import {readFile} from 'node:fs/promises';
import {publicClient} from './chain.mjs';
import {createGuardedSigner} from './adapters/signer.mjs';
import {loadCatalog, catalogProblems} from './catalog.mjs';
import {treasuryTick} from './loop.mjs';
import {tradingCycle, forceBuy, forceSell} from './engine.mjs';
import {refreshCatalog} from './catalog.mjs';
import {writeSiteData} from './site-data.mjs';
import {sessionAt} from './session.mjs';
import {socialAfterTick} from './social.mjs';
import {readLedger} from './treasury.mjs';
import {pushSite, writeFeedFile} from './site-push.mjs';
import {loadNotebook, liveEntries} from './notebook.mjs';
import {fetchQuote} from './adapters/robinhood-rhj.mjs';
import {paperConfig, paperState} from './paper.mjs';
import {forkConfig, assertLocalFork, FORK_RPC} from './fork.mjs';

// The bot loop as an object something can drive: the CLI, the control panel,
// a test. Holds the state the control panel needs to show and the controls it
// needs to offer, and nothing that would let a caller change the trust
// boundary. In particular there is no method here that turns live mode on.
// Live is decided when the process starts, from config plus the two
// environment variables, and it stays that way until the process is restarted.

// ETH/USD. A feed hiccup skips the cycle with a reason rather than guessing.
export async function ethUsd(fetchImpl = fetch) {
  const sources = [
    ['DeFiLlama', 'https://coins.llama.fi/prices/current/coingecko:ethereum', j => j?.coins?.['coingecko:ethereum']?.price],
    ['Coinbase', 'https://api.coinbase.com/v2/prices/ETH-USD/spot', j => Number(j?.data?.amount)],
  ];
  const errs = [];
  for (const [name, url, pick] of sources) {
    try {
      const r = await fetchImpl(url, {signal: AbortSignal.timeout(8000)});
      if (!r.ok) { errs.push(`${name}: HTTP ${r.status}`); continue; }
      const price = pick(await r.json());
      if (Number.isFinite(price) && price > 0) return price;
      errs.push(`${name}: no usable price`);
    } catch (e) { errs.push(`${name}: ${e.message.split('\n')[0]}`); }
  }
  throw new Error(`could not get an ETH/USD price (${errs.join('; ')})`);
}

export class Runner {
  constructor({configPath = 'config/default.json', paper = false, fork = false, forkRpc = FORK_RPC, env = process.env, deps = {}} = {}) {
    this.configPath = configPath;
    this.paper = paper;
    this.fork = fork;
    this.forkRpc = forkRpc;
    this.env = env;
    this.deps = {publicClient, createGuardedSigner, loadCatalog, treasuryTick, tradingCycle, refreshCatalog, writeSiteData, ethUsd, socialAfterTick, fetchQuote, ...deps};
    this.cycleState = {};          // research cadence, carried between ticks
    this.catalogRefreshedAt = null;
    this.state = 'stopped';        // stopped | idle | ticking | paused
    this.lines = [];               // ring buffer of log lines
    this.maxLines = 300;
    this.lastTickAt = null;
    this.lastTickResult = null;
    this.lastError = null;
    this.tickCount = 0;
    this.timer = null;
    this.repriceTimer = null;
    this.lastRepriceAt = null;
    this._stopping = false;
    this.config = null;
    this.mode = null;
  }

  log(msg) {
    const line = {at: new Date().toISOString(), msg: String(msg)};
    this.lines.push(line);
    if (this.lines.length > this.maxLines) this.lines.splice(0, this.lines.length - this.maxLines);
    if (this.onLog) this.onLog(line);
  }

  // Reads config fresh from disk. Called before every tick so edits made in
  // the control panel apply on the next cycle without a restart. The mode,
  // however, is pinned at start: a config edit cannot promote a preview
  // process to live.
  async loadConfig() {
    let cfg = JSON.parse(await readFile(this.configPath, 'utf8'));
    if (this.paper) cfg = paperConfig(cfg);
    if (this.fork) cfg = forkConfig(cfg, this.forkRpc);
    else if (this.mode) cfg.mode = this.mode;
    return cfg;
  }

  async start() {
    if (this.state !== 'stopped') return this.snapshot();
    // Proving the fork is local and real happens before anything is allowed
    // to sign, not after.
    if (this.fork) {
      const info = await assertLocalFork(this.forkRpc);
      this.log(`forked from ${info.forkedFrom} at block ${info.blockNumber}, chain ${info.chainId}`);
    }
    this.config = await this.loadConfig();
    this.mode = this.config.mode;                    // pinned for the life of the process
    if (this.paper) {
      this.catalogRefreshedAt = Date.now();
      const st = await paperState(this.config);
      if (!st.entries) throw new Error('No paper capital. Run: npm run paper:reset');
    }
    this.client = this.deps.publicClient(this.config.chain?.rpcUrl);
    this.catalog = await this.deps.loadCatalog(this.config);
    const problems = catalogProblems(this.catalog, this.config);
    if (problems.length) this.log(`catalog: ${problems.join(', ')}. Stock leg will reject everything until refreshed.`);
    this.config.runtime = {...this.config.runtime, allowedStockTokens: (this.catalog?.symbols ?? []).map(s => s.address).filter(Boolean)};
    // The v3 router variant is read off the router's bytecode when the
    // config does not name it, so a fresh install never has to run a
    // verify step to be able to swap on v3.
    if (!this.config.uniswap?.routerVariant && !this.paper) {
      try {
        const {detectRouterVariant} = await import('./preflight.mjs');
        const d = await detectRouterVariant(this.client);
        if (d.ok) { this.detectedRouterVariant = d.variant; this.config.uniswap = {...(this.config.uniswap ?? {}), routerVariant: d.variant}; this.log(`v3 router: ${d.detail}`); }
        else this.log(`v3 router variant unknown (${d.detail}); v3 swaps stay refused, v4 is unaffected`);
      } catch (e) { this.log(`v3 router variant not detected: ${e.message.split('\n')[0]}; v3 swaps stay refused, v4 is unaffected`); }
    }
    this.signer = this.deps.createGuardedSigner(this.config, this.env);   // throws if live without the ack
    // A Pons V2 token: the signer reads the launch's curve and quote asset
    // from the factory so it can recognise (and bound) the V2 legs. A V1
    // token leaves those destinations refused.
    if (this.signer.live && this.signer.resolvePonsV2) {
      try {
        const v2 = await this.signer.resolvePonsV2(this.client);
        if (v2) this.log(`pons v2 launch: curve ${v2.curve}, quote ${v2.pairToken === '0x0000000000000000000000000000000000000000' ? 'ETH' : v2.pairToken}, ${['on the curve', 'swept', 'trading on v4', 'rescued'][v2.phase] ?? v2.phase}`);
      } catch (e) { this.log(`pons v2 lookup failed: ${e.message.split('\n')[0]}`); }
    }
    this.state = 'paused';
    this.log(`ready in ${this.mode} mode${this.paper ? ' (paper)' : ''}${this.fork ? ' (local fork, fake money)' : ''}${this.signer.live ? (this.fork ? ', signing on the fork' : ', LIVE SIGNING ENABLED') : ', cannot sign'}`);
    return this.snapshot();
  }

  async tick() {
    if (this.state === 'stopped') await this.start();
    if (this.state === 'ticking') return {skipped: true, reason: 'a tick is already running'};
    const prev = this.state;
    this.state = 'ticking';
    const log = (m) => this.log(m);
    try {
      const config = await this.loadConfig();
      config.runtime = {...config.runtime, allowedStockTokens: this.config.runtime.allowedStockTokens};
      if (!config.uniswap?.routerVariant && this.detectedRouterVariant) config.uniswap = {...(config.uniswap ?? {}), routerVariant: this.detectedRouterVariant};
      this.config = config;
      let price;
      try { price = await this.deps.ethUsd(); }
      catch (e) { log(`skipping this cycle: ${e.message}`); this.lastError = e.message; return {skipped: true, reason: e.message}; }

      const out = {};
      if (!this.paper) {
        // Re-read the launch each tick: it graduates from the curve to the v4 pool at some point, and the guard must follow.
        if (this.signer.live && this.signer.resolvePonsV2) { try { await this.signer.resolvePonsV2(this.client); } catch {} }
        try { out.treasury = await this.deps.treasuryTick({client: this.client, signer: this.signer, config, ethUsd: price, log, catalog: this.catalog, fetchQuote: this.deps.fetchQuote}); if (!out.treasury?.skipped) log(`treasury: ${JSON.stringify(out.treasury, (k, v) => typeof v === 'bigint' ? v.toString() : v)}`); }
        catch (e) { log(`treasury error: ${e.message}`); out.treasuryError = e.message; }
      }
      // The catalog is refreshed from Robinhood on a schedule so newly listed
      // instruments show up without a restart. A failed refresh keeps the
      // last good catalog.
      const refreshEvery = (config.catalog?.refreshHours ?? 6) * 3600_000;
      if (!this.paper && !this.fork && (!this.catalogRefreshedAt || Date.now() - this.catalogRefreshedAt > refreshEvery)) {
        try {
          const r = await this.deps.refreshCatalog(config);
          this.catalog = await this.deps.loadCatalog(config);
          config.runtime.allowedStockTokens = (this.catalog?.symbols ?? []).map(s => s.address).filter(Boolean);
          this.config.runtime.allowedStockTokens = config.runtime.allowedStockTokens;
          this.catalogRefreshedAt = Date.now();
          log(`catalog refreshed: ${r.symbolCount} instruments`);
        } catch (e) { log(`catalog refresh failed, keeping the last good one: ${e.message}`); this.catalogRefreshedAt = Date.now(); }
      }
      try {
        out.trading = await this.deps.tradingCycle({client: this.client, signer: this.signer, config, catalog: this.catalog, ethUsd: price, log, state: this.cycleState});
        const t = out.trading;
        log(`cycle: ${t.reason ?? `${t.buys?.length ?? 0} buys, ${t.exits?.length ?? 0} position reviews, researched ${(t.researched ?? []).join(', ') || 'nothing'}`}`);
      } catch (e) { log(`trading error: ${e.message}`); out.tradingError = e.message; }
      // Gas. Everything above needs native ETH to send; a wallet that runs dry
      // fails every transaction with a message that looks like a bug.
      if (this.signer?.live && !this.fork) {
        try {
          const wei = await this.client.getBalance({address: this.signer.address});
          const eth = Number(wei) / 1e18, reserve = config.execution?.gasReserveEth ?? 0.003;
          if (eth < reserve) log(`LOW GAS: ${eth.toFixed(5)} ETH in the operator wallet, below the ${reserve} ETH reserve. Send ETH or trades will start failing.`);
          out.gasEth = eth;
        } catch {}
      }
      let site = null;
      if (!this.paper) {
        try { site = (await this.deps.writeSiteData(config, {wallet: this.signer.address ?? config.runtime?.watchAddress ?? null})).data; await this._pushSite(); }
        catch (e) { log(`site export error: ${e.message}`); }
      }
      // The voice. Runs last, off the settled results of this tick, and never
      // from a simulated run. A failure here is logged and cannot affect trading.
      if (!this.paper && !this.fork) {
        try {
          const nb = liveEntries(await loadNotebook(config), new Date());
          out.social = await this.deps.socialAfterTick({out, site, notebook: nb, market: this.cycleState.lastMarket ?? null, session: this.cycleState.lastSession ?? null, config, env: this.env, log, ledger: await readLedger(config).catch(() => null), tradesCount: site?.activity?.ordersExecuted ?? 0});
        } catch (e) { log(`social error: ${e.message}`); }
      }
      this.lastTickAt = new Date().toISOString();
      this.lastTickResult = out;
      this.lastError = out.treasuryError || out.tradingError || null;
      this.tickCount++;
      return out;
    } finally {
      if (this._pauseAfter) { this._pauseAfter = false; this.state = 'paused'; this.log('paused'); }
      else this.state = prev === 'stopped' ? 'paused' : prev;
    }
  }

  // The public page has to move between trades, and a trading tick is slow:
  // it shortlists, fetches headlines and calls a model. Repricing is neither
  // of those. It re-quotes the held symbols and rewrites data.json, so the
  // dashboard tracks open positions at their own cadence and a slow tick
  // can't stall it. It signs nothing and never touches the trading path.
  startReprice() {
    if (this.repriceTimer || this.paper) return;
    const seconds = Math.max(5, this.config?.site?.repriceSeconds ?? 15);
    const loop = async () => {
      if (this.state === 'stopped') return;
      if (this.state !== 'ticking') {
        try {
          await this.deps.writeSiteData(this.config, {wallet: this.signer?.address ?? this.config?.runtime?.watchAddress ?? null});
          await this._pushSite();
          this.lastRepriceAt = new Date().toISOString();
        } catch (e) { this.log(`reprice error: ${e.message}`); }
      }
      if (this.state !== 'stopped') this.repriceTimer = setTimeout(loop, seconds * 1000);
    };
    this.repriceTimer = setTimeout(loop, seconds * 1000);
    this.log(`repricing the dashboard every ${seconds}s`);
  }

  // Pushes the exported files to the blob store when they changed. The
  // first time a URL comes back, feed.json is written so the deployed page
  // knows where to look. Never throws into the loop.
  async _pushSite() {
    if (this.paper || this.fork) return;
    try {
      const r = await (this.deps.pushSite ?? pushSite)({config: this.config, env: this.env, log: this.log.bind(this)});
      if (r?.urls && !this._feedWritten) {
        await writeFeedFile({urls: r.urls});
        this._feedWritten = true;
        this.log(`site push: live feed at ${r.urls.data}; deploy the site folder once (npm run site:deploy) and zzy.live updates on its own from then on`);
      }
    } catch (e) { this.log(`site push error: ${e.message.split('\n')[0]}`); }
  }

  stopReprice() {
    if (this.repriceTimer) { clearTimeout(this.repriceTimer); this.repriceTimer = null; }
  }

  async resume() {
    if (this.state === 'stopped') await this.start();
    if (this.state === 'idle') return this.snapshot();
    this.state = 'idle';
    this.log('running');
    const loop = async () => {
      if (this.state !== 'idle') return;
      await this.tick();
      if (this.state === 'idle') {
        // Quoting the whole catalog every minute at 3am, with the underlying
        // closed and the reference frozen, is 275k requests a day for nothing.
        // Ticks slow down outside regular hours. The stop loss is still checked
        // every tick, and the review gate has its own, separate cadence.
        const ex = this.config?.execution ?? {};
        const phase = sessionAt(new Date()).phase;
        const seconds = phase === 'regular' ? (ex.tickIntervalSeconds ?? 60)
          : (phase === 'premarket' || phase === 'afterhours') ? (ex.tickIntervalSecondsExtended ?? ex.tickIntervalSeconds ?? 60)
          : (ex.tickIntervalSecondsClosed ?? ex.tickIntervalSecondsExtended ?? ex.tickIntervalSeconds ?? 60);
        this.timer = setTimeout(loop, seconds * 1000);
      }
    };
    loop();
    this.startReprice();
    return this.snapshot();
  }

  pause() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.stopReprice();
    if (this.state === 'idle') { this.state = 'paused'; this.log('paused'); }
    else if (this.state === 'ticking') { this._pauseAfter = true; this.log('pausing after this tick'); }
    return this.snapshot();
  }

  // Fork-only. The engine refuses these unless config._fork is set.
  async forceBuy(symbol, usd) {
    if (this.state === 'stopped') await this.start();
    const price = await this.deps.ethUsd();
    return forceBuy({client: this.client, signer: this.signer, config: this.config, catalog: this.catalog, symbol, usd, ethUsd: price, log: (m) => this.log(m)});
  }
  async forceSell(symbol, fraction = 1) {
    if (this.state === 'stopped') await this.start();
    const price = await this.deps.ethUsd();
    return forceSell({client: this.client, signer: this.signer, config: this.config, catalog: this.catalog, symbol, fraction, ethUsd: price, log: (m) => this.log(m)});
  }

  // Fork-only. Queue a verdict for the next cycle so the real Claude-to-swap
  // path runs with only the model's answer substituted.
  setForkVerdict(symbol, verdict, {confidence = 80, reason} = {}) {
    if (!this.fork) throw new Error('verdict overrides only exist on a local fork');
    if (!['PREPARE', 'WATCH', 'REJECT'].includes(verdict)) throw new Error('verdict must be PREPARE, WATCH or REJECT');
    (this.cycleState.verdictOverrides ??= {})[symbol.toUpperCase()] = {verdict, confidence, reason};
    this.log(`[fork] next cycle: Claude's verdict on ${symbol.toUpperCase()} will read ${verdict}`);
    return this.cycleState.verdictOverrides;
  }
  setForkExit(symbol, action, {fraction, reason} = {}) {
    if (!this.fork) throw new Error('exit overrides only exist on a local fork');
    if (!['TRIM', 'CLOSE', 'HOLD'].includes(action)) throw new Error('action must be TRIM, CLOSE or HOLD');
    (this.cycleState.exitOverrides ??= {})[symbol.toUpperCase()] = {action, fraction, reason};
    this.log(`[fork] next cycle: exit verdict on ${symbol.toUpperCase()} will read ${action}`);
    return this.cycleState.exitOverrides;
  }

  snapshot() {
    return {
      state: this.state,
      mode: this.mode,
      paper: this.paper,
      fork: this.fork,
      live: Boolean(this.signer?.live),
      wallet: this.signer?.address ?? this.config?.runtime?.watchAddress ?? null,
      lastTickAt: this.lastTickAt,
      lastError: this.lastError,
      tickCount: this.tickCount,
      intervalSeconds: this.config?.execution?.tickIntervalSeconds ?? 60,
      catalogSymbols: this.catalog?.symbols?.length ?? 0,
      lastReviewAt: this.cycleState.lastReviewAt ?? null,
      lastCheckAt: this.cycleState.lastCheckAt ?? null,
      researchIntervalSeconds: this.config?.research?.intervalSeconds ?? 300,
    };
  }
}
