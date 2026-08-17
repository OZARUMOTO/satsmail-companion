// Scan bitcoind's UTXO set for the given addresses/descriptors via RPC.
// Works on a pruned node with no -txindex — the UTXO set is always complete.
// Usage: node scan-utxo.js [addr|desc] [addr|desc] ...
const http = require('http');
const fs = require('fs');
const os = require('os');

function conf() {
  const path = process.env.BITCOIN_CONF || os.homedir() + '/.bitcoin/bitcoin.conf';
  const out = {};
  try {
    for (const line of fs.readFileSync(path, 'utf8').split('\n')) {
      const m = line.match(/^\s*([a-z0-9_]+)\s*=\s*(.*)$/i);
      if (m) out[m[1].toLowerCase()] = m[2].replace(/^"(.*)"$/, '$1');
    }
  } catch (e) { /* no conf */ }
  return out;
}

// bitcoind cookie auth: ~/.bitcoin/.cookie contains "user:password"
function cookieAuth() {
  try {
    const c = fs.readFileSync(os.homedir() + '/.bitcoin/.cookie', 'utf8').trim();
    const i = c.indexOf(':');
    if (i > 0) return { user: c.slice(0, i), pass: c.slice(i + 1) };
  } catch (e) { /* no cookie */ }
  return null;
}

function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const c = conf();
    const ck = cookieAuth();
    const port = parseInt(process.env.BTC_RPC_PORT || c.rpcport || '8332', 10);
    const host = process.env.BTC_RPC_HOST || '127.0.0.1';
    const user = process.env.BTC_RPC_USER || c.rpcuser || (ck && ck.user) || 'bitcoin';
    const pass = process.env.BTC_RPC_PASS || c.rpcpassword || (ck && ck.pass) || '';
    const body = JSON.stringify({ jsonrpc: '1.0', id: 'scan', method, params });
    const req = http.request({
      host, port, path: '/', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': 'Basic ' + Buffer.from(user + ':' + pass).toString('base64'),
      },
    }, (res) => {
      let buf = '';
      res.on('data', (d) => buf += d);
      res.on('end', () => {
        try {
          const j = JSON.parse(buf);
          if (j.error) reject(new Error(JSON.stringify(j.error)));
          else resolve(j.result);
        } catch (e) { reject(new Error('bad rpc response: ' + buf.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(300000, () => { req.destroy(new Error('rpc timeout')); });
    req.end(body);
  });
}

(async () => {
  const targets = process.argv.slice(2).map((t) =>
    (t.includes('(') ? t : 'addr(' + t + ')'));
  if (!targets.length) { console.error('usage: node scan-utxo.js <addr|descriptor> ...'); process.exit(1); }
  console.log('scanning', targets.length, 'target(s) via scantxoutset…');
  const res = await rpc('scantxoutset', ['start', targets]);
  console.log('success  :', res.success);
  console.log('txouts   :', res.txouts, '  (UTXO set size scanned)');
  console.log('height   :', res.height, '  bestblock:', res.bestblock);
  const unspents = res.unspents || [];
  console.log('matches  :', unspents.length);
  let total = 0;
  for (const u of unspents) {
    total += u.amount;
    console.log(`   ${u.txid}:${u.vout}  ${(u.amount * 1e8).toFixed(0)} sats  script=${u.scriptPubKey}`);
  }
  console.log('total    :', (total * 1e8).toFixed(0), 'sats');
  process.exit(0);
})().catch((e) => { console.error('scan failed:', e.message); process.exit(1); });
