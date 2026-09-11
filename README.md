# ZZY

An autonomous portfolio agent on Robinhood Chain. It is paid by the creator fees of its own token, $ZZY, launched on Pons. Half of every claim is bought back into $ZZY and held forever. The other half is a book of tokenized US stocks, run as a portfolio by a language model that sees the whole book, the market and its own notebook before every decision, inside limits it cannot raise.

Live at [zzy.live](https://zzy.live). It posts as [@zzygodv1](https://x.com/zzygodv1).

**Origin.** ZZY started as [MEADGod/ZZY](https://github.com/MEADGod/ZZY) by Ozzy, the creator of Pons: a preview-only crypto agent for Robinhood's Agentic Trading, built around a written rationale for every action, a risk policy that fails closed, and staged operating modes. This repo keeps that skeleton and points it at tokenized stocks on Robinhood Chain, then adds the token that pays for it, the allocator, the guards, the site and the voice. `origin.md` on the site tells the story.

**Read [OPERATORS_GUIDE.md](OPERATORS_GUIDE.md) first.** Install, every run mode (preview, paper, testnet, Anvil fork, live), the control panel, the live site feed, the X account, and the security checklist. [docs/SECURITY.md](docs/SECURITY.md) is the trust model and its limits.

## What it does, in one loop

1. Quotes the whole Stock Token registry every cycle and builds a market read from it.
2. Screens candidates through a deterministic policy: stale data, exposure, earnings blackout, catalog membership.
3. Reviews the entire book against the candidates in one model call, only when the inputs changed. Every name gets one question: does it earn its place, against cash and against everything else on the table?
4. Sizes as a share of the book toward the model's target weight, in steps, under a per-name ceiling and an aggregate cap.
5. Exits fund replacements in the same cycle. A hard stop, a cooldown and a fee check run before the model and cannot be overruled by it.
6. Signs through a guard that decodes every transaction and refuses anything that would sell, transfer, burn or approve $ZZY, or swap outside four permitted legs.
7. Exports its ledger to a public page and posts settled events to X, in its own voice, never a claim it cannot back with a hash.

The book's cash is USDG: Stock Tokens trade against USDG on Robinhood Chain. Fee claims arrive as WETH and the trading half is converted once at claim time.

## Never sold, never burned

`$ZZY` is bought and held. The signer decodes every transaction before signing and refuses any sale, approval, transfer or burn of $ZZY. It is enforced at the signing layer, not in a planner. It is a software constraint, not a contract lock; see the security doc for what that does and does not cover.

## Quick start

```bash
npm install
npm run catalog:refresh     # live Stock Token list from Robinhood's official API
npm run quote AAPL          # live bid/ask
npm run zzy                 # your token's pool, fee split, graduation, claimable
npm run tick                # one cycle, preview mode: logs what it WOULD sign
npm run control             # the local control panel
npm test
```

## Background: Robinhood Chain and Stock Tokens

- Robinhood's Stock Tokens are tokenized exposure to US-listed equities and ETFs, offered to eligible users outside the US (originally EU/EEA), not to US persons.
- Robinhood Europe UAB issues them as derivative contracts, not as shares -- holding a Stock Token does not carry shareholder rights.
- Robinhood Chain, an Ethereum Layer-2 built on Arbitrum technology, went to public mainnet on July 1, 2026, and is intended to become the settlement layer for Stock Tokens (they initially settled on Arbitrum One).
- Robinhood's Trading MCP and "Agentic Trading" have so far been announced for US equities/options accounts, with a crypto extension for US accounts described as rolling out around the same time as the Robinhood Chain launch.

**This project has not found an official confirmation that the Trading MCP exposes order tools for EU Stock Token accounts.** Those are two separate Robinhood product lines (a US-only agentic/MCP feature, and a non-US-only Stock Token product), and this repo does not assume they overlap. See `docs/ROBINHOOD_MCP.md`. Always confirm current eligibility, jurisdiction, and available tooling directly with Robinhood -- this is a fast-moving, only-months-old product area.

Sources:
- [Robinhood: "Robinhood Accelerates Global Expansion with Robinhood Chain Mainnet, Stock Tokens, Agentic Trading and New Suite of DeFi Products"](https://robinhood.com/us/en/newsroom/robinhood-accelerates-global-expansion-robinhood-chain-mainnet-stock-tokens-agentic-trading/) (Robinhood newsroom, July 1, 2026)
- [The Block: "Robinhood Chain goes live on mainnet alongside 24/7 tokenized stocks..."](https://www.theblock.co/news/business/2026-07-01-robinhood-chain-goes-live-mainnet-alongside-24-7-tokenized-stocks-lighter-perps-planned-crypto-agentic-trading-406918)
- [Robinhood EU Stock Token Dividend Match Terms (PDF)](https://cdn.robinhood.com/assets/robinhood/legal/stock_token_dividend_match_terms_eu.pdf) -- confirms Stock Tokens are derivative contracts issued by Robinhood Europe UAB, not shares.

## The tradable universe (Stock Token catalog)

`data/stock-token-catalog.json` holds every tradable ticker and its contract address. When the bot decides to buy a stock, it looks the ticker up **in that local file** and swaps straight to that address. No DEX search, no third-party resolver, no guessing:

```
"NVDA"  ->  data/stock-token-catalog.json  ->  0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC  ->  Uniswap swap
```

`resolveToken()` in `src/catalog.mjs` is that lookup. It **throws** on an unknown ticker rather than returning null, and the swap leg re-resolves at execution time instead of trusting the address carried on a snapshot. This matters because Robinhood's docs are explicit that ticker collisions are the trap: a token with a matching name or ticker but a different contract address is not a Robinhood Stock Token. The catalog is what makes the bot immune to that.

The shipped catalog holds **191 symbols from Robinhood's own asset registry** (`api.robinhood.com/rhj/assets`), every address EIP-55 checksum-validated and unique, there's a test that re-checks all of them, so a corrupted address can't sit in the file unnoticed.

Filtered to assets that are ACTIVE, on chain 4663, and **fractionally tradable**. Three (WYFI, SLS, XNDU) are whole-share only and excluded, since the agent sizes positions in dollars. `catalog:refresh` applies the same filter, so they won't come back.

Each entry is just `symbol`, `name`, `address`, nothing else is needed. Order size is decided in dollars and converted to ETH at swap time, so the share price of a token never enters the sizing math.

Newly listed tokens won't be in the file until you refresh:

```bash
npm run catalog:refresh   # overwrites the file from the official API
npm run catalog           # usable: true / false + problem list
```

That command is also how you pick up newly added tokens. The catalog fails closed on its own: missing, empty, unverified, or older than `catalog.maxAgeDays` (7) and nothing gets prepared.

## How it decides

Every tick it quotes the entire catalog, free. The policy layer gates each name
on freshness, price movement, exposure and catalog membership, free. A fresh
pull of every 8-K filed across the market is joined to the catalog, free. An
interest score ranks what passed, and the top few get their headlines fetched,
free. Only those few go to Claude, with the filings and headlines attached so
it reads first and searches only for what they leave open. That is the one
step with a bill, and `research.maxCandidatesPerCycle` every
`research.intervalSeconds` bounds it.

Claude returns PREPARE, WATCH or REJECT with a stated downside and a falsifier.
A PREPARE without those is downgraded. Size follows its conviction inside the
per-order cap and what remains of the book. The buy is recorded as a position
with its thesis attached.

Positions are re-examined on their own schedule against that thesis. If it
still holds, the position rides. If the falsifier fired, it closes, at a gain
or a loss. A stop loss underneath is checked before Claude is consulted.

## $ZZY treasury: buy forever, never sell

50% of claimed $ZZY fees buy $ZZY and hold permanently; 50% funds the stock strategy; realized profit compounds into bigger size up to the policy ceiling.

```bash
npm run treasury:plan -- --claim-usd 250   # exact split + buyback intent
npm run treasury                            # deployable capital + $ZZY held
```

The never-sell rule is a code invariant in `src/treasury.mjs`, not a config value -- no flag, env var, or LLM verdict disables it, and a test asserts that with a hostile config. `APPROVE_SPEND` is blocked alongside `SELL`, since an unlimited token approval is the usual way a never-sell position actually gets drained.

The module is **accounting only**: it holds no key, signs nothing, and records a buyback only once you supply a settled `txHash`. Full read on the invariant, the signing boundary, and the legal/tax questions worth asking a professional: `docs/TREASURY.md`.

## What ZZY Does

ZZY is designed around a controlled agentic-trading loop:

1. Connect to the authorized Robinhood MCP server.
2. Read the capabilities actually available to the eligible Agentic Account.
3. Discover which Stock Tokens are supported for that account.
4. Collect fresh price, market, and account information.
5. Build a structured trade rationale.
6. Check the proposed action against the configured risk policy, including the asset-class allowlist.
7. Review the exact asset, side, amount, price information, and estimated costs.
8. Request execution through the approved Robinhood tool boundary, if and when one is confirmed to exist for this asset class.
9. Record the returned order identifier and status.
10. Reconcile the final result before considering the operation complete.

ZZY must never claim that an order was filled merely because a request was prepared or submitted. Submitted, pending, partially filled, filled, rejected, and canceled orders are different states and must remain distinguishable.

## Agentic Account Boundary

ZZY is intended to operate through a dedicated Robinhood Agentic Account rather than unrestricted access to a user's primary account.

The Agentic Account provides an important boundary:

- ZZY can use only the funds intentionally deposited into that account.
- The user controls how much capital is exposed to the agent.
- Agent activity remains separate from unrelated personal holdings.
- Risk limits can be defined around the account's available funds.
- The user can stop funding the strategy without sharing private keys.

A dedicated account reduces the possible scope of mistakes, but it does not remove market, software, execution, or account risk.

## Trading Rationale

Before requesting any Stock Token trade, ZZY should create a compact rationale containing:

- Asset symbol and underlying equity/ETF
- Asset class (`tokenized-stock` -- anything else, especially `memecoin`, is rejected)
- Buy or sell action
- Observation timestamp
- Market-data source
- Current market conditions
- Evidence supporting the action
- Evidence contradicting the action
- Risk flags
- Intended order size
- Maximum acceptable exposure
- Invalidation conditions
- Rationale expiry time

An example rationale could look like this:

```json
{
  "agent": "ZZY",
  "asset": "SAMPLE_STOCK_TOKEN",
  "assetClass": "tokenized-stock",
  "action": "WATCH",
  "confidence": 62,
  "summary": "Market conditions are being monitored, but the available evidence does not justify an order.",
  "riskFlags": [
    "high-volatility",
    "limited-confirmation"
  ],
  "expiresAt": "2026-08-31T12:05:00Z"
}
```

This is an illustrative schema, not a real Robinhood order or a claim of live market analysis.

## Risk Policy

ZZY should fail closed when required information is missing, stale, malformed, or contradictory -- and it should fail closed on asset class first.

Suggested controls include:

- Asset-class allowlist (`tokenized-stock` only; `memecoin` explicitly blocked)
- Maximum amount per order
- Maximum total account exposure
- Maximum daily realized loss
- Supported-symbol allowlist within the tokenized-stock class
- Minimum data-freshness requirement
- Maximum acceptable price movement before execution
- Cooldown after repeated failures
- Explicit handling for pending or uncertain orders
- Emergency stop

Risk values must be configured by the account owner. Default values in a software example must never silently become live trading authorization.

## Order Safety

Before requesting execution, ZZY must validate the exact values currently visible or approved by the user:

- Robinhood account identifier
- Stock Token symbol and asset class
- Buy or sell side
- Order type
- Quantity or notional amount
- Limit price, when applicable
- Estimated price and costs
- Available buying power
- Maximum order amount
- Idempotency or request identifier, when supported

The agent must not replace invalid settings with hidden defaults at execution time.

If an execution request times out after it may have reached Robinhood, ZZY must treat the result as uncertain. It should query the order status before sending another request. An ambiguous submission must never trigger an automatic duplicate order.

## MCP Integration

ZZY is intended to use Robinhood's authorized MCP integration -- see `docs/ROBINHOOD_MCP.md` for the caveat about whether that integration currently covers Stock Tokens at all.

A production implementation should:

- Use the official Robinhood MCP server and current documentation.
- Authenticate through Robinhood's supported authorization flow.
- Request only the permissions required by ZZY.
- Keep credentials and session material outside source control.
- Validate every tool response before using it.
- Treat tool descriptions and returned market data as untrusted input.
- Keep a local, non-secret audit log of requested actions and results.
- Re-check account and order state after every write operation.

Do not invent MCP tool names, request schemas, account IDs, order fields, or endpoint behavior. The implementation must be generated and tested against the official tools exposed to the eligible Robinhood account.

## Secrets and Authentication

This repository must never contain:

- Robinhood usernames or passwords
- MFA codes
- Session cookies
- OAuth tokens
- API credentials
- Private keys
- Seed phrases
- Full credential-bearing MCP configuration

Use environment variables or the official local MCP authentication mechanism where required. Commit only a sanitized `.env.example` containing variable names without real values.

## Suggested Operating Modes

### Observe

ZZY reads supported public and account-scoped data but cannot prepare or place orders.

### Preview

ZZY produces a structured rationale and order preview without submitting it.

### Manual Approval

ZZY prepares a valid order request, but the user must explicitly approve that exact action before submission.

### Guarded Agentic Trading

ZZY may request orders within narrowly defined limits through the dedicated Agentic Account. This mode should be enabled only after the integration, risk controls, order-state handling, and emergency stop have been tested -- and only if Robinhood's MCP is confirmed to actually support Stock Token orders for the account in question.

## Audit Record

Every requested operation should record non-secret information such as:

- Agent name
- Timestamp
- Account role
- Asset and asset class
- Action
- Approved amount
- Rationale identifier
- Request identifier
- Robinhood order identifier
- Submission state
- Final order state
- Error classification

Logs must not contain authentication material or sensitive account responses.

## Project Structure

```text
zzy/
├── README.md · AGENT.md · SETUP.md
├── config/default.json
├── data/
│   ├── stock-token-catalog.json     the universe, refreshed from Robinhood
│   ├── prices.json                  rolling price history
│   └── positions.json               what it holds
├── docs/  ONCHAIN.md · RISK_POLICY.md · TREASURY.md
├── src/
│   ├── engine.mjs        the trading cycle: quote all, gate, shortlist, research, trade, manage
│   ├── intel.mjs         free intelligence: SEC 8-K firehose, Google News, interest score
│   ├── research.mjs      Claude, with filings and headlines attached
│   ├── exit.mjs          per-position judgement against the thesis; stop loss beneath
│   ├── positions.mjs     open positions from settled transactions
│   ├── policy.mjs        deterministic gate
│   ├── prices.mjs        history, movement, volatility, pool premium
│   ├── profit.mjs        principal vs book, compounding target, sweeps
│   ├── treasury.mjs      fee split, never-sell invariant, ledger
│   ├── loop.mjs          the treasury leg
│   ├── runner.mjs        the loop as an object: pause, tick, catalog refresh
│   ├── control-server.mjs · site-data.mjs · site-server.mjs
│   ├── paper.mjs · fork.mjs · preflight.mjs · smoke.mjs · wallet.mjs
│   └── adapters/  signer.mjs · uniswap.mjs · pons.mjs · robinhood-rhj.mjs
├── control/index.html    the control panel
├── site/index.html       the public dashboard
└── tests/
```

## Quick Start

Requirements:

- Node.js 20 or newer
- No npm dependencies required for preview mode (the MCP SDK is only needed by `discover-tools.mjs`)
- No Robinhood credentials required for preview mode

Run the tests:

```bash
npm test
```

Generate a decision from the clearly labeled sample fixture:

```bash
npm run demo
```

Preview an order from the latest decision:

```bash
npm run order:preview
```

Discover what your authenticated Robinhood MCP session actually exposes (opens your browser for login; requires `npm install` first):

```bash
npm run discover
```

The sample fixture can never produce or submit a live order.

## Configuration

Edit `config/default.json` to update non-secret preview policy values, including the `assetScope` allowlist. Do not widen `assetScope.allowedAssetClasses` to include `memecoin` or remove it from `blockedAssetClasses` -- and do not add Robinhood passwords, MFA codes, cookies, or access tokens.

## Current Status

ZZY is a working preview-only scaffold and Robinhood MCP integration specification, scoped to tokenized stocks.

This README does not claim that ZZY is connected to Robinhood, funded, placing orders, generating returns, or operating autonomously. Live capabilities require:

- An eligible Robinhood Stock Token account, in a jurisdiction where the product is offered
- Confirmation that Robinhood's Trading MCP actually exposes tools for that account and asset class (unconfirmed as of this writing -- see `docs/ROBINHOOD_MCP.md`)
- A dedicated Agentic Account, if and when Robinhood offers one for this asset class
- Completed Robinhood authentication
- User-defined capital and risk limits
- Runtime and integration testing

## Roadmap

### Phase 1, Observe

- Connect to the authorized Robinhood MCP server
- Detect available account and Stock Token capabilities
- Normalize supported market data
- Add freshness, schema, and asset-class validation

### Phase 2, Preview

- Generate structured trade rationales
- Add position and exposure limits
- Build exact order previews
- Record non-secret audit events

### Phase 3, Manual Execution

- Add explicit per-order authorization
- Validate exact order parameters
- Submit through the official MCP boundary
- Reconcile order states and partial fills

### Phase 4, Guarded Agentic Trading

- Add narrowly scoped autonomous limits
- Add durable duplicate-order prevention
- Add failure cooldowns and emergency stop
- Complete independent security and financial review

## Disclaimer

ZZY is experimental software and documentation. Tokenized stocks are a novel product structure; Stock Tokens are derivative contracts, not shares, and their value tracking, custody, and regulatory treatment can differ from owning the underlying equity directly. Markets are volatile and can result in substantial or total loss.

Nothing in this repository is financial, tax, or legal advice, a promise of profit, a recommendation to buy or sell an asset, or a claim of Robinhood endorsement.

Robinhood product availability, eligibility, supported assets, account requirements, restrictions, and fees vary by jurisdiction and may change. Always verify your own eligibility and the current terms directly with Robinhood before enabling any agentic trading workflow.

## Contributing

Run `npm test` and `npm run release:check` before a pull request. The second refuses if anything that looks like a key, a token, a wallet or an email is in the tree, and if any operator state file is present. Never commit `.env` or anything under `data/`, `treasury/` or `decisions/` other than the catalog and the `.gitkeep`.

## License

MIT. The original ZZY skeleton is Ozzy's; check the license on [MEADGod/ZZY](https://github.com/MEADGod/ZZY) for the terms that apply to what came from there.
