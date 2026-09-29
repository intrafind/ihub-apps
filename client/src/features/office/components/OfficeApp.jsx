import * as React from 'react';
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import OfficeLogin from './OfficeLogin';
import OfficeChatPanel from './OfficeChatPanel';
import OfficeStartPage from './OfficeStartPage';
import OfficeChatHistoryPage from './chat-history';
import ChatHeader from './chat/ChatHeader';
import './OfficeChatPanel.css';
import SettingsDialog from './settings-dialog';
import AppListPanel from '../../../shared/components/AppListPanel';
import { officeLocale } from '../utilities/officeLocale';
import { useOfficeFavoriteApps } from '../utilities/officeFavorites';
import { useOfficeConfig } from '../contexts/OfficeConfigContext';
import useOfficeChatPersistence from '../hooks/useOfficeChatPersistence';
import {
  OFFICE_APPS_PAGE_PATH,
  OFFICE_CHAT_PATH,
  OFFICE_HISTORY_PATH,
  OFFICE_START_PAGE_PATH,
  resolveOfficeHomePath
} from '../utilities/officeStartPage';
import { setPendingChatStart } from '../../chat/startChatHandoff';
import { invalidateChatsCache } from '../../../shared/hooks/chatListStore';
import {
  storeTokenResponse,
  clearTokens,
  fetchUserInfo,
  OFFICE_TOKEN_KEY,
  setOnSessionExpired
} from '../api/officeAuth';

const OFFICE_USER_KEY = 'office_ihubuser';
const OFFICE_APP_KEY = 'office_ihubselectedapp';

function getStoredAuth() {
  try {
    const token = localStorage.getItem(OFFICE_TOKEN_KEY);
    if (!token) return null;
    const stored = localStorage.getItem(OFFICE_USER_KEY);
    const user = stored ? JSON.parse(stored) : null;
    return { user: user ?? null };
  } catch {
    return null;
  }
}

function getStoredSelectedApp() {
  try {
    const stored = sessionStorage.getItem(OFFICE_APP_KEY);
    return stored ? JSON.parse(stored) : null;
  } catch {
    return null;
  }
}

function storeSelectedApp(app) {
  try {
    if (app) {
      sessionStorage.setItem(OFFICE_APP_KEY, JSON.stringify(app));
    } else {
      sessionStorage.removeItem(OFFICE_APP_KEY);
    }
  } catch {
    // ignore
  }
}

/**
 * Holds a view back until the pane knows whether chats are stored server-side
 * — a fraction of a second after sign-in.
 */
function PaneLoading() {
  const { t } = useTranslation();
  return (
    <div
      className="office-task-pane h-screen w-full flex items-center justify-center gap-2 bg-white text-sm text-slate-500 dark:bg-slate-900 dark:text-slate-400"
      role="status"
    >
      <span
        className="h-4 w-4 rounded-full border-2 border-slate-300 border-t-slate-700 animate-spin dark:border-slate-600 dark:border-t-slate-300"
        aria-hidden
      />
      {t('pages.appsList.loading', 'Loading…')}
    </div>
  );
}

/**
 * The full apps list. `onBack` is set when the start page is the pane's home,
 * so the list — reached through the start page's "All apps" link — offers a
 * way back; when the list itself is home there is nowhere to go back to.
 * `onOpenHistory` is set while chats are stored server-side.
 */
function SelectPage({ user, onLogout, onSelect, onBack, onOpenHistory }) {
  const { t } = useTranslation();
  const [isSettingsOpen, setIsSettingsOpen] = React.useState(false);
  const { favorites, toggleFavorite } = useOfficeFavoriteApps();

  const menuItems = [
    ...(onOpenHistory
      ? [
          {
            key: 'history',
            label: t('office.menu.history', 'Chat history'),
            onClick: onOpenHistory
          }
        ]
      : []),
    {
      key: 'settings',
      label: t('office.menu.settings', 'Settings'),
      onClick: () => setIsSettingsOpen(true)
    },
    { key: 'logout', label: t('office.menu.logout', 'Logout'), onClick: onLogout }
  ];

  const handleToggleFavorite = React.useCallback(
    (_event, appId) => {
      toggleFavorite(appId);
    },
    [toggleFavorite]
  );

  return (
    <div className="office-task-pane h-screen w-full flex flex-col p-0 bg-slate-50 dark:bg-slate-900">
      <div className="flex-1 min-h-0 flex flex-col w-full">
        <div className="flex flex-col h-full min-h-0 w-full overflow-hidden bg-white dark:bg-slate-900">
          <AppListPanel
            onSelect={onSelect}
            language={officeLocale}
            header={
              <ChatHeader
                title={t('office.selectApp.title', 'Select App')}
                showCheckmark={false}
                menuItems={menuItems}
                onBackClick={onBack}
                backLabel={t('office.startPage.backToStart', 'Back to start page')}
              />
            }
            favorites={favorites}
            onToggleFavorite={handleToggleFavorite}
          />
        </div>
      </div>
      <SettingsDialog
        user={user}
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
      />
    </div>
  );
}

const OfficeApp = () => {
  const { t } = useTranslation();
  const config = useOfficeConfig();
  const navigate = useNavigate();
  const location = useLocation();
  const [authData, setAuthData] = React.useState(getStoredAuth);
  const [selectedApp, setSelectedApp] = React.useState(getStoredSelectedApp);
  const [sessionError, setSessionError] = React.useState(null);
  // Durable chats: with them on, the pane's chats are stored like the web
  // app's, and the history lists both.
  const chatPersistence = useOfficeChatPersistence(!!authData);
  const historyEnabled = chatPersistence.persistence;

  // Where a signed-in user with no app open lands — the start page or the
  // apps list, per Admin → Office Integration → Start Page. Every view keeps
  // its own route; this only decides which one "home" is.
  const homePath = resolveOfficeHomePath(config);
  const startPageIsHome = homePath === OFFICE_START_PAGE_PATH;

  const handleSessionExpired = React.useCallback(() => {
    clearTokens();
    localStorage.removeItem(OFFICE_USER_KEY);
    invalidateChatsCache();
    storeSelectedApp(null);
    setAuthData(null);
    setSelectedApp(null);
    setSessionError('Your session has expired. Please log in again.');
    navigate('/', { replace: true });
  }, [navigate]);

  React.useEffect(() => {
    setOnSessionExpired(handleSessionExpired);
    return () => setOnSessionExpired(null);
  }, [handleSessionExpired]);

  const handleLoginSuccess = React.useCallback(
    async data => {
      storeTokenResponse(data);

      let user = null;
      try {
        user = await fetchUserInfo(config);
        localStorage.setItem(OFFICE_USER_KEY, JSON.stringify(user));
      } catch {
        // Userinfo fetch failed — continue without a display name.
      }

      setAuthData({ user });
      setSessionError(null);
      navigate(homePath, { replace: true });
    },
    [config, navigate, homePath]
  );

  const handleLogout = React.useCallback(() => {
    clearTokens();
    localStorage.removeItem(OFFICE_USER_KEY);
    // The next user must not see this one's chats for as long as the list
    // would otherwise be reused.
    invalidateChatsCache();
    storeSelectedApp(null);
    setAuthData(null);
    setSelectedApp(null);
    setSessionError(null);
    navigate('/', { replace: true });
  }, [navigate]);

  const handleAppSelect = React.useCallback(
    app => {
      storeSelectedApp(app);
      setSelectedApp(app);
      navigate(OFFICE_CHAT_PATH, { replace: true });
    },
    [navigate]
  );

  // Start page → chat with a prepared message. The text, the collected
  // emails and the edited email context travel through the in-memory handoff
  // (they cannot go through a route), and the chat panel sends them the
  // moment it is ready — so the app opens exactly as if the user had typed
  // and sent inside it. Issue #2368.
  const handleStartChat = React.useCallback(
    ({ app, ...start }) => {
      setPendingChatStart({ appId: app.id, ...start });
      storeSelectedApp(app);
      setSelectedApp(app);
      navigate(OFFICE_CHAT_PATH, { replace: true });
    },
    [navigate]
  );

  const handleSetSelectedApp = React.useCallback(app => {
    storeSelectedApp(app);
    setSelectedApp(app);
  }, []);

  // The history remembers which chat it was opened from, so its back button
  // can return there instead of to the home page.
  const handleOpenHistory = React.useCallback(
    ({ returnChatId } = {}) => {
      navigate(OFFICE_HISTORY_PATH, {
        state: returnChatId !== undefined ? { returnChatId } : null
      });
    },
    [navigate]
  );

  // History → a stored chat. The chat id travels as route state: the panel
  // opens that chat instead of a new one and loads its transcript from the
  // store. Its app becomes the selected app, as picking the app would.
  const handleOpenChat = React.useCallback(
    ({ chat, app }) => {
      storeSelectedApp(app);
      setSelectedApp(app);
      navigate(OFFICE_CHAT_PATH, { replace: true, state: { chatId: chat.id } });
    },
    [navigate]
  );

  // Opened from a chat, back returns to it (or to a new chat of the same app
  // when nothing was sent in it); opened from anywhere else, back goes home.
  const historyState = location.state;
  const historyFromChat = !!selectedApp && !!historyState && 'returnChatId' in historyState;
  const handleHistoryBack = React.useCallback(() => {
    if (historyFromChat) {
      navigate(OFFICE_CHAT_PATH, {
        replace: true,
        state: historyState.returnChatId ? { chatId: historyState.returnChatId } : null
      });
    } else {
      navigate(homePath, { replace: true });
    }
  }, [historyFromChat, historyState, navigate, homePath]);

  React.useEffect(() => {
    if (!sessionError) return undefined;
    const id = window.setTimeout(() => setSessionError(null), 5000);
    return () => window.clearTimeout(id);
  }, [sessionError]);

  // Mounted only once the chat mode is known: whether a chat is stored decides
  // how its transcript is kept, and switching that mid-chat would drop it.
  const chatPanel = chatPersistence.resolving ? (
    <PaneLoading />
  ) : (
    <OfficeChatPanel
      authData={authData}
      selectedApp={selectedApp}
      setSelectedApp={handleSetSelectedApp}
      onLogout={handleLogout}
      homePath={homePath}
      chatPersistence={historyEnabled}
      openChatId={location.state?.chatId ?? null}
      onOpenHistory={historyEnabled ? handleOpenHistory : undefined}
    />
  );

  const startPage = (
    <OfficeStartPage
      user={authData?.user}
      onLogout={handleLogout}
      onSelectApp={handleAppSelect}
      onStartChat={handleStartChat}
      onBrowseApps={() => navigate(OFFICE_APPS_PAGE_PATH)}
      chatHistoryEnabled={historyEnabled}
      onOpenHistory={historyEnabled ? () => handleOpenHistory() : undefined}
      onOpenChat={handleOpenChat}
    />
  );

  const selectPage = (
    <SelectPage
      user={authData?.user}
      onLogout={handleLogout}
      onSelect={handleAppSelect}
      onBack={
        startPageIsHome ? () => navigate(OFFICE_START_PAGE_PATH, { replace: true }) : undefined
      }
      onOpenHistory={historyEnabled ? () => handleOpenHistory() : undefined}
    />
  );

  const historyPage = chatPersistence.resolving ? (
    <PaneLoading />
  ) : historyEnabled ? (
    <OfficeChatHistoryPage
      user={authData?.user}
      onLogout={handleLogout}
      onOpenChat={handleOpenChat}
      onBack={handleHistoryBack}
      backLabel={
        historyFromChat
          ? t('office.history.backToChat', 'Back to chat')
          : startPageIsHome
            ? t('office.startPage.backToStart', 'Back to start page')
            : t('office.startPage.backToApps', 'Back to app selection')
      }
    />
  ) : (
    // Durable chats are off (or were turned off): there is no history.
    <Navigate to={homePath} replace />
  );

  return (
    <Routes>
      <Route
        path="/"
        element={
          !authData ? (
            <OfficeLogin onSuccess={handleLoginSuccess} initialError={sessionError} />
          ) : selectedApp ? (
            // An app left open in this session (the pane reloads when Outlook
            // re-renders it) stays open.
            chatPanel
          ) : (
            <Navigate to={homePath} replace />
          )
        }
      />
      <Route
        path={OFFICE_START_PAGE_PATH}
        element={authData ? startPage : <Navigate to="/" replace />}
      />
      <Route
        path={OFFICE_APPS_PAGE_PATH}
        element={authData ? selectPage : <Navigate to="/" replace />}
      />
      <Route
        path={OFFICE_CHAT_PATH}
        element={authData && selectedApp ? chatPanel : <Navigate to="/" replace />}
      />
      <Route
        path={OFFICE_HISTORY_PATH}
        element={authData ? historyPage : <Navigate to="/" replace />}
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
};

export default OfficeApp;
