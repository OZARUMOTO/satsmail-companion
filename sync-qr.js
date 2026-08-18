#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Michael Totten <mike@ozaru.io>
// SPDX-License-Identifier: GPL-3.0-or-later
//
// SATSMAIL companion — the network side of the QR sync flow.
//
// Satsmail on the Prime is air-gapped: no electrum, no cable. This script
// runs wherever bwt lives (the box at home) and turns the wallet state into
// an animated UR2 "bytes" QR. You open the page on your phone, point the
// Prime's "sync from qr" scanner at it, and the inbox updates.
//
// The wallet it tracks is SATSMAIL's OWN — derived from the app-scoped seed
// (GetAppSeed). Copy the "account xpub" shown on Satsmail's Compose page:
//
//     SATMAIL_XPUB=xpub6Cb... node sync-qr.js
//
// (bwt is a full Electrum server, so the same instance answers scripthash
// queries for any wallet — no second bwt needed.)
//
// v2 fixes:
//   * QR frames are PRE-RENDERED server-side into data-URL images. The old
//     page called QRCode.toCanvas() in the browser where QRCode was never
//     defined → blank black screen with only the text. No client-side QR
//     library is needed anymore.
//   * The payload re-syncs every 30s (and the open page polls /frames every
//     5s), so balance/mails update without restarting the service.
//
// The payload schema mirrors src/sync.rs QrSyncPayload exactly:
//
//     { "balance_sats": 123456, "generated_at": 1787000000,
//       "mails": [ { "subject": "receive btc", "amount": "+0.005",
//                    "detail": "from bc1q…", "status": "[3 confirmations]",
//                    "fresh": false, "block_time": 1786999000 } ] }

const net = require('net');
const http = require('http');

const ELECTRUM_HOST = process.env.ELECTRUM_HOST || '127.0.0.1';
const ELECTRUM_PORT = parseInt(process.env.ELECTRUM_PORT || '50001', 10);
const HTTP_PORT = parseInt(process.env.PORT || '8081', 10);
// The wallet to track: env var wins, otherwise read xpub.txt in this dir
// (write the xpub from Sats Mail → Compose → "account xpub" there).
const fs = require('fs');
const XPUB = process.env.SATMAIL_XPUB
  || (fs.existsSync(__dirname + '/xpub.txt') && fs.readFileSync(__dirname + '/xpub.txt', 'utf8').trim())
  || '';
const LOOKAHEAD_EXT = 20;
const LOOKAHEAD_INT = 10;

// ── pairing secret (HMAC auth of the sync channel) ────────────────────────
// The Prime is air-gapped and its only transport is the camera, so a sync QR
// could come from ANY page — including a fake one on the phone. To fix that,
// the box generates a 32-byte secret once, shows it on /pair as
// `satsmail-pair:<hex>`, and the Prime stores it after one scan ("pair with
// box"). Every sync payload after that carries an HMAC-SHA256 tag computed
// with this secret; the device recomputes it and REFUSES any payload that
// doesn't match. Without the secret a fake QR can't authenticate.
//
// The secret persists in ./pairing-secret (0600) next to this script; set
// SATMAIL_PAIRING_SECRET to override (e.g. from a vault). Keep it secret:
// anyone with it can impersonate the box.
const crypto = require('crypto');
const PAIR_PREFIX = 'satsmail-pair:';
function pairingSecret() {
  if (process.env.SATMAIL_PAIRING_SECRET) return process.env.SATMAIL_PAIRING_SECRET.trim();
  const file = __dirname + '/pairing-secret';
  if (fs.existsSync(file)) {
    const s = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{64}$/i.test(s)) return s;
    console.error('pairing-secret is not a 64-char hex string — regenerating');
  }
  const s = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, s + '\n', { mode: 0o600 });
  console.log('generated new pairing secret -> ' + file + ' (scan /pair once with Satsmail)');
  return s;
}
const PAIRING_SECRET = pairingSecret();

const { BIP32Factory } = require('bip32');
const bitcoin = require('bitcoinjs-lib');
const ecc = require('tiny-secp256k1');
const { encodeUR } = require('./ur-bytes.js'); // tiny local UR "bytes" encoder

const bip32 = BIP32Factory(ecc);
bitcoin.initEccLib(ecc); // required for taproot (p2tr) operations

// ── electrum client ─────────────────────────────────────────────────────────
// bwt keeps the connection open (newline-delimited JSON-RPC), so resolve on
// the first complete line instead of waiting for the socket to close.
function rpc(method, params = []) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(ELECTRUM_PORT, ELECTRUM_HOST, () => {
      sock.write(JSON.stringify({ id: 1, method, params }) + '\n');
    });
    let buf = Buffer.alloc(0);
    let done = false;
    const finish = (fn, v) => { if (!done) { done = true; sock.destroy(); fn(v); } };
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      const nl = buf.indexOf(0x0a);
      if (nl >= 0) {
        try {
          const msg = JSON.parse(buf.slice(0, nl).toString('utf8'));
          if (msg.error) finish(reject, new Error(msg.error.message || JSON.stringify(msg.error)));
          else finish(resolve, msg.result);
        } catch (e) { finish(reject, e); }
      }
    });
    sock.on('error', (e) => finish(reject, e));
    setTimeout(() => finish(reject, new Error('electrum timeout')), 8000);
  });
}

// The external + internal BIP-86 taproot scripts for the wallet's lookahead.
function ourScripts(xpub) {
  const node = bip32.fromBase58(xpub);
  const out = [];
  const push = (branch, i) => {
    const child = node.derive(branch).derive(i);
    const p2tr = bitcoin.payments.p2tr({ internalPubkey: child.publicKey.subarray(1, 33) });
    // p2tr.output is a Uint8Array — toString('hex') on one returns comma-joined
    // decimals, not hex. Copy it into a real Buffer first.
    out.push(Buffer.from(p2tr.output).toString('hex'));
  };
  for (let i = 0; i < LOOKAHEAD_EXT; i++) push(0, i);
  for (let i = 0; i < LOOKAHEAD_INT; i++) push(1, i);
  return out;
}

function scripthash(script) {
  const crypto = require('crypto');
  const digest = crypto.createHash('sha256').update(Buffer.from(script, 'hex')).digest();
  return Buffer.from(digest).reverse().toString('hex');
}

function scriptHex(hex) { return hex; }

function scriptToAddr(hex) {
  try {
    return bitcoin.address.fromOutputScript(Buffer.from(hex, 'hex'), bitcoin.networks.bitcoin);
  } catch { return null; }
}

function short(s) { if (!s) return '—'; return s.length <= 16 ? s : s.slice(0, 8) + '…' + s.slice(-4); }

// ── one sync pass → { payload, frames (data URLs), title } ──────────────────
async function buildPage() {
  const scripts = ourScripts(XPUB);
  const hashes = scripts.map(scripthash);

  // balance + UTXOs (compose-send feeds these into bdk on the device)
  let balance_sats = 0;
  const utxos = [];
  for (let i = 0; i < hashes.length; i++) {
    const h = hashes[i];
    const script = scriptHex(scripts[i]);
    for (const u of (await rpc('blockchain.scripthash.listunspent', [h])) || []) {
      balance_sats += u.value;
      utxos.push({
        txid: u.tx_hash,
        vout: u.tx_pos,
        script_hex: script,
        value_sats: u.value,
        confirmed: (u.height || 0) > 0,
      });
    }
  }

  // history
  const txids = new Set();
  for (const h of hashes) {
    for (const e of (await rpc('blockchain.scripthash.get_history', [h])) || []) {
      txids.add(e.tx_hash);
    }
  }

  const ourSet = new Set(scripts.map(scriptHex));
  const mails = [];
  // bwt's verbose `transaction.get` has NO `prevout`, and its `vout[].value`
  // is in BTC (floats), not sats. For inputs we fetch the prev tx (verbose:
  // bwt includes `scriptPubKey.address`, so no raw-hex parsing needed) and
  // read `vout[vin.vout]` the same way: value*1e8 → sats.
  const prevCache = {}; // txid -> verbose tx | null
  async function getPrev(txid) {
    if (txid in prevCache) return prevCache[txid];
    try {
      prevCache[txid] = await rpc('blockchain.transaction.get', [txid, true]);
    } catch { prevCache[txid] = null; }
    return prevCache[txid];
  }
  for (const txid of txids) {
    const tx = await rpc('blockchain.transaction.get', [txid, true]);
    if (!tx) continue;
    let our_in = 0, our_out = 0;
    let other_in = null, other_out = null; // { hex, addr }
    for (const vin of tx.vin || []) {
      const prev = await getPrev(vin.txid);
      const prevOut = (prev && prev.vout && prev.vout[vin.vout]) || null;
      const v = prevOut ? Math.round((prevOut.value || 0) * 1e8) : 0; // sats
      const s = prevOut ? (prevOut.scriptPubKey?.hex || '') : '';
      if (ourSet.has(s)) our_in += v;
      else if (other_in === null && s)
        other_in = { hex: s, addr: prevOut?.scriptPubKey?.address || scriptToAddr(s) || null };
    }
    for (const vout of tx.vout || []) {
      const v = Math.round((vout.value || 0) * 1e8);         // BTC -> sats
      const s = vout.scriptPubKey?.hex || '';
      if (ourSet.has(s)) our_out += v;
      else if (other_out === null && s)
        other_out = { hex: s, addr: vout.scriptPubKey?.address || scriptToAddr(s) || null };
    }
    const net_ = our_out - our_in;
    if (net_ === 0) continue;
    const fresh = (tx.confirmations || 0) === 0;
    const status = fresh ? '[unconfirmed]' : `[${tx.confirmations} confirmations]`;
    const block_time = fresh ? 0 : (tx.blocktime || 0);
    const sats = Math.abs(net_);
    const btc = sats / 1e8;
    const amt = btc.toFixed(8).replace(/\.?0+$/, '');
    const subject = net_ > 0 ? 'receive btc' : 'send btc';
    const detail = net_ > 0
      ? (other_in ? `from ${short(other_in.addr)}` : 'from —')
      : (other_out ? `to ${short(other_out.addr)}` : 'to —');
    mails.push({ subject, amount: (net_ > 0 ? '+' : '-') + amt, detail, status, fresh, block_time });
  }
  mails.sort((a, b) => (a.fresh !== b.fresh) ? (a.fresh ? -1 : 1) : b.block_time - a.block_time);

  // fee-rate presets (sat/vB) for compose-send: estimatefee returns BTC/kB
  // for N-block targets; convert to sat/vB. Fall back to conservative rates
  // when bwt has no estimate (pruned/tip mismatch).
  async function feePresets() {
    const toSatVb = (btcPerKb) => Math.max(1, Math.round(btcPerKb * 1e5));
    const est = async (blocks, fallback) => {
      try {
        const r = await rpc('blockchain.estimatefee', [blocks]);
        return (typeof r === 'number' && r > 0) ? toSatVb(r) : fallback;
      } catch { return fallback; }
    };
    return {
      low: await est(144, 1),    // ~1 day
      medium: await est(6, 3),   // ~1 hour
      high: await est(1, 8),     // next block
    };
  }
  const fee_rates = await feePresets();

  // The box's own broadcast page — compose-send renders a pushtx URL QR on
  // this base, the phone camera opens it, and this page submits to bwt.
  // Set BROADCAST_BASE if the box isn't reachable at the LAN IP below.
  const broadcast_base = process.env.BROADCAST_BASE
    || `http://127.0.0.1:${HTTP_PORT}/broadcast`;

  // HMAC-auth the payload: the device re-derives the exact canonical bytes
  // (same key order as the Rust QrSyncPayload struct) and recomputes this tag
  // with the pairing secret. Never change the key order here without matching
  // src/sync.rs — a mismatch makes every sync read as "auth failed".
  const generated_at = Math.floor(Date.now() / 1000);
  const canonical = JSON.stringify({ balance_sats, generated_at, mails, utxos, fee_rates, broadcast_base });
  const hmac = crypto.createHmac('sha256', Buffer.from(PAIRING_SECRET, 'hex')).update(canonical).digest('hex');
  const payload = { balance_sats, generated_at, mails, utxos, fee_rates, broadcast_base, hmac };
  console.log(`synced: ${mails.length} mails, ${balance_sats} sats, ${utxos.length} utxos, fees ${fee_rates.low}/${fee_rates.medium}/${fee_rates.high} (hmac authed)`);

  // ── animated UR2 bytes QR page ───────────────────────────────────────────
  // Pre-render EVERY frame server-side to a data-URL PNG. The browser just
  // cycles <img> srcs — no client-side QR library, no QRCode.toCanvas that
  // was never defined in the browser (that's why the old page was a black
  // screen with only the text).
  // Split into SMALL frames (~90 raw bytes each -> version ~10-11, 57-61
  // modules after the bytewords expansion): dense QRs are hard for the
  // Prime's camera off a phone screen, but the device scanner is built for
  // animated multi-frame UR — smaller frames scan reliably. Frames are
  // bytewords-Minimal fountain parts (see ur-bytes.js) that the scanner's
  // foundation_ur decoder reassembles.
  const frames = encodeUR(Buffer.from(JSON.stringify(payload), 'utf8'), 90);
  const QRCode = require('qrcode');
  // Match the device's own QR renderer: the Rust `qrcode` crate's default is
  // ECC Medium, and screens need a proper quiet zone — margin 1 was below the
  // spec's 4 modules and broke finder-pattern detection (camera saw the QR,
  // never decoded it). 'M' + margin 4 is what Foundation's exports use.
  const frameImgs = [];
  for (const f of frames) {
    frameImgs.push(await QRCode.toDataURL(f, { errorCorrectionLevel: 'M', margin: 4, width: 640 }));
  }
  const version = payload.generated_at + '-' + balance_sats + '-' + mails.length;

  return { version, frameImgs, title: `${mails.length} mails · ${(balance_sats/1e8).toFixed(8).replace(/\.?0+$/,'')} BTC`, status: `${mails.length} mails · ${(balance_sats/1e8).toFixed(8).replace(/\.?0+$/,'')} BTC · hold the Prime scanner to the screen` };
}

// ── server state (rebuilt every 30s) ───────────────────────────────────────
let page = null; // { version, frameImgs, title, status }
async function refreshPage() {
  try {
    page = await buildPage();
  } catch (e) {
    console.error(`refresh failed: ${e.message}`);
  }
}

const url = require('url');

const server = http.createServer(async (req, res) => {
  const p = url.parse(req.url, true);

  // GET /frames — the open page polls this every 5s; returns the latest
  // pre-rendered QR images so balance/mails update without a reload.
  if (p.pathname === '/frames') {
    if (!page) await refreshPage();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ version: page.version, frames: page.frameImgs }));
    return;
  }

  // GET /broadcast — the compose-send done screen renders a pushtx URL QR
  // pointing here (…/broadcast#t=<b64url(tx)>&c=<checksum>). The phone
  // camera opens it, this page decodes the fragment and submits the tx to
  // bwt, which broadcasts via the box's own bitcoind.
  if (p.pathname === '/broadcast') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(pushtxHtml());
    return;
  }

  // POST /pushtx — { tx: '<hex>' } → bwt blockchain.transaction.broadcast
  if (p.pathname === '/pushtx' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    let tx;
    try { tx = JSON.parse(body).tx; } catch { tx = null; }
    if (!tx || !/^[0-9a-fA-F]+$/.test(tx)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'bad tx hex' }));
      return;
    }
    try {
      const txid = await rpc('blockchain.transaction.broadcast', [tx]);
      console.log(`broadcast ok: ${txid}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, txid }));
    } catch (e) {
      console.error(`broadcast failed: ${e.message}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // GET /receipt?txid=… — the broadcast-receipt loop. After /broadcast
  // succeeds it redirects here; this page shows a QR the Prime scans with
  // "verify broadcast". The QR text is `satsmail-receipt:<status>:<txid>
  // [:confs]` and the Prime compares the txid against the one IT computed
  // from the signed tx — a lying box can't fake that, because the txid is a
  // hash of the very bytes the Prime produced. Polls /txstatus so the QR
  // upgrades from mempool → confirmed as confirmations arrive.
  if (p.pathname === '/receipt') {
    const QRCode = require('qrcode');
    const txid = (p.query.txid || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(txid)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><html><body style="background:#0d0f12;color:#e8e6e3;font-family:monospace;text-align:center;padding:40px">missing txid — go back to the broadcast page and broadcast again</body></html>');
      return;
    }
    const st = await txStatus(txid);
    const qr = await QRCode.toDataURL(receiptText(st, txid), { errorCorrectionLevel: 'M', margin: 4, width: 640 });
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(receiptHtml(txid, qr, st));
    return;
  }

  // GET /txstatus?txid=… — polled by the /receipt page every 5 s; returns
  // the current status plus a freshly pre-rendered receipt QR so the page
  // can swap the image as the tx confirms.
  if (p.pathname === '/txstatus') {
    const QRCode = require('qrcode');
    const txid = (p.query.txid || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(txid)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad txid' }));
      return;
    }
    const st = await txStatus(txid);
    const qr = await QRCode.toDataURL(receiptText(st, txid), { errorCorrectionLevel: 'M', margin: 4, width: 640 });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: st.status, label: st.label, confs: st.confs, qr }));
    return;
  }

  // GET /pair — one-time pairing: shows the secret as a plain-text QR
  // (`satsmail-pair:<hex>`). Scan it once with Satsmail → "pair with box".
  // The page stays up; re-scanning just re-pairs (rotates to a NEW secret,
  // which also invalidates the old one — that's the unpair/rotate flow).
  if (p.pathname === '/pair') {
    const QRCode = require('qrcode');
    const qr = await QRCode.toDataURL(PAIR_PREFIX + PAIRING_SECRET, { errorCorrectionLevel: 'M', margin: 4, width: 640 });
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>satsmail pairing</title>
<style>body{background:#000;color:#fff;font-family:monospace;display:flex;flex-direction:column;align-items:center;margin:24px}
img{width:min(80vw,480px);height:min(80vw,480px);image-rendering:pixelated}
pre{font-size:12px;color:#888;word-break:break-all;max-width:90vw}</style></head>
<body><img src="${qr}">
<div style="font-size:15px;padding:10px">open Satsmail → inbox → <b>pair with box</b> → scan this QR once</div>
<pre>${PAIR_PREFIX}${PAIRING_SECRET}</pre>
<div style="font-size:12px;color:#666;padding-top:8px">the secret lives in <code>~/satsmail-companion/pairing-secret</code> (0600).
Redeploying this page generates a NEW secret — re-scan to re-pair.</div>
</body></html>`);
    return;
  }

  // GET / — the sync QR page (default)
  if (!page) await refreshPage();
  const f0 = page.frameImgs[0] || '';
  const html = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>satsmail sync — ${page.title}</title>
<style>body{background:#000;color:#fff;font-family:monospace;display:flex;flex-direction:column;align-items:center;margin:0}
img#c{width:min(92vw,640px);height:min(92vw,640px);image-rendering:pixelated}
#st{font-size:14px;padding:8px;color:#888;text-align:center}#n{font-size:18px}</style></head>
<body><img id="c" src="${f0}"><div id="n">frame 1 / ${page.frameImgs.length}</div>
<div id="st">satsmail sync — ${page.status}</div>
<div style="font-size:11px;color:#555;padding:6px">hmac-authenticated · pair page: /pair</div>
<script>
let frames = ${JSON.stringify(page.frameImgs)};
let version = ${JSON.stringify(page.version)};
const img = document.getElementById('c');
let i = 0;
// hot-swap frames while scanning
setInterval(() => {
  if (frames.length > 1) { i = (i + 1) % frames.length; img.src = frames[i]; document.getElementById('n').textContent = 'frame ' + (i + 1) + ' / ' + frames.length; }
}, 240);
// poll for a fresh payload (new tx / new confirmations) every 5s
setInterval(async () => {
  try {
    const r = await fetch('/frames');
    const j = await r.json();
    if (j.version !== version) {
      version = j.version; frames = j.frames;
      i = 0; img.src = frames[0];
      document.getElementById('n').textContent = 'frame 1 / ' + frames.length;
    }
  } catch (e) { /* phone briefly offline — keep scanning the current frames */ }
}, 5000);
</script></body></html>`;
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(html);
});

server.listen(HTTP_PORT, '0.0.0.0', () => {
  console.log(`QR page: http://<this-box-ip>:${HTTP_PORT}  (open on your phone, scan with Satsmail)`);
  console.log(`broadcast page: ${process.env.BROADCAST_BASE || `http://127.0.0.1:${HTTP_PORT}/broadcast`}  (compose-send done screen QRs point here)`);
});

// initial sync + periodic refresh (30s), so balance/mails update on their own
refreshPage();
setInterval(refreshPage, 30000);

// The receipt QR text the Prime's "verify broadcast" scanner expects:
// `satsmail-receipt:<status>:<txid>[:<confs>]` (mirrors src/send.rs
// parse_receipt exactly — never change the shape without matching it).
function receiptText(st, txid) {
  return 'satsmail-receipt:' + st.status + ':' + txid + (st.confs ? ':' + st.confs : '');
}

// Current status of a broadcast tx from bwt: mempool until it has at least
// one confirmation (bwt's transaction.get returns confirmations, 0 = mempool).
async function txStatus(txid) {
  let confs = 0;
  try {
    const tx = await rpc('blockchain.transaction.get', [txid]);
    confs = Math.max(0, (tx && tx.confirmations) || 0);
  } catch { /* not found yet — still in mempool */ }
  if (confs > 0) return { status: 'confirmed', label: confs + ' confirmations', confs };
  return { status: 'mempool', label: 'in mempool — waiting for confirmation', confs: 0 };
}

// The /receipt page: big QR the Prime scans, status line, and a poller that
// swaps the QR when the tx confirms.
function receiptHtml(txid, qr, st) {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>satsmail receipt</title>
<style>body{background:#0d0f12;color:#e8e6e3;font-family:ui-monospace,Menlo,monospace;display:flex;flex-direction:column;align-items:center;padding:16px;min-height:100vh}
h1{font-size:18px;letter-spacing:1px}p{color:#9aa2ad;font-size:12px;max-width:440px;text-align:center}
img{width:min(80vw,480px);height:min(80vw,480px);image-rendering:pixelated;background:#fff;padding:8px;border-radius:8px}
#st{font-size:13px;color:#7ee787;padding:8px}pre{font-size:11px;color:#888;word-break:break-all;max-width:90vw}</style></head>
<body><h1>BROADCAST RECEIPT</h1>
<p>Hold the Prime scanner to this QR (Sats Mail → send → <b>verify broadcast</b>) — it checks the txid against the one the Prime computed from the tx it signed.</p>
<img src="${qr}">
<div id="st">${st.label}</div>
<pre>${receiptText(st, txid)}</pre>
<div style="font-size:12px;color:#666;padding-top:8px">the receipt updates automatically as confirmations arrive — keep this page open.</div>
<script>
const txid = ${JSON.stringify(txid)};
setInterval(async () => {
  try {
    const r = await fetch('/txstatus?txid=' + encodeURIComponent(txid));
    const j = await r.json();
    if (j.status === 'confirmed') {
      document.getElementById('st').textContent = j.label;
      document.querySelector('img').src = j.qr;
      document.querySelector('pre').textContent = 'satsmail-receipt:' + j.status + ':' + txid + (j.confs ? ':' + j.confs : '');
    }
  } catch (e) { /* phone briefly offline — keep the current QR */ }
}, 5000);
</script></body></html>`;
}

// The /broadcast page: decodes the #t=/#c= fragment the device QR carries,
// verifies the checksum, and POSTs the hex to /pushtx on this same box.
function pushtxHtml() {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>satsmail broadcast</title>
<style>body{background:#0d0f12;color:#e8e6e3;font-family:ui-monospace,Menlo,monospace;display:flex;flex-direction:column;align-items:center;padding:16px;min-height:100vh}
h1{font-size:18px;letter-spacing:1px}p{color:#9aa2ad;font-size:12px;max-width:440px;text-align:center}
.card{background:#161a20;border:1px solid #2a3038;border-radius:10px;padding:16px;width:100%;max-width:440px;margin-top:12px}
.stat{display:flex;justify-content:space-between;font-size:13px;padding:5px 0;border-bottom:1px dashed #2a3038}
.stat b{color:#7ee787}#result{margin-top:10px;font-size:13px;word-break:break-all}
button{background:#7ee787;color:#0d0f12;border:0;border-radius:6px;padding:10px 14px;font-weight:700;font-size:13px;cursor:pointer;width:100%;margin-top:10px}
button:disabled{opacity:.45}.ok{color:#7ee787}.err{color:#ff7b72}.meta{color:#9aa2ad}</style></head>
<body><h1>SATSMAIL PUSHTX</h1>
<p>Broadcast a signed transaction through <b>your own bitcoind</b> (bwt on this box). The tx came in from the QR your phone scanned.</p>
<div class="card" id="fragCard" hidden>
<div class="stat"><span>Loaded from QR</span><b id="size">—</b></div>
<div class="stat"><span>Checksum</span><b id="cksum">—</b></div>
<button id="broadcast">▸ BROADCAST VIA YOUR NODE</button>
<div id="result"></div>
</div>
<div class="card" id="manualCard" hidden>
<p>No tx in the URL — paste raw hex:</p>
<textarea id="txhex" style="width:100%;background:#0d0f12;color:#e8e6e3;border:1px solid #2a3038;border-radius:6px;padding:8px;min-height:120px;font-family:inherit" placeholder="0200000001…"></textarea>
<button id="manual-broadcast" style="background:#2a3038">▸ BROADCAST</button>
<div id="manual-result"></div>
</div>
<script>
var K=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
function rotr(x,n){return(x>>>n)|(x<<(32-n));}
function sha256(m){var H=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];var l=m.length,bitlen=l*8;var n=(((l+8)>>6)+1)<<6;var b=new Uint8Array(n);b.set(m);b[l]=0x80;var dv=new DataView(b.buffer);dv.setUint32(n-8,Math.floor(bitlen/0x100000000));dv.setUint32(n-4,bitlen>>>0);var w=new Int32Array(64);var h0=H[0],h1=H[1],h2=H[2],h3=H[3],h4=H[4],h5=H[5],h6=H[6],h7=H[7];
for(var off=0;off<n;off+=64){for(var i=0;i<16;i++)w[i]=dv.getInt32(off+i*4);for(i=16;i<64;i++){var s0=rotr(w[i-15],7)^rotr(w[i-15],18)^(w[i-15]>>>3);var s1=rotr(w[i-2],17)^rotr(w[i-2],19)^(w[i-2]>>>10);w[i]=(w[i-16]+s0+w[i-7]+s1)|0;}
var a=h0,b=h1,c=h2,d=h3,e=h4,f=h5,g=h6,hh=h7;for(i=0;i<64;i++){var S1=rotr(e,6)^rotr(e,11)^rotr(e,25);var ch=(e&f)^(~e&g);var t1=(hh+S1+ch+K[i]+w[i])|0;var S0=rotr(a,2)^rotr(a,13)^rotr(a,22);var maj=(a&b)^(a&c)^(b&c);var t2=(S0+maj)|0;hh=g;g=f;f=e;e=(d+t1)|0;d=c;c=b;b=a;a=(t1+t2)|0;}
h0=(h0+a)|0;h1=(h1+b)|0;h2=(h2+c)|0;h3=(h3+d)|0;h4=(h4+e)|0;h5=(h5+f)|0;h6=(h6+g)|0;h7=(h7+hh)|0;}
var out=new Uint8Array(32),odv=new DataView(out.buffer);odv.setUint32(0,h0>>>0);odv.setUint32(4,h1>>>0);odv.setUint32(8,h2>>>0);odv.setUint32(12,h3>>>0);odv.setUint32(16,h4>>>0);odv.setUint32(20,h5>>>0);odv.setUint32(24,h6>>>0);odv.setUint32(28,h7>>>0);return out;}
function b64urlToBytes(s){s=String(s).replace(/-/g,'+').replace(/_/g,'/');while(s.length%4)s+='=';var bin=atob(s);var out=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++)out[i]=bin.charCodeAt(i);return out;}
function bytesToHex(b){var s='';for(var i=0;i<b.length;i++)s+=(b[i]<16?'0':'')+b[i].toString(16);return s;}
function el(id){return document.getElementById(id);}
var frag=location.hash?location.hash.slice(1):'';var params={};
frag.split('&').forEach(function(kv){var i=kv.indexOf('=');if(i>0)params[kv.slice(0,i)]=decodeURIComponent(kv.slice(i+1));});
var txBytes=null,txHex='',checksumOk=null;
if(params.t){try{txBytes=b64urlToBytes(params.t);txHex=bytesToHex(txBytes);}catch(e){txHex='';}
el('fragCard').hidden=false;el('size').textContent=(txBytes?txBytes.length:0)+' bytes';
if(params.c){try{var want=b64urlToBytes(params.c);var got=sha256(txBytes);var ok=got.length>=8&&want.length===8;for(var i=0;ok&&i<8;i++)if(got[got.length-8+i]!==want[i])ok=false;checksumOk=ok;
el('cksum').textContent=ok?'✓ VALID':'✗ MISMATCH';el('cksum').style.color=ok?'#7ee787':'#ff7b72';}catch(e){el('cksum').textContent='unparseable';el('cksum').style.color='#ff7b72';}}
if(!txHex||checksumOk===false){el('broadcast').disabled=true;setResult('result',!txHex?'Could not decode the tx from the QR — rescan it.':'Checksum mismatch — the QR was scanned wrong. Rescan it.','err');}
}else{el('manualCard').hidden=false;}
function setResult(id,html,cls){var node=el(id);node.innerHTML=html;node.className=cls||'';}
function broadcast(txhex,resultId,btn){if(btn)btn.disabled=true;setResult(resultId,'sending to your node…','meta');
fetch('/pushtx',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tx:txhex})})
.then(function(r){return r.json().catch(function(){return{ok:false,error:'HTTP '+r.status};});})
.then(function(j){if(j&&j.ok&&j.txid){setResult(resultId,'✓ BROADCAST — txid: <b>'+j.txid+'</b>','ok');setTimeout(function(){location.href='/receipt?txid='+encodeURIComponent(j.txid);},1500);}else{setResult(resultId,'✗ '+(j&&j.error?j.error:'relay error'),'err');}})
.catch(function(e){setResult(resultId,'✗ could not reach the relay: '+e,'err');})
.finally(function(){if(btn)btn.disabled=false;});}
el('broadcast').addEventListener('click',function(){broadcast(txHex,'result',el('broadcast'));});
el('manual-broadcast').addEventListener('click',function(){var h=el('txhex').value.trim();if(!/^[0-9a-fA-F]+$/.test(h)||h.length%2){setResult('manual-result','invalid tx hex','err');return;}broadcast(h,'manual-result',el('manual-broadcast'));});
</script></body></html>`;
}
