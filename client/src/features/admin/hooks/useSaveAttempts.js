// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useState } from 'react';

/**
 * Counts the refused save attempts of the resource an edit page shows. The
 * count belongs to one resource: when the route moves to another resource (or
 * to a blank "new" form), the count reads 0 again, so that form opens without
 * errors. Each further refused save of the same resource raises it, which
 * moves the focus to the error summary again (`summaryFocusKey`).
 *
 * @param {string} resourceId - The routed ID (`'new'` for a new resource).
 * @returns {[number, () => void]} The count for this resource, and the function that
 *   counts one more refused attempt.
 *
 * @example
 * const [saveAttempts, countSaveAttempt] = useSaveAttempts(modelId);
 * // showAllErrors: saveAttempts > 0, summaryFocusKey: saveAttempts
 */
export default function useSaveAttempts(resourceId) {
  const [attempts, setAttempts] = useState({ resourceId, count: 0 });
  // A new resource starts from 0 and the old count is dropped, so coming back
  // to the first resource (say "new") does not bring its refused saves back.
  if (attempts.resourceId !== resourceId) {
    setAttempts({ resourceId, count: 0 });
  }
  const count = attempts.resourceId === resourceId ? attempts.count : 0;
  const countSaveAttempt = useCallback(
    () =>
      setAttempts(previous => ({
        resourceId,
        count: (previous.resourceId === resourceId ? previous.count : 0) + 1
      })),
    [resourceId]
  );
  return [count, countSaveAttempt];
}
