import {readdir, unlink} from 'node:fs/promises';
import path from 'node:path';
import {writeJsonAtomic} from './storage.mjs';

// The public decision log. One file per name per review, written by the
// engine straight after the allocator answers, so the dashboard shows every
// call the agent made: the holds and the passes as well as the buys and the
// rotations. This is what "Decision log" on the site reads.
//
// Nothing here is a fill. A PREPARE is an intention; the buy that follows,
// if any, is recorded separately from a settled receipt. Keeping them apart
// is what lets the site say "reviewed 191 names, acted on two" honestly.

const KEEP = 500;

export async function recordReview(review, {now = new Date(), dir = 'decisions', mode = 'preview', sample = false} = {}) {
  const at = now.toISOString();
  const stamp = at.replace(/[:.]/g, '-');
  const files = [];

  for (const h of review.holdings ?? []) {
    const file = path.join(dir, `${stamp}-${h.symbol}-review.json`);
    await writeJsonAtomic(file, {
      generatedAt: at, mode, sample,
      asset: {symbol: h.symbol},
      decision: h.action,                       // HOLD | TRIM | CLOSE
      decisionSource: h.source ?? 'allocator',
      replacedBy: h.replacedBy ?? null,
      targetWeightPercent: h.targetWeightPercent ?? null,
      rationale: h.replacedBy && h.replacedBy !== 'cash' ? `${h.reason} Capital to ${h.replacedBy}.` : h.reason ?? '',
    });
    files.push(file);
  }
  for (const c of review.candidates ?? []) {
    const file = path.join(dir, `${stamp}-${c.symbol}.json`);
    await writeJsonAtomic(file, {
      generatedAt: at, mode, sample,
      asset: {symbol: c.symbol},
      decision: c.verdict,                      // PREPARE | WATCH | REJECT
      decisionSource: 'allocator',
      confidence: c.confidence ?? null,
      targetWeightPercent: c.targetWeightPercent ?? null,
      rationale: c.rationale || c.reason || '',
      downsideCase: c.downsideCase ?? null,
      falsifier: c.falsifier ?? null,
      sources: c.sources ?? [],
    });
    files.push(file);
  }
  if (review.summary) {
    const file = path.join(dir, `${stamp}-review-summary.json`);
    await writeJsonAtomic(file, {generatedAt: at, mode, sample, asset: {symbol: 'BOOK'}, decision: 'REVIEW', decisionSource: 'allocator', rationale: review.summary});
    files.push(file);
  }
  await prune(dir);
  return files;
}

async function prune(dir) {
  let names;
  try { names = (await readdir(dir)).filter(f => f.endsWith('.json')).sort(); } catch { return; }
  for (const f of names.slice(0, Math.max(0, names.length - KEEP))) { try { await unlink(path.join(dir, f)); } catch {} }
}
