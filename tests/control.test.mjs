import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Runner} from '../src/runner.mjs';
import {createControlServer, validateEdit, EDITABLE} from '../src/control-server.mjs';

// A runner whose chain-touching pieces are all fakes.
function fakeRunner(configPath, {paper = false} = {}) {
  return new Runner({configPath, paper, env: {}, deps: {
    publicClient: () => ({}),
    createGuardedSigner: () => ({live: false, address: null, send: async () => { throw new Error('no'); }}),
    loadCatalog: async () => ({verified: true, fetchedAt: new Date().toISOString(), symbols: [{symbol: 'NVDA', address: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC'}]}),
    treasuryTick: async () => ({acted: false}),
    tradingCycle: async () => ({acted: false, reason: 'stub'}),
    refreshCatalog: async () => ({symbolCount: 1}),
    writeSiteData: async () => ({}),
    ethUsd: async () => 3000,
  }});
}

async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), 'zzy-ctl-'));
  const configPath = path.join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({
    agentName: 'ZZY', mode: 'preview', chain: {id: 4663},
    runtime: {watchAddress: null},
    policy: {maxOrderUsd: 50, maxTotalExposureUsd: 250, maxPriceMovePercent: 3, minConfidenceToPrepare: 80},
    execution: {tickIntervalSeconds: 60, maxPoolPremiumPercent: 2},
    research: {intervalSeconds: 300, maxCandidatesPerCycle: 6},
    profitPolicy: {mode: 'threshold', compoundUntilUsd: 10000}, exitPolicy: {maxLossPercent: 25},
    treasury: {zzyTokenAddress: null, ledgerPath: path.join(dir, 'ledger.json')},
    paper: {ledgerPath: path.join(dir, 'paper.json')}, pons: {claimThresholdEth: 0.42}, site: {},
  }, null, 2));
  const runner = fakeRunner(configPath);
  const {server, token} = createControlServer({runner, configPath, root: 'control'});
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, p, body, tok = token, extra = {}) => fetch(base + p, {method, headers: {'x-zzy-token': tok, 'content-type': 'application/json', ...extra}, body: body ? JSON.stringify(body) : undefined});
  return {dir, configPath, runner, server, token, base, call, done: async () => { runner.pause(); await new Promise(r => server.close(r)); await rm(dir, {recursive: true}); }};
}

test('SECURITY: every API route refuses without the token', async () => {
  const s = await setup();
  try {
    for (const [m, p] of [['GET', '/api/state'], ['POST', '/api/resume'], ['POST', '/api/pause'], ['POST', '/api/tick'], ['POST', '/api/config'], ['POST', '/api/preflight'], ['POST', '/api/paper/reset']]) {
      assert.equal((await s.call(m, p, null, '')).status, 401, `${m} ${p} without token`);
      assert.equal((await s.call(m, p, null, 'wrong-' + s.token)).status, 401, `${m} ${p} wrong token`);
    }
  } finally { await s.done(); }
});

test('SECURITY: a cross-origin request is refused even with the token', async () => {
  const s = await setup();
  try {
    const r = await s.call('POST', '/api/pause', null, s.token, {origin: 'https://evil.example'});
    assert.equal(r.status, 403);
  } finally { await s.done(); }
});

test('SECURITY: mode cannot be edited from the panel, nor anything off the allowlist', async () => {
  const s = await setup();
  try {
    for (const [k, v] of [['mode', 'live'], ['execution.maxTxValueWei', '999999999999'], ['uniswap.routerVariant', 'SwapRouter'], ['pons.claim', {abi: ['function x()']}], ['treasury.ledgerPath', '/etc/passwd']]) {
      const r = await s.call('POST', '/api/config', {set: {[k]: v}});
      assert.equal(r.status, 400, k);
      assert.match((await r.json()).error, /cannot be edited/, k);
    }
    const cfg = JSON.parse(await readFile(s.configPath, 'utf8'));
    assert.equal(cfg.mode, 'preview', 'mode must be untouched');
    assert.ok(!('uniswap' in cfg) || cfg.uniswap?.routerVariant !== 'SwapRouter');
  } finally { await s.done(); }
});

test('SECURITY: the state response never contains a key', async () => {
  const s = await setup();
  try {
    process.env.ZZY_OPERATOR_PRIVATE_KEY = '0x' + 'ab'.repeat(32);
    const body = await (await s.call('GET', '/api/state')).text();
    assert.ok(!body.includes('ab'.repeat(32)));
    assert.ok(!body.includes('PRIVATE_KEY'));
  } finally { delete process.env.ZZY_OPERATOR_PRIVATE_KEY; await s.done(); }
});

test('allowlisted edits are validated, applied, and picked up on the next tick', async () => {
  const s = await setup();
  try {
    let r = await s.call('POST', '/api/config', {set: {'policy.maxOrderUsd': 75, 'research.maxCandidatesPerCycle': 4}});
    assert.equal(r.status, 200);
    const cfg = JSON.parse(await readFile(s.configPath, 'utf8'));
    assert.equal(cfg.policy.maxOrderUsd, 75);
    assert.equal(cfg.research.maxCandidatesPerCycle, 4);
    // an out-of-range value is refused and nothing in the batch is written
    r = await s.call('POST', '/api/config', {set: {'research.maxCandidatesPerCycle': 500, 'policy.maxOrderUsd': 999}});
    assert.equal(r.status, 400);
    assert.equal(JSON.parse(await readFile(s.configPath, 'utf8')).policy.maxOrderUsd, 75, 'a failed batch must not partially apply');
    // out-of-range is refused with the range in the message
    r = await s.call('POST', '/api/config', {set: {'policy.maxOrderUsd': -5}});
    assert.equal(r.status, 400); assert.match((await r.json()).error, /between/);
    // runner re-reads config before each tick
    await s.runner.tick();
    assert.equal(s.runner.config.policy.maxOrderUsd, 75);
  } finally { await s.done(); }
});

test('there is no watchlist and no research switch to edit: the agent watches everything, always', () => {
  assert.throws(() => validateEdit('runtime.watchlist', ['NVDA']), /cannot be edited/);
  assert.throws(() => validateEdit('research.enabled', false), /cannot be edited/);
  assert.throws(() => validateEdit('llmDecision.enabled', false), /cannot be edited/);
});

test('an address field takes a real address or null, nothing else', () => {
  assert.equal(validateEdit('treasury.zzyTokenAddress', null), null);
  assert.equal(validateEdit('treasury.zzyTokenAddress', '0x' + '1'.repeat(40)), '0x' + '1'.repeat(40));
  assert.throws(() => validateEdit('treasury.zzyTokenAddress', 'not-an-address'), /invalid/);
});

test('start, pause, resume and single tick drive the runner state machine', async () => {
  const s = await setup();
  try {
    let st = await (await s.call('GET', '/api/state')).json();
    assert.equal(st.runner.state, 'stopped');
    await s.call('POST', '/api/tick');
    st = await (await s.call('GET', '/api/state')).json();
    assert.equal(st.runner.tickCount, 1); assert.equal(st.runner.state, 'paused', 'a manual tick leaves it paused');
    await s.call('POST', '/api/resume');
    st = await (await s.call('GET', '/api/state')).json();
    assert.ok(['idle', 'ticking'].includes(st.runner.state));
    await s.call('POST', '/api/pause');
    await new Promise(r => setTimeout(r, 30));
    st = await (await s.call('GET', '/api/state')).json();
    assert.equal(st.runner.state, 'paused');
  } finally { await s.done(); }
});

test('the runner pins mode at start: a config edit cannot promote preview to live', async () => {
  const s = await setup();
  try {
    await s.runner.start();
    const cfg = JSON.parse(await readFile(s.configPath, 'utf8')); cfg.mode = 'live';
    await writeFile(s.configPath, JSON.stringify(cfg));   // simulate a manual file edit, bypassing the allowlist
    const reloaded = await s.runner.loadConfig();
    assert.equal(reloaded.mode, 'preview', 'mode is pinned for the life of the process');
    assert.equal(s.runner.signer.live, false);
  } finally { await s.done(); }
});

test('the panel binds to 127.0.0.1 in listenControl and nothing in config can change that', async () => {
  const src = await readFile('src/control-server.mjs', 'utf8');
  assert.match(src, /server\.listen\(port, '127\.0\.0\.1'/);
  assert.ok(!/control\.host|bindAddress|listenHost/.test(src), 'no bind-address option should exist');
});

test('the edit allowlist does not include anything that changes the trust boundary', () => {
  for (const k of Object.keys(EDITABLE)) {
    assert.ok(!/^mode$|maxTxValueWei|routerVariant|pons\.claim(able)?$|pons\.claim(able)?\.|ledgerPath|rpcUrl|PRIVATE_KEY|EXECUTION_ACK|_paper|_fork/i.test(k), `${k} should not be editable from the panel`);
  }
});
