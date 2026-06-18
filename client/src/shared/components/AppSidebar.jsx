import { useState, useEffect, useMemo, useCallback } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useUIConfig } from '../contexts/UIConfigContext';
import useFeatureFlags from '../hooks/useFeatureFlags';
import Icon from './Icon';
import { fetchApps } from '../../api/api';
import { createFavoriteItemHelpers } from '../../utils/favoriteItems';
import { getLocalizedContent } from '../../utils/localizeContent';
import { useTranslation } from 'react-i18next';
import { MOCK_CHATS } from '../../features/chat/data/mockChats';
import UserAuthMenu from '../../features/auth/components/UserAuthMenu';
import { buildAssetUrl } from '../../utils/runtimeBasePath';

const SIDEBAR_COLLAPSED_KEY = 'ihub_sidebar_collapsed';
const { getFavorites: getFavoriteApps, toggleFavorite: toggleFavoriteApp } =
  createFavoriteItemHelpers('ihub_favorite_apps');

// iHub gradient logo SVG
function IHubLogo({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="ihub-lg" x1="6" y1="34" x2="34" y2="6" gradientUnits="userSpaceOnUse">
          <stop stopColor="#16a34a" />
          <stop offset="1" stopColor="#0ea5b7" />
        </linearGradient>
      </defs>
      <path d="M20 5L34 33H27.2L20 17.5L12.8 33H6L20 5Z" fill="url(#ihub-lg)" />
    </svg>
  );
}

function NavButton({ icon, label, onClick, active }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-3 w-full px-3 py-2 rounded-lg text-sm font-medium transition-colors text-left ${
        active
          ? 'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300'
          : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
      }`}
    >
      <Icon
        name={icon}
        size="sm"
        className={
          active ? 'text-indigo-600 dark:text-indigo-400' : 'text-gray-500 dark:text-gray-400'
        }
      />
      {label}
    </button>
  );
}

function SectionHeader({ label, open, onToggle }) {
  return (
    <button
      onClick={onToggle}
      className="flex items-center gap-1.5 w-full px-4 py-2 text-left"
      aria-expanded={open}
    >
      <Icon
        name="chevron-down"
        size="sm"
        className={`text-gray-400 transition-transform duration-150 ${open ? '' : '-rotate-90'}`}
      />
      <span className="text-[11px] font-bold tracking-widest uppercase text-gray-400">{label}</span>
    </button>
  );
}

export default function AppSidebar() {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const { user, isAuthenticated } = useAuth();
  const { uiConfig } = useUIConfig();
  const featureFlags = useFeatureFlags();
  const location = useLocation();
  const navigate = useNavigate();

  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true';
    } catch {
      return false;
    }
  });
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [appsOpen, setAppsOpen] = useState(true);
  const [recentsOpen, setRecentsOpen] = useState(true);
  const [apps, setApps] = useState([]);
  const [favoriteAppIds, setFavoriteAppIds] = useState(() => getFavoriteApps());

  const chatHistoryEnabled = featureFlags.isEnabled('chatHistory', false);

  useEffect(() => {
    let mounted = true;
    fetchApps()
      .then(data => {
        if (mounted && data && Array.isArray(data)) setApps(data);
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, []);

  const toggleCollapsed = useCallback(() => {
    setCollapsed(prev => {
      const next = !prev;
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(next));
      } catch {}
      return next;
    });
    if (!collapsed) {
      setSearchOpen(false);
      setSearch('');
    }
  }, [collapsed]);

  const handleToggleFav = useCallback((e, appId) => {
    e.preventDefault();
    e.stopPropagation();
    const newStatus = toggleFavoriteApp(appId);
    setFavoriteAppIds(prev => (newStatus ? [...prev, appId] : prev.filter(id => id !== appId)));
  }, []);

  const sidebarApps = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = apps.map(a => ({ ...a, isFav: favoriteAppIds.includes(a.id) }));
    list.sort((a, b) => {
      if (a.isFav && !b.isFav) return -1;
      if (!a.isFav && b.isFav) return 1;
      return 0;
    });
    if (q) {
      list = list.filter(a => {
        const name = getLocalizedContent(a.name, currentLanguage) || '';
        const desc = getLocalizedContent(a.description, currentLanguage) || '';
        return name.toLowerCase().includes(q) || desc.toLowerCase().includes(q);
      });
    }
    return list.slice(0, 5);
  }, [apps, favoriteAppIds, search, currentLanguage]);

  const recentChats = useMemo(() => {
    if (!chatHistoryEnabled) return [];
    const q = search.trim().toLowerCase();
    if (!q) return MOCK_CHATS.slice(0, 5);
    return MOCK_CHATS.filter(
      c =>
        c.title.toLowerCase().includes(q) ||
        c.appName.toLowerCase().includes(q) ||
        c.snippet.toLowerCase().includes(q)
    ).slice(0, 5);
  }, [chatHistoryEnabled, search]);

  const isOnApps = location.pathname === '/apps' || location.pathname === '/';
  const isOnPrompts = location.pathname.startsWith('/prompts');
  const isOnChats = location.pathname.startsWith('/chats');

  const headerTitle = useMemo(() => {
    if (uiConfig?.header?.titleLight || uiConfig?.header?.titleBold) {
      return (
        <>
          <span className="font-light">
            {getLocalizedContent(uiConfig.header.titleLight, currentLanguage)}
          </span>
          <span className="font-extrabold">
            {getLocalizedContent(uiConfig.header.titleBold, currentLanguage)}
          </span>
        </>
      );
    }
    return (
      <>
        <span className="font-light">iHub </span>
        <span className="font-extrabold">Apps</span>
      </>
    );
  }, [uiConfig, currentLanguage]);

  const logoSrc = uiConfig?.header?.logo?.url ? buildAssetUrl(uiConfig.header.logo.url) : null;

  if (collapsed) {
    return (
      <aside
        className="w-[72px] flex-none flex flex-col items-center gap-1.5 bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-700 py-4"
        aria-label={t('sidebar.navigation', 'Navigation')}
      >
        <div className="mb-1">
          {logoSrc ? (
            <img src={logoSrc} alt="Logo" className="w-7 h-7 object-contain" />
          ) : (
            <IHubLogo size={28} />
          )}
        </div>

        <button
          title={t('sidebar.expand', 'Expand sidebar')}
          onClick={toggleCollapsed}
          className="w-10 h-10 flex items-center justify-center rounded-xl text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
        >
          <Icon name="chevron-right" size="md" />
        </button>

        <button
          title={t('sidebar.newChat', 'New chat')}
          onClick={() => navigate('/')}
          className="w-10 h-10 flex items-center justify-center rounded-xl bg-indigo-600 text-white hover:bg-indigo-700 transition-colors"
        >
          <Icon name="plus" size="md" />
        </button>

        <button
          title={t('common.search', 'Search')}
          onClick={() => {
            setCollapsed(false);
            try {
              localStorage.setItem(SIDEBAR_COLLAPSED_KEY, 'false');
            } catch {}
            setSearchOpen(true);
          }}
          className="w-10 h-10 flex items-center justify-center rounded-xl text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
        >
          <Icon name="search" size="md" />
        </button>

        <button
          title={t('sidebar.browseApps', 'Browse all apps')}
          onClick={() => navigate('/apps')}
          className={`w-10 h-10 flex items-center justify-center rounded-xl transition-colors ${
            isOnApps
              ? 'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400'
              : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'
          }`}
        >
          <Icon name="home" size="md" />
        </button>

        {featureFlags.isEnabled('promptsLibrary', true) && (
          <button
            title={t('sidebar.prompts', 'Prompts')}
            onClick={() => navigate('/prompts')}
            className={`w-10 h-10 flex items-center justify-center rounded-xl transition-colors ${
              isOnPrompts
                ? 'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400'
                : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'
            }`}
          >
            <Icon name="sparkles" size="md" />
          </button>
        )}

        <div className="w-8 h-px bg-gray-200 dark:bg-gray-700 my-1" />

        {apps
          .filter(a => favoriteAppIds.includes(a.id))
          .slice(0, 4)
          .map(app => (
            <button
              key={app.id}
              title={getLocalizedContent(app.name, currentLanguage) || app.id}
              onClick={() => navigate(`/apps/${app.id}`)}
              className="w-10 h-10 flex items-center justify-center rounded-xl text-white transition-colors hover:brightness-110"
              style={{ backgroundColor: app.color || '#4f46e5' }}
            >
              <Icon name={app.icon} size="md" />
            </button>
          ))}

        <div className="flex-1" />

        <UserAuthMenu variant="sidebar" className="w-full flex justify-center" />
      </aside>
    );
  }

  return (
    <aside
      className="w-[284px] flex-none flex flex-col bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-700"
      aria-label={t('sidebar.navigation', 'Navigation')}
    >
      {/* Header */}
      <div className="px-4 pt-4 pb-0 flex items-center gap-2.5">
        {logoSrc ? (
          <img src={logoSrc} alt="Logo" className="w-8 h-8 object-contain flex-none" />
        ) : (
          <div className="flex-none">
            <IHubLogo size={30} />
          </div>
        )}
        <div className="flex-1 min-w-0 leading-tight">
          <div className="text-base text-gray-900 dark:text-gray-100">{headerTitle}</div>
          <div className="text-[10px] text-gray-400 tracking-wide">by IntraFind</div>
        </div>
        <button
          title={t('sidebar.collapse', 'Collapse sidebar')}
          onClick={toggleCollapsed}
          className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-600 dark:hover:text-gray-300 transition-colors flex-none"
        >
          <Icon name="chevron-left" size="sm" />
        </button>
      </div>

      {/* New chat + search */}
      <div className="px-4 pt-3.5 pb-1 flex gap-2">
        <button
          onClick={() => navigate('/')}
          className="flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold transition-colors"
        >
          <Icon name="plus" size="sm" />
          {t('sidebar.newChat', 'New chat')}
        </button>
        <button
          onClick={() => {
            setSearchOpen(s => !s);
            if (searchOpen) setSearch('');
          }}
          title={t('sidebar.searchChatsApps', 'Search chats & apps')}
          className={`w-11 flex items-center justify-center rounded-xl border transition-colors ${
            searchOpen
              ? 'border-indigo-300 bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600'
              : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-800'
          }`}
        >
          <Icon name="search" size="sm" />
        </button>
      </div>

      {searchOpen && (
        <div className="px-4 pb-2">
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">
              <Icon name="search" size="sm" />
            </span>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={t('sidebar.searchPlaceholder', 'Search chats & apps')}
              autoFocus
              className="w-full pl-9 pr-3 py-2 rounded-lg border border-indigo-200 dark:border-indigo-700 bg-gray-50 dark:bg-gray-800 text-sm outline-none focus:border-indigo-400 dark:text-gray-100"
            />
          </div>
        </div>
      )}

      {/* Scrollable middle */}
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden flex flex-col">
        {/* Nav items */}
        <div className="px-2 pt-2 pb-1">
          <NavButton
            icon="home"
            label={t('sidebar.browseApps', 'Browse all apps')}
            onClick={() => navigate('/apps')}
            active={location.pathname === '/apps'}
          />
          {featureFlags.isEnabled('promptsLibrary', true) && (
            <NavButton
              icon="sparkles"
              label={t('sidebar.prompts', 'Prompts')}
              onClick={() => navigate('/prompts')}
              active={isOnPrompts}
            />
          )}
        </div>

        {/* Apps section */}
        <SectionHeader
          label={t('sidebar.apps', 'Apps')}
          open={appsOpen}
          onToggle={() => setAppsOpen(o => !o)}
        />
        {appsOpen && (
          <div className="px-2 pb-2">
            {sidebarApps.length === 0 && (
              <p className="text-xs text-gray-400 px-3 py-1">
                {apps.length === 0
                  ? t('sidebar.loadingApps', 'Loading…')
                  : t('sidebar.noAppsMatch', 'No apps match')}
              </p>
            )}
            {sidebarApps.map(app => {
              const name = getLocalizedContent(app.name, currentLanguage) || app.id;
              const isActive =
                location.pathname === `/apps/${app.id}` ||
                location.pathname.startsWith(`/apps/${app.id}/`);
              return (
                <div
                  key={app.id}
                  className={`flex items-center rounded-lg transition-colors ${
                    isActive
                      ? 'bg-indigo-50 dark:bg-indigo-900/30'
                      : 'hover:bg-gray-100 dark:hover:bg-gray-800'
                  }`}
                >
                  <button
                    onClick={() => navigate(`/apps/${app.id}`)}
                    title={name}
                    className="flex-1 flex items-center gap-2.5 px-3 py-1.5 rounded-lg text-sm font-medium text-gray-700 dark:text-gray-300 text-left min-w-0"
                  >
                    <span
                      className="w-6 h-6 rounded-lg flex items-center justify-center flex-none text-white"
                      style={{ backgroundColor: app.color || '#4f46e5' }}
                    >
                      <Icon name={app.icon} size="sm" className="w-3.5 h-3.5" />
                    </span>
                    <span className="flex-1 truncate">{name}</span>
                  </button>
                  <button
                    onClick={e => handleToggleFav(e, app.id)}
                    title={
                      app.isFav ? t('pages.appsList.unfavorite') : t('pages.appsList.favorite')
                    }
                    className="w-8 h-8 flex-none mr-1 rounded-lg flex items-center justify-center text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
                  >
                    <Icon
                      name="star"
                      size="sm"
                      className={app.isFav ? 'text-yellow-400' : 'text-gray-300'}
                      solid={app.isFav}
                    />
                  </button>
                </div>
              );
            })}
            <button
              onClick={() => navigate('/apps')}
              className="flex items-center gap-2.5 w-full px-3 py-1.5 mt-1 rounded-lg text-indigo-600 dark:text-indigo-400 text-sm font-semibold hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            >
              <span className="w-6 h-6 flex items-center justify-center flex-none">
                <Icon name="home" size="sm" />
              </span>
              <span className="flex-1">{t('sidebar.allApps', 'All apps')}</span>
              <span className="text-[11px] font-bold text-gray-400 bg-gray-100 dark:bg-gray-800 rounded-full px-2 py-0.5">
                {apps.length}
              </span>
            </button>
          </div>
        )}

        {/* Recents section — feature-flagged */}
        {chatHistoryEnabled && (
          <>
            <SectionHeader
              label={t('sidebar.recents', 'Recents')}
              open={recentsOpen}
              onToggle={() => setRecentsOpen(o => !o)}
            />
            {recentsOpen && (
              <div className="px-2 pb-2">
                {recentChats.map(chat => {
                  const isActive = location.pathname === `/chats/${chat.id}`;
                  return (
                    <button
                      key={chat.id}
                      onClick={() => navigate(`/chats`)}
                      title={chat.title}
                      className={`flex items-center gap-2.5 w-full px-3 py-1.5 rounded-lg text-sm text-gray-700 dark:text-gray-300 text-left transition-colors ${
                        isActive
                          ? 'bg-indigo-50 dark:bg-indigo-900/30'
                          : 'hover:bg-gray-100 dark:hover:bg-gray-800'
                      }`}
                    >
                      <span
                        className="w-5 h-5 rounded-md flex items-center justify-center flex-none text-white"
                        style={{ backgroundColor: chat.appColor || '#4f46e5' }}
                      >
                        <Icon name={chat.appIcon} size="sm" className="w-3 h-3" />
                      </span>
                      <span className="flex-1 truncate text-[13px]">{chat.title}</span>
                    </button>
                  );
                })}
                <button
                  onClick={() => navigate('/chats')}
                  className="flex items-center gap-2.5 w-full px-3 py-1.5 mt-1 rounded-lg text-indigo-600 dark:text-indigo-400 text-sm font-semibold hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                >
                  <span className="w-5 h-5 flex items-center justify-center flex-none">
                    <Icon name="clock" size="sm" />
                  </span>
                  <span className="flex-1">{t('sidebar.allChats', 'All chats')}</span>
                  <span className="text-[11px] font-bold text-gray-400 bg-gray-100 dark:bg-gray-800 rounded-full px-2 py-0.5">
                    {MOCK_CHATS.length}
                  </span>
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {/* Account section */}
      <div className="border-t border-gray-100 dark:border-gray-800">
        <UserAuthMenu variant="sidebar" />
      </div>
    </aside>
  );
}
