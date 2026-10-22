// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { DataTable } from './data-table';
import { kindIcon, localizedText } from '../utils/projectAdmin';
import { formatTokenCount } from '../utils/tokenStats';

const BADGE = 'inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full';

/**
 * Status of one item: `pending` grey "waiting", `extracting` with a spinner,
 * `ready` green with its token count, `failed` red with the error message,
 * `stale` amber.
 *
 * @param {{item: Object}} props
 * @returns {JSX.Element}
 */
export function ProjectItemStatus({ item }) {
  const { t } = useTranslation();
  switch (item.status) {
    case 'pending':
      return (
        <span className={`${BADGE} bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300`}>
          {t('admin.projects.items.status.pending', 'Waiting')}
        </span>
      );
    case 'extracting':
      return (
        <span
          className={`${BADGE} bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-300`}
        >
          <Icon name="arrow-path" size="xs" className="animate-spin" />
          {t('admin.projects.items.status.extracting', 'Extracting')}
        </span>
      );
    case 'failed':
      return (
        <div className="min-w-0">
          <span className={`${BADGE} bg-red-100 dark:bg-red-900/40 text-red-800 dark:text-red-300`}>
            {t('admin.projects.items.status.failed', 'Failed')}
          </span>
          {item.error?.message && (
            <div className="mt-1 text-xs text-red-600 dark:text-red-400 break-words">
              {item.error.message}
            </div>
          )}
        </div>
      );
    case 'stale':
      return (
        <span
          className={`${BADGE} bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-300`}
          title={t(
            'admin.projects.items.status.staleHint',
            'The content changed at its origin; refresh to read it again.'
          )}
        >
          {t('admin.projects.items.status.stale', 'Outdated')}
        </span>
      );
    case 'ready':
    default:
      return (
        <span
          className={`${BADGE} bg-green-100 dark:bg-green-900/40 text-green-800 dark:text-green-300`}
        >
          {t('admin.projects.items.status.ready', 'Ready')}
          {Number.isFinite(item.text?.tokens) && (
            <span className="font-normal">
              ·{' '}
              {t('admin.projects.tokens.count', '~{{tokens}} tokens', {
                tokens: formatTokenCount(item.text.tokens)
              })}
            </span>
          )}
        </span>
      );
  }
}

/**
 * The items of an admin project with their status, a pinned toggle and the
 * actions that fit the status: preview the text, retry a failed item,
 * refresh a stale one, remove any.
 *
 * @param {Object} props
 * @param {Array<Object>} props.items
 * @param {Array<{id: string, name: Object}>} props.kinds - For the kind labels.
 * @param {string|null} props.busyItemId - The item an action is running on.
 * @param {(item: Object) => void} props.onTogglePinned
 * @param {(item: Object) => void} props.onPreview
 * @param {(item: Object) => void} props.onRefresh - Retry (failed) or refresh (stale).
 * @param {(item: Object) => void} props.onRemove
 * @returns {JSX.Element}
 */
function ProjectItemsTable({
  items,
  kinds,
  busyItemId,
  onTogglePinned,
  onPreview,
  onRefresh,
  onRemove
}) {
  const { t, i18n } = useTranslation();
  const language = i18n?.language || 'en';

  const kindName = kind => {
    const entry = (kinds || []).find(candidate => candidate.id === kind);
    return entry ? localizedText(entry.name, language) || kind : kind;
  };

  const columns = [
    {
      key: 'kind',
      header: t('admin.projects.items.columns.kind', 'Kind'),
      sortable: true,
      sortAccessor: item => kindName(item.kind),
      render: item => (
        <span className="inline-flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
          <Icon name={kindIcon(item.kind)} size="sm" />
          {kindName(item.kind)}
        </span>
      )
    },
    {
      key: 'name',
      header: t('admin.projects.items.columns.name', 'Name'),
      sortable: true,
      sortAccessor: item => (item.name || '').toLowerCase(),
      render: item => (
        <div className="min-w-0">
          <div className="text-sm font-medium text-gray-900 dark:text-gray-100 break-words">
            {item.name}
          </div>
          {item.ref?.url && (
            <div className="text-xs text-gray-500 dark:text-gray-400 truncate">{item.ref.url}</div>
          )}
        </div>
      )
    },
    {
      key: 'status',
      header: t('admin.projects.items.columns.status', 'Status'),
      sortable: true,
      sortAccessor: item => item.status,
      render: item => <ProjectItemStatus item={item} />
    },
    {
      key: 'pinned',
      header: t('admin.projects.items.columns.pinned', 'Pinned'),
      width: 'w-20',
      render: item => (
        <input
          type="checkbox"
          checked={item.pinned === true}
          disabled={busyItemId === item.id}
          onChange={() => onTogglePinned(item)}
          aria-label={t('admin.projects.items.pinItem', 'Pin {{name}}', { name: item.name })}
          title={t(
            'admin.projects.items.pinnedHint',
            'Pinned items are always in the prompt when the project is in context.'
          )}
          className="h-4 w-4 text-indigo-600 border-gray-300 dark:border-gray-600 rounded-sm focus:ring-indigo-500"
        />
      )
    }
  ];

  const actions = [
    {
      id: 'preview',
      label: t('admin.projects.items.actions.preview', 'Preview text'),
      icon: 'eye',
      priority: 'primary',
      hidden: item => !['ready', 'stale'].includes(item.status),
      onClick: onPreview
    },
    {
      id: 'retry',
      label: t('admin.projects.items.actions.retry', 'Retry'),
      icon: 'arrow-path',
      priority: 'primary',
      hidden: item => item.status !== 'failed',
      busy: item => busyItemId === item.id,
      onClick: onRefresh
    },
    {
      id: 'refresh',
      label: t('admin.projects.items.actions.refresh', 'Refresh'),
      icon: 'refresh',
      priority: 'primary',
      hidden: item => item.status !== 'stale',
      busy: item => busyItemId === item.id,
      onClick: onRefresh
    },
    {
      id: 'remove',
      label: t('admin.projects.items.actions.remove', 'Remove item'),
      icon: 'trash',
      destructive: true,
      disabled: item => busyItemId === item.id,
      onClick: onRemove
    }
  ];

  return (
    <DataTable
      columns={columns}
      data={items || []}
      getRowId={item => item.id}
      actions={actions}
      density="compact"
      empty={{
        icon: 'folder-open',
        title: t('admin.projects.items.empty', 'No items yet'),
        description: t(
          'admin.projects.items.emptyHint',
          'Add files, text, web pages, iHub pages or iFinder documents.'
        )
      }}
    />
  );
}

export default ProjectItemsTable;
