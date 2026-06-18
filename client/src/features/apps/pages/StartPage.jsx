import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../../shared/contexts/AuthContext';
import { useUIConfig } from '../../../shared/contexts/UIConfigContext';
import useFeatureFlags from '../../../shared/hooks/useFeatureFlags';
import Icon from '../../../shared/components/Icon';
import { fetchApps } from '../../../api/api';
import { createFavoriteItemHelpers } from '../../../utils/favoriteItems';
import { getLocalizedContent } from '../../../utils/localizeContent';
import { useTranslation } from 'react-i18next';
import { MOCK_CHATS } from '../../chat/data/mockChats';
import LoadingSpinner from '../../../shared/components/LoadingSpinner';
import { buildAssetUrl } from '../../../utils/runtimeBasePath';

const { getFavorites: getFavoriteApps } = createFavoriteItemHelpers('ihub_favorite_apps');

function timeBasedGreeting(t) {
  const h = new Date().getHours();
  if (h < 12) return t('startPage.greetingMorning', 'Good morning');
  if (h < 18) return t('startPage.greetingAfternoon', 'Good afternoon');
  return t('startPage.greetingEvening', 'Good evening');
}

// iHub gradient logo
function IHubLogo({ size = 44 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient
          id="sp-ihub-lg"
          x1="6"
          y1="34"
          x2="34"
          y2="6"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#16a34a" />
          <stop offset="1" stopColor="#0ea5b7" />
        </linearGradient>
      </defs>
      <path d="M20 5L34 33H27.2L20 17.5L12.8 33H6L20 5Z" fill="url(#sp-ihub-lg)" />
    </svg>
  );
}

export default function StartPage() {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const { user } = useAuth();
  const { uiConfig } = useUIConfig();
  const featureFlags = useFeatureFlags();
  const navigate = useNavigate();

  const [apps, setApps] = useState([]);
  const [appsLoading, setAppsLoading] = useState(true);
  const [favoriteAppIds, setFavoriteAppIds] = useState(() => getFavoriteApps());
  const [draft, setDraft] = useState('');
  const textareaRef = useRef(null);

  const chatHistoryEnabled = featureFlags.isEnabled('chatHistory', false);

  useEffect(() => {
    let mounted = true;
    setAppsLoading(true);
    fetchApps()
      .then(data => {
        if (mounted && data && Array.isArray(data)) {
          setApps(data);
          setFavoriteAppIds(getFavoriteApps());
        }
      })
      .catch(() => {})
      .finally(() => {
        if (mounted) setAppsLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  const greeting = useMemo(() => {
    const base = timeBasedGreeting(t);
    const name = user?.name || user?.email?.split('@')[0] || '';
    return name ? `${base}, ${name}` : base;
  }, [t, user]);

  // Default app: admin-configured via uiConfig.startPage.defaultAppId, else first app
  const defaultApp = useMemo(() => {
    const defaultId = uiConfig?.startPage?.defaultAppId;
    if (defaultId) {
      const found = apps.find(a => a.id === defaultId);
      if (found) return found;
    }
    return apps[0] || null;
  }, [apps, uiConfig]);

  // Featured apps: favorites first, then by order, max 4
  const featuredApps = useMemo(() => {
    const sorted = [...apps].sort((a, b) => {
      const aFav = favoriteAppIds.includes(a.id);
      const bFav = favoriteAppIds.includes(b.id);
      if (aFav && !bFav) return -1;
      if (!aFav && bFav) return 1;
      const aOrder = a.order ?? Infinity;
      const bOrder = b.order ?? Infinity;
      return aOrder - bOrder;
    });
    return sorted.slice(0, 4);
  }, [apps, favoriteAppIds]);

  const recentChats = chatHistoryEnabled ? MOCK_CHATS.slice(0, 3) : [];

  const handleSend = useCallback(() => {
    const text = draft.trim();
    if (!text || !defaultApp) return;
    navigate(`/apps/${defaultApp.id}?prefill=${encodeURIComponent(text)}`);
  }, [draft, defaultApp, navigate]);

  const handleKeyDown = useCallback(
    e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  const logoSrc = uiConfig?.header?.logo?.url ? buildAssetUrl(uiConfig.header.logo.url) : null;

  return (
    <div className="min-h-full flex flex-col items-center justify-center px-6 py-12 bg-gray-50 dark:bg-gray-900">
      <div className="w-full max-w-2xl">
        {/* Logo + greeting */}
        <div className="flex flex-col items-center text-center mb-8">
          {logoSrc ? (
            <img src={logoSrc} alt="Logo" className="w-12 h-12 object-contain mb-4" />
          ) : (
            <div className="mb-4">
              <IHubLogo size={46} />
            </div>
          )}
          <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100 tracking-tight mb-2">
            {greeting}!
          </h1>
          <p className="text-base text-gray-500 dark:text-gray-400">
            {t('startPage.subtitle', 'How can I help you today?')}
          </p>
        </div>

        {/* Default chat input */}
        {defaultApp && (
          <div className="mb-8">
            <div className="flex items-center gap-2 mb-2">
              <span
                className="w-6 h-6 rounded-md flex items-center justify-center text-white text-xs flex-none"
                style={{ backgroundColor: defaultApp.color || '#4f46e5' }}
              >
                <Icon name={defaultApp.icon} size="sm" className="w-3.5 h-3.5" />
              </span>
              <span className="text-sm font-medium text-gray-500 dark:text-gray-400">
                {getLocalizedContent(defaultApp.name, currentLanguage)}
              </span>
            </div>
            <div className="border-2 border-indigo-500 dark:border-indigo-600 rounded-2xl bg-white dark:bg-gray-800 shadow-sm shadow-indigo-100 dark:shadow-none">
              <textarea
                ref={textareaRef}
                value={draft}
                onChange={e => setDraft(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={t('startPage.inputPlaceholder', 'Type your message here…')}
                rows={2}
                className="block w-full border-none outline-none resize-none px-5 py-4 text-[15px] leading-relaxed bg-transparent text-gray-900 dark:text-gray-100 placeholder-gray-400"
                style={{ minHeight: '64px' }}
              />
              <div className="flex items-center gap-1 px-4 pb-3">
                <button
                  className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                  title={t('chat.attachFile', 'Attach')}
                  onClick={() => navigate(`/apps/${defaultApp.id}`)}
                >
                  <Icon name="paperclip" size="sm" />
                </button>
                <button
                  className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                  title={t('sidebar.prompts', 'Prompts')}
                  onClick={() => navigate('/prompts')}
                >
                  <Icon name="sparkles" size="sm" />
                </button>
                <div className="ml-auto flex items-center gap-2">
                  <button
                    onClick={() => navigate(`/apps/${defaultApp.id}`)}
                    className="text-sm text-indigo-600 dark:text-indigo-400 font-medium hover:underline px-2 py-1"
                  >
                    {t('startPage.openApp', 'Open full app')}
                  </button>
                  <button
                    onClick={handleSend}
                    disabled={!draft.trim()}
                    title={t('common.send', 'Send')}
                    className="w-9 h-9 flex items-center justify-center rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors"
                  >
                    <Icon name="arrowUp" size="sm" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {appsLoading && !defaultApp && (
          <div className="flex justify-center mb-8">
            <LoadingSpinner message={t('app.loading')} />
          </div>
        )}

        {/* Jump into an app */}
        {featuredApps.length > 0 && (
          <div className="mb-7">
            <div className="flex items-center justify-between mb-3">
              <span className="text-[11px] font-bold tracking-widest uppercase text-gray-400">
                {t('startPage.jumpIntoApp', 'Jump into an app')}
              </span>
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
                      <span className="block font-semibold text-[14.5px] text-gray-900 dark:text-gray-100 truncate">
                        {name}
                      </span>
                      <span className="block text-[12.5px] text-gray-500 dark:text-gray-400 truncate">
                        {desc}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Pick up where you left off — feature flagged */}
        {chatHistoryEnabled && recentChats.length > 0 && (
          <div>
            <span className="text-[11px] font-bold tracking-widest uppercase text-gray-400 block mb-3">
              {t('startPage.pickUpWhereYouLeftOff', 'Pick up where you left off')}
            </span>
            <div className="flex flex-wrap gap-2">
              {recentChats.map(chat => (
                <button
                  key={chat.id}
                  onClick={() => navigate('/chats')}
                  className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-700 dark:text-gray-300 hover:border-gray-300 dark:hover:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700 transition-all max-w-xs"
                >
                  <span
                    className="w-5 h-5 rounded-md flex items-center justify-center flex-none text-white"
                    style={{ backgroundColor: chat.appColor || '#4f46e5' }}
                  >
                    <Icon name={chat.appIcon} size="sm" className="w-3 h-3" />
                  </span>
                  <span className="truncate">{chat.title}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
