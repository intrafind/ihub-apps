// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate, useNavigationType, useParams } from 'react-router-dom';
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  Bars3BottomLeftIcon,
  XMarkIcon
} from '@heroicons/react/24/outline';
import { ChevronRightIcon } from '@heroicons/react/20/solid';
import './AdminDocsPage.css';
import { makeAdminApiCall } from '../../../api/adminApi';
import { renderMarkdown } from '../../../config/marked.config';
import { useCodeBlockInteractions } from '../../../hooks/useCodeBlockInteractions';
import { useMermaidRenderer } from '../../../hooks/useMermaidRenderer';
import LoadingSpinner from '../../../shared/components/LoadingSpinner';
import { useFocusTrap } from '../../../shared/hooks/useFocusTrap';
import DocsNav from '../components/docs/DocsNav';
import DocsOutline from '../components/docs/DocsOutline';
import DocsSearch from '../components/docs/DocsSearch';
import { decodeFragment, handleDocsLinkClick, rewriteDocsHtml } from '../utils/docsLinks';
import { highlightDocsCode } from '../utils/docsHighlight';
import { docsRoute, flattenDocsPages, groupDocsSections, locateDocsPage } from '../utils/docsToc';

/**
 * Admin → Documentation.
 *
 * The documentation that ships with this build (`docs/*.md`), rendered from Markdown as a docs
 * site inside the admin area: a sticky header with the breadcrumb and the search, the contents
 * from `SUMMARY.md` on the left (a drawer on small screens), the page in a reading column with
 * previous/next, and "On this page" on wide screens. Links between pages stay inside the admin UI;
 * links to release notes open What's New. The URL is the page's path
 * (`/admin/docs/integrations.md#migrations`), so a link, a bookmark or a reload lands on the same
 * heading.
 *
 * The admin layout's `<main>` is the only scroller: the header and both side columns stick inside
 * it, and the page scrolls it to the top, to the heading in the URL, or back to where the admin
 * was reading on Back/Forward.
 */

const HOME_PAGE = 'README.md';
const SCROLLER_ID = 'admin-main-content';
/** Admin routes a page's `adminPage` front-matter may link to. */
const ADMIN_ROUTE_RE = /^\/admin(\/[\w-]+)*\/?$/;

const getScroller = () => document.getElementById(SCROLLER_ID);

function Breadcrumb({ trail, t }) {
  return (
    <nav aria-label={t('admin.docs.breadcrumb', 'Breadcrumb')} className="min-w-0">
      <ol className="flex min-w-0 items-center gap-1 text-sm text-gray-500 dark:text-gray-400">
        <li className="shrink-0">
          <Link
            to={docsRoute(HOME_PAGE)}
            className="font-medium text-gray-900 hover:text-indigo-600 dark:text-gray-100 dark:hover:text-indigo-400"
          >
            {t('admin.docs.title', 'Documentation')}
          </Link>
        </li>
        {trail.map((crumb, index) => (
          <li key={`${crumb.title}-${index}`} className="flex min-w-0 items-center gap-1">
            <ChevronRightIcon className="h-4 w-4 shrink-0 text-gray-400" aria-hidden="true" />
            {crumb.path ? (
              <Link
                to={docsRoute(crumb.path)}
                className="truncate hover:text-gray-900 dark:hover:text-gray-100"
              >
                {crumb.title}
              </Link>
            ) : (
              <span className="truncate">{crumb.title}</span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

function PagerLink({ page, direction, t }) {
  const next = direction === 'next';
  return (
    <Link
      to={docsRoute(page.path)}
      rel={next ? 'next' : 'prev'}
      className={`group flex flex-1 flex-col rounded-lg border border-gray-200 px-4 py-3 transition-colors hover:border-indigo-300 hover:bg-indigo-50/40 dark:border-gray-800 dark:hover:border-indigo-700 dark:hover:bg-indigo-950/30 ${
        next ? 'items-end text-right' : 'items-start'
      }`}
    >
      <span className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
        {!next && <ArrowLeftIcon className="h-3.5 w-3.5" aria-hidden="true" />}
        {next ? t('admin.docs.next', 'Next') : t('admin.docs.previous', 'Previous')}
        {next && <ArrowRightIcon className="h-3.5 w-3.5" aria-hidden="true" />}
      </span>
      <span className="mt-0.5 text-sm font-medium text-gray-900 group-hover:text-indigo-700 dark:text-gray-100 dark:group-hover:text-indigo-300">
        {page.title}
      </span>
    </Link>
  );
}

/** The docs home below the introduction: one card per section with its first pages. */
function SectionCards({ sections, t }) {
  const titled = sections.filter(section => section.title && section.items.length > 0);
  if (titled.length === 0) return null;
  return (
    <section aria-labelledby="docs-browse" className="mt-12">
      <h2
        id="docs-browse"
        className="mb-4 text-lg font-semibold tracking-tight text-gray-900 dark:text-gray-100"
      >
        {t('admin.docs.browse', 'Browse the documentation')}
      </h2>
      <ul className="grid gap-4 sm:grid-cols-2">
        {titled.map(section => {
          const pages = flattenDocsPages([section]);
          const shown = pages.slice(0, 4);
          return (
            <li
              key={section.id}
              className="rounded-lg border border-gray-200 p-4 dark:border-gray-800"
            >
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                {pages[0] ? (
                  <Link
                    to={docsRoute(pages[0].path)}
                    className="hover:text-indigo-700 dark:hover:text-indigo-300"
                  >
                    {section.title}
                  </Link>
                ) : (
                  section.title
                )}
              </h3>
              <ul className="mt-2 space-y-1">
                {shown.map(page => (
                  <li key={page.path}>
                    <Link
                      to={docsRoute(page.path)}
                      className="text-sm text-gray-600 hover:text-indigo-700 dark:text-gray-400 dark:hover:text-indigo-300"
                    >
                      {page.title}
                    </Link>
                  </li>
                ))}
              </ul>
              {pages.length > shown.length && (
                <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                  {t('admin.docs.morePages', '+{{count}} more', {
                    count: pages.length - shown.length
                  })}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function ContentsDrawer({ open, onClose, sections, current, t }) {
  const panelRef = useRef(null);
  const closeRef = useRef(null);
  useFocusTrap(panelRef, { isActive: open, initialFocusRef: closeRef });
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = event => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 lg:hidden">
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        className="absolute inset-0 h-full w-full cursor-default bg-gray-900/40"
        onClick={onClose}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('admin.docs.contents', 'Documentation contents')}
        className="absolute inset-y-0 left-0 flex w-80 max-w-[85vw] flex-col bg-white shadow-xl dark:bg-gray-900"
      >
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-gray-200 px-4 dark:border-gray-800">
          <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            {t('admin.docs.contentsShort', 'Contents')}
          </span>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label={t('common.close', 'Close')}
            className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
          >
            <XMarkIcon className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-4">
          <DocsNav sections={sections} current={current} />
        </div>
      </div>
    </div>
  );
}

function AdminDocsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const navigationType = useNavigationType();
  const location = useLocation();
  const params = useParams();
  // React Router already decodes the splat; decoding it again throws on a literal `%`.
  const currentPath = params['*'] || HOME_PAGE;
  const articleRef = useRef(null);
  const titleRef = useRef(null);
  const scrollPositionsRef = useRef(new Map());
  const firstPageShownRef = useRef(false);
  useCodeBlockInteractions();

  const [toc, setToc] = useState(null);
  const [page, setPage] = useState(null);
  const [pageError, setPageError] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);

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

  // The page in the URL. The previous page stays on screen until the next one has arrived, so a
  // click does not flash a spinner and collapse the scroll height.
  useEffect(() => {
    let active = true;
    setPageError('');
    makeAdminApiCall(`/admin/docs/page?path=${encodeURIComponent(currentPath)}`, {
      method: 'GET'
    })
      .then(response => {
        if (active) setPage(response.data);
      })
      .catch(err => {
        if (!active) return;
        setPage(null);
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

  // Close the drawer whenever the page changes.
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname, location.hash]);

  const sections = useMemo(() => groupDocsSections(toc?.toc), [toc]);
  const pages = useMemo(() => flattenDocsPages(sections), [sections]);
  const { entry, previous, next } = useMemo(
    () => locateDocsPage(pages, currentPath),
    [pages, currentPath]
  );

  const pageReady = page && page.path === currentPath;
  const html = useMemo(
    () =>
      page
        ? renderMarkdown(page.markdown, {
            t,
            breaks: false,
            transformHtml: rendered =>
              rewriteDocsHtml(rendered, page.path, {
                headingIds: true,
                docsComponents: true,
                dropLeadingH1: true,
                anchorLabel: t('admin.docs.linkToSection', 'Link to this section')
              })
          })
        : '',
    [page, t]
  );

  useMermaidRenderer({ t });

  useEffect(() => {
    if (html && articleRef.current) highlightDocsCode(articleRef.current).catch(() => {});
  }, [html]);

  // Remember where the admin was reading, per history entry, for Back/Forward. Positions are only
  // recorded while the entry's page is on screen: the admin layout resets the scroller when the
  // path changes, and that reset must not overwrite the position of the entry being left.
  const entryKeyRef = useRef(location.key);
  const entryLandedRef = useRef(false);
  useEffect(() => {
    const scroller = getScroller();
    if (!scroller) return undefined;
    const onScroll = () => {
      if (entryLandedRef.current)
        scrollPositionsRef.current.set(entryKeyRef.current, scroller.scrollTop);
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  }, []);

  // Leaving a history entry: keep its position. Layout effects of this page run before the
  // admin layout's reset (a passive effect of the parent), so the position is still intact.
  useLayoutEffect(() => {
    if (entryKeyRef.current === location.key) return;
    const scroller = getScroller();
    if (scroller && entryLandedRef.current) {
      scrollPositionsRef.current.set(entryKeyRef.current, scroller.scrollTop);
    }
    entryKeyRef.current = location.key;
    entryLandedRef.current = false;
  }, [location.key]);

  // Land on the heading in the URL, on the remembered position (Back/Forward), or at the top.
  // Runs before paint so the new page never shows at the old position.
  useLayoutEffect(() => {
    if (!pageReady || !html) return;
    const scroller = getScroller();
    if (!scroller) return;
    const id = location.hash ? decodeFragment(location.hash.slice(1)) : '';
    const target = id ? document.getElementById(id) : null;
    const remembered = scrollPositionsRef.current.get(location.key);
    if (navigationType === 'POP' && remembered !== undefined) {
      scroller.scrollTop = remembered;
    } else if (target && typeof target.scrollIntoView === 'function') {
      // Headings carry a scroll margin for the sticky header.
      target.scrollIntoView({ block: 'start' });
    } else {
      scroller.scrollTop = 0;
    }
    entryLandedRef.current = true;
    // Move focus to the new page for keyboard and screen-reader users, except on first load.
    if (firstPageShownRef.current && !id) titleRef.current?.focus({ preventScroll: true });
    firstPageShownRef.current = true;
  }, [pageReady, html, location.key, location.hash, navigationType]);

  useEffect(() => {
    if (page?.title) {
      document.title = `${page.title} · ${t('admin.docs.title', 'Documentation')}`;
    }
  }, [page, t]);

  const trail = [
    ...(entry?.section?.title ? [{ title: entry.section.title, path: null }] : []),
    ...(entry?.ancestors || []).filter(ancestor => ancestor.path !== HOME_PAGE)
  ];
  const isHome = currentPath === HOME_PAGE;
  const title = page?.title || entry?.title || '';
  const description = page?.description || entry?.description || '';
  const adminPage =
    typeof page?.adminPage === 'string' && ADMIN_ROUTE_RE.test(page.adminPage)
      ? page.adminPage
      : null;

  return (
    <div className="min-h-full bg-white dark:bg-gray-900">
      {/* Docs header: sticks to the top of the admin scroller. */}
      <div className="sticky top-0 z-20 border-b border-gray-200 bg-white/90 backdrop-blur-sm dark:border-gray-800 dark:bg-gray-900/90">
        <div className="flex h-14 items-center gap-3 px-4 sm:px-6">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            className="-ml-1.5 inline-flex items-center gap-1.5 rounded-md p-1.5 text-sm text-gray-600 hover:bg-gray-100 lg:hidden dark:text-gray-300 dark:hover:bg-gray-800"
            aria-haspopup="dialog"
            aria-expanded={drawerOpen}
          >
            <Bars3BottomLeftIcon className="h-5 w-5" aria-hidden="true" />
            <span className="sr-only sm:not-sr-only">
              {t('admin.docs.contentsShort', 'Contents')}
            </span>
          </button>
          <div className="hidden min-w-0 flex-1 sm:block">
            <Breadcrumb trail={isHome ? [] : [...trail, { title, path: null }]} t={t} />
          </div>
          <div className="ml-auto w-full max-w-xs sm:w-72">
            <DocsSearch />
          </div>
        </div>
      </div>

      <div className="lg:grid lg:grid-cols-[17rem_minmax(0,1fr)] xl:grid-cols-[17rem_minmax(0,1fr)_14rem]">
        {/* Contents: full height of the scroller below the header, its own scroll. */}
        <aside className="hidden border-r border-gray-200 lg:block dark:border-gray-800">
          <div className="sticky top-14 h-[calc(100dvh-3.5rem)] overflow-y-auto overscroll-contain px-4 py-6">
            {toc ? (
              <DocsNav sections={sections} current={currentPath} />
            ) : (
              <LoadingSpinner message={t('admin.docs.loading', 'Loading documentation...')} />
            )}
          </div>
        </aside>

        <div className="min-w-0 px-4 py-8 sm:px-8 lg:px-12">
          <div className="mx-auto max-w-[46rem]">
            {pageError ? (
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
              <>
                <header className="mb-8">
                  {!isHome && trail.length > 0 && (
                    <p className="mb-2 text-sm font-medium text-indigo-600 dark:text-indigo-400">
                      {trail[0].title}
                    </p>
                  )}
                  <h1
                    ref={titleRef}
                    tabIndex={-1}
                    className="text-3xl font-bold tracking-tight text-gray-900 focus:outline-hidden sm:text-4xl dark:text-white"
                  >
                    {title}
                  </h1>
                  {description && (
                    <p className="mt-3 text-lg leading-relaxed text-gray-600 dark:text-gray-400">
                      {description}
                    </p>
                  )}
                  {adminPage && (
                    <Link
                      to={adminPage}
                      className="mt-4 inline-flex items-center gap-1.5 rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
                    >
                      {t('admin.docs.openSettings', 'Open in admin')}
                      <ArrowRightIcon className="h-4 w-4" aria-hidden="true" />
                    </Link>
                  )}
                </header>

                {/* Documentation links navigate within the admin UI. */}
                {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions */}
                <article
                  ref={articleRef}
                  className="docs-prose prose prose-gray max-w-none dark:prose-invert prose-headings:font-semibold prose-headings:tracking-tight prose-headings:text-gray-900 dark:prose-headings:text-white prose-h2:text-2xl prose-h3:text-lg prose-p:leading-7"
                  onClick={event => handleDocsLinkClick(event, navigate)}
                  // Sanitized by renderMarkdown (DOMPurify).
                  dangerouslySetInnerHTML={{ __html: html }}
                />

                {isHome && <SectionCards sections={sections} t={t} />}

                {(previous || next) && (
                  <nav
                    aria-label={t('admin.docs.pagination', 'Previous and next page')}
                    className="mt-16 flex flex-col gap-3 border-t border-gray-200 pt-6 sm:flex-row dark:border-gray-800"
                  >
                    {previous ? (
                      <PagerLink page={previous} direction="previous" t={t} />
                    ) : (
                      <span className="flex-1" />
                    )}
                    {next ? (
                      <PagerLink page={next} direction="next" t={t} />
                    ) : (
                      <span className="flex-1" />
                    )}
                  </nav>
                )}
              </>
            )}
          </div>
        </div>

        <aside className="hidden xl:block">
          <div className="sticky top-14 max-h-[calc(100dvh-3.5rem)] overflow-y-auto px-4 py-8">
            {pageReady && (
              <DocsOutline
                articleRef={articleRef}
                scrollerId={SCROLLER_ID}
                path={currentPath}
                html={html}
              />
            )}
          </div>
        </aside>
      </div>

      <ContentsDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        sections={sections}
        current={currentPath}
        t={t}
      />
    </div>
  );
}

export default AdminDocsPage;
