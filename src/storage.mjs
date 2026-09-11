import {readFile, writeFile, rename, mkdir, unlink} from 'node:fs/promises';
import path from 'node:path';

// Every state file the bot depends on goes through here.
//
// Two rules, both learned the hard way by other people:
//
//   1. Writes are atomic. A crash or kill mid-write used to leave a truncated
//      JSON file on disk. Write to a sibling temp file, then rename over the
//      target; rename is atomic on POSIX and on NTFS, so the file on disk is
//      always either the old version or the new one, never half of each.
//
//   2. A corrupt file is a halt, not a blank slate. loadPositions() used to
//      return "no positions" on any read error, and readLedger() returned an
//      empty ledger. That is the worst possible default for a bot holding
//      money: an empty ledger has a WETH baseline of zero, so the next
//      treasury tick treats the whole wallet as fresh fee proceeds and buys
//      half of it into $ZZY, permanently. A missing file (ENOENT) is a fresh
//      start and gets the default. Anything else throws, and the operator
//      restores from backup.

export async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function readJsonOrDefault(file, fallback) {
  let raw;
  try { raw = await readFile(file, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') return typeof fallback === 'function' ? fallback() : structuredClone(fallback);
    throw e;
  }
  try { return JSON.parse(raw); }
  catch (e) {
    throw new Error(`${file} exists but is not valid JSON (${e.message}). Refusing to continue with a blank default; restore it from ${file}.bak or a backup.`);
  }
}

export async function writeJsonAtomic(file, data, {pretty = true, backup = false} = {}) {
  const dir = path.dirname(file);
  await mkdir(dir, {recursive: true});
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  const text = pretty ? `${JSON.stringify(data, null, 2)}\n` : `${JSON.stringify(data)}\n`;
  try {
    await writeFile(tmp, text, {mode: 0o600});
    if (backup) {
      try { await rename(file, `${file}.bak`); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    await rename(tmp, file);
  } catch (e) {
    try { await unlink(tmp); } catch { /* already gone */ }
    throw e;
  }
  return file;
}
