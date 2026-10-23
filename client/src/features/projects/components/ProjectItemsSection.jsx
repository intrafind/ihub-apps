// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import {
  addProjectItem,
  checkPickerUrl,
  estimateProjectTokens,
  fetchPickerCloudProviders,
  fetchPickerPages,
  fetchProject,
  fetchProjectItemText,
  fetchProjects,
  searchPickerIFinder,
  uploadProjectItem
} from '../../../api';
import { useProjectEstimate } from '../hooks/useProjectEstimate';
import { useProjectItemActions } from '../hooks/useProjectItemActions';
import { projectErrorMessage } from '../utils/projectErrors';
import { canAddItem } from '../utils/projectView';
import AddProjectItemDialog from './AddProjectItemDialog';
import EstimateTokensButton from './EstimateTokensButton';
import ProjectEstimatePanel from './ProjectEstimatePanel';
import ProjectItemsTable from './ProjectItemsTable';
import ProjectItemTextDialog from './ProjectItemTextDialog';
import ProjectUsageBar from './ProjectUsageBar';
import RenameItemDialog from './RenameItemDialog';

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
    searchIFinder: query => searchPickerIFinder(query),
    checkUrl: url => checkPickerUrl(url),
    fetchCloudProviders: () => fetchPickerCloudProviders(),
    fetchLinkSources: () => fetchProjects(),
    fetchLinkSource: projectId => fetchProject(projectId),
    errorMessage
  };
}

/** From this many documents on, the table scrolls inside its card. */
const ITEMS_SCROLL_FROM = 6;

/** Text loader of the preview dialog. */
const fetchItemText = (...args) => fetchProjectItemText(...args);

/**
 * The items of a project (spec 1 §3, spec 3 §9): the usage against the
 * quotas, the table with each item's status, and — for the owner and editors
 * — adding (every enabled kind, with the cloud pickers), pinning, renaming,
 * refreshing and removing.
 *
 * @param {Object} props
 * @param {Object} props.project
 * @param {Object|null} props.config - `_config` (kinds, upload settings, limits).
 * @param {boolean} props.editable
 * @param {(updater: Function|Object) => void} props.setProject
 * @param {() => Promise<Object|null>} props.reload
 * @returns {JSX.Element}
 */
function ProjectItemsSection({ project, config, editable, setProject, reload }) {
  const { t } = useTranslation();
  const [adding, setAdding] = useState(false);
  const [previewItem, setPreviewItem] = useState(null);
  const [renaming, setRenaming] = useState(null);
  const [removing, setRemoving] = useState(null);
  const actions = useProjectItemActions({ projectId: project.id, setProject, reload });
  // Stable for the dialogs' effects as long as the language does not change.
  const messageOf = useCallback(err => projectErrorMessage(err, t), [t]);
  const itemApi = useMemo(() => userItemApi(messageOf), [messageOf]);
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
          {(project.items || []).length > 0 && (
            <EstimateTokensButton loading={estimating} onClick={runEstimate} />
          )}
          {editable && (
            <button
              type="button"
              onClick={() => setAdding(true)}
              disabled={!roomForMore}
              title={
                roomForMore
                  ? undefined
                  : t('projects.items.full', 'This project holds as many items as it may.')
              }
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-300 disabled:cursor-not-allowed"
            >
              <Icon name="plus" size="sm" />
              {t('projects.items.add', 'Add documents')}
            </button>
          )}
        </div>
      </div>

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

      {config?.limits && <ProjectUsageBar project={project} config={config} className="mb-4" />}

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

      {/* A long list scrolls inside its card instead of pushing the page down. */}
      <div
        className={
          (project.items || []).length > ITEMS_SCROLL_FROM
            ? 'max-h-[28rem] overflow-y-auto rounded-lg'
            : undefined
        }
        data-testid="project-items-scroll"
      >
        <ProjectItemsTable
          items={project.items || []}
          kinds={config?.kinds || []}
          busyItemId={actions.busyItemId}
          readOnly={!editable}
          estimates={estimate ? estimateByItem : undefined}
          onPreview={setPreviewItem}
          onTogglePinned={actions.togglePinned}
          onRefresh={item => {
            clearEstimate();
            return actions.refresh(item);
          }}
          onRename={setRenaming}
          onRemove={setRemoving}
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
          cloud
          projectLinks
          hideUnavailable
          multipleUploads
          project={project}
          onAdded={() => {
            clearEstimate();
            void reload();
          }}
        />
      )}
      <ProjectItemTextDialog
        projectId={project.id}
        item={previewItem}
        onClose={() => setPreviewItem(null)}
        fetchText={fetchItemText}
        onSave={
          editable
            ? text => {
                clearEstimate();
                return actions.editText(previewItem, text);
              }
            : undefined
        }
        errorMessage={messageOf}
      />
      {renaming && (
        <RenameItemDialog
          item={renaming}
          onClose={() => setRenaming(null)}
          onRename={name => actions.rename(renaming, name)}
        />
      )}
      <ConfirmDialog
        isOpen={Boolean(removing)}
        title={t('projects.items.removeTitle', 'Remove item')}
        message={t('projects.items.removeConfirm', 'Remove "{{name}}" from the project?', {
          name: removing?.name ?? ''
        })}
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
    </section>
  );
}

export default ProjectItemsSection;
