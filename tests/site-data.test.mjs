import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {buildSiteData} from '../src/site-data.mjs';

const base = (dir) => ({
  agentName: 'ZZY', mode: 'preview',
  chain: {id: 4663},
  policy: {maxTotalExposureUsd: 250, maxOrderUsd: 50},
  catalog: {path: 'data/stock-token-catalog.json', requireVerified: true, maxAgeDays: 3650},
  treasury: {zzyTokenAddress: null, buybackShareBps: 5000, tradingShareBps: 5000, ledgerPath: path.join(dir, 'ledger.json')},
  pons: {claimThresholdEth: 0.42},
});

test('with no ledger and no token, the page gets zeros and launched:false', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zzy-site-'));
  try {
    const d = await buildSiteData(base(dir));
    assert.equal(d.treasury.launched, false);
    assert.equal(d.treasury.zzyBoughtUsd, 0);
    assert.equal(d.treasury.claimCount, 0);
    assert.equal(d.portfolio.deployableUsd, 0);
    assert.equal(d.activity.ordersExecuted, 0);
    assert.equal(d.agent.live, false, 'preview must never report as live');
  } finally { await rm(dir, {recursive: true}); }
});

test('a real ledger flows through to the numbers the page shows', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zzy-site-'));
  try {
    const config = base(dir);
    await writeFile(config.treasury.ledgerPath, JSON.stringify({schemaVersion: 1, entries: [
      {type: 'fee-claim', at: '2026-09-01T00:00:00.000Z', claimUsd: 200, buybackUsd: 100, tradingUsd: 100, txHash: '0xabc'},
      {type: 'realized-pnl', at: '2026-09-02T00:00:00.000Z', amountUsd: 25},
    ]}));
    const d = await buildSiteData(config);
    assert.equal(d.treasury.zzyBoughtUsd, 100);
    assert.equal(d.treasury.claimCount, 1);
    assert.equal(d.treasury.buybacks[0].txHash, '0xabc');
    // principal is what the agent was given; book value is what it became
    assert.equal(d.portfolio.principalUsd, 100);
    assert.equal(d.portfolio.realizedPnlUsd, 25);
    assert.equal(d.portfolio.bookValueUsd, 125);
    assert.equal(d.portfolio.deployableUsd, 125);
    assert.equal(d.portfolio.sweptToBuybackUsd, 0);
    assert.equal(d.portfolio.profitMode, 'threshold');
  } finally { await rm(dir, {recursive: true}); }
});

test('sample-fixture decisions never count as real activity on a public page', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zzy-site-'));
  const decisions = path.join(process.cwd(), 'decisions');
  try {
    await mkdir(decisions, {recursive: true});
    const f = path.join(decisions, '2099-01-01T00-00-00-000Z-sitetest.json');
    await writeFile(f, JSON.stringify({
      generatedAt: '2099-01-01T00:00:00.000Z', asset: {symbol: 'SAMPLE'},
      decision: 'PREPARE', confidence: 90, sample: true, policy: {failures: []},
    }));
    const d = await buildSiteData(base(dir));
    assert.equal(d.activity.decisionsLogged, 0, 'sample data must not inflate the public decision count');
    assert.equal(d.activity.ordersExecuted, 0, 'a sample PREPARE is not an executed order');
    await rm(f);
  } finally { await rm(dir, {recursive: true}); }
});

test('the exporter never invents positions it cannot verify', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zzy-site-'));
  try {
    const d = await buildSiteData(base(dir));
    assert.deepEqual(d.portfolio.positions, []);
  } finally { await rm(dir, {recursive: true}); }
});

test('SECURITY: a private key in the environment can never reach the public data file', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zzy-site-'));
  const fakeKey = '0x' + 'ab'.repeat(32);
  const prev = {k: process.env.ZZY_OPERATOR_PRIVATE_KEY, a: process.env.ANTHROPIC_API_KEY, ack: process.env.ZZY_LIVE_EXECUTION_ACK};
  process.env.ZZY_OPERATOR_PRIVATE_KEY = fakeKey;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-should-never-leak';
  process.env.ZZY_LIVE_EXECUTION_ACK = 'I_UNDERSTAND_THIS_SIGNS_TRANSACTIONS_WITH_REAL_FUNDS';
  try {
    const config = {...base(dir), pons: {claimThresholdEth: 0.42, claim: {abi: ['function secretClaim()'], functionName: 'secretClaim'}}, uniswap: {routerVariant: 'SwapRouter02'}, chain: {id: 4663, rpcUrl: 'https://rpc.mainnet.chain.robinhood.com'}};
    const out = JSON.stringify(await buildSiteData(config));
    assert.ok(!out.includes(fakeKey), 'private key leaked into site data');
    assert.ok(!out.includes('sk-ant-'), 'API key leaked into site data');
    assert.ok(!out.includes('I_UNDERSTAND'), 'live ack phrase leaked into site data');
    assert.ok(!out.includes('secretClaim'), 'contract ABI config leaked into site data');
    assert.ok(!out.includes('ledgerPath') && !out.includes(dir), 'filesystem path leaked into site data');
    assert.ok(!out.includes('rpc.mainnet'), 'RPC URL leaked into site data');
  } finally {
    for (const [k, v] of [['ZZY_OPERATOR_PRIVATE_KEY', prev.k], ['ANTHROPIC_API_KEY', prev.a], ['ZZY_LIVE_EXECUTION_ACK', prev.ack]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    await rm(dir, {recursive: true});
  }
});

test('SECURITY: fees are exposed, the operator wallet is not', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zzy-site-'));
  try {
    const config = {...base(dir), runtime: {watchAddress: '0x3333333333333333333333333333333333333333', watchlist: ['NVDA']}};
    await writeFile(config.treasury.ledgerPath, JSON.stringify({schemaVersion: 1, entries: [
      {type: 'fee-claim', at: '2026-09-01T00:00:00.000Z', claimUsd: 200, claimEth: 0.05, buybackUsd: 100, tradingUsd: 100, txHash: '0xabc'},
    ]}));
    const d = await buildSiteData(config);
    // The wallet is discoverable on chain, but publishing it invites
    // copy-trading, so it stays off the page and out of the export.
    assert.ok(!JSON.stringify(d).includes('0x3333333333333333333333333333333333333333'), 'operator wallet must not be published');
    assert.equal(d.treasury.feesClaimedUsd, 200);
    assert.equal(d.treasury.feesClaimedEth, 0.05);
    assert.equal(JSON.stringify(d).includes('watchlist'), false, 'the watchlist is strategy, not public');
  } finally { await rm(dir, {recursive: true}); }
});

test('open positions are marked to market, so the page moves between trades', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zzy-site-'));
  try {
    const config = base(dir);
    config.positions = {path: path.join(dir, 'positions.json')};
    await writeFile(config.treasury.ledgerPath, JSON.stringify({schemaVersion: 1, entries: [
      {type: 'fee-claim', at: '2026-09-01T00:00:00.000Z', claimUsd: 200, buybackUsd: 100, tradingUsd: 100, txHash: '0xabc'},
    ]}));
    await writeFile(config.positions.path, JSON.stringify({schemaVersion: 1, positions: {
      NVDA: {symbol: 'NVDA', qty: 2, costBasisUsd: 100, openedAt: '2026-09-02T00:00:00.000Z'},
    }}));

    const up = await buildSiteData(config, {quote: async () => ({mid: 75})});
    assert.equal(up.portfolio.openPnlUsd, 50, '2 x 75 against a 100 basis is +50 open');
    assert.equal(up.portfolio.openPositionsUsd, 150);
    assert.equal(up.portfolio.totalPnlUsd, 50);

    const down = await buildSiteData(config, {quote: async () => ({mid: 30})});
    assert.equal(down.portfolio.openPnlUsd, -40, 'unrealised PnL has to be able to go negative');
    assert.ok(down.portfolio.markToMarketUsd < up.portfolio.markToMarketUsd);

    // settled figures must not move with the mark
    assert.equal(up.portfolio.lifetimeProfitUsd, down.portfolio.lifetimeProfitUsd);
    assert.equal(up.portfolio.bookValueUsd, down.portfolio.bookValueUsd);
  } finally { await rm(dir, {recursive: true}); }
});

test('a symbol that will not quote is held at cost, never at a guess', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zzy-site-'));
  try {
    const config = base(dir);
    config.positions = {path: path.join(dir, 'positions.json')};
    await writeFile(config.positions.path, JSON.stringify({schemaVersion: 1, positions: {
      NVDA: {symbol: 'NVDA', qty: 2, costBasisUsd: 100, openedAt: '2026-09-02T00:00:00.000Z'},
    }}));
    const d = await buildSiteData(config, {quote: async () => { throw new Error('feed down'); }});
    assert.equal(d.portfolio.openPnlUsd, 0, 'no price means no claimed PnL');
    assert.equal(d.portfolio.unpricedPositions, 1);
    assert.equal(d.portfolio.positions[0].valueUsd, null);
  } finally { await rm(dir, {recursive: true}); }
});
