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

/** The status a provider answers when only a document's extracted text is kept. */
export const ORIGINAL_DISCARDED = 410;

/**
 * Project item kinds that keep an original the preview can render: an iFinder
 * document is served through the iFinder provider (PDF rendition, the reader's
 * rights). Every other project item is text only — an upload or a picked
 * cloud file (original discarded), or a web / iHub page whose "original"
 * lives elsewhere (the content route redirects there, which a preview cannot
 * render).
 */
const PROJECT_KINDS_WITH_ORIGINAL = Object.freeze(['ifinder-document']);

/**
 * Whether a source is known to be text only. A project source without a
 * recorded kind is not: the preview asks for the original and falls back to
 * the text on {@link ORIGINAL_DISCARDED}.
 *
 * @param {{provider?: string, provenance?: {kind?: string}}} source
 * @returns {boolean}
 */
function isTextOnly(source) {
  const kind = source?.provenance?.kind;
  return (
    source?.provider === 'project' && Boolean(kind) && !PROJECT_KINDS_WITH_ORIGINAL.includes(kind)
  );
}

/** Characters of a passage used to find it when the whole passage does not match. */
const NEEDLE_LENGTH = 60;

/**
 * The format the preview asks the provider for first.
 *
 * @param {{provider?: string, provenance?: {kind?: string}}} source
 * @returns {'pdf'|'text'}
 */
export function previewFormatFor(source) {
  return isTextOnly(source) ? 'text' : 'pdf';
}

/**
 * The format a download asks for: the original, or the text where no
 * original is kept.
 *
 * @param {{provider?: string}} source
 * @returns {'original'|'text'}
 */
export function downloadFormatFor(source) {
  return isTextOnly(source) ? 'text' : 'original';
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
    response?.status === ORIGINAL_DISCARDED ||
    response?.data?.code === 'ORIGINAL_DISCARDED' ||
    response?.data?.details?.code === 'ORIGINAL_DISCARDED'
  );
}

/** `value` as a literal inside a regular expression. */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/**
 * Where `passage` occurs in `text`, as offsets into `text`, or null.
 * Whitespace runs match flexibly: a source collapses the whitespace of its
 * passages (`normalizeSource`), so a heading followed by a blank line is
 * quoted with a single space and must still be found in the original.
 *
 * @param {string} text
 * @param {string} passage
 * @returns {{start: number, end: number}|null}
 */
export function findPassage(text, passage) {
  const words = String(passage || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return null;
  const match = new RegExp(words.map(escapeRegExp).join(String.raw`\s+`)).exec(String(text || ''));
  return match ? { start: match.index, end: match.index + match[0].length } : null;
}

/**
 * Where a passage sits in the text: the whole passage when it occurs
 * (whitespace aside), else the start of it (passages are excerpts and may
 * have been cut).
 *
 * @param {string} text
 * @param {string} passage
 * @returns {{start: number, end: number}|null}
 */
function locate(text, passage) {
  const wanted = String(passage || '').trim();
  if (!wanted) return null;
  const whole = findPassage(text, wanted);
  if (whole) return whole;
  const needle = wanted.slice(0, NEEDLE_LENGTH).trim();
  if (needle.length < 8) return null;
  return findPassage(text, needle);
}

/**
 * Split a text into plain and highlighted segments, one highlight per
 * passage found (overlapping ranges merged, in text order).
 *
 * @param {string} text
 * @param {string[]} passages
 * @returns {{segments: Array<{at: number, text: string, match: number|null}>, matches: number}}
 *   `at` is the segment's offset in the text (its stable key); `match` is the
 *   highlight's index for highlighted segments, else null.
 *
 * @example
 * splitByPassages('a b c', ['b'])
 * // => { segments: [{ at: 0, text: 'a ', match: null }, { at: 2, text: 'b', match: 0 },
 * //                 { at: 3, text: ' c', match: null }], matches: 1 }
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
    if (range.start > cursor) {
      segments.push({ at: cursor, text: source.slice(cursor, range.start), match: null });
    }
    segments.push({ at: range.start, text: source.slice(range.start, range.end), match: index });
    cursor = range.end;
  });
  if (cursor < source.length || segments.length === 0) {
    segments.push({ at: cursor, text: source.slice(cursor), match: null });
  }
  return { segments, matches: merged.length };
}
