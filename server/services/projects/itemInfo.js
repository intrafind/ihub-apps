// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What a project item is about: a title and a short description, stored on
 * the item (`item.title`, `item.description`) so the model can tell which
 * document of a searched project to read without reading it (#3539).
 *
 * Captured, never written by hand:
 *
 *  - an upload or written text at ingest, from the document's own metadata
 *    (a PDF's title, an HTML page's `<title>` and meta description) or else
 *    from its text (the first heading, the first paragraph);
 *  - a web page (`url` item) when it is added, from what the page reader
 *    returns, and for an item added before this existed, on its first read.
 *
 * Both fields are optional: an item without them is listed by its name.
 *
 * @module services/projects/itemInfo
 */

/** Longest stored title, in characters. */
export const MAX_ITEM_TITLE_CHARS = 300;

/** Longest stored description, in characters. */
export const MAX_ITEM_DESCRIPTION_CHARS = 500;

/** Descriptions that say nothing about the document (the page reader's PDF placeholder). */
const EMPTY_DESCRIPTIONS = new Set(['pdf document']);

/** One line of text, at most `max` characters, cut at a word where it can be. */
function oneLine(value, max) {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * A title and description as they are stored: one line each, bounded, empty
 * ones left out.
 *
 * @param {{title?: string|null, description?: string|null}} [info]
 * @returns {{title?: string, description?: string}}
 */
export function cleanItemInfo({ title, description } = {}) {
  const out = {};
  const cleanTitle = oneLine(title, MAX_ITEM_TITLE_CHARS);
  if (cleanTitle) out.title = cleanTitle;
  const cleanDescription = oneLine(description, MAX_ITEM_DESCRIPTION_CHARS);
  if (cleanDescription && !EMPTY_DESCRIPTIONS.has(cleanDescription.toLowerCase())) {
    out.description = cleanDescription;
  }
  return out;
}

/** A line that is markup or a marker, not prose: `[Page 3]`, a table row, a rule, an image. */
function isNoise(line) {
  return (
    /^\[Page \d+/.test(line) ||
    /^[|>]/.test(line) ||
    /^[-*_=]{3,}$/.test(line) ||
    /^!\[/.test(line) ||
    /^```/.test(line)
  );
}

/**
 * A title and description read from extracted text: the first Markdown
 * heading (or, without one, a short first line) and the first paragraph of
 * prose after it.
 *
 * @param {string} text
 * @returns {{title?: string, description?: string}}
 */
export function infoFromText(text) {
  const lines = String(text ?? '')
    .slice(0, 20000)
    .split('\n')
    .map(line => line.trim());
  let title = '';
  let titleAt = -1;
  for (let at = 0; at < lines.length && at < 200; at++) {
    const heading = /^#{1,6}\s+(.+?)\s*#*$/.exec(lines[at]);
    if (heading) {
      title = heading[1];
      titleAt = at;
      break;
    }
  }
  if (!title) {
    const first = lines.findIndex(line => line && !isNoise(line));
    // A short first line that does not end a sentence reads as a title.
    if (first !== -1 && lines[first].length <= 120 && !/[.:;,]$/.test(lines[first])) {
      title = lines[first].replace(/^[#*_\s]+|[*_\s]+$/g, '');
      titleAt = first;
    }
  }
  let description = '';
  const paragraph = [];
  for (let at = titleAt + 1; at < lines.length; at++) {
    const line = lines[at];
    if (!line) {
      if (paragraph.length) break;
      continue;
    }
    if (/^#{1,6}\s/.test(line) || isNoise(line)) {
      if (paragraph.length) break;
      continue;
    }
    paragraph.push(line.replace(/^[-*+]\s+|^\d+[.)]\s+/, ''));
    if (paragraph.join(' ').length > MAX_ITEM_DESCRIPTION_CHARS) break;
  }
  description = paragraph.join(' ');
  return cleanItemInfo({ title, description });
}

/**
 * Set an item's title and description in place, replacing what it had.
 *
 * @param {Object} item
 * @param {{title?: string, description?: string}} info - Already cleaned.
 * @returns {Object} The item.
 */
export function applyItemInfo(item, info = {}) {
  if (info.title) item.title = info.title;
  else delete item.title;
  if (info.description) item.description = info.description;
  else delete item.description;
  return item;
}
