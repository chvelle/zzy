import test from 'node:test';
import assert from 'node:assert/strict';
import {parseEther} from 'viem';
import {checkRpc, checkDeployed, detectRouterVariant, ROUTER_SELECTORS,
        checkPool, checkBalances, checkApprove, checkSwap, checkClaim, preflight} from '../src/preflight.mjs';
import {ADDRESSES} from '../src/chain.mjs';

const ME = '0x3333333333333333333333333333333333333333';
const NVDA = '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC';

// A node stub. `revert` makes eth_call throw the way a real revert would.
const node = (o = {}) => ({
  getChainId: async () => o.chainId ?? 4663,
  getBlockNumber: async () => 1234n,
  getCode: async ({address}) => (o.code ?? {})[address] ?? '0xdeadbeef',
  getBalance: async () => o.balance ?? parseEther('0.05'),
  readContract: async () => o.weth ?? 0n,
  call: async () => { if (o.revert) throw Object.assign(new Error(o.revert), {shortMessage: o.revert}); return {data:'0x'}; },
  simulateContract: async () => { if (o.noPool) throw new Error('no pool'); return {result: [parseEther('1'), 0n, 0, 0n]}; },
});

test('a wrong chain is caught before anything else', async () => {
  const r = await checkRpc(node({chainId: 42161}), 4663);
  assert.equal(r.ok, false);
  assert.match(r.detail, /wrong chain/);
});

test('an address with no bytecode is reported as not deployed', async () => {
  const r = await checkDeployed(node({code: {[ADDRESSES.WETH]: '0x'}}), 'WETH', ADDRESSES.WETH);
  assert.equal(r.ok, false);
  assert.match(r.detail, /no bytecode/);
});

test('the two router variants have genuinely different selectors', () => {
  assert.notEqual(ROUTER_SELECTORS.SwapRouter, ROUTER_SELECTORS.SwapRouter02,
    'if these matched, the bytecode test could not tell them apart');
});

test('the router variant is read off the deployed bytecode, not from config', async () => {
  const withDeadline = node({code: {[ADDRESSES.UNISWAP_SWAP_ROUTER]: '0x60' + ROUTER_SELECTORS.SwapRouter.slice(2) + '80'}});
  assert.equal((await detectRouterVariant(withDeadline)).variant, 'SwapRouter');
  const without = node({code: {[ADDRESSES.UNISWAP_SWAP_ROUTER]: '0x60' + ROUTER_SELECTORS.SwapRouter02.slice(2) + '80'}});
  assert.equal((await detectRouterVariant(without)).variant, 'SwapRouter02');
});

test('a proxy with neither selector is flagged rather than guessed at', async () => {
  const r = await detectRouterVariant(node({code: {[ADDRESSES.UNISWAP_SWAP_ROUTER]: '0xabcdef'}}));
  assert.equal(r.ok, false);
  assert.equal(r.variant, null);
  assert.match(r.detail, /proxy/);
});

test('a missing pool is reported instead of a swap being attempted', async () => {
  const r = await checkPool(node({noPool: true}), {tokenIn: ADDRESSES.WETH, tokenOut: NVDA, amountIn: 1n});
  assert.equal(r.ok, false);
  assert.match(r.detail, /no pool on any tier/);
});

test('an empty wallet is called out, since every transaction would fail', async () => {
  const r = await checkBalances(node({balance: 0n}), ME);
  assert.equal(r.ok, false);
  assert.match(r.detail, /no gas/);
});

test('a reverting transaction surfaces the revert reason rather than passing', async () => {
  const r = await checkApprove(node({revert: 'ERC20: insufficient allowance'}), ME, 1n);
  assert.equal(r.ok, false);
  assert.match(r.detail, /insufficient allowance/);
});

test('a clean simulation reports ok', async () => {
  assert.equal((await checkApprove(node(), ME, 1n)).ok, true);
  assert.equal((await checkSwap(node(), ME, {tokenOut: NVDA, fee: 3000, amountIn: 1n, variant: 'SwapRouter02'})).ok, true);
});

test('the swap encodes deadline only for the variant that takes one', async () => {
  // If the wrong ABI were used the encode would throw, so a clean result for
  // both variants proves each is encoded against its own struct.
  for (const variant of ['SwapRouter', 'SwapRouter02']) {
    assert.equal((await checkSwap(node(), ME, {tokenOut: NVDA, fee: 3000, amountIn: 1n, variant})).ok, true, variant);
  }
  const bad = await checkSwap(node(), ME, {tokenOut: NVDA, fee: 3000, amountIn: 1n, variant: 'Nonsense'});
  assert.equal(bad.ok, false);
});

test('an unconfigured pons claim is skipped with instructions, not failed silently', async () => {
  const r = await checkClaim(node(), ME, {pons: {}, treasury: {zzyTokenAddress: '0x1'}});
  assert.equal(r.skipped, true);
  assert.match(r.detail, /SETUP.md/);
});

test('a configured claim that reverts is caught before it matters', async () => {
  const cfg = {treasury: {zzyTokenAddress: NVDA},
    pons: {locker: ADDRESSES.PONS_LOCKER, claim: {abi: ['function claimFees(address token)'], functionName: 'claimFees'}}};
  const r = await checkClaim(node({revert: 'not the creator'}), ME, cfg);
  assert.equal(r.ok, false);
  assert.match(r.detail, /not the creator/);
});

test('preflight runs without a wallet and still checks the plumbing', async () => {
  const cfg = {chain: {id: 4663}, runtime: {watchlist: []}, pons: {}};
  const r = await preflight(node(), cfg);
  assert.ok(r.checks.length >= 5);
  assert.equal(r.account, null);
  assert.ok(r.checks.some(c => c.name === 'RPC connection' && c.ok));
});

test('preflight is not ready when any check fails', async () => {
  const r = await preflight(node({chainId: 1}), {chain: {id: 4663}, runtime: {watchlist: []}, pons: {}});
  assert.equal(r.ready, false);
  assert.ok(r.failed > 0);
});
