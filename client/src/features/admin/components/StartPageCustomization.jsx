import { useState, useEffect, useMemo } from 'react';
import { fetchAdminApps } from '../../../api';
import { getLocalizedContent } from '../../../utils/localizeContent';
import { useTranslation } from 'react-i18next';
import DynamicLanguageEditor from '../../../shared/components/DynamicLanguageEditor';

/**
 * Start page configuration (uiConfig.startPage): which view the "/" route
 * shows, whether the default app's chat input is on the start page, which app
 * that is, and the subtitle under the greeting.
 */
function StartPageCustomization({ config, pages, onUpdate, t }) {
  const { i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const [apps, setApps] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    // Admin endpoint: every configured app, not just the ones this admin may use.
    fetchAdminApps()
      .then(data => {
        const list = Array.isArray(data) ? data : Array.isArray(data?.apps) ? data.apps : [];
        if (mounted) setApps(list);
      })
      .catch(() => {})
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  // The start page needs a chat to send the message to — skip iframe/redirect
  // apps there. As the home view any app works, so that selector keeps them.
  const chatApps = useMemo(() => apps.filter(app => (app.type || 'chat') === 'chat'), [apps]);

  const pageOptions = useMemo(() => {
    const entries = Object.entries(pages || {}).map(([id, page]) => ({
      id,
      label: getLocalizedContent(page?.title, currentLanguage) || id
    }));
    return entries.sort((a, b) => a.label.localeCompare(b.label));
  }, [pages, currentLanguage]);

  const defaultAppId = config?.defaultAppId || '';
  const showDefaultApp = config?.showDefaultApp !== false;
  const defaultPage = config?.defaultPage || 'start';
  const defaultPageId = config?.defaultPageId || '';
  const defaultPageAppId = config?.defaultPageAppId || '';

  // A target that was never picked (or has since been deleted) would send users
  // nowhere, so "/" falls back to the start page — say so instead of failing silently.
  const targetMissing =
    (defaultPage === 'page' && !defaultPageId) || (defaultPage === 'app' && !defaultPageAppId);

  const selectClass =
    'block w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 dark:text-gray-100 px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed';
  const labelClass = 'block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1';
  const helpClass = 'mt-2 text-xs text-gray-500 dark:text-gray-400';

  const appOptionLabel = app =>
    `${getLocalizedContent(app.name, currentLanguage) || app.id}${
      app.enabled === false ? ' (disabled)' : ''
    }`;

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
        {/* Which view "/" shows */}
        <div>
          <label htmlFor="startPage-defaultPage" className={labelClass}>
            {t('admin.ui.startPage.defaultPage', 'Home page')}
          </label>
          <select
            id="startPage-defaultPage"
            value={defaultPage}
            onChange={e => onUpdate({ defaultPage: e.target.value })}
            className={selectClass}
          >
            <option value="start">
              {t('admin.ui.startPage.defaultPageStart', 'Start page (greeting and chat input)')}
            </option>
            <option value="apps">{t('admin.ui.startPage.defaultPageApps', 'All apps')}</option>
            <option value="page">{t('admin.ui.startPage.defaultPagePage', 'Content page')}</option>
            <option value="app">{t('admin.ui.startPage.defaultPageApp', 'A specific app')}</option>
          </select>
          <p className={helpClass}>
            {t(
              'admin.ui.startPage.defaultPageHelp',
              'Where "/" sends users — after signing in and whenever they click the logo. Each view keeps its own route, so the start page stays at /start and the apps browser at /apps whatever you pick here.'
            )}
          </p>
        </div>

        {/* Target for the "content page" choice */}
        {defaultPage === 'page' && (
          <div>
            <label htmlFor="startPage-defaultPageId" className={labelClass}>
              {t('admin.ui.startPage.defaultPageId', 'Content page')}
            </label>
            <select
              id="startPage-defaultPageId"
              value={defaultPageId}
              onChange={e => onUpdate({ defaultPageId: e.target.value || undefined })}
              className={selectClass}
            >
              <option value="">{t('admin.ui.startPage.selectPage', 'Select a page…')}</option>
              {pageOptions.map(page => (
                <option key={page.id} value={page.id}>
                  {page.label}
                </option>
              ))}
              {/* Keep a stored id visible even if the page no longer exists. */}
              {defaultPageId && !pageOptions.some(page => page.id === defaultPageId) && (
                <option value={defaultPageId}>
                  {defaultPageId} ({t('admin.ui.startPage.unknownPage', 'not found')})
                </option>
              )}
            </select>
            <p className={helpClass}>
              {t(
                'admin.ui.startPage.defaultPageIdHelp',
                'One of the pages from Admin → Pages. Users who may not open it see the usual access-denied screen, so pick a page everyone can read.'
              )}
            </p>
          </div>
        )}

        {/* Target for the "specific app" choice */}
        {defaultPage === 'app' && (
          <div>
            <label htmlFor="startPage-defaultPageAppId" className={labelClass}>
              {t('admin.ui.startPage.defaultPageAppId', 'App')}
            </label>
            <select
              id="startPage-defaultPageAppId"
              value={defaultPageAppId}
              disabled={loading}
              onChange={e => onUpdate({ defaultPageAppId: e.target.value || undefined })}
              className={selectClass}
            >
              <option value="">{t('admin.ui.startPage.selectApp', 'Select an app…')}</option>
              {apps.map(app => (
                <option key={app.id} value={app.id}>
                  {appOptionLabel(app)}
                </option>
              ))}
              {/* Keep a stored id visible even if the app no longer exists. */}
              {!loading && defaultPageAppId && !apps.some(app => app.id === defaultPageAppId) && (
                <option value={defaultPageAppId}>
                  {defaultPageAppId} ({t('admin.ui.startPage.unknownApp', 'not found')})
                </option>
              )}
            </select>
            <p className={helpClass}>
              {t(
                'admin.ui.startPage.defaultPageAppIdHelp',
                'Opens this app straight away. Users without access to it see the usual access-denied screen.'
              )}
            </p>
          </div>
        )}

        {targetMissing && (
          <p className="rounded-md bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
            {t(
              'admin.ui.startPage.targetMissing',
              'Nothing selected yet — "/" keeps opening the start page until you choose a target.'
            )}
          </p>
        )}

        <hr className="border-gray-200 dark:border-gray-700" />

        {defaultPage !== 'start' && (
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {t(
              'admin.ui.startPage.notHomeNotice',
              'The start page is not what "/" opens right now, but it stays reachable at /start — that is where the sidebar’s "New chat" button leads, so the settings below still apply.'
            )}
          </p>
        )}

        {/* Subtitle under the greeting */}
        <div>
          <DynamicLanguageEditor
            label={t('admin.ui.startPage.subtitle', 'Subtitle')}
            value={config?.subtitle || {}}
            onChange={value => onUpdate({ subtitle: value })}
            type="text"
            placeholder={{
              en: 'How can I help you today?',
              de: 'Wie kann ich Ihnen heute helfen?'
            }}
          />
          <p className={helpClass}>
            {t(
              'admin.ui.startPage.subtitleHelp',
              'Shown under the greeting. Leave empty to use the built-in text.'
            )}
          </p>
        </div>

        {/* Toggle: show the default chat app input at all */}
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <span
              id="startPage-showDefaultApp-label"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              {t('admin.ui.startPage.showDefaultApp', 'Show default chat app')}
            </span>
            <p
              id="startPage-showDefaultApp-help"
              className="mt-1 text-xs text-gray-500 dark:text-gray-400"
            >
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
            aria-labelledby="startPage-showDefaultApp-label"
            aria-describedby="startPage-showDefaultApp-help"
            onClick={() => onUpdate({ showDefaultApp: !showDefaultApp })}
            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-hidden focus:ring-2 focus:ring-indigo-600 focus:ring-offset-2 ${
              showDefaultApp ? 'bg-indigo-600' : 'bg-gray-200 dark:bg-gray-600'
            }`}
          >
            <span
              aria-hidden="true"
              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-sm ring-0 transition duration-200 ease-in-out ${
                showDefaultApp ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </button>
        </div>

        {/* Default app selector */}
        <div>
          <label htmlFor="startPage-defaultApp" className={labelClass}>
            {t('admin.ui.startPage.defaultApp', 'Default chat app')}
          </label>
          <select
            id="startPage-defaultApp"
            value={defaultAppId}
            disabled={loading || !showDefaultApp}
            onChange={e => onUpdate({ defaultAppId: e.target.value || undefined })}
            className={selectClass}
          >
            <option value="">
              {t('admin.ui.startPage.firstAvailable', 'First available app (automatic)')}
            </option>
            {chatApps.map(app => (
              <option key={app.id} value={app.id}>
                {appOptionLabel(app)}
              </option>
            ))}
            {/* Keep a stored id visible even if the app no longer exists. */}
            {!loading && defaultAppId && !chatApps.some(app => app.id === defaultAppId) && (
              <option value={defaultAppId}>
                {defaultAppId} ({t('admin.ui.startPage.unknownApp', 'not found')})
              </option>
            )}
          </select>
          <p className={helpClass}>
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
