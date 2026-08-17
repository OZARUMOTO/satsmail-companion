// Probe bwt (Electrum 127.0.0.1:50001) for a single address: scripthash
// balance / unspents / history. bwt indexes the whole chain, so this works
// for any address — tracked or not.
const net = require('net');
const crypto = require('crypto');
const bitcoin = require('bitcoinjs-lib');
const ecc = require('tiny-secp256k1');
bitcoin.initEccLib(ecc); // required for taproot (bech32m/p2tr) ops

const HOST = process.env.ELECTRUM_HOST || '127.0.0.1';
const PORT = parseInt(process.env.ELECTRUM_PORT || '50001', 10);
const ADDR = process.argv[2];
if (!ADDR) { console.error('usage: node check-addr.js <address>'); process.exit(1); }

function rpc(method, params = []) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(PORT, HOST, () => {
      sock.write(JSON.stringify({ id: 1, method, params }) + '\n');
    });
    let buf = Buffer.alloc(0);
    let done = false;
    const finish = (fn, v) => { if (!done) { done = true; sock.destroy(); fn(v); } };
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      const nl = buf.indexOf(0x0a);
      if (nl >= 0) {
        const line = buf.subarray(0, nl).toString();
        try { finish(resolve, JSON.parse(line).result); }
        catch (e) { finish(reject, e); }
      }
    });
    sock.on('error', (e) => finish(reject, e));
    setTimeout(() => finish(reject, new Error('electrum timeout')), 8000);
  });
}

(async () => {
  const script = bitcoin.address.toOutputScript(ADDR);
  const sh = crypto.createHash('sha256').update(script).digest().reverse().toString('hex');
  console.log('address      :', ADDR);
  console.log('scriptPubKey :', script.toString('hex'));
  console.log('scripthash   :', sh);

  const bal = await rpc('blockchain.scripthash.get_balance', [sh]);
  console.log('balance      :', JSON.stringify(bal));

  const utxos = await rpc('blockchain.scripthash.listunspent', [sh]) || [];
  console.log('unspents     :', utxos.length);
  for (const u of utxos) {
    console.log(`   ${u.tx_hash}:${u.tx_pos}  ${u.value} sats  conf=${u.height > 0}`);
  }

  const hist = await rpc('blockchain.scripthash.get_history', [sh]) || [];
  console.log('history      :', hist.length, 'entries');
  for (const e of hist) {
    console.log(`   ${e.tx_hash}  height=${e.height}`);
  }

  // Chain tip sanity
  try {
    const tip = await rpc('blockchain.headers.subscribe', []);
    console.log('chain tip    :', tip ? `height=${tip.height}` : 'n/a');
  } catch (e) { /* fine */ }
  process.exit(0);
})().catch((e) => { console.error('probe failed:', e.message); process.exit(1); });
