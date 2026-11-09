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
/** A line longer than this is a paragraph, not an entry; it also bounds the scanning. */
const MAX_ENTRY_CHARS = 2000;
/** Share of an entry's own words that must occur in its source's title, site or URL. */
const MIN_SOURCE_OVERLAP = 0.5;

// Every pattern here is anchored or has no nested quantifier, so it runs in
// linear time; Markdown links are split off by `splitLinks`, not by a regex.
const FENCE = /^\s{0,3}(?:```|~~~)/;
const LIST_MARKER = /^\s*(?:[-*+•]|\d{1,3}[.)])\s+/;
const HEADING_START = /^#{1,6}\s/;
const BARE_URL = /<?https?:\/\/[^\s<>]+/g;
const CITE_TAG = /<cite\s+type="[rs]"\s*>\s*\d+\s*<\/cite>/gi;
/** An entry that starts with its citation: a link, a marker, a URL or "[1]". */
const STARTS_WITH_REF = /^[\s*_]*(?:\[|<cite\s|<?https?:\/\/)/i;

const isBlank = line => !line.trim();

/** Lower-case words and numbers, in any script. */
function wordsOf(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** `text` without the given character at its start and end. */
function trimChar(text, char) {
  let from = 0;
  let to = text.length;
  while (from < to && text[from] === char) from++;
  while (to > from && text[to - 1] === char) to--;
  return text.slice(from, to);
}

/** The index of the `close` that ends what opens at `from`, allowing one nested pair. */
function closingIndex(text, from, open, close) {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    if (text[i] === open) {
      depth++;
      if (depth > 1) return -1;
    } else if (text[i] === close) {
      if (depth === 0) return i;
      depth--;
    }
  }
  return -1;
}

/**
 * A line's Markdown links (`[label](url)`, images included) and the text
 * around them, in one pass.
 *
 * @param {string} line
 * @returns {{labels: string[], rest: string}}
 */
function splitLinks(line) {
  const labels = [];
  let rest = '';
  let i = 0;
  while (i < line.length) {
    const labelEnd = line[i] === '[' ? closingIndex(line, i + 1, '[', ']') : -1;
    const urlEnd =
      labelEnd >= 0 && line[labelEnd + 1] === '(' ? closingIndex(line, labelEnd + 2, '(', ')') : -1;
    if (urlEnd < 0) {
      rest += line[i];
      i++;
      continue;
    }
    labels.push(line.slice(i + 1, labelEnd));
    if (rest.endsWith('!')) rest = rest.slice(0, -1);
    rest += ' ';
    i = urlEnd + 1;
  }
  return { labels, rest };
}

/** Whether a line is a horizontal rule: `---`, `***`, `___`, spaced or not. */
function isRule(line) {
  if (/^\s{4}/.test(line)) return false;
  const marks = line.replaceAll(/\s/g, '');
  return marks.length >= 3 && '-*_'.includes(marks[0]) && trimChar(marks, marks[0]) === '';
}

/** The text of a lead-in line — a heading, a bold line or a line ending in ":" — or null. */
function leadInText(line) {
  const trimmed = line.trim();
  if (HEADING_START.test(trimmed)) return trimChar(trimChar(trimmed, '#').trim(), '#');
  const bold = trimmed.endsWith(':') ? trimmed.slice(0, -1).trimEnd() : trimmed;
  for (const mark of ['**', '__']) {
    if (bold.length > 4 && bold.startsWith(mark) && bold.endsWith(mark)) return bold.slice(2, -2);
  }
  return trimmed.endsWith(':') && !LIST_MARKER.test(line) ? trimmed : null;
}

/** The words of a lead-in line, or null when the line is not one. */
function leadInWords(line) {
  if (citationRefs(line).length) return null;
  const text = leadInText(line);
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

/** Whether an entry's own words name the sources it links. */
function namesItsSources(text, numbers, byNumber) {
  // "[1]" written as plain text numbers the entry; it says nothing.
  const words = wordsOf(text).filter(word => !/^\d{1,2}$/.test(word));
  if (words.length === 0) return true;
  if (words.length > MAX_ENTRY_WORDS) return false;
  const vocabulary = new Set(numbers.flatMap(n => [...vocabularyOf(byNumber.get(n))]));
  const named = words.filter(word => vocabulary.has(word)).length;
  return named / words.length >= MIN_SOURCE_OVERLAP;
}

/**
 * Whether a line is an entry for one of the answer's sources: it links only
 * the answer's sources, and its other words name them.
 */
function isSourceEntry(line, citations, byNumber) {
  if (line.length > MAX_ENTRY_CHARS || line.trimStart().startsWith('|')) return false; // a table row
  const refs = citationRefs(line);
  if (refs.length === 0) return false;
  const numbers = refs.map(ref => numberOf(ref, citations));
  if (numbers.some(n => n == null)) return false;

  const entry = line.replace(LIST_MARKER, '');
  const { labels, rest } = splitLinks(entry);
  const linksTitle = labels.some(label => /\p{L}/u.test(label));
  const bareUrl = rest.includes('http://') || rest.includes('https://');
  if (!STARTS_WITH_REF.test(entry) && !linksTitle && !bareUrl) return false;

  const own = rest.replaceAll(CITE_TAG, ' ').replaceAll(BARE_URL, ' ');
  return namesItsSources(own, numbers, byNumber);
}

/** Whether the text cites at least one of the answer's sources. */
function citesASource(text, citations) {
  return citationRefs(text).some(ref => numberOf(ref, citations) != null);
}

/** Where each line starts in the text. */
function lineStarts(lines) {
  const starts = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  return starts;
}

/**
 * The entries at the end, counted from the last line up; blank lines between
 * them are fine.
 *
 * @returns {{index: number, entries: number}|null} the line above the entries
 *   and how many there are; null when a code fence comes first
 */
function trailingEntries(lines, isEntry) {
  let index = lines.length - 1;
  let entries = 0;
  for (; index >= 0; index--) {
    const line = lines[index];
    if (isBlank(line)) continue;
    if (FENCE.test(line)) return null;
    if (!isEntry(line)) break;
    entries++;
  }
  return { index, entries };
}

/** The line the list starts at: its rule, its lead-in, or a rule above the lead-in. */
function listStart(lines, index) {
  if (isRule(lines[index])) return index;
  if (!leadInWords(lines[index])) return null;
  let above = index - 1;
  while (above >= 0 && isBlank(lines[above])) above--;
  return above >= 0 && isRule(lines[above]) ? above : index;
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

  const found = trailingEntries(lines, line => isSourceEntry(line, citations, byNumber));
  if (!found || found.entries === 0 || found.index < 0) return null;
  const start = listStart(lines, found.index);
  if (start == null) return null;

  // An odd number of fences above means the list is inside a code block.
  const fences = lines.slice(0, start).filter(line => FENCE.test(line)).length;
  if (fences % 2 === 1) return null;
  // The list must repeat sources the answer already cites in its text.
  const offset = lineStarts(lines)[start];
  const body = text.slice(0, offset);
  if (!body.trim() || !citesASource(body, citations)) return null;

  return { start: offset, entries: found.entries };
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
