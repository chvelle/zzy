// Pons V2: the adapter, the guard rules for its surfaces, and the treasury tick.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {decodeFunctionData, decodeAbiParameters, encodeFunctionData, parseEther, zeroAddress} from 'viem';
import {
  PONS_V2, UNISWAP_V4, PHASE, V2_ESCROW_ABI, V2_CURVE_ABI, UNIVERSAL_ROUTER_ABI, V2_FACTORY_ABI,
  poolKey, poolId, quoteCurveBuy, buildClaimTx, buildCurveBuyTx, buildV4BuyTx, buildPermit2ApproveTx, applySlippage, readLaunch,
} from '../src/adapters/pons-v2.mjs';
import {guard, SignerGuardError} from '../src/adapters/signer.mjs';
import {ADDRESSES, ERC20_ABI} from '../src/chain.mjs';
import {treasuryTick, _resetPonsVersionCache} from '../src/loop.mjs';
import {readLedger} from '../src/treasury.mjs';
import {_resetCashDecimals} from '../src/cash.mjs';

const ZZY = '0x1111111111111111111111111111111111111111';
const CURVE = '0x2222222222222222222222222222222222222222';
const ME = '0x3333333333333333333333333333333333333333';
const STRANGER = '0x9999999999999999999999999999999999999999';
const STOCK = '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC';

const nativeLaunch = {token: ZZY, curve: CURVE, deployer: ME, creatorFeeRecipient: ME, pairToken: zeroAddress, native: true, poolFee: 0, tickSpacing: 60, creatorTaxBps: 0, buybackEnabled: false, phase: 0, phaseName: 'on the curve'};
const usdgLaunch = {...nativeLaunch, pairToken: ADDRESSES.USDG, native: false};

test('pool key sorts currencies and the pool id matches the documented derivation', () => {
  const k = poolKey(nativeLaunch);
  assert.equal(k.currency0, zeroAddress, 'native ETH is always currency0');
  assert.equal(k.currency1, ZZY);
  assert.equal(k.fee, 0); assert.equal(k.hooks, PONS_V2.MEME_HOOK);
  const id = poolId(nativeLaunch);
  assert.match(id, /^0x[0-9a-f]{64}$/);
  const k2 = poolKey(usdgLaunch);
  assert.ok(k2.currency0.toLowerCase() < k2.currency1.toLowerCase());
});

test('the curve quote follows the contract arithmetic: fees off the input, snipe tax capped, clamp at the reserved edge', async () => {
  const state = {reserves: [1_000n * 10n ** 18n, 800_000_000n * 10n ** 18n], sellable: 700_000_000n * 10n ** 18n, feeBps: 100n, tax: 0n, snipe: 0n};
  const client = {async readContract({functionName}) {
    return {getReserves: state.reserves, sellableTokens: state.sellable, feeBps: state.feeBps, creatorTaxBps: state.tax, currentSnipeTaxBps: state.snipe}[functionName];
  }};
  const q = await quoteCurveBuy(client, CURVE, 10n * 10n ** 18n, ME);
  // net in = 10 * 0.99 = 9.9; out = 9.9 * 800M / (1000 + 9.9)
  const expected = (99n * 10n ** 17n * state.reserves[1]) / (state.reserves[0] + 99n * 10n ** 17n);
  assert.equal(q.tokensOut, expected);
  assert.equal(q.refund, 0n);
  // snipe tax at 99% is capped so the buyer nets at least 1%
  state.snipe = 9900n;
  const q2 = await quoteCurveBuy(client, CURVE, 10n * 10n ** 18n, ME);
  assert.equal(q2.snipeBps, 10000n - 100n - 0n - 100n);
  assert.ok(q2.tokensOut < q.tokensOut / 50n);
  // a buy past the edge is clamped and the rest refunded
  state.snipe = 0n; state.sellable = 1000n * 10n ** 18n;
  const q3 = await quoteCurveBuy(client, CURVE, 10n * 10n ** 18n, ME);
  assert.equal(q3.tokensOut, state.sellable);
  assert.ok(q3.refund > 0n && q3.spent < 10n * 10n ** 18n);
});

test('claim, curve buy and v4 buy transactions are built exactly as documented', () => {
  const c1 = buildClaimTx(zeroAddress);
  assert.equal(c1.to, PONS_V2.FEE_ESCROW);
  assert.equal(decodeFunctionData({abi: V2_ESCROW_ABI, data: c1.data}).functionName, 'claim');
  const c2 = buildClaimTx(ADDRESSES.USDG);
  const d2 = decodeFunctionData({abi: V2_ESCROW_ABI, data: c2.data});
  assert.equal(d2.functionName, 'claimToken'); assert.equal(d2.args[0].toLowerCase(), ADDRESSES.USDG.toLowerCase());

  const b = buildCurveBuyTx({curve: CURVE, quoteIn: 5n, minTokensOut: 4n, recipient: ME, native: true});
  assert.equal(b.to, CURVE); assert.equal(b.value, 5n);
  const db = decodeFunctionData({abi: V2_CURVE_ABI, data: b.data});
  assert.equal(db.functionName, 'buy'); assert.deepEqual(db.args, [5n, 4n, ME]);
  assert.equal(buildCurveBuyTx({curve: CURVE, quoteIn: 5n, minTokensOut: 4n, recipient: ME, native: false}).value, 0n);

  const v4 = buildV4BuyTx({launch: {...nativeLaunch, phase: 2}, amountIn: 7n, amountOutMinimum: 6n});
  assert.equal(v4.to, UNISWAP_V4.UNIVERSAL_ROUTER); assert.equal(v4.value, 7n);
  const dv = decodeFunctionData({abi: UNIVERSAL_ROUTER_ABI, data: v4.data});
  assert.equal(dv.functionName, 'execute'); assert.equal(dv.args[0], '0x10', 'one V4_SWAP command');
  const [actions, params] = decodeAbiParameters([{type: 'bytes'}, {type: 'bytes[]'}], dv.args[1][0]);
  assert.equal(actions, '0x060c0f'); assert.equal(params.length, 3);
  const [take] = decodeAbiParameters([{type: 'address'}, {type: 'uint256'}], params[2]);
  assert.equal(take, ZZY, 'TAKE_ALL is the launch token');
  const p2 = buildPermit2ApproveTx(ADDRESSES.USDG, 9n, {expiration: 123});
  assert.equal(p2.to, UNISWAP_V4.PERMIT2);
  assert.equal(applySlippage(1000n, 300), 970n);
});

test('the launch record is read from the factory and a token the factory does not know is null', async () => {
  const rec = {token: ZZY, curve: CURVE, deployer: ME, creatorFeeRecipient: ME, pairToken: zeroAddress, graduationThreshold: 1n, poolFee: 0, tickSpacing: 60, creatorTaxBps: 0, buybackEnabled: false, phase: 2, sweptQuote: 0n, sweptTokens: 0n, sweptAt: 0n, exists: true};
  const client = {async readContract({functionName, args}) { return args[0] === ZZY ? rec : {...rec, exists: false}; }};
  const l = await readLaunch(client, ZZY);
  assert.equal(l.native, true); assert.equal(l.phase, 2); assert.equal(l.phaseName, 'trading on Uniswap v4');
  assert.equal(await readLaunch(client, STRANGER), null);
});

// ── the guard ──────────────────────────────────────────────────────────

const ctxV1 = {zzyTokenAddress: ZZY, allowedStockTokens: [STOCK], maxValueWei: parseEther('1'), routerVariant: 'SwapRouter02', recipient: ME};
const ctxNative = {...ctxV1, ponsV2: {curve: CURVE, pairToken: zeroAddress, escrow: PONS_V2.FEE_ESCROW, phase: 0}};
const ctxUsdg = {...ctxV1, ponsV2: {curve: CURVE, pairToken: ADDRESSES.USDG, escrow: PONS_V2.FEE_ESCROW, phase: 0}};

test('SECURITY: without a resolved V2 launch, every V2 destination is refused', () => {
  assert.throws(() => guard(buildClaimTx(zeroAddress), ctxV1), SignerGuardError);
  assert.throws(() => guard(buildCurveBuyTx({curve: CURVE, quoteIn: 1n, minTokensOut: 1n, recipient: ME, native: true}), ctxV1), SignerGuardError);
  assert.throws(() => guard(buildCurveBuyTx({curve: CURVE, quoteIn: 1n, minTokensOut: 1n, recipient: ME, native: false}), ctxV1), /not on the allowlist/);
  assert.throws(() => guard(buildV4BuyTx({launch: nativeLaunch, amountIn: 1n, amountOutMinimum: 1n}), ctxV1), SignerGuardError);
  // Permit2 and the Universal Router serve the stock legs too, so they are reachable without V2; the buyback leg itself is not
  assert.equal(guard(buildPermit2ApproveTx(ADDRESSES.USDG, 1n), ctxV1), true);
});

test('escrow: claim and claimToken(pair) are signed; claimToken($ZZY) and anything else are not', () => {
  assert.equal(guard(buildClaimTx(zeroAddress), ctxNative), true);
  assert.equal(guard(buildClaimTx(ADDRESSES.USDG), ctxUsdg), true);
  assert.throws(() => guard(buildClaimTx(ZZY), ctxNative), /claimToken\(\$ZZY\)/);
});

test('curve: buy to the operator with a minimum is signed; sell, other recipients, zero minimum and value mismatches are refused', () => {
  assert.equal(guard(buildCurveBuyTx({curve: CURVE, quoteIn: 5n, minTokensOut: 4n, recipient: ME, native: true}), ctxNative), true);
  assert.equal(guard(buildCurveBuyTx({curve: CURVE, quoteIn: 5n, minTokensOut: 4n, recipient: ME, native: false}), ctxUsdg), true);
  const sell = {to: CURVE, data: encodeFunctionData({abi: V2_CURVE_ABI, functionName: 'sell', args: [1n, 1n, ME]}), value: 0n};
  assert.throws(() => guard(sell, ctxNative), /sale of \$ZZY/);
  assert.throws(() => guard(buildCurveBuyTx({curve: CURVE, quoteIn: 5n, minTokensOut: 4n, recipient: STRANGER, native: true}), ctxNative), /recipient is not the operator/);
  assert.throws(() => guard(buildCurveBuyTx({curve: CURVE, quoteIn: 5n, minTokensOut: 0n, recipient: ME, native: true}), ctxNative), /minTokensOut of 0/);
  // native launch paid with value 0, or an ERC-20 launch paid with value: both refused
  assert.throws(() => guard(buildCurveBuyTx({curve: CURVE, quoteIn: 5n, minTokensOut: 4n, recipient: ME, native: false}), ctxNative), /value does not match/);
  assert.throws(() => guard(buildCurveBuyTx({curve: CURVE, quoteIn: 5n, minTokensOut: 4n, recipient: ME, native: true}), ctxUsdg), /value does not match/);
});

test('universal router: exactly one v4 buy of $ZZY on the Pons hook, and nothing else', () => {
  const ok = buildV4BuyTx({launch: {...nativeLaunch, phase: 2}, amountIn: 7n, amountOutMinimum: 6n});
  assert.equal(guard(ok, ctxNative), true);
  const okUsdg = buildV4BuyTx({launch: {...usdgLaunch, phase: 2}, amountIn: 7n, amountOutMinimum: 6n});
  assert.equal(guard(okUsdg, ctxUsdg), true);
  // the same swap flipped (selling $ZZY): refused
  const sale = buildV4BuyTx({launch: {...nativeLaunch, phase: 2, token: zeroAddress, pairToken: ZZY, native: false}, amountIn: 7n, amountOutMinimum: 6n});
  assert.throws(() => guard({...sale, value: 0n}, ctxNative), /sale|not \$ZZY/);
  // no minimum: refused
  assert.throws(() => guard(buildV4BuyTx({launch: {...nativeLaunch, phase: 2}, amountIn: 7n, amountOutMinimum: 0n}), ctxNative), /amountOutMinimum of 0/);
  // wrong hook: refused
  assert.throws(() => guard(buildV4BuyTx({launch: {...nativeLaunch, phase: 2}, amountIn: 7n, amountOutMinimum: 6n, hook: STRANGER}), ctxNative), /Pons hook/);
  // value must match a native input
  assert.throws(() => guard({...ok, value: 0n}, ctxNative), /value does not match/);
  // a second command smuggled in: refused
  const two = {to: UNISWAP_V4.UNIVERSAL_ROUTER, data: encodeFunctionData({abi: UNIVERSAL_ROUTER_ABI, functionName: 'execute', args: ['0x1010', ['0x', '0x'], 0n]}), value: 0n};
  assert.throws(() => guard(two, ctxNative), /single V4_SWAP/);
});

test('permit2: approve of the pair asset to the Universal Router only', () => {
  assert.equal(guard(buildPermit2ApproveTx(ADDRESSES.USDG, 1n), ctxUsdg), true);
  assert.throws(() => guard(buildPermit2ApproveTx(ZZY, 1n), ctxUsdg), /\$ZZY/);
  assert.throws(() => guard(buildPermit2ApproveTx(ADDRESSES.USDG, 1n, {router: STRANGER}), ctxUsdg), /spender other than the Universal Router/);
});

test('ERC-20 approvals may now name the curve and Permit2, but $ZZY still cannot be approved to anyone', () => {
  const approve = (token, spender) => ({to: token, data: encodeFunctionData({abi: ERC20_ABI, functionName: 'approve', args: [spender, 1n]}), value: 0n});
  assert.equal(guard(approve(ADDRESSES.USDG, CURVE), ctxUsdg), true);
  assert.equal(guard(approve(ADDRESSES.USDG, UNISWAP_V4.PERMIT2), ctxUsdg), true);
  assert.equal(guard(approve(STOCK, CURVE), ctxUsdg), true);
  assert.throws(() => guard(approve(ADDRESSES.USDG, STRANGER), ctxUsdg), /only approve->router\/curve\/Permit2/);
  assert.throws(() => guard(approve(ZZY, CURVE), ctxUsdg), /\$ZZY token contract itself/);
  // without V2 resolved, the curve is not a valid spender; Permit2 is (the stock legs use it)
  assert.equal(guard(approve(ADDRESSES.USDG, UNISWAP_V4.PERMIT2), ctxV1), true);
});

// ── the tick ───────────────────────────────────────────────────────────

function v2Client({owed, phase = 0, pair = zeroAddress, usdgRaw = 0n, ethWei = 0n}) {
  const rec = {token: ZZY, curve: CURVE, deployer: ME, creatorFeeRecipient: ME, pairToken: pair, graduationThreshold: 1n, poolFee: 0, tickSpacing: 60, creatorTaxBps: 0, buybackEnabled: false, phase, sweptQuote: 0n, sweptTokens: 0n, sweptAt: 0n, exists: true};
  const st = {owed, usdgRaw, ethWei, sent: []};
  const client = {
    st,
    async readContract({address, functionName, args}) {
      const a = address.toLowerCase();
      if (functionName === 'getLaunchedToken') return rec;
      if (a === PONS_V2.FEE_ESCROW.toLowerCase()) return st.owed;
      if (a === CURVE.toLowerCase()) return {getReserves: [1_000n * 10n ** 18n, 800_000_000n * 10n ** 18n], sellableTokens: 700_000_000n * 10n ** 18n, feeBps: 100n, creatorTaxBps: 0n, currentSnipeTaxBps: 0n, quoteFeeBalance: 0n, creatorTaxBalance: 0n}[functionName];
      if (a === ADDRESSES.USDG.toLowerCase()) return functionName === 'decimals' ? 6 : functionName === 'balanceOf' ? st.usdgRaw : 0n;
      if (a === ADDRESSES.WETH.toLowerCase()) return functionName === 'balanceOf' ? 0n : 18;
      if (functionName === 'decimals') return 18;
      if (functionName === 'allowance') return 0n;
      return 0n;
    },
    async simulateContract({functionName, args}) {
      if (functionName === 'quoteExactInputSingle') return {result: [args[0].amountIn ? args[0].amountIn * 2_500n : (args[0].exactAmount ?? 0n) * 1_000_000n, 0n, 0, 0n]};
      throw new Error('unhandled simulate ' + functionName);
    },
    async waitForTransactionReceipt() { return {status: 'success'}; },
    async getBalance() { return st.ethWei; },
  };
  return client;
}

async function cfg(dir, extra = {}) {
  return {mode: 'live', treasury: {zzyTokenAddress: ZZY, buybackShareBps: 5000, tradingShareBps: 5000, ledgerPath: path.join(dir, 'ledger.json')},
    policy: {maxTotalExposureUsd: 10000}, uniswap: {routerVariant: 'SwapRouter02'}, execution: {slippageBps: 300, cashSlippageBps: 50, maxTxValueWei: String(parseEther('1'))},
    pons: {version: 'auto', claimThresholdUsd: 20}, ...extra};
}

test('V2 native launch on the curve: claim ETH, buy $ZZY on the curve, wrap and convert the rest to USDG, record what arrived', async () => {
  _resetPonsVersionCache(); _resetCashDecimals();
  const dir = await mkdtemp(path.join(tmpdir(), 'zzy-v2-'));
  try {
    const client = v2Client({owed: parseEther('0.1')});
    const sent = [];
    const signer = {live: true, address: ME, async send(tx) { sent.push(tx); if (tx.to.toLowerCase() === ADDRESSES.UNISWAP_SWAP_ROUTER.toLowerCase()) client.st.usdgRaw += 123_000_000n; return '0xh' + sent.length; }};
    const config = await cfg(dir);
    const lines = [];
    const r = await treasuryTick({client, signer, config, ethUsd: 2500, log: (m) => lines.push(m)});
    assert.equal(r.acted, true);
    const tos = sent.map(t => t.to.toLowerCase());
    assert.deepEqual(tos, [PONS_V2.FEE_ESCROW, CURVE, ADDRESSES.WETH, ADDRESSES.WETH, ADDRESSES.UNISWAP_SWAP_ROUTER].map(a => a.toLowerCase()),
      'claim, curve buy, wrap, WETH approve, WETH->USDG');
    assert.equal(sent[1].value, parseEther('0.05'), 'half the claim buys $ZZY, paid as native value');
    assert.equal(sent[2].value, parseEther('0.05'), 'the other half is wrapped');
    const ledger = await readLedger(config);
    const e = ledger.entries.find(x => x.type === 'fee-claim');
    assert.equal(e.pons, 'v2'); assert.equal(e.venue, 'curve');
    assert.equal(e.claimUsd, 250); assert.equal(e.buybackUsd, 125); assert.equal(e.tradingUsd, 123, 'USDG that actually arrived');
    assert.equal(e.zzyDisposition, 'held-permanently');
    assert.ok(!ledger.pendingBuyback);
  } finally { await rm(dir, {recursive: true}); }
});

test('V2 USDG launch after graduation: claimToken, Permit2 path, v4 buy through the Universal Router, no conversion needed', async () => {
  _resetPonsVersionCache(); _resetCashDecimals();
  const dir = await mkdtemp(path.join(tmpdir(), 'zzy-v2-'));
  try {
    const client = v2Client({owed: 400_000_000n, phase: 2, pair: ADDRESSES.USDG, usdgRaw: 0n});
    const sent = [];
    const signer = {live: true, address: ME, async send(tx) { sent.push(tx); return '0xh' + sent.length; }};
    const config = await cfg(dir);
    const r = await treasuryTick({client, signer, config, ethUsd: 2500, log: () => {}});
    assert.equal(r.acted, true);
    const tos = sent.map(t => t.to.toLowerCase());
    assert.deepEqual(tos, [PONS_V2.FEE_ESCROW, ADDRESSES.USDG, UNISWAP_V4.PERMIT2, UNISWAP_V4.UNIVERSAL_ROUTER].map(a => a.toLowerCase()),
      'claimToken, approve USDG to Permit2, Permit2 approve to router, v4 swap');
    assert.equal(sent[3].value, 0n, 'an ERC-20 input sends no value');
    const e = (await readLedger(config)).entries.find(x => x.type === 'fee-claim');
    assert.equal(e.venue, 'v4'); assert.equal(e.claimUsd, 400); assert.equal(e.buybackUsd, 200); assert.equal(e.tradingUsd, 200, 'USDG needs no conversion');
  } finally { await rm(dir, {recursive: true}); }
});

test('V2: a launch mid-graduation parks the buyback, still funds the book, and retries the buyback next tick', async () => {
  _resetPonsVersionCache(); _resetCashDecimals();
  const dir = await mkdtemp(path.join(tmpdir(), 'zzy-v2-'));
  try {
    const client = v2Client({owed: parseEther('0.1'), phase: 1});
    const sent = [];
    const signer = {live: true, address: ME, async send(tx) { sent.push(tx); if (tx.to.toLowerCase() === ADDRESSES.UNISWAP_SWAP_ROUTER.toLowerCase()) client.st.usdgRaw += 120_000_000n; return '0xh' + sent.length; }};
    const config = await cfg(dir);
    const lines = [];
    let r = await treasuryTick({client, signer, config, ethUsd: 2500, log: (m) => lines.push(m)});
    assert.equal(r.acted, true);
    assert.ok(!sent.some(t => t.to.toLowerCase() === CURVE.toLowerCase()), 'no curve buy while swept');
    let ledger = await readLedger(config);
    assert.equal(ledger.pendingBuyback.amount, parseEther('0.05').toString());
    assert.equal(ledger.entries[0].buybackUsd, 0); assert.equal(ledger.entries[0].tradingUsd, 120);
    assert.ok(lines.some(l => /buyback deferred/.test(l)));
    // next tick: graduated, nothing new owed, the parked half is bought on v4
    _resetPonsVersionCache();
    const client2 = v2Client({owed: 0n, phase: 2});
    sent.length = 0;
    r = await treasuryTick({client: client2, signer, config, ethUsd: 2500, log: (m) => lines.push(m)});
    assert.equal(sent.length, 1); assert.equal(sent[0].to.toLowerCase(), UNISWAP_V4.UNIVERSAL_ROUTER.toLowerCase());
    assert.equal(sent[0].value, parseEther('0.05'));
    ledger = await readLedger(config);
    assert.ok(!ledger.pendingBuyback, 'cleared');
    assert.ok(ledger.entries.some(e => e.type === 'buyback-settled' && e.venue === 'v4'));
  } finally { await rm(dir, {recursive: true}); }
});

test('V2: fees paid to another wallet are reported, not claimed; below threshold nothing is signed; preview signs nothing', async () => {
  _resetPonsVersionCache();
  const dir = await mkdtemp(path.join(tmpdir(), 'zzy-v2-'));
  try {
    const client = v2Client({owed: parseEther('0.1')});
    const other = {live: true, address: STRANGER, async send() { throw new Error('must not sign'); }};
    let r = await treasuryTick({client, signer: other, config: await cfg(dir), ethUsd: 2500, log: () => {}});
    assert.equal(r.acted, false); assert.match(r.reason, /not the creator fee recipient/);
    const small = v2Client({owed: parseEther('0.001')});
    r = await treasuryTick({client: small, signer: {live: true, address: ME, async send() { throw new Error('must not sign'); }}, config: await cfg(dir), ethUsd: 2500, log: () => {}});
    assert.equal(r.acted, false); assert.match(r.reason, /below \$20/);
    const preview = {live: false, address: ME, async send() { throw new Error('must not sign'); }};
    const lines = [];
    r = await treasuryTick({client, signer: preview, config: await cfg(dir, {mode: 'preview'}), ethUsd: 2500, log: (m) => lines.push(m)});
    assert.equal(r.preview, true); assert.ok(lines.some(l => /\[preview\] would claim/.test(l)));
  } finally { await rm(dir, {recursive: true}); }
});

test('a V1 token is still routed to the V1 tick', async () => {
  _resetPonsVersionCache();
  const dir = await mkdtemp(path.join(tmpdir(), 'zzy-v2-'));
  try {
    const client = {async readContract({functionName}) { if (functionName === 'getLaunchedToken') throw new Error('revert'); if (functionName === 'balanceOf') return 0n; throw new Error('v1 fake'); }};
    const r = await treasuryTick({client, signer: {live: false, address: ME}, config: await cfg(dir, {mode: 'preview', pons: {claimThresholdEth: 0.42}}), ethUsd: 2500, log: () => {}});
    assert.equal(r.acted, false); assert.match(r.reason, /unallocated WETH/, 'the V1 path answered');
  } finally { await rm(dir, {recursive: true}); }
});




test('the v4 swap struct carries minHopPriceX36 (Robinhood router fork), set to 0, before hookData', async () => {
  const {decodeFunctionData, decodeAbiParameters} = await import('viem');
  const {buildV4BuyTx, UNIVERSAL_ROUTER_ABI, RH_V4_SWAP_EXACT_IN_SINGLE} = await import('../src/adapters/pons-v2.mjs');
  const launch = {token: '0x58c91C04e84e1666b9847BcD1E2Bd883f343e2eF', pairToken: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', native: false, poolFee: 10000, tickSpacing: 200, phase: 2};
  const tx = buildV4BuyTx({launch, amountIn: 145_895_638n, amountOutMinimum: 1n});
  const {args} = decodeFunctionData({abi: UNIVERSAL_ROUTER_ABI, data: tx.data});
  const [actions, params] = decodeAbiParameters([{type: 'bytes'}, {type: 'bytes[]'}], args[1][0]);
  assert.equal(actions, '0x060c0f');
  const [swap] = decodeAbiParameters(RH_V4_SWAP_EXACT_IN_SINGLE, params[0]);
  assert.equal(swap.minHopPriceX36, 0n);
  assert.equal(swap.amountIn, 145_895_638n);
  assert.equal(swap.hookData, '0x');
  // the stock Uniswap struct must NOT decode cleanly to the same fields: proves the extra word is really there
  const stock = [{type: 'tuple', components: [...RH_V4_SWAP_EXACT_IN_SINGLE[0].components.filter(c => c.name !== 'minHopPriceX36')]}];
  let mismatch = false;
  try { const [s] = decodeAbiParameters(stock, params[0]); mismatch = s.hookData !== '0x'; } catch { mismatch = true; }
  assert.ok(mismatch, 'the struct is not the stock one');
});
