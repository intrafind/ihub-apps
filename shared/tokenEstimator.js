// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Shared token estimation utility.
 *
 * Uses gpt-tokenizer (o200k_base / GPT-4o BPE) to estimate token counts for
 * text. This is a cross-provider approximation: it is accurate for OpenAI
 * models and a good estimate for Anthropic / Google / Mistral (typically
 * within ~10-20%). The authoritative count for any turn is always the
 * provider-reported usage (promptTokens / completionTokens), which the chat
 * pipeline reconciles against after each response.
 *
 * The server (usageTracker, RequestBuilder) imports this helper. The client
 * uses its own tokenEstimatorClient.js which dynamically imports gpt-tokenizer.
 *
 * gpt-tokenizer is a dependency of the server (`server/package.json`). It is
 * still loaded defensively so the server can start even when the package is
 * missing from a deployment (falls back to a chars/4 heuristic).
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

/** Chars/4 fallback when the real tokenizer is unavailable. */
function heuristic(text) {
  return Math.ceil(text.length / 4);
}

let countTokensFn = null;

// Attempt to load gpt-tokenizer synchronously using createRequire. The server
// declares the package, and it lives in the server's node_modules: next to this
// file's own location Node looks only at the repository (or `dist/`) root, so
// the server directory is tried as well. A development checkout and the Docker
// image keep the package under `server/node_modules`, the single-binary build
// at the root; one of the two finds it. If neither does (e.g. a deployment
// that left it out), we silently fall back to the heuristic.
const SEARCH_FROM = [import.meta.url, new URL('../server/package.json', import.meta.url).href];
for (const base of SEARCH_FROM) {
  try {
    const mod = createRequire(base)('gpt-tokenizer');
    countTokensFn = mod.countTokens || mod.default?.countTokens || null;
    if (countTokensFn) break;
  } catch {
    // Not found from here — try the next place, then the heuristic
  }
}

/**
 * Texts longer than this are not tokenized whole: the BPE count is synchronous
 * and linear (about 7 ms per 100 KB of prose, 15x that for a long run without
 * whitespace), so a 4 MB attachment would hold the event loop for ~0.5 s and a
 * 1 MB run of one character for ~1.5 s. Above the limit the count is taken
 * from evenly spaced samples and scaled to the length (see `sampledCount`).
 */
export const FULL_COUNT_MAX_CHARS = 256 * 1024;
const SAMPLE_COUNT = 16;
const SAMPLE_CHARS = 4 * 1024;

/**
 * Count a long text from `SAMPLE_COUNT` slices spread over it (64 KB in all,
 * about 5 ms) and scale to the whole length. Measured within 7% of the full
 * count on 1 MB of English, German, JSON, code, CJK, base64 and mixed text
 * (worst case: English docs with tables and code, +6.4%); chars/4 is off by
 * up to 100% on the same texts.
 */
function sampledCount(text, count) {
  const last = text.length - SAMPLE_CHARS;
  let tokens = 0;
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    const start = Math.floor((last * i) / (SAMPLE_COUNT - 1));
    tokens += count(text.slice(start, start + SAMPLE_CHARS));
  }
  return Math.round((tokens * text.length) / (SAMPLE_COUNT * SAMPLE_CHARS));
}

/**
 * How much text went through the tokenizer in this process: `calls` counts and
 * `chars` characters (of a sampled count, the samples only). A diagnostic, and
 * what tests watch to prove a text was not counted again.
 */
export const tokenizerStats = { calls: 0, chars: 0 };

function tokenize(text) {
  tokenizerStats.calls += 1;
  tokenizerStats.chars += text.length;
  return countTokensFn(text);
}

/**
 * Count a text: in full up to `FULL_COUNT_MAX_CHARS`, sampled above.
 * @param {string} text - non-empty
 */
function countText(text) {
  try {
    if (countTokensFn && text.length > FULL_COUNT_MAX_CHARS) return sampledCount(text, tokenize);
    return countTokensFn ? tokenize(text) : heuristic(text);
  } catch {
    // Fall back to the classic chars/4 heuristic if the tokenizer throws
    // (e.g. on unusual input). Better an approximate number than a crash.
    return heuristic(text);
  }
}

const HASH_MEMO_MAX_ENTRIES = 512;
const hashMemo = new Map();

/**
 * The count of a long text, remembered by a hash of it: a project's knowledge
 * block or a long system prompt is sent with every turn as a new string with
 * the same content, and hashing it costs a fraction of counting it (SHA-1 runs
 * at about 1 GB/s; the count at 5-11 MB/s). Only the number is kept, for at
 * most `HASH_MEMO_MAX_ENTRIES` texts, the least recently used first out.
 */
function hashMemoCount(text) {
  const key = createHash('sha1').update(text).digest('base64');
  const hit = hashMemo.get(key);
  if (hit !== undefined) {
    hashMemo.delete(key);
    hashMemo.set(key, hit);
    return hit;
  }
  const tokens = countText(text);
  hashMemo.set(key, tokens);
  if (hashMemo.size > HASH_MEMO_MAX_ENTRIES) hashMemo.delete(hashMemo.keys().next().value);
  return tokens;
}

/**
 * Estimate the number of tokens in a piece of text.
 * @param {string} text
 * @returns {number} estimated token count (0 for empty/invalid input). Exact
 *   for texts up to `FULL_COUNT_MAX_CHARS`, sampled above. A text longer than
 *   `MEMO_MAX_CHARS` is counted once per process and then found by its hash.
 */
export function estimateTokens(text) {
  if (!text || typeof text !== 'string') return 0;
  if (countTokensFn && text.length > MEMO_MAX_CHARS) return hashMemoCount(text);
  return countText(text);
}

/**
 * A count from samples, whatever the length, never remembered: for a text
 * built once to be counted once (a whole transcript joined), where the hash
 * of {@link estimateTokens} would cost as much as the samples.
 * @param {string} text
 * @returns {number}
 */
export function estimateTokensSampled(text) {
  if (!text || typeof text !== 'string') return 0;
  if (!countTokensFn || text.length <= SAMPLE_COUNT * SAMPLE_CHARS) return countText(text);
  try {
    return sampledCount(text, tokenize);
  } catch {
    return heuristic(text);
  }
}

/**
 * Which method {@link estimateTokens} counts with: `o200k_base` when
 * gpt-tokenizer is installed, `heuristic` (about 4 characters per token, a rough
 * approximation that can be off in either direction) when it is not. For callers that show
 * the figure to a person and should say how it was made.
 * @returns {{method: 'o200k_base'|'heuristic'}}
 */
export function tokenizerInfo() {
  return { method: countTokensFn ? 'o200k_base' : 'heuristic' };
}

const MEMO_MIN_CHARS = 256;
const MEMO_MAX_CHARS = 128 * 1024;
const MEMO_BUDGET_CHARS = 2 * 1024 * 1024;
const memo = new Map();
let memoChars = 0;

/**
 * `estimateTokens(text)` remembered by content, for texts that are counted
 * again and again without belonging to an object: a tool definition, a skill
 * body or catalog, a document-list line. Hashing an equal string costs about
 * a twentieth of counting it. Only texts of 256 characters to 128 KB are kept
 * (shorter ones are as cheap to count; longer ones are remembered by their
 * hash in `estimateTokens` itself), and the whole memo holds at most 2 M
 * characters, the oldest first out.
 * @param {string} text
 * @returns {number}
 */
export function estimateTokensMemo(text) {
  if (typeof text !== 'string' || text.length < MEMO_MIN_CHARS || text.length > MEMO_MAX_CHARS) {
    return estimateTokens(text);
  }
  const hit = memo.get(text);
  if (hit !== undefined) {
    memo.delete(text);
    memo.set(text, hit);
    return hit;
  }
  const tokens = estimateTokens(text);
  memo.set(text, tokens);
  memoChars += text.length;
  for (const [oldest] of memo) {
    if (memoChars <= MEMO_BUDGET_CHARS) break;
    memo.delete(oldest);
    memoChars -= oldest.length;
  }
  return tokens;
}

const counted = new WeakMap();

/**
 * `estimateTokens(text)` remembered on `owner` (a message, a document record):
 * a text that was counted for the same object is not counted again, which is
 * what an agent loop does with its transcript after every step. The remembered
 * figure is used only while the text is still the same string content, so an
 * edited message is counted afresh. Nothing is retained beyond the owner's
 * life (WeakMap), and the text is not copied.
 * @param {object} owner
 * @param {string} text
 * @param {(text: string) => number} [count] - how to count it on a miss
 *   (e.g. {@link estimateTokensWithKnown} for a message with stored counts)
 * @returns {number}
 */
export function estimateTokensFor(owner, text, count = estimateTokens) {
  if (!owner || typeof owner !== 'object') return count(text);
  const hit = counted.get(owner);
  if (hit && hit.text === text) return hit.tokens;
  const tokens = count(text);
  if (typeof text === 'string' && text.length > 0) counted.set(owner, { text, tokens });
  return tokens;
}

const knownParts = new WeakMap();

/**
 * Note on `owner` (a prompt message) which pieces of its text were counted
 * when they were stored: an attachment's extracted text, a project document.
 * The note is not part of the message, so it never reaches a provider; a copy
 * of the message does not carry it (see {@link copyKnownTokenParts}).
 * @param {object} owner
 * @param {Array<{text: string, tokens: number}>} parts
 */
export function setKnownTokenParts(owner, parts) {
  if (!owner || typeof owner !== 'object' || !Array.isArray(parts)) return;
  const valid = parts.filter(
    part => typeof part?.text === 'string' && part.text && Number.isFinite(part.tokens)
  );
  if (valid.length) knownParts.set(owner, valid);
}

/**
 * The stored counts noted on `owner`, or null.
 * @param {object} owner
 * @returns {Array<{text: string, tokens: number}>|null}
 */
export function knownTokenParts(owner) {
  return (owner && typeof owner === 'object' && knownParts.get(owner)) || null;
}

/** Carry the stored counts of `from` over to its copy `to`. */
export function copyKnownTokenParts(from, to) {
  const parts = knownTokenParts(from);
  if (parts && to && typeof to === 'object') knownParts.set(to, parts);
}

/**
 * Count `text` with the stored counts of the pieces it contains: each piece
 * found in it adds its stored number and is cut out, and only what is left
 * (the question, the framing around the pieces) goes to `count`. A piece that
 * is not in the text (it was edited on the way) adds nothing; its text, if any,
 * is counted with the rest.
 * @param {string} text
 * @param {Array<{text: string, tokens: number}>|null} parts
 * @param {(text: string) => number} [count]
 * @returns {number}
 */
export function estimateTokensWithKnown(text, parts, count = estimateTokens) {
  if (typeof text !== 'string' || !text) return 0;
  if (!parts?.length) return count(text);
  // The pieces come in the order the text holds them: one pass with a cursor
  // keeps the text between them, joined once. A piece not found after the
  // cursor (out of order) is looked for in what is left afterwards.
  let known = 0;
  let from = 0;
  const kept = [];
  const missed = [];
  for (const part of parts) {
    const at = text.indexOf(part.text, from);
    if (at === -1) {
      missed.push(part);
      continue;
    }
    known += part.tokens;
    kept.push(text.slice(from, at));
    from = at + part.text.length;
  }
  kept.push(text.slice(from));
  let rest = kept.join('');
  for (const part of missed) {
    const at = rest.indexOf(part.text);
    if (at === -1) continue;
    known += part.tokens;
    rest = rest.slice(0, at) + rest.slice(at + part.text.length);
  }
  return known + count(rest);
}

/**
 * Estimate tokens across multiple text fragments (system prompt, sources,
 * history, new message, file content, ...). Non-string entries are ignored.
 * @param {Array<string>} fragments
 * @returns {number} total estimated token count
 */
export function estimateTokensForFragments(fragments = []) {
  if (!Array.isArray(fragments)) return 0;
  return fragments.reduce((sum, fragment) => sum + estimateTokens(fragment), 0);
}

// Re-exported from the dependency-free helper so existing server/test imports
// (`import { computeContextUsage } from 'shared/tokenEstimator.js'`) keep working.

export { computeContextUsage } from './contextUsage.js';
