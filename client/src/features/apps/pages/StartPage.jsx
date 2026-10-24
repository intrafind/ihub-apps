// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../../shared/contexts/AuthContext';
import { useUIConfig } from '../../../shared/contexts/UIConfigContext';
import Icon from '../../../shared/components/Icon';
import useApps from '../../../shared/hooks/useApps';
import useChats, { useChatPersistence } from '../../../shared/hooks/useChats';
import useFavorites from '../../../shared/hooks/useFavorites';
import IHubLogo from '../../../shared/components/IHubLogo';
import { getLocalizedContent } from '../../../utils/localizeContent';
import { rankAppShortcuts, readAppShortcutConfig } from '../../../utils/appShortcuts';
import { getRecentAppIds } from '../../../utils/recentApps';
import { pickDefaultChatApp } from '../../../utils/homePage';
import { useTranslation } from 'react-i18next';
import LoadingSpinner from '../../../shared/components/LoadingSpinner';
import { buildAssetUrl } from '../../../utils/runtimeBasePath';
import AppChatStarter from '../../chat/components/AppChatStarter';
import { buildStartPageGreeting } from '../../../utils/startPageGreeting';

export default function StartPage() {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const { user } = useAuth();
  const { uiConfig, resetHeaderColor } = useUIConfig();
  const navigate = useNavigate();

  const { apps, loading: appsLoading, error: appsError } = useApps();
  // Durable chats — inert (no request, empty list) when the capability is off
  // or the viewer cannot own chats.
  const chatsEnabled = useChatPersistence();
  const { chats } = useChats();
  const { favorites: favoriteAppIds } = useFavorites('ihub_favorite_apps');

  // Leaving an app for "/" must not keep that app's colour on the classic header.
  useEffect(() => {
    resetHeaderColor();
  }, [resetHeaderColor]);

  // Admins can hide the start-page chat input entirely.
  const showDefaultApp = uiConfig?.startPage?.showDefaultApp !== false;

  // Time-based greeting with the viewer's name, unless the admin turned the
  // name off or configured a heading of their own (startPage.title).
  const greeting = useMemo(
    () =>
      buildStartPageGreeting({
        startPage: uiConfig?.startPage,
        user,
        language: currentLanguage,
        t
      }),
    [uiConfig?.startPage, user, currentLanguage, t]
  );

  const subtitle =
    getLocalizedContent(uiConfig?.startPage?.subtitle, currentLanguage) ||
    t('startPage.subtitle', 'How can I help you today?');

  // How many apps the grid shows, which ones lead it and how the rest rank —
  // all admin-configured under UI Customization → Start Page.
  const { mode, featuredAppIds, startPageCount } = useMemo(
    () => readAppShortcutConfig(uiConfig),
    [uiConfig]
  );

  // Read once per visit: re-reading on every render would reshuffle the grid
  // under the user's cursor. Only the `recent` mode needs the list at all.
  const recentAppIds = useMemo(() => (mode === 'recent' ? getRecentAppIds() : []), [mode]);

  // Favorites first, then the admin's default apps, then the rest by mode.
  const rankedApps = useMemo(
    () =>
      rankAppShortcuts(apps, {
        favoriteAppIds,
        featuredAppIds,
        mode,
        recentAppIds,
        currentLanguage
      }),
    [apps, favoriteAppIds, featuredAppIds, mode, recentAppIds, currentLanguage]
  );

  // Default app: admin-configured via uiConfig.startPage.defaultAppId; when it
  // is unset or not accessible to this user, the top-ranked chat app. Shared
  // with the sidebar's "New chat" button so both open the same app.
  const defaultApp = useMemo(
    () => pickDefaultChatApp(apps, favoriteAppIds, uiConfig),
    [apps, favoriteAppIds, uiConfig]
  );

  // Featured apps: the top of the shared ranking, capped by the admin's count.
  const featuredApps = useMemo(
    () => rankedApps.slice(0, startPageCount),
    [rankedApps, startPageCount]
  );

  // The three most recent stored chats. `GET /api/chats` returns the stored
  // document only, so the app's colour and icon are joined from the apps list
  // this page already has.
  const recentChats = useMemo(() => {
    if (!chatsEnabled) return [];
    return chats.slice(0, 3).map(chat => {
      const app = apps.find(a => a.id === chat.appId);
      return {
        id: chat.id,
        appId: chat.appId,
        title: chat.title,
        appColor: app?.color || '#4f46e5',
        appIcon: app?.icon || 'chat'
      };
    });
  }, [chatsEnabled, chats, apps]);

  const logoSrc = uiConfig?.header?.logo?.url ? buildAssetUrl(uiConfig.header.logo.url) : null;
  const logoAlt = getLocalizedContent(uiConfig?.header?.logo?.alt, currentLanguage) || 'iHub';

  return (
    <div className="min-h-full flex flex-col items-center justify-center px-6 py-12 bg-gray-50 dark:bg-gray-900">
      <div className="w-full max-w-2xl">
        {/* Logo + greeting */}
        <div className="flex flex-col items-center text-center mb-8">
          {logoSrc ? (
            <img src={logoSrc} alt={logoAlt} className="w-12 h-12 object-contain mb-4" />
          ) : (
            <div className="mb-4">
              <IHubLogo size={46} />
            </div>
          )}
          <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100 tracking-tight mb-2">
            {greeting}
          </h1>
          <p className="text-base text-gray-500 dark:text-gray-400">{subtitle}</p>
        </div>

        {/* Default chat input — renders the real app input (uploads, prompts,
            placeholder, input mode, tools) and starts the chat on submit. */}
        {showDefaultApp && defaultApp && (
          <div className="mb-8">
            <div className="flex items-center justify-between gap-2 mb-2">
              <div className="flex items-center gap-2 min-w-0">
                <span
                  className="w-6 h-6 rounded-md flex items-center justify-center text-white text-xs flex-none"
                  style={{ backgroundColor: defaultApp.color || '#4f46e5' }}
                >
                  <Icon name={defaultApp.icon} size="sm" className="w-3.5 h-3.5" />
                </span>
                <span className="text-sm font-medium text-gray-500 dark:text-gray-400 truncate">
                  {getLocalizedContent(defaultApp.name, currentLanguage)}
                </span>
              </div>
              <button
                onClick={() => navigate(`/apps/${defaultApp.id}`)}
                className="text-sm text-indigo-600 dark:text-indigo-400 font-medium hover:underline flex-none"
              >
                {t('startPage.openApp', 'Open full app')} →
              </button>
            </div>

            <AppChatStarter app={defaultApp} pickProjects />
          </div>
        )}

        {appsLoading && !defaultApp && (
          <div className="flex justify-center mb-8">
            <LoadingSpinner message={t('app.loading')} />
          </div>
        )}

        {!appsLoading && apps.length === 0 && (
          <p role="status" className="text-center text-sm text-gray-500 dark:text-gray-400 mb-8">
            {appsError
              ? t('startPage.appsUnavailable', 'Apps could not be loaded. Please try again later.')
              : // Admins customise this text under UI Customization → Error Pages.
                getLocalizedContent(uiConfig?.errorPages?.noApps?.message, currentLanguage) ||
                t('startPage.noApps', 'No apps are available for your account yet.')}
          </p>
        )}

        {/* Jump into an app */}
        {featuredApps.length > 0 && (
          <div className="mb-7">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-[0.6875rem] font-bold tracking-widest uppercase text-gray-500 dark:text-gray-400">
                {t('startPage.jumpIntoApp', 'Jump into an app')}
              </h2>
              <button
                onClick={() => navigate('/apps')}
                className="text-sm text-indigo-600 dark:text-indigo-400 font-semibold hover:underline"
              >
                {t('startPage.browseAllApps', 'Browse all apps')} →
              </button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {featuredApps.map(app => {
                const name = getLocalizedContent(app.name, currentLanguage) || app.id;
                const desc = getLocalizedContent(app.description, currentLanguage) || '';
                return (
                  <button
                    key={app.id}
                    onClick={() => navigate(`/apps/${app.id}`)}
                    className="flex items-center gap-3 px-4 py-3.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-left hover:border-gray-300 dark:hover:border-gray-600 hover:shadow-md transition-all"
                  >
                    <span
                      className="w-10 h-10 rounded-xl flex items-center justify-center flex-none text-white"
                      style={{ backgroundColor: app.color || '#4f46e5' }}
                    >
                      <Icon name={app.icon} size="md" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-semibold text-[0.9062rem] text-gray-900 dark:text-gray-100 truncate">
                        {name}
                      </span>
                      <span className="block text-[0.7812rem] text-gray-500 dark:text-gray-400 truncate">
                        {desc}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Pick up where you left off — the viewer's most recent stored chats */}
        {recentChats.length > 0 && (
          <div>
            <h2 className="text-[0.6875rem] font-bold tracking-widest uppercase text-gray-500 dark:text-gray-400 mb-3">
              {t('startPage.pickUpWhereYouLeftOff', 'Pick up where you left off')}
            </h2>
            <div className="flex flex-wrap gap-2">
              {recentChats.map(chat => (
                <button
                  key={chat.id}
                  onClick={() =>
                    navigate(chat.appId ? `/apps/${chat.appId}/c/${chat.id}` : '/chats')
                  }
                  className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-700 dark:text-gray-300 hover:border-gray-300 dark:hover:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700 transition-all max-w-xs"
                >
                  <span
                    className="w-5 h-5 rounded-md flex items-center justify-center flex-none text-white"
                    style={{ backgroundColor: chat.appColor }}
                  >
                    <Icon name={chat.appIcon} size="sm" className="w-3 h-3" />
                  </span>
                  <span className="truncate">
                    {chat.title || t('chatHistory.untitled', 'Untitled chat')}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
