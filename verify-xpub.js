// Verify satsmail's taproot xpub: parse the tr() descriptor, derive the first
// BIP-86 receive addresses, and print them for cross-check against the
// Prime's Compose page (receive address #0 must match).
const { BIP32Factory } = require('bip32');
const bitcoin = require('bitcoinjs-lib');
const ecc = require('tiny-secp256k1');
const bip32 = BIP32Factory(ecc);
bitcoin.initEccLib(ecc);

// The descriptor satsmail shows: tr([fp/86'/0'/0']xpub/0/*)#checksum
// Pass it as the argument — never hardcode a real descriptor.
const desc = process.argv[2];
if (!desc) { console.error('usage: node verify-xpub.js "tr([fp/86\'/0\'/0\']xpub/0/*)#checksum"'); process.exit(1); }

// strip origin + path + checksum → bare xpub
const m = desc.match(/xpub[1-9A-HJ-NP-Za-km-z]{107,108}/);
if (!m) { console.error('no xpub found in descriptor'); process.exit(1); }
const xpub = m[0];
console.log('xpub   :', xpub);

// The xpub IS the account key (m/86'/0'/0'); receive = /0/i, change = /1/i
const node = bip32.fromBase58(xpub);
for (let i = 0; i < 3; i++) {
  const child = node.derive(0).derive(i);
  const p2tr = bitcoin.payments.p2tr({ internalPubkey: child.publicKey.subarray(1, 33) });
  console.log(`receive #${i} : ${p2tr.address}`);
}
const ch = node.derive(1).derive(0);
const chTr = bitcoin.payments.p2tr({ internalPubkey: ch.publicKey.subarray(1, 33) });
console.log(`change  #0 : ${chTr.address}`);
