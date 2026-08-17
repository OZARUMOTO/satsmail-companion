// Verify sync-qr.js's BIP-86 derivation against the official BIP-86 test
// vector: mnemonic "abandon … about" → m/86'/0'/0'/0/0 →
// bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr
const bip39 = require('bip39');
const { BIP32Factory } = require('bip32');
const bitcoin = require('bitcoinjs-lib');
const ecc = require('tiny-secp256k1');
const bip32 = BIP32Factory(ecc);
bitcoin.initEccLib(ecc);

const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const seed = bip39.mnemonicToSeedSync(mnemonic);
const root = bip32.fromSeed(seed);
const account = root.deriveHardened(86).deriveHardened(0).deriveHardened(0);
const child = account.derive(0).derive(0);
const p2tr = bitcoin.payments.p2tr({ internalPubkey: child.publicKey.subarray(1, 33) });
console.log('derived :', p2tr.address);
console.log('expected: bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr');
console.log('MATCH   :', p2tr.address === 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr');
