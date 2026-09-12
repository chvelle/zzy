// Uniswap v4 on Robinhood Chain, for the stock legs.
//
// The deep pools for most Stock Tokens live on the v4 singleton, not on v3.
// A v3 quote for such a name comes from a leftover puddle and reads as a
// huge premium, which the premium guard refuses (correctly). This module
// quotes the same pair on v4 across the standard hookless pool configs and
// builds the swap through the Universal Router, in the Robinhood fork's
// struct (RH_V4_SWAP_EXACT_IN_SINGLE, the one with minHopPriceX36).
//
// The engine asks both venues and takes the better quote. Nothing here
// sends; the guarded signer decodes every call.

import {encodeAbiParameters, encodeFunctionData, zeroAddress} from 'viem';
import {ERC20_ABI} from '../chain.mjs';
import {
  UNISWAP_V4, V4_QUOTER_ABI, UNIVERSAL_ROUTER_ABI, PERMIT2_ABI, UR_COMMAND_V4_SWAP, V4_ACTION, RH_V4_SWAP_EXACT_IN_SINGLE,
} from './pons-v2.mjs';

// The standard hookless configurations. Pools keyed by (fee, tickSpacing).
export const V4_CONFIGS = [{fee: 100, tickSpacing: 1}, {fee: 500, tickSpacing: 10}, {fee: 3000, tickSpacing: 60}, {fee: 10000, tickSpacing: 200}];

const eq = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

export function v4PoolKey(tokenA, tokenB, {fee, tickSpacing}, hooks = zeroAddress) {
  const [currency0, currency1] = tokenA.toLowerCase() < tokenB.toLowerCase() ? [tokenA, tokenB] : [tokenB, tokenA];
  return {currency0, currency1, fee, tickSpacing, hooks};
}

// ── pool discovery ──────────────────────────────────────────────────────
//
// A v4 pool can use any fee, any tick spacing and any hook, so guessing the
// four standard configs misses most of what exists. The PoolManager emits
// Initialize(id, currency0, currency1, fee, tickSpacing, hooks, ...) once per
// pool, with both currencies indexed, so the full set for a pair is one log
// query. Blockscout's explorer API answers it in one call; the RPC is the
// fallback, scanned in chunks. Results are cached on disk per pair.

export const INITIALIZE_TOPIC = '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438';
const INITIALIZE_ABI_ITEM = {type: 'event', name: 'Initialize', inputs: [
  {type: 'bytes32', name: 'id', indexed: true}, {type: 'address', name: 'currency0', indexed: true}, {type: 'address', name: 'currency1', indexed: true},
  {type: 'uint24', name: 'fee'}, {type: 'int24', name: 'tickSpacing'}, {type: 'address', name: 'hooks'}, {type: 'uint160', name: 'sqrtPriceX96'}, {type: 'int24', name: 'tick'}]};

const pad32 = (addr) => '0x' + addr.toLowerCase().slice(2).padStart(64, '0');

function decodeInit(log) {
  const {decodeEventLog} = viemSync;
  const {args} = decodeEventLog({abi: [INITIALIZE_ABI_ITEM], data: log.data, topics: log.topics});
  return {id: args.id, currency0: args.currency0, currency1: args.currency1, fee: Number(args.fee), tickSpacing: Number(args.tickSpacing), hooks: args.hooks};
}
let viemSync = null;

async function poolsViaExplorer(currency0, currency1, {explorer, fetchImpl, poolManager}) {
  const url = `${explorer}/api?module=logs&action=getLogs&fromBlock=0&toBlock=latest&address=${poolManager}&topic0=${INITIALIZE_TOPIC}&topic0_2_opr=and&topic2=${pad32(currency0)}&topic2_3_opr=and&topic3=${pad32(currency1)}`;
  const r = await fetchImpl(url, {signal: AbortSignal.timeout(20000), headers: {'accept': 'application/json', 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36'}});
  if (!r.ok) throw new Error(`explorer ${r.status}`);
  const j = await r.json();
  if (j.status !== '1' && !Array.isArray(j.result)) throw new Error(`explorer: ${j.message ?? 'no result'}`);
  return (Array.isArray(j.result) ? j.result : []).map(decodeInit);
}

// The RPC's log range limit is not published, so the scan starts wide and
// halves on a rejection, down to a floor, with a cap on total calls so a
// hostile node cannot turn discovery into a wait.
async function poolsViaRpc(client, currency0, currency1, {poolManager, fromBlock = 0n, chunk = 4_000_000n, minChunk = 250_000n, maxCalls = 80}) {
  const latest = await client.getBlockNumber();
  const out = [];
  let calls = 0, from = fromBlock, size = chunk;
  while (from <= latest) {
    if (++calls > maxCalls) throw new Error(`gave up after ${maxCalls} log queries (chunk ${size})`);
    const to = from + size - 1n > latest ? latest : from + size - 1n;
    try {
      const logs = await client.getLogs({address: poolManager, event: INITIALIZE_ABI_ITEM, args: {currency0, currency1}, fromBlock: from, toBlock: to});
      for (const l of logs) out.push({id: l.args.id, currency0: l.args.currency0, currency1: l.args.currency1, fee: Number(l.args.fee), tickSpacing: Number(l.args.tickSpacing), hooks: l.args.hooks});
      from = to + 1n;
    } catch (e) {
      if (size <= minChunk) throw e;
      size = size / 2n;
    }
  }
  return out;
}

const poolCache = new Map();   // pairKey -> {at, pools}
export function _resetV4PoolCache() { poolCache.clear(); }

// Every v4 pool that exists for the pair, as {id, currency0, currency1, fee, tickSpacing, hooks}.
export async function discoverV4Pools(client, tokenA, tokenB, {explorer = 'https://robinhoodchain.blockscout.com', poolManager = UNISWAP_V4.POOL_MANAGER, fetchImpl = fetch, ttlMs = 6 * 3600_000, log = () => {}} = {}) {
  const [currency0, currency1] = tokenA.toLowerCase() < tokenB.toLowerCase() ? [tokenA, tokenB] : [tokenB, tokenA];
  const key = `${currency0.toLowerCase()}:${currency1.toLowerCase()}`;
  const hit = poolCache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.pools;
  if (!viemSync) viemSync = await import('viem');
  let pools = null;
  try { pools = await poolsViaExplorer(currency0, currency1, {explorer, fetchImpl, poolManager}); }
  catch (e) { log(`v4 discovery via explorer failed (${e.message.split('\n')[0]}); scanning the RPC`); }
  if (!pools) {
    try { pools = await poolsViaRpc(client, currency0, currency1, {poolManager}); }
    catch (e) { log(`v4 discovery via RPC failed: ${e.message.split('\n')[0]}`); pools = []; }
  }
  // dedupe by pool id
  const seen = new Set(); pools = pools.filter(p => { const k = String(p.id).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  poolCache.set(key, {at: Date.now(), pools});
  return pools;
}

// Best v4 quote for tokenIn -> tokenOut across every pool that exists for
// the pair (discovered), falling back to the standard hookless configs
// when discovery finds nothing. Pools on a hook not in allowedHooks are
// quoted and reported but never chosen: the signer would refuse them.
// Returns null when no pool quotes (as opposed to throwing): the caller
// compares venues and a missing one is simply not in the running.
export async function bestV4Quote(client, {tokenIn, tokenOut, amountIn, configs = V4_CONFIGS, quoter = UNISWAP_V4.QUOTER, allowedHooks = [], discover = true, log = () => {}, fetchImpl = fetch}) {
  let keys = [];
  if (discover) {
    const pools = await discoverV4Pools(client, tokenIn, tokenOut, {fetchImpl, log});
    keys = pools.map(p => ({currency0: p.currency0, currency1: p.currency1, fee: p.fee, tickSpacing: p.tickSpacing, hooks: p.hooks}));
  }
  if (!keys.length) keys = configs.map(c => v4PoolKey(tokenIn, tokenOut, c));
  const hookOk = (h) => eq(h, zeroAddress) || allowedHooks.some(a => eq(a, h));
  let best = null, bestBlocked = null;
  for (const key of keys) {
    const zeroForOne = eq(key.currency0, tokenIn);
    try {
      const {result} = await client.simulateContract({
        address: quoter, abi: V4_QUOTER_ABI, functionName: 'quoteExactInputSingle',
        args: [{poolKey: key, zeroForOne, exactAmount: amountIn, hookData: '0x'}],
      });
      const amountOut = result[0];
      if (!(amountOut > 0n)) continue;
      const q = {amountOut, key, zeroForOne, fee: key.fee, tickSpacing: key.tickSpacing, hooks: key.hooks, venue: 'v4'};
      if (hookOk(key.hooks)) { if (!best || amountOut > best.amountOut) best = q; }
      else if (!bestBlocked || amountOut > bestBlocked.amountOut) bestBlocked = q;
    } catch { /* this pool does not quote */ }
  }
  if (bestBlocked && (!best || bestBlocked.amountOut > best.amountOut)) {
    log(`v4: the best pool for this pair uses hook ${bestBlocked.hooks} (fee ${bestBlocked.fee}, spacing ${bestBlocked.tickSpacing}); it is not in uniswap.v4.allowedHooks, so it is not used`);
  }
  return best;
}

// One exact-in single-pool swap through the Universal Router. The output is
// taken by msg.sender, the operator wallet.
export function buildV4SwapTx({key, zeroForOne, tokenIn, tokenOut, amountIn, amountOutMinimum, router = UNISWAP_V4.UNIVERSAL_ROUTER, deadlineSeconds = 120}) {
  const swapParams = encodeAbiParameters(RH_V4_SWAP_EXACT_IN_SINGLE, [{poolKey: key, zeroForOne, amountIn, amountOutMinimum, minHopPriceX36: 0n, hookData: '0x'}]);
  const settle = encodeAbiParameters([{type: 'address'}, {type: 'uint256'}], [tokenIn, amountIn]);
  const take = encodeAbiParameters([{type: 'address'}, {type: 'uint256'}], [tokenOut, amountOutMinimum]);
  const actions = `0x${[V4_ACTION.SWAP_EXACT_IN_SINGLE, V4_ACTION.SETTLE_ALL, V4_ACTION.TAKE_ALL].map(b => b.toString(16).padStart(2, '0')).join('')}`;
  const input = encodeAbiParameters([{type: 'bytes'}, {type: 'bytes[]'}], [actions, [swapParams, settle, take]]);
  const commands = `0x${UR_COMMAND_V4_SWAP.toString(16).padStart(2, '0')}`;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSeconds);
  return {to: router, data: encodeFunctionData({abi: UNIVERSAL_ROUTER_ABI, functionName: 'execute', args: [commands, [input], deadline]}), value: 0n};
}

// The two-leg Permit2 route the Universal Router needs to pull an ERC-20:
// token -> Permit2 (once, max) and Permit2 -> router (per amount, timed).
// Returns the transactions still needed, in order; none if the route is set.
export async function permit2Route(client, {owner, token, amount, permit2 = UNISWAP_V4.PERMIT2, router = UNISWAP_V4.UNIVERSAL_ROUTER, now = Math.floor(Date.now() / 1000), expirySeconds = 30 * 24 * 3600}) {
  const txs = [];
  const erc20 = await client.readContract({address: token, abi: ERC20_ABI, functionName: 'allowance', args: [owner, permit2]});
  if (erc20 < amount) txs.push({label: 'approve to Permit2', to: token, data: encodeFunctionData({abi: ERC20_ABI, functionName: 'approve', args: [permit2, 2n ** 256n - 1n]}), value: 0n});
  let p2Amount = 0n, p2Exp = 0;
  try {
    const r = await client.readContract({address: permit2, abi: PERMIT2_ABI, functionName: 'allowance', args: [owner, token, router]});
    p2Amount = BigInt(r[0]); p2Exp = Number(r[1]);
  } catch {}
  if (p2Amount < amount || p2Exp <= now) {
    txs.push({label: 'Permit2 approve to router', to: permit2, data: encodeFunctionData({abi: PERMIT2_ABI, functionName: 'approve', args: [token, router, 2n ** 160n - 1n, now + expirySeconds]}), value: 0n});
  }
  return txs;
}
