import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { buildPath } from '../../../utils/runtimeBasePath';
import { fetchAppDetails } from '../../../api';
import AppChat from '../../apps/pages/AppChat';

function PanelMessage({ icon, children }) {
  return (
    <div className="flex-1 flex items-center justify-center p-8 text-center">
      <div className="max-w-sm">
        <Icon name={icon} className="h-8 w-8 mx-auto text-gray-400" />
        <p className="mt-3 text-sm text-gray-600 dark:text-gray-300">{children}</p>
      </div>
    </div>
  );
}

/**
 * One run of the test: loads the saved app the way the chat page does and
 * renders the real chat for it. Keyed by the reload counter, so every reload
 * refetches the app and starts a new chat.
 */
function TestChat({ appId }) {
  const { t } = useTranslation();
  const [state, setState] = useState({ status: 'loading', app: null });

  useEffect(() => {
    let cancelled = false;
    fetchAppDetails(appId).then(
      app => !cancelled && setState({ status: 'ready', app }),
      () => !cancelled && setState({ status: 'error', app: null })
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

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <AppChat embedded appId={appId} preloadedApp={state.app} />
    </div>
  );
}

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
 * Beside the editor on wide screens, full screen on narrow ones.
 *
 * @param {Object} props
 * @param {string} props.appId - Saved app id
 * @param {boolean} props.enabled - Whether the saved app is enabled; disabled apps aren't served
 * @param {boolean} props.isDirty - The editor has changes the test doesn't run yet
 * @param {number} props.reloadKey - Changes whenever the app was saved
 * @param {Function} props.onClose - Close the panel
 */
function AppTestPanel({ appId, enabled, isDirty, reloadKey, onClose }) {
  const { t } = useTranslation();
  const [restarts, setRestarts] = useState(0);
  const title = t('admin.apps.test.title', 'Test app');

  const iconButton =
    'p-1.5 rounded-md text-gray-500 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-700 focus:outline-hidden focus:ring-2 focus:ring-indigo-500';

  return (
    <aside
      aria-label={title}
      className="fixed inset-0 z-40 flex flex-col bg-white dark:bg-gray-900 lg:static lg:z-auto lg:h-full lg:w-[45%] lg:min-w-[26rem] lg:max-w-3xl lg:shrink-0 lg:border-l lg:border-gray-200 lg:dark:border-gray-700"
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
        {enabled && (
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
          type="button"
          onClick={onClose}
          className={iconButton}
          title={t('admin.apps.test.close', 'Close test panel')}
          aria-label={t('admin.apps.test.close', 'Close test panel')}
        >
          <Icon name="x-mark" className="h-4 w-4" />
        </button>
      </div>

      {isDirty && enabled && (
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

      {enabled ? (
        <TestChat key={`${reloadKey}-${restarts}`} appId={appId} />
      ) : (
        <PanelMessage icon="eye-slash">
          {t(
            'admin.apps.test.disabled',
            'This app is disabled, so it cannot be opened in the chat. Enable it and save to test it.'
          )}
        </PanelMessage>
      )}
    </aside>
  );
}

export default AppTestPanel;
