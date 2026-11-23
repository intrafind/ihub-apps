// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import i18nService from '../../../services/i18nService';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import { useAuth } from '../../../shared/contexts/AuthContext';
import { usePlatformConfig } from '../../../shared/contexts/PlatformConfigContext';
import useFeatureFlags from '../../../shared/hooks/useFeatureFlags';
import { apiErrorMessage } from '../../../utils/apiErrorMessage';
import AdminBreadcrumb from '../components/AdminBreadcrumb';
import { copyLabelWith, loadCopyLanguages } from '../components/app-create/copyLanguages';
import CreateHeader from '../components/app-create/CreateHeader';
import CreateNotices, { EssentialsNotice } from '../components/app-create/CreateNotices';
import DescribeSlot from '../components/app-create/DescribeSlot';
import EssentialsScreen from '../components/app-create/EssentialsScreen';
import StartScreen from '../components/app-create/StartScreen';
import {
  beginBlank,
  beginCopy,
  beginGenerated,
  beginLink,
  beginTemplate
} from '../components/app-create/createFlow';
import { FIELD_LABEL_KEYS, HEADING_KEYS } from '../components/app-create/createKeys';
import { useAppDraft } from '../components/app-create/useAppDraft';
import { useCopySource } from '../components/app-create/useCopySource';
import { useCreateResources } from '../components/app-create/useCreateResources';
import { useCreateSubmit } from '../components/app-create/useCreateSubmit';
import { useScreenTitle } from '../components/app-create/useScreenTitle';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { adminAppSource } from '../utils/adminAppSource';
import { appCategoryOptions, contentLanguage } from '../utils/appDraft';

/** Where the page lives and where it leads. Nothing below this file names a path. */
const ADMIN_PATH = '/admin';
const APPS_PATH = '/admin/apps';
const MODELS_PATH = '/admin/models';
const MARKETPLACE_PATH = '/admin/marketplace';

// Every request of the page and what the screens offer (section 11.3 of the personal apps plan).
const source = adminAppSource;
// The UI holds its own language; "(copy)" in another language of a name is loaded.
const loadLanguage = language => i18nService.loadFullTranslations(language);

/**
 * "New app": the one page every way of creating an app leads to (the list
 * button, the empty state, Cmd+K, the setup wizard, "Duplicate" with
 * `?from=<id>`). It has two screens, Start and Essentials, creates the app
 * with one request and opens it in the editor with the test chat running.
 *
 * This file is the frame: it loads what the screens need, switches the
 * screen, moves the focus and the document title with it, and asks before
 * typed input is lost. The screens and the logic live in
 * `components/app-create/`.
 *
 * @returns {JSX.Element}
 */
function AdminAppCreatePage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { platformConfig } = usePlatformConfig();
  const { user } = useAuth();
  const featureFlags = useFeatureFlags();

  const prepareCopy = useCallback(app => loadCopyLanguages(app, { i18n, loadLanguage }), [i18n]);
  const copy = useCopySource({ fetchApp: source.fetchApp, prepare: prepareCopy });
  const draft = useAppDraft({ restore: !copy.requested });
  const { state, begin, describe, deriveId, setExtras, back, reset, forget } = draft;
  const resources = useCreateResources({
    fetchModels: source.fetchModels,
    fetchApps: source.fetchApps,
    fetchUiConfig: source.fetchUiConfig
  });
  const { isTaken, nameExists, markTaken, appsReady } = resources;

  const platformLanguage = platformConfig?.defaultLanguage;
  const language = contentLanguage(i18n.language, platformLanguage);
  const isFullAdmin = Boolean(user?.isAdmin || user?.permissions?.adminAccess);

  const headingRef = useRef(null);
  const nameRef = useRef(null);
  // Set when the author's action changed the screen; a reload sets nothing.
  const [arrival, setArrival] = useState(null);
  // 'back' or 'startOver' while the page asks whether to discard the input.
  const [leaving, setLeaving] = useState(null);

  const { blocker, markSaved } = useUnsavedChanges(false, state.dirty);

  const onCreated = useCallback(
    id => {
      // The draft became an app: nothing of it is kept for the tab.
      forget();
      markSaved();
      navigate(`${APPS_PATH}/${encodeURIComponent(id)}?created=1`, { replace: true });
    },
    [forget, markSaved, navigate]
  );
  const labelOf = useCallback(field => t(FIELD_LABEL_KEYS[field]), [t]);
  const detailOf = useCallback(error => apiErrorMessage(error, t, ''), [t]);
  const form = useCreateSubmit({
    state,
    deriveId,
    isTaken,
    markTaken,
    createApp: source.createApp,
    onCreated,
    labelOf,
    detailOf
  });
  const { restart } = form;

  /** Shows a screen the author asked for, and lets the focus follow. */
  const arrive = useCallback(
    start => setArrival(current => ({ start, nonce: (current?.nonce ?? 0) + 1 })),
    []
  );

  // Opens Essentials with a start. A copy that was asked for ends here; it cannot arrive late.
  const { dismiss: dismissCopy } = copy;
  const open = useCallback(
    start => {
      restart();
      begin(start);
      arrive(start.start);
      dismissCopy();
    },
    [restart, begin, arrive, dismissCopy]
  );

  // "Duplicate", a cold load of `?from=<id>` and a pick from the list: the
  // copy opens once the source and the list of taken IDs are there.
  const copySource = copy.source;
  useEffect(() => {
    if (!copySource || !appsReady) return;
    open(
      beginCopy(copySource, {
        uiLanguage: i18n.language,
        platformDefault: platformLanguage,
        isTaken,
        copyLabel: copyLabelWith(t)
      })
    );
    // Once per loaded source: later changes of the helpers must not reopen the copy.
    // eslint-disable-next-line @eslint-react/exhaustive-deps
  }, [copySource, appsReady]);

  // The focus follows the screen: to the name of a template or a copy (with
  // the text selected, ready to be replaced), else to the heading.
  useEffect(() => {
    if (!arrival) return;
    const name = nameRef.current;
    if ((arrival.start === 'template' || arrival.start === 'copy') && name) {
      name.focus();
      name.select();
    } else {
      headingRef.current?.focus();
    }
  }, [arrival]);

  const heading =
    state.screen === 'essentials' ? t(HEADING_KEYS[state.start]) : t('admin.apps.create.title');
  useScreenTitle(heading);

  const leaveScreen = kind => {
    setLeaving(null);
    restart();
    if (kind === 'back') back();
    else reset();
    arrive(null);
  };
  /** Back and "Start over" ask once when the author typed or changed something. */
  const askBeforeLeaving = kind => (state.dirty ? setLeaving(kind) : leaveScreen(kind));
  const cancel = () => {
    // Nothing typed: nothing to ask, and nothing to bring back later.
    if (!state.dirty) forget();
    navigate(APPS_PATH);
  };
  const blocked = blocker.state === 'blocked';
  const startOver = () => askBeforeLeaving('startOver');
  const handleDraft = (result, description) =>
    open(beginGenerated(result, { description, language }));

  let screen;
  if (copy.status === 'loading') {
    screen = (
      <p role="status" className="text-sm text-gray-600 dark:text-gray-400">
        {t('admin.apps.loading')}
      </p>
    );
  } else if (state.screen === 'essentials') {
    screen = (
      <EssentialsScreen
        source={source}
        draft={draft}
        form={form}
        notice={
          <EssentialsNotice
            source={source}
            state={state}
            language={language}
            generate={source.generateDraft}
            onDescriptionChange={describe}
            onExtrasChange={setExtras}
            onDraft={handleDraft}
            creating={form.submitting}
            onStartOver={startOver}
          />
        }
        isTaken={isTaken}
        nameExists={nameExists}
        idsKnown={Array.isArray(resources.apps)}
        categories={appCategoryOptions(resources.uiConfig, state.draft?.category)}
        platformLanguage={platformLanguage}
        nameRef={nameRef}
        onCancel={cancel}
      />
    );
  } else {
    screen = (
      <StartScreen
        source={source}
        describe={
          <DescribeSlot
            source={source}
            enabled={featureFlags.isEnabled('appGenerator', true)}
            models={resources.models}
            configuredModelId={platformConfig?.appGenerator?.modelId || ''}
            modelSetupHref={isFullAdmin ? MODELS_PATH : null}
            language={language}
            description={state.description}
            onDescriptionChange={describe}
            onDraft={handleDraft}
            generate={source.generateDraft}
          />
        }
        fetchTemplates={source.fetchTemplates}
        fetchExistingApps={source.fetchExistingApps}
        language={language}
        onPickTemplate={template => open(beginTemplate(template, { language, isTaken }))}
        onStartBlank={() => open(beginBlank({ language }))}
        onPickExisting={copy.use}
        onStartLink={() => open(beginLink({ language }))}
        marketplaceHref={
          isFullAdmin && featureFlags.isEnabled('marketplace', true) ? MARKETPLACE_PATH : null
        }
      />
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <AdminBreadcrumb
        crumbs={[
          { label: t('documentTitle.admin'), href: ADMIN_PATH },
          { label: t('admin.apps.title'), href: APPS_PATH },
          { label: t('admin.apps.create.title') }
        ]}
      />
      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 shadow-xs sm:p-6">
        <CreateHeader
          heading={heading}
          screen={state.screen}
          headingRef={headingRef}
          onBack={
            state.screen === 'essentials' && copy.status !== 'loading'
              ? () => askBeforeLeaving('back')
              : undefined
          }
        />
        <CreateNotices state={state} copy={copy} onStartOver={startOver} />
        {screen}
      </div>

      <ConfirmDialog
        isOpen={blocked || leaving !== null}
        title={t('admin.apps.create.discard.title')}
        message={t('admin.apps.create.discard.body')}
        confirmLabel={t('admin.apps.create.discard.confirm')}
        denyLabel={t('admin.apps.create.discard.keep')}
        danger
        onConfirm={() => {
          if (!blocked) return leaveScreen(leaving);
          // The page is left for good: nothing of the draft is kept for the tab.
          forget();
          return blocker.proceed();
        }}
        onDeny={() => (blocked ? blocker.reset() : setLeaving(null))}
      />
    </div>
  );
}

export default AdminAppCreatePage;
