import { useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * URL-persisted filter state backed by React Router's useSearchParams.
 * Survives navigation and can be bookmarked / shared.
 *
 * @param {string} paramName  The URL query parameter name
 * @param {string} defaultValue  Value to use when param is absent
 * @returns {[string, (value: string) => void]}  [currentValue, setValue]
 *
 * Usage:
 *   const [status, setStatus] = useFilterState('status', 'all');
 *
 * ⚠️ Never call two of these setters in the same tick. React Router's
 * `setSearchParams` does not queue the way React's `setState` does — the
 * functional updater receives the *render-time* params, not the result of a
 * setter called moments earlier — so the second call silently discards the
 * first. Use {@link useFilterParams} when a single interaction has to change
 * more than one parameter (for example a filter plus a page reset).
 */
export function useFilterState(paramName, defaultValue = '') {
  const [searchParams, setSearchParams] = useSearchParams();

  const value = searchParams.get(paramName) ?? defaultValue;

  const setValue = useCallback(
    newValue => {
      setSearchParams(
        prev => {
          const next = new URLSearchParams(prev);
          if (newValue === defaultValue || newValue === '' || newValue === null) {
            next.delete(paramName);
          } else {
            next.set(paramName, newValue);
          }
          return next;
        },
        { replace: true }
      );
    },
    [paramName, defaultValue, setSearchParams]
  );

  return [value, setValue];
}

/**
 * URL-persisted filter state for pages that change several parameters at once.
 *
 * `setMany` applies every update in a **single** `setSearchParams` call, which
 * is what makes it safe where {@link useFilterState} is not: chaining two
 * `useFilterState` setters loses the first one (see the warning there).
 *
 * A value of `null`, `undefined`, `''`, an empty array, or the parameter's
 * default removes the parameter. An array writes repeated parameters
 * (`?actor=a&actor=b`), which is how multi-value filters over values that may
 * contain a comma are encoded.
 *
 * @param {Record<string, string>} [defaults]  Per-parameter default values;
 *   a parameter equal to its default is omitted from the URL.
 * @returns {{
 *   searchParams: URLSearchParams,
 *   get: (name: string) => string,
 *   getAll: (name: string) => string[],
 *   setMany: (updates: Record<string, string|string[]|null>) => void
 * }}
 *
 * Usage:
 *   const { get, setMany } = useFilterParams({ page: '1' });
 *   setMany({ resource: 'app', page: null });   // one navigation
 */
export function useFilterParams(defaults = {}) {
  const [searchParams, setSearchParams] = useSearchParams();

  // Callers pass an object literal, so keep `setMany` stable across renders by
  // reading the latest defaults through a ref instead of a dependency.
  const defaultsRef = useRef(defaults);
  defaultsRef.current = defaults;

  const get = useCallback(
    name => searchParams.get(name) ?? defaultsRef.current[name] ?? '',
    [searchParams]
  );

  const getAll = useCallback(name => searchParams.getAll(name), [searchParams]);

  const setMany = useCallback(
    updates => {
      setSearchParams(
        prev => {
          const next = new URLSearchParams(prev);
          for (const [name, value] of Object.entries(updates)) {
            next.delete(name);
            if (Array.isArray(value)) {
              for (const item of value) {
                if (item !== null && item !== undefined && item !== '') next.append(name, item);
              }
            } else if (
              value !== null &&
              value !== undefined &&
              value !== '' &&
              value !== defaultsRef.current[name]
            ) {
              next.set(name, String(value));
            }
          }
          return next;
        },
        { replace: true }
      );
    },
    [setSearchParams]
  );

  return { searchParams, get, getAll, setMany };
}
