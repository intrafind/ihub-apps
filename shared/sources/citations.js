/**
 * Which of an answer's sources its text cites, and where.
 *
 * A citation is anything in the answer that points at one of the answer's
 * sources, whatever scheme the producer uses:
 *
 *  - a Markdown link or a bare URL to a source's `url` — conventionally
 *    `[n](url)`: the research guidance asks script-backed web search to cite
 *    so, OpenAI writes such links itself, the Anthropic and Google converters
 *    append or insert them ({@link citationMarkers}, {@link insertSupportMarkers}),
 *    and answers researched with the iFinder tools link each document's deep link;
 *  - a provider marker naming a source or passage — iAssistant's
 *    `<cite type="r">3</cite>` (the third result document) and
 *    `<cite type="s">7</cite>` (passage 7), matched to the sources and
 *    passages carrying `markers` `r:3` / `s:7`.
 *
 * The number the text writes does not matter: sources are numbered in the
 * order the answer first cites them, which is what the badge shows, so a
 * model that numbers wrongly or restarts at 1 still renders correctly. A link
 * to a URL none of the answer's sources has is left an ordinary link.
 *
 * Pure functions only, no DOM and no Node APIs, so both sides import it.
 *
 * @module shared/sources/citations
 */
import { httpUrl, markdownLinkUrl, urlKey } from './url.js';

/** A document id shorter than this is too likely to occur in the text by chance. */
const MIN_CITED_ID_CHARS = 6;

/** Fenced and inline code: links in there are code, not citations. */
function withoutCode(markdown) {
  return String(markdown || '')
    .replace(/```[\s\S]*?(```|$)/g, match => ' '.repeat(match.length))
    .replace(/~~~[\s\S]*?(~~~|$)/g, match => ' '.repeat(match.length))
    .replace(/`[^`\n]*`/g, match => ' '.repeat(match.length));
}

const LINK =
  /(!?)\[((?:[^[\]]|\[[^\]]*\])*)\]\(\s*<?([^()\s<>]+(?:\([^()\s]*\)[^()\s<>]*)*)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
const BARE_URL = /<?(https?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]])>?/g;
const CITE_TAG = /<cite\s+type="([rs])"\s*>\s*(\d+)\s*<\/cite>/gi;

/**
 * The marker a `<cite>` tag stands for.
 *
 * @param {string} type - `r` (result document) or `s` (source passage)
 * @param {string|number} num
 * @returns {string} e.g. `r:3`
 */
export function citeMarker(type, num) {
  return `${String(type).toLowerCase()}:${Number(num)}`;
}

/**
 * Every citation candidate in a Markdown text, in order: `[text](url)` links
 * first claim their span, then `<cite>` markers, autolinks and bare URLs in
 * what remains.
 *
 * @param {string} markdown
 * @returns {Array<{url: string}|{marker: string}>}
 */
export function citationRefs(markdown) {
  const found = [];
  let rest = withoutCode(markdown).replace(LINK, (match, bang, _label, url, offset) => {
    if (!bang) found.push({ offset, ref: { url } });
    return ' '.repeat(match.length);
  });
  rest = rest.replace(CITE_TAG, (match, type, num, offset) => {
    found.push({ offset, ref: { marker: citeMarker(type, num) } });
    return ' '.repeat(match.length);
  });
  for (const match of rest.matchAll(BARE_URL)) {
    found.push({ offset: match.index, ref: { url: match[1] } });
  }
  return found.sort((a, b) => a.offset - b.offset).map(entry => entry.ref);
}

/**
 * Every link target in a Markdown text, in order.
 *
 * @param {string} markdown
 * @returns {string[]}
 */
export function linkTargets(markdown) {
  return citationRefs(markdown)
    .filter(ref => ref.url)
    .map(ref => ref.url);
}

/** Characters that continue an id or a URL, so a match inside a longer one is not a match. */
const TOKEN_CHAR = /[A-Za-z0-9_\-.~%/]/;

/**
 * Whether a token ends at `index`: the next character cannot continue an id or URL (a trailing
 * period ends a sentence).
 */
function endsTokenAt(value, index) {
  const next = value[index] || '';
  if (next === '.') return !TOKEN_CHAR.test(value[index + 1] || '');
  return !TOKEN_CHAR.test(next);
}

/** Whether `token` occurs in `value` as a whole token, not inside a longer id or URL. */
function containsToken(value, token) {
  let from = 0;
  for (;;) {
    const at = value.indexOf(token, from);
    if (at < 0) return false;
    const before = at > 0 ? value[at - 1] : '';
    if (!TOKEN_CHAR.test(before) && endsTokenAt(value, at + token.length)) return true;
    from = at + 1;
  }
}

/**
 * Which of an answer's sources its text cites, numbered in the order it first
 * cites them, and which it only considered.
 *
 * Besides links and markers, a document counts as cited when its id appears
 * in the text (the iFinder answer rules put it in each link's title), and a
 * source its provider reports as cited (`cited`: Anthropic `citations`, the
 * Google grounding chunks a support rests on, OpenAI `url_citation`s) counts
 * even when the text points at it nowhere. Both are numbered after the ones
 * the text points at.
 *
 * @param {string} markdown - the answer
 * @param {{items?: Array}|null} set - the answer's source set
 * @returns {{cited: Array<Object>, considered: Array<Object>, numbers: Map<string, number>,
 *   numberOfUrl: (url: string) => number|null, numberOfMarker: (marker: string) => number|null}}
 *   `cited` entries carry their number as `n`; `numbers` maps a source id to it
 */
export function resolveCitations(markdown, set) {
  const items = Array.isArray(set?.items) ? set.items : [];
  const byUrl = new Map();
  const byMarker = new Map();
  for (const source of items) {
    const key = source?.url ? urlKey(source.url) : null;
    if (key && !byUrl.has(key)) byUrl.set(key, source);
    for (const marker of source?.markers || []) {
      if (!byMarker.has(marker)) byMarker.set(marker, source);
    }
    for (const passage of source?.passages || []) {
      if (passage.marker && !byMarker.has(passage.marker)) byMarker.set(passage.marker, source);
    }
  }

  const numbers = new Map();
  const cited = [];
  const cite = source => {
    if (!source || numbers.has(source.id)) return;
    numbers.set(source.id, cited.length + 1);
    cited.push({ ...source, n: cited.length + 1 });
  };
  for (const ref of citationRefs(markdown)) {
    cite(ref.url ? byUrl.get(urlKey(ref.url)) : byMarker.get(ref.marker));
  }
  const text = withoutCode(markdown);
  for (const source of items) {
    const id = source?.ref?.id;
    if (typeof id === 'string' && id.length >= MIN_CITED_ID_CHARS && containsToken(text, id)) {
      cite(source);
    }
  }
  for (const source of items) {
    if (source?.cited) cite(source);
  }
  const considered = items.filter(source => source && !numbers.has(source.id));

  return {
    cited,
    considered,
    numbers,
    numberOfUrl: url => {
      const source = byUrl.get(urlKey(url));
      return source ? (numbers.get(source.id) ?? null) : null;
    },
    numberOfMarker: marker => {
      const source = byMarker.get(marker);
      return source ? (numbers.get(source.id) ?? null) : null;
    }
  };
}

/**
 * Citation markers for a set of URLs, numbered through `numbers` (URL key →
 * n, extended as new URLs appear), e.g. `[1](https://a.example/)[2](…)`.
 *
 * @param {string[]} urls
 * @param {Map<string, number>} numbers - shared across the calls of one answer
 * @returns {string} '' when no URL is usable
 */
export function citationMarkers(urls, numbers) {
  const seen = new Set();
  let out = '';
  for (const raw of urls || []) {
    const url = httpUrl(raw);
    const key = url && urlKey(url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (!numbers.has(key)) numbers.set(key, numbers.size + 1);
    out += `[${numbers.get(key)}](${markdownLinkUrl(url)})`;
  }
  return out;
}

/**
 * Place citation markers after the passages grounding supports name (Google
 * Search grounding, whose answer text has no links). Each passage is looked
 * for from where the previous one ended; a passage that is not found, or
 * that already has a marker for the same source right after it, is skipped,
 * so applying this twice changes nothing.
 *
 * @param {string} text - the answer
 * @param {Array<{text: string, urls: string[]}>} supports
 * @returns {string}
 */
export function insertSupportMarkers(text, supports) {
  const source = typeof text === 'string' ? text : '';
  if (!source || !Array.isArray(supports) || supports.length === 0) return source;
  const numbers = new Map();
  let out = '';
  let cursor = 0;
  for (const support of supports) {
    const passage = typeof support?.text === 'string' ? support.text : '';
    if (!passage.trim()) continue;
    const at = source.indexOf(passage, cursor);
    if (at < 0) continue;
    const end = at + passage.length;
    const markers = citationMarkers(support.urls, numbers);
    if (!markers) continue;
    const following = source.slice(end, end + markers.length + 1);
    out += source.slice(cursor, end);
    if (!following.trimStart().startsWith(markers)) out += markers;
    cursor = end;
  }
  return out + source.slice(cursor);
}
