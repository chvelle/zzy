// Each test here pins a bug found in the September 2026 sweep. If one of
// these fails, something that used to lose money has come back.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {readJsonOrDefault, writeJsonAtomic} from '../src/storage.mjs';
import {loadPositions} from '../src/positions.mjs';
import {readLedger, adjustWethBaseline} from '../src/treasury.mjs';
import {treasuryTick} from '../src/loop.mjs';

const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';

test('a corrupt positions file halts instead of reporting no positions', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zzy-reg-'));
  try {
    const file = path.join(dir, 'positions.json');
    await writeFile(file, '{"schemaVersion":1,"positions":{"NVDA":{"qty":1,"costBas');   // killed mid-write
    await assert.rejects(loadPositions({positions: {path: file}}), /not valid JSON/);
  } finally { await rm(dir, {recursive: true}); }
});

test('a corrupt ledger halts instead of returning an empty ledger with a zero baseline', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zzy-reg-'));
  try {
    const file = path.join(dir, 'ledger.json');
    await writeFile(file, '{"schemaVersion":1,"wethBaselineEth":4.2,"entries":[');
    await assert.rejects(readLedger({treasury: {ledgerPath: file}}), /not valid JSON/);
  } finally { await rm(dir, {recursive: true}); }
});

test('a missing state file is still a fresh start', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zzy-reg-'));
  try {
    const d = await readJsonOrDefault(path.join(dir, 'nope.json'), {a: 1});
    assert.deepEqual(d, {a: 1});
  } finally { await rm(dir, {recursive: true}); }
});

test('an atomic write leaves the previous version readable as .bak and no temp file behind', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zzy-reg-'));
  try {
    const file = path.join(dir, 's.json');
    await writeJsonAtomic(file, {v: 1}, {backup: true});
    await writeJsonAtomic(file, {v: 2}, {backup: true});
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {v: 2});
    assert.deepEqual(JSON.parse(await readFile(`${file}.bak`, 'utf8')), {v: 1});
    const {readdir} = await import('node:fs/promises');
    assert.ok(!(await readdir(dir)).some(f => f.endsWith('.tmp')), 'temp file cleaned up');
  } finally { await rm(dir, {recursive: true}); }
});

test('stock sale proceeds are not mistaken for creator fees', async () => {
  // Wallet holds 1 WETH at baseline 1. A stock sale returns 0.5 WETH. The
  // engine raises the baseline by 0.5. The treasury tick must then see zero
  // fresh proceeds, not 0.5 WETH to split and half-buy into $ZZY.
  const dir = await mkdtemp(path.join(tmpdir(), 'zzy-reg-'));
  try {
    const config = {treasury: {ledgerPath: path.join(dir, 'l.json'), zzyTokenAddress: '0x1111111111111111111111111111111111111111', minProceedsEth: 0.01, buybackShareBps: 5000, tradingShareBps: 5000},
      pons: {claimThresholdEth: 0.42}, uniswap: {routerVariant: 'SwapRouter02'}, execution: {}, runtime: {watchAddress: '0x3333333333333333333333333333333333333333'}};
    await writeJsonAtomic(config.treasury.ledgerPath, {schemaVersion: 1, wethBaselineEth: 1, entries: []});
    let weth = 15n * 10n ** 17n;   // 1.5 WETH after the sale
    const client = {async readContract({address, functionName}) {
      if (functionName === 'decimals') return 18;
      return address.toLowerCase() === WETH ? weth : 0n; }};
    const signer = {live: false, address: null};

    await adjustWethBaseline(0.5, config);
    const r = await treasuryTick({client, signer, config, ethUsd: 3000, log: () => {}});
    assert.equal(r.acted, false, 'nothing to split');
    assert.match(r.reason, /unallocated WETH 0\.000000/);
  } finally { await rm(dir, {recursive: true}); }
});

test('a stock buy lowers the baseline so later fees are still visible', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zzy-reg-'));
  try {
    const config = {treasury: {ledgerPath: path.join(dir, 'l.json')}};
    await writeJsonAtomic(config.treasury.ledgerPath, {schemaVersion: 1, wethBaselineEth: 1, entries: []});
    const next = await adjustWethBaseline(-0.3, config);
    assert.equal(next, 0.7);
    const neverNegative = await adjustWethBaseline(-5, config);
    assert.equal(neverNegative, 0);
  } finally { await rm(dir, {recursive: true}); }
});

test('a reverted swap records nothing and moves no baseline', async () => {
  const {forceBuy} = await import('../src/engine.mjs');
  (await import('../src/cash.mjs'))._resetCashDecimals();
  const dir = await mkdtemp(path.join(tmpdir(), 'zzy-reg-'));
  try {
    const config = {_fork: true, uniswap: {routerVariant: 'SwapRouter02'}, execution: {}, treasury: {ledgerPath: path.join(dir, 'l.json')}, positions: {path: path.join(dir, 'p.json')}, decisions: {path: path.join(dir, 'decisions')}, notebook: {path: path.join(dir, 'nb.json')}, earnings: {path: path.join(dir, 'earn.json')}};
    await writeJsonAtomic(config.treasury.ledgerPath, {schemaVersion: 1, wethBaselineEth: 1, entries: []});
    const catalog = {symbols: [{symbol: 'NVDA', name: 'NVIDIA', address: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC'}]};
    const sent = [];
    const signer = {live: true, address: '0x3333333333333333333333333333333333333333', async send(tx) { sent.push(tx); return '0xh' + sent.length; }};
    const client = {
      async readContract({address, functionName}) { if (functionName === 'decimals') return address.toLowerCase() === '0x5fc5360d0400a0fd4f2af552add042d716f1d168' ? 6 : 18; if (address.toLowerCase() === '0x5fc5360d0400a0fd4f2af552add042d716f1d168') return 100_000_000n; return address.toLowerCase() === WETH ? 10n ** 18n : 0n; },
      async simulateContract() { return {result: [10n ** 17n, 0n, 0, 0n]}; },
      async waitForTransactionReceipt() { return {status: sent.length === 1 ? 'success' : 'reverted', blockNumber: 1n}; },
    };
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ok: true, json: async () => ({quotes: [{tokenSymbol: 'NVDA', bid: '100', ask: '100', dailyTradingVolume: '1', generatedAt: new Date().toISOString()}]})});
    try {
      await assert.rejects(forceBuy({client, signer, config, catalog, symbol: 'NVDA', usd: 20, ethUsd: 3000, log: () => {}}), /reverted on-chain/);
      assert.deepEqual((await loadPositions(config)).positions, {}, 'no phantom position');
      assert.equal((await readLedger(config)).wethBaselineEth, 1, 'baseline untouched');
    } finally { globalThis.fetch = realFetch; }
  } finally { await rm(dir, {recursive: true}); }
});

test('room is capped by the USDG actually in the wallet, not just the ledger', async () => {
  const {tradingCycle} = await import('../src/engine.mjs');
  (await import('../src/cash.mjs'))._resetCashDecimals();
  const {writeJsonAtomic} = await import('../src/storage.mjs');
  const dir = await mkdtemp(path.join(tmpdir(), 'zzy-reg-'));
  try {
    const now = new Date('2026-09-09T12:00:00Z');
    const config = {mode: 'live', uniswap: {routerVariant: 'SwapRouter02'}, execution: {quoteConcurrency: 4}, policy: {maxTotalExposureUsd: 10000, maxOrderUsd: null, sizing: {maxPositionPercent: 60, maxOrderPercent: 100, minOrderUsd: 5}},
      research: {intervalSeconds: 0, maxCandidatesPerCycle: 3, minInterestScore: 0, maxSearchesPerCycle: 1}, catalog: {path: path.join(dir, 'c.json'), requireVerified: false},
      treasury: {ledgerPath: path.join(dir, 'l.json')}, positions: {path: path.join(dir, 'p.json')}, prices: {path: path.join(dir, 'pr.json')},
      decisions: {path: path.join(dir, 'decisions')}, notebook: {path: path.join(dir, 'nb.json')}, earnings: {path: path.join(dir, 'earn.json')}, news: {edgarUserAgent: 't t@t.t'}};
    // ledger says $5000 of principal; the wallet only has $300 USDG
    await writeJsonAtomic(config.treasury.ledgerPath, {schemaVersion: 1, entries: [{type: 'deposit', at: now.toISOString(), tradingUsd: 5000}]});
    await writeJsonAtomic(config.prices.path, {schemaVersion: 1, symbols: {NVDA: [[now.getTime() - 300000, 100]]}});
    const catalog = {verified: true, fetchedAt: now.toISOString(), symbols: [{symbol: 'NVDA', name: 'NVIDIA', address: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC'}]};
    const sent = [];
    const signer = {live: true, address: '0x3333333333333333333333333333333333333333', async send(tx) { sent.push(tx); return '0xh' + sent.length; }};
    let tok = 0n;
    const client = {
      async readContract({address, functionName}) {
        const a = address.toLowerCase();
        if (functionName === 'decimals') return a === '0x5fc5360d0400a0fd4f2af552add042d716f1d168' ? 6 : 18;
        if (a === '0x5fc5360d0400a0fd4f2af552add042d716f1d168') return 300_000_000n;
        return tok;
      },
      // USDG (6 dec) in, tokens (18 dec) out at $100 each
      async simulateContract({args}) { return {result: [args[0].amountIn * 10n ** 12n / 100n, 0n, 0, 0n]}; },
      async waitForTransactionReceipt() { tok = 18n * 10n ** 17n; return {status: 'success'}; },
    };
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('rhj/prices')) return {ok: true, json: async () => ({quotes: [{tokenSymbol: 'NVDA', bid: '100', ask: '100', dailyTradingVolume: '1', generatedAt: now.toISOString()}]})};
      if (u.includes('api.anthropic.com')) return {ok: true, json: async () => ({content: [{type: 'text', text: JSON.stringify({holdings: [], candidates: [{symbol: 'NVDA', verdict: 'PREPARE', confidence: 90, targetWeightPercent: 60, rationale: 'x', downsideCase: 'y', falsifier: 'z', sources: ['https://a']}]})}]})};
      return {ok: true, json: async () => ({}), text: async () => ''};
    };
    const lines = [];
    const prevKey = process.env.ANTHROPIC_API_KEY; process.env.ANTHROPIC_API_KEY = 'test';
    try {
      const r = await tradingCycle({client, signer, config, catalog, ethUsd: 3000, now, log: (m) => lines.push(m), state: {verdictOverrides: {}}});
      assert.equal(r.buys.length, 1);
      assert.equal(r.buys[0].usd, 180, '60% target of the $300 actually in the wallet, not of the $5000 ledger');
      assert.ok(lines.some(l => /wallet holds \$300\.00 USDG/.test(l)), 'the mismatch is said out loud');
      const {decodeFunctionData} = await import('viem');
      const {SWAP_ROUTER_ABI} = await import('../src/chain.mjs');
      const swap = sent.find(t => t.to.toLowerCase() === '0xcaf681a66d020601342297493863e78c959e5cb2');
      const {args} = decodeFunctionData({abi: SWAP_ROUTER_ABI.SwapRouter02, data: swap.data});
      assert.equal(args[0].tokenIn.toLowerCase(), '0x5fc5360d0400a0fd4f2af552add042d716f1d168', 'the buy spends USDG');
    } finally { globalThis.fetch = realFetch; if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevKey; }
  } finally { await rm(dir, {recursive: true}); }
});
