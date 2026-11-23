// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import { usePlatformConfig } from '../../../shared/contexts/PlatformConfigContext';
import { invalidateAppsCache } from '../../../shared/hooks/appsCache';
import { invalidateUserAppsConfig } from '../../../shared/hooks/useUserApps';
import i18nService from '../../../services/i18nService';
import { apiErrorMessage } from '../../../utils/apiErrorMessage';
import { copyLabelWith, loadCopyLanguages } from '../../admin/components/app-create/copyLanguages';
import CreateHeader from '../../admin/components/app-create/CreateHeader';
import CreateNotices, { EssentialsNotice } from '../../admin/components/app-create/CreateNotices';
import DescribeSlot from '../../admin/components/app-create/DescribeSlot';
import EssentialsScreen from '../../admin/components/app-create/EssentialsScreen';
import StartScreen from '../../admin/components/app-create/StartScreen';
import {
  beginBlank,
  beginCopy,
  beginGenerated,
  beginTemplate
} from '../../admin/components/app-create/createFlow';
import { FIELD_LABEL_KEYS, HEADING_KEYS } from '../../admin/components/app-create/createKeys';
import { LINK_BUTTON_CLASS } from '../../admin/components/app-create/createStyles';
import { useAppDraft } from '../../admin/components/app-create/useAppDraft';
import { useCopySource } from '../../admin/components/app-create/useCopySource';
import { useCreateResources } from '../../admin/components/app-create/useCreateResources';
import { useCreateSubmit } from '../../admin/components/app-create/useCreateSubmit';
import { useScreenTitle } from '../../admin/components/app-create/useScreenTitle';
import { CALLOUT_CLASS } from '../../admin/components/formStyles';
import { useUnsavedChanges } from '../../admin/hooks/useUnsavedChanges';
import { contentLanguage } from '../../admin/utils/appDraft';
import { userAppSource } from '../builder/userAppSource';

/** Where the page lives and where it leads. Nothing below this file names a path. */
const APPS_PATH = '/apps';
const editPath = id => `${APPS_PATH}/${encodeURIComponent(id)}/edit?created=1`;

/** The tab keeps the draft of a personal app apart from a draft of the admin page. */
export const USER_APP_DRAFT_STORAGE_KEY = 'ihub.userAppCreate.draft';

/**
 * A personal app gets its ID from the server. The create screens check an app
 * ID before they send anything, so the draft they check carries this one,
 * which is always valid; it never leaves the browser.
 */
const UNSENT_APP_ID = 'personal-app';

// A personal app has no ID to keep free, no name to compare and no category.
const noApps = async () => [];
const noUiConfig = async () => null;
const neverTaken = () => false;
const nothing = () => {};
// The UI holds its own language; "(copy)" in another language of a name is loaded.
const loadLanguage = language => i18nService.loadFullTranslations(language);

/**
 * "New app" for a person's own app (`/apps/new`): the two screens of the admin
 * page, Start and Essentials, with the personal source. It offers the
 * description box, the templates, "Copy an existing app" (an app the person
 * has access to, also as `?from=<id>`) and "Start empty"; it has no link or
 * Marketplace start, no app ID and no category. The app is created with one
 * request and opened in its editor.
 *
 * The page asks `GET /api/apps/_config` first. Someone who may not create an
 * app is sent to the apps page; someone at their limit reads so and sends
 * nothing.
 *
 * @param {object} [props]
 * @param {object} [props.source] - The calls and choices of the page; the personal source.
 * @returns {JSX.Element}
 */
function UserAppCreatePage({ source = userAppSource }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { platformConfig } = usePlatformConfig();

  const platformLanguage = platformConfig?.defaultLanguage;
  const language = contentLanguage(i18n.language, platformLanguage);

  // `undefined` while loading, `null` when the answer did not arrive: the page
  // then works without it, and the server stays the authority.
  const [config, setConfig] = useState(undefined);
  const { fetchConfig } = source;
  useEffect(() => {
    let current = true;
    Promise.resolve()
      .then(() => fetchConfig({ language }))
      .then(value => current && setConfig(value && typeof value === 'object' ? value : null))
      .catch(() => current && setConfig(null));
    return () => {
      current = false;
    };
    // Once per visit: a language change must not take the screen away.
    // eslint-disable-next-line @eslint-react/exhaustive-deps
  }, [fetchConfig]);

  const prepareCopy = useCallback(app => loadCopyLanguages(app, { i18n, loadLanguage }), [i18n]);
  const copy = useCopySource({ fetchApp: source.fetchApp, prepare: prepareCopy });
  const draft = useAppDraft({ storageKey: USER_APP_DRAFT_STORAGE_KEY, restore: !copy.requested });
  const { state, begin, describe, deriveId, setExtras, back, reset, forget } = draft;
  const resources = useCreateResources({
    fetchModels: source.fetchModels,
    fetchApps: noApps,
    fetchUiConfig: noUiConfig
  });

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
      // The new app belongs in the apps list and the sidebar, and counts against the limit.
      invalidateAppsCache();
      invalidateUserAppsConfig();
      navigate(editPath(id), { replace: true });
    },
    [forget, markSaved, navigate]
  );
  const labelOf = useCallback(field => t(FIELD_LABEL_KEYS[field]), [t]);
  const detailOf = useCallback(error => apiErrorMessage(error, t, ''), [t]);

  const allowed = config?.capabilities ?? null;
  const { createApp: sendApp } = source;
  const createApp = useCallback(
    (payload, { origin } = {}) =>
      sendApp(payload, { origin, language: state.language || language, allowed }),
    [sendApp, state.language, language, allowed]
  );
  // The screens check an app ID; a personal app has none to check.
  const checked = useMemo(
    () =>
      state.draft
        ? { ...state, idTouched: false, draft: { ...state.draft, id: UNSENT_APP_ID } }
        : state,
    [state]
  );
  const form = useCreateSubmit({
    state: checked,
    deriveId,
    isTaken: neverTaken,
    createApp,
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

  // A cold load of `?from=<id>` and a pick from the list: the copy opens once
  // the source is there. The source holds only what a personal app may hold
  // (`userAppCopy.js`). A personal app cannot be saved without instructions,
  // so a source without them does not make them optional, as it does for an
  // admin copy.
  const copySource = copy.source;
  useEffect(() => {
    if (!copySource) return;
    const start = beginCopy(copySource, {
      uiLanguage: i18n.language,
      platformDefault: platformLanguage,
      isTaken: neverTaken,
      copyLabel: copyLabelWith(t)
    });
    open({ ...start, source: { ...start.source, noInstructions: false } });
    // Once per loaded source: later changes of the helpers must not reopen the copy.
    // eslint-disable-next-line @eslint-react/exhaustive-deps
  }, [copySource]);

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

  if (config && (config.enabled === false || config.canCreate === false)) {
    return <Navigate to={APPS_PATH} replace />;
  }

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

  const maxApps = Number(config?.maxApps) || 0;
  const atLimit = maxApps > 0 && Number(config?.used) >= maxApps;

  let screen;
  if (config === undefined || copy.status === 'loading') {
    screen = (
      <p role="status" className="text-sm text-gray-600 dark:text-gray-400">
        {t('admin.apps.loading')}
      </p>
    );
  } else if (atLimit) {
    screen = (
      <div className="space-y-4">
        <p role="alert" className={CALLOUT_CLASS.warning}>
          {t('userApps.list.limitReached', { max: maxApps })}
        </p>
        <Link to={APPS_PATH} className={LINK_BUTTON_CLASS}>
          {t('admin.apps.create.back')}
        </Link>
      </div>
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
        isTaken={neverTaken}
        nameExists={neverTaken}
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
          source.starts.describe && (
            <DescribeSlot
              source={source}
              // The server's answer where there is one; else nothing is known, and the request answers.
              enabled={config ? config.generator === true : true}
              models={resources.models}
              language={language}
              description={state.description}
              onDescriptionChange={describe}
              onDraft={handleDraft}
              generate={source.generateDraft}
            />
          )
        }
        fetchTemplates={source.fetchTemplates}
        fetchExistingApps={source.fetchExistingApps}
        language={language}
        onPickTemplate={template => open(beginTemplate(template, { language }))}
        onStartBlank={() => open(beginBlank({ language }))}
        onPickExisting={copy.use}
        onStartLink={nothing}
      />
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 shadow-xs sm:p-6">
        <CreateHeader
          heading={heading}
          screen={state.screen}
          headingRef={headingRef}
          onBack={
            state.screen === 'essentials' && !atLimit && copy.status !== 'loading'
              ? () => askBeforeLeaving('back')
              : undefined
          }
        />
        {!atLimit && (
          <CreateNotices source={source} state={state} copy={copy} onStartOver={startOver} />
        )}
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

export default UserAppCreatePage;
