import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { buildPath } from '../../../utils/runtimeBasePath';
import { appChatPath } from '../../../utils/appPreviewMode';

/**
 * One load of the app page. Keyed by the reload counter, so every reload
 * starts over with a fresh document and its own loading state.
 */
function PreviewFrame({ appId, title }) {
  const { t } = useTranslation();
  const [loaded, setLoaded] = useState(false);

  return (
    <div className="relative flex-1 min-h-0">
      {!loaded && (
        <div className="absolute inset-0 flex items-center justify-center bg-white dark:bg-gray-900">
          <div className="text-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600 mx-auto" />
            <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
              {t('admin.apps.test.loading', 'Loading app...')}
            </p>
          </div>
        </div>
      )}
      <iframe
        src={buildPath(appChatPath(appId, { preview: true }))}
        title={title}
        // Voice input and copy buttons, as on the app page itself.
        allow="microphone; clipboard-write"
        onLoad={() => setLoaded(true)}
        className="h-full w-full border-0 bg-white dark:bg-gray-900"
      />
    </div>
  );
}

/**
 * Test mode of the app editor (issue #2510): the real chat page of the app,
 * in an iframe, so what the admin tests is exactly what end users get.
 *
 * It runs the saved configuration. The chat always resolves the app from the
 * server's config cache, so unsaved editor state can't reach it; the panel
 * says so while there are unsaved changes, and the editor reloads it after
 * every save through `reloadKey`.
 *
 * Beside the editor on wide screens, full screen on narrow ones.
 *
 * @param {Object} props
 * @param {string} props.appId - Saved app id
 * @param {string} props.appName - Display name, for the frame title
 * @param {boolean} props.enabled - Whether the saved app is enabled; disabled apps aren't served
 * @param {boolean} props.isDirty - The editor has changes the preview doesn't run yet
 * @param {number} props.reloadKey - Changes whenever the app was saved
 * @param {Function} props.onClose - Close the panel
 */
function AppTestPanel({ appId, appName, enabled, isDirty, reloadKey, onClose }) {
  const { t } = useTranslation();
  const [manualReloads, setManualReloads] = useState(0);
  const title = t('admin.apps.test.title', 'Test app');

  const iconButton =
    'p-1.5 rounded-md text-gray-500 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-700 focus:outline-hidden focus:ring-2 focus:ring-indigo-500';

  return (
    <aside
      aria-label={title}
      className="fixed inset-0 z-40 flex flex-col bg-white dark:bg-gray-900 lg:static lg:z-auto lg:h-full lg:w-[45%] lg:min-w-[24rem] lg:max-w-3xl lg:shrink-0 lg:border-l lg:border-gray-200 lg:dark:border-gray-700"
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
              onClick={() => setManualReloads(n => n + 1)}
              className={iconButton}
              title={t('admin.apps.test.reload', 'Reload')}
              aria-label={t('admin.apps.test.reload', 'Reload')}
            >
              <Icon name="refresh" className="h-4 w-4" />
            </button>
            <a
              href={buildPath(appChatPath(appId))}
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
              'You have unsaved changes. Save to test them — the test reloads after every save.'
            )}
          </span>
        </div>
      )}

      {enabled ? (
        <PreviewFrame
          key={`${reloadKey}-${manualReloads}`}
          appId={appId}
          title={t('admin.apps.test.frameTitle', 'Test of {{name}}', { name: appName || appId })}
        />
      ) : (
        <div className="flex-1 flex items-center justify-center p-8 text-center">
          <div className="max-w-sm">
            <Icon name="eye-slash" className="h-8 w-8 mx-auto text-gray-400" />
            <p className="mt-3 text-sm text-gray-600 dark:text-gray-300">
              {t(
                'admin.apps.test.disabled',
                'This app is disabled, so it cannot be opened in the chat. Enable it and save to test it.'
              )}
            </p>
          </div>
        </div>
      )}
    </aside>
  );
}

export default AppTestPanel;
