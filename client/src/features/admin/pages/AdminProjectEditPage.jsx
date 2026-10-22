// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import DynamicLanguageEditor from '../../../shared/components/DynamicLanguageEditor';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import {
  addAdminProjectItem,
  checkProjectPickerUrl,
  createAdminProject,
  deleteAdminProjectItem,
  fetchAdminProjectConfig,
  fetchAdminProjectItemText,
  fetchAdminProjectKinds,
  fetchProjectPickerPages,
  getAdminApiErrorMessage,
  refreshAdminProjectItem,
  searchProjectPickerIFinder,
  testAdminProject,
  updateAdminProject,
  updateAdminProjectItem,
  updateAdminProjectItemText,
  uploadAdminProjectItem
} from '../../../api/adminApi';
import AdminBreadcrumb from '../components/AdminBreadcrumb';
import ChangeHistoryDrawer from '../components/ChangeHistoryDrawer';
import AddProjectItemDialog from '../../projects/components/AddProjectItemDialog';
import ProjectItemsTable from '../../projects/components/ProjectItemsTable';
import ProjectItemTextDialog from '../../projects/components/ProjectItemTextDialog';
import ProjectTestResults from '../components/ProjectTestResults';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { useAdminProject } from '../hooks/useAdminProject';
import {
  MAX_PROJECT_ID_LENGTH,
  buildProjectPayload,
  createEmptyProjectForm,
  parseTags,
  projectFormFromProject,
  uploadsAreUnscanned,
  validateProjectForm
} from '../utils/projectAdmin';
import { localizedText } from '../../projects/utils/projectItems';

const INPUT_CLASS =
  'w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500';
const LABEL_CLASS = 'block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2';

/**
 * What the shared "Add item" dialog calls for an admin project: the admin
 * item routes and the user picker endpoints. Admin projects get no cloud tab.
 */
const ADMIN_ITEM_API = {
  addItem: (...args) => addAdminProjectItem(...args),
  uploadItem: (...args) => uploadAdminProjectItem(...args),
  fetchPages: () => fetchProjectPickerPages(),
  searchIFinder: query => searchProjectPickerIFinder(query),
  checkUrl: url => checkProjectPickerUrl(url),
  errorMessage: err => getAdminApiErrorMessage(err)
};

/** Text loader of the shared preview dialog. */
const fetchAdminItemText = (...args) => fetchAdminProjectItemText(...args);
const adminErrorMessage = err => getAdminApiErrorMessage(err);

/**
 * Admin → Projects → new / edit (#1036). Edits the project's settings (id on
 * create only, localized name and description, instructions, enabled,
 * category, tags) and, once the project exists, its items: add (one tab per
 * kind), pin, preview the text, retry, refresh, remove, and a test of every
 * item. While an item is being extracted the page re-reads the project
 * every two seconds.
 *
 * @returns {JSX.Element}
 */
function AdminProjectEditPage() {
  const { t, i18n } = useTranslation();
  const language = i18n?.language || 'en';
  const { id } = useParams();
  const navigate = useNavigate();
  const isNew = id === 'new';

  const {
    project,
    setProject,
    loading,
    error: loadError,
    reload
  } = useAdminProject(isNew ? null : id);
  const [form, setForm] = useState(() => (isNew ? createEmptyProjectForm() : null));
  const [initialForm, setInitialForm] = useState(() => (isNew ? createEmptyProjectForm() : null));
  const [tagsText, setTagsText] = useState('');
  const [validationErrors, setValidationErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [kinds, setKinds] = useState([]);
  const [config, setConfig] = useState(null);
  const [addOpen, setAddOpen] = useState(false);
  const [previewItem, setPreviewItem] = useState(null);
  const [busyItemId, setBusyItemId] = useState(null);
  const [removeItem, setRemoveItem] = useState(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  const { blocker, markSaved } = useUnsavedChanges(initialForm, form);

  // The form is filled once per loaded project (state adjusted during render,
  // not in an effect); polling later only refreshes the items.
  const [filledFor, setFilledFor] = useState(null);
  if (!isNew && project && project.id !== filledFor) {
    const next = projectFormFromProject(project);
    setFilledFor(project.id);
    setForm(next);
    setInitialForm(next);
    setTagsText(next.tags.join(', '));
  }

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
        'IDs starting with "prj_" are reserved for user projects.'
      )
    },
    name: {
      required: t('admin.projects.validation.nameRequired', 'A name is required.')
    }
  };

  const handleChange = (field, value) => {
    setForm(prev => ({ ...prev, [field]: value }));
    if (validationErrors[field]) {
      setValidationErrors(prev => {
        const { [field]: _removed, ...rest } = prev;
        return rest;
      });
    }
  };

  const handleSave = async event => {
    event.preventDefault();
    const nextForm = { ...form, tags: parseTags(tagsText) };
    const errors = validateProjectForm(nextForm, { isNew });
    setValidationErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setSaving(true);
    setError(null);
    try {
      const payload = buildProjectPayload(nextForm);
      if (isNew) {
        const created = await createAdminProject(payload);
        markSaved();
        // Items can be added once the project exists.
        navigate(`/admin/projects/${encodeURIComponent(created?.id || payload.id)}`, {
          replace: true
        });
        return;
      }
      const updated = await updateAdminProject(id, payload);
      if (updated) setProject(updated);
      const saved = projectFormFromProject(updated || { ...project, ...payload });
      setForm(saved);
      setInitialForm(saved);
      setTagsText(saved.tags.join(', '));
      markSaved();
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
      replaceItem(await refreshAdminProjectItem(id, item.id));
      await reload();
    });

  const handleRemove = async () => {
    const item = removeItem;
    setRemoveItem(null);
    await runItemAction(item, async () => {
      await deleteAdminProjectItem(id, item.id);
      setProject(prev =>
        prev ? { ...prev, items: (prev.items || []).filter(entry => entry.id !== item.id) } : prev
      );
    });
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await testAdminProject(id));
    } catch (err) {
      setTestResult({
        success: false,
        duration: 0,
        items: [],
        error: getAdminApiErrorMessage(err)
      });
    } finally {
      setTesting(false);
    }
  };

  if (loading || (!isNew && (!project || !form) && !loadError)) {
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

  const title = isNew
    ? t('admin.projects.createNew', 'New project')
    : localizedText(project?.name, language) || id;
  const idError = validationErrors.id
    ? validationErrors.id === 'exists'
      ? t('admin.projects.validation.idExists', 'A project with this ID already exists.')
      : validationMessages.id[validationErrors.id]
    : null;

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
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setHistoryOpen(true)}
                className="rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-600"
              >
                {t('admin.projects.history', 'History')}
              </button>
              <button
                type="button"
                onClick={handleTest}
                disabled={testing}
                className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-4 py-2 rounded-lg font-medium flex items-center"
              >
                <Icon
                  name={testing ? 'arrow-path' : 'beaker'}
                  className={`h-4 w-4 mr-2 ${testing ? 'animate-spin' : ''}`}
                />
                {testing
                  ? t('admin.projects.test.running', 'Testing...')
                  : t('admin.projects.test.button', 'Test')}
              </button>
            </div>
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

        <div className="space-y-6">
          <form
            onSubmit={handleSave}
            noValidate
            className="bg-white dark:bg-gray-800 rounded-lg shadow-xs p-6 space-y-6"
          >
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label htmlFor="project-id" className={LABEL_CLASS}>
                  {t('admin.projects.fields.id', 'Project ID')} *
                </label>
                <input
                  id="project-id"
                  type="text"
                  value={form.id}
                  disabled={!isNew}
                  maxLength={MAX_PROJECT_ID_LENGTH}
                  onChange={e => handleChange('id', e.target.value)}
                  placeholder="employee-handbook"
                  aria-invalid={Boolean(idError)}
                  className={`${INPUT_CLASS} ${!isNew ? 'opacity-60 cursor-not-allowed' : ''} ${
                    idError ? 'border-red-400' : ''
                  }`}
                />
                {idError && <p className="mt-1 text-sm text-red-600">{idError}</p>}
                {!isNew && (
                  <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                    {t('admin.projects.fields.idFixed', 'The ID cannot be changed after creation.')}
                  </p>
                )}
              </div>
              <div className="flex items-end">
                <label className="flex items-center gap-2 pb-2 text-sm text-gray-700 dark:text-gray-300">
                  <input
                    type="checkbox"
                    checked={form.enabled}
                    onChange={e => handleChange('enabled', e.target.checked)}
                    className="h-4 w-4 text-indigo-600 border-gray-300 rounded-sm focus:ring-indigo-500"
                  />
                  {t('admin.projects.fields.enabled', 'Enabled')}
                </label>
              </div>
            </div>

            <div>
              <label className={LABEL_CLASS}>{t('admin.projects.fields.name', 'Name')} *</label>
              <DynamicLanguageEditor
                value={form.name}
                onChange={value => handleChange('name', value)}
                placeholder={t('admin.projects.fields.namePlaceholder', 'Project name')}
                error={validationErrors.name ? validationMessages.name.required : null}
              />
            </div>

            <div>
              <label className={LABEL_CLASS}>
                {t('admin.projects.fields.description', 'Description')}
              </label>
              <DynamicLanguageEditor
                value={form.description}
                onChange={value => handleChange('description', value)}
                placeholder={t(
                  'admin.projects.fields.descriptionPlaceholder',
                  'What this project contains'
                )}
                type="textarea"
              />
            </div>

            <div>
              <label htmlFor="project-instructions" className={LABEL_CLASS}>
                {t('admin.projects.fields.instructions', 'Instructions')}
              </label>
              <textarea
                id="project-instructions"
                rows={5}
                value={form.instructions}
                onChange={e => handleChange('instructions', e.target.value)}
                className={INPUT_CLASS}
              />
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                {t(
                  'admin.projects.fields.instructionsHint',
                  'Instructions apply when the project is in context.'
                )}
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label htmlFor="project-category" className={LABEL_CLASS}>
                  {t('admin.projects.fields.category', 'Category')}
                </label>
                <input
                  id="project-category"
                  type="text"
                  value={form.category}
                  maxLength={100}
                  onChange={e => handleChange('category', e.target.value)}
                  placeholder={t('admin.projects.fields.categoryPlaceholder', 'Optional category')}
                  className={INPUT_CLASS}
                />
              </div>
              <div>
                <label htmlFor="project-tags" className={LABEL_CLASS}>
                  {t('admin.projects.fields.tags', 'Tags')}
                </label>
                <input
                  id="project-tags"
                  type="text"
                  value={tagsText}
                  onChange={e => {
                    setTagsText(e.target.value);
                    setForm(prev => ({ ...prev, tags: parseTags(e.target.value) }));
                  }}
                  placeholder={t('admin.projects.fields.tagsPlaceholder', 'hr, policies')}
                  className={INPUT_CLASS}
                />
                <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                  {t('admin.projects.fields.tagsHint', 'Separate tags with commas.')}
                </p>
              </div>
            </div>

            <div className="flex items-center justify-between pt-2">
              <button
                type="button"
                onClick={() => navigate('/admin/projects')}
                className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-600"
              >
                {t('common.cancel', 'Cancel')}
              </button>
              <button
                type="submit"
                disabled={saving}
                className="px-6 py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50 flex items-center"
              >
                {saving && <Icon name="arrow-path" className="animate-spin h-4 w-4 mr-2" />}
                {saving
                  ? t('common.saving', 'Saving...')
                  : isNew
                    ? t('admin.projects.createAndContinue', 'Create and add items')
                    : t('common.save', 'Save')}
              </button>
            </div>
          </form>

          {testResult && (
            <ProjectTestResults result={testResult} onDismiss={() => setTestResult(null)} />
          )}

          <section className="bg-white dark:bg-gray-800 rounded-lg shadow-xs p-6">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
              <h2 className="text-lg font-medium text-gray-900 dark:text-gray-100">
                {t('admin.projects.items.title', 'Items')}
              </h2>
              {!isNew && (
                <button
                  type="button"
                  onClick={() => setAddOpen(true)}
                  className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-sm font-medium flex items-center"
                >
                  <Icon name="plus" className="h-4 w-4 mr-2" />
                  {t('admin.projects.items.add', 'Add item')}
                </button>
              )}
            </div>
            {isNew ? (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {t(
                  'admin.projects.items.saveFirst',
                  'Create the project first; then you can add items to it.'
                )}
              </p>
            ) : (
              <ProjectItemsTable
                items={project?.items || []}
                kinds={kinds}
                busyItemId={busyItemId}
                onTogglePinned={handleTogglePinned}
                onPreview={setPreviewItem}
                onRefresh={handleRefresh}
                onRemove={setRemoveItem}
              />
            )}
          </section>
        </div>
      </div>

      {!isNew && (
        <>
          {addOpen && (
            <AddProjectItemDialog
              isOpen
              onClose={() => setAddOpen(false)}
              projectId={id}
              kinds={kinds}
              config={config}
              api={ADMIN_ITEM_API}
              onAdded={() => void reload()}
            />
          )}
          <ProjectItemTextDialog
            projectId={id}
            item={previewItem}
            onClose={() => setPreviewItem(null)}
            fetchText={fetchAdminItemText}
            onSave={async text => {
              const updated = await updateAdminProjectItemText(id, previewItem.id, text);
              replaceItem(updated);
              return updated;
            }}
            errorMessage={adminErrorMessage}
          />
          <ChangeHistoryDrawer
            isOpen={historyOpen}
            onClose={() => setHistoryOpen(false)}
            resource="project"
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

export default AdminProjectEditPage;
