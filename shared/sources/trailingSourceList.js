// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A list of sources a model wrote at the end of its answer ("Quellen:",
 * "Sources:", "References" …), although the chat lists the sources the answer
 * cites under it ("Cited in this answer") — so the same sources showed twice
 * (issue #3522). The prompt asks models not to write one; this finds the list
 * when a model writes it anyway, so the chat can leave it out.
 *
 * Conservative: leaving a duplicate is better than hiding part of an answer.
 * A block counts only when all of these hold:
 *
 *  - it is at the very end of the answer, after text that cites at least one
 *    source inline (so the list repeats what the answer already links);
 *  - it is introduced by a short lead-in — a heading, a bold line or a line
 *    ending in ":" of at most four words — and/or a horizontal rule;
 *  - every line of it is an entry for one of the answer's sources: it links
 *    the source (a Markdown link, a bare URL or a provider marker) and says
 *    nothing but the source's title or site — no claim, no other link. An
 *    entry starts with its citation (`[1](url) – Title`), links the title
 *    itself (`[Title](url)`) or ends in the bare URL (`Title: https://…`); a
 *    line that ends in a numbered citation is a claim, even a short one;
 *  - it holds no code and no table.
 *
 * Language-independent: the lead-in's words are not checked. Each entry is
 * compared with the source it links instead.
 *
 * Pure functions only, no DOM and no Node APIs, so both sides import it.
 *
 * @module shared/sources/trailingSourceList
 */
import { citationRefs } from './citations.js';

/** At most this many words in the lead-in ("Quellen und weiterführende Links:"). */
const MAX_LEAD_IN_WORDS = 4;
/** An entry saying more than this many words besides its links is a sentence. */
const MAX_ENTRY_WORDS = 12;
/** Share of an entry's own words that must occur in its source's title, site or URL. */
const MIN_SOURCE_OVERLAP = 0.5;

const BLANK = /^\s*$/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const FENCE = /^\s{0,3}(```|~~~)/;
const LIST_MARKER = /^\s*(?:[-*+•]|\d{1,3}[.)])\s+/;
const HEADING = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/;
const BOLD_LINE = /^\s*(\*\*|__)(.+?)\1\s*:?\s*$/;
const LINK = /!?\[((?:[^[\]]|\[[^\]]*\])*)\]\([^)]*(?:\([^)]*\)[^)]*)*\)/g;
const BARE_URL = /<?https?:\/\/[^\s<>]+>?/g;
const CITE_TAG = /<cite\s+type="[rs]"\s*>\s*\d+\s*<\/cite>/gi;
/** An entry that starts with its citation: a link, a marker, a URL or "[1]". */
const STARTS_WITH_REF = /^[\s*_]*(?:\[|<cite\s|<?https?:\/\/)/i;

/** Lower-case words and numbers, in any script. */
function wordsOf(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** The words of a lead-in line, or null when the line is not one. */
function leadInWords(line) {
  if (citationRefs(line).length) return null;
  const heading = line.match(HEADING);
  const bold = line.match(BOLD_LINE);
  const colon = /:\s*$/.test(line) && !LIST_MARKER.test(line);
  const text = heading?.[1] ?? bold?.[2] ?? (colon ? line : null);
  if (text == null) return null;
  const words = wordsOf(text);
  return words.length > 0 && words.length <= MAX_LEAD_IN_WORDS ? words : null;
}

/** The number a citation ref has in the answer, or null when it is not one of its sources. */
function numberOf(ref, citations) {
  if (ref.url) return citations.numberOfUrl?.(ref.url) ?? null;
  if (ref.marker) return citations.numberOfMarker?.(ref.marker) ?? null;
  return null;
}

/** The words a source can be named by: its title, site, file name and URL. */
function vocabularyOf(source) {
  return new Set(
    wordsOf([source?.title, source?.site, source?.fileName, source?.url].filter(Boolean).join(' '))
  );
}

/**
 * Whether a line is an entry for one of the answer's sources: it links only
 * the answer's sources, and its other words name them.
 */
function isSourceEntry(line, citations, byNumber) {
  if (/^\s*\|/.test(line)) return false; // a table row
  const refs = citationRefs(line);
  if (refs.length === 0) return false;
  const numbers = refs.map(ref => numberOf(ref, citations));
  if (numbers.some(n => n == null)) return false;

  const entry = line.replace(LIST_MARKER, '');
  const linksTitle = [...entry.matchAll(LINK)].some(link => /\p{L}/u.test(link[1]));
  const bareUrl = BARE_URL.test(entry.replace(LINK, ' '));
  BARE_URL.lastIndex = 0;
  if (!STARTS_WITH_REF.test(entry) && !linksTitle && !bareUrl) return false;

  const rest = line
    .replace(LIST_MARKER, ' ')
    .replace(LINK, ' ')
    .replace(CITE_TAG, ' ')
    .replace(BARE_URL, ' ');
  // "[1]" written as plain text numbers the entry; it says nothing.
  const words = wordsOf(rest).filter(word => !/^\d{1,2}$/.test(word));
  if (words.length === 0) return true;
  if (words.length > MAX_ENTRY_WORDS) return false;

  const vocabulary = new Set(numbers.flatMap(n => [...vocabularyOf(byNumber.get(n))]));
  const named = words.filter(word => vocabulary.has(word)).length;
  return named / words.length >= MIN_SOURCE_OVERLAP;
}

/** Whether the text cites at least one of the answer's sources. */
function citesASource(text, citations) {
  return citationRefs(text).some(ref => numberOf(ref, citations) != null);
}

/**
 * Find a list of sources the model wrote at the end of its answer.
 *
 * @param {string} markdown - the answer
 * @param {{cited: Array<{n: number}>, numberOfUrl: Function, numberOfMarker: Function}|null}
 *   citations - `resolveCitations(markdown, set)` of the same answer
 * @returns {{start: number, entries: number}|null} where the list starts (its
 *   rule or lead-in), and how many entries it has; null when there is none
 */
export function findTrailingSourceList(markdown, citations) {
  const text = typeof markdown === 'string' ? markdown : '';
  if (!text || !citations?.cited?.length) return null;
  const byNumber = new Map(citations.cited.map(source => [source.n, source]));

  const lines = text.split('\n');
  const offsets = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length + 1;
  }

  let index = lines.length - 1;
  while (index >= 0 && BLANK.test(lines[index])) index--;

  // The entries, from the end up; blank lines between them are fine.
  let entries = 0;
  for (; index >= 0; index--) {
    const line = lines[index];
    if (BLANK.test(line)) continue;
    if (FENCE.test(line)) return null;
    if (!isSourceEntry(line, citations, byNumber)) break;
    entries++;
  }
  if (entries === 0 || index < 0) return null;

  // What introduces them: a lead-in, a rule, or a rule above a lead-in.
  let start = null;
  if (RULE.test(lines[index])) {
    start = index;
  } else if (leadInWords(lines[index])) {
    start = index;
    let above = index - 1;
    while (above >= 0 && BLANK.test(lines[above])) above--;
    if (above >= 0 && RULE.test(lines[above])) start = above;
  }
  if (start == null) return null;

  // An odd number of fences above means the list is inside a code block.
  const before = lines.slice(0, start);
  if (before.filter(line => FENCE.test(line)).length % 2 === 1) return null;
  // The list must repeat sources the answer already cites in its text.
  const body = text.slice(0, offsets[start]);
  if (!body.trim() || !citesASource(body, citations)) return null;

  return { start: offsets[start], entries };
}

/**
 * The answer without a list of sources the model wrote at its end.
 *
 * @param {string} markdown
 * @param {Object|null} citations - `resolveCitations(markdown, set)`
 * @returns {string} the answer, unchanged when it has no such list
 */
export function withoutTrailingSourceList(markdown, citations) {
  const found = findTrailingSourceList(markdown, citations);
  return found ? markdown.slice(0, found.start).trimEnd() : markdown;
}
