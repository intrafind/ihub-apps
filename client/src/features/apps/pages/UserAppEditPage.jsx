// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  acceptUserAppOffer,
  clearUserAppOffer,
  deleteUserApp,
  duplicateUserApp,
  fetchModels,
  fetchUserApp,
  fetchUserAppShareTargets,
  offerUserApp,
  updateUserApp
} from '../../../api';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import TransferOwnerDialog from '../../../shared/components/TransferOwnerDialog';
import { invalidateAppsCache } from '../../../shared/hooks/appsCache';
import { invalidateUserAppsConfig, useUserAppsConfig } from '../../../shared/hooks/useUserApps';
import NotFound from '../../../pages/error/NotFound';
import { getLocalizedContent } from '../../../utils/localizeContent';
import AdminSaveBar from '../../admin/components/AdminSaveBar';
import AppTestPanel from '../../admin/components/AppTestPanel';
import UnsavedChangesDialog from '../../admin/components/UnsavedChangesDialog';
import EditorToast, {
  EditorSaveError,
  useEditorToast
} from '../../admin/components/app-editor/EditorMessages';
import { useCreatedArrival } from '../../admin/components/app-editor/useCreatedArrival';
import { useScreenTitle } from '../../admin/components/app-create/useScreenTitle';
import ConversationPanel from '../../admin/components/app-conversation/ConversationPanel';
import EditorViewSwitch from '../../admin/components/app-conversation/EditorViewSwitch';
import {
  draftOf,
  unsavedOutsideContent
} from '../../admin/components/app-conversation/conversationState';
import { personalStakes } from '../../admin/components/app-conversation/stakes';
import {
  CONVERSATION_VIEW,
  VIEW_PARAM,
  useAppBuilderFeatures
} from '../../admin/components/app-conversation/useAppBuilderChat';
import ImproveInstructionsDialog from '../../admin/components/app-form/ImproveInstructionsDialog';
import useMediaQuery from '../../../shared/hooks/useMediaQuery';
import { userAppSource } from '../builder/userAppSource';
import {
  AppFormLanguageProvider,
  AppFormTranslateProvider
} from '../../admin/components/app-form/AppLanguageField';
import StarterPromptsSection from '../../admin/components/app-form/StarterPromptsSection';
import SystemInstructionsSection from '../../admin/components/app-form/SystemInstructionsSection';
import VariablesSection from '../../admin/components/app-form/VariablesSection';
import { CALLOUT_CLASS, SECONDARY_BUTTON_CLASS } from '../../admin/components/formStyles';
import { useUnsavedChanges } from '../../admin/hooks/useUnsavedChanges';
import { isUserAppId, pickUserAppContent } from '../../../../../shared/userAppContent.js';
import UserAppBasicsSection from '../components/user-app/UserAppBasicsSection';
import PublishDialog from '../components/user-app/PublishDialog';
import UserAppEditorGroup from '../components/user-app/UserAppEditorGroup';
import UserAppEditorHeader from '../components/user-app/UserAppEditorHeader';
import UserAppExtrasSection from '../components/user-app/UserAppExtrasSection';
import UserAppNextSteps from '../components/user-app/UserAppNextSteps';
import UserAppOfferBanner from '../components/user-app/UserAppOfferBanner';
import UserAppShareDialog from '../components/user-app/UserAppShareDialog';
import UserAppStatusBanner from '../components/user-app/UserAppStatusBanner';
import {
  userAppErrorCode,
  userAppErrorMessage,
  userAppErrorStatus
} from '../components/user-app/userAppErrors';
import {
  formFromApp,
  offersAiChanges,
  patchFor,
  readOnlyReason,
  userAppStateChip,
  withheldCapabilities,
  withoutCapability
} from '../components/user-app/userAppForm';

/** Where the page lives and where it leads. Nothing below this file names a path. */
const APPS_PATH = '/apps';
const chatPath = id => `${APPS_PATH}/${encodeURIComponent(id)}`;
const editPath = id => `${chatPath(id)}/edit`;

/** The query parameter with which the apps page asks for a dialog (`?dialog=share`). */
const DIALOG_PARAM = 'dialog';

/**
 * The dialog behind the "Publish" entry of the editor menu (slice P12). The
 * entry appears when the server says `permissions.canPublish`. Setting this
 * to `null` takes publishing out of the page.
 */
const PUBLISH_DIALOG = PublishDialog;

/** The texts the sections of the admin form edit; everything else of their output is dropped. */
const SECTION_KEYS = ['system', 'prompt', 'messagePlaceholder', 'variables', 'starterPrompts'];
const SECTION_EMPTY = {
  system: {},
  prompt: {},
  messagePlaceholder: {},
  variables: [],
  starterPrompts: []
};

const NOTHING_LOADED = Object.freeze({ appId: null, status: 'loading', app: null, error: null });
/** From here up the test panel sits beside the editor; below it is a full-screen dialog. */
const WIDE_QUERY = '(min-width: 1024px)';
const GROUPS_OPEN = Object.freeze({ basics: true, instructions: true, extras: true });

/**
 * The editor of a personal app (`/apps/:appId/edit`): three groups, the test
 * chat beside them, and what concerns the whole app (share, hand over,
 * duplicate, delete). An app is created on `/apps/new` and arrives here with
 * `?created=1`.
 *
 * The server decides what the caller may do and sends it with the app
 * (`permissions`); the page offers exactly that. A person who may read the
 * app and not change it (a member with "Can use", the receiver of an offer,
 * an editor of an app that is read-only) sees the form disabled, with the
 * reason above it where there is one.
 *
 * The page calls the user routes only (`/api/apps…`), never an admin route.
 *
 * Design: concepts/app-builder-rework-2026-11/02-personal-apps.md, 11.4, 11.5, 11.7.
 *
 * @returns {JSX.Element}
 */
function UserAppEditPage() {
  const { t, i18n } = useTranslation();
  const { appId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const uiLanguage = String(i18n.language || '').split('-')[0] || 'en';
  const { config } = useUserAppsConfig();
  const features = useAppBuilderFeatures();
  const wide = useMediaQuery(WIDE_QUERY);
  const [improveOpen, setImproveOpen] = useState(false);

  const [loaded, setLoaded] = useState(NOTHING_LOADED);
  const current = loaded.appId === appId ? loaded : NOTHING_LOADED;
  const { app, status } = current;
  // The stored content as a form state, and the form as edited.
  const [forms, setForms] = useState({ saved: null, form: null });
  const [models, setModels] = useState([]);
  const [groups, setGroups] = useState(GROUPS_OPEN);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [conflict, setConflict] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const [testFocus, setTestFocus] = useState(0);
  const [testRun, setTestRun] = useState(0);
  // 'share' | 'handOver' | 'delete' | 'publish' | null
  const [dialog, setDialog] = useState(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [offerNotice, setOfferNotice] = useState(null);
  const [shareRefused, setShareRefused] = useState(false);
  const [toast, showToast] = useEditorToast();
  const headingRef = useRef(null);
  const inputsRef = useRef(null);
  const generationRef = useRef(0);

  const { isDirty, blocker, markSaved } = useUnsavedChanges(
    status === 'ready' ? forms.saved : null,
    forms.form
  );

  /**
   * Takes a new answer of the server. Unsaved input stays when `keepInput` is
   * true, or when the form is no longer `sentForm` (typed while a save ran).
   */
  const adopt = useCallback(
    (next, { keepInput = false, sentForm } = {}) => {
      // The reduced body (switched off, shares suspended) has no content to edit.
      const full = isPlainName(next?.system);
      const saved = full ? formFromApp(next) : null;
      setLoaded({ appId, status: 'ready', app: next, error: null });
      setForms(held => ({
        saved,
        form:
          (keepInput || (sentForm && held.form !== sentForm)) && held.form && saved
            ? held.form
            : saved
      }));
    },
    [appId]
  );

  const load = useCallback(async () => {
    const generation = ++generationRef.current;
    try {
      const next = await fetchUserApp(appId);
      if (generation !== generationRef.current) return next;
      adopt(next);
      setConflict(false);
      setSaveError(null);
      return next;
    } catch (error) {
      if (generation !== generationRef.current) return null;
      const missing = userAppErrorStatus(error) === 404;
      setLoaded({
        appId,
        status: missing ? 'missing' : 'error',
        app: null,
        error: missing ? null : userAppErrorMessage(error, t)
      });
      setForms({ saved: null, form: null });
      return null;
    }
    // `t` only words an error; a language change must not reload the app.
    // eslint-disable-next-line @eslint-react/exhaustive-deps
  }, [appId, adopt]);

  useEffect(() => {
    // An ID of another shape is a company app or nothing: no request for it.
    if (isUserAppId(appId)) void load();
    return () => {
      generationRef.current += 1;
    };
  }, [appId, load]);

  const allowed = config?.capabilities ?? null;
  const modelChoice = allowed?.modelChoice === true;
  useEffect(() => {
    if (!modelChoice) return undefined;
    let active = true;
    fetchModels()
      .then(list => active && setModels(Array.isArray(list) ? list : []))
      .catch(() => active && setModels([]));
    return () => {
      active = false;
    };
  }, [modelChoice]);

  const permissions = app?.permissions || {};
  const form = forms.form;
  const contentLanguage =
    app?.language || Object.keys(isPlainName(app?.name) ? app.name : {})[0] || uiLanguage;
  const name =
    getLocalizedContent(form?.name ?? app?.name, uiLanguage) ||
    getLocalizedContent(form?.name ?? app?.name, contentLanguage) ||
    appId;
  useScreenTitle(status === 'ready' ? name : '');
  // The name as stored: what "Publish" and "Duplicate" take.
  const storedName =
    getLocalizedContent(app?.name, uiLanguage) ||
    getLocalizedContent(app?.name, contentLanguage) ||
    appId;

  const readOnly = useMemo(() => (app ? readOnlyReason(app) : null), [app]);
  const withheld = useMemo(() => (app ? withheldCapabilities(app) : []), [app]);
  // The receiver of an offer, whatever else the app is to them: a person it is already shared
  // with keeps the role of that share until they accept.
  const offered = permissions.canAcceptOffer === true;
  const offerOpen = Boolean(app?.pendingOwner);

  /**
   * The name of a capability. `form: 'noun'` is the form that stands inside a
   * sentence ("This app uses the chosen AI model"); the default opens one
   * ("The chosen AI model is no longer available").
   */
  const capabilityName = useCallback(
    (capability, { form: wording = 'title' } = {}) => {
      if (capability.kind === 'integration') {
        const system = (allowed?.integrations || []).find(
          entry => entry.id === capability.installationId
        );
        return (
          system?.label ||
          getLocalizedContent(capability.name, uiLanguage) ||
          capability.installationId
        );
      }
      return wording === 'noun'
        ? t(`userApps.edit.capabilityNoun.${capability.kind}`)
        : t(`userApps.edit.capability.${capability.kind}`);
    },
    [allowed, t, uiLanguage]
  );
  const capabilityNoun = useCallback(
    capability => capabilityName(capability, { form: 'noun' }),
    [capabilityName]
  );

  // Arriving from "Create and test": the test chat opens and a toast says that the app exists.
  const arrival = useCreatedArrival({
    appId,
    ready: status === 'ready' && Boolean(form),
    onArrive: ({ conversation: toConversation } = {}) => {
      // Into the conversation on a small screen, the test would cover it: it stays a button away.
      if (!toConversation || wide) setTestOpen(true);
      showToast(t('userApps.create.created', { name }));
    }
  });

  // The apps page asks for the share dialog with `?dialog=share`.
  const wantedDialog = new URLSearchParams(location.search).get(DIALOG_PARAM);
  useEffect(() => {
    if (status !== 'ready' || !wantedDialog) return;
    if (wantedDialog === 'share') {
      // The URL is outside React: this is the one place it turns into state.
      /* eslint-disable @eslint-react/set-state-in-effect */
      if (permissions.canShare === true) setDialog('share');
      else setShareRefused(true);
      /* eslint-enable @eslint-react/set-state-in-effect */
    }
    const params = new URLSearchParams(location.search);
    params.delete(DIALOG_PARAM);
    const search = params.toString();
    navigate({ search: search ? `?${search}` : '', hash: location.hash }, { replace: true });
    // Once per arrival, with what is current then.
    // eslint-disable-next-line @eslint-react/exhaustive-deps
  }, [status, wantedDialog]);

  const setForm = useCallback(
    next =>
      setForms(held => ({
        ...held,
        form: typeof next === 'function' ? next(held.form) : next
      })),
    []
  );
  /** The sections of the admin form hand back an app; only their texts and lists are taken. */
  const applySections = useCallback(
    next => {
      const picked = pickUserAppContent(next);
      setForm(held => {
        const merged = { ...held };
        for (const key of SECTION_KEYS) merged[key] = picked[key] ?? SECTION_EMPTY[key];
        return merged;
      });
    },
    [setForm]
  );

  const save = async () => {
    if (!app || !form || saving) return;
    const patch = patchFor(forms.saved, form);
    if (!patch) {
      // Only something a personal app cannot store was touched.
      setForm(forms.saved);
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const next = await updateUserApp(appId, patch, { revision: app.revision });
      // Input typed while the save ran stays in the form, as unsaved changes.
      adopt(next, { sentForm: form });
      invalidateAppsCache();
      setConflict(false);
      setTestRun(run => run + 1);
      showToast(t('admin.apps.edit.saved'));
    } catch (error) {
      // The author's input stays in the form either way.
      if (userAppErrorCode(error) === 'ETAG_MISMATCH') setConflict(true);
      else setSaveError(userAppErrorMessage(error, t));
    } finally {
      setSaving(false);
    }
  };

  /**
   * The conversation's Apply and Undo: puts `next` into the form and saves it
   * with the page's own save (`PATCH /api/apps/{appId}` with `If-Match`). On a
   * conflict (409 `ETAG_MISMATCH`) or any other refusal nothing is written,
   * and the form shows what it held before.
   *
   * @param {object} next - The form with the change merged over it.
   * @returns {Promise<{status: 'saved'|'conflict'|'failed', value?: object, message?: string|null}>}
   *   `value` is the form as the server stored it.
   */
  const persistFromConversation = async next => {
    if (!app || !form || saving) return { status: 'failed', message: null };
    const before = form;
    const patch = patchFor(forms.saved, next);
    if (!patch) {
      // Nothing a personal app stores differs from what is saved.
      setForm(next);
      return { status: 'saved', value: next };
    }
    setForm(next);
    setSaving(true);
    setSaveError(null);
    try {
      const stored = await updateUserApp(appId, patch, { revision: app.revision });
      adopt(stored, { sentForm: next });
      invalidateAppsCache();
      setConflict(false);
      setTestRun(run => run + 1);
      if (!wide) showToast(t('admin.apps.conversation.toast'));
      return { status: 'saved', value: formFromApp(stored) };
    } catch (error) {
      setForm(held => (held === next ? before : held));
      if (userAppErrorCode(error) === 'ETAG_MISMATCH') {
        setConflict(true);
        return { status: 'conflict' };
      }
      return { status: 'failed', message: userAppErrorMessage(error, t) };
    } finally {
      setSaving(false);
    }
  };

  // The conversation and "Improve with AI" need drafts for personal apps and an author who may
  // edit this app; create rights are not needed (owner decision of 2026-11-23).
  const aiOffered = offersAiChanges(config, app);
  // Every turn names the app: the server answers an editor without create rights by it.
  const refine = useCallback(request => userAppSource.refineDraft({ ...request, appId }), [appId]);
  // The conversation (`?view=conversation`) also needs the preview feature.
  const conversationOffered = features.chat && aiOffered && status === 'ready' && Boolean(form);
  const conversationView =
    conversationOffered &&
    new URLSearchParams(location.search).get(VIEW_PARAM) === CONVERSATION_VIEW;
  const setView = next => {
    const params = new URLSearchParams(location.search);
    if (next === CONVERSATION_VIEW) params.set(VIEW_PARAM, CONVERSATION_VIEW);
    else params.delete(VIEW_PARAM);
    const search = params.toString();
    navigate({ search: search ? `?${search}` : '', hash: location.hash }, { replace: true });
  };
  const testable = permissions.canUse === true;
  useEffect(() => {
    // The view comes from the URL: this is the one place it opens the test beside it.
    // eslint-disable-next-line @eslint-react/set-state-in-effect
    if (conversationView && wide && testable) setTestOpen(true);
  }, [conversationView, wide, testable]);

  const stakes = useMemo(() => {
    const labels = new Map(
      (allowed?.integrations || []).map(system => [system.id, system.label || system.id])
    );
    return personalStakes({
      sharedWith: app?.sharedWith,
      integrationNames: (forms.saved?.capabilities?.integrations || []).map(
        binding => labels.get(binding.id) || binding.id
      )
    });
  }, [allowed, app?.sharedWith, forms.saved]);

  /** Runs an action of the page that is not the save, with one error line for all of them. */
  const run = async action => {
    setBusy(true);
    setActionError(null);
    try {
      await action();
    } catch (error) {
      setActionError(userAppErrorMessage(error, t));
    } finally {
      setBusy(false);
    }
  };

  const duplicate = () =>
    run(async () => {
      const copy = await duplicateUserApp(appId);
      invalidateAppsCache();
      invalidateUserAppsConfig();
      navigate(editPath(copy.id));
    });
  const remove = () =>
    run(async () => {
      await deleteUserApp(appId);
      invalidateAppsCache();
      invalidateUserAppsConfig();
      markSaved();
      setDialog(null);
      navigate(APPS_PATH);
    });
  const withdraw = () =>
    run(async () => {
      await clearUserAppOffer(appId);
      invalidateAppsCache();
      adopt(await fetchUserApp(appId), { keepInput: true });
    });
  const decline = () =>
    run(async () => {
      await clearUserAppOffer(appId);
      invalidateAppsCache();
      navigate(APPS_PATH);
    });
  const accept = async () => {
    setBusy(true);
    setActionError(null);
    setOfferNotice(null);
    try {
      adopt(await acceptUserAppOffer(appId, { revision: app.revision }));
      invalidateAppsCache();
      invalidateUserAppsConfig();
      headingRef.current?.focus();
    } catch (error) {
      if (userAppErrorCode(error) === 'ETAG_MISMATCH') {
        // An editor changed the app after the receiver read it: read it again.
        await load();
        setOfferNotice(t('userApps.transfer.changed'));
      } else {
        setActionError(userAppErrorMessage(error, t));
      }
    } finally {
      setBusy(false);
    }
  };

  /**
   * A dialog was refused because someone changed the app (409
   * `ETAG_MISMATCH`): read the app again so the next attempt carries the
   * current revision. Unsaved input stays.
   */
  const refreshAfterConflict = async () => {
    try {
      adopt(await fetchUserApp(appId), { keepInput: true });
    } catch {
      // The page keeps what it has; the save bar's "Reload" is still there.
      setConflict(true);
    }
  };

  const showTest = () => {
    setTestOpen(true);
    setTestFocus(token => token + 1);
  };
  const showInputs = () => {
    setGroups(held => ({ ...held, instructions: true }));
    inputsRef.current?.focus();
  };
  const toggleGroup = id => setGroups(held => ({ ...held, [id]: !held[id] }));

  if (!isUserAppId(appId) || status === 'missing') return <NotFound />;
  if (status === 'loading') {
    return (
      <p role="status" className="p-8 text-center text-sm text-gray-600 dark:text-gray-400">
        {t('admin.apps.loading')}
      </p>
    );
  }
  if (status === 'error') {
    return (
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-4">
        <p role="alert" className={CALLOUT_CLASS.danger}>
          {current.error}
        </p>
        <button type="button" onClick={() => void load()} className={SECONDARY_BUTTON_CLASS}>
          {t('common.retry')}
        </button>
      </div>
    );
  }
  // Retired for this person: the chat route shows where the company app is.
  if (app.state === 'retired' || app.ownership !== 'user') {
    return app.ownership === 'user' ? <Navigate to={chatPath(appId)} replace /> : <NotFound />;
  }

  const canUse = permissions.canUse === true;
  const formDisabled = Boolean(readOnly);
  const lifecycleOpen = app.state === 'active' && !app.disabled;
  const publishOffered = Boolean(PUBLISH_DIALOG) && permissions.canPublish === true;
  const labels = {
    title: t('userApps.transfer.action'),
    hint: t('userApps.transfer.pickHint'),
    search: t('userApps.transfer.search'),
    submit: t('userApps.transfer.next'),
    submitTo: () => t('userApps.transfer.next'),
    confirmTitle: owner => t('userApps.transfer.title', { name, owner: owner.name }),
    lines: owner => [
      t('userApps.transfer.line1', { owner: owner.name }),
      t('userApps.transfer.line2', { owner: owner.name }),
      t('userApps.transfer.line3', { owner: owner.name })
    ],
    confirm: owner => t('userApps.transfer.submit', { owner: owner.name })
  };

  return (
    // With the test panel open the page splits: editor left, app right (full screen below lg).
    <div className={testOpen ? 'lg:flex lg:h-full' : undefined}>
      <div
        className={testOpen ? 'lg:flex-1 lg:min-w-0 lg:overflow-y-auto' : undefined}
        // The cards of the form sections are one column on this page.
        data-form-narrow=""
      >
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <nav aria-label={t('userApps.edit.breadcrumb')} className="mb-4 text-sm">
            <Link
              to={APPS_PATH}
              className="rounded-sm text-admin-accent dark:text-admin-accent-fg-dark underline hover:no-underline"
            >
              {t('header.apps')}
            </Link>
            <span aria-hidden="true" className="mx-2 text-gray-500">
              ›
            </span>
            <span aria-current="page" className="text-gray-700 dark:text-gray-300">
              {name}
            </span>
          </nav>

          <UserAppEditorHeader
            name={name}
            icon={form?.icon || app.icon}
            color={form?.color || app.color}
            chip={userAppStateChip(app)}
            testOpen={testOpen}
            onToggleTest={canUse ? () => setTestOpen(open => !open) : undefined}
            onShare={permissions.canShare === true ? () => setDialog('share') : undefined}
            onOpenApp={canUse ? () => navigate(chatPath(appId)) : undefined}
            onPublish={publishOffered ? () => setDialog('publish') : undefined}
            onHandOver={
              permissions.canOffer === true && lifecycleOpen
                ? () => setDialog('handOver')
                : undefined
            }
            onWithdraw={permissions.canOffer === true && offerOpen ? withdraw : undefined}
            onDuplicate={canUse && config?.canCreate === true ? duplicate : undefined}
            onDelete={permissions.canDelete === true ? () => setDialog('delete') : undefined}
            unsaved={isDirty}
            headingRef={headingRef}
          />
          {conversationOffered && (
            <div className="mt-4 flex justify-end">
              <EditorViewSwitch
                view={conversationView ? CONVERSATION_VIEW : 'form'}
                onChange={setView}
              />
            </div>
          )}

          <EditorSaveError message={saveError || actionError} />
          {shareRefused && (
            <p role="status" className={`mt-6 ${CALLOUT_CLASS.info}`}>
              {t('userApps.share.notAllowed')}
            </p>
          )}

          <UserAppStatusBanner app={app} readOnly={readOnly} capabilityName={capabilityNoun} />

          {offered && (
            <UserAppOfferBanner
              app={app}
              onTry={showTest}
              onDecline={decline}
              onAccept={accept}
              busy={busy}
              notice={offerNotice}
            />
          )}

          {arrival.stepsShown && !formDisabled && !conversationView && (
            <UserAppNextSteps
              onTest={showTest}
              onInputFields={showInputs}
              onShare={permissions.canShare === true ? () => setDialog('share') : undefined}
              onDismiss={() => {
                // The card goes, and with it the button that has the focus.
                headingRef.current?.focus();
                arrival.dismissSteps();
              }}
              focusHeading={arrival.focusSteps}
            />
          )}

          {form && conversationView && (
            // The conversation edits the same form; "Form" above is one click away.
            <div className="mt-6 space-y-4">
              {/* Apply put the form back after a conflict, so the save bar is gone: Reload is here. */}
              {conflict && !isDirty && (
                <div role="alert" className={CALLOUT_CLASS.warning}>
                  <p>{t('userApps.edit.conflict')}</p>
                  <button
                    type="button"
                    onClick={() => void load()}
                    className={`mt-2 ${SECONDARY_BUTTON_CLASS}`}
                  >
                    {t('userApps.edit.reload')}
                  </button>
                </div>
              )}
              <ConversationPanel
                appId={appId}
                target="personal"
                form={form}
                language={contentLanguage}
                refine={refine}
                persist={persistFromConversation}
                stakes={stakes}
                testOpen={testOpen && wide}
                // Apply and Undo save the whole form: the model and capabilities go with them.
                // A personal app's Save has no client-side check; the server checks both.
                savesOtherChanges={unsavedOutsideContent(form, forms.saved, 'personal')}
              />
            </div>
          )}

          {form && !conversationView && (
            <AppFormLanguageProvider value={contentLanguage}>
              {/* The machine translation is an admin route. */}
              <AppFormTranslateProvider value={false}>
                <UserAppEditorGroup
                  title={t('admin.apps.edit.groups.basics')}
                  open={groups.basics}
                  onToggle={() => toggleGroup('basics')}
                  disabled={formDisabled}
                >
                  <UserAppBasicsSection form={form} onChange={setForm} />
                </UserAppEditorGroup>

                <UserAppEditorGroup
                  title={t('admin.apps.edit.groups.instructions')}
                  open={groups.instructions}
                  onToggle={() => toggleGroup('instructions')}
                  buttonRef={inputsRef}
                  disabled={formDisabled}
                >
                  <SystemInstructionsSection
                    app={form}
                    onChange={applySections}
                    t={t}
                    // Every member can read the instructions (design 6.4).
                    description={t('userApps.edit.instructionsDesc')}
                    readOnly={formDisabled}
                    // "Improve with AI" over `POST /api/apps/_revise`, with drafts for personal apps.
                    onImprove={aiOffered ? () => setImproveOpen(true) : undefined}
                  />
                  <VariablesSection app={form} onChange={applySections} showStartOptions={false} />
                  <StarterPromptsSection app={form} onChange={applySections} showAutoSend={false} />
                </UserAppEditorGroup>

                <UserAppEditorGroup
                  title={t('userApps.edit.extras.title')}
                  open={groups.extras}
                  onToggle={() => toggleGroup('extras')}
                  disabled={formDisabled}
                >
                  <UserAppExtrasSection
                    form={form}
                    onChange={setForm}
                    allowed={allowed}
                    models={models}
                    withheld={withheld}
                    capabilityName={capabilityName}
                    onRemove={capability => setForm(held => withoutCapability(held, capability))}
                    language={uiLanguage}
                  />
                </UserAppEditorGroup>
              </AppFormTranslateProvider>
            </AppFormLanguageProvider>
          )}
        </div>

        {!formDisabled && (
          <AdminSaveBar
            dirty={isDirty}
            saving={saving}
            onSave={() => void save()}
            onDiscard={() => {
              setForm(forms.saved);
              setSaveError(null);
            }}
            message={conflict ? t('userApps.edit.conflict') : null}
            action={
              conflict
                ? { label: t('userApps.edit.reload'), onClick: () => void load() }
                : undefined
            }
          />
        )}
      </div>

      {testOpen && canUse && (
        <AppTestPanel
          appId={appId}
          enabled
          isDirty={isDirty}
          reloadKey={testRun}
          onClose={() => setTestOpen(false)}
          focusToken={testFocus}
        />
      )}

      <EditorToast message={toast} />
      <UnsavedChangesDialog blocker={blocker} />
      {form && (
        <ImproveInstructionsDialog
          isOpen={improveOpen}
          onClose={() => setImproveOpen(false)}
          refine={refine}
          draft={draftOf(form, 'personal')}
          language={contentLanguage}
          // Into the form only: Save keeps it, Discard takes it back.
          onUse={system => setForm(held => ({ ...held, system }))}
        />
      )}

      {dialog === 'share' && (
        <UserAppShareDialog
          app={app}
          name={name}
          onClose={() => setDialog(null)}
          onSaved={next => {
            setDialog(null);
            invalidateAppsCache();
            adopt(next, { keepInput: true });
          }}
          onConflict={() => void refreshAfterConflict()}
        />
      )}
      {dialog === 'handOver' && (
        <TransferOwnerDialog
          item={app}
          fetchTargets={query => fetchUserAppShareTargets({ q: query, purpose: 'offer' })}
          transfer={(item, owner) => offerUserApp(item.id, owner.id)}
          errorMessage={userAppErrorMessage}
          labels={labels}
          danger={false}
          onClose={() => setDialog(null)}
          onTransferred={next => {
            setDialog(null);
            invalidateAppsCache();
            adopt(next, { keepInput: true });
          }}
        />
      )}
      {dialog === 'publish' && PUBLISH_DIALOG && (
        <PUBLISH_DIALOG
          app={app}
          // What is published is the stored app, so the dialog names the stored name.
          name={storedName}
          onClose={() => setDialog(null)}
          onPublished={next => {
            setDialog(null);
            // The list of apps changed: the company app is new in it.
            invalidateAppsCache();
            // The menu offers "Publish" only for a saved form; nothing is left to lose.
            markSaved();
            // Visible at once and usable by the owner: the answer is the
            // pointer to the company app, and so is the chat route.
            if (next?.state === 'retired' && next?.publishedAs?.appId) {
              navigate(chatPath(appId));
              return;
            }
            adopt(next);
          }}
          onChanged={() => {
            setDialog(null);
            setActionError(t('userApps.publish.changed'));
            void refreshAfterConflict();
          }}
        />
      )}
      <ConfirmDialog
        isOpen={dialog === 'delete'}
        title={t('userApps.edit.delete.title', { name })}
        message={t('userApps.edit.delete.body')}
        confirmLabel={t('userApps.list.menu.delete')}
        danger
        busy={busy}
        error={dialog === 'delete' ? actionError : null}
        onConfirm={remove}
        onDeny={() => setDialog(null)}
      />
    </div>
  );
}

/** Whether a name is the localized object the server sends. */
function isPlainName(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export default UserAppEditPage;
