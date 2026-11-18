// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as adminApi from '../../../api/adminApi';

/** Seconds to wait before a Retry after a 429 that carries no `Retry-After`. */
export const DEFAULT_RATE_LIMIT_RETRY_SECONDS = 10;

/**
 * Read the wait a 429 asks for: the `Retry-After` header (seconds or an HTTP
 * date), else a `retryAfter` field of the problem+json body (top level or in
 * `details`), else {@link DEFAULT_RATE_LIMIT_RETRY_SECONDS}.
 *
 * @param {object} response - The axios error response
 * @returns {number} Whole seconds, at least 1
 */
function readRetryAfterSeconds(response) {
  const headers = response?.headers || {};
  const raw =
    (typeof headers.get === 'function' ? headers.get('retry-after') : undefined) ??
    headers['retry-after'] ??
    headers['Retry-After'] ??
    response?.data?.retryAfter ??
    response?.data?.details?.retryAfter;

  if (raw !== undefined && raw !== null && raw !== '') {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.max(1, Math.ceil(seconds));
    const date = Date.parse(String(raw));
    if (!Number.isNaN(date)) return Math.max(1, Math.ceil((date - Date.now()) / 1000));
  }
  return DEFAULT_RATE_LIMIT_RETRY_SECONDS;
}

/**
 * Turn a failed admin GET into what the load-error panel needs.
 *
 * @param {unknown} err - What `makeAdminApiCall` (axios) threw
 * @returns {{status: number|null, code: string|null, detail: string, retryAfterSeconds: number|null}}
 *   `status` is the HTTP status (null for a network error), `code` the problem+json
 *   registry code, `detail` the readable reason, `retryAfterSeconds` set only for a 429.
 *
 * @example
 * describeAdminLoadError(err) // { status: 429, code: 'RATE_LIMITED', detail: 'Too many requests', retryAfterSeconds: 12 }
 */
export function describeAdminLoadError(err) {
  const response = err?.response;
  const status = typeof response?.status === 'number' ? response.status : null;
  return {
    status,
    code: response?.data?.code ?? null,
    // The problem+json `detail`, read the way every admin page reads it.
    detail:
      adminApi.getAdminApiErrorMessage?.(err) ??
      (response?.data?.detail || err?.message || 'An unexpected error occurred'),
    retryAfterSeconds: status === 429 ? readRetryAfterSeconds(response) : null
  };
}

/**
 * Load the data an admin settings page saves, and say whether it may be shown
 * and saved.
 *
 * A page that failed to load must not look like one that loaded: until every
 * *required* source succeeded, `status` is not `'ready'`, the page renders the
 * load-error panel instead of its form (see `AdminLoadGate`), and every save
 * handler returns early. An *optional* source (a group list for a picker, the
 * JSON schema) never blocks the page; its failure only shows up in `errors`.
 *
 * - `retry()` re-runs only the sources that failed, in place (no page reload).
 *   While it runs, `status` stays `'failed'` and `retrying` is true, so the
 *   error panel stays mounted and can show "Retrying…".
 *   After a 429 it is a no-op until the `Retry-After` wait has passed;
 *   `retryAfterSeconds` counts that wait down once a second.
 * - A response that arrives after a newer request for the same source started
 *   (out-of-order resolution), or after the page unmounted, is ignored.
 *
 * @param {object} params
 * @param {Object<string, {load: () => Promise<any>, required?: boolean, onLoad?: (data: any) => void}>} params.sources
 *   Each source's `load` resolves with its data. `required` defaults to true.
 *   `onLoad` runs with the data of a current (not stale) response, in the same
 *   render as the status change, so a page can seed its form state from it.
 *   The object may be created inline on every render; the latest one is used.
 * @returns {{
 *   status: 'loading'|'ready'|'failed',
 *   sourceStatus: Object<string, 'loading'|'ready'|'failed'>,
 *   data: Object<string, any>,
 *   errors: Object<string, {status: number|null, code: string|null, detail: string, retryAfterSeconds: number|null}>,
 *   error: {status: number|null, code: string|null, detail: string, retryAfterSeconds: number|null}|null,
 *   retry: () => Promise<void>,
 *   retrying: boolean,
 *   retryAfterSeconds: number
 * }}
 *
 * @example
 * const load = useAdminConfigLoad({
 *   sources: {
 *     platform: {
 *       load: async () => (await makeAdminApiCall('/admin/configs/platform')).data,
 *       onLoad: setConfig
 *     },
 *     groups: { load: loadGroups, required: false }
 *   }
 * });
 * const save = async () => {
 *   if (load.status !== 'ready') return;
 *   // …
 * };
 */
export function useAdminConfigLoad({ sources }) {
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;

  // The source keys are fixed for the life of the page.
  const keysRef = useRef(Object.keys(sources));
  const keys = keysRef.current;

  const [results, setResults] = useState(() =>
    Object.fromEntries(keys.map(key => [key, { state: 'loading', data: undefined, error: null }]))
  );
  const [retryAvailableAt, setRetryAvailableAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  const mountedRef = useRef(false);
  const generationRef = useRef({});
  const resultsRef = useRef(results);
  resultsRef.current = results;

  const runSource = useCallback(async (key, asRetry = false) => {
    const generation = (generationRef.current[key] ?? 0) + 1;
    generationRef.current[key] = generation;
    // A retry keeps the error on screen (the panel shows "Retrying…") instead of
    // swapping it for a spinner, so focus stays on the Retry button.
    setResults(prev => ({
      ...prev,
      [key]: asRetry
        ? { ...prev[key], state: 'retrying' }
        : { ...prev[key], state: 'loading', error: null }
    }));

    let outcome;
    try {
      outcome = { ok: true, data: await sourcesRef.current[key].load() };
    } catch (err) {
      outcome = { ok: false, error: describeAdminLoadError(err) };
    }

    // A newer request for this source started, or the page went away.
    if (!mountedRef.current || generationRef.current[key] !== generation) return;

    if (outcome.ok) {
      sourcesRef.current[key].onLoad?.(outcome.data);
      setResults(prev => ({ ...prev, [key]: { state: 'ok', data: outcome.data, error: null } }));
    } else {
      setResults(prev => ({
        ...prev,
        [key]: { state: 'error', data: prev[key]?.data, error: outcome.error }
      }));
      if (outcome.error.retryAfterSeconds) {
        const until = Date.now() + outcome.error.retryAfterSeconds * 1000;
        setRetryAvailableAt(prev => Math.max(prev, until));
        setNow(Date.now());
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    keys.forEach(key => void runSource(key));
    return () => {
      mountedRef.current = false;
    };
  }, [keys, runSource]);

  // Count the Retry-After wait down once a second.
  useEffect(() => {
    if (retryAvailableAt <= now) return undefined;
    const timer = setTimeout(() => setNow(Date.now()), 1000);
    return () => clearTimeout(timer);
  }, [retryAvailableAt, now]);

  const retryAfterSeconds = Math.max(0, Math.ceil((retryAvailableAt - now) / 1000));
  const retryAfterRef = useRef(retryAfterSeconds);
  retryAfterRef.current = retryAfterSeconds;

  const retry = useCallback(async () => {
    if (retryAfterRef.current > 0) return;
    const failed = keys.filter(key => resultsRef.current[key]?.state === 'error');
    await Promise.all(failed.map(key => runSource(key, true)));
  }, [keys, runSource]);

  const isRequired = key => sourcesRef.current[key]?.required !== false;

  let status = 'ready';
  if (keys.some(key => isRequired(key) && results[key].state === 'loading')) status = 'loading';
  else if (keys.some(key => isRequired(key) && results[key].error)) status = 'failed';
  const retrying = keys.some(key => results[key].state === 'retrying');

  const data = useMemo(
    () => Object.fromEntries(keys.map(key => [key, results[key].data])),
    [keys, results]
  );
  const errors = useMemo(
    () =>
      Object.fromEntries(
        keys.filter(key => results[key].error).map(key => [key, results[key].error])
      ),
    [keys, results]
  );

  // Per source, for a page whose sections save independently (see AdminLoadGate `sources`).
  const sourceStatus = useMemo(
    () =>
      Object.fromEntries(
        keys.map(key => {
          const { state, error } = results[key];
          if (error) return [key, 'failed'];
          return [key, state === 'ok' ? 'ready' : 'loading'];
        })
      ),
    [keys, results]
  );

  // The error the page shows: that of the first required source that failed.
  const firstRequiredFailure = keys.find(key => isRequired(key) && results[key].error);
  const error = firstRequiredFailure ? results[firstRequiredFailure].error : null;

  return { status, sourceStatus, data, errors, error, retry, retrying, retryAfterSeconds };
}

export default useAdminConfigLoad;
