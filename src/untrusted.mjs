// Headlines, filing titles and article text are written by strangers. They
// reach a model that then decides what this bot buys, so they are hostile
// input, not facts. Anyone who can get a sentence into a news feed for a
// ticker in the catalog can put text in front of the decision engine.
//
// This does not try to detect malicious intent, which is a losing game. It
// removes the mechanical tricks that make injection cheap, and the caller
// fences the result so the model is told plainly that it is quoted data.
//
// The real defences remain structural and live elsewhere: the model can only
// return a symbol from the candidate list, only three verdicts, sizing is the
// engine's, and the signer refuses anything outside the allowlist. Injection
// can at worst argue for a bad buy of a legitimate token inside the risk caps.
// It cannot introduce an asset, raise a limit, or move funds.

// Invisible and direction-changing characters. These let text read one way to
// a human reviewing a feed and another way to a tokenizer: zero-width joiners,
// bidi overrides, soft hyphens, the Unicode tag block used to smuggle hidden
// ASCII.
// Note the braces on the tag block: \uE0000 without them parses as \uE000
// followed by a literal 0, which silently turns the class into a range
// covering most printable text. Written the wrong way, this deleted every
// headline it touched.
const INVISIBLE = /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}]/gu;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

// Fake conversation structure. A headline containing a line that looks like a
// new turn or a system block is trying to end the quoted region early.
const TURN_MARKERS = /^\s*(system|assistant|human|user|developer)\s*:/gim;
const TAGS = /<\/?\s*(system|assistant|human|user|instructions?|prompt)[^>]*>/gi;
const FENCE = /```+/g;

export const MAX_FIELD = 300;

export function sanitizeUntrusted(value, {maxLength = MAX_FIELD} = {}) {
  if (typeof value !== 'string') return null;
  let s = value.normalize('NFKC').replace(INVISIBLE, '').replace(CONTROL, ' ');
  s = s.replace(TAGS, ' ').replace(TURN_MARKERS, (m) => m.replace(':', ' ')).replace(FENCE, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > maxLength) s = s.slice(0, maxLength - 1) + '\u2026';
  return s || null;
}

// A URL is only useful to the model if it can be opened, and only safe if it
// cannot smuggle a payload or point at something local. Anything not plainly
// https is dropped rather than repaired.
export function sanitizeUrl(value) {
  if (typeof value !== 'string') return null;
  let u;
  try { u = new URL(value.trim()); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) return null;
  // Literal IPs, including the cloud metadata address, are never a news source.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) return null;
  u.hash = '';
  return u.toString().slice(0, 400);
}

// Applied to every headline before it is serialised into the prompt.
export function sanitizeHeadline(h) {
  const title = sanitizeUntrusted(h?.title);
  if (!title) return null;
  return {
    title,
    source: sanitizeUntrusted(h?.source, {maxLength: 80}),
    at: typeof h?.at === 'string' ? h.at.slice(0, 40) : null,
    url: sanitizeUrl(h?.url),
  };
}

export function sanitizeFiling(e) {
  const form = sanitizeUntrusted(e?.form, {maxLength: 20});
  if (!form) return null;
  return {form, at: typeof e?.at === 'string' ? e.at.slice(0, 40) : null, url: sanitizeUrl(e?.url)};
}
