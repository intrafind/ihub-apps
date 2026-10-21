// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { DataTable } from '../../admin/components/data-table';
import { isItemReadable, kindIcon, localizedText } from '../utils/projectItems';
import ItemProvenance from './ItemProvenance';
import ProjectItemStatus from './ProjectItemStatus';

/** Whether an item can be read again from its source (refresh). */
function isRefreshable(item) {
  return (
    item.status === 'stale' || (item.status === 'ready' && item.provenance?.origin === 'picked')
  );
}

/**
 * The items of a project with their status, a pinned toggle and the actions
 * that fit the status: preview the text, retry a failed item, refresh a
 * stale or picked one, rename, remove. The admin project editor and the user
 * project page share it; a reader (`readOnly`) sees the items and may preview
 * them, nothing else.
 *
 * Every handler is optional: an action without one is not offered.
 *
 * @param {Object} props
 * @param {Array<Object>} props.items
 * @param {Array<{id: string, name: Object}>} props.kinds - For the kind labels.
 * @param {string|null} [props.busyItemId] - The item an action is running on.
 * @param {boolean} [props.readOnly=false] - Hide every action that changes an item.
 * @param {(item: Object) => void} [props.onTogglePinned]
 * @param {(item: Object) => void} [props.onPreview]
 * @param {(item: Object) => void} [props.onRefresh] - Retry (failed) or refresh (stale, picked).
 * @param {(item: Object) => void} [props.onRename]
 * @param {(item: Object) => void} [props.onRemove]
 * @returns {JSX.Element}
 */
function ProjectItemsTable({
  items,
  kinds,
  busyItemId = null,
  readOnly = false,
  onTogglePinned,
  onPreview,
  onRefresh,
  onRename,
  onRemove
}) {
  const { t, i18n } = useTranslation();
  const language = i18n?.language || 'en';
  const canChange = handler => !readOnly && typeof handler === 'function';

  const kindName = kind => {
    const entry = (kinds || []).find(candidate => candidate.id === kind);
    return entry ? localizedText(entry.name, language) || kind : kind;
  };

  const columns = [
    {
      key: 'kind',
      header: t('projects.items.columns.kind', 'Kind'),
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
      header: t('projects.items.columns.name', 'Name'),
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
          <ItemProvenance provenance={item.provenance} item={item} className="mt-0.5" />
        </div>
      )
    },
    {
      key: 'status',
      header: t('projects.items.columns.status', 'Status'),
      sortable: true,
      sortAccessor: item => item.status,
      render: item => <ProjectItemStatus item={item} />
    },
    {
      key: 'pinned',
      header: t('projects.items.columns.pinned', 'Pinned'),
      width: 'w-20',
      render: item => (
        <input
          type="checkbox"
          checked={item.pinned === true}
          disabled={!canChange(onTogglePinned) || busyItemId === item.id}
          onChange={() => onTogglePinned(item)}
          aria-label={t('projects.items.pinItem', 'Pin {{name}}', { name: item.name })}
          title={t(
            'projects.items.pinnedHint',
            'Pinned items are always in the prompt, even when the project is searched.'
          )}
          className="h-4 w-4 text-indigo-600 border-gray-300 dark:border-gray-600 rounded-sm focus:ring-indigo-500"
        />
      )
    }
  ];

  const actions = [
    {
      id: 'preview',
      label: t('projects.items.actions.preview', 'Preview text'),
      icon: 'eye',
      priority: 'primary',
      hidden: item => typeof onPreview !== 'function' || !isItemReadable(item),
      onClick: item => onPreview(item)
    },
    {
      id: 'retry',
      label: t('projects.items.actions.retry', 'Retry'),
      icon: 'arrow-path',
      priority: 'primary',
      hidden: item => !canChange(onRefresh) || item.status !== 'failed',
      busy: item => busyItemId === item.id,
      onClick: item => onRefresh(item)
    },
    {
      id: 'refresh',
      label: t('projects.items.actions.refresh', 'Refresh'),
      icon: 'refresh',
      priority: 'primary',
      hidden: item => !canChange(onRefresh) || !isRefreshable(item),
      busy: item => busyItemId === item.id,
      onClick: item => onRefresh(item)
    },
    {
      id: 'rename',
      label: t('projects.items.actions.rename', 'Rename'),
      icon: 'pencil',
      hidden: () => !canChange(onRename),
      disabled: item => busyItemId === item.id,
      onClick: item => onRename(item)
    },
    {
      id: 'remove',
      label: t('projects.items.actions.remove', 'Remove item'),
      icon: 'trash',
      destructive: true,
      hidden: () => !canChange(onRemove),
      disabled: item => busyItemId === item.id,
      onClick: item => onRemove(item)
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
        title: t('projects.items.empty', 'No items yet'),
        description: readOnly
          ? undefined
          : t(
              'projects.items.emptyHint',
              'Add files, text, web pages, iHub pages, cloud or iFinder documents.'
            )
      }}
    />
  );
}

export default ProjectItemsTable;
