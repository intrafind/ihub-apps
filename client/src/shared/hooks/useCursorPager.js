// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useState } from 'react';

/**
 * Previous/next paging over a cursor-paged list (`{ items, nextCursor }`).
 *
 * A cursor is opaque, so the pager keeps the cursors of the pages it has visited and steps back
 * through them. Pass `cursor` to the list call, hand the answer's `nextCursor` to `goNext`, and
 * pass a `resetKey` that changes with the filters (or call `reset`) to return to the first page.
 *
 * @param {string|null} [resetKey]
 * @returns {{ cursor: string|null, page: number, hasPrevious: boolean,
 *   goNext: (nextCursor: string|null) => void, goPrevious: () => void, reset: () => void }}
 */
export function useCursorPager(resetKey = null) {
  const [stored, setStored] = useState({ cursors: [null], index: 0, key: resetKey });
  // A changed `resetKey` (the filters, say) starts over without a render on the old cursors.
  const state = stored.key === resetKey ? stored : { cursors: [null], index: 0, key: resetKey };

  const goNext = useCallback(
    nextCursor => {
      if (!nextCursor) return;
      setStored(prev => {
        const { cursors, index } = prev.key === resetKey ? prev : { cursors: [null], index: 0 };
        return {
          cursors: [...cursors.slice(0, index + 1), nextCursor],
          index: index + 1,
          key: resetKey
        };
      });
    },
    [resetKey]
  );

  const goPrevious = useCallback(() => {
    setStored(prev =>
      prev.key === resetKey ? { ...prev, index: Math.max(prev.index - 1, 0) } : prev
    );
  }, [resetKey]);

  const reset = useCallback(
    () => setStored({ cursors: [null], index: 0, key: resetKey }),
    [resetKey]
  );

  return {
    cursor: state.cursors[state.index],
    page: state.index + 1,
    hasPrevious: state.index > 0,
    goNext,
    goPrevious,
    reset
  };
}
