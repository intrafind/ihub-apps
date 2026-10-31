// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import {
  createAdminProject,
  deleteAdminProjectItem,
  fetchAdminProjectConfig,
  fetchAdminProjectItemText,
  fetchAdminProjectKinds,
  getAdminApiErrorMessage,
  refreshAdminProjectItem,
  updateAdminProjectItem,
  updateAdminProjectItemText
} from '../../../api/adminApi';
import AdminBreadcrumb from '../components/AdminBreadcrumb';
import ChangeHistoryDrawer from '../components/ChangeHistoryDrawer';
import AddProjectItemDialog from '../../projects/components/AddProjectItemDialog';
import ProjectItemsTable from '../../projects/components/ProjectItemsTable';
import { useProjectItemDocumentActions } from '../../projects/components/ProjectItemDocumentActions';
import ProjectItemTextDialog from '../../projects/components/ProjectItemTextDialog';
import AdminProjectSettingsForm from '../components/AdminProjectSettingsForm';
import AdminProjectSettingsPanel from '../components/AdminProjectSettingsPanel';
import {
  AdminProjectCheckResults,
  AdminProjectHeaderActions,
  ProjectDetailLayout,
  useAdminProjectChecks
} from '../components/AdminProjectDetail';
import TransferItemsDialog from '../components/TransferItemsDialog';
import { ADMIN_ITEM_API } from '../utils/adminProjectItemApi';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { useAdminProject } from '../hooks/useAdminProject';
import {
  MAX_PROJECT_ID_LENGTH,
  buildProjectPayload,
  createEmptyProjectForm,
  parseTags,
  projectIdFromName,
  uploadsAreUnscanned,
  validateProjectForm
} from '../utils/projectAdmin';
import { localizedText } from '../../projects/utils/projectItems';

/** Text loader of the shared preview dialog. */
const fetchAdminItemText = (...args) => fetchAdminProjectItemText(...args);
const adminErrorMessage = err => getAdminApiErrorMessage(err);

/**
 * Admin → Projects → new / edit (#1036). A new project starts with the full
 * settings form (id, localized name and description, availability,
 * instructions, category, tags). Once it exists, the page works on its
 * items: add (one tab per kind), pin, preview the text, retry, refresh,
 * remove, and a test of every item; the settings sit beside them as rows
 * that each open a dialog and save at once, as on a user's project page.
 * While an item is being extracted the page re-reads the project every two
 * seconds.
 *
 * @param {{id: string}} props - The project id, or `new`.
 * @returns {JSX.Element}
 */
function AdminProjectEditPageContent({ id }) {
  const { t, i18n } = useTranslation();
  const language = i18n?.language || 'en';
  const navigate = useNavigate();
  const location = useLocation();
  const isNew = id === 'new';

  const {
    project,
    setProject,
    loading,
    error: loadError,
    reload
  } = useAdminProject(isNew ? null : id);
  // Only a new project has a form; an existing one saves each change at once.
  const [form, setForm] = useState(() => (isNew ? createEmptyProjectForm() : null));
  const [initialForm] = useState(() => (isNew ? createEmptyProjectForm() : null));
  const [tagsText, setTagsText] = useState('');
  const [validationErrors, setValidationErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [kinds, setKinds] = useState([]);
  const [config, setConfig] = useState(null);
  const [addOpen, setAddOpen] = useState(false);
  // Until the admin types an ID, a new project's ID follows its name.
  const [idEdited, setIdEdited] = useState(false);
  const [previewItem, setPreviewItem] = useState(null);
  const documentActions = useProjectItemDocumentActions(id);
  const [busyItemId, setBusyItemId] = useState(null);
  const [removeItem, setRemoveItem] = useState(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [selectedItemIds, setSelectedItemIds] = useState(() => new Set());
  // The items a move or copy dialog is open for, and its starting mode.
  const [transfer, setTransfer] = useState(null);

  const { blocker, markSaved } = useUnsavedChanges(initialForm, form);

  const checks = useAdminProjectChecks(id);
  const { estimate, byItem: estimateByItem, clearEstimate } = checks;

  // Kinds and upload settings drive the item dialog; a failure only limits it.
  useEffect(() => {
    if (isNew) return;
    fetchAdminProjectKinds()
      .then(setKinds)
      .catch(err => console.error('Failed to load item kinds:', err));
    fetchAdminProjectConfig()
      .then(setConfig)
      .catch(err => console.error('Failed to load project settings:', err));
  }, [isNew]);

  // A project just created lands here with the "Add item" dialog open. The
  // page instance is shared with the create route, so this is an effect, not
  // an initial state; the flag is cleared so a reload does not open it again.
  useEffect(() => {
    if (isNew || !location.state?.openAdd) return;
    setAddOpen(true);
    navigate(location.pathname, { replace: true, state: null });
  }, [isNew, location.state, location.pathname, navigate]);

  const validationMessages = {
    id: {
      required: t('admin.projects.validation.idRequired', 'The project ID is required.'),
      invalid: t(
        'admin.projects.validation.idInvalid',
        'Use only letters, numbers, dots, underscores and hyphens.'
      ),
      tooLong: t('admin.projects.validation.idTooLong', 'At most {{max}} characters.', {
        max: MAX_PROJECT_ID_LENGTH
      }),
      reserved: t(
        'admin.projects.validation.idReserved',
        'IDs starting with "prj_" or "ifc_" are reserved for user projects and iFinder collections.'
      )
    },
    name: {
      required: t('admin.projects.validation.nameRequired', 'A name is required.')
    }
  };

  const handleChange = (field, value) => {
    if (field === 'id') setIdEdited(value !== '');
    setForm(prev => ({
      ...prev,
      [field]: value,
      ...(isNew && field === 'name' && !idEdited ? { id: projectIdFromName(value) } : {})
    }));
    const cleared = field === 'name' && isNew && !idEdited ? ['name', 'id'] : [field];
    if (cleared.some(key => validationErrors[key])) {
      setValidationErrors(prev => {
        const rest = { ...prev };
        cleared.forEach(key => delete rest[key]);
        return rest;
      });
    }
  };

  const handleCreate = async event => {
    event.preventDefault();
    const nextForm = { ...form, tags: parseTags(tagsText) };
    const errors = validateProjectForm(nextForm, { isNew: true });
    setValidationErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setSaving(true);
    setError(null);
    try {
      const payload = buildProjectPayload(nextForm);
      const created = await createAdminProject(payload);
      markSaved();
      // Items can be added once the project exists.
      navigate(`/admin/projects/${encodeURIComponent(created?.id || payload.id)}/edit`, {
        replace: true,
        state: { openAdd: true }
      });
    } catch (err) {
      if (err?.response?.status === 409) {
        setValidationErrors({ id: 'exists' });
      }
      setError(getAdminApiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  /** Replace one item in the shown project (after a PATCH or refresh). */
  const replaceItem = item => {
    if (!item) return;
    setProject(prev =>
      prev
        ? { ...prev, items: (prev.items || []).map(entry => (entry.id === item.id ? item : entry)) }
        : prev
    );
  };

  const runItemAction = async (item, action) => {
    setBusyItemId(item.id);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(getAdminApiErrorMessage(err));
    } finally {
      setBusyItemId(null);
    }
  };

  const handleTogglePinned = item =>
    runItemAction(item, async () =>
      replaceItem(await updateAdminProjectItem(id, item.id, { pinned: !item.pinned }))
    );

  const handleRefresh = item =>
    runItemAction(item, async () => {
      clearEstimate();
      replaceItem(await refreshAdminProjectItem(id, item.id));
      await reload();
    });

  const handleRemove = async () => {
    const item = removeItem;
    setRemoveItem(null);
    clearEstimate();
    await runItemAction(item, async () => {
      await deleteAdminProjectItem(id, item.id);
      setProject(prev =>
        prev ? { ...prev, items: (prev.items || []).filter(entry => entry.id !== item.id) } : prev
      );
    });
  };

  const handleTransferDone = () => {
    clearEstimate();
    setSelectedItemIds(new Set());
    void reload();
  };

  if (loading || (!isNew && !project && !loadError)) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
        <div className="flex items-center justify-center h-64">
          <Icon name="arrow-path" className="animate-spin h-8 w-8 text-gray-500" />
          <span className="ml-3 text-gray-500 dark:text-gray-400">
            {t('common.loading', 'Loading...')}
          </span>
        </div>
      </div>
    );
  }

  if (!isNew && !project) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
        <div className="max-w-3xl mx-auto py-12 px-4 text-center">
          <Icon name="x-circle" className="h-12 w-12 text-red-400 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-2">
            {t('admin.projects.notFound', 'Project not found')}
          </h3>
          <p className="text-gray-500 dark:text-gray-400 mb-4">{loadError}</p>
          <button
            type="button"
            onClick={() => navigate('/admin/projects')}
            className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg font-medium"
          >
            {t('admin.projects.backToList', 'Back to projects')}
          </button>
        </div>
      </div>
    );
  }

  // The selection as it is now: an item removed or moved since it was ticked
  // is not selected any more.
  const selectedItems = (project?.items || []).filter(item => selectedItemIds.has(item.id));

  const title = isNew
    ? t('admin.projects.createNew', 'New project')
    : localizedText(project?.name, language) || id;
  const idError = validationErrors.id
    ? validationErrors.id === 'exists'
      ? t('admin.projects.validation.idExists', 'A project with this ID already exists.')
      : validationMessages.id[validationErrors.id]
    : null;

  const createForm = isNew && (
    <AdminProjectSettingsForm
      form={form}
      saving={saving}
      idError={idError}
      nameError={validationErrors.name ? validationMessages.name.required : null}
      tagsText={tagsText}
      onFieldChange={handleChange}
      onTagsTextChange={text => {
        setTagsText(text);
        setForm(prev => ({ ...prev, tags: parseTags(text) }));
      }}
      onSubmit={handleCreate}
      onCancel={() => navigate('/admin/projects')}
    />
  );

  const itemsSection = (
    <section className="bg-white dark:bg-gray-800 rounded-lg shadow-xs p-6">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <h2 className="text-lg font-medium text-gray-900 dark:text-gray-100">
          {t('admin.projects.items.title', 'Items')}
        </h2>
        <button
          type="button"
          onClick={() => setAddOpen(true)}
          className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-sm font-medium flex items-center"
        >
          <Icon name="plus" className="h-4 w-4 mr-2" />
          {t('admin.projects.items.add', 'Add item')}
        </button>
      </div>
      {selectedItems.length > 0 && (
        <div
          data-testid="item-selection-bar"
          className="mb-4 bg-indigo-50 dark:bg-indigo-900/30 border border-indigo-200 dark:border-indigo-800 rounded-lg p-3 flex flex-wrap items-center justify-between gap-3"
        >
          <span className="text-sm font-medium text-indigo-800 dark:text-indigo-200">
            {t('admin.projects.items.selectedCount', '{{count}} items selected', {
              count: selectedItems.length
            })}
          </span>
          <div className="flex gap-2">
            {['move', 'copy'].map(mode => (
              <button
                key={mode}
                type="button"
                onClick={() =>
                  setTransfer({
                    mode,
                    items: selectedItems
                  })
                }
                className="bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-1 rounded-sm text-sm font-medium"
              >
                {mode === 'move'
                  ? t('admin.projects.items.moveSelected', 'Move to…')
                  : t('admin.projects.items.copySelected', 'Copy to…')}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setSelectedItemIds(new Set())}
              className="bg-gray-500 hover:bg-gray-600 text-white px-3 py-1 rounded-sm text-sm font-medium"
            >
              {t('common.clearSelection', 'Clear')}
            </button>
          </div>
        </div>
      )}
      <ProjectItemsTable
        items={project?.items || []}
        kinds={kinds}
        busyItemId={busyItemId}
        estimates={estimate ? estimateByItem : undefined}
        selectedIds={new Set(selectedItems.map(item => item.id))}
        onSelectionChange={setSelectedItemIds}
        onTogglePinned={handleTogglePinned}
        onPreview={setPreviewItem}
        onRefresh={handleRefresh}
        onTransfer={item => setTransfer({ mode: 'move', items: [item] })}
        onRemove={setRemoveItem}
        onDocumentAction={documentActions.onDocumentAction}
      />
      {documentActions.error && (
        <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">
          {documentActions.error}
        </p>
      )}
      {documentActions.dialogs}
    </section>
  );

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <div className="max-w-7xl mx-auto py-6 px-4">
        <AdminBreadcrumb
          crumbs={[
            { label: t('admin.nav.overview', 'Overview'), href: '/admin' },
            { label: t('admin.nav.projects', 'Projects'), href: '/admin/projects' },
            { label: title }
          ]}
        />

        <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100 flex items-center">
            <Icon name="folder" className="h-6 w-6 mr-2" />
            {title}
          </h1>
          {!isNew && (
            <AdminProjectHeaderActions checks={checks} onHistory={() => setHistoryOpen(true)} />
          )}
        </div>

        {uploadsAreUnscanned(config) && (
          <div
            role="status"
            data-testid="project-scan-warning"
            className="mb-6 bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 rounded-lg p-4 flex items-start gap-2"
          >
            <Icon name="exclamation-triangle" className="h-5 w-5 text-amber-500 shrink-0" />
            <p className="text-sm text-amber-800 dark:text-amber-200">
              {t(
                'admin.projects.scanWarning',
                'Uploads are not scanned for malware. Configure platform.projects.scan to scan them.'
              )}
            </p>
          </div>
        )}

        {error && (
          <div
            role="alert"
            className="mb-6 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-lg p-4 flex items-center"
          >
            <Icon name="x-circle" className="h-5 w-5 text-red-400 mr-2" />
            <p className="text-red-800 dark:text-red-200">{error}</p>
            <button
              type="button"
              onClick={() => setError(null)}
              aria-label={t('common.dismiss', 'Dismiss')}
              className="ml-auto text-red-700 dark:text-red-400"
            >
              <Icon name="x-mark" className="h-4 w-4" />
            </button>
          </div>
        )}

        {isNew ? (
          // Items come right after the create: no empty card to look at first.
          <div className="max-w-3xl">{createForm}</div>
        ) : (
          // The items are what an admin works on here: they take the wide
          // column (and come first on a narrow screen); the settings sit
          // beside them as rows, each changed in its own dialog.
          <ProjectDetailLayout
            main={
              <>
                <AdminProjectCheckResults checks={checks} />
                {itemsSection}
              </>
            }
            side={<AdminProjectSettingsPanel project={project} onSaved={setProject} />}
          />
        )}
      </div>

      {!isNew && (
        <>
          {addOpen && kinds.length > 0 && (
            <AddProjectItemDialog
              isOpen
              onClose={() => setAddOpen(false)}
              projectId={id}
              kinds={kinds}
              config={config}
              api={ADMIN_ITEM_API}
              project={project}
              onAdded={() => {
                // The items changed: an estimate of the old set no longer holds.
                clearEstimate();
                void reload();
              }}
            />
          )}
          <ProjectItemTextDialog
            projectId={id}
            item={previewItem}
            onClose={() => setPreviewItem(null)}
            fetchText={fetchAdminItemText}
            onSave={async text => {
              const updated = await updateAdminProjectItemText(id, previewItem.id, text);
              clearEstimate();
              replaceItem(updated);
              return updated;
            }}
            errorMessage={adminErrorMessage}
          />
          {transfer && (
            <TransferItemsDialog
              project={project}
              items={transfer.items}
              initialMode={transfer.mode}
              onClose={() => setTransfer(null)}
              onDone={handleTransferDone}
            />
          )}
          <ChangeHistoryDrawer
            isOpen={historyOpen}
            onClose={() => setHistoryOpen(false)}
            resource="project"
            readOnly
            resourceId={id}
          />
        </>
      )}

      <ConfirmDialog
        isOpen={Boolean(removeItem)}
        title={t('admin.projects.items.removeTitle', 'Remove item')}
        message={t('admin.projects.items.removeConfirm', 'Remove "{{name}}" from the project?', {
          name: removeItem?.name ?? ''
        })}
        confirmLabel={t('admin.projects.items.actions.remove', 'Remove item')}
        danger
        onConfirm={handleRemove}
        onDeny={() => setRemoveItem(null)}
      />
      <ConfirmDialog
        isOpen={blocker.state === 'blocked'}
        title={t('admin.projects.unsaved.title', 'Unsaved changes')}
        message={t('admin.projects.unsaved.message', 'You have unsaved changes. Leave anyway?')}
        confirmLabel={t('admin.projects.unsaved.leave', 'Leave')}
        denyLabel={t('admin.projects.unsaved.stay', 'Stay')}
        onConfirm={() => blocker.proceed?.()}
        onDeny={() => blocker.reset?.()}
      />
    </div>
  );
}

/**
 * The page of the project in the URL. Mounted per id, so the create form and
 * one project's items never carry state over to another route: React Router
 * reuses the element when only the path changes.
 *
 * @returns {JSX.Element}
 */
function AdminProjectEditPage() {
  // `/admin/projects/new` has no id in its path.
  const { id = 'new' } = useParams();
  return <AdminProjectEditPageContent key={id} id={id} />;
}

export default AdminProjectEditPage;
