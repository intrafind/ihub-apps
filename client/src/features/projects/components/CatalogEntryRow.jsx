// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';

/**
 * How each catalog source looks: its icon and the colours of the icon tile.
 * The icon is never the only signal: the group header and the row's meta line
 * name the source in text.
 */
export const CATALOG_SOURCE_STYLES = Object.freeze({
  admin: {
    icon: 'shield-check',
    tile: 'bg-purple-50 text-purple-600 dark:bg-purple-900/40 dark:text-purple-300'
  },
  colleagues: {
    icon: 'user-group',
    tile: 'bg-indigo-50 text-indigo-600 dark:bg-indigo-900/40 dark:text-indigo-300'
  },
  ifinder: {
    icon: 'magnifying-glass',
    tile: 'bg-teal-50 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300'
  },
  yours: {
    icon: 'folder',
    tile: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'
  }
});

const ACTION_BASE =
  'shrink-0 inline-flex items-center justify-center gap-1.5 rounded-lg border text-sm font-medium min-h-11 min-w-11 px-2.5 sm:min-h-9 sm:min-w-0 sm:px-3 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-800 aria-disabled:opacity-60 aria-disabled:cursor-wait';
const ADD_BUTTON = `${ACTION_BASE} border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-600`;
const ADDED_BUTTON = `${ACTION_BASE} border-green-300 bg-green-50 text-green-800 hover:bg-green-100 dark:border-green-700 dark:bg-green-900/30 dark:text-green-300 dark:hover:bg-green-900/50`;

/**
 * The meta line of an entry: where it comes from, in words, and its size.
 *
 * @param {import('../utils/catalogSources').CatalogEntry} entry
 * @param {Function} t
 * @returns {string}
 */
function metaLine(entry, t) {
  if (entry.kind === 'collection') {
    return `${t('projects.catalog.sourceMeta.ifinder', 'iFinder smart collection')} · ${t(
      'projects.ifinder.documentCount',
      '{{count}} documents',
      { count: entry.count }
    )}`;
  }
  const origin =
    entry.source === 'admin'
      ? t('projects.catalog.byAdmins', 'From the administrators')
      : t('projects.catalog.byOwner', 'By {{name}}', {
          name: entry.ownerName || t('projects.members.unknownOwner', 'Unknown')
        });
  return `${origin} · ${t('projects.list.itemCount', '{{count}} items', { count: entry.count })}`;
}

/**
 * One entry of the project catalog: a published project or one of the
 * viewer's iFinder smart collections, with what the viewer can do with it.
 *
 * - `add`: an Add button.
 * - `added` (a project added from the catalog): an Added button that removes
 *   it again.
 * - `inList` (own or member project, collection already added): a status.
 *
 * While busy, the button stays focusable (`aria-disabled`), so focus does not
 * drop to the page when its label flips.
 *
 * @param {Object} props
 * @param {import('../utils/catalogSources').CatalogEntry} props.entry
 * @param {boolean} props.busy - Adding or removing it is under way.
 * @param {string|null} [props.error] - Why the last add or remove failed.
 * @param {(entry: Object) => void} props.onToggle - Add, or remove an added project.
 * @param {() => void} props.onNavigate - Called when the viewer follows the link.
 * @returns {JSX.Element}
 */
function CatalogEntryRow({ entry, busy, error, onToggle, onNavigate }) {
  const { t } = useTranslation();
  const style = CATALOG_SOURCE_STYLES[entry.source];
  const errorId = error ? `catalog-row-error-${entry.key}` : undefined;

  const action =
    entry.status === 'inList' ? (
      <span className="shrink-0 inline-flex items-center gap-1 rounded-full bg-gray-100 dark:bg-gray-700 px-2 py-1 text-xs font-medium text-gray-700 dark:text-gray-200 whitespace-nowrap">
        <Icon name="check-circle" size="xs" aria-hidden="true" />
        {t('projects.catalog.inYourList', 'In your projects')}
      </span>
    ) : (
      <button
        type="button"
        onClick={() => !busy && onToggle(entry)}
        aria-disabled={busy || undefined}
        aria-busy={busy || undefined}
        aria-describedby={errorId}
        className={entry.status === 'added' ? ADDED_BUTTON : ADD_BUTTON}
        aria-label={
          entry.status === 'added'
            ? t('projects.catalog.addedRemoveNamed', 'Added: remove {{name}} from my projects', {
                name: entry.name
              })
            : t('projects.catalog.addNamed', 'Add {{name}} to my projects', { name: entry.name })
        }
      >
        <Icon
          name={busy ? 'spinner' : entry.status === 'added' ? 'check' : 'plus'}
          size="sm"
          className={busy ? 'animate-spin' : undefined}
          aria-hidden="true"
        />
        <span className="hidden sm:inline">
          {entry.status === 'added'
            ? t('projects.catalog.added', 'Added')
            : t('projects.catalog.addShort', 'Add')}
        </span>
      </button>
    );

  return (
    <li className="flex items-start gap-3 px-4 py-3 sm:px-6 [@media(max-height:560px)]:py-2">
      <span
        className={`flex-none grid place-items-center size-9 rounded-lg ${style.tile}`}
        aria-hidden="true"
      >
        <Icon name={style.icon} size="md" />
      </span>
      <div className="flex-1 min-w-0">
        {entry.projectId ? (
          <Link
            to={`/projects/${encodeURIComponent(entry.projectId)}`}
            onClick={onNavigate}
            className="block truncate font-medium text-gray-900 dark:text-gray-100 hover:text-indigo-600 dark:hover:text-indigo-400 rounded-sm focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500"
          >
            {entry.name}
          </Link>
        ) : (
          <span className="block truncate font-medium text-gray-900 dark:text-gray-100">
            {entry.name}
          </span>
        )}
        {entry.description && (
          <p className="text-sm text-gray-600 dark:text-gray-400 line-clamp-1 sm:line-clamp-2 [@media(max-height:560px)]:line-clamp-1">
            {entry.description}
          </p>
        )}
        <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{metaLine(entry, t)}</p>
        {error && (
          <p id={errorId} role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
      </div>
      {action}
    </li>
  );
}

export default CatalogEntryRow;
