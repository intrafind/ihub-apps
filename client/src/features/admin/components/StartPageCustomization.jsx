import { useState, useEffect, useMemo } from 'react';
import { fetchAdminApps } from '../../../api';
import { getLocalizedContent } from '../../../utils/localizeContent';
import { useTranslation } from 'react-i18next';
import DynamicLanguageEditor from '../../../shared/components/DynamicLanguageEditor';
import Icon from '../../../shared/components/Icon';
import ReorderableList from './ReorderableList';
import {
  APP_SHORTCUT_MODES,
  DEFAULT_APP_SHORTCUT_MODE,
  DEFAULT_SIDEBAR_APPS_COUNT,
  DEFAULT_START_PAGE_APPS_COUNT,
  MAX_APP_SHORTCUTS
} from '../../../utils/appShortcuts';

/**
 * Start page configuration (uiConfig.startPage): which view the "/" route
 * shows, whether the default app's chat input is on the start page, which app
 * that is, the subtitle under the greeting, and the app shortcuts the start
 * page and the sidebar show (which apps, how they rank, how many).
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

  // ---- App shortcuts: the short app lists on /start and in the sidebar ----
  const appsMode = APP_SHORTCUT_MODES.includes(config?.appsMode)
    ? config.appsMode
    : DEFAULT_APP_SHORTCUT_MODE;
  const featuredAppIds = Array.isArray(config?.featuredAppIds) ? config.featuredAppIds : [];

  // An unset count means "use the built-in default", so show that number
  // rather than an empty box the admin has to guess at.
  const countValue = (value, fallback) =>
    value === undefined || value === null || value === '' ? fallback : value;

  const handleCountChange = (field, raw) => {
    if (raw === '') {
      // Clearing the box goes back to the built-in default.
      onUpdate({ [field]: undefined });
      return;
    }
    const parsed = Number.parseInt(raw, 10);
    if (Number.isNaN(parsed)) return;
    onUpdate({ [field]: Math.min(Math.max(parsed, 0), MAX_APP_SHORTCUTS) });
  };

  // Keep ids that no longer resolve to an app in the list so they stay
  // removable instead of silently occupying a slot.
  const featuredItems = featuredAppIds.map(id => ({
    id,
    app: apps.find(app => app.id === id) || null
  }));
  const addableApps = apps.filter(app => !featuredAppIds.includes(app.id));

  const addFeaturedApp = id => {
    if (!id || featuredAppIds.includes(id)) return;
    onUpdate({ featuredAppIds: [...featuredAppIds, id] });
  };
  const removeFeaturedApp = id => {
    onUpdate({ featuredAppIds: featuredAppIds.filter(entry => entry !== id) });
  };
  const featuredLabel = item =>
    item.app ? getLocalizedContent(item.app.name, currentLanguage) || item.id : item.id;

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

        <hr className="border-gray-200 dark:border-gray-700" />

        {/* App shortcuts — shared by the start page grid and the sidebar */}
        <div>
          <h4 className="text-base font-medium text-gray-900 dark:text-gray-100">
            {t('admin.ui.startPage.shortcuts', 'App shortcuts')}
          </h4>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {t(
              'admin.ui.startPage.shortcutsHelp',
              'The short app lists on the start page and in the sidebar. A user’s favorites always come first, then the default apps below, then everything else in the order you pick.'
            )}
          </p>
        </div>

        {/* How the apps that are not favorites or default apps rank */}
        <div>
          <label htmlFor="startPage-appsMode" className={labelClass}>
            {t('admin.ui.startPage.appsMode', 'Order of the remaining apps')}
          </label>
          <select
            id="startPage-appsMode"
            value={appsMode}
            onChange={e => onUpdate({ appsMode: e.target.value })}
            className={selectClass}
          >
            <option value="order">
              {t('admin.ui.startPage.appsModeOrder', 'Configured order (the app’s order field)')}
            </option>
            <option value="recent">
              {t('admin.ui.startPage.appsModeRecent', 'Recently used first')}
            </option>
          </select>
          <p className={helpClass}>
            {t(
              'admin.ui.startPage.appsModeHelp',
              'Applies to both lists. "Recently used" ranks the apps each user opened most recently, the same way the apps browser does; the default apps below still lead the list.'
            )}
          </p>
        </div>

        {/* Separate counts: the grid and the sidebar have very different room */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="startPage-appsCount" className={labelClass}>
              {t('admin.ui.startPage.appsCount', 'Apps on the start page')}
            </label>
            <input
              id="startPage-appsCount"
              type="number"
              min="0"
              max={MAX_APP_SHORTCUTS}
              value={countValue(config?.appsCount, DEFAULT_START_PAGE_APPS_COUNT)}
              onChange={e => handleCountChange('appsCount', e.target.value)}
              className={selectClass}
            />
          </div>
          <div>
            <label htmlFor="startPage-sidebarAppsCount" className={labelClass}>
              {t('admin.ui.startPage.sidebarAppsCount', 'Apps in the sidebar')}
            </label>
            <input
              id="startPage-sidebarAppsCount"
              type="number"
              min="0"
              max={MAX_APP_SHORTCUTS}
              value={countValue(config?.sidebarAppsCount, DEFAULT_SIDEBAR_APPS_COUNT)}
              onChange={e => handleCountChange('sidebarAppsCount', e.target.value)}
              className={selectClass}
            />
          </div>
        </div>
        <p className="-mt-4 text-xs text-gray-500 dark:text-gray-400">
          {t(
            'admin.ui.startPage.appsCountHelp',
            'Between 0 and {{max}} each. Set 0 to hide a list.',
            {
              max: MAX_APP_SHORTCUTS
            }
          )}
        </p>

        {/* The curated default apps, in the order they should appear */}
        <div>
          <span className={labelClass}>{t('admin.ui.startPage.featuredApps', 'Default apps')}</span>
          {featuredItems.length === 0 ? (
            <p className="rounded-md border border-dashed border-gray-300 dark:border-gray-600 px-3 py-4 text-xs text-gray-500 dark:text-gray-400">
              {t(
                'admin.ui.startPage.featuredAppsEmpty',
                'No default apps yet — both lists follow the order above.'
              )}
            </p>
          ) : (
            <ReorderableList
              items={featuredItems}
              onReorder={items => onUpdate({ featuredAppIds: items.map(item => item.id) })}
              getKey={item => item.id}
              getLabel={featuredLabel}
              renderItem={(item, index) => (
                <span className="flex min-w-0 items-center gap-2">
                  <span className="w-5 shrink-0 text-xs font-semibold text-gray-400 dark:text-gray-500">
                    {index + 1}.
                  </span>
                  {item.app && (
                    <span
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-white"
                      style={{ backgroundColor: item.app.color || '#4f46e5' }}
                    >
                      <Icon name={item.app.icon} size="sm" className="h-3.5 w-3.5" />
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate text-sm text-gray-900 dark:text-gray-100">
                    {featuredLabel(item)}
                    {!item.app && !loading && (
                      <span className="ml-1 text-xs text-amber-600 dark:text-amber-400">
                        ({t('admin.ui.startPage.unknownApp', 'not found')})
                      </span>
                    )}
                    {item.app?.enabled === false && (
                      <span className="ml-1 text-xs text-gray-500 dark:text-gray-400">
                        ({t('admin.apps.status.disabled', 'Disabled')})
                      </span>
                    )}
                  </span>
                </span>
              )}
              renderActions={item => (
                <button
                  type="button"
                  onClick={() => removeFeaturedApp(item.id)}
                  aria-label={t('admin.ui.startPage.removeFeaturedApp', 'Remove {{name}}', {
                    name: featuredLabel(item)
                  })}
                  title={t('admin.ui.startPage.removeFeaturedApp', 'Remove {{name}}', {
                    name: featuredLabel(item)
                  })}
                  className="rounded-md p-1 text-gray-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/30"
                >
                  <Icon name="trash" size="sm" />
                </button>
              )}
            />
          )}
          <select
            id="startPage-addFeaturedApp"
            value=""
            disabled={loading || addableApps.length === 0}
            onChange={e => addFeaturedApp(e.target.value)}
            aria-label={t('admin.ui.startPage.addFeaturedApp', 'Add a default app')}
            className={`${selectClass} mt-2`}
          >
            <option value="">{t('admin.ui.startPage.addFeaturedApp', 'Add a default app')}</option>
            {addableApps.map(app => (
              <option key={app.id} value={app.id}>
                {appOptionLabel(app)}
              </option>
            ))}
          </select>
          <p className={helpClass}>
            {t(
              'admin.ui.startPage.featuredAppsHelp',
              'Shown in this order, right after each user’s favorites. Users who cannot access an app never see it. Drag a row or use the arrows to reorder.'
            )}
          </p>
        </div>
      </div>
    </div>
  );
}

export default StartPageCustomization;
