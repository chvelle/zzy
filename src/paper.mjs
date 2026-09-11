import {mkdir} from 'node:fs/promises';
import {writeJsonAtomic} from './storage.mjs';
import path from 'node:path';
import {readLedger} from './treasury.mjs';

// Paper mode. Gives the agent simulated capital so the whole decision path can
// be exercised before a token exists, before any fees have been claimed, and
// before a key is anywhere near the machine.
//
// Two hard separations, both deliberate:
//
//   1. Paper capital is written to its own ledger file, never to the real one.
//      A paper run cannot corrupt the ledger that funds live trading.
//   2. Every paper entry carries `paper: true`, and the site exporter drops
//      those entries. Simulated money must never reach a public page that has
//      a buy button on it, even by accident, even if someone points the site
//      at the wrong ledger path.
//
// Paper mode never signs. It runs the agent in preview, which cannot sign at
// all, so the worst case is a wrong log line.

export function paperConfig(config, {capitalUsd} = {}) {
  const ledgerPath = config.paper?.ledgerPath ?? 'data/paper-ledger.json';
  return {
    ...config,
    mode: 'preview',                       // forced, not inherited
    treasury: {...config.treasury, ledgerPath},
    positions: {path: config.paper?.positionsPath ?? 'data/paper-positions.json'},
    _paper: true,
    _paperCapitalUsd: capitalUsd,
  };
}

// Writes a synthetic fee claim so the book has something to deploy.
export async function seedPaperCapital(config, capitalUsd, {now = new Date()} = {}) {
  if (!(capitalUsd > 0)) throw new Error('paper capital must be positive');
  const cfg = paperConfig(config, {capitalUsd});
  const file = cfg.treasury.ledgerPath;
  await mkdir(path.dirname(file), {recursive: true});
  const ledger = {
    schemaVersion: 1,
    paper: true,
    entries: [{
      type: 'fee-claim',
      at: now.toISOString(),
      paper: true,
      claimUsd: capitalUsd * 2,      // half would have gone to the buyback
      claimEth: null,
      buybackUsd: capitalUsd,
      tradingUsd: capitalUsd,
      txHash: 'paper',
      zzyDisposition: 'simulated',
    }],
  };
  await writeJsonAtomic(file, ledger);
  return {file, tradingUsd: capitalUsd, config: cfg};
}

export async function paperState(config) {
  const cfg = paperConfig(config);
  const ledger = await readLedger(cfg);
  return {file: cfg.treasury.ledgerPath, entries: ledger.entries.length, isPaper: Boolean(ledger.paper)};
}
