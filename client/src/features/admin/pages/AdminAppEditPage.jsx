// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import DualModeEditor from '../../../shared/components/DualModeEditor';
import AdminEditPageShell from '../../../shared/components/AdminEditPageShell';
import { useOptionalAuth } from '../../../shared/contexts/authContextValue';
import { usePlatformConfig } from '../../../shared/contexts/platformConfigContextValue';
import useMediaQuery from '../../../shared/hooks/useMediaQuery';
import { apiErrorMessage } from '../../../utils/apiErrorMessage';
import { getLocalizedContent } from '../../../utils/localizeContent';
import { buildPath } from '../../../utils/runtimeBasePath';
import { UI_CREATES_PUBLISHED, primaryLanguageOf } from '../../../../../shared/appDefaults.js';
import AppFormEditor from '../components/AppFormEditor';
import { CALLOUT_CLASS, SECONDARY_BUTTON_CLASS } from '../components/formStyles';
import ConversationPanel from '../components/app-conversation/ConversationPanel';
import { adminStakes } from '../components/app-conversation/stakes';
import { unsavedOutsideChange } from '../components/app-conversation/conversationState';
import {
  CONVERSATION_VIEW,
  VIEW_PARAM,
  useAppBuilderFeatures
} from '../components/app-conversation/useAppBuilderChat';
import { adminAppSource } from '../utils/adminAppSource';
import AppTestPanel from '../components/AppTestPanel';
import ChangeHistoryDrawer from '../components/ChangeHistoryDrawer';
import ContentAccessSection from '../components/ContentAccessSection';
import ItemAccessTools from '../components/access/ItemAccessTools';
import AppEditorHeader from '../components/app-editor/AppEditorHeader';
import EditorSaveBar from '../components/app-editor/EditorSaveBar';
import EditorToast, {
  EditorSaveError,
  useEditorToast
} from '../components/app-editor/EditorMessages';
import NextStepsCard from '../components/app-editor/NextStepsCard';
import { PublishDialogs } from '../components/app-editor/PublishDialog';
import {
  EDITOR_RESOURCES,
  isAppSaveConflict,
  loadAccess,
  loadApp,
  saveApp,
  setPublished
} from '../components/app-editor/adminAppRequests';
import { downloadApp } from '../components/app-editor/downloadApp';
import { useAppAccess } from '../components/app-editor/useAppAccess';
import { useAppEditorState } from '../components/app-editor/useAppEditorState';
import { useAppPublishing } from '../components/app-editor/useAppPublishing';
import { useCreatedArrival } from '../components/app-editor/useCreatedArrival';
import { useEditorResources } from '../components/app-editor/useEditorResources';
import { useEditorSave } from '../components/app-editor/useEditorSave';
import EditorGroup from '../components/app-form/EditorGroup';
import EditorGroupNav from '../components/app-form/EditorGroupNav';
import { groupOfField } from '../components/app-form/editorGroups';
import { useEditorGroups } from '../components/app-form/useEditorGroups';
import { hasNoUsableModel } from '../components/app-form/modelChoices';
import { useDeletedResourceRestore } from '../hooks/useDeletedResourceRestore';

/** Where the page lives and where it leads. Its parts name no page. */
const APPS_PATH = '/admin/apps';
const NEW_APP_PATH = '/admin/apps/new';
const MODELS_PATH = '/admin/models';
const GUIDE_PATH = '/admin/docs/app-quickstart.md';
/** The one group the page renders itself; the form renders the others. */
const ACCESS_GROUP = 'access';
const NO_ERRORS = Object.freeze([]);
const CONTENT_CLASS = 'max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8';
/** From here up the test panel sits beside the editor; below it is a full-screen dialog. */
const WIDE_QUERY = '(min-width: 1024px)';

const openApp = appId =>
  window.open(buildPath(`/apps/${encodeURIComponent(appId)}`), '_blank', 'noopener,noreferrer');

/** The index beside the form; with the test panel open the column is narrower. */
const INDEX_LAYOUT = {
  wide: 'lg:grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:items-start lg:gap-8',
  besideTest: '2xl:grid 2xl:grid-cols-[13rem_minmax(0,1fr)] 2xl:items-start 2xl:gap-8'
};

/**
 * The app editor: one existing app, its form, who can use it, and the test
 * chat beside it. An app is created on the "New app" page and arrives here
 * with `?created=1`; the editor has no "new" mode.
 *
 * This file is the frame. It saves, publishes and unpublishes, and holds the
 * state of the editor's groups, which it shares with the form
 * (`components/app-form/`). Its parts live in `components/app-editor/`; the
 * requests they run are those of `adminAppRequests.js`.
 *
 * @returns {JSX.Element}
 */
function AdminAppEditPage() {
  const { t, i18n } = useTranslation();
  const { appId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const user = useOptionalAuth()?.user;
  const isFullAdmin = Boolean(user?.isAdmin || user?.permissions?.adminAccess);
  const uiLanguage = String(i18n.language || '').split('-')[0] || 'en';
  const { platformConfig } = usePlatformConfig();
  const features = useAppBuilderFeatures();
  const wide = useMediaQuery(WIDE_QUERY);

  // The revision (`ETag`) of the app this editor loaded: a save sends it as
  // `If-Match`, so it cannot overwrite a change someone else saved in between.
  // Every write of the editor to the app file (save, Apply, Undo, Publish,
  // Unpublish) takes the new revision; a restore from the history reloads it.
  const revisionRef = useRef(null);
  const requests = useMemo(
    () => ({
      loadApp: id => loadApp(id, revisionRef),
      saveApp: (value, id) => saveApp(value, id, revisionRef)
    }),
    []
  );
  const publishApp = useMemo(() => (id, published) => setPublished(id, published, revisionRef), []);
  const editor = useAppEditorState({ appId, ...requests });
  const { app, savedApp, isDirty, loading, loadError } = editor;
  const { models, uiConfig, jsonSchema } = useEditorResources(EDITOR_RESOURCES);
  const { access, refreshAccess, setAccessView } = useAppAccess({ appId, loadAccess });

  const [editingMode, setEditingMode] = useState('form');
  const [validationState, setValidationState] = useState({ isValid: true, errors: [] });
  const [historyOpen, setHistoryOpen] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const [testFocus, setTestFocus] = useState(0);
  // Bumped whenever the test has to start over: after a save, after access changed.
  const [testRun, setTestRun] = useState(0);
  // Bumped when the group card granted or revoked: the access tools read the groups again.
  const [accessVersion, setAccessVersion] = useState(0);
  // Bumped when "Restrict access" changed groups: the group card loads again.
  const [groupCardKey, setGroupCardKey] = useState(0);
  const [toast, showToast] = useEditorToast();
  // Where the focus goes when its control leaves the page (Publish, "Hide these steps").
  const headingRef = useRef(null);
  const editorRef = useRef(null);

  const published = savedApp?.enabled !== false;
  // In the reader's language, else in one the app has: a German-only name shows in an English UI.
  const appName = getLocalizedContent(app?.name, uiLanguage) || appId;
  const isChat = (app?.type || 'chat') === 'chat';
  // The editor lists disabled models too: "no model" means none of them is enabled.
  const noModel = hasNoUsableModel(models) && isChat;
  // A deleted app's page offers to restore it from its change history.
  const { restorable } = useDeletedResourceRestore({
    resource: 'app',
    resourceId: appId,
    notFound: loadError?.status === 404
  });
  // The conversation (`?view=conversation`) needs both AI features and a chat app.
  const conversationOffered = features.chat && features.generator && isChat;
  const conversationView =
    conversationOffered &&
    new URLSearchParams(location.search).get(VIEW_PARAM) === CONVERSATION_VIEW;
  const formMode = editingMode === 'form' && !conversationView;
  const describeError = error => apiErrorMessage(error, t, t('admin.apps.errorTitle'));

  const groupsExtra = useMemo(
    () => ({ models: models || [], language: i18n.language, access: access.view }),
    [models, i18n.language, access.view]
  );
  // The JSON editor reports its markers, warnings included, and none of them
  // names a field: only the form's errors are counted and booked on a group.
  const groups = useEditorGroups({
    app,
    errors: formMode ? validationState.errors : NO_ERRORS,
    extra: groupsExtra,
    view: editingMode
  });

  /** Opens the group of the first field that needs attention and moves the focus to it. */
  const showFirstError = () => {
    const field = groups.firstErrorField;
    if (!formMode || !field) return false;
    groups.open(groupOfField(field), { focus: field });
    return true;
  };

  const { saving, saveError, save, saveValue, conflict, clearConflict, reportConflict } =
    useEditorSave({
      ready: Boolean(app),
      valid: validationState.isValid,
      persist: editor.save,
      persistValue: editor.saveValue,
      // The JSON editor has no field to lead to; there the sentence stands in.
      explainInvalid: () => (showFirstError() ? null : t('admin.apps.edit.validationErrorsExist')),
      describeError,
      isConflict: isAppSaveConflict,
      onSaved: () => {
        setTestRun(run => run + 1);
        showToast(t('admin.apps.edit.saved'));
      }
    });

  /**
   * The conversation's Apply and Undo: the editor's own save, conditional on
   * the revision this editor loaded. When the form holds other unsaved edits
   * than the change's own keys (any key, content keys included), they are
   * saved too, so the form's validity check runs as for Save. The test chat
   * restarts on the saved app; below `lg`, where the test is a dialog, a toast
   * points to it.
   *
   * @param {object} next - The form with the change merged over it, or put back.
   * @param {{ keys: string[] }} change - The keys the change writes.
   */
  const persistFromConversation = async (next, { keys } = { keys: [] }) => {
    const checkForm = unsavedOutsideChange(next, savedApp, keys);
    const outcome = await saveValue(next, { checkForm });
    if (outcome.status !== 'saved') return outcome;
    setTestRun(run => run + 1);
    if (!wide) showToast(t('admin.apps.conversation.toast'));
    return { status: 'saved', value: next };
  };

  /** Shows the form or the conversation; opening the conversation opens the test beside it. */
  const setView = next => {
    const params = new URLSearchParams(location.search);
    if (next === CONVERSATION_VIEW) params.set(VIEW_PARAM, CONVERSATION_VIEW);
    else params.delete(VIEW_PARAM);
    const search = params.toString();
    navigate({ search: search ? `?${search}` : '', hash: location.hash }, { replace: true });
  };

  // The conversation is used together with the test chat: on a wide screen it opens beside it.
  // Below `lg` the test would cover the conversation, so it stays a button away.
  const appLoaded = Boolean(app);
  useEffect(() => {
    // The view comes from the URL: this is the one place it opens the panel.
    // eslint-disable-next-line @eslint-react/set-state-in-effect
    if (conversationView && appLoaded && wide) setTestOpen(true);
  }, [conversationView, appLoaded, wide]);

  /** Reads the app again after a conflict; the author's edits are dropped. */
  const reloadAfterConflict = async () => {
    clearConflict();
    await editor.retryLoad();
  };

  const contentLanguage = primaryLanguageOf(app, uiLanguage, platformConfig?.defaultLanguage);
  const stakes = useMemo(
    () =>
      adminStakes({
        published,
        accessView: access.view,
        integrationNames: Object.keys(savedApp?.integrations || {})
      }),
    [published, access.view, savedApp?.integrations]
  );

  const publishing = useAppPublishing({
    appId,
    isDirty,
    setPublished: publishApp,
    saveFirst: save,
    // The toggle changed the stored flag only; it is not an edit of the form.
    onChanged: enabled => {
      editor.applySaved({ enabled });
      // "Publish" is gone once the app is published. The focus moves before the
      // dialog closes, which then leaves it there instead of dropping it on <body>.
      if (enabled) headingRef.current?.focus();
    },
    describeError,
    // Someone else saved the app since it was loaded: the conflict notice offers to reload.
    isConflict: isAppSaveConflict,
    onConflict: reportConflict,
    // Groups may have changed since the page loaded; say who sees the app now.
    onAskPublish: refreshAccess
  });

  // Arriving from "Create and test": the test chat opens and a toast says that
  // the app exists; the hook shows the next steps and cleans the URL.
  const arrival = useCreatedArrival({
    appId,
    ready: Boolean(app),
    onArrive: ({ conversation: toConversation } = {}) => {
      // Into the conversation on a small screen, the test would cover it: it stays a button away.
      if (!toConversation || wide) setTestOpen(true);
      showToast(t('admin.apps.create.done.toast', { name: appName }));
    }
  });

  /**
   * Where a link leads: to a group of the editor, or to the test chat. A group
   * of the form is not on the page while the JSON editor is, so the editor is
   * asked for the form first (it confirms with unsaved changes); the focus
   * follows once the group is rendered.
   */
  const openGroup = id => {
    if (conversationView) setView('form');
    else if (!formMode && id !== ACCESS_GROUP) editorRef.current?.switchMode('form');
    groups.open(id, { focus: true });
  };
  const showTest = () => {
    setTestOpen(true);
    setTestFocus(token => token + 1);
  };

  const handleAccessSaved = view => {
    setAccessView(view);
    // A group that got access a moment ago: the test can load the app now.
    setTestRun(run => run + 1);
    setAccessVersion(version => version + 1);
  };

  // "Restrict access" rewrote groups: the group card and the publish dialog read them again.
  const handleRestricted = () => {
    setGroupCardKey(key => key + 1);
    void refreshAccess();
    setTestRun(run => run + 1);
  };

  return (
    // With the test panel open the page splits: editor left, app right (full screen below lg).
    <div className={testOpen ? 'lg:flex lg:h-full' : undefined}>
      {/* The form's scroll column. The save bar is its last child, so it never
          runs under the test panel. */}
      <div
        className={testOpen ? 'lg:flex-1 lg:min-w-0 lg:overflow-y-auto' : undefined}
        // Beside the test chat the form's cards are one column (`md:form-cols:` in tailwind.css).
        data-form-narrow={testOpen ? '' : undefined}
      >
        {/* An app that did not load shows the error, with Retry, in place of the editor. */}
        <AdminEditPageShell
          loading={loading}
          loadingFallback={
            <div className={`${CONTENT_CLASS} text-center`}>
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600 mx-auto"></div>
              <p className="mt-2 text-gray-600 dark:text-gray-400">{t('admin.apps.loading')}</p>
            </div>
          }
          contentClassName={CONTENT_CLASS}
          breadcrumbs={[
            { label: t('documentTitle.admin'), href: '/admin' },
            { label: t('admin.apps.title'), href: APPS_PATH },
            { label: appName }
          ]}
          blocker={editor.blocker}
          loadError={loadError}
          onRetry={editor.retryLoad}
          resourceLabel={t('admin.apps.edit.resource', 'app "{{id}}"', { id: appId })}
          notFoundAction={
            restorable
              ? {
                  label: t('admin.restoreDeleted.action', 'Restore from History'),
                  onClick: () => setHistoryOpen(true)
                }
              : {
                  label: t('admin.apps.edit.backToApps', 'Back to Apps'),
                  onClick: () => navigate(APPS_PATH)
                }
          }
        >
          <AppEditorHeader
            appId={appId}
            name={appName}
            icon={app?.icon}
            color={app?.color}
            published={published}
            testOpen={testOpen}
            onToggleTest={() => {
              // Opened from the header, the panel does not take the focus.
              setTestFocus(0);
              setTestOpen(open => !open);
            }}
            onPublish={publishing.askPublish}
            onUnpublish={publishing.askUnpublish}
            onOpenApp={() => openApp(appId)}
            // An app that is not published opens only where the server serves it to its authors.
            openAppDisabled={!published && UI_CREATES_PUBLISHED}
            onHistory={() => setHistoryOpen(true)}
            onDownload={() => downloadApp(app)}
            onDuplicate={() => navigate(`${NEW_APP_PATH}?from=${encodeURIComponent(appId)}`)}
            headingRef={headingRef}
            view={conversationView ? CONVERSATION_VIEW : 'form'}
            onViewChange={conversationOffered ? setView : undefined}
          />

          <EditorSaveError message={saveError} />

          {conflict && (
            <div role="alert" className={`mt-6 ${CALLOUT_CLASS.warning}`}>
              <h2 className="font-medium">{t('admin.apps.edit.conflict.title')}</h2>
              <p className="mt-1">{t('admin.apps.edit.conflict.message')}</p>
              <button
                type="button"
                onClick={() => void reloadAfterConflict()}
                className={`mt-3 ${SECONDARY_BUTTON_CLASS}`}
              >
                {t('admin.apps.edit.conflict.reload')}
              </button>
            </div>
          )}

          {arrival.stepsShown && !conversationView && (
            <NextStepsCard
              onOpenGroup={openGroup}
              onTest={showTest}
              onPublish={publishing.askPublish}
              onDismiss={() => {
                // The card goes, and with it the button that has the focus.
                headingRef.current?.focus();
                arrival.dismissSteps();
              }}
              published={published}
              groupIds={groups.groups.map(group => group.id)}
              canTest={isChat}
              focusHeading={arrival.focusSteps}
              guideHref={isFullAdmin ? buildPath(GUIDE_PATH) : null}
            />
          )}

          {conversationView ? (
            // The conversation edits the same app as the form; "Form" in the header is one click away.
            <div className="mt-8">
              <ConversationPanel
                appId={appId}
                target="admin"
                form={app}
                language={contentLanguage}
                refine={adminAppSource.refineDraft}
                persist={persistFromConversation}
                stakes={stakes}
                testOpen={testOpen && wide}
                saved={savedApp}
              />
            </div>
          ) : (
            <div className={`mt-8 ${testOpen ? INDEX_LAYOUT.besideTest : INDEX_LAYOUT.wide}`}>
              {formMode && <EditorGroupNav groups={groups} compact={testOpen} />}
              <div className={formMode ? 'min-w-0' : 'min-w-0 col-span-full'}>
                <DualModeEditor
                  value={app}
                  savedValue={savedApp}
                  onChange={editor.setApp}
                  formComponent={AppFormEditor}
                  formProps={{ availableModels: models || [], uiConfig, jsonSchema, groups }}
                  jsonSchema={jsonSchema}
                  defaultMode={editingMode}
                  controlRef={editorRef}
                  onModeChange={setEditingMode}
                  onValidationChange={setValidationState}
                  className="mb-6"
                />

                {/* Which groups may use this app (groups.json); saved on its own. */}
                <EditorGroup id={ACCESS_GROUP} groups={groups}>
                  <ContentAccessSection
                    key={groupCardKey}
                    resourceType="apps"
                    resourceId={appId}
                    onSaved={handleAccessSaved}
                  />
                  {/* Restrict access (W3) is for full admins; a content admin gets the
                    access check for the groups they manage. */}
                  <ItemAccessTools
                    type="apps"
                    id={appId}
                    itemName={appName}
                    refreshKey={accessVersion}
                    onRestricted={handleRestricted}
                    fullAdmin={isFullAdmin}
                    className="mt-6"
                  />
                </EditorGroup>
              </div>
            </div>
          )}
        </AdminEditPageShell>

        <EditorSaveBar
          dirty={isDirty}
          saving={saving}
          onSave={() => void save()}
          onDiscard={editor.discard}
          errorCount={groups.totalErrors}
          invalidMessage={
            !formMode && !validationState.isValid
              ? t('admin.apps.edit.validationErrorsExist')
              : null
          }
          published={published}
          onShowFirstError={formMode && groups.firstErrorField ? showFirstError : null}
        />
      </div>

      {testOpen && app && (
        <AppTestPanel
          appId={appId}
          enabled={published}
          isDirty={isDirty}
          reloadKey={testRun}
          onClose={() => {
            setTestOpen(false);
            setTestFocus(0);
          }}
          noModel={noModel}
          modelSetupHref={isFullAdmin ? MODELS_PATH : null}
          onOpenAccess={() => openGroup('access')}
          focusToken={testFocus}
          focusChatOnOpen={!conversationView}
        />
      )}

      <EditorToast message={toast} />

      <PublishDialogs
        publishing={publishing}
        name={appName}
        access={access}
        savesFirst={isDirty}
        noModel={noModel}
      />

      <ChangeHistoryDrawer
        isOpen={historyOpen}
        onClose={() => setHistoryOpen(false)}
        resource="app"
        resourceId={appId}
        // A rollback rewrites the app file: the editor loads the restored app and its
        // revision, or its next save would be refused as a conflict.
        onRestored={() => {
          setHistoryOpen(false);
          clearConflict();
          editor.retryLoad();
        }}
      />
    </div>
  );
}

export default AdminAppEditPage;
