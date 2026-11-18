// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Keeps the "as loaded / as last saved" copy of an editor's value, for
 * `useUnsavedChanges(baseline, current)`.
 *
 * Settings pages often load in several steps and normalise what they load
 * through `setState(prev => …)`, so the exact loaded value only exists after
 * React has applied those updates. `captureBaseline()` asks for a snapshot of
 * `current` as it is after the next render: call it at the end of a successful
 * load (in the same tick as the state updates) and the baseline equals the
 * normalised loaded value, so a just-loaded page is never dirty.
 *
 * Until the first capture the baseline is `null`, which `useUnsavedChanges`
 * treats as "not loaded": a page that is loading or whose load failed is never
 * dirty.
 *
 * @param {*} current - The value being edited (memoise objects built from
 *   several states so the snapshot is stable).
 * @returns {{
 *   baseline: *,
 *   captureBaseline: () => void,
 *   setBaseline: (next: * | ((prev: *) => *)) => void
 * }} `setBaseline` updates part of the baseline after a partial save.
 *
 * @example
 * const current = useMemo(() => ({ logging, privacy }), [logging, privacy]);
 * const { baseline, captureBaseline, setBaseline } = useSavedBaseline(current);
 * const { blocker } = useUnsavedChanges(baseline, current);
 * // after load:  setLogging(...); setPrivacy(...); captureBaseline();
 * // after save:  setBaseline(prev => ({ ...prev, privacy }));
 */
export function useSavedBaseline(current) {
  const [baseline, setBaseline] = useState(null);
  const [captureRequest, setCaptureRequest] = useState(0);
  const currentRef = useRef(current);
  currentRef.current = current;

  useEffect(() => {
    if (captureRequest > 0) setBaseline(currentRef.current);
  }, [captureRequest]);

  const captureBaseline = useCallback(() => setCaptureRequest(n => n + 1), []);

  return { baseline, captureBaseline, setBaseline };
}
