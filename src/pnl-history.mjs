// The PnL series behind the chart.
//
// The dashboard used to have no memory: every export was a snapshot and a
// reload started from nothing. This keeps a time series of the book, marked
// to market, written on every export.
//
// Two resolutions, because the page cannot take the whole thing on every
// push. `live` is the last ~hour at export cadence and rides inside
// data.json, so the chart moves with every tick. `archive` is one point per
// minute for up to 30 days, written to its own file once a minute and
// fetched by the page on load. The page stitches them.

import {readJsonOrDefault, writeJsonAtomic} from './storage.mjs';

export const DEFAULT_HISTORY = {path: 'data/pnl-history.json', liveMax: 720, archiveDays: 30};
const EMPTY = {schemaVersion: 1, live: [], archive: []};

export function historyConfig(config) { return {...DEFAULT_HISTORY, ...(config.history ?? {})}; }

export async function loadHistory(config) {
  try { return await readJsonOrDefault(historyConfig(config).path, EMPTY); }
  catch { return structuredClone(EMPTY); }   // derivable from the ledger; a corrupt file may reset
}

// A point is [unix ms, book value at market, total pnl, open pnl].
export function addPoint(store, {t, book, pnl, open}, cfg = DEFAULT_HISTORY) {
  const point = [Math.round(t), r2(book), r2(pnl), r2(open)];
  const live = [...(store.live ?? []), point].slice(-cfg.liveMax);
  // archive: one per minute, last write of the minute wins
  const minute = Math.floor(point[0] / 60000) * 60000;
  let archive = store.archive ?? [];
  if (archive.length && Math.floor(archive.at(-1)[0] / 60000) * 60000 === minute) archive = [...archive.slice(0, -1), [minute, point[1], point[2], point[3]]];
  else archive = [...archive, [minute, point[1], point[2], point[3]]];
  const cutoff = point[0] - cfg.archiveDays * 86400_000;
  archive = archive.filter(p => p[0] >= cutoff);
  return {...store, schemaVersion: 1, live, archive};
}

export async function saveHistory(store, config) { return writeJsonAtomic(historyConfig(config).path, store, {pretty: false}); }

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
