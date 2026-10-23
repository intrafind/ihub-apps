// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../../shared/components/Icon';
import { comparableUrl } from '../../utils/projectItems';
import CheckableList from './CheckableList';
import { HINT_CLASS, INPUT_CLASS, LABEL_CLASS, SECONDARY_BUTTON } from './dialogStyles';

/** Choices of the crawl options (the server's bounds: 200 pages, depth 3). */
const DEPTH_CHOICES = [1, 2, 3];
const PAGE_CHOICES = [25, 50, 100, 200];
const DEFAULT_DEPTH = 2;
const DEFAULT_MAX_PAGES = 50;

/** The part of a site a crawl searched, as an address: `https://x.com/docs/…`. */
function scopeLabel(scope) {
  if (!scope?.origin) return '';
  const path = scope.path || '/';
  return `${scope.origin}${path}${path.endsWith('/') ? '…' : ''}`;
}

/**
 * "Find more pages" in the URL tab, behind a disclosure so the one-page flow
 * stays short: follows the links of the page in the URL field that stay on
 * the same website, lists the pages found, and lets the user tick the ones
 * to add — each becomes its own URL item.
 *
 * The list belongs to the URL it was found for: a crawl that answers after
 * the URL was edited is dropped, and editing the URL clears the list (the
 * picker clears the selection with it). No more pages can be ticked than the
 * project has room for.
 *
 * @param {Object} props
 * @param {string} props.url - The URL in the field.
 * @param {(url: string, options: {maxPages: number, maxDepth: number, samePath: boolean})
 *   => Promise<{ok: boolean, pages?: Array<Object>, truncated?: boolean,
 *   robotsExcluded?: number, scope?: Object, error?: string}>} props.crawlUrl
 * @param {(error: Error) => string} props.errorMessage
 * @param {Array<{url: string, title?: string}>} props.selected
 * @param {(selected: Array<{url: string, title?: string}>) => void} props.onSelectedChange
 * @param {(url: string, title?: string) => void} [props.onPreview]
 * @param {Set<string>} [props.existingUrls] - `comparableUrl` forms of the
 *   URLs the project has already.
 * @param {number} [props.remaining=Infinity] - Items the project still takes.
 * @param {boolean} [props.busy=false] - The picked pages are being added.
 * @returns {JSX.Element}
 */
function SiteCrawlPanel({
  url,
  crawlUrl,
  errorMessage,
  selected,
  onSelectedChange,
  onPreview,
  existingUrls,
  remaining = Infinity,
  busy = false
}) {
  const { t, i18n } = useTranslation();
  const panelId = useId();
  const [open, setOpen] = useState(selected.length > 0);
  const [depth, setDepth] = useState(DEFAULT_DEPTH);
  const [maxPages, setMaxPages] = useState(DEFAULT_MAX_PAGES);
  const [samePath, setSamePath] = useState(true);
  const [crawl, setCrawl] = useState(null);
  const [filter, setFilter] = useState('');

  // The list answers for the URL it was found for (adjusted during render).
  const [crawlFor, setCrawlFor] = useState(url);
  if (crawlFor !== url) {
    setCrawlFor(url);
    setCrawl(null);
    setFilter('');
  }

  const run = async () => {
    const start = url.trim();
    if (!start || crawl?.loading) return;
    setCrawl({ loading: true, url: start });
    let outcome;
    try {
      outcome = await crawlUrl(start, { maxPages, maxDepth: depth, samePath });
    } catch (err) {
      outcome = { ok: false, error: errorMessage(err) };
    }
    setCrawl(current => (current?.url === start ? { ...outcome, url: start } : current));
  };

  const pages = useMemo(() => (crawl?.ok ? crawl.pages || [] : []), [crawl]);
  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return pages;
    return pages.filter(
      page =>
        page.url.toLowerCase().includes(needle) || (page.title || '').toLowerCase().includes(needle)
    );
  }, [pages, filter]);
  const selectedUrls = new Set(selected.map(page => page.url));
  const isExisting = page => Boolean(existingUrls?.has(comparableUrl(page.url)));
  const existingCount = pages.filter(isExisting).length;
  const selectable = visible.filter(page => !isExisting(page));
  const room = Math.max(0, remaining - selected.length);
  const full = room === 0;

  const toggle = page => {
    onSelectedChange(
      selectedUrls.has(page.url)
        ? selected.filter(entry => entry.url !== page.url)
        : [...selected, { url: page.url, title: page.title }]
    );
  };
  // Ticks the shown pages in list order, as many as the project takes.
  const selectAllVisible = () => {
    const added = selectable
      .filter(page => !selectedUrls.has(page.url))
      .slice(0, room)
      .map(page => ({ url: page.url, title: page.title }));
    onSelectedChange([...selected, ...added]);
  };
  const clearVisible = () => {
    const shown = new Set(visible.map(page => page.url));
    onSelectedChange(selected.filter(entry => !shown.has(entry.url)));
  };

  const formatCount = count => count.toLocaleString(i18n?.language || undefined);
  // What a screen reader announces: the status region exists before its text
  // changes, so the change is read out.
  let status = '';
  if (crawl?.loading) {
    status = t('projects.addItem.crawling', 'Finding pages...');
  } else if (crawl?.ok) {
    status = t('projects.addItem.crawlSummary', '{{selected}} of {{total}} pages selected', {
      selected: formatCount(selected.length),
      total: formatCount(pages.length)
    });
    if (existingCount > 0) {
      status += ` · ${t('projects.addItem.crawlExisting', {
        count: existingCount,
        defaultValue_one: '{{count}} already added',
        defaultValue_other: '{{count}} already added'
      })}`;
    }
    if (Number.isFinite(remaining)) {
      status += ` · ${t('projects.addItem.crawlRoom', {
        count: room,
        defaultValue_one: '{{count}} more fits into the project',
        defaultValue_other: '{{count}} more fit into the project'
      })}`;
    }
  }

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700">
      <button
        type="button"
        onClick={() => setOpen(value => !value)}
        aria-expanded={open}
        aria-controls={panelId}
        className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50 rounded-lg"
      >
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size="sm" />
        {t('projects.addItem.crawlTitle', 'Find more pages of this website')}
        {!open && selected.length > 0 && (
          <span className="ml-auto text-xs font-normal text-gray-600 dark:text-gray-400">
            {t('projects.addItem.crawlPicked', {
              count: selected.length,
              defaultValue_one: '{{count}} page ticked',
              defaultValue_other: '{{count}} pages ticked'
            })}
          </span>
        )}
      </button>

      <div id={panelId} hidden={!open} className="px-3 pb-3 space-y-3">
        <p className={`${HINT_CLASS} mt-0`}>
          {t(
            'projects.addItem.crawlHint',
            'Follows the links of the page above that stay on the same website and lists the pages found. Tick the pages to add: each becomes its own item. Pages the website excludes in its robots.txt are left out.'
          )}
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor={`${panelId}-depth`} className={LABEL_CLASS}>
              {t('projects.addItem.crawlDepth', 'Link depth')}
            </label>
            <select
              id={`${panelId}-depth`}
              value={depth}
              onChange={e => setDepth(Number(e.target.value))}
              className={INPUT_CLASS}
            >
              {DEPTH_CHOICES.map(choice => (
                <option key={choice} value={choice}>
                  {choice}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={`${panelId}-pages`} className={LABEL_CLASS}>
              {t('projects.addItem.crawlMaxPages', 'At most')}
            </label>
            <select
              id={`${panelId}-pages`}
              value={maxPages}
              onChange={e => setMaxPages(Number(e.target.value))}
              className={INPUT_CLASS}
            >
              {PAGE_CHOICES.map(choice => (
                <option key={choice} value={choice}>
                  {t('projects.addItem.crawlPagesOption', '{{count}} pages', { count: choice })}
                </option>
              ))}
            </select>
          </div>
          <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 pb-2">
            <input
              type="checkbox"
              checked={samePath}
              onChange={e => setSamePath(e.target.checked)}
              className="h-4 w-4 text-indigo-600 border-gray-300 rounded-sm focus:ring-indigo-500"
            />
            {t('projects.addItem.crawlSamePath', 'Stay in this part of the website')}
          </label>
          <button
            type="button"
            onClick={() => void run()}
            disabled={!url.trim() || crawl?.loading || busy}
            className={`${SECONDARY_BUTTON} ml-auto inline-flex items-center gap-1.5`}
          >
            {crawl?.loading && <Icon name="arrow-path" size="sm" className="animate-spin" />}
            {crawl?.loading
              ? t('projects.addItem.crawling', 'Finding pages...')
              : t('projects.addItem.crawl', 'Find pages')}
          </button>
        </div>

        {crawl && !crawl.loading && !crawl.ok && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {t('projects.addItem.crawlFailed', 'The website cannot be read: {{error}}', {
              error: crawl.error || ''
            })}
          </p>
        )}

        {crawl?.ok && (
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="search"
              value={filter}
              onChange={e => setFilter(e.target.value)}
              placeholder={t('projects.addItem.crawlFilter', 'Filter pages')}
              aria-label={t('projects.addItem.crawlFilter', 'Filter pages')}
              className={`${INPUT_CLASS} flex-1 min-w-[10rem] py-1.5 text-sm`}
            />
            <button
              type="button"
              onClick={selectAllVisible}
              disabled={selectable.length === 0 || full || busy}
              className={SECONDARY_BUTTON}
            >
              {t('projects.addItem.crawlSelectAll', 'Select all')}
            </button>
            <button
              type="button"
              onClick={clearVisible}
              disabled={selected.length === 0 || busy}
              className={SECONDARY_BUTTON}
            >
              {t('projects.addItem.crawlSelectNone', 'Select none')}
            </button>
          </div>
        )}

        <p
          role="status"
          className="text-xs text-gray-600 dark:text-gray-400"
          data-testid="crawl-status"
        >
          {status}
        </p>

        {crawl?.ok && (
          <>
            {(crawl.scope || crawl.truncated || crawl.robotsExcluded > 0) && (
              <p className="text-xs text-gray-600 dark:text-gray-400">
                {crawl.scope &&
                  t('projects.addItem.crawlScope', 'Searched {{scope}}', {
                    scope: scopeLabel(crawl.scope)
                  })}
                {crawl.robotsExcluded > 0 &&
                  ` ${t('projects.addItem.crawlRobots', {
                    count: crawl.robotsExcluded,
                    defaultValue_one:
                      '{{count}} link was left out because the website excludes it in its robots.txt.',
                    defaultValue_other:
                      '{{count}} links were left out because the website excludes them in its robots.txt.'
                  })}`}
                {crawl.truncated &&
                  ` ${t(
                    'projects.addItem.crawlTruncated',
                    'The search stopped at its limit; raise it or start from a deeper address to find more.'
                  )}`}
              </p>
            )}
            {full && Number.isFinite(remaining) && (
              <p className="text-xs text-amber-700 dark:text-amber-400">
                {t(
                  'projects.addItem.crawlFull',
                  'The project takes no more pages. Untick some, or remove items from the project first.'
                )}
              </p>
            )}
            <CheckableList
              testId="crawl-results"
              emptyText={t('projects.addItem.crawlNoPages', 'No pages found.')}
              rows={visible.map(page => {
                const existing = isExisting(page);
                const checked = existing || selectedUrls.has(page.url);
                const label = page.title || page.url;
                return {
                  key: page.url,
                  checked,
                  muted: existing,
                  disabled: existing || busy || (full && !checked),
                  onToggle: () => toggle(page),
                  content: (
                    <>
                      <span className="block truncate text-gray-900 dark:text-gray-100">
                        {label}
                      </span>
                      {page.title && (
                        <span className="block truncate text-xs text-gray-600 dark:text-gray-400">
                          {page.url}
                        </span>
                      )}
                    </>
                  ),
                  badge: (
                    <>
                      {page.type === 'document' && (
                        <span className="text-xs text-gray-600 dark:text-gray-400">
                          {t('projects.addItem.crawlDocument', 'PDF')}
                        </span>
                      )}
                      {existing && (
                        <span className="text-xs text-gray-600 dark:text-gray-400">
                          {t('projects.addItem.crawlAlready', 'Already added')}
                        </span>
                      )}
                    </>
                  ),
                  action: onPreview && (
                    <button
                      type="button"
                      onClick={() => onPreview(page.url, page.title)}
                      title={t('projects.addItem.preview', 'Preview')}
                      aria-label={t('projects.addItem.previewPage', 'Preview {{title}}', {
                        title: label
                      })}
                      className="p-1 rounded text-gray-600 dark:text-gray-300 hover:text-indigo-600 hover:bg-gray-100 dark:hover:bg-gray-700"
                    >
                      <Icon name="eye" size="sm" />
                    </button>
                  )
                };
              })}
            />
          </>
        )}
      </div>
    </div>
  );
}

export default SiteCrawlPanel;
