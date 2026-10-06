import * as React from 'react';
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowsPointingOutIcon } from '@heroicons/react/24/outline';
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
import { useEmbeddedHost } from '../contexts/EmbeddedHostContext';
import useOfficeChatPersistence from '../hooks/useOfficeChatPersistence';
import { getStoredThemePreference } from '../utilities/officeTheme';
import { buildPopoutUrl, isPopoutSupported, openChatPopout } from '../utilities/officePopout';
import { popoutChatRouteState, seedPopoutTranscript } from '../utilities/officePopoutChat';
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
  getAccessToken,
  getRefreshToken,
  OFFICE_TOKEN_KEY,
  setOnSessionExpired
} from '../api/officeAuth';

export const OFFICE_USER_KEY = 'office_ihubuser';
export const OFFICE_APP_KEY = 'office_ihubselectedapp';

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

export function storeSelectedApp(app) {
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

/** Office's dialog errors a user can do something about. */
function describePopoutError(error, t) {
  const code = error?.code;
  if (code === 12009 || code === 12011) {
    return t(
      'office.popout.blocked',
      'The larger window was blocked. Allow pop-ups for Outlook and try again.'
    );
  }
  if (code === 12007) {
    return t('office.popout.alreadyOpen', 'The larger window is already open.');
  }
  return t('office.popout.failed', 'The larger window could not be opened.');
}

/**
 * What the pane shows while its chat is in the pop-out window. The pane has
 * to stay open meanwhile: the window reaches Outlook through it.
 */
function PopoutPlaceholder({ onBringBack }) {
  const { t } = useTranslation();
  return (
    <div className="office-task-pane h-screen w-full flex flex-col items-center justify-center gap-3 p-6 text-center bg-white dark:bg-slate-900">
      <ArrowsPointingOutIcon className="h-8 w-8 text-slate-400 dark:text-slate-500" aria-hidden />
      <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">
        {t('office.popout.openTitle', 'The chat is open in a larger window')}
      </p>
      <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">
        {t(
          'office.popout.keepPaneOpen',
          'Keep this pane open: the window reads and writes your emails through it. Pin the pane so it stays open when you select another email.'
        )}
      </p>
      <button
        type="button"
        onClick={onBringBack}
        className="mt-1 rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
      >
        {t('office.popout.bringBack', 'Show the chat here instead')}
      </button>
    </div>
  );
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
  // The popped-out chat (see officePopout.js) renders this same tree in an
  // Office dialog; its sign-in belongs to the pane behind it.
  const embeddedHost = useEmbeddedHost();
  const popoutChild = embeddedHost.popout?.role === 'child' ? embeddedHost.popout : null;
  // The pane side of the pop-out: whether the chat is out in the window right
  // now, the window's handle, and the chat as the window last reported it.
  const [popoutOpen, setPopoutOpen] = React.useState(false);
  const [popoutError, setPopoutError] = React.useState(null);
  const popoutRef = React.useRef(null);
  const popoutStateRef = React.useRef(null);
  // Set the moment the button is pressed, before Office answers: a second
  // press while the window opens must not start a second one.
  const popoutOpeningRef = React.useRef(false);
  // Bumped to mount the chat panel afresh when a chat comes back from the
  // window: the panel reads its chat only when it mounts.
  const [chatPanelKey, setChatPanelKey] = React.useState(0);
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
    // The popped-out chat refreshes through the pane, so the pane has signed
    // out already: hand the chat back and let the pane ask for a sign-in.
    if (popoutChild) {
      popoutChild.signedOut();
      return;
    }
    clearTokens();
    localStorage.removeItem(OFFICE_USER_KEY);
    storeSelectedApp(null);
    setAuthData(null);
    setSelectedApp(null);
    setSessionError('Your session has expired. Please log in again.');
    navigate('/', { replace: true });
    // After the tokens are gone, so the window's chat is not reopened.
    popoutRef.current?.close({ collect: false });
  }, [navigate, popoutChild]);

  React.useEffect(() => {
    setOnSessionExpired(handleSessionExpired);
    return () => setOnSessionExpired(null);
  }, [handleSessionExpired]);

  // Signed out (logout or an expired session): the next user must not see this
  // one's chats for as long as the list would otherwise be reused. Dropped from
  // an effect rather than the logout handler: by now the signed-in views are
  // unmounted, whereas invalidating under a mounted list refetches it on the
  // spot — without a token, and the 401 that earns reads as an expired session.
  React.useEffect(() => {
    if (!authData) invalidateChatsCache();
  }, [authData]);

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
    // One sign-in for both windows: signing out in the popped-out chat signs
    // the pane out, which closes the window.
    if (popoutChild) {
      popoutChild.signedOut();
      return;
    }
    clearTokens();
    localStorage.removeItem(OFFICE_USER_KEY);
    storeSelectedApp(null);
    setAuthData(null);
    setSelectedApp(null);
    setSessionError(null);
    navigate('/', { replace: true });
    popoutRef.current?.close({ collect: false });
  }, [navigate, popoutChild]);

  // A chat coming back from the pop-out window, as it was there.
  const resumeFromPopout = React.useCallback(
    state => {
      if (!state?.app) return;
      seedPopoutTranscript(state);
      storeSelectedApp(state.app);
      setSelectedApp(state.app);
      setChatPanelKey(key => key + 1);
      navigate(OFFICE_CHAT_PATH, { replace: true, state: popoutChatRouteState(state) });
    },
    [navigate]
  );

  // Pop the chat out (see officePopout.js). The panel stays until the window
  // is up — a window that does not open leaves the chat where it was — and
  // then gives way to the placeholder; the chat comes back when the window
  // closes, however it closes.
  const handlePopOut = React.useCallback(
    async chatState => {
      if (popoutRef.current || popoutOpeningRef.current) return;
      popoutOpeningRef.current = true;
      popoutStateRef.current = chatState;
      setPopoutError(null);
      try {
        popoutRef.current = await openChatPopout({
          url: buildPopoutUrl({ language: officeLocale, theme: getStoredThemePreference() }),
          // Read when the window asks — again after it reloads, so it then
          // gets the chat as it last reported it.
          getInit: () => ({
            config,
            user: authData?.user ?? null,
            tokens: { access_token: getAccessToken(), refresh_token: getRefreshToken() },
            chat: popoutStateRef.current
          }),
          onChatState: state => {
            popoutStateRef.current = { ...popoutStateRef.current, ...state };
          },
          onPinnedEmails: pinnedEmails => {
            popoutStateRef.current = { ...popoutStateRef.current, pinnedEmails };
          },
          onClosed: reason => {
            const last = popoutStateRef.current;
            popoutRef.current = null;
            popoutStateRef.current = null;
            setPopoutOpen(false);
            if (reason === 'signedOut') {
              handleLogout();
              return;
            }
            // Signed out while the window was open: nothing to go back to.
            if (!getAccessToken()) return;
            resumeFromPopout(last);
          }
        });
        setPopoutOpen(true);
      } catch (error) {
        popoutRef.current = null;
        popoutStateRef.current = null;
        setPopoutError(describePopoutError(error, t));
      } finally {
        popoutOpeningRef.current = false;
      }
    },
    [config, authData, handleLogout, resumeFromPopout, t]
  );
  const popoutSupported = !popoutChild && !!authData && isPopoutSupported();
  const panelPopout = React.useMemo(() => {
    if (popoutChild) return popoutChild;
    if (!popoutSupported) return null;
    return {
      role: 'pane',
      open: handlePopOut,
      error: popoutError,
      dismissError: () => setPopoutError(null)
    };
  }, [popoutChild, popoutSupported, handlePopOut, popoutError]);

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
      key={chatPanelKey}
      authData={authData}
      selectedApp={selectedApp}
      setSelectedApp={handleSetSelectedApp}
      onLogout={handleLogout}
      homePath={homePath}
      chatPersistence={historyEnabled}
      openChatId={location.state?.chatId ?? null}
      restoredChat={location.state?.restoredChat ?? null}
      popout={panelPopout}
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

  if (popoutOpen) {
    return <PopoutPlaceholder onBringBack={() => popoutRef.current?.close()} />;
  }

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
