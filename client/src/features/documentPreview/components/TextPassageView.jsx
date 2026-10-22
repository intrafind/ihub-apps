// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useMemo } from 'react';

/** `value` as a literal inside a regular expression. */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Where `passage` occurs in `text`, as `[start, end]` offsets into `text`, or
 * null. Whitespace runs match flexibly: a source collapses the whitespace of
 * its passages (`normalizeSource`), so a heading followed by a blank line is
 * quoted with a single space, and must still be found in the original.
 *
 * @param {string} text
 * @param {string} passage
 * @returns {[number, number]|null}
 */
export function findPassage(text, passage) {
  const words = String(passage || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return null;
  const match = new RegExp(words.map(escapeRegExp).join('\\s+')).exec(text);
  return match ? [match.index, match.index + match[0].length] : null;
}

/**
 * The passages of `text` that `passages` quote, as `<mark>` segments: each
 * quoted passage is looked up once, whole (whitespace aside), so a passage
 * the text does not carry (the extraction rewrote it) just goes unmarked.
 *
 * @param {string} text
 * @param {string[]} passages
 * @returns {Array<{at: number, text: string, marked: boolean}>} `at` is the
 *   segment's offset in `text`, the stable key of its element.
 */
export function segmentText(text, passages) {
  const ranges = [];
  for (const passage of passages) {
    const range = findPassage(text, passage);
    if (range) ranges.push(range);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const segments = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start < cursor) continue;
    if (start > cursor)
      segments.push({ at: cursor, text: text.slice(cursor, start), marked: false });
    segments.push({ at: start, text: text.slice(start, end), marked: true });
    cursor = end;
  }
  if (cursor < text.length) segments.push({ at: cursor, text: text.slice(cursor), marked: false });
  return segments;
}

/**
 * The extracted text of a document the server keeps no original of (a
 * project's uploaded document), with the cited passages highlighted.
 *
 * @param {{text: string, passages?: string[]}} props
 */
function TextPassageView({ text, passages = [] }) {
  const segments = useMemo(() => segmentText(text, passages), [text, passages]);
  return (
    <div className="flex-1 min-h-0 overflow-auto bg-gray-50 dark:bg-gray-900">
      <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-gray-800 dark:text-gray-200 p-6 max-w-3xl mx-auto">
        {segments.map(segment =>
          segment.marked ? (
            <mark key={segment.at} className="bg-amber-200 dark:bg-amber-700/60 rounded-sm px-0.5">
              {segment.text}
            </mark>
          ) : (
            <span key={segment.at}>{segment.text}</span>
          )
        )}
      </pre>
    </div>
  );
}

export default TextPassageView;
