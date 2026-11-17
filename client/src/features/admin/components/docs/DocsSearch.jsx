// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { MagnifyingGlassIcon } from '@heroicons/react/24/outline';
import { makeAdminApiCall } from '../../../../api/adminApi';
import { docsRoute } from '../../utils/docsToc';

const SEARCH_DEBOUNCE_MS = 250;
const MIN_QUERY_LENGTH = 2;

/**
 * The documentation search: a combobox in the docs header with its results in a popover below it,
 * so the page stays where it is while the admin looks. `/` focuses it from anywhere on the page;
 * the arrow keys move through the results, Enter opens one, Escape closes the list.
 */
export default function DocsSearch() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const inputRef = useRef(null);
  const rootRef = useRef(null);
  const listId = useId();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [search, setSearch] = useState({ results: null, loading: false, error: '' });

  // `/` focuses the search unless the admin is typing somewhere.
  useEffect(() => {
    const onKeyDown = event => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      const typing =
        target instanceof HTMLElement &&
        (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
      if (typing) return;
      event.preventDefault();
      inputRef.current?.focus();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  // Close when a click leaves the search (focus leaving it is handled by `onBlur` on the root).
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = event => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  // Search as the admin types, debounced.
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      setSearch({ results: null, loading: false, error: '' });
      return undefined;
    }
    let active = true;
    setSearch(previous => ({ ...previous, loading: true, error: '' }));
    const timer = setTimeout(() => {
      makeAdminApiCall(`/admin/docs/search?q=${encodeURIComponent(trimmed)}`, { method: 'GET' })
        .then(response => {
          if (!active) return;
          setSearch({ results: response.data?.items ?? [], loading: false, error: '' });
          setActiveIndex(-1);
        })
        .catch(err => {
          if (!active) return;
          setSearch({
            results: null,
            loading: false,
            error: err.message || t('admin.docs.searchError', 'Search failed')
          });
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [query, t]);

  const results = search.results || [];
  const showPanel = open && query.trim().length >= MIN_QUERY_LENGTH;
  const optionId = index => `${listId}-option-${index}`;

  const pick = result => {
    setOpen(false);
    setQuery('');
    inputRef.current?.blur();
    navigate(docsRoute(result.path, result.anchor));
  };

  const onKeyDown = event => {
    if (event.key === 'Escape') {
      if (showPanel) {
        event.preventDefault();
        setOpen(false);
      } else {
        setQuery('');
      }
      return;
    }
    // Only act on results that are on screen and belong to the query as typed: while a search is
    // pending the list still holds the previous query's hits, and a closed list shows nothing.
    if (!showPanel || search.loading || !results.length) {
      if (event.key === 'Enter') event.preventDefault();
      if (event.key === 'ArrowDown' && !showPanel && !search.loading && results.length) {
        event.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
      setActiveIndex(index => (index + 1) % results.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex(index => (index <= 0 ? results.length - 1 : index - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      pick(results[Math.max(activeIndex, 0)]);
    }
  };

  // Keep the highlighted result in view while arrowing through a long list.
  useEffect(() => {
    if (activeIndex < 0) return;
    const option = document.getElementById(`${listId}-option-${activeIndex}`);
    if (option && typeof option.scrollIntoView === 'function') {
      option.scrollIntoView({ block: 'nearest' });
    }
  }, [activeIndex, listId]);

  let status = '';
  if (showPanel && !search.loading && search.results) {
    status =
      results.length === 0
        ? t('admin.docs.noResults', 'Nothing found for "{{query}}".', { query: query.trim() })
        : t('admin.docs.resultCount', '{{count}} results', { count: results.length });
  }

  return (
    <div
      ref={rootRef}
      className="relative w-full"
      onBlur={event => {
        if (!rootRef.current?.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <label htmlFor={`${listId}-input`} className="sr-only">
        {t('admin.docs.searchLabel', 'Search the documentation')}
      </label>
      <MagnifyingGlassIcon
        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400"
        aria-hidden="true"
      />
      <input
        ref={inputRef}
        id={`${listId}-input`}
        type="search"
        role="combobox"
        autoComplete="off"
        aria-expanded={showPanel}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showPanel && activeIndex >= 0 ? optionId(activeIndex) : undefined}
        value={query}
        onChange={event => {
          setQuery(event.target.value);
          // A new query starts with nothing highlighted, so Enter cannot pick a hit for the old one.
          setActiveIndex(-1);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder={t('admin.docs.searchPlaceholder', 'Search the documentation...')}
        className="w-full rounded-lg border border-admin-control-border bg-gray-50 py-1.5 pl-9 pr-9 text-sm text-gray-900 placeholder:text-gray-500 focus:border-indigo-500 focus:bg-white focus:outline-hidden focus:ring-1 focus:ring-indigo-500 dark:border-admin-control-border-dark dark:bg-gray-800 dark:text-gray-100 dark:placeholder:text-gray-400 dark:focus:bg-gray-900"
      />
      {!query && (
        <kbd
          aria-hidden="true"
          className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 rounded border border-gray-300 px-1.5 font-sans text-[11px] text-gray-500 dark:border-gray-600 dark:text-gray-400"
        >
          /
        </kbd>
      )}

      <p className="sr-only" aria-live="polite">
        {status}
      </p>

      {showPanel && (
        <div className="absolute right-0 z-30 mt-2 w-full min-w-[min(36rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-900">
          {search.error ? (
            <p role="alert" className="p-4 text-sm text-red-600 dark:text-red-400">
              {search.error}
            </p>
          ) : search.loading && !search.results ? (
            <p className="p-4 text-sm text-gray-500 dark:text-gray-400">
              {t('admin.docs.searching', 'Searching...')}
            </p>
          ) : results.length === 0 ? (
            <p className="p-4 text-sm text-gray-500 dark:text-gray-400">{status}</p>
          ) : (
            <ul
              id={listId}
              role="listbox"
              // The input drives the list; keep the scrollable list itself out of the tab order,
              // so Tab leaves the search instead of stopping on the list.
              tabIndex={-1}
              aria-label={t('admin.docs.searchResults', 'Search results')}
              className="max-h-[min(28rem,70vh)] overflow-y-auto py-1"
            >
              {results.map((result, index) => (
                <li
                  key={`${result.path}#${result.anchor}`}
                  id={optionId(index)}
                  role="option"
                  aria-selected={index === activeIndex}
                  onMouseDown={event => event.preventDefault()}
                  onClick={() => pick(result)}
                  // The combobox input drives the list with the arrow keys; an option that does
                  // get focus (assistive technology) opens on Enter or Space like a click.
                  onKeyDown={event => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      pick(result);
                    }
                  }}
                  onMouseMove={() => setActiveIndex(index)}
                  className={`cursor-pointer px-4 py-2.5 ${
                    index === activeIndex ? 'bg-indigo-50 dark:bg-indigo-900/30' : ''
                  }`}
                >
                  <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                    {result.heading && result.heading !== result.title
                      ? result.heading
                      : result.title}
                  </div>
                  {result.heading && result.heading !== result.title && (
                    <div className="text-xs text-gray-500 dark:text-gray-400">{result.title}</div>
                  )}
                  {result.snippet && (
                    <p className="mt-1 line-clamp-2 text-xs text-gray-600 dark:text-gray-300">
                      {result.snippet}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
