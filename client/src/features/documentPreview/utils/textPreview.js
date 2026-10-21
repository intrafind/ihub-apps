// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The text mode of the document preview (#1036, spec 2 §5.1). A project
 * item keeps no original in the iHub tier: its PDF rendition answers
 * `410 ORIGINAL_DISCARDED`, so the preview shows the extracted text instead
 * (`format=text`) with the cited passages highlighted.
 *
 * @module features/documentPreview/utils/textPreview
 */

/** Providers whose documents are kept as text only (no original, no PDF). */
const TEXT_ONLY_PROVIDERS = Object.freeze(['project']);

/** Characters of a passage used to find it when the whole passage does not match. */
const NEEDLE_LENGTH = 60;

/**
 * The format the preview asks the provider for first.
 *
 * @param {{provider?: string}} source
 * @returns {'pdf'|'text'}
 */
export function previewFormatFor(source) {
  return TEXT_ONLY_PROVIDERS.includes(source?.provider) ? 'text' : 'pdf';
}

/**
 * The format a download asks for: the original, or the text where no
 * original is kept.
 *
 * @param {{provider?: string}} source
 * @returns {'original'|'text'}
 */
export function downloadFormatFor(source) {
  return TEXT_ONLY_PROVIDERS.includes(source?.provider) ? 'text' : 'original';
}

/**
 * Whether a failed content request means "only the text is kept".
 *
 * @param {Error & {response?: {status?: number, data?: Object}}} error
 * @returns {boolean}
 */
export function isOriginalDiscarded(error) {
  const response = error?.response || error?.originalError?.response;
  return (
    response?.status === 410 ||
    response?.data?.code === 'ORIGINAL_DISCARDED' ||
    response?.data?.details?.code === 'ORIGINAL_DISCARDED'
  );
}

/**
 * Where a passage sits in the text: the whole passage when it occurs
 * verbatim, else the start of it (passages are excerpts and may have been
 * cut or re-spaced).
 *
 * @param {string} text
 * @param {string} passage
 * @returns {{start: number, end: number}|null}
 */
function locate(text, passage) {
  const wanted = String(passage || '').trim();
  if (!wanted) return null;
  let start = text.indexOf(wanted);
  if (start >= 0) return { start, end: start + wanted.length };
  const needle = wanted.slice(0, NEEDLE_LENGTH).trim();
  if (needle.length < 8) return null;
  start = text.indexOf(needle);
  return start >= 0 ? { start, end: start + needle.length } : null;
}

/**
 * Split a text into plain and highlighted segments, one highlight per
 * passage found (overlapping ranges merged, in text order).
 *
 * @param {string} text
 * @param {string[]} passages
 * @returns {{segments: Array<{text: string, match: number|null}>, matches: number}}
 *   `match` is the highlight's index for highlighted segments, else null.
 *
 * @example
 * splitByPassages('a b c', ['b'])
 * // => { segments: [{ text: 'a ', match: null }, { text: 'b', match: 0 },
 * //                 { text: ' c', match: null }], matches: 1 }
 */
export function splitByPassages(text, passages) {
  const source = String(text || '');
  const ranges = (passages || [])
    .map(passage => locate(source, passage))
    .filter(Boolean)
    .sort((a, b) => a.start - b.start);
  const merged = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  const segments = [];
  let cursor = 0;
  merged.forEach((range, index) => {
    if (range.start > cursor)
      segments.push({ text: source.slice(cursor, range.start), match: null });
    segments.push({ text: source.slice(range.start, range.end), match: index });
    cursor = range.end;
  });
  if (cursor < source.length || segments.length === 0) {
    segments.push({ text: source.slice(cursor), match: null });
  }
  return { segments, matches: merged.length };
}
