// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../../../shared/components/Modal';
import Icon from '../../../shared/components/Icon';
import useProjectCatalog from '../hooks/useProjectCatalog';
import {
  availableSources,
  collectionEntry,
  filterCatalogEntries,
  projectEntry
} from '../utils/catalogSources';
import { INPUT_CLASS } from './item-dialog/dialogStyles';
import CatalogEntryRow from './CatalogEntryRow';
import {
  CatalogEmptyState,
  CatalogError,
  CollectionsNotice,
  HowItWorks,
  SourceChips
} from './CatalogDialogParts';

/** Delay before the result count is announced, so typing is not read out letter by letter. */
const ANNOUNCE_DELAY_MS = 600;

/**
 * Matches per source.
 *
 * @param {import('../utils/catalogSources').CatalogEntry[]} entries
 * @returns {Object<string, number>}
 */
function countBySource(entries) {
  const counts = {};
  for (const entry of entries) counts[entry.source] = (counts[entry.source] || 0) + 1;
  return counts;
}

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
  const [announcement, setAnnouncement] = useState('');
  const searchRef = useRef(null);
  const { catalog, collections, retryCatalog, retryCollections, toggle, busyKey, rowErrors } =
    useProjectCatalog({ catalogEnabled, collectionsEnabled, onChanged, t });

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
  const activeSource = sources.includes(source) ? source : 'all';
  const matches = filterCatalogEntries(entries, query);
  const shown =
    activeSource === 'all' ? matches : matches.filter(entry => entry.source === activeSource);
  const showCollectionsNotice = collectionsNotice && ['all', 'ifinder'].includes(activeSource);
  const catalogLoading = catalogEnabled && catalog.status === 'loading';
  const showCatalogError =
    catalogEnabled && catalog.status === 'error' && activeSource !== 'ifinder';
  const collectionsLoading = collectionsEnabled && collections.status === 'loading';
  const settled = !catalogLoading && !collectionsLoading;
  const trimmedQuery = query.trim();
  const showEmpty = settled && shown.length === 0 && !showCollectionsNotice && !showCatalogError;

  const resultText = t('projects.catalog.resultCount', '{{count}} results', {
    count: shown.length
  });
  useEffect(() => {
    if (!settled) return undefined;
    const handle = setTimeout(() => setAnnouncement(resultText), ANNOUNCE_DELAY_MS);
    return () => clearTimeout(handle);
  }, [resultText, settled]);

  const clearFilters = () => {
    setQuery('');
    setSource('all');
    searchRef.current?.focus();
  };

  const hints = [];
  if (catalogEnabled) {
    hints.push(
      t(
        'projects.catalog.dialogHint',
        'Projects published for everyone, by their owners or by the administrators: add one to your projects to use it in your chats. Whoever published it keeps it up to date.'
      )
    );
  }
  if (collectionsEnabled) {
    hints.push(
      t(
        'projects.catalog.collectionsHint',
        'Add a collection to your projects to chat with it, with a default app and instructions of its own. Its documents stay in iFinder.'
      )
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
          <SourceChips
            sources={sources}
            activeSource={activeSource}
            counts={countBySource(matches)}
            total={matches.length}
            pendingSources={collectionsLoading ? ['ifinder'] : []}
            onSelect={setSource}
          />
        )}
        <p role="status" aria-live="polite" className="sr-only">
          {announcement}
        </p>
      </div>

      <div
        className="flex-1 min-h-0 overflow-y-auto overscroll-contain pb-[env(safe-area-inset-bottom)]"
        data-testid="catalog-results"
      >
        <HowItWorks hints={hints} />
        {showCollectionsNotice && (
          <CollectionsNotice
            status={collections.status}
            error={collections.error}
            onRetry={retryCollections}
          />
        )}
        {showCatalogError && <CatalogError error={catalog.error} onRetry={retryCatalog} />}
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
        {showEmpty && (
          <CatalogEmptyState
            query={trimmedQuery}
            filtered={trimmedQuery !== '' || activeSource !== 'all'}
            catalogEnabled={catalogEnabled}
            collectionsEnabled={collectionsEnabled}
            onClear={clearFilters}
          />
        )}
      </div>
    </Modal>
  );
}

export default ProjectCatalogDialog;
