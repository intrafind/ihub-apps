// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../../shared/components/Icon';
import { HINT_CLASS, INPUT_CLASS, LABEL_CLASS, SECONDARY_BUTTON } from './dialogStyles';

/** Choices of the crawl options (the server's bounds: 200 pages, depth 3). */
const DEPTH_CHOICES = [1, 2, 3];
const PAGE_CHOICES = [25, 50, 100, 200];
const DEFAULT_DEPTH = 2;
const DEFAULT_MAX_PAGES = 50;

/**
 * "Find pages" in the URL tab: follows the links of the page in the URL field
 * that stay on the same site, lists the pages found, and lets the user tick
 * the ones to add — each becomes its own URL item.
 *
 * The list belongs to the URL it was found for: a crawl that answers after
 * the URL was edited is dropped, and editing the URL clears the list (the
 * picker clears the selection with it).
 *
 * @param {Object} props
 * @param {string} props.url - The URL in the field.
 * @param {(url: string, options: {maxPages: number, maxDepth: number, samePath: boolean})
 *   => Promise<{ok: boolean, pages?: Array<Object>, truncated?: boolean, error?: string}>}
 *   props.crawlUrl
 * @param {(error: Error) => string} props.errorMessage
 * @param {Array<{url: string, title?: string}>} props.selected
 * @param {(selected: Array<{url: string, title?: string}>) => void} props.onSelectedChange
 * @param {(url: string, title?: string) => void} [props.onPreview]
 * @param {Set<string>} [props.existingUrls] - URLs the project has already.
 * @returns {JSX.Element}
 */
function SiteCrawlPanel({
  url,
  crawlUrl,
  errorMessage,
  selected,
  onSelectedChange,
  onPreview,
  existingUrls
}) {
  const { t } = useTranslation();
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
  const isExisting = page => Boolean(existingUrls?.has(page.url));
  const selectable = visible.filter(page => !isExisting(page));

  const toggle = page => {
    onSelectedChange(
      selectedUrls.has(page.url)
        ? selected.filter(entry => entry.url !== page.url)
        : [...selected, { url: page.url, title: page.title }]
    );
  };
  const selectAllVisible = () => {
    const added = selectable
      .filter(page => !selectedUrls.has(page.url))
      .map(page => ({ url: page.url, title: page.title }));
    onSelectedChange([...selected, ...added]);
  };
  const clearVisible = () => {
    const shown = new Set(visible.map(page => page.url));
    onSelectedChange(selected.filter(entry => !shown.has(entry.url)));
  };

  return (
    <fieldset className="rounded-lg border border-gray-200 dark:border-gray-700 p-3 space-y-3">
      <legend className="px-1 text-sm font-medium text-gray-700 dark:text-gray-300">
        {t('projects.addItem.crawlTitle', 'More pages of this website')}
      </legend>
      <p className={`${HINT_CLASS} mt-0`}>
        {t(
          'projects.addItem.crawlHint',
          'Follows the links of the page above that stay on the same website and lists the pages found. Tick the pages to add: each becomes its own item.'
        )}
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="project-item-crawl-depth" className={LABEL_CLASS}>
            {t('projects.addItem.crawlDepth', 'Link depth')}
          </label>
          <select
            id="project-item-crawl-depth"
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
          <label htmlFor="project-item-crawl-pages" className={LABEL_CLASS}>
            {t('projects.addItem.crawlMaxPages', 'At most')}
          </label>
          <select
            id="project-item-crawl-pages"
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
          {t('projects.addItem.crawlSamePath', 'Only pages below this address')}
        </label>
        <button
          type="button"
          onClick={() => void run()}
          disabled={!url.trim() || crawl?.loading}
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
        <div className="space-y-2">
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
              disabled={selectable.length === 0}
              className={SECONDARY_BUTTON}
            >
              {t('projects.addItem.crawlSelectAll', 'Select all')}
            </button>
            <button
              type="button"
              onClick={clearVisible}
              disabled={selected.length === 0}
              className={SECONDARY_BUTTON}
            >
              {t('projects.addItem.crawlSelectNone', 'Select none')}
            </button>
          </div>
          <p className="text-xs text-gray-600 dark:text-gray-400" aria-live="polite">
            {t('projects.addItem.crawlSummary', '{{selected}} of {{count}} pages selected', {
              selected: selected.length,
              count: pages.length
            })}
            {crawl.truncated &&
              ` ${t(
                'projects.addItem.crawlTruncated',
                'The search stopped at its limit; raise it or start from a deeper address to find more.'
              )}`}
          </p>
          <ul
            className="max-h-64 overflow-y-auto border border-gray-200 dark:border-gray-700 rounded-md divide-y divide-gray-100 dark:divide-gray-700"
            data-testid="crawl-results"
          >
            {visible.length === 0 && (
              <li className="p-3 text-sm text-gray-500 dark:text-gray-400">
                {t('projects.addItem.crawlNoPages', 'No pages found.')}
              </li>
            )}
            {visible.map(page => {
              const existing = isExisting(page);
              const label = page.title || page.url;
              return (
                <li key={page.url} className="flex items-center gap-2 px-3 py-2">
                  <label
                    className={`flex items-center gap-3 flex-1 min-w-0 text-sm ${
                      existing ? 'opacity-60' : ''
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={existing || selectedUrls.has(page.url)}
                      onChange={() => toggle(page)}
                      disabled={existing}
                      className="h-4 w-4 text-indigo-600 border-gray-300 rounded-sm focus:ring-indigo-500"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-gray-900 dark:text-gray-100">
                        {label}
                      </span>
                      {page.title && (
                        <span className="block truncate text-xs text-gray-500 dark:text-gray-400">
                          {page.url}
                        </span>
                      )}
                    </span>
                    {page.type === 'document' && (
                      <span className="text-xs text-gray-500 dark:text-gray-400">PDF</span>
                    )}
                    {existing && (
                      <span className="text-xs text-gray-500 dark:text-gray-400">
                        {t('projects.addItem.crawlAlready', 'Already added')}
                      </span>
                    )}
                  </label>
                  {onPreview && (
                    <button
                      type="button"
                      onClick={() => onPreview(page.url, page.title)}
                      title={t('projects.addItem.preview', 'Preview')}
                      aria-label={t('projects.addItem.previewPage', 'Preview {{title}}', {
                        title: label
                      })}
                      className="p-1 rounded text-gray-500 hover:text-indigo-600 hover:bg-gray-100 dark:hover:bg-gray-700"
                    >
                      <Icon name="eye" size="sm" />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </fieldset>
  );
}

export default SiteCrawlPanel;
