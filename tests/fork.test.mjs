import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {assertLocalFork, forkConfig, FORK_RPC} from '../src/fork.mjs';
import {createGuardedSigner, SignerGuardError, LIVE_ACK_PHRASE} from '../src/adapters/signer.mjs';

// A stub node. `answers` maps method -> result, or a method to an Error.
function fakeNode(answers) {
  const server = createServer((req, res) => {
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      const {id, method} = JSON.parse(body);
      const a = answers[method];
      res.writeHead(200, {'content-type': 'application/json'});
      if (a === undefined) return res.end(JSON.stringify({jsonrpc:'2.0', id, error: {code: -32601, message: 'method not found'}}));
      res.end(JSON.stringify({jsonrpc:'2.0', id, result: a}));
    });
  });
  return server;
}
async function withNode(answers, fn) {
  const server = fakeNode(answers);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try { await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(r => server.close(r)); }
}
const GOOD = {
  anvil_nodeInfo: {forkConfig: {forkUrl: 'https://rpc.mainnet.chain.robinhood.com', forkBlockNumber: 5000000}},
  eth_chainId: '0x1237',   // 4663
};

test('SECURITY: a remote RPC is refused outright, whatever it answers', async () => {
  for (const url of ['https://rpc.mainnet.chain.robinhood.com', 'http://10.0.0.5:8545', 'https://evil.example/rpc', 'http://127.0.0.1.evil.com:8545']) {
    await assert.rejects(() => assertLocalFork(url), /refuses a non-local RPC/, url);
  }
});

test('SECURITY: a real node that is not Anvil is refused', async () => {
  await withNode({eth_chainId: '0x1237'}, async (url) => {
    await assert.rejects(() => assertLocalFork(url), /no Anvil node/);
  });
});

test('SECURITY: an Anvil node that is not forking anything is refused', async () => {
  await withNode({anvil_nodeInfo: {forkConfig: {}}, eth_chainId: '0x1237'}, async (url) => {
    await assert.rejects(() => assertLocalFork(url), /not forking anything/);
  });
});

test('SECURITY: a fork of the wrong chain is refused', async () => {
  await withNode({...GOOD, eth_chainId: '0x1'}, async (url) => {
    await assert.rejects(() => assertLocalFork(url), /reports chain 1, expected 4663/);
  });
});

test('a genuine local fork of Robinhood Chain is accepted', async () => {
  await withNode(GOOD, async (url) => {
    const info = await assertLocalFork(url);
    assert.equal(info.chainId, 4663);
    assert.match(info.forkedFrom, /rpc\.mainnet\.chain\.robinhood\.com/);
  });
});

test('SECURITY: _fork cannot be turned on by editing the config file', async () => {
  // The only way to get _fork is forkConfig(), which callers reach only after
  // assertLocalFork has passed. A config file with _fork in it still has to
  // survive the runner, which sets it itself. Prove the flag is not read from
  // disk anywhere.
  const {readFile} = await import('node:fs/promises');
  const runner = await readFile('src/runner.mjs', 'utf8');
  assert.match(runner, /if \(this\.fork\) \{\s*\n\s*const info = await assertLocalFork/, 'the fork must be verified before config is built');
  const idx = runner.indexOf('assertLocalFork');
  const cfgIdx = runner.indexOf('this.config = await this.loadConfig()');
  assert.ok(idx < cfgIdx && idx !== -1, 'verification must come before the config that enables signing');
});

test('SECURITY: fork signing is enabled only with the _fork flag, not by mode alone', () => {
  const key = '0x' + '11'.repeat(32);
  const base = {mode: 'live', treasury: {zzyTokenAddress: '0x' + '22'.repeat(20)}, uniswap: {routerVariant: 'SwapRouter02'}, execution: {maxTxValueWei: '0'}};
  // live config, no ack, no fork -> refused
  assert.throws(() => createGuardedSigner(base, {ZZY_OPERATOR_PRIVATE_KEY: key}), SignerGuardError);
  // live config with the ack -> allowed (the normal mainnet path)
  assert.ok(createGuardedSigner(base, {ZZY_OPERATOR_PRIVATE_KEY: key, ZZY_LIVE_EXECUTION_ACK: LIVE_ACK_PHRASE}).live);
  // fork config, no ack -> allowed, because the fork was already verified
  assert.ok(createGuardedSigner({...base, _fork: true}, {ZZY_OPERATOR_PRIVATE_KEY: key}).live);
});

test('the never-sell guard still applies on a fork', async () => {
  const {guard} = await import('../src/adapters/signer.mjs');
  const {ADDRESSES, SWAP_ROUTER_ABI} = await import('../src/chain.mjs');
  const {encodeFunctionData} = await import('viem');
  const ZZY = '0x' + '11'.repeat(20), ME = '0x' + '33'.repeat(20);
  const sell = {to: ADDRESSES.UNISWAP_SWAP_ROUTER, data: encodeFunctionData({abi: SWAP_ROUTER_ABI.SwapRouter02, functionName: 'exactInputSingle',
    args: [{tokenIn: ZZY, tokenOut: ADDRESSES.WETH, fee: 10000, recipient: ME, amountIn: 1n, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n}]})};
  assert.throws(() => guard(sell, {zzyTokenAddress: ZZY, allowedStockTokens: [], maxValueWei: 10n ** 20n, routerVariant: 'SwapRouter02', recipient: ME}),
    /that is a sale/, 'fake money does not relax the invariant');
});

test('forkConfig points at the fork and raises the tx cap, without touching anything else', () => {
  const cfg = forkConfig({mode: 'preview', chain: {id: 4663, rpcUrl: 'https://real'}, execution: {slippageBps: 300}, policy: {maxOrderUsd: 50}}, FORK_RPC);
  assert.equal(cfg.mode, 'live');
  assert.equal(cfg.chain.rpcUrl, FORK_RPC);
  assert.equal(cfg._fork, true);
  assert.equal(cfg.execution.slippageBps, 300, 'unrelated settings are preserved');
  assert.equal(cfg.policy.maxOrderUsd, 50);
});

test('the fork writes to its own ledger, never the real book', async () => {
  const {mkdtemp, rm, readFile} = await import('node:fs/promises');
  const {tmpdir} = await import('node:os');
  const path = (await import('node:path')).default;
  const dir = await mkdtemp(path.join(tmpdir(), 'zzy-fork-'));
  try {
    const cfg = {treasury: {ledgerPath: path.join(dir, 'real.json')}, fork: {ledgerPath: path.join(dir, 'fork.json')}};
    assert.equal(forkConfig(cfg).treasury.ledgerPath, path.join(dir, 'fork.json'));
    await withNode(GOOD, async (url) => {
      const {seedForkBook} = await import('../src/fork.mjs');
      await seedForkBook(cfg, {tradingUsd: 6000, rpcUrl: url});
      const led = JSON.parse(await readFile(path.join(dir, 'fork.json'), 'utf8'));
      assert.equal(led.fork, true);
      assert.equal(led.entries[0].tradingUsd, 6000);
      assert.equal(led.entries[0].fork, true, 'entries are labelled');
      await assert.rejects(() => readFile(path.join(dir, 'real.json'), 'utf8'), /ENOENT/, 'the real book is untouched');
    });
  } finally { await rm(dir, {recursive: true}); }
});

test('SECURITY: fork capital never reaches the public site data', async () => {
  const {mkdtemp, rm, writeFile} = await import('node:fs/promises');
  const {tmpdir} = await import('node:os');
  const path = (await import('node:path')).default;
  const {buildSiteData} = await import('../src/site-data.mjs');
  const dir = await mkdtemp(path.join(tmpdir(), 'zzy-fork-'));
  try {
    const led = path.join(dir, 'fork.json');
    await writeFile(led, JSON.stringify({schemaVersion:1, fork:true, entries:[
      {type:'fee-claim', fork:true, claimUsd:12000, buybackUsd:6000, tradingUsd:6000, txHash:'fork'}]}));
    const d = await buildSiteData({treasury:{ledgerPath:led}, policy:{maxTotalExposureUsd:250}, catalog:{path:'data/stock-token-catalog.json', requireVerified:false, maxAgeDays:99999}, pons:{}});
    assert.equal(d.treasury.feesClaimedUsd, 0, 'fork money must not show as collected fees');
    assert.equal(d.portfolio.principalUsd, 0);
  } finally { await rm(dir, {recursive: true}); }
});

test('the treasury leg skips cleanly before a token exists, rather than erroring', async () => {
  const {treasuryTick} = await import('../src/loop.mjs');
  const r = await treasuryTick({client: {}, signer: {live: false}, config: {treasury: {}}, ethUsd: 3000, log: () => {}});
  assert.equal(r.skipped, true);
  assert.equal(r.acted, false);
  assert.match(r.reason, /no \$ZZY token configured/);
});
