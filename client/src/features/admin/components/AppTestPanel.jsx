// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { buildPath } from '../../../utils/runtimeBasePath';
import { fetchAppDetails } from '../../../api';
import AppChat from '../../apps/pages/AppChat';
import useOverlayPanel from '../../../shared/hooks/useOverlayPanel';
import NoModelNotice from './app-create/NoModelNotice';
import TestNoAccessMessage from './app-editor/TestNoAccessMessage';
import { UI_CREATES_PUBLISHED } from '../../../../../shared/appDefaults.js';

export function PanelMessage({ icon, children }) {
  return (
    <div className="flex-1 flex items-center justify-center p-8 text-center">
      <div className="max-w-sm">
        <Icon name={icon} className="h-8 w-8 mx-auto text-gray-500" />
        <p className="mt-3 text-sm text-gray-600 dark:text-gray-300">{children}</p>
      </div>
    </div>
  );
}

/**
 * The app a project test runs: the app as saved, but with the model picker
 * on whatever the app says (the point is to compare models) and the chat
 * incognito, so the scratch chat is never listed in the admin's history. The
 * incognito toggle is taken away: switching it off would keep the chat.
 *
 * @param {Object} app - The saved app.
 * @returns {Object} A copy for the embedded chat.
 */
export function projectTestApp(app) {
  return {
    ...app,
    ephemeral: true,
    disallowModelSelection: false,
    settings: {
      ...app.settings,
      model: { ...app.settings?.model, enabled: true },
      ephemeral: { ...app.settings?.ephemeral, enabled: false }
    }
  };
}

/**
 * One run of the test: loads the saved app the way the chat page does and
 * renders the real chat for it. Keyed by the reload counter, so every reload
 * refetches the app and starts a new chat. Also the chat of the integration
 * test panel (`integrations/IntegrationTestPanel.jsx`) and of the project
 * test panel (`ProjectTestPanel.jsx`).
 *
 * @param {Object} props
 * @param {string} props.appId - The saved app to run
 * @param {string} [props.testProjectId] - An admin project to test: it is the only
 *   one in scope and the chat is temporary (#3309)
 * @param {(error: unknown) => React.ReactNode} [props.renderLoadError] - What to show
 *   when the app could not be loaded, for a caller that knows more about the cause
 *   than "could not be loaded"; return nothing to keep that message
 */
export function TestChat({ appId, testProjectId = null, renderLoadError }) {
  const { t } = useTranslation();
  const [state, setState] = useState({ status: 'loading', app: null, error: null });

  useEffect(() => {
    let cancelled = false;
    fetchAppDetails(appId).then(
      app => !cancelled && setState({ status: 'ready', app, error: null }),
      error => !cancelled && setState({ status: 'error', app: null, error })
    );
    return () => {
      cancelled = true;
    };
  }, [appId]);

  if (state.status === 'loading') {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600 mx-auto" />
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
            {t('admin.apps.test.loading', 'Loading app...')}
          </p>
        </div>
      </div>
    );
  }

  if (state.status === 'error') {
    const explained = renderLoadError?.(state.error);
    if (explained) return explained;
    return (
      <PanelMessage icon="exclamation-triangle">
        {t('admin.apps.test.loadError', 'The app could not be loaded for the test.')}
      </PanelMessage>
    );
  }

  // Iframe and redirect apps have no chat; their page is the external site.
  if ((state.app.type || 'chat') !== 'chat') {
    return (
      <PanelMessage icon="information-circle">
        {t(
          'admin.apps.test.chatOnly',
          'Testing here works for chat apps. Use Open app to try this app.'
        )}
      </PanelMessage>
    );
  }

  // `data-surface="app"`: the end-user chat keeps its end-user look inside the admin (App.css
  // scopes the admin's form-control styles out of this subtree).
  return (
    <div data-surface="app" className="flex flex-col flex-1 min-h-0">
      <AppChat
        embedded
        appId={appId}
        preloadedApp={testProjectId ? projectTestApp(state.app) : state.app}
        testProjectId={testProjectId}
      />
    </div>
  );
}

/** The server's answer for an app the caller cannot get: unknown, or not for their groups. */
const isNotFound = error => (error?.status ?? error?.response?.status) === 404;

/**
 * Test mode of the app editor (issue #2510): the app's real chat, rendered
 * next to the editor so what the admin tests is what end users get.
 *
 * It runs the saved configuration. The chat resolves the app from the
 * server's config cache, so unsaved editor state can't reach it; the panel
 * says so while there are unsaved changes, and the editor restarts it after
 * every save through `reloadKey`. Each start is a new chat from the app's
 * defaults (see AppChat's `embedded`).
 *
 * An app that is not published runs here too: the server hands it to the
 * people who manage apps, and the panel says that nobody else sees it. When
 * the author's groups do not grant the app, its load answers 404 and the panel
 * says what to do. Without a model it says that instead of showing a chat
 * that cannot answer.
 *
 * Beside the editor on wide screens, full screen on narrow ones. Full screen it
 * covers the editor, so it is a dialog there (see `useOverlayPanel`): focus
 * moves in and stays in, Escape closes it, and focus goes back to the button.
 *
 * @param {Object} props
 * @param {string} props.appId - Saved app id
 * @param {boolean} props.enabled - Whether the saved app is published
 * @param {boolean} props.isDirty - The editor has changes the test doesn't run yet
 * @param {number} props.reloadKey - Changes whenever the app was saved
 * @param {Function} props.onClose - Close the panel
 * @param {boolean} [props.runsUnpublished] - Whether an app that is not published runs
 *   here; where new apps start published (`UI_CREATES_PUBLISHED`), the panel only says
 *   that it is not.
 * @param {boolean} [props.noModel=false] - No AI model is available to the author
 * @param {string|null} [props.modelSetupHref] - Where a model is set up, for someone
 *   who may open that page
 * @param {() => void} [props.onOpenAccess] - Opens "Who can use this app" in the editor
 * @param {number} [props.focusToken=0] - A new number above 0 moves the focus to the
 *   panel: the author followed a link to the test. Its button leaves the focus alone.
 */
function AppTestPanel({
  appId,
  enabled,
  isDirty,
  reloadKey,
  onClose,
  runsUnpublished = !UI_CREATES_PUBLISHED,
  noModel = false,
  modelSetupHref = null,
  onOpenAccess,
  focusToken = 0
}) {
  const { t } = useTranslation();
  const [restarts, setRestarts] = useState(0);
  const { panelRef, closeRef, overlay, dialogProps } = useOverlayPanel({ onClose });

  useEffect(() => {
    if (focusToken > 0) panelRef.current?.focus();
  }, [focusToken, panelRef]);
  const title = t('admin.apps.test.title', 'Test app');
  const runs = enabled || runsUnpublished;

  const iconButton =
    'p-1.5 rounded-md text-gray-500 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-700 focus:outline-hidden focus:ring-2 focus:ring-indigo-500';

  // Covering the editor, the panel has to go before the editor can show the group.
  const openAccess = onOpenAccess
    ? () => {
        if (overlay) onClose();
        onOpenAccess();
      }
    : undefined;

  const explainLoadError = error =>
    !enabled && isNotFound(error) ? <TestNoAccessMessage onOpenAccess={openAccess} /> : null;

  let body;
  if (!runs) {
    body = <PanelMessage icon="eye-slash">{t('admin.apps.test.disabled')}</PanelMessage>;
  } else if (noModel) {
    body = (
      <div className="flex-1 overflow-y-auto p-4">
        <NoModelNotice setupHref={modelSetupHref} />
      </div>
    );
  } else {
    body = (
      <TestChat key={`${reloadKey}-${restarts}`} appId={appId} renderLoadError={explainLoadError} />
    );
  }

  return (
    <aside
      ref={panelRef}
      aria-label={title}
      tabIndex={-1}
      {...dialogProps}
      className="fixed inset-0 z-40 flex flex-col bg-white dark:bg-gray-900 focus:outline-hidden lg:static lg:z-auto lg:h-full lg:w-[45%] lg:min-w-[26rem] lg:max-w-3xl lg:shrink-0 lg:border-l lg:border-gray-200 lg:dark:border-gray-700"
    >
      <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-200 dark:border-gray-700 shrink-0">
        <Icon name="beaker" className="h-5 w-5 text-indigo-600 dark:text-indigo-400 shrink-0" />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">
            {title}
          </h2>
          <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
            {t('admin.apps.test.subtitle', 'Runs the saved version, as users see it')}
          </p>
        </div>
        {runs && (
          <>
            <button
              type="button"
              onClick={() => setRestarts(n => n + 1)}
              className={iconButton}
              title={t('admin.apps.test.restart', 'Restart with a new chat')}
              aria-label={t('admin.apps.test.restart', 'Restart with a new chat')}
            >
              <Icon name="refresh" className="h-4 w-4" />
            </button>
            <a
              href={buildPath(`/apps/${encodeURIComponent(appId)}`)}
              target="_blank"
              rel="noopener noreferrer"
              className={iconButton}
              title={t('admin.apps.openAppHint', 'Open the app in a new tab')}
              aria-label={t('admin.apps.openApp', 'Open app')}
            >
              <Icon name="external-link" className="h-4 w-4" />
            </a>
          </>
        )}
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          className={iconButton}
          title={t('admin.apps.test.close', 'Close test panel')}
          aria-label={t('admin.apps.test.close', 'Close test panel')}
        >
          <Icon name="x-mark" className="h-4 w-4" />
        </button>
      </div>

      {runs && !enabled && (
        <p
          data-testid="test-not-published"
          className="flex items-start gap-2 px-4 py-2 text-xs bg-gray-50 dark:bg-gray-800 text-gray-700 dark:text-gray-300 border-b border-gray-200 dark:border-gray-700 shrink-0"
        >
          <Icon name="eye-slash" className="h-4 w-4 shrink-0 mt-px" />
          <span>{t('admin.apps.edit.notPublishedHint')}</span>
        </p>
      )}

      {isDirty && runs && (
        <div
          role="status"
          className="flex items-start gap-2 px-4 py-2 text-xs bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-200 border-b border-amber-200 dark:border-amber-800 shrink-0"
        >
          <Icon name="information-circle" className="h-4 w-4 shrink-0 mt-px" />
          <span>
            {t(
              'admin.apps.test.unsavedHint',
              'You have unsaved changes. Save to test them — the test restarts after every save.'
            )}
          </span>
        </div>
      )}

      {body}
    </aside>
  );
}

export default AppTestPanel;
