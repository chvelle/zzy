import test from 'node:test';
import assert from 'node:assert/strict';
import {smokeTest} from '../src/smoke.mjs';
import {ROBINHOOD_TESTNET} from '../src/chain.mjs';

const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

test('the testnet config is the official one', () => {
  assert.equal(ROBINHOOD_TESTNET.id, 46630);
  assert.equal(ROBINHOOD_TESTNET.rpcUrls.default.http[0], 'https://rpc.testnet.chain.robinhood.com');
  assert.match(ROBINHOOD_TESTNET.faucet, /faucet\.testnet\.chain\.robinhood\.com/);
});

test('smoke refuses to run without a key', async () => {
  await assert.rejects(() => smokeTest({privateKey: null}), /no operator key/);
});

test('SECURITY: smoke refuses to run on any chain but the testnet', async () => {
  // Point it at an RPC that will answer eth_chainId with mainnet's id. The
  // check happens before any transaction is built, so a wrong network can
  // never receive a real send.
  const {createServer} = await import('node:http');
  const server = createServer((req, res) => {
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      const {id, method} = JSON.parse(body);
      const result = method === 'eth_chainId' ? '0x1237' : '0x0';   // 4663, mainnet
      res.writeHead(200, {'content-type': 'application/json'}); res.end(JSON.stringify({jsonrpc: '2.0', id, result}));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    await assert.rejects(() => smokeTest({privateKey: KEY, rpcUrl: `http://127.0.0.1:${server.address().port}`}), /refusing: connected to chain 4663/);
  } finally { await new Promise(r => server.close(r)); }
});

test('smoke tells you to use the faucet when the wallet is empty', async () => {
  const {createServer} = await import('node:http');
  const server = createServer((req, res) => {
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      const {id, method} = JSON.parse(body);
      const result = method === 'eth_chainId' ? '0xb626' : '0x0';    // 46630, then zero balance
      res.writeHead(200, {'content-type': 'application/json'}); res.end(JSON.stringify({jsonrpc: '2.0', id, result}));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    await assert.rejects(() => smokeTest({privateKey: KEY, rpcUrl: `http://127.0.0.1:${server.address().port}`}), /wallet is empty.*faucet/s);
  } finally { await new Promise(r => server.close(r)); }
});
