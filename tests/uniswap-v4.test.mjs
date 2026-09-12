// The stock legs on Uniswap v4: quoting, the venue choice, the Permit2 route,
// and the signer's view of all of it.
import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeFunctionData, decodeFunctionData, decodeAbiParameters, zeroAddress} from 'viem';
import {bestV4Quote, buildV4SwapTx, permit2Route, v4PoolKey, V4_CONFIGS} from '../src/adapters/uniswap-v4.mjs';
import {bestVenueQuote} from '../src/engine.mjs';
import {guard, SignerGuardError} from '../src/adapters/signer.mjs';
import {ADDRESSES, ERC20_ABI} from '../src/chain.mjs';
import {UNISWAP_V4, UNIVERSAL_ROUTER_ABI, RH_V4_SWAP_EXACT_IN_SINGLE, PERMIT2_ABI} from '../src/adapters/pons-v2.mjs';

const STOCK = '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC';
const ZZY = '0x1111111111111111111111111111111111111111';
const ME = '0x3333333333333333333333333333333333333333';
const ctx = {zzyTokenAddress: ZZY, allowedStockTokens: [STOCK], maxValueWei: 0n, routerVariant: 'SwapRouter02', recipient: ME, ponsClaimSelector: null};

test('v4 quotes every hookless config and keeps the best; no pool means null, not a throw', async () => {
  const seen = [];
  const client = {async simulateContract({args}) { const fee = args[0].poolKey.fee; seen.push(fee); if (fee === 3000) throw new Error('no pool'); return {result: [BigInt(fee) * 1000n, 0n]}; }};
  const q = await bestV4Quote(client, {tokenIn: ADDRESSES.USDG, tokenOut: STOCK, amountIn: 1_000_000n});
  assert.deepEqual(seen, V4_CONFIGS.map(c => c.fee));
  assert.equal(q.fee, 10000); assert.equal(q.venue, 'v4');
  assert.equal(q.key.hooks, zeroAddress);
  const none = await bestV4Quote({async simulateContract() { throw new Error('nope'); }}, {tokenIn: ADDRESSES.USDG, tokenOut: STOCK, amountIn: 1n});
  assert.equal(none, null);
});

test('the engine takes whichever venue quotes more, and survives one venue missing', async () => {
  // v3 quoter and v4 quoter are told apart by the address they are called at
  const mk = (v3Out, v4Out) => ({async simulateContract({address}) {
    if (address.toLowerCase() === ADDRESSES.UNISWAP_QUOTER_V2.toLowerCase()) { if (v3Out == null) throw new Error('no v3'); return {result: [v3Out, 0n, 0, 0n]}; }
    if (v4Out == null) throw new Error('no v4'); return {result: [v4Out, 0n]};
  }});
  const lines = [];
  let q = await bestVenueQuote(mk(10n, 500n), {tokenIn: ADDRESSES.USDG, tokenOut: STOCK, amountIn: 1n}, m => lines.push(m));
  assert.equal(q.venue, 'v4'); assert.ok(lines.some(l => /taking v4/.test(l)));
  q = await bestVenueQuote(mk(900n, 500n), {tokenIn: ADDRESSES.USDG, tokenOut: STOCK, amountIn: 1n});
  assert.equal(q.venue, 'v3');
  q = await bestVenueQuote(mk(null, 500n), {tokenIn: ADDRESSES.USDG, tokenOut: STOCK, amountIn: 1n});
  assert.equal(q.venue, 'v4');
  await assert.rejects(bestVenueQuote(mk(null, null), {tokenIn: ADDRESSES.USDG, tokenOut: STOCK, amountIn: 1n}), /no Uniswap pool/);
});

test('the Permit2 route is only what is missing', async () => {
  const now = 1_000_000;
  const client = (erc20, p2amt, p2exp) => ({async readContract({address, functionName}) {
    if (functionName === 'allowance' && address.toLowerCase() === UNISWAP_V4.PERMIT2.toLowerCase()) return [p2amt, p2exp, 0];
    if (functionName === 'allowance') return erc20;
    throw new Error('unexpected');
  }});
  assert.equal((await permit2Route(client(0n, 0n, 0), {owner: ME, token: ADDRESSES.USDG, amount: 100n, now})).length, 2);
  assert.equal((await permit2Route(client(10n ** 30n, 0n, 0), {owner: ME, token: ADDRESSES.USDG, amount: 100n, now})).length, 1);
  assert.equal((await permit2Route(client(10n ** 30n, 10n ** 30n, now + 10), {owner: ME, token: ADDRESSES.USDG, amount: 100n, now})).length, 0);
  assert.equal((await permit2Route(client(10n ** 30n, 10n ** 30n, now - 1), {owner: ME, token: ADDRESSES.USDG, amount: 100n, now})).length, 1, 'expired Permit2 allowance is renewed');
});

test('the signer signs a v4 USDG->stock buy and stock->USDG sell on a hookless pool, and refuses everything adjacent', () => {
  const key = v4PoolKey(ADDRESSES.USDG, STOCK, {fee: 3000, tickSpacing: 60});
  const buy = buildV4SwapTx({key, zeroForOne: key.currency0.toLowerCase() === ADDRESSES.USDG.toLowerCase(), tokenIn: ADDRESSES.USDG, tokenOut: STOCK, amountIn: 100n, amountOutMinimum: 1n});
  assert.equal(guard(buy, ctx), true);
  const sell = buildV4SwapTx({key, zeroForOne: key.currency0.toLowerCase() === STOCK.toLowerCase(), tokenIn: STOCK, tokenOut: ADDRESSES.USDG, amountIn: 100n, amountOutMinimum: 1n});
  assert.equal(guard(sell, ctx), true);
  // the struct is the Robinhood one
  const {args} = decodeFunctionData({abi: UNIVERSAL_ROUTER_ABI, data: buy.data});
  const [, params] = decodeAbiParameters([{type: 'bytes'}, {type: 'bytes[]'}], args[1][0]);
  assert.equal(decodeAbiParameters(RH_V4_SWAP_EXACT_IN_SINGLE, params[0])[0].minHopPriceX36, 0n);
  // a stock leg on a hooked pool: refused
  const hooked = buildV4SwapTx({key: {...key, hooks: '0x9999999999999999999999999999999999999999'}, zeroForOne: true, tokenIn: ADDRESSES.USDG, tokenOut: STOCK, amountIn: 100n, amountOutMinimum: 1n});
  assert.throws(() => guard(hooked, ctx), /not permitted \(add it to uniswap\.v4\.allowedHooks/);
  // ... unless the operator has allowed that hook
  assert.equal(guard(hooked, {...ctx, allowedHooks: ['0x9999999999999999999999999999999999999999']}), true);
  // stock -> stock, or out to a stranger: refused
  const stranger = '0x9999999999999999999999999999999999999999';
  const bad = buildV4SwapTx({key: v4PoolKey(STOCK, stranger, {fee: 3000, tickSpacing: 60}), zeroForOne: true, tokenIn: STOCK, tokenOut: stranger, amountIn: 1n, amountOutMinimum: 1n});
  assert.throws(() => guard(bad, ctx), /not a permitted leg/);
  // $ZZY as the input through this path: refused before anything else
  const sale = buildV4SwapTx({key: v4PoolKey(ZZY, ADDRESSES.USDG, {fee: 3000, tickSpacing: 60}), zeroForOne: true, tokenIn: ZZY, tokenOut: ADDRESSES.USDG, amountIn: 1n, amountOutMinimum: 1n});
  assert.throws(() => guard(sale, ctx), SignerGuardError);
  // no minimum: refused
  const open = buildV4SwapTx({key, zeroForOne: true, tokenIn: ADDRESSES.USDG, tokenOut: STOCK, amountIn: 100n, amountOutMinimum: 0n});
  assert.throws(() => guard(open, ctx), /amountOutMinimum of 0/);
  // Permit2 route: stock and USDG may be approved to Permit2, Permit2 may approve the router, $ZZY never
  const approve = (token, spender) => ({to: token, data: encodeFunctionData({abi: ERC20_ABI, functionName: 'approve', args: [spender, 1n]}), value: 0n});
  assert.equal(guard(approve(STOCK, UNISWAP_V4.PERMIT2), ctx), true);
  assert.equal(guard(approve(ADDRESSES.USDG, UNISWAP_V4.PERMIT2), ctx), true);
  const p2 = (token, spender) => ({to: UNISWAP_V4.PERMIT2, data: encodeFunctionData({abi: PERMIT2_ABI, functionName: 'approve', args: [token, spender, 1n, 1]}), value: 0n});
  assert.equal(guard(p2(STOCK, UNISWAP_V4.UNIVERSAL_ROUTER), ctx), true);
  assert.throws(() => guard(p2(STOCK, stranger), ctx), /spender other than the Universal Router/);
  assert.throws(() => guard(p2(ZZY, UNISWAP_V4.UNIVERSAL_ROUTER), ctx), /\$ZZY/);
});

test('v4 pools are discovered from the chain, every one is quoted, and a hooked best pool is reported but not chosen', async () => {
  const {discoverV4Pools, _resetV4PoolCache} = await import('../src/adapters/uniswap-v4.mjs');
  const {encodeAbiParameters, keccak256} = await import('viem');
  _resetV4PoolCache();
  const HOOK = '0x9999999999999999999999999999999999999999';
  const [c0, c1] = ADDRESSES.USDG.toLowerCase() < STOCK.toLowerCase() ? [ADDRESSES.USDG, STOCK] : [STOCK, ADDRESSES.USDG];
  const mkLog = (fee, spacing, hooks, id) => ({
    topics: ['0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438', id, '0x' + c0.slice(2).toLowerCase().padStart(64, '0'), '0x' + c1.slice(2).toLowerCase().padStart(64, '0')],
    data: encodeAbiParameters([{type: 'uint24'}, {type: 'int24'}, {type: 'address'}, {type: 'uint160'}, {type: 'int24'}], [fee, spacing, hooks, 1n, 0]),
  });
  const id1 = keccak256('0x01'), id2 = keccak256('0x02');
  const explorerCalls = [];
  const fetchImpl = async (url) => { explorerCalls.push(url); return {ok: true, json: async () => ({status: '1', result: [mkLog(2500, 50, zeroAddress, id1), mkLog(500, 10, HOOK, id2)]})}; };
  const client = {async simulateContract({args}) { const k = args[0].poolKey; return {result: [k.hooks === zeroAddress ? 100n : 500n, 0n]}; }};
  const pools = await discoverV4Pools(client, ADDRESSES.USDG, STOCK, {fetchImpl});
  assert.equal(pools.length, 2); assert.equal(pools[0].fee, 2500); assert.equal(pools[0].tickSpacing, 50);
  assert.ok(explorerCalls[0].includes('topic0=0xdd466e67') && explorerCalls[0].includes('module=logs'));
  const lines = [];
  const q = await bestV4Quote(client, {tokenIn: ADDRESSES.USDG, tokenOut: STOCK, amountIn: 1n, fetchImpl, log: m => lines.push(m)});
  assert.equal(q.fee, 2500, 'the non-standard hookless pool was found and used');
  assert.equal(q.amountOut, 100n);
  assert.ok(lines.some(l => /uses hook 0x9999/.test(l)), 'the better hooked pool is reported');
  const q2 = await bestV4Quote(client, {tokenIn: ADDRESSES.USDG, tokenOut: STOCK, amountIn: 1n, fetchImpl, allowedHooks: [HOOK]});
  assert.equal(q2.amountOut, 500n, 'allowed hook: the hooked pool wins');
  assert.equal(explorerCalls.length, 1, 'discovery is cached');
});

test('the RPC scan halves its window on a range rejection and gives up after a bounded number of calls', async () => {
  const {discoverV4Pools, _resetV4PoolCache} = await import('../src/adapters/uniswap-v4.mjs');
  _resetV4PoolCache();
  const noExplorer = async () => ({ok: false, status: 403, json: async () => ({})});
  let calls = 0; const sizes = [];
  const client = {async getBlockNumber() { return 10_000_000n; }, async getLogs({fromBlock, toBlock}) { calls++; const size = toBlock - fromBlock + 1n; sizes.push(size); if (size > 1_000_000n) throw new Error('range too large'); return []; }};
  const pools = await discoverV4Pools(client, ADDRESSES.USDG, STOCK, {fetchImpl: noExplorer});
  assert.deepEqual(pools, []);
  assert.ok(sizes[0] === 4_000_000n && sizes.some(s => s === 1_000_000n), 'halved down to a size the node accepts');
  assert.ok(calls <= 80);
});
