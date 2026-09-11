// The notebook. What a person keeps in their head, or in a text file next
// to their brokerage tab: names they are tracking and what they are waiting
// for. "AMD: MI400 launch in October, buy if it holds 150 into it." "TSLA:
// deliveries print next week, thesis is fine but the print decides it."
//
// Without this every review started from nothing. A WATCH verdict evaporated
// the moment it was given, and the name only came back if the deterministic
// screen happened to surface it again, which needs a price move or a filing.
// So the agent could never do the most basic thing an investor does, which
// is wait for a setup it has already identified.
//
// Entries come from the allocator: for a WATCH it can say what would turn it
// into a buy; for a holding it can leave a note about what it is watching.
// Noted names are fed back into the next review, and they get an interest
// boost so they reach the shortlist without needing to move first. Entries
// expire, and the notebook is capped, so it stays a notebook rather than a
// second catalog.

import {readJsonOrDefault, writeJsonAtomic} from './storage.mjs';
import {sanitizeUntrusted} from './untrusted.mjs';

const EMPTY = {schemaVersion: 1, entries: []};
export const DEFAULT_NOTEBOOK = {path: 'data/notebook.json', maxEntries: 20, ttlDays: 7};

export function notebookConfig(config) { return {...DEFAULT_NOTEBOOK, ...(config.notebook ?? {})}; }

export async function loadNotebook(config) {
  return readJsonOrDefault(notebookConfig(config).path, EMPTY);
}

export async function saveNotebook(store, config) {
  return writeJsonAtomic(notebookConfig(config).path, store, {backup: true});
}

// Drops expired entries. Called on load so the model never sees a stale note.
export function liveEntries(store, now = new Date()) {
  return (store.entries ?? []).filter(e => e.expiresAt && new Date(e.expiresAt) > now);
}

// Applies the allocator's notes. A new note on a symbol replaces the old one:
// the agent's latest view is the one it holds. Empty notes clear the entry.
export function applyNotes(store, notes, config, now = new Date()) {
  const cfg = notebookConfig(config);
  const byKey = new Map(liveEntries(store, now).map(e => [e.symbol, e]));
  for (const n of notes ?? []) {
    if (!n?.symbol) continue;
    const text = sanitizeUntrusted(n.note, {maxLength: 240});
    if (!text) { byKey.delete(n.symbol); continue; }
    byKey.set(n.symbol, {
      symbol: n.symbol, note: text,
      kind: n.kind === 'holding' ? 'holding' : 'watch',
      at: now.toISOString(),
      expiresAt: new Date(now.getTime() + cfg.ttlDays * 86400_000).toISOString(),
    });
  }
  const entries = [...byKey.values()].sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, cfg.maxEntries);
  return {...store, schemaVersion: 1, entries};
}

// Pulls the notes out of an allocator review. WATCH candidates with a
// watchFor become watch entries; holdings with a note become holding entries;
// a PREPARE or CLOSE clears any note on that name, since it has resolved.
export function notesFromReview(review) {
  const out = [];
  for (const c of review.candidates ?? []) {
    if (c.verdict === 'WATCH' && c.watchFor) out.push({symbol: c.symbol, note: c.watchFor, kind: 'watch'});
    else if (c.verdict === 'PREPARE' || c.verdict === 'REJECT') out.push({symbol: c.symbol, note: null});
  }
  for (const h of review.holdings ?? []) {
    if (h.action === 'CLOSE') out.push({symbol: h.symbol, note: null});
    else if (h.note) out.push({symbol: h.symbol, note: h.note, kind: 'holding'});
  }
  return out;
}
