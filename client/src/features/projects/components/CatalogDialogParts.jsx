// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { CATALOG_SOURCE_STYLES, catalogSourceLabel } from './CatalogEntryRow';

const CHIP_BASE =
  'shrink-0 inline-flex items-center gap-1.5 rounded-full border px-2.5 min-h-11 sm:min-h-8 text-sm font-medium whitespace-nowrap transition-colors focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-800 [@media(max-height:560px)]:min-h-8';
const CHIP_SELECTED = `${CHIP_BASE} bg-indigo-600 border-indigo-600 text-white`;
const CHIP_IDLE = `${CHIP_BASE} bg-white border-gray-300 text-gray-700 hover:bg-gray-50 dark:bg-gray-700 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-600`;
const COUNT_SELECTED = 'bg-white/20';
const COUNT_IDLE = 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300';
const NOTICE_ROW = 'px-4 sm:px-6 py-3 border-t border-gray-100 dark:border-gray-700 text-sm';

export const LINK_BUTTON =
  'font-medium text-indigo-600 dark:text-indigo-400 hover:underline rounded-sm focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500';

/**
 * One filter chip: a source (or All) with the number of entries that match
 * the search.
 *
 * @param {Object} props
 * @param {string} props.source - A catalog source, or `all`.
 * @param {boolean} props.selected
 * @param {number|null} props.count - `null` while the source is loading.
 * @param {(source: string) => void} props.onSelect
 * @returns {JSX.Element}
 */
function SourceChip({ source, selected, count, onSelect }) {
  const { t } = useTranslation();
  const dimmed = !selected && count === 0;
  const label =
    source === 'all' ? t('projects.catalog.chips.all', 'All') : catalogSourceLabel(source, t);
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={() => onSelect(source)}
      className={`${selected ? CHIP_SELECTED : CHIP_IDLE} ${dimmed ? 'opacity-60' : ''}`}
    >
      {source !== 'all' && (
        <Icon
          name={CATALOG_SOURCE_STYLES[source].icon}
          size="xs"
          aria-hidden="true"
          className={selected ? 'text-white' : ''}
        />
      )}
      {label}
      <span
        className={`tabular-nums text-xs rounded-full px-1.5 min-w-5 text-center ${
          selected ? COUNT_SELECTED : COUNT_IDLE
        }`}
      >
        {count ?? '…'}
      </span>
    </button>
  );
}

/**
 * The source filter: All plus one chip per source. On narrow and short
 * screens the chips stay on one line and scroll sideways.
 *
 * @param {Object} props
 * @param {string[]} props.sources - The sources to offer, in order.
 * @param {string} props.activeSource - `all` or one of the sources.
 * @param {Object<string, number>} props.counts - Matches per source.
 * @param {number} props.total - Matches over all sources.
 * @param {string[]} [props.pendingSources=[]] - Sources still loading (no count yet).
 * @param {(source: string) => void} props.onSelect
 * @returns {JSX.Element}
 */
export function SourceChips({
  sources,
  activeSource,
  counts,
  total,
  pendingSources = [],
  onSelect
}) {
  const { t } = useTranslation();
  const countOf = source => {
    if (source === 'all') return total;
    if (pendingSources.includes(source)) return null;
    return counts[source] ?? 0;
  };
  return (
    <fieldset className="min-w-0 m-0 p-0 border-0">
      <legend className="sr-only">{t('projects.catalog.filterLabel', 'Show')}</legend>
      <div className="-mx-4 px-4 sm:mx-0 sm:px-0 flex gap-2 overflow-x-auto sm:flex-wrap [@media(max-height:560px)]:flex-nowrap [scrollbar-width:none]">
        {['all', ...sources].map(source => (
          <SourceChip
            key={source}
            source={source}
            selected={activeSource === source}
            count={countOf(source)}
            onSelect={onSelect}
          />
        ))}
      </div>
    </fieldset>
  );
}

/**
 * "How adding works": the explanations, folded away so they take no room.
 *
 * @param {Object} props
 * @param {string[]} props.hints
 * @returns {JSX.Element|null}
 */
export function HowItWorks({ hints }) {
  const { t } = useTranslation();
  if (hints.length === 0) return null;
  return (
    <details className="group px-4 sm:px-6 py-2 text-sm text-gray-600 dark:text-gray-400">
      <summary className="inline-flex items-center gap-1 cursor-pointer select-none font-medium text-gray-700 dark:text-gray-300 rounded-sm focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500 [&::-webkit-details-marker]:hidden list-none">
        <Icon
          name="chevron-right"
          size="xs"
          className="transition-transform group-open:rotate-90"
        />
        {t('projects.catalog.howItWorks', 'How adding works')}
      </summary>
      <div className="mt-1 space-y-1">
        {hints.map(text => (
          <p key={text}>{text}</p>
        ))}
      </div>
    </details>
  );
}

/**
 * The state of the iFinder smart collections while they are not simply
 * listed: loading, failed, or iFinder could not be reached.
 *
 * @param {Object} props
 * @param {'loading'|'error'|'ready'} props.status
 * @param {string|null} props.error
 * @param {() => void} props.onRetry
 * @returns {JSX.Element}
 */
export function CollectionsNotice({ status, error, onRetry }) {
  const { t } = useTranslation();
  if (status === 'loading') {
    return (
      <p className={`${NOTICE_ROW} text-gray-500 dark:text-gray-400`}>
        {t('projects.catalog.collectionsLoading', 'Loading your iFinder smart collections…')}
      </p>
    );
  }
  const failed = status === 'error';
  const message = failed
    ? error
    : t(
        'projects.catalog.collectionsUnavailable',
        'iFinder could not be reached, so your smart collections are missing from this list.'
      );
  return (
    <p
      role={failed ? 'alert' : undefined}
      className={`${NOTICE_ROW} flex items-start gap-2 ${
        failed ? 'text-red-600 dark:text-red-400' : 'text-amber-700 dark:text-amber-300'
      }`}
    >
      <Icon name="exclamation-triangle" size="sm" className="mt-0.5 flex-none" />
      <span className="flex-1">{message}</span>
      <button type="button" onClick={onRetry} className={LINK_BUTTON}>
        {t('common.retry', 'Retry')}
      </button>
    </p>
  );
}

/**
 * The published projects could not be loaded.
 *
 * @param {Object} props
 * @param {string|null} props.error
 * @param {() => void} props.onRetry
 * @returns {JSX.Element}
 */
export function CatalogError({ error, onRetry }) {
  const { t } = useTranslation();
  return (
    <div
      role="alert"
      className="mx-4 sm:mx-6 my-2 flex items-start gap-2 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/30 px-3 py-2 text-sm text-red-700 dark:text-red-300"
    >
      <Icon name="exclamation-triangle" size="sm" className="mt-0.5 flex-none" />
      <span className="flex-1">{error}</span>
      <button type="button" onClick={onRetry} className={LINK_BUTTON}>
        {t('common.retry', 'Retry')}
      </button>
    </div>
  );
}

/**
 * The text of an empty catalog, by what is switched on.
 *
 * @param {boolean} catalogEnabled
 * @param {boolean} collectionsEnabled
 * @param {Function} t
 * @returns {string}
 */
function emptyText(catalogEnabled, collectionsEnabled, t) {
  if (catalogEnabled && collectionsEnabled) {
    return t(
      'projects.catalog.emptyAll',
      'Nothing has been published yet, and you have no smart collections in iFinder.'
    );
  }
  if (catalogEnabled) return t('projects.catalog.empty', 'Nothing has been published yet.');
  return t('projects.catalog.noCollections', 'You have no smart collections in iFinder.');
}

/**
 * Nothing to list: nothing matches the search or filter (with a way back),
 * or there is nothing in the catalog at all.
 *
 * @param {Object} props
 * @param {string} props.query - The trimmed search.
 * @param {boolean} props.filtered - A search or a source filter is active.
 * @param {boolean} props.catalogEnabled
 * @param {boolean} props.collectionsEnabled
 * @param {() => void} props.onClear - Clears the search and the filter.
 * @returns {JSX.Element}
 */
export function CatalogEmptyState({
  query,
  filtered,
  catalogEnabled,
  collectionsEnabled,
  onClear
}) {
  const { t } = useTranslation();
  if (!filtered) {
    return (
      <p className="px-4 sm:px-6 py-8 text-center text-sm text-gray-600 dark:text-gray-400">
        {emptyText(catalogEnabled, collectionsEnabled, t)}
      </p>
    );
  }
  return (
    <div className="px-4 sm:px-6 py-8 text-center text-sm text-gray-600 dark:text-gray-400 space-y-2">
      <p>
        {query
          ? t('projects.catalog.noMatchesQuery', 'Nothing matches “{{query}}”.', { query })
          : t('projects.catalog.noMatchesFilter', 'Nothing matches this filter.')}
      </p>
      <button type="button" onClick={onClear} className={LINK_BUTTON}>
        {t('projects.catalog.clearFilters', 'Clear search and filter')}
      </button>
    </div>
  );
}
