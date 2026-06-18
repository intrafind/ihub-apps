import { useState, useEffect, useMemo, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useUIConfig } from '../contexts/UIConfigContext';
import useFeatureFlags from '../hooks/useFeatureFlags';
import useApps from '../hooks/useApps';
import useFavorites from '../hooks/useFavorites';
import Icon from './Icon';
import IHubLogo from './IHubLogo';
import { getLocalizedContent } from '../../utils/localizeContent';
import { isActivePath } from '../../utils/pathUtils';
import { canAccessLink, FEATURE_ROUTES } from '../../utils/pageAccess';
import { useTranslation } from 'react-i18next';
import { MOCK_CHATS } from '../../features/chat/data/mockChats';
import UserAuthMenu from '../../features/auth/components/UserAuthMenu';
import LanguageSelector from './LanguageSelector';
import { buildAssetUrl } from '../../utils/runtimeBasePath';

const SIDEBAR_COLLAPSED_KEY = 'ihub_sidebar_collapsed';
const FAVORITE_APPS_KEY = 'ihub_favorite_apps';

function NavButton({ icon, label, onClick, active }) {
  return (
    <button
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
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

export default function AppSidebar({ mobileOpen = false, onMobileClose = () => {} }) {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const { user, isAuthenticated } = useAuth();
  const { uiConfig } = useUIConfig();
  const featureFlags = useFeatureFlags();
  const location = useLocation();
  const navigate = useNavigate();

  const { apps } = useApps();
  const { favorites: favoriteAppIds, isFavorite, toggleFavorite } = useFavorites(FAVORITE_APPS_KEY);

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

  const chatHistoryEnabled = featureFlags.isEnabled('chatHistory', false);

  // Navigate and close the mobile drawer (no-op on desktop).
  const go = useCallback(
    to => {
      navigate(to);
      onMobileClose();
    },
    [navigate, onMobileClose]
  );

  // Close the mobile drawer on Escape.
  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = e => {
      if (e.key === 'Escape') onMobileClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [mobileOpen, onMobileClose]);

  const toggleCollapsed = useCallback(() => {
    setCollapsed(prev => {
      const next = !prev;
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(next));
      } catch {
        // ignore storage failures (private mode, etc.)
      }
      return next;
    });
    setSearchOpen(false);
    setSearch('');
  }, []);

  const handleToggleFav = useCallback(
    (e, appId) => {
      e.preventDefault();
      e.stopPropagation();
      toggleFavorite(appId);
    },
    [toggleFavorite]
  );

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

  const isOnPrompts = location.pathname.startsWith('/prompts');
  const isOnChats = location.pathname.startsWith('/chats');
  const isOnApps = location.pathname === '/apps';

  const linkIconFor = url => {
    if (/^https?:\/\//.test(url)) return 'external-link';
    if (url.startsWith('mailto:')) return 'mail';
    if (url.startsWith('/prompts')) return 'sparkles';
    if (url.startsWith('/pages/')) return 'document';
    if (url === '/') return 'home';
    return 'link';
  };

  // Header links from config (CMS pages, prompts, external), excluding entries
  // already represented by dedicated buttons. Feature gating + page access apply.
  const configuredLinks = useMemo(() => {
    const links = uiConfig?.header?.links;
    if (!Array.isArray(links)) return [];
    return links.filter(link => {
      if (!link?.url) return false;
      if (link.url === '/' || link.url === '/apps') return false;
      const featureId = FEATURE_ROUTES[link.url];
      if (featureId && !featureFlags.isEnabled(featureId, true)) return false;
      return canAccessLink(link, { uiConfig, isAuthenticated, user });
    });
  }, [uiConfig, featureFlags, isAuthenticated, user]);

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
  const logoAlt = getLocalizedContent(uiConfig?.header?.logo?.alt, currentLanguage) || 'iHub';
  // Vendor tagline is only shown when configured (no hard-coded vendor name).
  const tagline = uiConfig?.header?.tagline
    ? getLocalizedContent(uiConfig.header.tagline, currentLanguage)
    : null;

  // Plain render helper (not a nested component) to avoid remounting on render.
  const renderBrandMark = size =>
    logoSrc ? (
      <img
        src={logoSrc}
        alt={logoAlt}
        className="object-contain"
        style={{ width: size, height: size }}
      />
    ) : (
      <IHubLogo size={size} />
    );

  // ---- Collapsed rail (desktop only) ----
  const rail = (
    <aside
      className="hidden md:flex w-[72px] flex-none flex-col items-center gap-1.5 bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-700 py-4"
      aria-label={t('sidebar.navigation', 'Navigation')}
    >
      <button
        onClick={() => go('/')}
        title={t('sidebar.home', 'Home')}
        aria-label={t('sidebar.home', 'Home')}
        className="mb-1 rounded-lg p-0.5 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
      >
        {renderBrandMark(28)}
      </button>

      <button
        title={t('sidebar.expand', 'Expand sidebar')}
        aria-label={t('sidebar.expand', 'Expand sidebar')}
        onClick={toggleCollapsed}
        className="w-10 h-10 flex items-center justify-center rounded-xl text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
      >
        <Icon name="chevron-right" size="md" />
      </button>

      <button
        title={t('sidebar.newChat', 'New chat')}
        aria-label={t('sidebar.newChat', 'New chat')}
        onClick={() => go('/')}
        className="w-10 h-10 flex items-center justify-center rounded-xl bg-indigo-600 text-white hover:bg-indigo-700 transition-colors"
      >
        <Icon name="plus" size="md" />
      </button>

      <button
        title={t('sidebar.search', 'Search')}
        aria-label={t('sidebar.search', 'Search')}
        onClick={() => {
          setCollapsed(false);
          try {
            localStorage.setItem(SIDEBAR_COLLAPSED_KEY, 'false');
          } catch {
            // ignore
          }
          setSearchOpen(true);
        }}
        className="w-10 h-10 flex items-center justify-center rounded-xl text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
      >
        <Icon name="search" size="md" />
      </button>

      <button
        title={t('sidebar.browseApps', 'Browse all apps')}
        aria-label={t('sidebar.browseApps', 'Browse all apps')}
        aria-current={isOnApps ? 'page' : undefined}
        onClick={() => go('/apps')}
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
          aria-label={t('sidebar.prompts', 'Prompts')}
          aria-current={isOnPrompts ? 'page' : undefined}
          onClick={() => go('/prompts')}
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
        .map(app => {
          const name = getLocalizedContent(app.name, currentLanguage) || app.id;
          return (
            <button
              key={app.id}
              title={name}
              aria-label={name}
              onClick={() => go(`/apps/${app.id}`)}
              className="w-10 h-10 flex items-center justify-center rounded-xl text-white transition-colors hover:brightness-110"
              style={{ backgroundColor: app.color || '#4f46e5' }}
            >
              <Icon name={app.icon} size="md" />
            </button>
          );
        })}

      <div className="flex-1" />

      <UserAuthMenu variant="sidebar" collapsed className="flex justify-center" />
    </aside>
  );

  // ---- Expanded content (shared by desktop-expanded and mobile drawer) ----
  const expandedContent = (
    <>
      {/* Header */}
      <div className="px-4 pt-4 pb-0 flex items-center gap-2.5">
        <button
          onClick={() => go('/')}
          title={t('sidebar.home', 'Home')}
          className="flex items-center gap-2.5 flex-1 min-w-0 rounded-lg -ml-1 pl-1 py-1 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors text-left"
        >
          <span className="flex-none">
            {renderBrandMark(30)}
          </span>
          <span className="flex-1 min-w-0 leading-tight">
            <span className="block text-base text-gray-900 dark:text-gray-100 truncate">
              {headerTitle}
            </span>
            {tagline && (
              <span className="block text-[10px] text-gray-400 tracking-wide truncate">
                {tagline}
              </span>
            )}
          </span>
        </button>
        {/* Collapse on desktop, close on mobile */}
        <button
          title={t('sidebar.collapse', 'Collapse sidebar')}
          aria-label={t('sidebar.collapse', 'Collapse sidebar')}
          onClick={() => {
            if (mobileOpen) onMobileClose();
            else toggleCollapsed();
          }}
          className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-600 dark:hover:text-gray-300 transition-colors flex-none"
        >
          <Icon name={mobileOpen ? 'x' : 'chevron-left'} size="sm" />
        </button>
      </div>

      {/* New chat + search */}
      <div className="px-4 pt-3.5 pb-1 flex gap-2">
        <button
          onClick={() => go('/')}
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
          aria-label={t('sidebar.searchChatsApps', 'Search chats & apps')}
          aria-expanded={searchOpen}
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
              aria-label={t('sidebar.searchChatsApps', 'Search chats & apps')}
              autoFocus
              className="w-full pl-9 pr-3 py-2 rounded-lg border border-indigo-200 dark:border-indigo-700 bg-gray-50 dark:bg-gray-800 text-sm outline-none focus:border-indigo-400 dark:text-gray-100"
            />
          </div>
        </div>
      )}

      {/* Scrollable middle */}
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden flex flex-col">
        {/* Nav items */}
        <nav className="px-2 pt-2 pb-1" aria-label={t('sidebar.navigation', 'Navigation')}>
          <NavButton
            icon="home"
            label={t('sidebar.browseApps', 'Browse all apps')}
            onClick={() => go('/apps')}
            active={isOnApps}
          />
          {configuredLinks.map((link, index) => {
            const label = getLocalizedContent(link.name, currentLanguage) || link.url;
            const isExternal = /^https?:\/\//.test(link.url) || link.url.startsWith('mailto:');
            return (
              <NavButton
                key={`${link.url}-${index}`}
                icon={linkIconFor(link.url)}
                label={label}
                active={!isExternal && isActivePath(location.pathname, link.url)}
                onClick={() => {
                  if (isExternal) {
                    window.open(link.url, '_blank', 'noopener,noreferrer');
                    onMobileClose();
                  } else {
                    go(link.url);
                  }
                }}
              />
            );
          })}
        </nav>

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
              const fav = isFavorite(app.id);
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
                    onClick={() => go(`/apps/${app.id}`)}
                    title={name}
                    aria-current={isActive ? 'page' : undefined}
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
                    aria-pressed={fav}
                    aria-label={
                      fav
                        ? t('pages.appsList.unfavorite', 'Remove from favorites')
                        : t('pages.appsList.favorite', 'Add to favorites')
                    }
                    title={
                      fav
                        ? t('pages.appsList.unfavorite', 'Remove from favorites')
                        : t('pages.appsList.favorite', 'Add to favorites')
                    }
                    className="w-8 h-8 flex-none mr-1 rounded-lg flex items-center justify-center text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
                  >
                    <Icon
                      name="star"
                      size="sm"
                      className={fav ? 'text-yellow-400' : 'text-gray-300'}
                      solid={fav}
                    />
                  </button>
                </div>
              );
            })}
            <button
              onClick={() => go('/apps')}
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
                {recentChats.map(chat => (
                  <button
                    key={chat.id}
                    onClick={() => go('/chats')}
                    title={chat.title}
                    className="flex items-center gap-2.5 w-full px-3 py-1.5 rounded-lg text-sm text-gray-700 dark:text-gray-300 text-left transition-colors hover:bg-gray-100 dark:hover:bg-gray-800"
                  >
                    <span
                      className="w-5 h-5 rounded-md flex items-center justify-center flex-none text-white"
                      style={{ backgroundColor: chat.appColor || '#4f46e5' }}
                    >
                      <Icon name={chat.appIcon} size="sm" className="w-3 h-3" />
                    </span>
                    <span className="flex-1 truncate text-[13px]">{chat.title}</span>
                  </button>
                ))}
                <button
                  onClick={() => go('/chats')}
                  aria-current={isOnChats ? 'page' : undefined}
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
      <div className="border-t border-gray-100 dark:border-gray-800 px-2 py-2 flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <UserAuthMenu variant="sidebar" />
        </div>
        <LanguageSelector variant="sidebar" />
      </div>
    </>
  );

  return (
    <>
      {/* Desktop sidebar */}
      {collapsed ? (
        rail
      ) : (
        <aside
          className="hidden md:flex w-[284px] flex-none flex-col bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-700"
          aria-label={t('sidebar.navigation', 'Navigation')}
        >
          {expandedContent}
        </aside>
      )}

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="md:hidden fixed inset-0 z-40" role="dialog" aria-modal="true">
          <div className="absolute inset-0 bg-black/50" onClick={onMobileClose} aria-hidden="true" />
          <aside
            className="absolute inset-y-0 left-0 w-[284px] max-w-[85vw] flex flex-col bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-700 shadow-xl"
            aria-label={t('sidebar.navigation', 'Navigation')}
          >
            {expandedContent}
          </aside>
        </div>
      )}
    </>
  );
}
