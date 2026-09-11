# ZZY On-Chain Loop

Everything runs from one operator wallet on Robinhood Chain (chain ID 4663). No brokerage account, no MCP.

```
                 pons locker                       Uniswap V3 (Robinhood Chain)
  $ZZY trades ──► creator fees accrue ──► claim ──► WETH in operator wallet
                                                        │
                                          50% ──► WETH→$ZZY swap ──► held forever (signer refuses any sale)
                                          50% ──► earmarked trading capital
                                                        │
  api.robinhood.com/rhj ─► catalog + quotes ─► policy ─► research LLM ─► WETH→StockToken swap
  (SEC EDGAR + web search)                                 │
                                                  realized P&L ──► ledger ──► bigger size, capped by policy
```

## Why this works without Robinhood's MCP

Robinhood Stock Tokens are plain ERC-20s on Robinhood Chain, fully transferable, listed on Uniswap, each with a Chainlink feed ([docs.robinhood.com/chain/stock-tokens](https://docs.robinhood.com/chain/stock-tokens)). Robinhood publishes a read-only REST API for the catalog and quotes ([Stock Token APIs](https://docs.robinhood.com/chain/stock-token-apis)). So the stock leg is: official quote in, policy gate, LLM research, Uniswap swap out, same wallet, same router, same chain as the $ZZY buyback.

The earlier "MCP doesn't cover EU Stock Tokens" concern is moot. It's not needed.

## Sources, and what was NOT verified

| Thing | Source | Status |
|---|---|---|
| Chain ID, RPC, WETH, Uniswap router/quoter/factory, pons factory/locker | docs.ponsfamily.com, docs.robinhood.com/chain/contracts | verified |
| pons fee split reads, graduation, token self-description | docs.ponsfamily.com (code copied verbatim) | verified |
| Stock Token catalog + quotes | api.robinhood.com/rhj/assets, /prices/{symbol} | verified, official; 191 tradable contract addresses in `data/stock-token-catalog.json`, checksum-validated |
| SEC EDGAR full-text search | efts.sec.gov/LATEST/search-index | verified (undocumented but stable, needs User-Agent) |
| Uniswap exactInputSingle, QuoterV2, ERC-20, Chainlink ABIs | standard public interfaces | verified |
| **Which router ABI is at `0xCaf6…5cb2`** (SwapRouter vs SwapRouter02) | not stated in pons docs | **you verify on Blockscout → `uniswap.routerVariant`** |
| **pons creator-fee claim function** | not in pons docs | **you copy from verified locker source → `pons.claim`** |
| pons creator-claimable view | not in pons docs | optional → `pons.claimable`; loop works without it (see below) |

The two bolded items are the only things standing between preview and live, and the code refuses to sign until they're set. It will not guess a selector.

**Watch out for `ponfamily.com`** (no "s"). It's a lookalike that advertises an "API key" flywheel feature the real docs don't have. The official domain is `ponsfamily.com`.

## Threshold and the auto-claim wrinkle

`pons.claimThresholdEth` (default 0.42) triggers a claim when the locker reports at least that much creator-claimable WETH.

The pons docs also say unclaimed fees may be auto-claimed by pons and routed to the payout wallet. So the loop doesn't depend on its own claim: every tick it measures WETH in the wallet above `wethBaselineEth` in the ledger and treats that as proceeds. After a buyback, the baseline moves to the remaining balance (the trading half). Either path, your claim or theirs, ends up split the same way.

Fees accrue in **both** WETH and $ZZY. The $ZZY side of a claim is simply held. The 0.42 threshold and the 50/50 split apply to the WETH side.

## Never-sell is enforced where it can't be bypassed

`src/adapters/signer.mjs` is the only code that can sign, and `guard()` decodes every transaction before it does. Refused outright:

- any call whose target is the $ZZY contract (transfer, approve, permit, increaseAllowance, anything)
- any `exactInputSingle` with $ZZY as `tokenIn`
- any swap whose recipient isn't the operator wallet
- bare ETH sends to anything but WETH/router
- opaque calldata that doesn't decode against the expected ABI
- any swap at all until `routerVariant` is verified

Stock tokens may be bought *and* sold, they're not $ZZY. Tests in `tests/signer.test.mjs` cover every branch, including a live signer that still refuses a $ZZY sale.

Two things this cannot protect against, so be clear-eyed: the key itself leaking (then anyone can sell), and you editing the source. "Locked in the wallet" is a code invariant plus your discipline, not a contract lock.

## Price

The agent tracks price, not market capitalisation. For a tokenised equity, market cap is supply multiplied by price, and supply moves with issuance and redemption rather than with anything about the instrument, so it carries no information the price does not already carry. It is deliberately absent from the codebase.

`src/prices.mjs` keeps a rolling per-symbol series (26h, capped at 720 samples) written to `data/prices.json` every tick. From it the agent derives 5m, 1h and 24h movement, realised volatility, and the series handed to the research layer.

Two prices matter and they are not the same thing:

- **Reference quote** from `api.robinhood.com/rhj/prices`, what the instrument is quoted at.
- **Pool price** from the Uniswap quoter, what the agent actually pays.

They are held together by arbitrage, not by a peg, so they can diverge when liquidity is thin. `execution.maxPoolPremiumPercent` (default 2) skips a buy when the pool sits too far above the reference, since that is paying more for identical exposure.

## Compounding

`tradingCapital()` = trading-half allocations + realized P&L, capped at `policy.maxTotalExposureUsd`. Losses shrink the base. Profits grow it up to the cap. Raising the cap is a deliberate config edit, never automatic.

Record realized P&L with `recordRealizedPnl` when a stock position closes. The stock leg's sell path (research verdict `REJECT` on a held position) is wired but position tracking across restarts is minimal, see `holdings` in `stockTick`.

## Go-live checklist

1. `npm run catalog:refresh`, pull the real Stock Token list from Robinhood. Verify `npm run catalog` says `usable: true`.
2. Set `treasury.zzyTokenAddress` after your launch. `npm run zzy` shows pool, fee split, graduation, and the creator payout wallet. **The operator wallet must be that payout wallet**, or the fees land somewhere the loop can't see.
3. On Blockscout, open the router at `0xCaf681a66D020601342297493863E78C959E5cb2`, confirm SwapRouter vs SwapRouter02, set `uniswap.routerVariant`.
4. On Blockscout, open the active locker, find the creator claim function in the verified source, set `pons.claim.abi` + `functionName` (and `pons.claimable` if there's a view).
5. Set `config.news.edgarUserAgent` to `"your-app you@email"` (SEC requirement).
6. Set `runtime.watchAddress` to the payout wallet and run `npm run tick` in **preview**. It logs exactly what it would sign.
7. Enable `research.enabled` with `ANTHROPIC_API_KEY` set. Run preview ticks until the decisions look sane to you.
8. Fund a **dedicated** operator wallet with a little ETH for gas. Set `execution.maxTxValueWei` to a real per-tx ceiling.
9. `mode: "live"`, set `ZZY_OPERATOR_PRIVATE_KEY` and `ZZY_LIVE_EXECUTION_ACK`, run `npm run tick` once, read the receipts on Blockscout, then `npm run run`.

## Costs you'll pay that the code can't reduce

- 1% pool fee on every $ZZY buyback (pons pools are fixed at 1%). Your buyback of your own token pays fees, 70% of which come back to you as creator fees. That's fine; just know a chunk of each cycle is the pool fee round-tripping.
- Stock Token pool fees on Uniswap (whatever tier has liquidity), plus slippage. Small caps on thin pools will move against you.
- Gas, in ETH, on both legs.
- On the stock leg, the honest expected edge from public news is small. Primary-source filings (EDGAR) catch things you'd otherwise miss; they don't beat the market to them.
