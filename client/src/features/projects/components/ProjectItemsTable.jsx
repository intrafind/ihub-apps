// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { DataTable } from '../../admin/components/data-table';
import {
  aiAccessOf,
  hasDocumentActions,
  isItemReadable,
  kindIcon,
  localizedText
} from '../utils/projectItems';
import { refreshSummary, takesRefreshTtl } from '../utils/refreshTtl';
import ItemEstimate from './ItemEstimate';
import ItemProvenance from './ItemProvenance';
import ProjectItemStatus from './ProjectItemStatus';

/**
 * Whether an item can be read again from its source (refresh): a stale
 * item, a picked document, a file from a website, or a web page (its
 * snapshot; a page added before #3622 keeps its `linked` origin).
 */
function isRefreshable(item) {
  return (
    item.status === 'stale' ||
    (item.status === 'ready' && (item.provenance?.origin === 'picked' || item.kind === 'url'))
  );
}

/**
 * Whether a failed item can be retried. Retry is a refresh, which reads the
 * item again from its source; an upload (a file or a written text) has no
 * source to read, so the server refuses it (`INVALID_REF`) — the file has to
 * be added again.
 */
function isRetryable(item) {
  return item.status === 'failed' && item.kind !== 'upload';
}

/**
 * What an item is for the AI when it is not the default: a pinned item is always
 * in the prompt, a "Not for AI" one is never given to the model. A normal item
 * shows nothing. The setting itself is changed in the edit dialog.
 */
function AiAccessBadge({ item }) {
  const { t } = useTranslation();
  const state = aiAccessOf(item);
  if (state === 'normal') return null;
  const excluded = state === 'excluded';
  return (
    <span
      className={`mt-1 inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
        excluded
          ? 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200'
          : 'bg-indigo-50 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300'
      }`}
    >
      {excluded
        ? t('projects.items.aiAccess.excluded', 'Not for AI')
        : t('projects.items.aiAccess.pinned', 'Pinned')}
    </span>
  );
}

/**
 * The items of a project with their status and the actions that fit it:
 * preview the text, retry a failed picked item, refresh a stale or picked one,
 * edit (the name, "For the AI" and the reference of a link), remove. The admin
 * project editor and the user
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
 * @param {(item: Object) => void} [props.onPreview]
 * @param {(action: 'previewDocument'|'download'|'details'|'open', item: Object) => void} [props.onDocumentAction] -
 *   The document actions of an iFinder document (`ProjectItemDocumentActions.jsx`);
 *   reading only, so offered on a read-only list too.
 * @param {(item: Object) => void} [props.onRefresh] - Retry (failed, not an upload) or
 *   refresh (stale, picked).
 * @param {(item: Object) => void} [props.onSchedule] - Set the refresh TTL of a file
 *   from a website or a web page.
 * @param {(item: Object) => void} [props.onEdit] - Change an item's name, its "For the AI"
 *   setting (pinned, normal or "Not for AI": three states of one setting, #3538) and,
 *   for a link item, what it points at (the kinds of `EDITABLE_ITEM_KINDS`).
 * @param {(item: Object) => void} [props.onRemove]
 * @param {(item: Object) => void} [props.onTransfer] - Move or copy into another project.
 * @param {Set<string>} [props.selectedIds] - With `onSelectionChange`, a checkbox column
 *   selects items for a bulk action the page offers.
 * @param {(ids: Set<string>) => void} [props.onSelectionChange]
 * @param {Object<string, Object>} [props.estimates] - The items of a token estimate by item
 *   id; adds a column with each item's tokens and whether it belongs in the prompt.
 * @returns {JSX.Element}
 */
function ProjectItemsTable({
  items,
  kinds,
  busyItemId = null,
  readOnly = false,
  onPreview,
  onDocumentAction,
  onRefresh,
  onSchedule,
  onEdit,
  onRemove,
  onTransfer,
  selectedIds,
  onSelectionChange,
  estimates
}) {
  const { t, i18n } = useTranslation();
  const language = i18n?.language || 'en';
  const canChange = handler => !readOnly && typeof handler === 'function';

  const kindName = kind => {
    const entry = (kinds || []).find(candidate => candidate.id === kind);
    return entry ? localizedText(entry.name, language) || kind : kind;
  };

  const selectable = canChange(onSelectionChange);
  const selected = selectedIds || new Set();
  const allSelected = (items || []).length > 0 && selected.size === (items || []).length;
  const checkboxClass =
    'h-4 w-4 text-indigo-600 border-gray-300 dark:border-gray-600 rounded-sm focus:ring-indigo-500';

  const selectColumn = {
    key: 'select',
    header: (
      <input
        type="checkbox"
        aria-label={t('projects.items.selectAll', 'Select all items')}
        checked={allSelected}
        onChange={e =>
          onSelectionChange(
            e.target.checked ? new Set((items || []).map(item => item.id)) : new Set()
          )
        }
        className={checkboxClass}
      />
    ),
    width: 'w-10',
    render: item => (
      <input
        type="checkbox"
        aria-label={t('projects.items.selectItem', 'Select {{name}}', { name: item.name })}
        checked={selected.has(item.id)}
        onChange={e => {
          const next = new Set(selected);
          if (e.target.checked) next.add(item.id);
          else next.delete(item.id);
          onSelectionChange(next);
        }}
        onClick={e => e.stopPropagation()}
        className={checkboxClass}
      />
    )
  };

  const columns = [
    ...(selectable ? [selectColumn] : []),
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
          <AiAccessBadge item={item} />
          <ItemProvenance provenance={item.provenance} item={item} className="mt-0.5" />
          {item.refresh && (
            <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              {refreshSummary(item, t, language)}
            </div>
          )}
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
    ...(estimates
      ? [
          {
            key: 'estimate',
            header: t('projects.items.columns.estimate', 'Estimate'),
            render: item => <ItemEstimate estimate={estimates[item.id]} />
          }
        ]
      : [])
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
    ...[
      ['previewDocument', t('sources.preview', 'Preview (PDF)'), 'document-text'],
      ['open', t('projects.items.actions.openInIFinder', 'Open in iFinder'), 'external-link'],
      ['download', t('sources.download', 'Download'), 'download'],
      ['details', t('sources.details', 'Details'), 'information-circle']
    ].map(([id, label, icon]) => ({
      id,
      label,
      icon,
      // Opening the document where it lives is the one a reader wants first.
      ...(id === 'open' ? { priority: 'primary' } : {}),
      hidden: item => typeof onDocumentAction !== 'function' || !hasDocumentActions(item),
      disabled: item => busyItemId === item.id,
      onClick: item => onDocumentAction(id, item)
    })),
    {
      id: 'retry',
      label: t('projects.items.actions.retry', 'Retry'),
      icon: 'arrow-path',
      priority: 'primary',
      hidden: item => !canChange(onRefresh) || !isRetryable(item),
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
      id: 'schedule',
      label: t('projects.items.actions.schedule', 'Refresh schedule'),
      icon: 'clock',
      hidden: item => !canChange(onSchedule) || !takesRefreshTtl(item),
      disabled: item => busyItemId === item.id,
      onClick: item => onSchedule(item)
    },
    {
      id: 'edit',
      label: t('projects.items.actions.edit', 'Edit'),
      icon: 'pencil',
      priority: 'primary',
      hidden: () => !canChange(onEdit),
      disabled: item => busyItemId === item.id,
      onClick: item => onEdit(item)
    },
    {
      id: 'transfer',
      label: t('projects.items.actions.transfer', 'Move or copy to…'),
      icon: 'arrow-right',
      hidden: () => !canChange(onTransfer),
      disabled: item => busyItemId === item.id,
      onClick: item => onTransfer(item)
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
