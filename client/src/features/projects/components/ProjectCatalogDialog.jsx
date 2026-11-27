// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../../../shared/components/Modal';
import Icon from '../../../shared/components/Icon';
import {
  addCatalogProject,
  addSmartCollection,
  fetchProjectCatalog,
  fetchSmartCollections,
  removeCatalogProject
} from '../../../api';
import { projectErrorMessage } from '../utils/projectErrors';
import {
  availableSources,
  collectionEntry,
  filterCatalogEntries,
  projectEntry
} from '../utils/catalogSources';
import { INPUT_CLASS } from './item-dialog/dialogStyles';
import CatalogEntryRow, { CATALOG_SOURCE_STYLES, catalogSourceLabel } from './CatalogEntryRow';

const CHIP_BASE =
  'shrink-0 inline-flex items-center gap-1.5 rounded-full border px-2.5 min-h-11 sm:min-h-8 text-sm font-medium whitespace-nowrap transition-colors focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-800 [@media(max-height:560px)]:min-h-8';
const CHIP_SELECTED = `${CHIP_BASE} bg-indigo-600 border-indigo-600 text-white`;
const CHIP_IDLE = `${CHIP_BASE} bg-white border-gray-300 text-gray-700 hover:bg-gray-50 dark:bg-gray-700 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-600`;
const LINK_BUTTON =
  'font-medium text-indigo-600 dark:text-indigo-400 hover:underline rounded-sm focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500';

/** Delay before the result count is announced, so typing is not read out letter by letter. */
const ANNOUNCE_DELAY_MS = 600;

/**
 * The project catalog: what the viewer can add to their projects, in one
 * list ordered by where it comes from — the viewer's own iFinder smart
 * collections (where that tier is offered), projects the administrators made
 * available to everyone, projects colleagues published, and published
 * projects that are in their list already. Each entry carries a badge that
 * names its source.
 *
 * The header (title, close, search, source filter) stays in place and only
 * the list scrolls, so the dialog works on short screens too; below the `sm`
 * breakpoint it fills the screen. The search and the filter work on the
 * loaded lists, so the source counts follow every keystroke.
 *
 * Mount it only while open.
 *
 * @param {Object} props
 * @param {() => void} props.onClose
 * @param {() => void} props.onChanged - Called after a project was added or removed.
 * @param {boolean} [props.catalogEnabled=true] - The catalog of published projects is on.
 * @param {boolean} [props.collectionsEnabled=false] - The iFinder tier is offered to the viewer.
 * @returns {JSX.Element}
 */
function ProjectCatalogDialog({
  onClose,
  onChanged,
  catalogEnabled = true,
  collectionsEnabled = false
}) {
  const { t, i18n } = useTranslation();
  const language = i18n?.language || 'en';
  const [query, setQuery] = useState('');
  const [source, setSource] = useState('all');
  // { status: 'loading'|'ready'|'error', items, error }
  const [catalog, setCatalog] = useState({ status: 'loading', items: [], error: null });
  // { status: 'loading'|'ready'|'error', items, warnings, error }
  const [collections, setCollections] = useState({
    status: 'loading',
    items: [],
    warnings: [],
    error: null
  });
  const [catalogAttempt, setCatalogAttempt] = useState(0);
  const [collectionsAttempt, setCollectionsAttempt] = useState(0);
  const [busyKey, setBusyKey] = useState(null);
  const [rowErrors, setRowErrors] = useState({});
  const [announcement, setAnnouncement] = useState('');
  const searchRef = useRef(null);

  useEffect(() => {
    if (!catalogEnabled) return undefined;
    let active = true;
    fetchProjectCatalog()
      .then(result => {
        if (active) setCatalog({ status: 'ready', items: result?.items || [], error: null });
      })
      .catch(err => {
        if (active) setCatalog({ status: 'error', items: [], error: projectErrorMessage(err, t) });
      });
    return () => {
      active = false;
    };
  }, [catalogEnabled, catalogAttempt, t]);

  useEffect(() => {
    if (!collectionsEnabled) return undefined;
    let active = true;
    fetchSmartCollections()
      .then(result => {
        if (!active) return;
        setCollections({
          status: 'ready',
          items: result?.items || [],
          warnings: result?.warnings || [],
          error: null
        });
      })
      .catch(err => {
        if (!active) return;
        setCollections({
          status: 'error',
          items: [],
          warnings: [],
          error: projectErrorMessage(err, t)
        });
      });
    return () => {
      active = false;
    };
  }, [collectionsEnabled, collectionsAttempt, t]);

  const entries = useMemo(
    () => [
      ...(catalogEnabled ? catalog.items.map(project => projectEntry(project, language)) : []),
      ...(collectionsEnabled ? collections.items.map(collectionEntry) : [])
    ],
    [catalogEnabled, catalog.items, collectionsEnabled, collections.items, language]
  );

  // The iFinder chip stays while it loads or has something to say, so it does
  // not appear late and a warning is not lost. A viewer the tier is not
  // offered to (`available: false`, no warning) gets no chip.
  const collectionsNotice =
    collectionsEnabled && (collections.status !== 'ready' || collections.warnings.length > 0);
  const sources = availableSources(entries, collectionsNotice ? ['ifinder'] : []);
  const activeSource = source !== 'all' && sources.includes(source) ? source : 'all';
  const matches = filterCatalogEntries(entries, query);
  const countBySource = {};
  for (const entry of matches) countBySource[entry.source] = (countBySource[entry.source] || 0) + 1;
  const shown =
    activeSource === 'all' ? matches : matches.filter(entry => entry.source === activeSource);
  const showCollectionsNotice =
    collectionsNotice && (activeSource === 'all' || activeSource === 'ifinder');
  const catalogLoading = catalogEnabled && catalog.status === 'loading';
  const showCatalogError =
    catalogEnabled && catalog.status === 'error' && activeSource !== 'ifinder';
  const settled = !catalogLoading && !(collectionsEnabled && collections.status === 'loading');
  const shownCount = shown.length;
  const filtered = query.trim() !== '' || activeSource !== 'all';

  const resultText = t('projects.catalog.resultCount', '{{count}} results', {
    count: shownCount
  });
  useEffect(() => {
    if (!settled) return undefined;
    const handle = setTimeout(() => setAnnouncement(resultText), ANNOUNCE_DELAY_MS);
    return () => clearTimeout(handle);
  }, [resultText, settled]);

  /** Loads the catalog again (after it failed). */
  const retryCatalog = () => {
    setCatalog(previous => ({ ...previous, status: 'loading', error: null }));
    setCatalogAttempt(n => n + 1);
  };

  /** Loads the smart collections again (after iFinder failed or warned). */
  const retryCollections = () => {
    setCollections(previous => ({ ...previous, status: 'loading', error: null }));
    setCollectionsAttempt(n => n + 1);
  };

  const clearFilters = () => {
    setQuery('');
    setSource('all');
    searchRef.current?.focus();
  };

  const toggle = useCallback(
    async entry => {
      setBusyKey(entry.key);
      setRowErrors(previous => ({ ...previous, [entry.key]: null }));
      try {
        if (entry.kind === 'collection') {
          const project = await addSmartCollection({ collectionId: entry.id });
          setCollections(previous => ({
            ...previous,
            items: previous.items.map(item =>
              item.collectionId === entry.id
                ? { ...item, added: true, projectId: project.id }
                : item
            )
          }));
        } else {
          const subscribed = entry.status === 'added';
          if (subscribed) await removeCatalogProject(entry.id);
          else await addCatalogProject(entry.id);
          setCatalog(previous => ({
            ...previous,
            items: previous.items.map(item =>
              item.id === entry.id ? { ...item, subscribed: !subscribed } : item
            )
          }));
        }
        onChanged();
      } catch (err) {
        setRowErrors(previous => ({ ...previous, [entry.key]: projectErrorMessage(err, t) }));
      } finally {
        setBusyKey(null);
      }
    },
    [onChanged, t]
  );

  const hint = [
    catalogEnabled
      ? t(
          'projects.catalog.dialogHint',
          'Projects published for everyone, by their owners or by the administrators: add one to your projects to use it in your chats. Whoever published it keeps it up to date.'
        )
      : null,
    collectionsEnabled
      ? t(
          'projects.catalog.collectionsHint',
          'Add a collection to your projects to chat with it, with a default app and instructions of its own. Its documents stay in iFinder.'
        )
      : null
  ].filter(Boolean);

  let emptyState = null;
  if (settled && shownCount === 0 && !showCollectionsNotice && !showCatalogError) {
    emptyState = filtered ? (
      <div className="px-4 sm:px-6 py-8 text-center text-sm text-gray-600 dark:text-gray-400 space-y-2">
        <p>
          {query.trim()
            ? t('projects.catalog.noMatchesQuery', 'Nothing matches “{{query}}”.', {
                query: query.trim()
              })
            : t('projects.catalog.noMatchesFilter', 'Nothing matches this filter.')}
        </p>
        <button type="button" onClick={clearFilters} className={LINK_BUTTON}>
          {t('projects.catalog.clearFilters', 'Clear search and filter')}
        </button>
      </div>
    ) : (
      <p className="px-4 sm:px-6 py-8 text-center text-sm text-gray-600 dark:text-gray-400">
        {catalogEnabled && collectionsEnabled
          ? t(
              'projects.catalog.emptyAll',
              'Nothing has been published yet, and you have no smart collections in iFinder.'
            )
          : catalogEnabled
            ? t('projects.catalog.empty', 'Nothing has been published yet.')
            : t('projects.catalog.noCollections', 'You have no smart collections in iFinder.')}
      </p>
    );
  }

  return (
    <Modal
      isOpen
      onClose={onClose}
      maxWidthClassName="max-w-3xl"
      // Below `sm`, and on screens of little height, the dialog fills the screen.
      // Otherwise it keeps one height, so the search does not move while typing.
      overlayPaddingClassName="p-0 sm:[@media(min-height:561px)]:p-4"
      maxHeightClassName="max-h-dvh sm:[@media(min-height:561px)]:max-h-[90dvh]"
      panelClassName="h-dvh sm:h-[min(90dvh,48rem)] max-sm:rounded-none [@media(max-height:560px)]:h-dvh [@media(max-height:560px)]:rounded-none"
      labelledBy="project-catalog-dialog-title"
      initialFocusRef={searchRef}
    >
      <div className="flex-none space-y-3 px-4 pt-4 pb-3 sm:px-6 sm:pt-5 border-b border-gray-200 dark:border-gray-700 [@media(max-height:560px)]:space-y-2 [@media(max-height:560px)]:pt-2 [@media(max-height:560px)]:pb-2">
        <div className="flex items-center gap-3">
          <h2
            id="project-catalog-dialog-title"
            className="flex-1 min-w-0 truncate text-lg font-semibold text-gray-900 dark:text-gray-100 [@media(max-height:560px)]:text-base"
          >
            {t('projects.catalog.dialogTitle', 'Project catalog')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close', 'Close')}
            className="-mr-2 grid place-items-center size-11 sm:size-9 rounded-lg text-gray-500 hover:text-gray-700 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-200 dark:hover:bg-gray-700 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500"
          >
            <Icon name="x" size="md" />
          </button>
        </div>
        <input
          ref={searchRef}
          type="search"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={t('projects.catalog.search', 'Search the catalog')}
          aria-label={t('projects.catalog.search', 'Search the catalog')}
          className={INPUT_CLASS}
        />
        {sources.length > 1 && (
          <div
            role="group"
            aria-label={t('projects.catalog.filterLabel', 'Show')}
            className="-mx-4 px-4 sm:mx-0 sm:px-0 flex gap-2 overflow-x-auto sm:flex-wrap [@media(max-height:560px)]:flex-nowrap [scrollbar-width:none]"
          >
            {['all', ...sources].map(key => {
              const selected = activeSource === key;
              const count = key === 'all' ? matches.length : (countBySource[key] ?? 0);
              const pending = key === 'ifinder' && collections.status === 'loading';
              return (
                <button
                  key={key}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setSource(key)}
                  className={`${selected ? CHIP_SELECTED : CHIP_IDLE} ${
                    !selected && count === 0 && !pending ? 'opacity-60' : ''
                  }`}
                >
                  {key !== 'all' && (
                    <Icon
                      name={CATALOG_SOURCE_STYLES[key].icon}
                      size="xs"
                      aria-hidden="true"
                      className={selected ? 'text-white' : ''}
                    />
                  )}
                  {key === 'all'
                    ? t('projects.catalog.chips.all', 'All')
                    : catalogSourceLabel(key, t)}
                  <span
                    className={`tabular-nums text-xs rounded-full px-1.5 min-w-5 text-center ${
                      selected
                        ? 'bg-white/20'
                        : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300'
                    }`}
                  >
                    {pending ? '…' : count}
                  </span>
                </button>
              );
            })}
          </div>
        )}
        <p role="status" aria-live="polite" className="sr-only">
          {announcement}
        </p>
      </div>

      <div
        className="flex-1 min-h-0 overflow-y-auto overscroll-contain pb-[env(safe-area-inset-bottom)]"
        data-testid="catalog-results"
      >
        {hint.length > 0 && (
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
              {hint.map(text => (
                <p key={text}>{text}</p>
              ))}
            </div>
          </details>
        )}

        {showCollectionsNotice &&
          (collections.status === 'loading' ? (
            <p className="px-4 sm:px-6 py-3 border-t border-gray-100 dark:border-gray-700 text-sm text-gray-500 dark:text-gray-400">
              {t('projects.catalog.collectionsLoading', 'Loading your iFinder smart collections…')}
            </p>
          ) : collections.status === 'error' ? (
            <p
              role="alert"
              className="px-4 sm:px-6 py-3 border-t border-gray-100 dark:border-gray-700 text-sm text-red-600 dark:text-red-400 flex items-start gap-2"
            >
              <Icon name="exclamation-triangle" size="sm" className="mt-0.5 flex-none" />
              <span className="flex-1">{collections.error}</span>
              <button type="button" onClick={retryCollections} className={LINK_BUTTON}>
                {t('common.retry', 'Retry')}
              </button>
            </p>
          ) : (
            <CollectionsWarning onRetry={retryCollections} />
          ))}

        {showCatalogError && (
          <div
            role="alert"
            className="mx-4 sm:mx-6 my-2 flex items-start gap-2 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/30 px-3 py-2 text-sm text-red-700 dark:text-red-300"
          >
            <Icon name="exclamation-triangle" size="sm" className="mt-0.5 flex-none" />
            <span className="flex-1">{catalog.error}</span>
            <button type="button" onClick={retryCatalog} className={LINK_BUTTON}>
              {t('common.retry', 'Retry')}
            </button>
          </div>
        )}

        {shown.length > 0 && (
          <ul
            className="border-t border-gray-100 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-700"
            aria-label={t('projects.catalog.dialogTitle', 'Project catalog')}
          >
            {shown.map(entry => (
              <CatalogEntryRow
                key={entry.key}
                entry={entry}
                busy={busyKey === entry.key}
                error={rowErrors[entry.key]}
                onToggle={toggle}
                onNavigate={onClose}
              />
            ))}
          </ul>
        )}

        {catalogLoading && (
          <p className="px-4 sm:px-6 py-6 text-center text-sm text-gray-500 dark:text-gray-400">
            {t('common.loading', 'Loading...')}
          </p>
        )}

        {emptyState}
      </div>
    </Modal>
  );
}

/**
 * iFinder could not be reached: the smart collections may be missing.
 *
 * @param {Object} props
 * @param {() => void} props.onRetry
 * @returns {JSX.Element}
 */
function CollectionsWarning({ onRetry }) {
  const { t } = useTranslation();
  return (
    <p className="px-4 sm:px-6 py-3 border-t border-gray-100 dark:border-gray-700 flex items-start gap-2 text-sm text-amber-700 dark:text-amber-300">
      <Icon name="exclamation-triangle" size="sm" className="mt-0.5 flex-none" />
      <span className="flex-1">
        {t(
          'projects.catalog.collectionsUnavailable',
          'iFinder could not be reached, so your smart collections are missing from this list.'
        )}
      </span>
      <button type="button" onClick={onRetry} className={LINK_BUTTON}>
        {t('common.retry', 'Retry')}
      </button>
    </p>
  );
}

export default ProjectCatalogDialog;
