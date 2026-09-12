// Pons V2 on Robinhood Chain.
//
// Everything here is from docs.ponsfamily.com/v2 (contract addresses, ABIs,
// the curve's own quote arithmetic) and developers.uniswap.org (the v4 stack
// for chain 4663). Nothing is guessed. Where the docs say a value must be
// resolved per launch, it is read from the factory rather than assumed.
//
// How V2 differs from V1, and why this module exists:
//   - a launch trades on a bonding curve, then graduates into a Uniswap v4
//     pool with a Pons hook; there is no v3 pool and no locker NFT
//   - creator fees are paid in the launch's quote asset: native ETH for an
//     ETH launch, USDG or a stock token for a custom pair
//   - fees accrue on the curve (pre-graduation) or the hook (post), and only
//     reach the fee escrow after a sweep; the creator withdraws from escrow
//   - the escrow is claimed with claim() for ETH and claimToken(asset) for
//     an ERC-20, one balance per asset

import {encodeFunctionData, encodeAbiParameters, keccak256, parseAbi, zeroAddress, formatUnits} from 'viem';
import {ERC20_ABI} from '../chain.mjs';

export const PONS_V2 = {
  FACTORY: '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e',
  MEME_HOOK: '0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044',
  FEE_ESCROW: '0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e',
  BUYBACK_VAULT: '0x42df2a798f82289E177311362e8f5ccC45c1219c',
  LAUNCH_LOCKER: '0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952',
};

// Uniswap v4 on Robinhood Chain, from developers.uniswap.org/docs/protocols/v4/deployments
export const UNISWAP_V4 = {
  POOL_MANAGER: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
  QUOTER: '0x8dc178efb8111bb0973dd9d722ebeff267c98f94',
  UNIVERSAL_ROUTER: '0x8876789976decbfcbbbe364623c63652db8c0904',
  PERMIT2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
};

export const PHASE = {NotGraduated: 0, Swept: 1, PoolCreated: 2, Rescued: 3};
export const PHASE_NAME = ['on the curve', 'swept, pool pending', 'trading on Uniswap v4', 'rescued'];

export const V2_FACTORY_ABI = parseAbi([
  'struct LaunchedToken { address token; address curve; address deployer; address creatorFeeRecipient; address pairToken; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; uint16 creatorTaxBps; bool buybackEnabled; uint8 phase; uint256 sweptQuote; uint256 sweptTokens; uint256 sweptAt; bool exists; }',
  'function getLaunchedToken(address token) view returns (LaunchedToken)',
  'struct FeePolicy { address protocolFeeRecipient; uint16 protocolFeeShareBps; uint16 buybackBurnBps; uint16 hookFeeBps; uint16 maxInternalPriceImpactBps; }',
  'function getLaunchFeePolicy(address token) view returns (FeePolicy)',
]);

export const V2_ESCROW_ABI = parseAbi([
  'function balanceOf(address recipient) view returns (uint256)',
  'function balanceOfToken(address recipient, address token) view returns (uint256)',
  'function claim()',
  'function claimToken(address token)',
]);

export const V2_CURVE_ABI = parseAbi([
  'function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256 tokensOut)',
  'function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256 quoteOut)',
  'function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)',
  'function sellableTokens() view returns (uint256)',
  'function feeBps() view returns (uint256)',
  'function creatorTaxBps() view returns (uint256)',
  'function currentSnipeTaxBps(address recipient) view returns (uint256)',
  'function quoteFeeBalance() view returns (uint256)',
  'function creatorTaxBalance() view returns (uint256)',
  'function readyToGraduate() view returns (bool)',
  'function graduated() view returns (bool)',
  'function isNativeQuote() view returns (bool)',
  'function pairToken() view returns (address)',
  'function sweepFees(uint256 minBuybackTokensOut)',
]);

export const V2_HOOK_ABI = parseAbi([
  'function pendingFees(bytes32 poolId, address currency) view returns (uint256)',
  'function pendingCreatorTax(bytes32 poolId, address currency) view returns (uint256)',
]);

// Uniswap v4 periphery (standard)
export const V4_QUOTER_ABI = parseAbi([
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }',
  'function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)',
]);
export const UNIVERSAL_ROUTER_ABI = parseAbi([
  'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable',
]);
export const PERMIT2_ABI = parseAbi([
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
  'function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
]);

// Universal Router command and v4 action bytes (universal-router Commands.sol, v4-periphery Actions.sol)
export const UR_COMMAND_V4_SWAP = 0x10;
export const V4_ACTION = {SWAP_EXACT_IN_SINGLE: 0x06, SETTLE_ALL: 0x0c, TAKE_ALL: 0x0f};

const BPS = 10_000n;
const eq = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
export const isNativePair = (pair) => !pair || eq(pair, zeroAddress);

// ── reads ────────────────────────────────────────────────────────────────

export async function readLaunch(client, token, factory = PONS_V2.FACTORY) {
  const raw = await client.readContract({address: factory, abi: V2_FACTORY_ABI, functionName: 'getLaunchedToken', args: [token]});
  const l = raw.launched ?? raw;
  if (!l.exists) return null;
  return {
    token: l.token, curve: l.curve, deployer: l.deployer, creatorFeeRecipient: l.creatorFeeRecipient,
    pairToken: l.pairToken, native: isNativePair(l.pairToken),
    graduationThreshold: l.graduationThreshold, poolFee: Number(l.poolFee), tickSpacing: Number(l.tickSpacing),
    creatorTaxBps: Number(l.creatorTaxBps), buybackEnabled: l.buybackEnabled, phase: Number(l.phase), phaseName: PHASE_NAME[Number(l.phase)] ?? 'unknown',
  };
}

// Is this token a V2 launch? A V1 token makes the V2 factory return exists=false (or revert).
export async function isV2Launch(client, token, factory = PONS_V2.FACTORY) {
  try { return (await readLaunch(client, token, factory)) != null; } catch { return false; }
}

export async function escrowOwed(client, recipient, pairToken, escrow = PONS_V2.FEE_ESCROW) {
  if (isNativePair(pairToken)) return client.readContract({address: escrow, abi: V2_ESCROW_ABI, functionName: 'balanceOf', args: [recipient]});
  return client.readContract({address: escrow, abi: V2_ESCROW_ABI, functionName: 'balanceOfToken', args: [recipient, pairToken]});
}

// Fees earned but not yet swept into the escrow. Informational: the creator
// cannot always sweep them (a sweep that needs an internal swap is operator-
// only), so this is shown, never relied on.
export async function unsweptFees(client, launch, hook = PONS_V2.MEME_HOOK) {
  if (launch.phase === PHASE.NotGraduated) {
    const [fee, tax] = await Promise.all([
      client.readContract({address: launch.curve, abi: V2_CURVE_ABI, functionName: 'quoteFeeBalance'}),
      client.readContract({address: launch.curve, abi: V2_CURVE_ABI, functionName: 'creatorTaxBalance'}),
    ]);
    return {where: 'curve', quoteFee: fee, creatorTax: tax};
  }
  if (launch.phase === PHASE.PoolCreated) {
    const id = poolId(launch, hook);
    const quote = launch.native ? zeroAddress : launch.pairToken;
    const [fee, tax] = await Promise.all([
      client.readContract({address: hook, abi: V2_HOOK_ABI, functionName: 'pendingFees', args: [id, quote]}),
      client.readContract({address: hook, abi: V2_HOOK_ABI, functionName: 'pendingCreatorTax', args: [id, quote]}),
    ]);
    return {where: 'hook', quoteFee: fee, creatorTax: tax};
  }
  return {where: 'none', quoteFee: 0n, creatorTax: 0n};
}

// ── Uniswap v4 pool identity (docs: "Reconstructing the pool") ──────────

export function poolKey(launch, hook = PONS_V2.MEME_HOOK) {
  const pair = launch.native ? zeroAddress : launch.pairToken;
  const [currency0, currency1] = pair.toLowerCase() < launch.token.toLowerCase() ? [pair, launch.token] : [launch.token, pair];
  return {currency0, currency1, fee: launch.poolFee, tickSpacing: launch.tickSpacing, hooks: hook};
}

export function poolId(launch, hook = PONS_V2.MEME_HOOK) {
  const k = poolKey(launch, hook);
  return keccak256(encodeAbiParameters(
    [{type: 'address'}, {type: 'address'}, {type: 'uint24'}, {type: 'int24'}, {type: 'address'}],
    [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks],
  ));
}

// ── curve quote (docs: "Getting a quote", same integer order as the contract) ──

const amountOut = (inAmount, reserveIn, reserveOut) => (inAmount * reserveOut) / (reserveIn + inAmount);
const amountIn = (outAmount, reserveIn, reserveOut) => (outAmount * reserveIn) / (reserveOut - outAmount) + 1n;
const ceilDiv = (a, b) => (a + b - 1n) / b;

export async function quoteCurveBuy(client, curve, quoteIn, recipient) {
  const read = (functionName, args) => client.readContract({address: curve, abi: V2_CURVE_ABI, functionName, args});
  const [reserves, sellable, feeBps, creatorTaxBps, rawSnipe] = await Promise.all([
    read('getReserves'), read('sellableTokens'), read('feeBps'), read('creatorTaxBps'), read('currentSnipeTaxBps', [recipient]),
  ]);
  const [quoteReserve, tokenReserve] = reserves;
  let snipeBps = rawSnipe;
  if (snipeBps > 0n) { const max = BPS - feeBps - creatorTaxBps - 100n; if (snipeBps > max) snipeBps = max; }
  let spent = quoteIn;
  const fee = (spent * feeBps) / BPS, tax = (spent * creatorTaxBps) / BPS, snipe = (spent * snipeBps) / BPS;
  let tokensOut = amountOut(spent - fee - tax - snipe, quoteReserve, tokenReserve);
  if (tokensOut > sellable) {
    tokensOut = sellable;
    const net = amountIn(sellable, quoteReserve, tokenReserve);
    const grossed = ceilDiv(net * BPS, BPS - feeBps - creatorTaxBps - snipeBps);
    spent = grossed < quoteIn ? grossed : quoteIn;
  }
  return {tokensOut, spent, refund: quoteIn - spent, sellable, snipeBps};
}

// Quote a post-graduation buy on the v4 pool via the official V4Quoter.
export async function quoteV4Buy(client, launch, amountIn, {quoter = UNISWAP_V4.QUOTER, hook = PONS_V2.MEME_HOOK} = {}) {
  const key = poolKey(launch, hook);
  const pair = launch.native ? zeroAddress : launch.pairToken;
  const zeroForOne = eq(key.currency0, pair);   // we spend the pair asset, receive the launch token
  const {result} = await client.simulateContract({
    address: quoter, abi: V4_QUOTER_ABI, functionName: 'quoteExactInputSingle',
    args: [{poolKey: key, zeroForOne, exactAmount: amountIn, hookData: '0x'}],
  });
  return {amountOut: result[0], zeroForOne, key};
}

// ── transaction builders (never sent from here) ─────────────────────────

export function buildClaimTx(pairToken, escrow = PONS_V2.FEE_ESCROW) {
  const data = isNativePair(pairToken)
    ? encodeFunctionData({abi: V2_ESCROW_ABI, functionName: 'claim'})
    : encodeFunctionData({abi: V2_ESCROW_ABI, functionName: 'claimToken', args: [pairToken]});
  return {to: escrow, data, value: 0n};
}

export function buildApproveTx(token, spender, amount) {
  return {to: token, data: encodeFunctionData({abi: ERC20_ABI, functionName: 'approve', args: [spender, amount]}), value: 0n};
}

export function buildCurveBuyTx({curve, quoteIn, minTokensOut, recipient, native}) {
  return {
    to: curve,
    data: encodeFunctionData({abi: V2_CURVE_ABI, functionName: 'buy', args: [quoteIn, minTokensOut, recipient]}),
    value: native ? quoteIn : 0n,
  };
}

// Permit2 allowance for the Universal Router to pull an ERC-20 pair asset.
export function buildPermit2ApproveTx(token, amount, {permit2 = UNISWAP_V4.PERMIT2, router = UNISWAP_V4.UNIVERSAL_ROUTER, expiration = null} = {}) {
  const exp = expiration ?? Math.floor(Date.now() / 1000) + 30 * 60;
  return {to: permit2, data: encodeFunctionData({abi: PERMIT2_ABI, functionName: 'approve', args: [token, router, amount, exp]}), value: 0n};
}

// The Universal Router on Robinhood Chain is a modified fork: its
// SWAP_EXACT_IN_SINGLE struct carries an extra uint256 minHopPriceX36
// between amountOutMinimum and hookData (always 0, the feature is off).
// Stock Uniswap calldata reverts against it. Source: docs.bags.fm/robinhood
// (trade-tokens, "the router is a fork"). This is the one struct definition
// the builder encodes with and the signer decodes with, so they cannot drift.
export const RH_V4_SWAP_EXACT_IN_SINGLE = [{type: 'tuple', components: [
  {type: 'tuple', name: 'poolKey', components: [{type: 'address', name: 'currency0'}, {type: 'address', name: 'currency1'}, {type: 'uint24', name: 'fee'}, {type: 'int24', name: 'tickSpacing'}, {type: 'address', name: 'hooks'}]},
  {type: 'bool', name: 'zeroForOne'}, {type: 'uint128', name: 'amountIn'}, {type: 'uint128', name: 'amountOutMinimum'},
  {type: 'uint256', name: 'minHopPriceX36'},
  {type: 'bytes', name: 'hookData'},
]}];

// One exact-input single-pool v4 swap through the Universal Router:
// V4_SWAP -> [SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL]. The output is
// taken to msg.sender, which is the operator wallet.
export function buildV4BuyTx({launch, amountIn, amountOutMinimum, hook = PONS_V2.MEME_HOOK, router = UNISWAP_V4.UNIVERSAL_ROUTER, deadlineSeconds = 120}) {
  const key = poolKey(launch, hook);
  const pair = launch.native ? zeroAddress : launch.pairToken;
  const zeroForOne = eq(key.currency0, pair);
  const swapParams = encodeAbiParameters(RH_V4_SWAP_EXACT_IN_SINGLE,
    [{poolKey: key, zeroForOne, amountIn, amountOutMinimum, minHopPriceX36: 0n, hookData: '0x'}],
  );
  const settle = encodeAbiParameters([{type: 'address'}, {type: 'uint256'}], [pair, amountIn]);
  const take = encodeAbiParameters([{type: 'address'}, {type: 'uint256'}], [launch.token, amountOutMinimum]);
  const actions = `0x${[V4_ACTION.SWAP_EXACT_IN_SINGLE, V4_ACTION.SETTLE_ALL, V4_ACTION.TAKE_ALL].map(b => b.toString(16).padStart(2, '0')).join('')}`;
  const input = encodeAbiParameters([{type: 'bytes'}, {type: 'bytes[]'}], [actions, [swapParams, settle, take]]);
  const commands = `0x${UR_COMMAND_V4_SWAP.toString(16).padStart(2, '0')}`;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSeconds);
  return {
    to: router,
    data: encodeFunctionData({abi: UNIVERSAL_ROUTER_ABI, functionName: 'execute', args: [commands, [input], deadline]}),
    value: launch.native ? amountIn : 0n,
    zeroForOne, key,
  };
}

export function applySlippage(amount, bps) { return amount - (amount * BigInt(bps)) / BPS; }

export function fmt(amount, decimals = 18) { return Number(formatUnits(amount, decimals)); }
