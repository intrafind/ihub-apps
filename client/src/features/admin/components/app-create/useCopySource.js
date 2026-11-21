// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

/** The query parameter that names the app to copy: `?from=<id>`. */
export const COPY_SOURCE_PARAM = 'from';

/**
 * The app a copy starts from: the one the URL names (`?from=<id>`, the
 * target of "Duplicate"), or one the author picked from the list.
 *
 * The app named in the URL is loaded through the caller's `fetchApp`. Once
 * the page has opened the copy it calls `done()`, which takes the parameter
 * out of the URL: a reload then brings back the author's draft instead of a
 * fresh copy, and "Back" leads to a Start screen that copies nothing.
 *
 * @param {object} options
 * @param {(id: string) => Promise<object>} options.fetchApp - One app, as stored.
 * @returns {{
 *   requested: boolean,
 *   status: 'idle'|'loading'|'gone'|'failed',
 *   source: object|null,
 *   use: (app: object) => void,
 *   done: () => void,
 *   retry: () => void
 * }} `requested`: the page was opened with a source in its URL. `gone`: that
 *   app does not exist. `failed`: it could not be loaded; `retry()` tries again.
 */
export function useCopySource({ fetchApp }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const fromId = searchParams.get(COPY_SOURCE_PARAM);
  const [requested] = useState(Boolean(fromId));
  const [status, setStatus] = useState(fromId ? 'loading' : 'idle');
  const [source, setSource] = useState(null);
  const [attempt, setAttempt] = useState(0);

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
    if (!fromId) return undefined;
    let current = true;
    fetchApp(fromId)
      .then(app => {
        if (current) setSource(app);
      })
      .catch(error => {
        if (!current) return;
        const code = error?.response?.status;
        // An ID that names no app, or that cannot be an ID at all.
        const gone = code === 404 || code === 400;
        setStatus(gone ? 'gone' : 'failed');
        if (gone) dropParam();
      });
    return () => {
      current = false;
    };
    // `dropParam` changes with the URL it rewrites; the request must not repeat for that.
    // eslint-disable-next-line @eslint-react/exhaustive-deps
  }, [fromId, attempt, fetchApp]);

  const use = useCallback(app => {
    setStatus('loading');
    setSource(app);
  }, []);

  const done = useCallback(() => {
    setSource(null);
    setStatus('idle');
    if (fromId) dropParam();
  }, [fromId, dropParam]);

  const retry = useCallback(() => {
    setStatus('loading');
    setAttempt(count => count + 1);
  }, []);

  return { requested, status, source, use, done, retry };
}

export default useCopySource;
