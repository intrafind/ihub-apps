import { useState, useEffect } from 'react';
import { fetchApps } from '../../../api/api';
import { getLocalizedContent } from '../../../utils/localizeContent';
import { useTranslation } from 'react-i18next';

/**
 * Start page configuration. Currently lets an admin pick the default app used
 * for the start page's chat input (uiConfig.startPage.defaultAppId).
 */
function StartPageCustomization({ config, onUpdate, t }) {
  const { i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const [apps, setApps] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    fetchApps()
      .then(data => {
        if (mounted && Array.isArray(data)) setApps(data);
      })
      .catch(() => {})
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  const defaultAppId = config?.defaultAppId || '';
  const showDefaultApp = config?.showDefaultApp !== false;

  return (
    <div className="p-6">
      <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-1">
        {t('admin.ui.startPage.title', 'Start Page Configuration')}
      </h3>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
        {t(
          'admin.ui.startPage.description',
          'Configure the personalized start page shown to users.'
        )}
      </p>

      <div className="max-w-lg space-y-6">
        {/* Toggle: show the default chat app input at all */}
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <span className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              {t('admin.ui.startPage.showDefaultApp', 'Show default chat app')}
            </span>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {t(
                'admin.ui.startPage.showDefaultAppHelp',
                'When off, the start page shows the greeting and apps but no chat input.'
              )}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={showDefaultApp}
            onClick={() => onUpdate({ showDefaultApp: !showDefaultApp })}
            className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-indigo-600 focus:ring-offset-2 ${
              showDefaultApp ? 'bg-indigo-600' : 'bg-gray-200 dark:bg-gray-600'
            }`}
          >
            <span
              aria-hidden="true"
              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                showDefaultApp ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </button>
        </div>

        {/* Default app selector */}
        <div>
          <label
            htmlFor="startPage-defaultApp"
            className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
          >
            {t('admin.ui.startPage.defaultApp', 'Default chat app')}
          </label>
          <select
            id="startPage-defaultApp"
            value={defaultAppId}
            disabled={loading || !showDefaultApp}
            onChange={e => onUpdate({ defaultAppId: e.target.value || undefined })}
            className="block w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 dark:text-gray-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <option value="">
              {t('admin.ui.startPage.firstAvailable', 'First available app (automatic)')}
            </option>
            {apps.map(app => (
              <option key={app.id} value={app.id}>
                {getLocalizedContent(app.name, currentLanguage) || app.id}
              </option>
            ))}
          </select>
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            {t(
              'admin.ui.startPage.defaultAppHelp',
              'The app whose chat input is shown on the start page. When unset, the first app the user can access is used.'
            )}
          </p>
        </div>
      </div>
    </div>
  );
}

export default StartPageCustomization;
