// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import DualModeEditor from '../../../shared/components/DualModeEditor';
import AdminEditPageShell from '../../../shared/components/AdminEditPageShell';
import Icon from '../../../shared/components/Icon';
import { useOptionalAuth } from '../../../shared/contexts/authContextValue';
import { fetchContentAccess, makeAdminApiCall, toggleApps } from '../../../api/adminApi';
import { fetchModels, fetchUIConfig } from '../../../api';
import { fetchJsonSchema } from '../../../utils/schemaService';
import { apiErrorMessage } from '../../../utils/apiErrorMessage';
import { getLocalizedContent } from '../../../utils/localizeContent';
import { buildPath } from '../../../utils/runtimeBasePath';
import {
  UI_CREATES_PUBLISHED,
  cleanAppForSave,
  padLoadedApp
} from '../../../../../shared/appDefaults.js';
import AppFormEditor from '../components/AppFormEditor';
import AdminSaveBar from '../components/AdminSaveBar';
import AppTestPanel from '../components/AppTestPanel';
import ChangeHistoryDrawer from '../components/ChangeHistoryDrawer';
import ContentAccessSection from '../components/ContentAccessSection';
import { CALLOUT_CLASS } from '../components/formStyles';
import AppEditorHeader from '../components/app-editor/AppEditorHeader';
import NextStepsCard from '../components/app-editor/NextStepsCard';
import PublishDialog, { UnpublishDialog } from '../components/app-editor/PublishDialog';
import { useAppEditorState } from '../components/app-editor/useAppEditorState';
import { useAppPublishing } from '../components/app-editor/useAppPublishing';
import { useCreatedArrival } from '../components/app-editor/useCreatedArrival';
import { useEditorResources } from '../components/app-editor/useEditorResources';
import EditorGroup from '../components/app-form/EditorGroup';
import EditorGroupNav from '../components/app-form/EditorGroupNav';
import { groupOfField } from '../components/app-form/editorGroups';
import { useEditorGroups } from '../components/app-form/useEditorGroups';

/** Where the page lives and where it leads. Nothing below this file names a path. */
const APPS_PATH = '/admin/apps';
const NEW_APP_PATH = '/admin/apps/new';
const MODELS_PATH = '/admin/models';
const GUIDE_PATH = '/admin/docs/app-quickstart.md';
const CONTENT_CLASS = 'max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8';

const appUrl = appId => `/admin/apps/${encodeURIComponent(appId)}`;
const loadApp = async appId => padLoadedApp((await makeAdminApiCall(appUrl(appId))).data);
const saveApp = (app, appId) =>
  makeAdminApiCall(appUrl(appId), { method: 'PUT', body: cleanAppForSave(app) });
const loadAccess = appId => fetchContentAccess('apps', appId);
const setPublished = (appId, published) => toggleApps([appId], published);
const RESOURCES = {
  fetchModels: () => fetchModels(),
  fetchUiConfig: () => fetchUIConfig(),
  fetchSchema: () => fetchJsonSchema('app')
};

/** The index beside the form; with the test panel open the column is narrower. */
const INDEX_LAYOUT = {
  wide: 'lg:grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:items-start lg:gap-8',
  besideTest: '2xl:grid 2xl:grid-cols-[13rem_minmax(0,1fr)] 2xl:items-start 2xl:gap-8'
};
const TOAST_MS = 4000;

/**
 * The app editor: one existing app, its form, who can use it, and the test
 * chat beside it. An app is created on the "New app" page and arrives here
 * with `?created=1`; the editor has no "new" mode.
 *
 * This file is the frame. It saves, publishes and unpublishes, and holds the
 * state of the editor's groups, which it shares with the form
 * (`components/app-form/`). Its parts live in `components/app-editor/`.
 *
 * @returns {JSX.Element}
 */
function AdminAppEditPage() {
  const { t, i18n } = useTranslation();
  const { appId } = useParams();
  const navigate = useNavigate();
  const user = useOptionalAuth()?.user;
  const isFullAdmin = Boolean(user?.isAdmin || user?.permissions?.adminAccess);
  const uiLanguage = String(i18n.language || '').split('-')[0] || 'en';

  const editor = useAppEditorState({ appId, loadApp, saveApp });
  const { app, savedApp, isDirty, loading, loadError } = editor;
  const { models, uiConfig, jsonSchema } = useEditorResources(RESOURCES);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [editingMode, setEditingMode] = useState('form');
  const [validationState, setValidationState] = useState({ isValid: true, errors: [] });
  const [historyOpen, setHistoryOpen] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const [testFocus, setTestFocus] = useState(0);
  // Bumped whenever the test has to start over: after a save, after access changed.
  const [testRun, setTestRun] = useState(0);
  const [toast, setToast] = useState(null);
  const toastTimerRef = useRef(null);

  const showToast = useCallback(message => {
    clearTimeout(toastTimerRef.current);
    setToast(message);
    toastTimerRef.current = setTimeout(() => setToast(null), TOAST_MS);
  }, []);
  useEffect(() => () => clearTimeout(toastTimerRef.current), []);

  const published = savedApp?.enabled !== false;
  // The name in the reader's language, else in a language the app has (an app
  // named only in German shows that name in an English UI too).
  const appName = getLocalizedContent(app?.name, uiLanguage) || appId;
  const noModel = Array.isArray(models) && models.length === 0 && (app?.type || 'chat') === 'chat';
  const describeError = useCallback(
    error => apiErrorMessage(error, t, t('admin.apps.errorTitle')),
    [t]
  );

  // Always the latest `save` (defined below, once the groups are known): for
  // Ctrl/Cmd+S, whose listener is registered once, and for publishing.
  const saveRef = useRef(null);

  const publishing = useAppPublishing({
    appId,
    isDirty,
    loadAccess,
    setPublished,
    saveFirst: () => saveRef.current(),
    onChanged: enabled => editor.applySaved({ enabled }),
    describeError
  });
  const { access } = publishing;

  const groupsExtra = useMemo(
    () => ({ models: models || [], language: i18n.language, access: access.view }),
    [models, i18n.language, access.view]
  );
  const groups = useEditorGroups({ app, errors: validationState.errors, extra: groupsExtra });
  const formMode = editingMode === 'form';

  /** Opens the group of the first field that needs attention and moves the focus to it. */
  const showFirstError = () => {
    const field = groups.firstErrorField;
    if (!formMode || !field) return false;
    groups.open(groupOfField(field), { focus: field });
    return true;
  };

  /** Saves the form and stays in the editor. Resolves with whether it was saved. */
  const save = async () => {
    if (!app || saving) return false;
    if (!validationState.isValid) {
      if (!showFirstError()) setSaveError(t('admin.apps.edit.validationErrorsExist'));
      return false;
    }
    try {
      setSaving(true);
      setSaveError(null);
      await editor.save();
      setTestRun(run => run + 1);
      showToast(t('admin.apps.edit.saved'));
      return true;
    } catch (error) {
      setSaveError(describeError(error));
      return false;
    } finally {
      setSaving(false);
    }
  };
  saveRef.current = save;

  // Ctrl/Cmd+S saves without leaving the editor.
  useEffect(() => {
    const handleKeyDown = event => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      if (event.key !== 's' && event.key !== 'S') return;
      event.preventDefault();
      void saveRef.current();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Arriving from "Create and test": the test chat opens and a toast says that
  // the app exists; the hook shows the next steps and cleans the URL.
  const arrival = useCreatedArrival({
    appId,
    ready: Boolean(app),
    onArrive: () => {
      setTestOpen(true);
      showToast(t('admin.apps.create.done.toast', { name: appName }));
    }
  });

  const handleStep = step => {
    if (step.group) {
      groups.open(step.group, { focus: true });
    } else if (step.id === 'test') {
      setTestOpen(true);
      setTestFocus(token => token + 1);
    } else if (step.id === 'publish') {
      publishing.askPublish();
    }
  };

  const handleAccessSaved = view => {
    publishing.setAccessView(view);
    // A group that got access a moment ago: the test can load the app now.
    setTestRun(run => run + 1);
  };

  const downloadApp = () => {
    const link = document.createElement('a');
    link.setAttribute(
      'href',
      `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(app, null, 2))}`
    );
    link.setAttribute('download', `app-${app.id}.json`);
    link.click();
  };

  const breadcrumbs = [
    { label: t('documentTitle.admin'), href: '/admin' },
    { label: t('admin.apps.title'), href: APPS_PATH },
    { label: loadError ? appId : appName }
  ];

  // A failed load: the shell shows the error with an in-place Retry, and no form
  // (rendering it would only show defaults that a Save would store).
  if (loadError && !loading) {
    return (
      <AdminEditPageShell
        loading={false}
        contentClassName={CONTENT_CLASS}
        breadcrumbs={breadcrumbs}
        blocker={editor.blocker}
        loadError={loadError}
        onRetry={editor.retryLoad}
        resourceLabel={t('admin.apps.edit.resource', 'app "{{id}}"', { id: appId })}
        notFoundAction={{
          label: t('admin.apps.edit.backToApps', 'Back to Apps'),
          onClick: () => navigate(APPS_PATH)
        }}
      />
    );
  }

  const errorCount = groups.totalErrors;
  let barMessage;
  if (errorCount > 0) barMessage = t('admin.apps.edit.fieldsNeedAttention', { count: errorCount });
  else if (published) barMessage = t('admin.apps.edit.liveHint');
  const canJump = errorCount > 0 && formMode && Boolean(groups.firstErrorField);

  return (
    // With the test panel open the page splits: the editor scrolls on the
    // left, the app runs on the right (full screen below the lg breakpoint).
    <div className={testOpen ? 'lg:flex lg:h-full' : undefined}>
      {/* The form's scroll column. The save bar is its last child, so it never
          runs under the test panel. */}
      <div className={testOpen ? 'lg:flex-1 lg:min-w-0 lg:overflow-y-auto' : undefined}>
        <AdminEditPageShell
          loading={loading}
          loadingFallback={
            <div className={`${CONTENT_CLASS} text-center`}>
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600 mx-auto"></div>
              <p className="mt-2 text-gray-600 dark:text-gray-400">{t('admin.apps.loading')}</p>
            </div>
          }
          contentClassName={CONTENT_CLASS}
          breadcrumbs={breadcrumbs}
          blocker={editor.blocker}
        >
          <AppEditorHeader
            appId={appId}
            name={appName}
            icon={app?.icon}
            color={app?.color}
            published={published}
            testOpen={testOpen}
            onToggleTest={() => setTestOpen(open => !open)}
            onPublish={publishing.askPublish}
            onUnpublish={publishing.askUnpublish}
            onOpenApp={() =>
              window.open(
                buildPath(`/apps/${encodeURIComponent(appId)}`),
                '_blank',
                'noopener,noreferrer'
              )
            }
            // An app that is not published opens only where the server serves it to its authors.
            openAppDisabled={!published && UI_CREATES_PUBLISHED}
            onHistory={() => setHistoryOpen(true)}
            onDownload={downloadApp}
            onDuplicate={() => navigate(`${NEW_APP_PATH}?from=${encodeURIComponent(appId)}`)}
          />

          {saveError && (
            <div role="alert" className={`mt-6 flex items-start gap-2 ${CALLOUT_CLASS.danger}`}>
              <Icon name="x-circle" className="shrink-0" aria-hidden="true" />
              <div>
                <h2 className="font-medium">{t('admin.apps.errorTitle')}</h2>
                <p className="mt-1">{saveError}</p>
              </div>
            </div>
          )}

          {arrival.stepsShown && (
            <NextStepsCard
              onStep={handleStep}
              onDismiss={arrival.dismissSteps}
              published={published}
              focusHeading={arrival.focusSteps}
              guideHref={isFullAdmin ? buildPath(GUIDE_PATH) : null}
            />
          )}

          <div className={`mt-8 ${testOpen ? INDEX_LAYOUT.besideTest : INDEX_LAYOUT.wide}`}>
            {formMode && <EditorGroupNav groups={groups} compact={testOpen} />}
            <div className={formMode ? 'min-w-0' : 'min-w-0 col-span-full'}>
              <DualModeEditor
                value={app}
                onChange={editor.setApp}
                formComponent={AppFormEditor}
                formProps={{ availableModels: models || [], uiConfig, jsonSchema, groups }}
                jsonSchema={jsonSchema}
                defaultMode={editingMode}
                onModeChange={setEditingMode}
                onValidationChange={setValidationState}
                showValidationSummary={true}
                className="mb-6"
              />

              {/* Which groups may use this app (groups.json); saved on its own. */}
              <EditorGroup id="access" groups={groups}>
                <ContentAccessSection
                  resourceType="apps"
                  resourceId={appId}
                  onSaved={handleAccessSaved}
                />
              </EditorGroup>
            </div>
          </div>
        </AdminEditPageShell>

        <AdminSaveBar
          dirty={isDirty}
          saving={saving}
          onSave={() => void save()}
          onDiscard={editor.discard}
          message={barMessage}
          action={
            canJump
              ? { label: t('admin.apps.edit.showFirstError'), onClick: showFirstError }
              : undefined
          }
        />
      </div>

      {testOpen && app && (
        <AppTestPanel
          appId={appId}
          enabled={published}
          isDirty={isDirty}
          reloadKey={testRun}
          onClose={() => setTestOpen(false)}
          noModel={noModel}
          modelSetupHref={isFullAdmin ? MODELS_PATH : null}
          onOpenAccess={() => groups.open('access', { focus: true })}
          focusToken={testFocus}
        />
      )}

      {toast && (
        <div
          role="status"
          className="fixed top-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 rounded-md bg-green-700 px-4 py-2 text-sm text-white shadow-lg"
        >
          <Icon name="check-circle" className="h-4 w-4" />
          {toast}
        </div>
      )}

      <PublishDialog
        isOpen={publishing.dialog === 'publish'}
        name={appName}
        access={access}
        savesFirst={isDirty}
        noModel={noModel}
        busy={publishing.busy}
        error={publishing.error}
        onConfirm={publishing.confirm}
        onCancel={publishing.cancel}
      />
      <UnpublishDialog
        isOpen={publishing.dialog === 'unpublish'}
        name={appName}
        busy={publishing.busy}
        error={publishing.error}
        onConfirm={publishing.confirm}
        onCancel={publishing.cancel}
      />

      <ChangeHistoryDrawer
        isOpen={historyOpen}
        onClose={() => setHistoryOpen(false)}
        resource="app"
        resourceId={appId}
      />
    </div>
  );
}

export default AdminAppEditPage;
