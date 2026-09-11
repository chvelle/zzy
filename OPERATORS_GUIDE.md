# ZZY Operator's Guide

Everything you need to install, configure, test and run ZZY, from first
`npm install` to a live bot on Robinhood Chain. Read it top to bottom the
first time. After that, the sections stand alone.

ZZY is an autonomous agent. It claims creator fees from its own token, $ZZY,
buys half of them back into $ZZY and holds forever, and trades Robinhood
Stock Tokens with the other half. It runs 24 hours a day, watches the entire
Stock Token catalog, and consults a language model before it buys. Once it is
live it signs real transactions with real money without asking you first.
Every mode below except the last one exists so you never have to find out
something is wrong with money on the line.

---

## 1. What you need

**Machine.** Anything that runs Node 20 or newer and stays on. A laptop that
closes its lid is the most common reason an agent "stopped trading". A small
VPS or a Mac Mini in a cupboard is ideal.

**Accounts and keys.**

| Item | Needed for | Where |
|---|---|---|
| Node.js 20+ | everything | nodejs.org |
| Anthropic API key | research and exit decisions | console.anthropic.com |
| An email address | SEC filings feed (their fair-access rule) | any |
| Foundry (Anvil) | fork mode only | getfoundry.sh |
| A dedicated EVM wallet | fork, testnet and live modes | `npm run wallet:new` makes one |
| A little ETH on Robinhood Chain | live mode only, for gas | bridge from Ethereum |

**Jurisdiction.** Robinhood Stock Tokens are issued by Robinhood Europe UAB
and are not offered to US persons. Confirm you are eligible before running
anything that signs.

---

## 2. Install

```bash
unzip zzy-robinhood-agent.zip && cd zzy
npm install
npm test
```

The zip unpacks to a single `zzy/` folder with `package.json` at its top.
If `npm test` says `Missing script: "test"`, you are one folder too high or
too low; `ls` should show `package.json`, `src/` and `tests/`.

You should see `pass 201, fail 0`. If a test fails, stop; do not run the bot
on a machine where the suite does not pass.

Then confirm the read side works:

```bash
npm run catalog        # usable: true, 191 symbols
npm run quote NVDA     # a live bid and ask
```

Neither of these touches a wallet. If `quote` returns a price, this machine
can reach Robinhood's API and the bot can see the market.

---

## 3. The files that matter

```
config/default.json        every setting; the panel edits an allowlisted subset
.env                       secrets: API key, private key, live acknowledgement
data/stock-token-catalog.json   ticker -> contract address, from Robinhood's registry
data/positions.json        what the bot currently holds (live)
data/prices.json           price history it builds itself
data/notebook.json         names it is tracking and what it is waiting for
data/earnings.json         the earnings calendar, refreshed twice a day
data/social-log.json       every post it made, or would have made in dry-run
data/pnl-history.json      the P&L series behind the chart
treasury/ledger.json       every settled fee claim, buyback and realised P&L (live)
data/paper-ledger.json     the same, for paper mode; never mixed with the real one
decisions/                 one JSON file per model verdict, feeds the public log
site/                      the public dashboard and its data.json
control/                   the private operator panel
docs/SECURITY.md           the trust model and its limits
```

Every state file is written atomically and keeps a `.bak` of the previous
version next to it. A corrupt file halts the bot with a message telling you
which file and where the backup is. It never silently starts from blank,
because a blank ledger would make the next fee claim treat your entire wallet
as fresh income.

---

## 4. Configuration

Open `config/default.json`. The settings that matter most:

### Money limits

```json
"policy": {
  "maxOrderUsd": 50,
  "maxTotalExposureUsd": 250,
  "maxPriceMovePercent": 3
}
```

`maxTotalExposureUsd` is the number that actually caps your downside. Profit
raises deployable capital only up to it, and the agent cannot raise it
itself. Set it to an amount you are willing to lose entirely. Raise it later,
after you have watched the agent work.

Sizing is a share of the book, not a dollar amount:

```json
"policy": {
  "maxOrderUsd": null,
  "sizing": {
    "maxPositionPercent": 60,
    "maxOrderPercent": 25,
    "minOrderUsd": 5
  }
}
```

The model sees the whole portfolio and states a target weight for each name
it wants. The engine adds toward that target in steps of at most
`maxOrderPercent` of the book per cycle, and never lets one name exceed
`maxPositionPercent`. A name the agent is strongly convinced about can become
most of the book, over a few cycles, up to that ceiling. Because the unit is
the book, sizing scales as the book compounds.

`maxOrderUsd` is an optional hard dollar cap on top. Set it to 2 for your
first live trade, then clear it.

`maxPriceMovePercent` skips anything that has already run in the last five
minutes. The bot does not chase.

### Exits

```json
"exitPolicy": {
  "maxLossPercent": 25,
  "cooldownSeconds": 900
}
```

A position past `maxLossPercent` is closed without asking the model. It is a
backstop, not the strategy. `null` disables it. Do not do that.

Everything else about exits is the allocator's call, made in the same review
as entries (below). A position is never sold because it is up, down, or
because a headline was bad. It is kept because it still has the best claim
on its capital, and sold because that capital would do more in a named
replacement, or because the reason it was bought no longer holds.

### Profit

```json
"profitPolicy": {
  "mode": "threshold",
  "compoundUntilUsd": 10000
}
```

`compound` keeps all trading profit in the book. `buyback` sweeps all of it
into $ZZY. `threshold` compounds until the book reaches `compoundUntilUsd`,
then sweeps everything above that line.

### Research

```json
"research": {
  "intervalSeconds": 300,
  "maxCandidatesPerCycle": 6,
  "maxSearchesPerCycle": 4
}
```

The bot quotes every symbol every tick for free. The review is the only step
that costs money. Every `intervalSeconds`, one model call sees the whole
book, every open position with its weight, thesis and result, and every
candidate the screen surfaced with filings and headlines attached, and
answers one question for every name: does it earn its place in this
portfolio, against cash and against everything else on the table? Holdings
come back as HOLD, TRIM or CLOSE with a named replacement; candidates come
back with a verdict and a target weight. Exits run first so freed capital
funds what replaces it in the same cycle.

Each review also sees what the market did (built from the SPY, QQQ, SMH, XLK
and GLD tokens in the catalog, breadth, leaders and laggards), the latest
filings and headlines on every position it holds, and its own notebook.

The notebook is `data/notebook.json`. When the review says WATCH on a name it
can write down what it is waiting for: a level, a date, a print. That note
comes back to it next review, and the name reaches the shortlist without
needing a price move first. Notes expire after `notebook.ttlDays` and the
notebook is capped at `notebook.maxEntries`, so it stays a notebook and not
a second catalog. Read it any time; it is the closest thing to the agent's
train of thought.

### What a review costs, and when it runs

The review is the only thing in the loop that costs money. Three things
keep the bill honest when it runs 24 hours a day:

```json
"research": {
  "intervalSeconds": 300,
  "intervalSecondsExtended": 900,
  "intervalSecondsClosed": 3600,
  "skipIfNothingNew": true,
  "materialMovePercent": 2,
  "maxCandidatesPerCycle": 6,
  "maxSearchesPerCycle": 4
}
```

**Cadence by session.** Every five minutes in regular hours, every fifteen
in pre and after-market, hourly overnight and at weekends. Filings and
headlines still land off-hours and the next gate catches them; this only
sets how often the bot checks whether there is anything to think about.

**Skip when nothing changed.** Before every review the bot fingerprints what
the model would be shown: which names, which filings, which headlines, the
notebook, the holdings, the cash. If the fingerprint matches the last review
and no holding has moved `materialMovePercent` since, the model is not
called. It cannot form a different view of identical inputs, so it is not
asked to. A new headline, a new 8-K, a fee claim landing as cash, or a 2%
move on something held all count as new. Expect the log to say `nothing new
since the last review, skipping the model call` a lot overnight. That is the
bill not being spent.

**Bounded per review.** `maxCandidatesPerCycle` caps how many names it sees,
`maxSearchesPerCycle` caps web searches, and the prompt tells it to search
only for what the attached material leaves open. Raise the search cap if
you want deeper reviews and a bigger bill.

The same idea governs the quotes. `execution.tickIntervalSeconds` applies in
regular hours, `tickIntervalSecondsExtended` (120) pre and after-market,
`tickIntervalSecondsClosed` (300) overnight and weekends. The stop loss is
checked every tick regardless. Slowing off-hours ticks takes the catalog
quoting from about 275,000 requests a day to about 60,000.

### Earnings calendar

```json
"policy":   { "earningsBlackoutDays": 1 },
"earnings": { "windowDays": 14, "refreshHours": 12 }
```

Fetched from Nasdaq's public calendar, one small request per day in the
window, cached on disk at `data/earnings.json` and refreshed twice a day.
Two uses:

- A candidate reporting inside the blackout is dropped before it can cost a
  headline fetch or a slot in the review. The bot has no edge on a print,
  and it should not pay to reason about one. Holdings are never force-sold
  by this.
- Every holding and candidate carries its next report date into the review,
  so "reports Tuesday, wait for the print" is a decision it can make and a
  note it can leave.

If the calendar cannot be fetched the review is told `unknown`, never "no
report coming".

### Identity

```json
"news":    { "edgarUserAgent": "zzy-agent you@example.com" },
"site":    { "twitter": "https://x.com/yourhandle", "credit": "Launched on Pons, built by you" },
"runtime": { "watchAddress": "0xYourOperatorWallet" }
```

The SEC requires a User-Agent with a contact address on their feed. Filings
are skipped without one, which removes the bot's best input.

### Secrets go in `.env`, never in config

```bash
cp .env.example .env
```

```
ANTHROPIC_API_KEY=sk-ant-...
ZZY_OPERATOR_PRIVATE_KEY=          # leave blank until section 8
ZZY_LIVE_EXECUTION_ACK=            # leave blank until section 9
```

`.env` is gitignored and `npm run wallet` checks that its permissions are
owner-only. Back it up somewhere offline the moment it holds a key.

---

## 5. The modes

There are five ways to run ZZY. They form a ladder. Each rung proves
something the one below it cannot, and each is safe until the last.

| Mode | Money | Signs | Proves |
|---|---|---|---|
| Preview | none | no | the decisions, against the real chain |
| Paper | simulated | no | the decisions, with capital to deploy |
| Testnet smoke | fake | yes, on chain 46630 | the wallet, RPC, nonce, gas and broadcast |
| Fork | fake | yes, on a local copy of mainnet | every real swap against real pools |
| Live | real | yes | nothing further; this is the thing itself |

### 5a. Preview

The default. `mode` is `preview` in the shipped config and the signer is a
stub that throws if anything tries to use it.

```bash
npm run tick     # one cycle
npm run run      # loop
```

It reads the chain, quotes the catalog, runs every gate, consults the model
when research is due, and logs what it *would* do with `[preview]` in front.
With no token configured and no fees claimed it has no capital, so it will
mostly say it has nothing to deploy. That is correct.

### 5b. Paper

Preview with simulated capital, so the whole decision path has something to
decide about.

```bash
npm run paper:reset -- --capital 500
npm run run:paper
```

Three walls keep this separate from real money: paper capital lives in
`data/paper-ledger.json`, never the real ledger; mode is forced to preview so
it cannot sign even if config says live; and every paper entry is labelled,
and the site exporter drops labelled entries, so simulated numbers never reach
a page with a buy button.

**Spend real time here.** This is where you learn that a limit is wrong,
research is too eager or too shy, or the exit policy does not do what you
thought. It costs only API calls.

Paper mode does not update the public site. That is deliberate.

### 5c. Testnet smoke test

Proves the wallet can get a transaction mined. Nothing more, nothing less.

```bash
npm run wallet:new       # generates a key into .env, prints only the address
```

Get testnet ETH for that address from `faucet.testnet.chain.robinhood.com`,
wait for it to land, then:

```bash
npm run smoke:testnet
```

It sends a tiny amount of test ETH from the wallet to itself on chain 46630
and prints a link to the mined transaction. That is the entire execution
pipeline, key, RPC, nonce, gas, signature, broadcast and receipt, without
needing any contract to exist. It refuses to run on any chain but 46630, so
it cannot be pointed at real money by mistake.

What it does not prove: Stock Tokens, Uniswap and Pons are mainnet products
and do not exist on the testnet. The testnet proves the wire. The fork proves
the swaps.

### 5d. Fork

The dress rehearsal. Anvil copies Robinhood Chain onto your machine. Every
real contract exists at its real address with real pool liquidity, and your
wallet is handed as much fake ETH as it wants. The bot signs and executes
genuine transactions against the genuine router. Nothing touches the real
chain.

Install Foundry once:

```bash
curl -L https://foundry.paradigm.xyz | bash
foundryup
```

In its own terminal tab, start the fork and leave it running:

```bash
npm run fork
```

Back in the first tab:

```bash
npm run fork:setup     # 10 fake ETH to your wallet, 2 wrapped to WETH, 1.5 of that swapped to USDG through the real pool
npm run control:fork   # opens the panel in fork mode
```

Open the panel URL, press Start, and watch. When a decision clears the gates
it approves WETH and calls `exactInputSingle` on the real router, and the log
carries real transaction hashes that exist only on your machine.

To prove the plumbing without waiting for the market to give the model a
reason to buy, the panel in fork mode has two overrides under **Fork test
trades**:

- *Make Claude say PREPARE on NVDA.* Everything runs for real on the next
  cycle. Only the model's verdict on that one symbol is substituted. The
  engine sizes, checks the pool premium, approves, swaps and records exactly
  as it would on a real verdict.
- *Make the exit review say CLOSE on NVDA.* Same, for the sell path.

Both refuse outside a fork. Fork mode checks that the RPC is on loopback,
that the node answers an Anvil-only method, and that it is forking chain
4663. A remote URL is refused whatever it claims to be, and the flag that
enables fork signing is not a config file option, so it cannot be set by
editing config.

The never-sell rule for $ZZY still applies on the fork. There is a test.

To reset, stop Anvil and start it again.

### 5e. Live

Section 9. Not before.

---

## 6. The control panel

Once install works, most of what follows is easier from the panel than from
the terminal.

```bash
npm run control          # real book, loop starts paused
npm run control:paper    # simulated capital
npm run control:fork     # local fork
```

The terminal prints a URL with a session token in it. Open that. The token is
your login; do not share it or screenshot it. The page pulls it into memory
and scrubs it from the address bar.

From the panel: start and pause the loop, step one tick at a time, edit every
limit, set the research budget, change the profit policy and stop loss, set
the token address, run preflight, reset paper capital, and watch the log and
the book live. Edits are written to `config/default.json` and picked up on
the next tick with no restart.

Three things it deliberately cannot do:

- **Turn live mode on.** Mode is pinned when the process starts. Live is a
  config edit plus two environment variables plus a restart.
- **Edit anything outside a fixed allowlist.** Router variant, Pons claim
  ABI, the per-transaction wei cap, ledger paths and the RPC URL are all off
  limits from the panel.
- **Be reached from another machine.** It binds to 127.0.0.1 with no option
  to change that. Every call needs the session token in a header, so a web
  page you happen to have open cannot make your browser send it. If you need
  it remotely, use an SSH tunnel. Never port-forward it.

---

## 7. The public site and the live feed

```bash
npm run site           # export site/data.json from the ledger once
npm run site:serve     # serve site/ read-only on 127.0.0.1:4663, with the live feed
```

When the bot is running, the dashboard updates itself in two ways:

**After every tick.** The runner re-exports `data.json` when a cycle ends, so
every decision, buy, sell and fee claim reaches the page as it happens.

**Between ticks.** A trading tick is slow: it quotes the whole catalog, reads
filings and calls a model. Prices do not wait for that. A separate repricer
re-quotes the symbols the bot holds every `site.repriceSeconds` (5 by
default), re-marks the open positions to market and re-exports. It signs
nothing and never touches the trading path.

**How the page receives it.** `npm run site:serve` exposes `/events`, a
one-way Server-Sent Events stream. Each export is pushed to every open page
within milliseconds of the file being written. The page shows **Feed: Live**
when connected. If `/events` is not available, because the site is on a
static host or a proxy strips streams, the page falls back to polling
`data.json` every `site.pollSeconds` and shows **Feed: Polling**. Both paths
end in the same render.

The chart is the book's total P&L over time. The bot records a point on
every export: the last hour rides inside `data.json` so the chart moves with
every push, and a one-per-minute archive for 30 days is written to
`site/history.json` and loaded once by the page. Nothing is drawn that was
not measured. A fresh install shows a flat line until the first exports.

What the page shows moves between trades: **Book value now** is settled cash
plus open positions at the current reference price, and **Profit to date**
splits into settled and open. Positions that fail to quote are held at cost
rather than guessed.

### 7c. Keeping zzy.live live

The static host serves a snapshot. To make it follow the bot without ever
exposing the machine that holds the key, the bot pushes its two data files
to Vercel Blob as they change and the page reads them from there.

One-time setup:

1. Vercel dashboard, your `zzy` project, **Storage**, Create Database,
   **Blob**. Connect it to the project.
2. Project **Settings**, **Environment Variables**: copy
   `BLOB_READ_WRITE_TOKEN`. Put it in `.env` (silent prompt, same as the
   other keys):

   ```bash
   sed -i '' '/^BLOB_READ_WRITE_TOKEN=/d' .env; read -s "K?Blob token: "; echo; echo "BLOB_READ_WRITE_TOKEN=$K" >> .env; unset K
   ```

3. Push once by hand and deploy the page so it knows where to look:

   ```bash
   npm run site:push && npm run site:deploy
   ```

That's it. From then on, while the bot runs, `data.json` goes to the blob
whenever it changes (at most every `site.push.intervalSeconds`, 30) and
`history.json` every 5 minutes. The blob's CDN holds a file for
`site.push.cacheSeconds` (60, Vercel's floor) and the page polls every 15
seconds, so the numbers on zzy.live are never more than about 90 seconds
behind the bot. `feed.json` in the site folder is what tells the page to
read from the blob; it is written by the first push, so deploy after it.

The page still works without any of this: no token means no push, and the
site stays a snapshot you update with `npm run site:deploy`.

### Hosting it publicly

The machine running the bot holds the private key. Keep it off the public
internet. Two options, in order of preference:

1. **Static host, bot pushes the file.** Put `site/` on Cloudflare Pages,
   Vercel or Netlify. Have the bot machine push `site/data.json` after each
   export (a cron or a post-export hook with `rclone`, `aws s3 cp`, `wrangler
   pages deploy`, whatever the host takes). The page polls; the signing
   machine is unreachable. You lose the sub-second push and keep everything
   else.

2. **Built-in server behind a proxy.** Run `npm run site:serve` and put
   Cloudflare Tunnel or nginx in front of it. Proxies must not buffer
   `/events` (the server sets `X-Accel-Buffering: no` for nginx; on
   Cloudflare, SSE works by default). You keep the live feed and accept that
   the bot's machine now has a public route to one read-only port.

Never expose `4663` or `4664` directly. Never proxy `4664`, the control
panel, at all.

---

## 7b. The X account

ZZY posts to its own account, `@zzygodv1`, in its own voice: first person,
short, dry, about what it actually did. It only ever posts about events that
already exist in its ledger, a settled buy or sale, a fee claim, a review it
ran, plus one state-of-the-book post a day after the US close and, when
nothing has happened, an occasional thought from its notebook. It never
says "buy $ZZY", never predicts a price, never uses a hashtag, an emoji or
an exclamation mark, and every post is scanned for secrets before it leaves.

It ships in dry-run. With `social.enabled` false, every post it would have
made is written to `data/social-log.json` and nothing is sent. Run it that
way for a day first and read the log:

```bash
npm run social:log
npm run social:preview     # composes today's report from the current book, prints it, sends nothing
```

To go live, create an app at developer.x.com under the account, set its
permissions to **Read and Write**, then generate the four keys. The access
token must be generated after setting Read and Write, or it will be
read-only and every post will fail with a 403. Put them in `.env`:

```
X_API_KEY=
X_API_SECRET=
X_ACCESS_TOKEN=
X_ACCESS_SECRET=
```

Then flip `social.enabled` in the panel, or in config, and post once by hand
to prove the keys:

```bash
npm run social:hello
```

Cadence: if it happened, it posts. A settled buy, sale, rotation or fee
claim goes out the same tick it settled, with no gap and no daily cap. A
close that named its replacement and the buy of that replacement become one
post. Soft posts, the review's own notes and thoughts from the notebook, go
out at most every `social.softEveryHours` (6) and only when nothing real has
been said since. `social.safetyCapPerDay` (60) exists solely so a bug cannot
become a hundred tweets an hour. Paper and fork runs never post.

Mood: by default it does not post losses, down days, or downbeat thoughts.
A losing close, a rotation out at a loss, a daily report with the book under
water, a musing on a day the index is down: none of it is posted, and none
of it is spun into something else either. The dashboard remains the full
record and the account links to it. `social.postBearish` turns this off,
and then it says losses plainly.

### How money moves onchain

Worth having straight in your head before live:

- **Fees arrive as WETH.** The $ZZY pool is WETH-paired, so a claim pays
  WETH. Half is swapped WETH to $ZZY and held. The other half is swapped
  WETH to USDG through the chain's deepest pool, and that USDG is the book.
- **Stocks are bought with USDG and sold for USDG.** Single hop, each token's
  own USDG pool, best fee tier by quote. The signer permits exactly four
  swap legs: WETH to $ZZY, WETH to USDG, USDG to stock, stock to USDG. It
  refuses everything else, including cash back out to ETH and stock to
  stock.
- **Room is the smaller of the ledger and the wallet.** If the ledger says
  the book may deploy $500 but the wallet holds $300 USDG, it trades $300
  and says so in the log.

## 8. Launch the token and prepare the wallet

Only once paper mode looks right.

**The wallet.** `npm run wallet:new` generated one in section 5c. If you did
not do that yet, do it now. Use a fresh wallet that holds nothing else. The
never-sell rule for $ZZY is enforced by this code, not by a contract, and it
cannot protect a wallet whose key has leaked.

**The token.** Go to pons.family, connect the operator wallet, launch $ZZY.
The wallet you launch from is the creator fee recipient, and that is the
wallet the agent must run as, because it is the only one that can claim.

Put the contract address in config and confirm the bot sees it:

```json
"treasury": { "zzyTokenAddress": "0xYourToken" }
```

```bash
npm run zzy
```

That prints the pool, fee split, graduation status, the creator payout
address and claimable WETH. **Confirm the payout address is your operator
wallet.** If it is not, the bot will never see a fee.

**Resolve the two chain facts the docs do not state.**

```bash
npm run verify
```

Reads the deployed router bytecode and its verified ABI to determine whether
it is `SwapRouter` or `SwapRouter02`, by two independent methods, and reads
the Pons locker's verified ABI to list its claim function and any claimable
view. Nothing is signed. Then:

```bash
npm run verify:write
```

Patches `config/default.json`, but only where the answer is unambiguous. If
the locker exposes two plausible claim functions, or one that takes arguments
the script would have to invent, it writes nothing for that field and says
so. The signer refuses every swap until `uniswap.routerVariant` is set, and
every fee claim until `pons.claim` is set. Unset is the safe state; wrong is
not.

If the locker is not verified on Blockscout, the ABI cannot be read at all.
Ask Pons for the signature, or decode a claim transaction another creator has
already sent to that contract.

**Preflight.** Send a small amount of ETH to the operator wallet for gas,
then:

```bash
npm run preflight -- --address 0xYourOperatorWallet
```

Runs every transaction the bot will ever send through `eth_call` against live
chain state: wrap, approve, swap, claim. Same execution path a sequencer
would take, same reverts, nothing broadcast, nothing signed, no gas. Every
line must be `[ok]`. A `[XX]` line shows the actual revert reason; `not the
creator` on the claim line means the payout wallet is wrong, and this is
where you want to learn that.

---

## 9. Going live

Only after preview has run against your real book long enough that the
decisions look right, preflight is clean, and you have done at least one fork
session.

1. Fund the operator wallet. Two things go in it, and they are different:

   - **ETH for gas.** A small amount; the runner warns when it drops below
     `execution.gasReserveEth`.
   - **USDG for the book.** The book's cash is USDG, because Stock Tokens
     trade against USDG on Robinhood Chain. Before any fees have been
     claimed, the book has nothing to deploy, so send USDG to the wallet and
     tell the ledger about it:

     ```bash
     npm run fund -- --usd 500
     ```

     It checks the USDG is actually there before recording it. Fee claims
     top this up automatically later: the trading half of each claim is
     swapped from WETH to USDG at claim time.

   Nothing else lives in that wallet.

2. Set a real per-transaction ceiling in wei. It ships as `"0"`, which
   refuses every value transfer:

   ```json
   "execution": { "maxTxValueWei": "20000000000000000" }
   ```

3. Start small. Set `policy.maxOrderUsd` to 2 for the first trade. Clear it afterwards so the percent limits govern.

4. Flip the mode:

   ```json
   "mode": "live"
   ```

5. Set both environment variables in `.env`. Config alone cannot sign:

   ```
   ZZY_OPERATOR_PRIVATE_KEY=0x...
   ZZY_LIVE_EXECUTION_ACK=I_UNDERSTAND_THIS_SIGNS_TRANSACTIONS_WITH_REAL_FUNDS
   ```

   The phrase must match exactly. The startup log will say `LIVE SIGNING
   ENABLED`. If it says `cannot sign`, one of the two is wrong.

6. Run **one** tick, then read every receipt on
   `robinhoodchain.blockscout.com`:

   ```bash
   npm run tick
   ```

7. If the two-dollar trade did what you expected, set `maxOrderUsd` to
   what you intend, or clear it, and loop it:

   ```bash
   npm run control      # panel, press Start
   # or
   npm run run          # headless
   ```

One real two-dollar transaction removes the last of the doubt that
simulation cannot.

---

## 10. Running it 24/7

The process is built to be left alone. Every failure path holds rather than
trades. An unreachable quote feed skips the cycle and says so. Fetches time
out at 15 seconds instead of hanging a tick. The catalog re-syncs from
Robinhood every six hours so new listings appear without a restart. An
unhandled error anywhere is logged and the next tick runs.

What it cannot do is restart itself. Use a supervisor:

```bash
npm install -g pm2
pm2 start "npm run control" --name zzy
pm2 save
pm2 startup      # prints one command to run so pm2 survives a reboot
```

`pm2 logs zzy` tails the log. `pm2 restart zzy` restarts it. The panel URL
with its token is in the log each time it starts.

### Backups

Back up `.env`, `treasury/ledger.json`, `data/positions.json` and
`config/default.json` on a schedule. The first is irreplaceable. The other
three are what the bot believes it owns, and while the chain is the source of
truth, reconstructing cost basis from raw transfers is a bad afternoon.

Each state file keeps a `.bak` of its previous version beside it. If the bot
halts with `not valid JSON`, the message names the file; restore the `.bak`
and restart.

### Reading the log

| Line | Meaning |
|---|---|
| `quoted 191/191, 40 pass policy, 151 rejected` | normal; most names are rejected every cycle |
| `research not due for 240s` | normal; the model is consulted on its own cadence |
| `review: Rotated NVDA into TSLA; capex thesis played out, TSLA has the better setup at today's price.` | the allocator's one-line summary of what changed in the book |
| `NVDA: close 4.2 for $812.50, realised +$112.50, capital to TSLA (0x...)` | an exit whose proceeds are earmarked for a named replacement |
| `NVDA: sizing $250.00 (0% held, target 60%, one step of 25%)` | a buy sized as a share of the book, stepping toward its target |
| `review not due for 2400s (closed cadence 3600s)` | overnight; the bot is not spending on reviews |
| `nothing new since the last review, skipping the model call` | inputs identical to the last review; no bill |
| `earnings blackout: ORCL (reports 2026-09-10 after-hours, inside the 1-day blackout)` | dropped before research; no edge on a print |
| `social: [dry-run] posted close: Sold TSLA. NVDA has the better claim on the money.` | what it would have tweeted; flip social.enabled to send |
| `social: refused a review post (forbidden: ...)` | the scan caught something; nothing sent |
| `NVDA: pool 2.4% over reference, skipping` | the premium guard working; more common overnight |
| `NVDA: buy failed, nothing recorded: ... reverted` | the swap reverted; no position, no baseline change |
| `Signer refused: ...` | a guard fired before signing; read the reason |
| `repricing the dashboard every 5s` | the site feed is running |
| `site push: live feed at https://....blob.vercel-storage.com/data.json` | first push succeeded; deploy the site folder once |
| `treasury: {"acted":false,"reason":"unallocated WETH 0.000000 ..."}` | no new fees since the last claim; normal |

---

## 11. Security checklist

Before live, every line should be true.

- [ ] The operator wallet holds only ETH for gas and what the bot has bought.
- [ ] `.env` has owner-only permissions (`npm run wallet` checks).
- [ ] `.env` is backed up offline.
- [ ] `npm test` passes on this machine.
- [ ] `npm run verify` resolved the router variant and the claim function, or you set them from a verified source.
- [ ] `npm run preflight -- --address ...` is entirely `[ok]`.
- [ ] `maxTotalExposureUsd` is an amount you can lose entirely.
- [ ] Port 4664 is not reachable from outside the machine.
- [ ] Port 4663 is behind a proxy or not exposed; the site is on a static host or behind Cloudflare.
- [ ] `docs/SECURITY.md` read, including the section on what is not protected.

What the code enforces: $ZZY can never be sold, transferred, burned or
approved for spending. The hard stop, cooldown and fee check run before the
allocator and it cannot overrule them. Only catalog tokens can be bought, by contract
address. Every swap has a minimum output and returns to the operator wallet.
The Pons locker is only ever called with the configured claim selector. The
model cannot introduce a symbol, raise a limit or size a position. Every
failure path resolves to hold.

What it does not enforce: your key staying secret, the source staying
unmodified, dependencies being honest, the issuer honouring the tokens, and
the strategy being right. The last one is the one most likely to cost you
money.

---

## 12. Command reference

```
npm test                       run the suite
npm run catalog                is the catalog usable, how many symbols
npm run catalog:refresh        pull the current registry from Robinhood
npm run quote NVDA             live bid/ask for one symbol
npm run zzy                    $ZZY on-chain state, payout wallet, claimable fees
npm run verify                 resolve router variant and Pons claim signature (read-only)
npm run verify:write           same, and patch config where unambiguous
npm run wallet                 show the operator address, check .env permissions
npm run wallet:new             generate a fresh operator key into .env
npm run fund -- --usd 500      record USDG you sent to the wallet as trading principal
npm run smoke:testnet          one real transaction on chain 46630
npm run preflight -- --address 0x..   simulate every transaction against live state
npm run fork                   start Anvil forking Robinhood Chain (own tab)
npm run fork:setup             fund the operator wallet on the fork
npm run fork:status            balances on the fork
npm run fork:buy NVDA 20       fork only: force a buy through the real path
npm run fork:sell NVDA         fork only: close a position through the real path
npm run paper                  show simulated capital
npm run paper:reset -- --capital 500   seed simulated capital
npm run tick:paper             one cycle on simulated capital
npm run run:paper              loop on simulated capital
npm run tick                   one cycle (preview or live, per config)
npm run run                    loop
npm run control                panel, real book, starts paused
npm run control:paper          panel, simulated capital
npm run control:fork           panel, local fork
npm run treasury               ledger summary
npm run treasury:plan -- --claim-usd 100   how a claim of that size would split
npm run site                   export site/data.json once
npm run site:serve             serve the dashboard with the live feed on 127.0.0.1:4663
npm run site:push              push data.json and history.json to Vercel Blob once, write feed.json
npm run site:deploy            deploy the site folder to Vercel (zzy.live)
npm run social:preview         compose today's X post from the book, print it, send nothing
npm run social:hello           the first real post; needs social.enabled and X keys
npm run social:log             the last 20 posts, real or dry-run
```

---

## 13. Before real money, two things a professional should look at

Buying your own token with revenue that token generates, while publicly
saying it will never be sold, is a structure EU market-abuse rules under MiCA
have opinions about. Automated and disclosed helps. It is not a safe harbour.

Creator fee revenue is likely taxable on receipt in most EU jurisdictions,
and reinvesting it into the same token does not defer that. The ledger gives
you the record. An accountant tells you what it means.
