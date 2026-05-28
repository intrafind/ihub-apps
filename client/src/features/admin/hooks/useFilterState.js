import { useCallback } from 'react';
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
