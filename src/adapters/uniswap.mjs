import {encodeFunctionData, parseEther} from 'viem';
import {ADDRESSES, ERC20_ABI, QUOTER_V2_ABI, SWAP_ROUTER_ABI, PONS_POOL_FEE} from '../chain.mjs';

// 100 is the tier stable-paired pools tend to sit on; USDG/stock pools vary.
const STANDARD_FEES = [100, 500, 3000, 10000];

// Best quote across standard fee tiers. Stock Token pools (USDG-paired) may
// sit on any tier; pons pools are always 10000. Uses eth_call simulation of
// QuoterV2.
export async function bestQuote(client, {tokenIn, tokenOut, amountIn, fees = STANDARD_FEES}) {
  let best = null;
  for (const fee of fees) {
    try {
      const {result} = await client.simulateContract({
        address: ADDRESSES.UNISWAP_QUOTER_V2, abi: QUOTER_V2_ABI, functionName: 'quoteExactInputSingle',
        args: [{tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n}],
      });
      const amountOut = result[0];
      if (!best || amountOut > best.amountOut) best = {fee, amountOut};
    } catch { /* no pool on this tier */ }
  }
  if (!best) throw new Error(`no Uniswap V3 pool found for ${tokenIn} -> ${tokenOut} on tiers ${fees.join(',')}`);
  return best;
}

export function applySlippage(amountOut, slippageBps) {
  return amountOut - (amountOut * BigInt(slippageBps)) / 10000n;
}

export function buildApproveTx(token, amount) {
  return {to: token, data: encodeFunctionData({abi: ERC20_ABI, functionName: 'approve', args: [ADDRESSES.UNISWAP_SWAP_ROUTER, amount]}), value: 0n};
}

// Builds an exactInputSingle. Deliberately has no way to express tokenIn=ZZY
// from the treasury path; the signer guard rejects it anyway.
export function buildSwapTx({tokenIn, tokenOut, fee, amountIn, amountOutMinimum, recipient, routerVariant, deadlineSeconds = 120}) {
  const abi = SWAP_ROUTER_ABI[routerVariant];
  if (!abi) throw new Error('uniswap.routerVariant must be "SwapRouter" or "SwapRouter02" -- verify the router source on Blockscout');
  const base = {tokenIn, tokenOut, fee, recipient, amountIn, amountOutMinimum, sqrtPriceLimitX96: 0n};
  const params = routerVariant === 'SwapRouter'
    ? {...base, deadline: BigInt(Math.floor(Date.now() / 1000) + deadlineSeconds)}
    : base;
  return {to: ADDRESSES.UNISWAP_SWAP_ROUTER, data: encodeFunctionData({abi, functionName: 'exactInputSingle', args: [params]}), value: 0n};
}

// Convenience: WETH -> $ZZY buy plan for the treasury leg.
export async function planBuyZzy(client, {zzyToken, amountEth, slippageBps, recipient, routerVariant}) {
  const amountIn = parseEther(String(amountEth));
  const quote = await bestQuote(client, {tokenIn: ADDRESSES.WETH, tokenOut: zzyToken, amountIn, fees: [PONS_POOL_FEE]});
  return {
    approve: buildApproveTx(ADDRESSES.WETH, amountIn),
    swap: buildSwapTx({tokenIn: ADDRESSES.WETH, tokenOut: zzyToken, fee: quote.fee, amountIn, amountOutMinimum: applySlippage(quote.amountOut, slippageBps), recipient, routerVariant}),
    expectedOut: quote.amountOut,
  };
}

// WETH -> USDG for the trading half of a fee claim. One swap through the
// chain's deepest pool, then the book is in dollars.
export async function planWethToCash(client, {amountWei, slippageBps, recipient, routerVariant}) {
  const quote = await bestQuote(client, {tokenIn: ADDRESSES.WETH, tokenOut: ADDRESSES.USDG, amountIn: amountWei, fees: [100, 500, 3000]});
  return {
    approve: buildApproveTx(ADDRESSES.WETH, amountWei),
    swap: buildSwapTx({tokenIn: ADDRESSES.WETH, tokenOut: ADDRESSES.USDG, fee: quote.fee, amountIn: amountWei, amountOutMinimum: applySlippage(quote.amountOut, slippageBps), recipient, routerVariant}),
    expectedOut: quote.amountOut, fee: quote.fee,
  };
}
