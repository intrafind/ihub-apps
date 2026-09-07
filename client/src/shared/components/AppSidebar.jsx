import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useUIConfig } from '../contexts/UIConfigContext';
import useFeatureFlags from '../hooks/useFeatureFlags';
import useApps from '../hooks/useApps';
import useFavorites from '../hooks/useFavorites';
import Icon from './Icon';
import IHubLogo from './IHubLogo';
import { getLocalizedContent } from '../../utils/localizeContent';
import { sortFavoritesFirst } from '../../utils/favoriteItems';
import useMediaQuery from '../hooks/useMediaQuery';
import BrandTitle from './BrandTitle';
import { isActivePath } from '../../utils/pathUtils';
import { canAccessLink, FEATURE_ROUTES } from '../../utils/pageAccess';
import { useTranslation } from 'react-i18next';
import { MOCK_CHATS } from '../../features/chat/data/mockChats';
import UserAuthMenu from '../../features/auth/components/UserAuthMenu';
import LanguageSelector from './LanguageSelector';
import DarkModeToggle from './DarkModeToggle';
import { buildAssetUrl } from '../../utils/runtimeBasePath';

const SIDEBAR_COLLAPSED_KEY = 'ihub_sidebar_collapsed';
const FAVORITE_APPS_KEY = 'ihub_favorite_apps';

// Navigation entries are real links (open-in-new-tab, middle click, history)
// like the header links they replace; external targets open in a new tab.
function NavItem({ icon, label, to, external = false, onClick, active }) {
  const className = `flex items-center gap-3 w-full px-3 py-2 rounded-lg text-sm font-medium transition-colors text-left ${
    active
      ? 'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300'
      : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
  }`;
  const content = (
    <>
      <Icon
        name={icon}
        size="sm"
        className={
          active ? 'text-indigo-600 dark:text-indigo-400' : 'text-gray-500 dark:text-gray-400'
        }
      />
      {label}
    </>
  );
  if (external) {
    return (
      <a
        href={to}
        target="_blank"
        rel="noopener noreferrer"
        onClick={onClick}
        className={className}
      >
        {content}
      </a>
    );
  }
  return (
    <Link
      to={to}
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={className}
    >
      {content}
    </Link>
  );
}

function SectionHeader({ label, badge = null, open, onToggle }) {
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
      <span className="text-[11px] font-bold tracking-widest uppercase text-gray-500 dark:text-gray-400">
        {label}
      </span>
      {badge && (
        <span className="text-[10px] font-semibold text-amber-800 dark:text-amber-200 bg-amber-100 dark:bg-amber-900/40 rounded px-1.5">
          {badge}
        </span>
      )}
    </button>
  );
}

const railItemClass = active =>
  `w-10 h-10 flex items-center justify-center rounded-xl transition-colors ${
    active
      ? 'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400'
      : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'
  }`;

export default function AppSidebar({ mobileOpen = false, onMobileClose = () => {} }) {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const { user, isAuthenticated } = useAuth();
  const { uiConfig } = useUIConfig();
  const featureFlags = useFeatureFlags();
  const location = useLocation();

  const { apps, loading: appsLoading, error: appsError } = useApps();
  // Render exactly one sidebar variant instead of mounting both and hiding one with CSS.
  const isDesktop = useMediaQuery('(min-width: 768px)');
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
  const drawerRef = useRef(null);
  const expandButtonRef = useRef(null);
  const collapseButtonRef = useRef(null);
  const refocusAfterToggle = useRef(false);

  const chatHistoryEnabled = featureFlags.isEnabled('chatHistoryPreview', false);
  // Same gate as the /prompts route in App.jsx.
  const promptsEnabled =
    uiConfig?.promptsList?.enabled !== false && featureFlags.isEnabled('promptsLibrary', true);
  // Without chat history the search only covers apps — say so.
  const searchLabel = chatHistoryEnabled
    ? t('sidebar.searchChatsApps', 'Search chats & apps')
    : t('sidebar.searchApps', 'Search apps');
  const sidebarLabel = t('sidebar.label', 'Sidebar');
  const navigationLabel = t('sidebar.navigation', 'Navigation');

  // A drawer left open while the viewport grows to desktop would keep the
  // page scroll locked with nothing visible — close it.
  useEffect(() => {
    if (isDesktop && mobileOpen) onMobileClose();
  }, [isDesktop, mobileOpen, onMobileClose]);

  // Mobile drawer is a modal dialog: move focus into it, keep Tab inside,
  // close on Escape, lock page scroll, and hand focus back when it closes.
  useEffect(() => {
    if (!mobileOpen) return;
    const opener = document.activeElement;
    const focusables = () =>
      Array.from(
        drawerRef.current?.querySelectorAll(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        ) || []
      ).filter(el => el.offsetParent !== null);
    focusables()[0]?.focus();
    const onKey = e => {
      if (e.key === 'Escape') {
        onMobileClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const els = focusables();
      if (els.length === 0) return;
      const first = els[0];
      const last = els[els.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
      if (opener && typeof opener.focus === 'function' && document.contains(opener)) opener.focus();
    };
  }, [mobileOpen, onMobileClose]);

  const persistCollapsed = value => {
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(value));
    } catch {
      // ignore storage failures (private mode, etc.)
    }
  };

  const toggleCollapsed = useCallback(() => {
    refocusAfterToggle.current = true;
    setCollapsed(prev => {
      persistCollapsed(!prev);
      return !prev;
    });
    setSearchOpen(false);
    setSearch('');
  }, []);

  // Collapsing swaps the whole tree, which would drop keyboard focus to <body>;
  // land it on the counterpart toggle instead.
  useEffect(() => {
    if (!refocusAfterToggle.current) return;
    refocusAfterToggle.current = false;
    (collapsed ? expandButtonRef : collapseButtonRef).current?.focus();
  }, [collapsed]);

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
    let list = sortFavoritesFirst(apps, favoriteAppIds);
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
      if (link.url.startsWith('/prompts') && !promptsEnabled) return false;
      const featureId = FEATURE_ROUTES[link.url];
      if (featureId && !featureFlags.isEnabled(featureId, true)) return false;
      return canAccessLink(link, { uiConfig, isAuthenticated, user });
    });
  }, [uiConfig, featureFlags, isAuthenticated, user, promptsEnabled]);

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

  const favLabel = fav =>
    fav
      ? t('pages.appsList.unfavorite', 'Remove from favorites')
      : t('pages.appsList.favorite', 'Add to favorites');

  // ---- Collapsed rail (desktop only) ----
  const rail = (
    <aside
      className="hidden md:flex w-18 flex-none flex-col items-center gap-1.5 bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-700 py-4"
      aria-label={sidebarLabel}
    >
      <Link
        to="/"
        title={t('sidebar.home', 'Home')}
        aria-label={t('sidebar.home', 'Home')}
        className="mb-1 rounded-lg p-0.5 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
      >
        {renderBrandMark(28)}
      </Link>

      <button
        ref={expandButtonRef}
        title={t('sidebar.expand', 'Expand sidebar')}
        aria-label={t('sidebar.expand', 'Expand sidebar')}
        onClick={toggleCollapsed}
        className={railItemClass(false)}
      >
        <Icon name="chevron-right" size="md" />
      </button>

      <nav aria-label={navigationLabel} className="flex flex-col items-center gap-1.5">
        <Link
          to="/"
          title={t('sidebar.newChat', 'New chat')}
          aria-label={t('sidebar.newChat', 'New chat')}
          className="w-10 h-10 flex items-center justify-center rounded-xl bg-indigo-600 text-white hover:bg-indigo-700 transition-colors"
        >
          <Icon name="plus" size="md" />
        </Link>

        <button
          title={searchLabel}
          aria-label={searchLabel}
          onClick={() => {
            setCollapsed(false);
            persistCollapsed(false);
            setSearchOpen(true);
          }}
          className={railItemClass(false)}
        >
          <Icon name="search" size="md" />
        </button>

        <Link
          to="/apps"
          title={t('sidebar.browseApps', 'Browse all apps')}
          aria-label={t('sidebar.browseApps', 'Browse all apps')}
          aria-current={isOnApps ? 'page' : undefined}
          className={railItemClass(isOnApps)}
        >
          <Icon name="home" size="md" />
        </Link>

        {promptsEnabled && (
          <Link
            to="/prompts"
            title={t('sidebar.prompts', 'Prompts')}
            aria-label={t('sidebar.prompts', 'Prompts')}
            aria-current={isOnPrompts ? 'page' : undefined}
            className={railItemClass(isOnPrompts)}
          >
            <Icon name="sparkles" size="md" />
          </Link>
        )}

        {configuredLinks.map(link => {
          const label = getLocalizedContent(link.name, currentLanguage) || link.url;
          const isExternal = /^https?:\/\//.test(link.url) || link.url.startsWith('mailto:');
          const active = !isExternal && isActivePath(location.pathname, link.url);
          return isExternal ? (
            <a
              key={link.url}
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              title={label}
              aria-label={label}
              className={railItemClass(false)}
            >
              <Icon name={linkIconFor(link.url)} size="md" />
            </a>
          ) : (
            <Link
              key={link.url}
              to={link.url}
              title={label}
              aria-label={label}
              aria-current={active ? 'page' : undefined}
              className={railItemClass(active)}
            >
              <Icon name={linkIconFor(link.url)} size="md" />
            </Link>
          );
        })}

        <div className="w-8 h-px bg-gray-200 dark:bg-gray-700 my-1" aria-hidden="true" />

        {apps
          .filter(a => favoriteAppIds.includes(a.id))
          .slice(0, 4)
          .map(app => {
            const name = getLocalizedContent(app.name, currentLanguage) || app.id;
            return (
              <Link
                key={app.id}
                to={`/apps/${app.id}`}
                title={name}
                aria-label={name}
                className="w-10 h-10 flex items-center justify-center rounded-xl text-white transition hover:brightness-110"
                style={{ backgroundColor: app.color || '#4f46e5' }}
              >
                <Icon name={app.icon} size="md" />
              </Link>
            );
          })}
      </nav>

      <div className="flex-1" />

      {uiConfig?.header?.languageSelector?.enabled !== false && (
        <LanguageSelector variant="sidebar" />
      )}
      <DarkModeToggle variant="sidebar" className="mb-1" />
      <UserAuthMenu variant="sidebar" collapsed className="flex justify-center" />
    </aside>
  );

  // ---- Expanded content (shared by desktop-expanded and mobile drawer) ----
  const closeLabel = mobileOpen
    ? t('sidebar.closeMenu', 'Close navigation')
    : t('sidebar.collapse', 'Collapse sidebar');

  const expandedContent = (
    <>
      {/* Header */}
      <div className="px-4 pt-4 pb-0 flex items-center gap-2.5">
        <Link
          to="/"
          onClick={onMobileClose}
          title={t('sidebar.home', 'Home')}
          className="flex items-center gap-2.5 flex-1 min-w-0 rounded-lg -ml-1 pl-1 py-1 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors text-left"
        >
          <span className="flex-none">{renderBrandMark(30)}</span>
          <span className="flex-1 min-w-0 leading-tight">
            <BrandTitle
              uiConfig={uiConfig}
              currentLanguage={currentLanguage}
              className="block text-base text-gray-900 dark:text-gray-100 truncate"
            />
            {tagline && (
              <span className="block text-[10px] text-gray-500 dark:text-gray-400 tracking-wide truncate">
                {tagline}
              </span>
            )}
          </span>
        </Link>
        {/* Collapse on desktop, close on mobile */}
        <button
          ref={mobileOpen ? undefined : collapseButtonRef}
          title={closeLabel}
          aria-label={closeLabel}
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
        <Link
          to="/"
          onClick={onMobileClose}
          className="flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold transition-colors"
        >
          <Icon name="plus" size="sm" />
          {t('sidebar.newChat', 'New chat')}
        </Link>
        <button
          onClick={() => {
            setSearchOpen(s => !s);
            if (searchOpen) setSearch('');
          }}
          title={searchLabel}
          aria-label={searchLabel}
          aria-expanded={searchOpen}
          className={`w-11 flex items-center justify-center rounded-xl border transition-colors ${
            searchOpen
              ? 'border-indigo-300 dark:border-indigo-700 bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400'
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
              placeholder={searchLabel}
              aria-label={searchLabel}
              autoFocus
              className="w-full pl-9 pr-3 py-2 rounded-lg border border-indigo-200 dark:border-indigo-700 bg-gray-50 dark:bg-gray-800 text-sm outline-hidden focus:border-indigo-400 dark:text-gray-100"
            />
          </div>
        </div>
      )}

      {/* Scrollable middle */}
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden flex flex-col">
        {/* Nav items */}
        <nav className="px-2 pt-2 pb-1" aria-label={navigationLabel}>
          <NavItem
            icon="home"
            label={t('sidebar.browseApps', 'Browse all apps')}
            to="/apps"
            onClick={onMobileClose}
            active={isOnApps}
          />
          {configuredLinks.map(link => {
            const label = getLocalizedContent(link.name, currentLanguage) || link.url;
            const isExternal = /^https?:\/\//.test(link.url) || link.url.startsWith('mailto:');
            return (
              <NavItem
                key={link.url}
                icon={linkIconFor(link.url)}
                label={label}
                to={link.url}
                external={isExternal}
                onClick={onMobileClose}
                active={!isExternal && isActivePath(location.pathname, link.url)}
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
              <p className="text-xs text-gray-500 dark:text-gray-400 px-3 py-1">
                {appsLoading
                  ? t('sidebar.loadingApps', 'Loading…')
                  : appsError && apps.length === 0
                    ? t('sidebar.appsUnavailable', 'Apps could not be loaded')
                    : apps.length === 0
                      ? getLocalizedContent(uiConfig?.errorPages?.noApps?.title, currentLanguage) ||
                        t('sidebar.noApps', 'No apps available')
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
                  <Link
                    to={`/apps/${app.id}`}
                    onClick={onMobileClose}
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
                  </Link>
                  <button
                    onClick={e => handleToggleFav(e, app.id)}
                    aria-pressed={fav}
                    aria-label={favLabel(fav)}
                    title={favLabel(fav)}
                    className="w-8 h-8 flex-none mr-1 rounded-lg flex items-center justify-center hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
                  >
                    <Icon
                      name="star"
                      size="sm"
                      className={fav ? 'text-amber-500' : 'text-gray-500 dark:text-gray-400'}
                      solid={fav}
                    />
                  </button>
                </div>
              );
            })}
            <Link
              to="/apps"
              onClick={onMobileClose}
              className="flex items-center gap-2.5 w-full px-3 py-1.5 mt-1 rounded-lg text-indigo-600 dark:text-indigo-400 text-sm font-semibold hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            >
              <span className="w-6 h-6 flex items-center justify-center flex-none">
                <Icon name="home" size="sm" />
              </span>
              <span className="flex-1">{t('sidebar.allApps', 'All apps')}</span>
              <span className="text-[11px] font-bold text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 rounded-full px-2 py-0.5">
                {apps.length}
              </span>
            </Link>
          </div>
        )}

        {/* Recents section — feature-flagged */}
        {chatHistoryEnabled && (
          <>
            <SectionHeader
              label={t('sidebar.recents', 'Recents')}
              badge={t('sidebar.sampleBadge', 'Sample')}
              open={recentsOpen}
              onToggle={() => setRecentsOpen(o => !o)}
            />
            {recentsOpen && (
              <div className="px-2 pb-2">
                {recentChats.map(chat => (
                  <Link
                    key={chat.id}
                    to="/chats"
                    onClick={onMobileClose}
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
                  </Link>
                ))}
                <Link
                  to="/chats"
                  onClick={onMobileClose}
                  aria-current={isOnChats ? 'page' : undefined}
                  className="flex items-center gap-2.5 w-full px-3 py-1.5 mt-1 rounded-lg text-indigo-600 dark:text-indigo-400 text-sm font-semibold hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                >
                  <span className="w-5 h-5 flex items-center justify-center flex-none">
                    <Icon name="clock" size="sm" />
                  </span>
                  <span className="flex-1">{t('sidebar.allChats', 'All chats')}</span>
                  <span className="text-[11px] font-bold text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 rounded-full px-2 py-0.5">
                    {MOCK_CHATS.length}
                  </span>
                </Link>
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
        {uiConfig?.header?.languageSelector?.enabled !== false && (
          <LanguageSelector variant="sidebar" />
        )}
        <DarkModeToggle variant="sidebar" />
      </div>
    </>
  );

  return (
    <>
      {/* Desktop sidebar */}
      {isDesktop &&
        (collapsed ? (
          rail
        ) : (
          <aside
            className="hidden md:flex w-71 flex-none flex-col bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-700"
            aria-label={sidebarLabel}
          >
            {expandedContent}
          </aside>
        ))}

      {/* Mobile drawer */}
      {!isDesktop && mobileOpen && (
        <div
          className="md:hidden fixed inset-0 z-40"
          role="dialog"
          aria-modal="true"
          aria-label={navigationLabel}
        >
          <div
            className="absolute inset-0 bg-black/50"
            onClick={onMobileClose}
            aria-hidden="true"
          />
          <aside
            ref={drawerRef}
            className="absolute inset-y-0 left-0 w-71 max-w-[85vw] flex flex-col bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-700 shadow-xl"
            aria-label={sidebarLabel}
          >
            {expandedContent}
          </aside>
        </div>
      )}
    </>
  );
}
