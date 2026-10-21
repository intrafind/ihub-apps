// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useMemo } from 'react';

/**
 * The passages of `text` that `passages` quote, as `<mark>` segments: each
 * quoted passage is looked up once, whole, so a passage the text does not
 * carry verbatim (the extraction normalised it) just goes unmarked.
 *
 * @param {string} text
 * @param {string[]} passages
 * @returns {Array<{text: string, marked: boolean}>}
 */
export function segmentText(text, passages) {
  const ranges = [];
  for (const passage of passages) {
    const needle = String(passage || '').trim();
    if (!needle) continue;
    const start = text.indexOf(needle);
    if (start >= 0) ranges.push([start, start + needle.length]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const segments = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start < cursor) continue;
    if (start > cursor) segments.push({ text: text.slice(cursor, start), marked: false });
    segments.push({ text: text.slice(start, end), marked: true });
    cursor = end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), marked: false });
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
        {segments.map((segment, index) =>
          segment.marked ? (
            <mark key={index} className="bg-amber-200 dark:bg-amber-700/60 rounded-sm px-0.5">
              {segment.text}
            </mark>
          ) : (
            <span key={index}>{segment.text}</span>
          )
        )}
      </pre>
    </div>
  );
}

export default TextPassageView;
