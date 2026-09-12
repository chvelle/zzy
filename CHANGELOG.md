# Changelog

## 0.4.0

The release that went live. First fee claim, first buyback, first stock
trades, all on Robinhood Chain.

### Pons V2
- Full support for tokens launched on Pons V2: launch detection from the
  V2 factory, fee claims from the V2 escrow in the launch's quote asset,
  buybacks on the bonding curve before graduation and on the Uniswap v4
  pool after it. `pons.version: "auto"` picks V1 or V2 per token.
- The Universal Router on Robinhood Chain is a modified fork whose v4 swap
  struct carries an extra `minHopPriceX36` field. Stock Uniswap calldata
  reverts against it; ours matches it, in the builder and in the signer's
  decoder, from one shared definition.
- A buyback that cannot run this tick is parked in the ledger and retried,
  never spent elsewhere.

### Uniswap v4 for the book
- Stock legs (USDG to stock, stock to USDG) run on v4 as well as v3; the
  engine quotes both venues and takes the better one.
- v4 pool discovery from the chain: every pool that exists for a pair,
  whatever its fee, tick spacing or hook, from the PoolManager's
  `Initialize` events (explorer first, RPC scan as fallback, cached).
- Hookless pools are always usable. A pool on a hook is quoted and reported
  but not used until the hook is listed under `uniswap.v4.allowedHooks`.
- The v3 router variant is read off the router's bytecode at startup; no
  verify step needed.

### Allocator
- The model never sees the book in dollars, only in percent. Size of the
  book is never a reason to act or not act.
- Posture (`research.posture`: patient, balanced, active) sets how much
  conviction a setup needs. Hard guards apply the same under all three.
- Survives every reply shape: prose around the JSON, a paused turn
  mid-search, a talk-only reply, an empty reply after searches, a dropped
  connection. A review that did not complete does not count as one.
- Citation markup from web search is stripped from the model's prose.
- An add to a name already held inherits the thesis on file.

### Social
- Routine claims and buybacks are quiet; milestones post once: first fees
  claimed, first buyback, and ladders for $ZZY bought back, lifetime fees,
  lifetime profit and trade count. Trades always post.
- Settled events are never skipped as downbeat.

### Site
- Decision log first, grouped by review, plain-language verdicts, expandable
  reasoning with downside case, falsifier and sources. Portfolio panel with
  weights that add to 100. Plain headings.
- Live feed through the site's own `/api/push` function with a shared
  secret; the blob token never leaves Vercel.

### Bought back and burned
- Half of every claim buys $ZZY, which is burned. The signer refuses any
  sale, transfer or approval of $ZZY.

### Other
- `npm run buy -- SYMBOL USD`: an operator-directed live buy through the
  normal path, same guards, recorded and posted like any buy.
- Trade counts come from settled fills; closed positions keep their history.
- 277 tests.

## 0.3.0

First public release. USDG as the book's cash, Pons V1 fee claims, Uniswap
v3 stock legs, the guarded signer, the control panel, the public terminal.
