// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The numbers of a website corpus: tokens per page and per section, how many
 * context windows the corpus fills, what line-level deduplication saves, and
 * which pages are duplicates of each other.
 *
 * Pure: pages in, numbers out. Token counting is injected (`countTokens`), so
 * the caller decides which estimator counts and says so in the report.
 *
 * @module services/websiteCorpus/stats
 */
import { sectionOf } from './urls.js';

/** Context windows the report compares with. 128k, 256k and 1M are binary sizes. */
export const WINDOWS = Object.freeze([
  { label: '128k', size: 131_072 },
  { label: '256k', size: 262_144 },
  { label: '1M', size: 1_048_576 }
]);

/** A page with less main text than this is thin. */
export const THIN_CHARS = 300;

/** A line of at least this many characters is counted only on the first page that has it. */
export const DEDUP_MIN_LINE = 40;

/** Sections treated as news-like for the "core pages" rows, unless the caller names others. */
export const DEFAULT_NEWS_SECTIONS = Object.freeze([
  'blog',
  'news',
  'newsroom',
  'aktuelles',
  'presse',
  'press',
  'magazin',
  'magazine',
  'neuigkeiten'
]);

/** Near-duplicate detection: pages of at least this many characters, similarity at least this. */
const NEAR_DUP_MIN_CHARS = 300;
const NEAR_DUP_THRESHOLD = 0.8;
/** MinHash signature length, the estimate that selects candidates, and the words read per page. */
const SIGNATURE_SIZE = 64;
const CANDIDATE_ESTIMATE = 0.6;
const NEAR_DUP_MAX_WORDS = 5000;
/** Most near-duplicate pairs reported. */
const MAX_NEAR_DUP_PAIRS = 25;
/** Most shingle sets of the inner pages held at once while candidate pairs are confirmed. */
const SHINGLE_CACHE_SIZE = 200;
/**
 * Most candidate pairs confirmed on the real shingle sets. A site of near-identical
 * pages has every pair as a candidate (300 such pages are 44,850 pairs, about a
 * minute of work); the comparison stops here and the result says so.
 */
export const MAX_NEAR_DUP_VERIFICATIONS = 3000;

const yieldToEventLoop = () => new Promise(resolve => setImmediate(resolve));

/**
 * The text of a page without the lines an earlier page already had: a line of
 * `DEDUP_MIN_LINE` characters or more is kept only the first time it appears.
 * `seen` is shared across the pages in order.
 */
function dedupText(text, seen) {
  const kept = [];
  for (const line of text.split('\n')) {
    if (line.length >= DEDUP_MIN_LINE) {
      if (seen.has(line)) continue;
      seen.add(line);
    }
    kept.push(line);
  }
  return kept.join('\n');
}

/** Whole numbers a few percent of a total, for display; `null` when there is no total. */
export function percent(part, whole, digits = 1) {
  return whole ? Number(((100 * part) / whole).toFixed(digits)) : null;
}

/**
 * Tokens per page and the totals of a corpus.
 *
 * @param {Array<{url: string, text: string, chars?: number, tokens?: number}>} pages - In sitemap order
 * @param {Object} options
 * @param {(text: string) => number} options.countTokens
 * @param {string} [options.prefix] - The scope prefix, to name sections
 * @param {string[]} [options.newsSections] - Section names left out of the core pages
 * @returns {Promise<Object>} `{ rows, sections, totals, core, newsFound, exactDuplicates }`
 */
export async function analyseCorpus(
  pages,
  { countTokens, prefix = '', newsSections = DEFAULT_NEWS_SECTIONS }
) {
  const segmentCounts = new Map();
  for (const page of pages) {
    const segment = sectionOf(page.url, prefix);
    segmentCounts.set(segment, (segmentCounts.get(segment) || 0) + 1);
  }

  const seen = new Set();
  const rows = [];
  for (const [index, page] of pages.entries()) {
    let section = sectionOf(page.url, prefix);
    // A segment with a single page is grouped; the root page stays `home`.
    if (section !== 'home' && segmentCounts.get(section) === 1) section = 'top-level pages';
    const chars = page.chars ?? page.text.length;
    const tokens = page.tokens ?? countTokens(page.text);
    const deduped = dedupText(page.text, seen);
    rows.push({
      url: page.url,
      title: page.title || '',
      section,
      chars,
      tokens,
      tokensDedup: deduped === page.text ? tokens : countTokens(deduped),
      thin: chars < THIN_CHARS
    });
    if (index % 25 === 24) await yieldToEventLoop();
  }

  const sum = (list, key) => list.reduce((total, row) => total + row[key], 0);
  const summarize = list => ({
    pages: list.length,
    thin: list.filter(row => row.thin).length,
    chars: sum(list, 'chars'),
    tokens: sum(list, 'tokens'),
    tokensDedup: sum(list, 'tokensDedup')
  });

  const bySection = new Map();
  for (const row of rows) {
    if (!bySection.has(row.section)) bySection.set(row.section, []);
    bySection.get(row.section).push(row);
  }
  const sections = [...bySection]
    .map(([section, list]) => ({ section, ...summarize(list) }))
    .sort((a, b) => b.tokens - a.tokens || a.section.localeCompare(b.section));

  const news = new Set((newsSections || []).map(name => String(name).trim().toLowerCase()));
  const newsFound = sections.map(entry => entry.section).filter(name => news.has(name));
  const coreRows = rows.filter(row => !news.has(row.section));

  // Exact duplicates: the same text under different URLs.
  const byText = new Map();
  for (const page of pages) {
    if (!byText.has(page.text)) byText.set(page.text, []);
    byText.get(page.text).push(page.url);
  }
  const tokensOf = new Map(rows.map(row => [row.url, row.tokens]));
  const exactDuplicates = [...byText.values()]
    .filter(urls => urls.length > 1)
    .map(urls => ({
      urls,
      extraTokens: (urls.length - 1) * (tokensOf.get(urls[0]) || 0)
    }));

  return {
    rows,
    sections,
    totals: summarize(rows),
    core: summarize(coreRows),
    newsFound,
    exactDuplicates
  };
}

/** For a list of tokens the windows they fill: `{label, size, ratio, windows}`. */
export function windowFit(tokens) {
  return WINDOWS.map(({ label, size }) => ({
    label,
    size,
    ratio: tokens / size,
    windows: Math.max(1, Math.ceil(tokens / size)),
    fits: tokens <= size
  }));
}

// ---- near-duplicate pages ---------------------------------------------------

/** 32-bit FNV-1a of a string. */
function fnv(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Hashes of the word 5-grams of a text. */
function shingleHashes(text) {
  const words = (text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) || []).slice(0, NEAR_DUP_MAX_WORDS);
  const hashes = new Set();
  const size = 5;
  for (let i = 0; i < Math.max(1, words.length - size + 1); i++) {
    hashes.add(fnv(words.slice(i, i + size).join(' ')));
  }
  return hashes;
}

// Fixed odd multipliers and offsets: the same signature for the same text, every run.
const MULTIPLIERS = Array.from({ length: SIGNATURE_SIZE }, (_v, i) => (fnv(`a${i}`) | 1) >>> 0);
const OFFSETS = Array.from({ length: SIGNATURE_SIZE }, (_v, i) => fnv(`b${i}`));

function signatureOf(hashes) {
  const signature = new Uint32Array(SIGNATURE_SIZE).fill(0xffffffff);
  for (const hash of hashes) {
    for (let i = 0; i < SIGNATURE_SIZE; i++) {
      const value = (Math.imul(hash, MULTIPLIERS[i]) + OFFSETS[i]) >>> 0;
      if (value < signature[i]) signature[i] = value;
    }
  }
  return signature;
}

function jaccard(a, b) {
  let shared = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const hash of small) if (large.has(hash)) shared += 1;
  const union = a.size + b.size - shared;
  return union ? shared / union : 0;
}

/**
 * Pairs of pages whose word 5-grams overlap by 0.8 or more (Jaccard), for pages
 * of 300 characters or more with different text.
 *
 * A MinHash signature per page selects the candidate pairs, and each candidate
 * is then confirmed on the real shingle sets, so the pairs reported are exact.
 * At most `MAX_NEAR_DUP_VERIFICATIONS` candidates are confirmed; a site that
 * is mostly near-identical pages reaches that, and `truncated` is then true:
 * the pairs found are real, but there may be more.
 *
 * @param {Array<{url: string, text: string}>} pages
 * @returns {Promise<{total: number, pairs: Array<{similarity: number, urls: [string, string]}>, truncated: boolean, verified: number}>}
 *   The number of pairs found, the most similar ones (at most 25, most similar first),
 *   whether the comparison stopped early, and how many candidate pairs were confirmed
 */
export async function findNearDuplicates(pages) {
  const eligible = pages.filter(page => page.text.length >= NEAR_DUP_MIN_CHARS);
  const signatures = [];
  for (const [index, page] of eligible.entries()) {
    signatures.push(signatureOf(shingleHashes(page.text)));
    if (index % 25 === 24) await yieldToEventLoop();
  }
  const pairs = [];
  // The outer page's shingle set is built once for all its pairs; the inner pages' sets are
  // kept in a small cache, the oldest dropped first, so a template-heavy site cannot hold
  // every set at once.
  const inner = new Map();
  const innerSet = index => {
    let set = inner.get(index);
    if (!set) {
      if (inner.size >= SHINGLE_CACHE_SIZE) inner.delete(inner.keys().next().value);
      set = shingleHashes(eligible[index].text);
      inner.set(index, set);
    }
    return set;
  };
  let verified = 0;
  let truncated = false;
  outer: for (let i = 0; i < eligible.length; i++) {
    let outerSet = null;
    for (let j = i + 1; j < eligible.length; j++) {
      let equal = 0;
      for (let k = 0; k < SIGNATURE_SIZE; k++)
        if (signatures[i][k] === signatures[j][k]) equal += 1;
      if (equal / SIGNATURE_SIZE < CANDIDATE_ESTIMATE) continue;
      if (eligible[i].text === eligible[j].text) continue;
      if (verified >= MAX_NEAR_DUP_VERIFICATIONS) {
        truncated = true;
        break outer;
      }
      outerSet ??= shingleHashes(eligible[i].text);
      const similarity = jaccard(outerSet, innerSet(j));
      if (++verified % 50 === 0) await yieldToEventLoop();
      if (similarity >= NEAR_DUP_THRESHOLD) {
        pairs.push({
          similarity: Number(similarity.toFixed(2)),
          urls: [eligible[i].url, eligible[j].url]
        });
      }
    }
    if (i % 10 === 9) await yieldToEventLoop();
  }
  pairs.sort((a, b) => b.similarity - a.similarity);
  return {
    total: pairs.length,
    pairs: pairs.slice(0, MAX_NEAR_DUP_PAIRS),
    truncated,
    verified
  };
}
