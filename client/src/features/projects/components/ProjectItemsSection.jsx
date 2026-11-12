// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import {
  addProjectItem,
  checkPickerUrl,
  crawlPickerUrl,
  estimateProjectTokens,
  fetchPickerCloudProviders,
  fetchPickerPages,
  fetchProject,
  fetchProjectCatalog,
  fetchProjectItemText,
  fetchProjects,
  previewPickerUrl,
  searchPickerIFinder,
  fetchPickerIFinderProfiles,
  uploadProjectItem
} from '../../../api';
import { useProjectEstimate } from '../hooks/useProjectEstimate';
import { useProjectItemActions } from '../hooks/useProjectItemActions';
import { projectErrorMessage } from '../utils/projectErrors';
import { canAddItem, isIFinderProject } from '../utils/projectView';

/** The one item kind a smart collection from iFinder takes. */
const IFINDER_DOCUMENT_KIND = 'ifinder-document';
const IFINDER_ALLOWED_KINDS = [IFINDER_DOCUMENT_KIND];
import AddProjectItemDialog from './AddProjectItemDialog';
import EditItemDialog from './EditItemDialog';
import EstimateTokensButton from './EstimateTokensButton';
import ItemSelectionBar, { SelectionDeleteButton } from './ItemSelectionBar';
import ProjectEstimatePanel from './ProjectEstimatePanel';
import ProjectItemsTable from './ProjectItemsTable';
import { useProjectItemDocumentActions } from './ProjectItemDocumentActions';
import ProjectItemTextDialog from './ProjectItemTextDialog';
import ProjectUsageBar from './ProjectUsageBar';
import RefreshTtlDialog from './RefreshTtlDialog';
import { isAwaitingRefresh } from '../utils/projectItems';

/**
 * What the shared "Add item" dialog calls for a user project.
 *
 * @param {(error: Error) => string} errorMessage
 * @returns {import('./AddProjectItemDialog').ProjectItemApi}
 */
function userItemApi(errorMessage) {
  return {
    addItem: (...args) => addProjectItem(...args),
    uploadItem: (...args) => uploadProjectItem(...args),
    fetchPages: () => fetchPickerPages(),
    searchIFinder: (query, options) => searchPickerIFinder(query, options),
    fetchIFinderProfiles: () => fetchPickerIFinderProfiles(),
    checkUrl: url => checkPickerUrl(url),
    previewUrl: url => previewPickerUrl(url),
    crawlUrl: (url, options) => crawlPickerUrl(url, options),
    fetchCloudProviders: () => fetchPickerCloudProviders(),
    // Own projects, and published ones: the catalog lists those the viewer
    // has not added (an empty list while it is off).
    fetchLinkSources: async () => {
      const [projects, catalog] = await Promise.all([
        fetchProjects(),
        fetchProjectCatalog().catch(() => ({ items: [] }))
      ]);
      // A smart collection from iFinder is read-only and has no stored items
      // to link from.
      return [...projects.filter(project => !isIFinderProject(project)), ...(catalog?.items || [])];
    },
    fetchLinkSource: projectId => fetchProject(projectId),
    errorMessage
  };
}

/**
 * The wording of deleting the ticked documents. A smart collection from iFinder
 * only removes them from the collection: the documents stay in iFinder.
 *
 * @param {Function} t
 * @param {boolean} isIFinder
 * @param {number} count - The documents the confirmation is for.
 * @returns {{action: string, title: string, message: string, confirm: string}}
 */
function bulkRemoveTexts(t, isIFinder, count) {
  if (isIFinder) {
    return {
      action: t('projects.items.removeSelected', 'Remove'),
      title: t('projects.items.removeSelectedTitle', 'Remove selected documents'),
      message: t(
        'projects.items.removeSelectedFromCollectionConfirm',
        'Remove {{count}} documents from the collection? The documents stay in iFinder.',
        { count }
      ),
      confirm: t('projects.items.removeSelectedAction', 'Remove documents')
    };
  }
  return {
    action: t('projects.items.deleteSelected', 'Delete'),
    title: t('projects.items.deleteSelectedTitle', 'Delete selected documents'),
    message: t(
      'projects.items.deleteSelectedConfirm',
      'Delete {{count}} documents from the project? This cannot be undone.',
      { count }
    ),
    confirm: t('projects.items.deleteSelectedAction', 'Delete documents')
  };
}

/** From this many documents on, the table scrolls inside its card. */
const ITEMS_SCROLL_FROM = 6;

/** Text loader of the preview dialog. */
const fetchItemText = (...args) => fetchProjectItemText(...args);

/**
 * What is being refreshed in the project, and what is outdated (#3622): web
 * pages and files from websites refreshed when the project is used are read
 * again the next time a chat or a search uses it (opening the page is no
 * use); answers use the stored text until then. Nothing shows while
 * everything is current.
 *
 * @param {{items?: Array<Object>}} props
 * @returns {JSX.Element|null}
 */
function RefreshNotice({ items }) {
  const { t } = useTranslation();
  const refreshing = (items || []).filter(item => item?.refreshingAt).length;
  const awaiting = (items || []).filter(isAwaitingRefresh).length;
  if (!refreshing && !awaiting) return null;
  return (
    <div
      role="status"
      className="mb-3 flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 dark:bg-blue-900/20 dark:border-blue-800 px-3 py-2 text-sm text-blue-800 dark:text-blue-200"
    >
      <Icon name="arrow-path" size="sm" className="mt-0.5 shrink-0" />
      <span>
        {refreshing
          ? t(
              'projects.refresh.refreshingNotice',
              'Refreshing {{count}} outdated documents. Answers use the stored text until they are done.',
              { count: refreshing + awaiting }
            )
          : t(
              'projects.refresh.outdatedNotice',
              '{{count}} documents are outdated. They are refreshed the next time the project is used in a chat or a search; answers use the stored text until then.',
              { count: awaiting }
            )}
      </span>
    </div>
  );
}

/**
 * The items of a project (spec 1 §3, spec 3 §9): the usage against the
 * quotas, the table with each item's status, and — for the owner and editors
 * — adding (every enabled kind, with the cloud pickers), editing an item (its
 * name, "For the AI" and, for a link, what it points at), refreshing, removing, and removing every ticked item at once.
 *
 * @param {Object} props
 * @param {Object} props.project
 * @param {Object|null} props.config - `_config` (kinds, upload settings, limits).
 * @param {boolean} props.editable - The caller may add and remove items. For a smart
 *   collection from iFinder the page derives it from `permissions.canEdit` and the
 *   `_config.ifinder.writable` capability.
 * @param {(updater: Function|Object) => void} props.setProject
 * @param {() => Promise<Object|null>} props.reload
 * @returns {JSX.Element}
 */
function ProjectItemsSection({ project, config, editable, setProject, reload }) {
  const { t } = useTranslation();
  // A smart collection from iFinder: its documents are listed and read, and its
  // owner adds and removes them (`editable`, which the page derives from the
  // permissions and the capability). The local limits, editing, pins and
  // refreshing a document, and the token estimate (a request the server does not
  // take for it) do not apply.
  const isIFinder = isIFinderProject(project);
  const canAddDocuments =
    !isIFinder || (config?.kinds || []).some(kind => kind.id === IFINDER_DOCUMENT_KIND);
  const [adding, setAdding] = useState(false);
  const [previewItem, setPreviewItem] = useState(null);
  const [scheduling, setScheduling] = useState(null);
  const [editing, setEditing] = useState(null);
  const [removing, setRemoving] = useState(null);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  // The ticked items a removal waits to be confirmed for (none: no dialog), and whether it runs.
  const [bulkRemove, setBulkRemove] = useState([]);
  const [bulkRemoving, setBulkRemoving] = useState(false);
  const actions = useProjectItemActions({ projectId: project.id, setProject, reload });
  const documentActions = useProjectItemDocumentActions(project.id);
  // Stable for the dialogs' effects as long as the language does not change.
  const messageOf = useCallback(err => projectErrorMessage(err, t), [t]);
  // A smart collection holds document ids only and reads them in the default
  // search profile, so its picker searches there and offers no other.
  const itemApi = useMemo(() => {
    const api = userItemApi(messageOf);
    return isIFinder ? { ...api, fetchIFinderProfiles: undefined } : api;
  }, [messageOf, isIFinder]);
  const roomForMore = canAddItem(project, config);
  const projectId = project.id;
  const estimateCall = useCallback(() => estimateProjectTokens(projectId), [projectId]);
  const {
    estimate,
    byItem: estimateByItem,
    loading: estimating,
    error: estimateError,
    run: runEstimate,
    clear: clearEstimate
  } = useProjectEstimate(estimateCall, messageOf);

  // The selection as it is now: an item removed since it was ticked (here, by
  // someone else, or found gone by the poll) is not selected any more. The table
  // offers ticking only to those who may change the items.
  const selectedItems = (project.items || []).filter(item => selectedIds.has(item.id));
  const bulkTexts = bulkRemoveTexts(t, isIFinder, bulkRemove.length);

  const handleBulkRemove = async () => {
    const items = bulkRemove;
    setBulkRemove([]);
    if (items.length === 0) return;
    clearEstimate();
    setBulkRemoving(true);
    try {
      const removed = await actions.removeMany(items);
      setSelectedIds(prev => new Set([...prev].filter(itemId => !removed.has(itemId))));
    } finally {
      setBulkRemoving(false);
    }
  };

  return (
    <section
      className="bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-xl p-5"
      aria-labelledby="project-items-title"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <h2
          id="project-items-title"
          className="text-base font-semibold text-gray-900 dark:text-gray-100"
        >
          {t('projects.items.title', 'Documents')}
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          {!isIFinder && (project.items || []).length > 0 && (
            <EstimateTokensButton loading={estimating} onClick={runEstimate} />
          )}
          {editable && canAddDocuments && (
            <button
              type="button"
              onClick={() => setAdding(true)}
              disabled={!roomForMore}
              title={
                roomForMore
                  ? undefined
                  : isIFinder
                    ? t(
                        'projects.items.collectionFull',
                        'A smart collection holds as many documents as iFinder allows.'
                      )
                    : t('projects.items.full', 'This project holds as many items as it may.')
              }
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-transparent text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-300 disabled:cursor-not-allowed"
            >
              <Icon name="plus" size="sm" />
              {t('projects.items.add', 'Add documents')}
            </button>
          )}
        </div>
      </div>

      <RefreshNotice items={project.items} />

      {estimateError && (
        <div
          role="alert"
          className="mb-3 rounded-lg border border-red-200 bg-red-50 dark:bg-red-900/20 dark:border-red-800 px-3 py-2 text-sm text-red-700 dark:text-red-300"
        >
          {t('projects.estimate.failed', 'The estimate could not be made.')} {estimateError}
        </div>
      )}
      {estimate && <ProjectEstimatePanel estimate={estimate} onDismiss={clearEstimate} />}
      {estimate && <div className="mb-4" />}

      {(isIFinder ? config?.ifinder?.maxDocuments : config?.limits) && (
        <ProjectUsageBar project={project} config={config} className="mb-4" />
      )}

      {actions.error && (
        <div
          role="alert"
          className="mb-3 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 dark:bg-red-900/20 dark:border-red-800 px-3 py-2 text-sm text-red-700 dark:text-red-300"
        >
          <span className="flex-1">{actions.error}</span>
          <button
            type="button"
            onClick={actions.clearError}
            aria-label={t('common.close', 'Close')}
            className="text-red-700 hover:text-red-700"
          >
            <Icon name="x" size="sm" />
          </button>
        </div>
      )}

      {editable && selectedItems.length > 0 && (
        <ItemSelectionBar
          label={t('projects.items.selectedCount', '{{count}} documents selected', {
            count: selectedItems.length
          })}
          busy={bulkRemoving}
          onClear={() => setSelectedIds(new Set())}
        >
          <SelectionDeleteButton busy={bulkRemoving} onClick={() => setBulkRemove(selectedItems)}>
            {bulkTexts.action}
          </SelectionDeleteButton>
        </ItemSelectionBar>
      )}

      {/* A long list scrolls inside its card instead of pushing the page down. */}
      <div
        className={
          (project.items || []).length > ITEMS_SCROLL_FROM
            ? 'max-h-[28rem] overflow-y-auto rounded-lg'
            : undefined
        }
        data-testid="project-items-scroll"
      >
        {documentActions.error && (
          <p role="alert" className="mb-2 text-sm text-red-600 dark:text-red-400">
            {documentActions.error}
          </p>
        )}
        <ProjectItemsTable
          items={project.items || []}
          kinds={config?.kinds || []}
          busyItemId={actions.busyItemId || documentActions.busyId}
          readOnly={!editable}
          estimates={estimate ? estimateByItem : undefined}
          onPreview={setPreviewItem}
          onDocumentAction={documentActions.onDocumentAction}
          onRefresh={
            isIFinder
              ? undefined
              : item => {
                  clearEstimate();
                  return actions.refresh(item);
                }
          }
          onSchedule={isIFinder ? undefined : setScheduling}
          onEdit={isIFinder ? undefined : setEditing}
          onRemove={setRemoving}
          selectedIds={new Set(selectedItems.map(item => item.id))}
          onSelectionChange={setSelectedIds}
        />
      </div>

      {adding && (
        <AddProjectItemDialog
          isOpen
          onClose={() => setAdding(false)}
          projectId={project.id}
          kinds={config?.kinds || []}
          config={config}
          api={itemApi}
          cloud={!isIFinder}
          projectLinks={!isIFinder}
          hideUnavailable
          multipleUploads={!isIFinder}
          allowedKinds={isIFinder ? IFINDER_ALLOWED_KINDS : null}
          project={project}
          onAdded={() => {
            clearEstimate();
            void reload();
          }}
        />
      )}
      {documentActions.dialogs}
      <ProjectItemTextDialog
        projectId={project.id}
        item={previewItem}
        onClose={() => setPreviewItem(null)}
        fetchText={fetchItemText}
        onSave={
          editable && !isIFinder
            ? text => {
                clearEstimate();
                return actions.editText(previewItem, text);
              }
            : undefined
        }
        errorMessage={messageOf}
      />
      {editing && (
        <EditItemDialog
          item={editing}
          api={itemApi}
          onClose={() => setEditing(null)}
          onSave={changes => {
            clearEstimate();
            return actions.update(editing, changes);
          }}
        />
      )}
      {scheduling && (
        <RefreshTtlDialog
          scope="item"
          item={scheduling}
          value={scheduling.refreshTtl ?? null}
          inherited={
            project.refreshTtl ??
            config?.refreshTtl ??
            (scheduling.refresh?.from !== 'item' ? scheduling.refresh?.ttl : null)
          }
          mode={scheduling.refreshMode ?? null}
          inheritedMode={
            project.refreshMode ??
            config?.refreshMode ??
            (scheduling.refresh?.modeFrom !== 'item' ? scheduling.refresh?.mode : null)
          }
          onClose={() => setScheduling(null)}
          onSave={changes => actions.setRefreshTtl(scheduling, changes)}
        />
      )}
      <ConfirmDialog
        isOpen={Boolean(removing)}
        title={t('projects.items.removeTitle', 'Remove item')}
        message={
          isIFinder
            ? t(
                'projects.items.removeFromCollectionConfirm',
                'Remove "{{name}}" from the collection? The document stays in iFinder.',
                { name: removing?.name ?? '' }
              )
            : t('projects.items.removeConfirm', 'Remove "{{name}}" from the project?', {
                name: removing?.name ?? ''
              })
        }
        confirmLabel={t('projects.items.actions.remove', 'Remove item')}
        danger
        onConfirm={() => {
          const item = removing;
          setRemoving(null);
          clearEstimate();
          void actions.remove(item);
        }}
        onDeny={() => setRemoving(null)}
      />
      <ConfirmDialog
        isOpen={bulkRemove.length > 0}
        title={bulkTexts.title}
        message={bulkTexts.message}
        confirmLabel={bulkTexts.confirm}
        danger
        onConfirm={handleBulkRemove}
        onDeny={() => setBulkRemove([])}
      />
    </section>
  );
}

export default ProjectItemsSection;
