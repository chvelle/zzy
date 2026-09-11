# Security model

What this bot is protected against, what it is not, and where the boundaries
actually sit. Read this before switching `mode` to `live`.

## The one thing that matters

A key that can sign is the whole risk. Everything below is arranged so that a
bug, a bad model output, or a hostile news article cannot turn into a
transaction the operator did not intend.

Use a dedicated operator wallet holding only what the loop needs. Not your
main wallet. The signer is careful, but it is software, and software has bugs.

## Trust boundaries, from the outside in

### 1. Third-party text (headlines, filing titles, retrieved pages)

Hostile by default. Anyone who can place a sentence in a news feed for a
ticker in the catalog can put text in front of the decision engine.

- `src/untrusted.mjs` strips invisible and bidi characters, defuses fake
  conversation turns and tags, caps field length, and drops any URL that is
  not plain https (no `javascript:`, no localhost, no literal IPs, so the
  cloud metadata endpoint is unreachable through this path).
- The system prompt states the trust boundary explicitly: quoted material is
  evidence, never instruction, and text that tries to instruct is itself a
  reason to distrust the source.

Sanitising is the cheap layer, not the defence. The defence is that injection
has nowhere to go, see 2 and 4.

### 2. The model

Advisory. It cannot introduce an asset, raise a limit, or size a position.

- Only symbols already on the candidate list are accepted; anything else is
  discarded as a hallucination.
- Only `PREPARE`, `WATCH`, `REJECT` are accepted.
- A `PREPARE` without a downside case, a falsifier and a source is downgraded
  to `WATCH`.
- Every failure path, including a timeout, a parse error and a missing API
  key, lands on `WATCH`. Never on `PREPARE`.

The worst a successful injection achieves is arguing for a bad buy of a
legitimate, allowlisted token, inside the risk caps.

### 3. The policy layer

Deterministic, runs before any discretionary reasoning, and its rejections are
final. Stale data, unknown instruments, exposure breaches and anything absent
from the verified catalog are dropped here.

### 4. The signer (`src/adapters/signer.mjs`)

The last boundary and the only thing that can sign. It decodes calldata before
signature and refuses:

- any call whose target is the $ZZY contract, in any form
- any swap with $ZZY as `tokenIn`, which is the never-sell invariant
- any destination not on the allowlist (WETH, USDG, router, pons locker,
  catalog stock tokens)
- any swap that is not one of four legs: WETH to $ZZY, WETH to USDG, USDG to
  stock, stock to USDG. Cash can never be swapped out to ETH by the agent,
  and one stock is never swapped straight into another
- any swap whose recipient is not the operator wallet, and any call where the
  recipient is not known at all
- any swap with `amountOutMinimum` of zero, which would be unbounded slippage
- any call to the pons locker that does not match the configured claim
  selector, including when no selector is configured
- any calldata that does not decode against the expected ABI
- any swap at all until `uniswap.routerVariant` has been verified on
  Blockscout

Live signing additionally requires `ZZY_LIVE_EXECUTION_ACK` set to the exact
phrase in `signer.mjs`, so a stray `mode: live` in config cannot sign alone.

## Operational surfaces

### Control panel (`npm run control`)

Can change what a live bot does, so it is the most sensitive port.

- Binds to 127.0.0.1 with no option to bind elsewhere.
- Every API call needs a token generated fresh at startup. It goes in a
  header, not a cookie, so a browser will not attach it cross-site.
- Config edits are limited to an allowlist with per-field ranges. `mode` is
  not on it.
- Never reads or returns a private key.

Do not port-forward it. Do not put it behind a reverse proxy. If you need it
remotely, use an SSH tunnel.

### Public site (`site/`)

- `site-data.mjs` emits a fixed allowlist of fields and never reads
  `process.env`. A test asserts a private key in the environment cannot appear
  in the output.
- Paper and fork ledger entries are filtered out, so simulated money cannot
  reach a page that has a buy button on it.
- `site-server.mjs` is GET/HEAD only, rejects path traversal, and sets CSP.

Best practice is not to serve it from the machine holding the key at all.
Export `data.json` and push it to a static host. That keeps the signing
machine off the public internet entirely.

## What this does not protect against

Stated plainly, because a security doc that only lists wins is marketing.

- **A compromise of the operator key.** Nothing here survives that. The
  never-sell rule is enforced by this code, not by a contract.
- **A change to the source.** The invariants are compiled in, not on-chain.
  Anyone who can edit `signer.mjs` can remove them.
- **A malicious dependency.** `npm install` runs code. Pin and audit.
- **MEV.** `amountOutMinimum` bounds the damage per swap. It does not prevent
  being sandwiched within that bound.
- **Issuer and counterparty risk.** Stock Tokens are derivative contracts
  issued by Robinhood Europe UAB. If the issuer stops honouring them, no code
  here helps.
- **The strategy being wrong.** Every guard above concerns whether the bot
  does what it was told. None of them concern whether that was a good idea.
