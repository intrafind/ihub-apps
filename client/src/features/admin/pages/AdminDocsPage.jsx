// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { MagnifyingGlassIcon } from '@heroicons/react/24/outline';
import { makeAdminApiCall } from '../../../api/adminApi';
import { renderMarkdown } from '../../../config/marked.config';
import { useCodeBlockInteractions } from '../../../hooks/useCodeBlockInteractions';
import { useMermaidRenderer } from '../../../hooks/useMermaidRenderer';
import LoadingSpinner from '../../../shared/components/LoadingSpinner';
import { decodeFragment, handleDocsLinkClick, rewriteDocsHtml } from '../utils/docsLinks';

/**
 * Admin → Documentation.
 *
 * The documentation that ships with this build (`docs/*.md`), rendered from Markdown: the
 * navigation from `SUMMARY.md` on the left, a search over every section on top, the page on the
 * right. Links between pages stay inside the admin UI; links to release notes open What's New.
 * The URL is the page's path (`/admin/docs/integrations.md#migrations`), so a link from the
 * release notes, a bookmark or a reload lands on the same heading.
 */

const HOME_PAGE = 'README.md';
const SEARCH_DEBOUNCE_MS = 250;

const docsRoute = (path, anchor) =>
  `/admin/docs/${path.split('/').map(encodeURIComponent).join('/')}${anchor ? `#${anchor}` : ''}`;

function TocTree({ nodes, current, depth = 0 }) {
  return (
    <ul
      className={
        depth === 0
          ? 'space-y-0.5'
          : 'mt-0.5 space-y-0.5 border-l border-gray-200 pl-3 dark:border-gray-700'
      }
    >
      {nodes.map((node, index) => {
        const key = `${node.path || node.title}-${index}`;
        if (node.part) {
          return (
            <li
              key={key}
              className="pt-3 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400"
            >
              {node.title}
            </li>
          );
        }
        const active = node.path === current;
        return (
          <li key={key}>
            {node.path ? (
              <Link
                to={docsRoute(node.path)}
                aria-current={active ? 'page' : undefined}
                className={`block rounded px-2 py-1 text-sm ${
                  active
                    ? 'bg-indigo-50 font-medium text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300'
                    : 'text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800'
                }`}
              >
                {node.title}
              </Link>
            ) : (
              <span className="block px-2 py-1 text-sm font-medium text-gray-900 dark:text-gray-100">
                {node.title}
              </span>
            )}
            {node.children.length > 0 && (
              <TocTree nodes={node.children} current={current} depth={depth + 1} />
            )}
          </li>
        );
      })}
    </ul>
  );
}

function SearchResults({ query, results, loading, error, onPick, t }) {
  if (error) {
    return (
      <p role="alert" className="text-sm text-red-600 dark:text-red-400">
        {error}
      </p>
    );
  }
  if (loading && !results) {
    return <LoadingSpinner message={t('admin.docs.searching', 'Searching...')} />;
  }
  if (!results) return null;
  if (results.length === 0) {
    return (
      <p className="text-sm text-gray-500 dark:text-gray-400">
        {t('admin.docs.noResults', 'Nothing found for "{{query}}".', { query })}
      </p>
    );
  }
  return (
    <ol className="divide-y divide-gray-100 dark:divide-gray-800">
      {results.map(result => (
        <li key={`${result.path}#${result.anchor}`} className="py-3">
          <Link
            to={docsRoute(result.path, result.anchor)}
            onClick={onPick}
            className="font-medium text-indigo-600 hover:underline dark:text-indigo-400"
          >
            {result.title}
            {result.heading && result.heading !== result.title && (
              <span className="text-gray-500 dark:text-gray-400"> › {result.heading}</span>
            )}
          </Link>
          {result.snippet && (
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">{result.snippet}</p>
          )}
        </li>
      ))}
    </ol>
  );
}

function AdminDocsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams();
  // React Router already decodes the splat; decoding it again throws on a literal `%`.
  const currentPath = params['*'] || HOME_PAGE;
  const contentRef = useRef(null);
  useCodeBlockInteractions();

  const [toc, setToc] = useState(null);
  const [page, setPage] = useState(null);
  const [pageError, setPageError] = useState('');
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState({ results: null, loading: false, error: '' });

  // The navigation, once.
  useEffect(() => {
    let active = true;
    makeAdminApiCall('/admin/docs/toc', { method: 'GET' })
      .then(response => {
        if (active) setToc(response.data || { toc: [], unlisted: [] });
      })
      .catch(() => {
        if (active) setToc({ toc: [], unlisted: [] });
      });
    return () => {
      active = false;
    };
  }, []);

  // The page in the URL.
  useEffect(() => {
    let active = true;
    setPage(null);
    setPageError('');
    makeAdminApiCall(`/admin/docs/page?path=${encodeURIComponent(currentPath)}`, {
      method: 'GET'
    })
      .then(response => {
        if (active) setPage(response.data);
      })
      .catch(err => {
        if (!active) return;
        setPageError(
          err?.response?.status === 404 || err?.status === 404
            ? t('admin.docs.notFound', 'This documentation page does not exist in this version.')
            : err.message || t('admin.docs.loadError', 'Failed to load the documentation page')
        );
      });
    return () => {
      active = false;
    };
  }, [currentPath, t]);

  // Search as the admin types, debounced.
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setSearch({ results: null, loading: false, error: '' });
      return undefined;
    }
    let active = true;
    setSearch(prev => ({ ...prev, loading: true, error: '' }));
    const timer = setTimeout(() => {
      makeAdminApiCall(`/admin/docs/search?q=${encodeURIComponent(trimmed)}`, { method: 'GET' })
        .then(response => {
          if (active) {
            setSearch({ results: response.data?.results ?? [], loading: false, error: '' });
          }
        })
        .catch(err => {
          if (active) {
            setSearch({
              results: null,
              loading: false,
              error: err.message || t('admin.docs.searchError', 'Search failed')
            });
          }
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [query, t]);

  const html = useMemo(
    () =>
      page
        ? renderMarkdown(page.markdown, {
            t,
            breaks: false,
            transformHtml: rendered => rewriteDocsHtml(rendered, page.path, { headingIds: true })
          })
        : '',
    [page, t]
  );

  useMermaidRenderer({ t });

  // Scroll to the heading in the URL fragment once the page is rendered, or to the top.
  useEffect(() => {
    if (!html) return;
    const id = location.hash ? decodeFragment(location.hash.slice(1)) : '';
    const target = id ? document.getElementById(id) : null;
    if (target && typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ block: 'start' });
    } else if (
      !id &&
      contentRef.current &&
      typeof contentRef.current.scrollIntoView === 'function'
    ) {
      contentRef.current.scrollIntoView({ block: 'start' });
    }
  }, [html, location.hash]);

  useEffect(() => {
    if (page?.title) {
      document.title = `${page.title} · ${t('admin.docs.title', 'Documentation')}`;
    }
  }, [page, t]);

  const searching = query.trim().length >= 2;

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            {t('admin.docs.title', 'Documentation')}
          </h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t(
              'admin.docs.subtitle',
              'The iHub Apps documentation for the version you are running.'
            )}
          </p>
        </div>
        <div className="relative w-full sm:w-80">
          <label htmlFor="admin-docs-search" className="sr-only">
            {t('admin.docs.searchLabel', 'Search the documentation')}
          </label>
          <MagnifyingGlassIcon
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400"
            aria-hidden="true"
          />
          <input
            id="admin-docs-search"
            type="search"
            value={query}
            onChange={event => setQuery(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Escape') setQuery('');
            }}
            placeholder={t('admin.docs.searchPlaceholder', 'Search the documentation...')}
            className="w-full rounded-md border border-gray-300 bg-white py-2 pl-9 pr-3 text-sm text-gray-900 focus:border-indigo-500 focus:outline-hidden focus:ring-1 focus:ring-indigo-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
          />
        </div>
      </header>

      <div className="lg:grid lg:grid-cols-[16rem_minmax(0,1fr)] lg:gap-10">
        <nav
          aria-label={t('admin.docs.contents', 'Documentation contents')}
          className="mb-6 max-h-[calc(100vh-12rem)] overflow-y-auto lg:sticky lg:top-6 lg:mb-0"
        >
          {toc ? (
            <TocTree nodes={toc.toc} current={currentPath} />
          ) : (
            <LoadingSpinner message={t('admin.docs.loading', 'Loading documentation...')} />
          )}
        </nav>

        <main className="min-w-0" ref={contentRef}>
          {searching ? (
            <section aria-live="polite">
              <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                {t('admin.docs.searchResults', 'Search results')}
              </h2>
              <SearchResults
                query={query.trim()}
                results={search.results}
                loading={search.loading}
                error={search.error}
                onPick={() => setQuery('')}
                t={t}
              />
            </section>
          ) : pageError ? (
            <div
              role="alert"
              className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400"
            >
              {pageError}{' '}
              <Link to={docsRoute(HOME_PAGE)} className="underline">
                {t('admin.docs.backHome', 'Go to the documentation start page')}
              </Link>
            </div>
          ) : !page ? (
            <LoadingSpinner message={t('admin.docs.loadingPage', 'Loading page...')} />
          ) : (
            // Documentation links navigate within the admin UI.
            // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions
            <article
              className="prose prose-sm sm:prose-base dark:prose-invert max-w-none prose-headings:scroll-mt-6 prose-headings:text-gray-900 dark:prose-headings:text-white prose-a:text-indigo-600 dark:prose-a:text-indigo-400 prose-img:rounded-md prose-img:border prose-img:border-gray-200 dark:prose-img:border-gray-700 prose-code:before:content-none prose-code:after:content-none"
              onClick={event => handleDocsLinkClick(event, navigate)}
              // Sanitized by renderMarkdown (DOMPurify).
              dangerouslySetInnerHTML={{ __html: html }}
            />
          )}
        </main>
      </div>
    </div>
  );
}

export default AdminDocsPage;
