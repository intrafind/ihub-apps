import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../../shared/contexts/AuthContext';
import { useUIConfig } from '../../../shared/contexts/UIConfigContext';
import useFeatureFlags from '../../../shared/hooks/useFeatureFlags';
import Icon from '../../../shared/components/Icon';
import { fetchApps, fetchAppDetails, fetchModels } from '../../../api/api';
import { createFavoriteItemHelpers } from '../../../utils/favoriteItems';
import { getLocalizedContent } from '../../../utils/localizeContent';
import { filterModelsForApp, pickInitialModelForApp } from '../../../utils/modelFiltering';
import { useTranslation } from 'react-i18next';
import { MOCK_CHATS } from '../../chat/data/mockChats';
import LoadingSpinner from '../../../shared/components/LoadingSpinner';
import { buildAssetUrl } from '../../../utils/runtimeBasePath';
import ChatInput from '../../chat/components/ChatInput';
import useFileUploadHandler from '../../../shared/hooks/useFileUploadHandler';
import useVoiceCommands from '../../voice/hooks/useVoiceCommands';
import { setPendingChatStart } from '../../chat/startChatHandoff';

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
  const { user, isAuthenticated } = useAuth();
  const { uiConfig } = useUIConfig();
  const featureFlags = useFeatureFlags();
  const navigate = useNavigate();

  const [apps, setApps] = useState([]);
  const [appsLoading, setAppsLoading] = useState(true);
  const [favoriteAppIds, setFavoriteAppIds] = useState(() => getFavoriteApps());
  const [draft, setDraft] = useState('');
  const [defaultAppDetails, setDefaultAppDetails] = useState(null);
  const [models, setModels] = useState([]);
  const [selectedModel, setSelectedModel] = useState(null);

  const inputRef = useRef(null);
  const formRef = useRef(null);
  const fileUploadHandler = useFileUploadHandler();

  const chatHistoryEnabled = featureFlags.isEnabled('chatHistory', false);

  // Admins can hide the start-page chat input entirely.
  const showDefaultApp = uiConfig?.startPage?.showDefaultApp !== false;

  // Voice dictation handler — writes the transcript into the draft, mirroring
  // the in-app chat behaviour.
  const { handleVoiceInput, handleVoiceCommand } = useVoiceCommands({
    setInput: setDraft,
    currentText: draft,
    sendMessage: () => formRef.current?.requestSubmit?.()
  });

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
    // Reload when the authenticated user changes so apps reflect the new
    // permissions right after login/logout (no manual refresh needed).
  }, [isAuthenticated, user?.id]);

  // Keep favorites fresh when toggled elsewhere
  useEffect(() => {
    const handleFavoritesChanged = e => {
      if (e?.detail?.storageKey && e.detail.storageKey !== 'ihub_favorite_apps') return;
      setFavoriteAppIds(getFavoriteApps());
    };
    window.addEventListener('ihub:favorites-changed', handleFavoritesChanged);
    return () => window.removeEventListener('ihub:favorites-changed', handleFavoritesChanged);
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

  // Load the full default-app config so the chat input renders exactly what the
  // app is configured for (uploads, input mode, placeholder, etc.).
  useEffect(() => {
    if (!defaultApp?.id) {
      setDefaultAppDetails(null);
      return;
    }
    let mounted = true;
    fetchAppDetails(defaultApp.id)
      .then(details => {
        if (mounted && details) setDefaultAppDetails(details);
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, [defaultApp?.id]);

  // Load models so the start-page input can offer the model selector when the
  // app allows it (mirrors the in-app chat).
  useEffect(() => {
    let mounted = true;
    fetchModels()
      .then(data => {
        if (mounted && Array.isArray(data)) setModels(data);
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, []);

  // Models the default app is actually allowed to use.
  const compatibleModels = useMemo(
    () => (defaultAppDetails ? filterModelsForApp(models, defaultAppDetails) : []),
    [models, defaultAppDetails]
  );

  // Pick an initial model once the app + models are available.
  useEffect(() => {
    if (!defaultAppDetails || compatibleModels.length === 0) return;
    setSelectedModel(prev => {
      if (prev && compatibleModels.some(m => m.id === prev)) return prev;
      return pickInitialModelForApp(compatibleModels, defaultAppDetails) || compatibleModels[0].id;
    });
  }, [defaultAppDetails, compatibleModels]);

  const showModelSelector =
    defaultAppDetails?.disallowModelSelection !== true &&
    defaultAppDetails?.settings?.model?.enabled !== false &&
    compatibleModels.length > 0;

  const micEnabled =
    (defaultAppDetails?.inputMode?.microphone?.enabled ??
      defaultAppDetails?.microphone?.enabled) !== false;

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

  const uploadConfig = useMemo(
    () =>
      defaultAppDetails ? fileUploadHandler.createUploadConfig(defaultAppDetails, null) : undefined,
    [defaultAppDetails, fileUploadHandler]
  );

  // Start the chat: carry the message via prefill+send (so refresh/shared links
  // work) and hand off any attachment payload through the in-memory bridge.
  const handleSubmit = useCallback(
    e => {
      if (e?.preventDefault) e.preventDefault();
      if (!defaultApp) return;
      const text = draft.trim();
      const hasFile = fileUploadHandler.selectedFile != null;
      if (!text && !hasFile && !defaultAppDetails?.allowEmptyContent) return;

      if (hasFile) {
        setPendingChatStart({ appId: defaultApp.id, files: fileUploadHandler.selectedFile });
      }

      const params = new URLSearchParams();
      if (text) {
        params.set('prefill', text);
        params.set('send', 'true');
      }
      // Carry the chosen model so the app starts with the same selection.
      if (selectedModel && selectedModel !== defaultAppDetails?.preferredModel) {
        params.set('model', selectedModel);
      }
      const qs = params.toString();
      navigate(`/apps/${defaultApp.id}${qs ? `?${qs}` : ''}`);
    },
    [draft, defaultApp, defaultAppDetails, fileUploadHandler, navigate, selectedModel]
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

        {/* Default chat input — renders the real app input (uploads, prompts,
            placeholder, input mode) and starts the chat on submit. */}
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

            {defaultAppDetails ? (
              <ChatInput
                app={defaultAppDetails}
                value={draft}
                onChange={e => setDraft(e.target.value)}
                onSubmit={handleSubmit}
                isProcessing={false}
                onCancel={() => {}}
                inputRef={inputRef}
                formRef={formRef}
                uploadConfig={uploadConfig}
                onFileSelect={fileUploadHandler.handleFileSelect}
                selectedFile={fileUploadHandler.selectedFile}
                showUploader={fileUploadHandler.showUploader}
                onToggleUploader={fileUploadHandler.toggleUploader}
                allowEmptySubmit={
                  defaultAppDetails?.allowEmptyContent || fileUploadHandler.selectedFile !== null
                }
                onVoiceInput={micEnabled ? handleVoiceInput : undefined}
                onVoiceCommand={micEnabled ? handleVoiceCommand : undefined}
                models={compatibleModels}
                selectedModel={selectedModel}
                onModelChange={setSelectedModel}
                showModelSelector={showModelSelector}
                currentLanguage={currentLanguage}
              />
            ) : (
              <div className="flex justify-center py-6 border border-gray-200 dark:border-gray-700 rounded-2xl bg-white dark:bg-gray-800">
                <LoadingSpinner message={t('app.loading')} />
              </div>
            )}
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
