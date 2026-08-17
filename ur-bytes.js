#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Michael Totten <mike@ozaru.io>
// SPDX-License-Identifier: GPL-3.0-or-later
//
// UR "bytes" encoder — wire-compatible with the device's scanner
// (gui-app-qr-scanner, which uses foundation_ur). The scanner requires:
//
//   * lowercase `ur:` scheme (it lowercases scanned text, but the UR spec
//     and foundation_ur's `strip_prefix("ur:")` are case-sensitive).
//   * every part payload encoded as bytewords-Minimal (two-letter tokens,
//     first+last letters of the 256-word bytewords table) with a CRC32
//     checksum appended. Raw hex is NOT valid bytewords and fails the
//     scanner's `bytewords::validate` ("Bytewords error: InvalidWord").
//   * multipart parts are fountain parts: CBOR array(5)
//       [sequence, sequence_count, message_length, crc32(message), data]
//     bytewords-encoded. The first `sequence_count` parts are "systematic":
//     part i carries raw fragment i-1, which the fountain decoder reduces
//     trivially — no xoshiro RNG needed on our side.
//
// The reassembled message is a CBOR byte string (what
// `Value::from_ur("bytes", …)` expects to decode via minicbor ByteSlice), so
// callers pass the RAW payload and we wrap it.
//
// Wire format:
//   Single part:  ur:bytes/<bytewords(message + crc32)>
//   Multipart:    ur:bytes/<seq>-<count>/<bytewords(part_cbor + crc32)>

const zlib = require('zlib');

// The 256 bytewords, in index order (BCR-2020-012). Minimal tokens are the
// first+last letters of each word, e.g. "able" -> "ae".
const WORDS = [
  'able', 'acid', 'also', 'apex', 'aqua', 'arch', 'atom', 'aunt',
  'away', 'axis', 'back', 'bald', 'barn', 'belt', 'beta', 'bias',
  'blue', 'body', 'brag', 'brew', 'bulb', 'buzz', 'calm', 'cash',
  'cats', 'chef', 'city', 'claw', 'code', 'cola', 'cook', 'cost',
  'crux', 'curl', 'cusp', 'cyan', 'dark', 'data', 'days', 'deli',
  'dice', 'diet', 'door', 'down', 'draw', 'drop', 'drum', 'dull',
  'duty', 'each', 'easy', 'echo', 'edge', 'epic', 'even', 'exam',
  'exit', 'eyes', 'fact', 'fair', 'fern', 'figs', 'film', 'fish',
  'fizz', 'flap', 'flew', 'flux', 'foxy', 'free', 'frog', 'fuel',
  'fund', 'gala', 'game', 'gear', 'gems', 'gift', 'girl', 'glow',
  'good', 'gray', 'grim', 'guru', 'gush', 'gyro', 'half', 'hang',
  'hard', 'hawk', 'heat', 'help', 'high', 'hill', 'holy', 'hope',
  'horn', 'huts', 'iced', 'idea', 'idle', 'inch', 'inky', 'into',
  'iris', 'iron', 'item', 'jade', 'jazz', 'join', 'jolt', 'jowl',
  'judo', 'jugs', 'jump', 'junk', 'jury', 'keep', 'keno', 'kept',
  'keys', 'kick', 'kiln', 'king', 'kite', 'kiwi', 'knob', 'lamb',
  'lava', 'lazy', 'leaf', 'legs', 'liar', 'limp', 'lion', 'list',
  'logo', 'loud', 'love', 'luau', 'luck', 'lung', 'main', 'many',
  'math', 'maze', 'memo', 'menu', 'meow', 'mild', 'mint', 'miss',
  'monk', 'nail', 'navy', 'need', 'news', 'next', 'noon', 'note',
  'numb', 'obey', 'oboe', 'omit', 'onyx', 'open', 'oval', 'owls',
  'paid', 'part', 'peck', 'play', 'plus', 'poem', 'pool', 'pose',
  'puff', 'puma', 'purr', 'quad', 'quiz', 'race', 'ramp', 'real',
  'redo', 'rich', 'road', 'rock', 'roof', 'ruby', 'ruin', 'runs',
  'rust', 'safe', 'saga', 'scar', 'sets', 'silk', 'skew', 'slot',
  'soap', 'solo', 'song', 'stub', 'surf', 'swan', 'taco', 'task',
  'taxi', 'tent', 'tied', 'time', 'tiny', 'toil', 'tomb', 'toys',
  'trip', 'tuna', 'twin', 'ugly', 'undo', 'unit', 'urge', 'user',
  'vast', 'very', 'veto', 'vial', 'vibe', 'view', 'visa', 'void',
  'vows', 'wall', 'wand', 'warm', 'wasp', 'wave', 'waxy', 'webs',
  'what', 'when', 'whiz', 'wolf', 'work', 'yank', 'yawn', 'yell',
  'yoga', 'yurt', 'zaps', 'zero', 'zest', 'zinc', 'zone', 'zoom',
];

const MINIMALS = WORDS.map((w) => w[0] + w[3]);

function crc32(buf) {
  return zlib.crc32(buf) >>> 0;
}

// CBOR major type 2 (byte string), shortest form.
function cborBytes(data) {
  const len = data.length;
  let head;
  if (len < 24) head = Buffer.from([0x40 + len]);
  else if (len < 0x100) head = Buffer.from([0x58, len]);
  else if (len < 0x10000) {
    head = Buffer.alloc(3);
    head[0] = 0x59;
    head.writeUInt16BE(len, 1);
  } else {
    head = Buffer.alloc(5);
    head[0] = 0x5a;
    head.writeUInt32BE(len, 1);
  }
  return Buffer.concat([head, data]);
}

// CBOR major type 0 (unsigned int), shortest form — matches minicbor, which
// the device uses for both encode and decode.
function cborUInt(v) {
  if (v < 24) return Buffer.from([v]);
  if (v < 0x100) return Buffer.from([0x18, v]);
  if (v < 0x10000) {
    const b = Buffer.alloc(3);
    b[0] = 0x19;
    b.writeUInt16BE(v, 1);
    return b;
  }
  if (v < 0x100000000) {
    const b = Buffer.alloc(5);
    b[0] = 0x1a;
    b.writeUInt32BE(v, 1);
    return b;
  }
  const b = Buffer.alloc(9);
  b[0] = 0x1b;
  b.writeBigUInt64BE(BigInt(v), 1);
  return b;
}

// Bytewords-Minimal: every byte -> its 2-letter token, concatenated.
function bytewords(buf) {
  let out = '';
  for (let i = 0; i < buf.length; i++) out += MINIMALS[buf[i]];
  return out;
}

// Fountain part CBOR: array(5) [seq, count, message_length, crc32(msg), data].
function partCbor(seq, count, messageLength, checksum, data) {
  return Buffer.concat([
    Buffer.from([0x85]),
    cborUInt(seq),
    cborUInt(count),
    cborUInt(messageLength),
    cborUInt(checksum),
    cborBytes(data),
  ]);
}

// Encode `data` (the RAW payload; we wrap it in a CBOR byte string) into UR
// frames. `fragmentBytes` is the max raw message bytes per frame; we emit
// systematic parts 1..=count, exactly what the device's fountain decoder
// reduces. Returns an array of QR strings ready to render.
function encodeUR(data, fragmentBytes = 90) {
  const message = cborBytes(data);
  const count = Math.max(1, Math.ceil(message.length / fragmentBytes));
  const fragmentLength = Math.ceil(message.length / count);
  const checksum = crc32(message);

  const frames = [];
  for (let seq = 1; seq <= count; seq++) {
    const start = (seq - 1) * fragmentLength;
    let frag = message.slice(start, start + fragmentLength);
    if (frag.length < fragmentLength) {
      frag = Buffer.concat([frag, Buffer.alloc(fragmentLength - frag.length)]);
    }
    const part = partCbor(seq, count, message.length, checksum, frag);
    const bw = bytewords(Buffer.concat([part, uint32be(crc32(part))]));
    frames.push(`ur:bytes/${seq}-${count}/${bw}`);
  }
  return frames;
}

function uint32be(v) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(v >>> 0, 0);
  return b;
}

module.exports = { encodeUR, cborBytes, cborUInt, bytewords, crc32 };
