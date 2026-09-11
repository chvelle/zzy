// The book's cash is USDG. These pin the conversions and the funding path.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {toCash, fromCash, cashDecimals, cashBalance, _resetCashDecimals, CASH} from '../src/cash.mjs';
import {recordDeposit, readLedger} from '../src/treasury.mjs';
import {bookState} from '../src/profit.mjs';
import {planWethToCash} from '../src/adapters/uniswap.mjs';
import {ADDRESSES} from '../src/chain.mjs';
import {decodeFunctionData} from 'viem';
import {SWAP_ROUTER_ABI} from '../src/chain.mjs';

test('USDG amounts round-trip at six decimals and never through 1e18', () => {
  assert.equal(toCash(62.5, 6), 62_500_000n);
  assert.equal(fromCash(62_500_000n, 6), 62.5);
  assert.equal(toCash(0.001, 6), 1000n);
  assert.equal(fromCash(1n, 6), 0.000001);
});

test('cash decimals are read once and an implausible answer falls back to six', async () => {
  _resetCashDecimals();
  let reads = 0;
  const client = {async readContract({address, functionName}) { reads++; if (functionName === 'decimals') return 6; return 1_000_000n; }};
  assert.equal(await cashDecimals(client), 6);
  assert.equal(await cashDecimals(client), 6);
  assert.equal(reads, 1, 'cached');
  _resetCashDecimals();
  const bad = {async readContract() { throw new Error('revert'); }};
  assert.equal(await cashDecimals(bad), 6);
  _resetCashDecimals();
  const b = await cashBalance(client, '0x3333333333333333333333333333333333333333');
  assert.equal(b.usd, 1);
  assert.equal(CASH, ADDRESSES.USDG);
});

test('an operator deposit becomes principal, and cannot exceed what the wallet holds', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zzy-cash-'));
  try {
    const config = {treasury: {ledgerPath: path.join(dir, 'l.json')}, policy: {maxTotalExposureUsd: 10000}};
    await assert.rejects(recordDeposit({amountUsd: 500, walletUsd: 120}, config), /wallet holds \$120\.00/);
    await recordDeposit({amountUsd: 500, walletUsd: 500}, config);
    const st = bookState(await readLedger(config), config);
    assert.equal(st.principalUsd, 500);
    assert.equal(st.bookValueUsd, 500);
  } finally { await rm(dir, {recursive: true}); }
});

test('the trading half of a claim is planned as WETH -> USDG through the best stable tier', async () => {
  const seen = [];
  const client = {async simulateContract({args}) { seen.push(args[0].fee); return {result: [args[0].fee === 500 ? 2_500_000_000n : 2_400_000_000n, 0n, 0, 0n]}; }};
  const plan = await planWethToCash(client, {amountWei: 10n ** 18n, slippageBps: 50, recipient: '0x3333333333333333333333333333333333333333', routerVariant: 'SwapRouter02'});
  assert.deepEqual(seen, [100, 500, 3000], 'only stable-ish tiers are tried for the cash leg');
  assert.equal(plan.fee, 500);
  const {args} = decodeFunctionData({abi: SWAP_ROUTER_ABI.SwapRouter02, data: plan.swap.data});
  assert.equal(args[0].tokenIn.toLowerCase(), ADDRESSES.WETH.toLowerCase());
  assert.equal(args[0].tokenOut.toLowerCase(), ADDRESSES.USDG.toLowerCase());
  assert.equal(args[0].amountOutMinimum, 2_487_500_000n, '0.5% under the quote');
});
