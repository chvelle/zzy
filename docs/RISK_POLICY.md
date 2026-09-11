# ZZY Risk Policy

ZZY defaults to preview-only mode and fails closed. Its asset scope is limited to tokenized stocks (Robinhood Stock Tokens); it does not evaluate or trade memecoins.

## Mandatory Blocks

- Symbol absent from a present, verified, fresh Stock Token catalog (`catalog-unavailable`, `catalog-empty`, `catalog-unverified`, `catalog-stale`, `symbol-not-in-catalog`). The shipped catalog is a `verified: false` placeholder, so out of the box nothing can be prepared until you supply a real one.
- Asset class outside the configured allowlist (`config/default.json` -> `assetScope.allowedAssetClasses`). Memecoins are explicitly listed under `blockedAssetClasses` and are rejected even if they were somehow also allow-listed.
- Missing or malformed source data
- Stale observation
- Unsupported or unknown asset
- Price movement beyond the configured tolerance
- Existing-order limit reached
- Total exposure limit reached
- Missing Agentic Account
- Sample or fixture data

The asset-class check runs first and independently of every other check: a memecoin snapshot is rejected even if it would otherwise pass every freshness, price, and exposure rule.

## The reasoning layer

There is no optional layer and no fixed confidence bar. The deterministic policy says yes or no to every quoted instrument. Among the yeses, a free interest score (price movement over 5m/1h/24h, a fresh SEC 8-K, unusual volume) picks the top `research.maxCandidatesPerCycle`, their filings and headlines are fetched for free, and only those go to Claude, at most once every `research.intervalSeconds`.

Claude's authority is bounded the same way as before: it can say PREPARE, WATCH or REJECT on a name that already passed policy; a PREPARE without a downside case, a falsifier and a source is downgraded; hallucinated symbols are discarded; every failure path holds. Sizing follows its stated conviction inside `policy.maxOrderUsd` and what remains of the book.

Held positions are re-examined every `research.positionReviewSeconds` against the thesis that opened them (see `src/exit.mjs`). A stop loss is checked before the agent is consulted.

## $ZZY Treasury

See `docs/TREASURY.md`. In short: 50% of claimed fees buy $ZZY and hold it permanently (selling is a non-configurable code invariant, not a policy value), 50% funds the stock strategy, and compounded profit is capped by `policy.maxTotalExposureUsd`. The treasury module is accounting only -- it holds no key and signs nothing.

## Live Readiness

Live order submission requires an eligible Robinhood account, a dedicated Agentic Account, official MCP authorization, exact tool-schema validation for the Stock Token order flow specifically (not assumed from Robinhood's US equities/crypto agentic tooling), bounded order settings, durable idempotency, and order-state reconciliation.
