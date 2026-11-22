// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

/** The query parameter that names the app to copy: `?from=<id>`. */
const COPY_SOURCE_PARAM = 'from';

/**
 * The app a copy starts from: the one the URL names (`?from=<id>`, the
 * target of "Duplicate"), or one the author picked from the list.
 *
 * The app named in the URL is loaded through the caller's `fetchApp`. Once
 * the page opens a start (the copy itself, or any other) it calls
 * `dismiss()`, which takes the parameter out of the URL and ends the copy: a
 * reload then brings back the author's draft instead of a fresh copy, "Back"
 * leads to a Start screen that copies nothing, and a source that is still
 * loading can no longer replace what the author started instead.
 *
 * A source that could not be loaded leaves the URL too. Its ID is kept for
 * `retry()`, so a reload brings back what the author typed meanwhile.
 *
 * @param {object} options
 * @param {(id: string) => Promise<object>} options.fetchApp - One app, as stored.
 * @param {(app: object) => Promise<unknown>|null|undefined} [options.prepare] -
 *   Runs before a source is handed over, whichever way it was chosen (the page
 *   loads what the copy needs). When it returns a promise, the source waits
 *   for it. It must be stable; a failure does not stop the copy.
 * @returns {{
 *   requested: boolean,
 *   status: 'idle'|'loading'|'gone'|'failed',
 *   source: object|null,
 *   use: (app: object) => void,
 *   dismiss: () => void,
 *   retry: () => void
 * }} `requested`: the page was opened with a source in its URL. `gone`: that
 *   app does not exist. `failed`: it could not be loaded; `retry()` tries again.
 */
export function useCopySource({ fetchApp, prepare }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const fromId = searchParams.get(COPY_SOURCE_PARAM);
  const [requested] = useState(Boolean(fromId));
  // The app to load. It outlives the URL parameter, which a failed load drops.
  const [targetId, setTargetId] = useState(fromId);
  const [seenFromId, setSeenFromId] = useState(fromId);
  const [status, setStatus] = useState(fromId ? 'loading' : 'idle');
  const [source, setSource] = useState(null);
  const [attempt, setAttempt] = useState(0);
  // Counts the picks, so a pick that is still being prepared cannot replace a later one.
  const pickRef = useRef(0);

  // A source named in the URL while the page is open ("Duplicate" from another place).
  if (fromId !== seenFromId) {
    setSeenFromId(fromId);
    if (fromId) {
      setTargetId(fromId);
      setStatus('loading');
    }
  }

  /**
   * The caller's preparation for an app: a promise that never rejects, or
   * null when there is nothing to wait for (the copy then opens at once).
   */
  const preparing = useCallback(
    app => {
      let wait = null;
      try {
        wait = prepare?.(app);
      } catch {
        // A preparation that fails does not stop the copy.
      }
      return typeof wait?.then === 'function' ? Promise.resolve(wait).catch(() => undefined) : null;
    },
    [prepare]
  );

  const dropParam = useCallback(() => {
    setSearchParams(
      params => {
        const next = new URLSearchParams(params);
        next.delete(COPY_SOURCE_PARAM);
        return next;
      },
      { replace: true }
    );
  }, [setSearchParams]);

  useEffect(() => {
    if (!targetId) return undefined;
    let current = true;
    fetchApp(targetId)
      .then(app => preparing(app)?.then(() => app) ?? app)
      .then(app => {
        if (current) setSource(app);
      })
      .catch(error => {
        if (!current) return;
        const code = error?.response?.status;
        // An ID that names no app, or that cannot be an ID at all.
        const gone = code === 404 || code === 400;
        setStatus(gone ? 'gone' : 'failed');
        if (gone) setTargetId(null);
        // Either way the URL no longer asks for a copy: a reload restores the author's draft.
        dropParam();
      });
    return () => {
      current = false;
    };
    // `dropParam` changes with the URL it rewrites; the request must not repeat for that.
    // eslint-disable-next-line @eslint-react/exhaustive-deps
  }, [targetId, attempt, fetchApp, preparing]);

  const use = useCallback(
    app => {
      const pick = (pickRef.current += 1);
      setStatus('loading');
      const wait = preparing(app);
      if (!wait) {
        setSource(app);
        return;
      }
      void wait.then(() => {
        if (pickRef.current === pick) setSource(app);
      });
    },
    [preparing]
  );

  const dismiss = useCallback(() => {
    // A pick that is still being prepared, or a load that is still running, is dropped.
    pickRef.current += 1;
    setTargetId(null);
    setSource(null);
    setStatus('idle');
    if (fromId) dropParam();
  }, [fromId, dropParam]);

  const retry = useCallback(() => {
    setStatus('loading');
    setAttempt(count => count + 1);
  }, []);

  return { requested, status, source, use, dismiss, retry };
}

export default useCopySource;
