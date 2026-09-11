# Setting up ZZY

Work through this in order. Everything up to Stage 4 is safe: the agent cannot
sign a transaction until you deliberately turn that on, and it refuses to even
if `mode` says live but the environment variable is missing.

---

## Stage 0. Run it

```bash
npm install
npm test          # 201 tests, all should pass
npm run catalog   # should print usable: true, 191 symbols
npm run quote NVDA
```

If `npm run quote` returns a live bid/ask, your machine can reach Robinhood's
API and the read side works. Nothing here touches a wallet.

---

## Stage 1. Paper mode: test it before launching anything

You do not need a token, a wallet, or a key to see the agent work. Paper mode
hands it simulated capital and runs the whole decision path in preview.

```bash
npm run paper:reset -- --capital 500
npm run tick:paper
```

That is it. It will pull live quotes, track prices, run the policy gates, and
print what it would buy and why.

There is no watchlist. It quotes the entire catalog every tick and decides for
itself what deserves attention. Put your API key in `.env` so it can reason:

```bash
echo "ANTHROPIC_API_KEY=sk-ant-..." >> .env
```

Then loop it:

```bash
npm run run:paper
```

Typical output:

```
symbol  move    decision  why
NVDA     0.19%  WATCH     ...
PLTR     7.32%  REJECT    Rejected because: price-move-above-maximum.
```

**Spend real time here.** This is where you find out the limits are wrong,
the limits are too tight or too loose, or the reasoning is not what you
expected. It costs nothing.

Three separations make this safe:

- Paper capital goes to `data/paper-ledger.json`, never the real ledger.
- `mode` is forced to preview, so it cannot sign even if config says live.
- Every paper entry is labelled, and the site exporter drops labelled entries,
  so simulated money can never appear on a public page with a buy button.

`npm run paper` shows what is currently seeded. Re-run `paper:reset` any time
to start over.

---

## Stage 1b. Launch the token

Only once paper mode looks right.

1. Go to **pons.family**, connect the wallet you intend to use as the operator
   wallet, and launch $ZZY.
2. **The wallet you launch from is the creator fee recipient.** That is the
   wallet the agent has to run as, because it is the only one that can claim.
   Use a fresh wallet that holds nothing else.
3. Copy the token's contract address into config:

```json
"treasury": { "zzyTokenAddress": "0xYourTokenAddress" }
```

4. Check the agent can see it:

```bash
npm run zzy
```

This prints the pool, the fee split, graduation status, the creator payout
address, and claimable WETH. **Confirm the payout address matches your operator
wallet.** If it does not, the agent will never see the fees.

---

## Stage 1c. A wallet, and proof it can send

You can do this before there is a token. It answers the question paper mode
cannot: can this machine, with this key, get a transaction mined?

### Make the operator wallet

```bash
npm run wallet:new
```

Generates a key on your machine, writes it to `.env` with owner-only
permissions, and prints only the address. The key is never shown. **Back up
`.env` somewhere offline now.** Lose it and everything the wallet ever holds is
gone.

If you would rather use a wallet you already have, put its key in `.env`
yourself as `ZZY_OPERATOR_PRIVATE_KEY=0x...` and run `npm run wallet` to see
the address it derives. But do not use your main wallet. This process holds
the key in memory while it runs, and the never-sell rule for $ZZY lives in
this code, not on chain. Use a wallet that holds nothing you would mind losing
to a bug.

`npm run wallet` any time shows the address and checks the file permissions.

### Prove it on the testnet

Robinhood Chain has a public testnet, chain 46630, with fake ETH. Get some:

- Official faucet: https://faucet.testnet.chain.robinhood.com
- Or Alchemy's, which needs a little real ETH on Ethereum mainnet in the same
  address to prove you are not a bot.

Paste in the address from `npm run wallet`, wait for it to land, then:

```bash
npm run smoke:testnet
```

It sends a tiny amount of test ETH from the wallet to itself. That is the
whole execution pipeline, key, RPC, nonce, gas, signature, broadcast, receipt,
without needing any contract to exist. Output ends with a link to the mined
transaction on the testnet explorer.

It refuses to run on anything but chain 46630, so it cannot be pointed at real
money by accident.

**What the testnet does not prove:** Stock Tokens and pons are mainnet
products, so the actual swaps and fee claims cannot be rehearsed there. That
is what preflight (next) is for. The testnet proves the wallet and the wire;
preflight proves the specific transactions.

---

## Stage 1d. Fork mainnet locally and let it actually trade

This is the closest thing to a dress rehearsal. Anvil forks Robinhood Chain
onto your machine, so every real contract exists at its real address with real
pool liquidity, and the fork hands your wallet as much fake ETH as you want.
The agent signs and executes genuine transactions against the genuine Uniswap
pools. Nothing touches the real chain.

It is a better rehearsal than the testnet can be, because the testnet has no
Uniswap, no Stock Tokens and no pons. There is nothing there to trade.

### Install Anvil

```bash
curl -L https://foundry.paradigm.xyz | bash
foundryup
```

### Start the fork, in its own Terminal tab

```bash
npm run fork
```

Leave it running. It prints a list of test accounts and then sits there.

### In your original tab, fund your wallet on the fork

```bash
npm run fork:setup
```

Gives your operator wallet 10 fake ETH and wraps 2 of it into WETH, which is
what the trading leg expects to find. `npm run fork:status` shows balances any
time.

### Run the whole thing

```bash
npm run control:fork
```

Open the panel URL, press Start, and watch it work. When a decision clears the
gates it will really approve WETH and really call `exactInputSingle` on the
real router, and the log will carry real transaction hashes. Those hashes only
exist on your machine.

To reset, stop Anvil and start it again. The fork is thrown away.

### What this proves, and what it does not

Proves: the whole pipeline end to end, against production contracts. If a swap
works here, the same swap works on mainnet.

Does not prove: your $ZZY token, since it will not exist on a fork taken before
you launch it. Fork again after launching and it will be there.

**Safety.** Fork mode signs without the mainnet acknowledgement, because the
money is fake. Before signing is enabled it checks that the RPC is on loopback
**and** that the node answers an Anvil-only method **and** that it is forking
chain 4663. A remote URL is refused whatever it claims to be, and the flag
that enables this cannot be set by editing the config file. The never-sell
rule for $ZZY still applies on the fork; there is a test for that too.

---

## Stage 2. Preflight: prove the transactions will go through

Paper mode proves the agent decides well. It proves nothing about whether a
transaction will actually land. Those fail for unrelated reasons: wrong ABI,
missing approval, no gas, a pool that does not exist, a contract that is not
where you think it is.

`preflight` runs every transaction through `eth_call`, which executes it
against live chain state on the node and throws the result away. Same execution
path a miner would take, same reverts, but nothing is broadcast, nothing is
signed, nothing costs gas.

### 2a. Before you have a wallet funded

```bash
npm run preflight
```

Checks the RPC, the chain ID, that every contract it depends on is actually
deployed, that a pool exists for the first catalog symbol and can quote, and
**which Uniswap router variant is deployed**.

That last one resolves one of the two open blockers automatically. The two
variants have different function selectors, because `SwapRouter`'s params
struct carries a `deadline` and `SwapRouter02`'s does not. Preflight reads the
deployed bytecode and tells you which selector is in there. You no longer have
to read the source on Blockscout, and if config disagrees with the chain it
says so and tells you to trust the chain.

Put the answer in config:

```json
"uniswap": { "routerVariant": "SwapRouter02" }
```

### 2b. Pons fee claim function

Still needs a human. Open the pons locker on
[robinhoodchain.blockscout.com](https://robinhoodchain.blockscout.com) (address
from `npm run zzy`), find the function a creator calls to claim, and copy the
signature:

```json
"pons": {
  "claim":     { "abi": ["function claimFees(address token)"], "functionName": "claimFees" },
  "claimable": { "abi": ["function claimable(address) view returns (uint256)"], "functionName": "claimable" }
}
```

Then let preflight check whether you got it right, rather than finding out when
a claim fails.

### 2c. Once the wallet has gas in it

Send a small amount of ETH to the operator wallet, then:

```bash
npm run preflight -- --address 0xYourOperatorWallet
```

Now it simulates the real thing: wrapping ETH, approving the router, the swap
itself, and the pons claim. Output looks like:

```
  [ok] RPC connection             connected, block 4821903
  [ok] WETH deployed              deployed, 3124 bytes
  [ok] Router variant             bytecode contains 0x04e45aaf, so this is SwapRouter02
  [ok] NVDA pool quotes           pool found at 0.3% fee, quotes 0.0271 out
  [ok] Wallet balances            0.05 ETH for gas, 0.0 WETH to trade with
  [ok] Wrap ETH                   simulated clean
  [ok] Approve WETH               simulated clean
  [ok] Swap                       simulated clean
  [XX] Claim fees                 not the creator
```

Anything marked `XX` shows the actual revert reason. `not the creator` above
would mean the operator wallet is not the fee recipient, which is exactly the
kind of thing you want to discover here rather than on your first live claim.

**Do not go live until this is all clean.** A transaction that simulates clean
will go through, barring a state change between the simulation and the send.

### 2d. The final proof

Simulation is close to certain, not certain. When preflight is green, set
`maxOrderUsd` to something trivial like 2, run one live tick, and read the
receipt on Blockscout. Then raise the limit. One real two dollar transaction
removes the last of the doubt.

---

## Stage 3. Configure the strategy

In `config/default.json`:

```json
"runtime": { "watchAddress": "0xYourOperatorWallet" }
```

There is no watchlist. The agent quotes every instrument in the catalog each
tick and picks what to research itself.

```json
"news": { "edgarUserAgent": "zzy-agent you@youremail.com" }
```

The SEC requires a User-Agent with a contact address. Filings are skipped
without it.

Money limits, and the ones that matter most:

```json
"policy": {
  "maxOrderUsd": 50,             // biggest single position
  "maxTotalExposureUsd": 250,    // hard ceiling on the whole book
  "maxPriceMovePercent": 3       // skip anything that just ran
},
"profitPolicy": {
  "mode": "threshold",
  "compoundUntilUsd": 10000      // grow the book to here, then sweep profit to $ZZY
},
"exitPolicy": {
  "maxLossPercent": 25           // full exit past this. null disables it.
}
```

`maxTotalExposureUsd` is the number that actually caps your downside. Profit
raises deployable capital only up to it. **Set it to an amount you are willing
to lose entirely**, then raise it later once you have watched the agent work.

---

## Stage 4. Preview against your real book

Same as paper mode, but now with your actual fee income rather than simulated
capital:

```bash
npm run tick    # one cycle
npm run run     # loop forever
```

Mode is still `preview`, so it reads the chain, claims nothing, signs nothing,
and prints exactly what it *would* do. This is also what refreshes the
dashboard, so leave `npm run run` going while you watch.

---

## The control panel

Once Stage 0 works, most of what follows is easier from the panel than from
the terminal:

```bash
npm run control          # real book, loop starts paused
npm run control:paper    # simulated capital, loop starts paused
```

The terminal prints a URL with a session token in it. Open that. It is your
login; do not share it or screenshot it. The page pulls the token into memory
and scrubs it from the address bar.

From the panel you can start and pause the loop, step it one tick at a time,
edit every limit, set the research budget, change the
profit policy and stop loss, set the token address, run preflight, reset paper
capital, and watch the log and the book live. Config edits are written to
`config/default.json` and picked up on the next tick, no restart.

Three things it deliberately cannot do:

- **Turn live mode on.** Mode is pinned when the process starts. Even editing
  the config file by hand while it runs does not change it. Live is a config
  edit plus two environment variables plus a restart.
- **Edit anything outside a fixed allowlist.** The router variant, the pons
  claim ABI, the per-transaction wei cap, ledger paths and the RPC URL are all
  off limits from the panel.
- **Be reached from another machine.** It binds to 127.0.0.1 and there is no
  option to change that. Every API call needs the session token, and the
  token travels in a header rather than a cookie, so a web page you happen to
  have open cannot make your browser send it.

## Stage 5. The dashboard

```bash
npm run site        # writes site/data.json from the ledger
npm run site:serve  # read-only, 127.0.0.1:4663
```

`npm run run` refreshes the data every tick, so the page updates live.

Set your X handle and credit line under `site` in config.

For public hosting, the safer option is to put `site/` on a static host
(Cloudflare Pages, Vercel, Netlify) and have the machine running the bot push
`data.json` to it. That keeps the box holding your private key off the public
internet entirely. If you do expose the built-in server, put Cloudflare or nginx
in front of it. Never open it directly.

---

## Stage 6. Going live

Only after Stage 4 has been running long enough that the decisions look right.

1. Fund the operator wallet with a little ETH for gas. Nothing else should live
   in that wallet.
2. Set a real per-transaction ceiling:

```json
"execution": { "maxTxValueWei": "20000000000000000" }
```

3. Flip the mode:

```json
"mode": "live"
```

4. Set both environment variables. Config alone is not enough:

```bash
export ZZY_OPERATOR_PRIVATE_KEY=0x...
export ZZY_LIVE_EXECUTION_ACK=I_UNDERSTAND_THIS_SIGNS_TRANSACTIONS_WITH_REAL_FUNDS
```

5. Run **one** tick and read the receipts on Blockscout before looping:

```bash
npm run tick
```

6. If they look right:

```bash
npm run run
```

---

## Running it 24/7

The process is built to be left alone: every failure path holds rather than
trades, an unreachable price feed or quote API skips the cycle and says so,
the catalog re-syncs from Robinhood every 6 hours so new listings appear
without a restart, and an unhandled error anywhere is logged instead of taking
the process down.

What it cannot do is restart itself if the machine reboots or the process is
killed. Use a supervisor:

```bash
npm install -g pm2
pm2 start "npm run control" --name zzy
pm2 save
pm2 startup     # prints one command to run so pm2 itself survives a reboot
```

`pm2 logs zzy` tails the log, `pm2 restart zzy` restarts it. The control
panel URL with its token is in the log each time it starts.

Keep the machine on, plugged in, and on a network that will not drop. A
laptop lid closing is the most common reason an agent "stopped trading".

## What protects you, and what does not

**Enforced in code:**

- $ZZY can never be sold. Every transaction is decoded before signing, and any
  sell, transfer, burn, bridge, or spend approval on $ZZY is refused. Not a
  config value.
- Only symbols in the verified catalog can be bought, resolved by contract
  address, so a token faking the ticker cannot be hit.
- `maxTotalExposureUsd` binds regardless of profit.
- Anything failing the policy gate never reaches the reasoning layer.
- Every failure path in the reasoning layers resolves to hold or skip. It never
  trades on an error.

**Not protected:**

- Your private key. If it leaks, everything in that wallet goes, including
  $ZZY. The never-sell rule lives in this code, not on chain.
- Market risk. The agent can be wrong and lose the book.
- Editing the source. Every guard here is one commit from being removed.

## Before real money

Two things worth an hour of a professional's time, because I am not one:

- Buying your own token with revenue that token generates, while publicly
  saying it will never be sold, is a structure EU market-abuse rules under MiCA
  have opinions about. Disclosed and automated helps. It is not a safe harbour.
- Creator fee revenue is likely taxable on receipt in most EU jurisdictions,
  and reinvesting it into the same token does not defer that. The ledger gives
  you the record; an accountant should tell you what it means.
