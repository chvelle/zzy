// The book's cash is USDG.
//
// Robinhood Chain's Stock Tokens trade against USDG, the chain's native
// stablecoin, not against WETH. The deep pools are USDG/NVDA, USDG/SPY and
// so on; WETH pools exist for a few names and are thin. A book that held
// WETH and swapped it straight into stock tokens would find no pool for
// most of the registry and a bad one for the rest.
//
// So: fee claims arrive as WETH (the $ZZY pool is WETH-paired). The buyback
// half stays in WETH and buys $ZZY. The trading half is swapped once, into
// USDG, through the chain's deepest pool. From then on the book is USDG in
// and USDG out, single-hop against each stock token's own pool, and its
// cash is dollar-stable rather than carrying ETH exposure.

import {parseUnits, formatUnits} from 'viem';
import {ADDRESSES, ERC20_ABI} from './chain.mjs';

export const CASH = ADDRESSES.USDG;
let cachedDecimals = null;

// USDG is 6 decimals on every chain it is deployed on, but it is read once
// rather than assumed, for the same reason stock token decimals are.
export async function cashDecimals(client) {
  if (cachedDecimals != null) return cachedDecimals;
  try {
    const d = Number(await client.readContract({address: CASH, abi: ERC20_ABI, functionName: 'decimals'}));
    cachedDecimals = Number.isInteger(d) && d >= 0 && d <= 36 ? d : 6;
  } catch { cachedDecimals = 6; }
  return cachedDecimals;
}
export function _resetCashDecimals() { cachedDecimals = null; }

export async function cashBalance(client, owner) {
  const [raw, d] = await Promise.all([
    client.readContract({address: CASH, abi: ERC20_ABI, functionName: 'balanceOf', args: [owner]}),
    cashDecimals(client),
  ]);
  return {raw, usd: Number(formatUnits(raw, d)), decimals: d};
}

export function toCash(usd, decimals) { return parseUnits(Number(usd).toFixed(decimals), decimals); }
export function fromCash(raw, decimals) { return Number(formatUnits(raw, decimals)); }
