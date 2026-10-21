// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useMemo, useRef, useState } from 'react';
import { splitByPassages } from '../utils/textPreview';

/**
 * The text sibling of `PdfPassageViewer` (#1036, spec 2 §5.1): a document
 * kept as text only, with the cited passages highlighted. It reports its
 * state the same way (`onStateChange`) and is driven through the same
 * control (`controlRef.current.nextMatch()` / `previousMatch()`), so the
 * preview's toolbar works for both.
 *
 * @param {Object} props
 * @param {string} props.text
 * @param {string[]} props.passages - Passage texts to highlight.
 * @param {{current: Object|null}} props.controlRef
 * @param {(state: {loading: boolean, numPages: number, totalMatches: number,
 *   currentMatch: number}) => void} props.onStateChange
 * @returns {JSX.Element}
 */
function TextPassageViewer({ text, passages, controlRef, onStateChange }) {
  const containerRef = useRef(null);
  const { segments, matches } = useMemo(() => splitByPassages(text, passages), [text, passages]);
  const [current, setCurrent] = useState(matches > 0 ? 0 : -1);

  // A new passage selection starts at its first highlight.
  const [shownFor, setShownFor] = useState(segments);
  if (shownFor !== segments) {
    setShownFor(segments);
    setCurrent(matches > 0 ? 0 : -1);
  }

  useEffect(() => {
    onStateChange?.({ loading: false, numPages: 0, totalMatches: matches, currentMatch: current });
    if (current < 0) return;
    const mark = containerRef.current?.querySelector(`[data-match="${current}"]`);
    mark?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  }, [current, matches, onStateChange]);

  useEffect(() => {
    if (!controlRef) return undefined;
    controlRef.current = {
      nextMatch: () => setCurrent(index => (matches > 0 ? (index + 1) % matches : -1)),
      previousMatch: () => setCurrent(index => (matches > 0 ? (index - 1 + matches) % matches : -1))
    };
    return () => {
      controlRef.current = null;
    };
  }, [controlRef, matches]);

  return (
    <div
      ref={containerRef}
      className="flex-1 min-h-0 overflow-y-auto bg-gray-50 dark:bg-gray-900 p-4 sm:p-8"
    >
      <pre
        className="max-w-4xl mx-auto whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-gray-800 dark:text-gray-200 bg-white dark:bg-gray-800 rounded-lg shadow-sm p-6"
        data-testid="text-passage-viewer"
      >
        {segments.map((segment, index) =>
          segment.match === null ? (
            <span key={index}>{segment.text}</span>
          ) : (
            <mark
              key={index}
              data-match={segment.match}
              className={`rounded-sm px-0.5 ${
                segment.match === current
                  ? 'bg-amber-300 dark:bg-amber-500/70 text-gray-900'
                  : 'bg-amber-100 dark:bg-amber-700/40 text-inherit'
              }`}
            >
              {segment.text}
            </mark>
          )
        )}
      </pre>
    </div>
  );
}

export default TextPassageViewer;
