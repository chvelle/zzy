# $ZZY Treasury

ZZY's Pons token, $ZZY, generates creator fees. Those fees are split deterministically:

- **50% buys $ZZY** and holds it permanently. Never sold.
- **50% funds the tokenized-stock strategy.** Realized profit compounds into larger size, up to the policy ceiling.

Shares are `treasury.buybackShareBps` / `treasury.tradingShareBps` in `config/default.json` and must sum to exactly 10000 basis points, a config that doesn't is a hard error, not something silently normalized, so a typo can't quietly redirect funds. Rounding on the buyback goes **down**, with the remainder to trading, so rounding can never manufacture buyback dollars that weren't claimed.

## The never-sell invariant

`SELL`, `SWAP_OUT`, `TRANSFER_OUT`, `WITHDRAW`, `BURN`, `BRIDGE_OUT`, and `APPROVE_SPEND` on $ZZY all throw `ZzySellAttemptError`. `BUY` is the only permitted action.

This is a constant in `src/treasury.mjs`, not a config value. No flag, environment variable, LLM verdict, or config key disables it, there's a test that passes a hostile config full of plausible override names and asserts the block still holds. Changing it requires deliberately editing the source.

`APPROVE_SPEND` is in that list on purpose: an unlimited ERC-20 approval is the usual way a "never sell" position gets drained, since the approval itself isn't a sale.

## What this module does NOT do

**It holds no private key, signs nothing, and executes nothing.** Per AGENT.md rule #7, no key material belongs in this repo.

So the flow is:

1. You claim fees with your own wallet.
2. `npm run treasury:plan -- --claim-usd <amount>` gives you the exact split and a buyback **intent**.
3. You execute the buy with your own signer.
4. You record it with the resulting `txHash`.

`recordBuyback` **requires** a txHash, the ledger records settled transactions only, never intent, matching rule #8 (never report a fill without confirmation).

Two consequences worth being explicit about:

- "Automatically invests half back into $ZZY" is not automatic here. Fully automating it means a hot wallet holding a signing key with standing authority to spend, a different and much larger security problem than anything else in this repo, and the single most common way agent treasuries get drained. The accounting is automated; the signature stays with you.
- Moving on-chain proceeds into a Robinhood Stock Token account is a manual off-ramp and deposit. There is no code path from a Robinhood Chain wallet into a brokerage account. `trading.amountUsd` is an accounting allocation, not an executed transfer.

## Compounding is capped

`tradingCapital()` returns allocated capital plus realized P&L (**negative on losing trades**, so drawdowns shrink the base rather than being ignored). That figure is then capped by `policy.maxTotalExposureUsd`.

Profits raise position size only up to that ceiling. Raising the ceiling stays a deliberate human edit. Uncapped compounding plus a losing streak is how small accounts go to zero fast, and the cap is the thing standing between "compounds nicely" and that.

## Asset boundary

$ZZY is a memecoin. It is a **treasury asset** here, never a trading candidate, `memecoin` stays blocked in `policy.mjs`, and nothing in this module relaxes that. ZZY the agent buys and holds $ZZY the token; ZZY the agent trades only tokenized stocks. The two paths never cross.

## Things worth getting a real opinion on

Not legal advice, and I'm not a lawyer, but these are worth raising with someone who is, before this runs with real money:

- **Buying your own token with revenue that token generates, while publicly committing to never sell**, is a structure regulators have opinions about. In the EU, MiCA covers market abuse for crypto-assets, and rules around price manipulation and misleading signals to the market can apply to buyback-and-promote patterns. That the buyback is automated and disclosed helps; it isn't a safe harbour by itself.
- **"Locked in his wallet forever" isn't a lock.** Tokens in a wallet you control are exactly as sellable as the key allows, the guarantee is a code invariant plus your own discipline, not a smart-contract lock. If you want it to be a real lock, that's a vesting/timelock contract holding the tokens, not a `throw` in a JS file. Worth being precise about that distinction publicly, because "locked forever" claims get read as contract-enforced.
- **Fee revenue from a launchpad token is likely taxable income on receipt** in most EU jurisdictions, and reinvesting it into the same token doesn't defer that. The ledger gives you the record; a local accountant should tell you what it means.
