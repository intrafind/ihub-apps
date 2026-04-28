import * as React from 'react';
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import OfficeLogin from './OfficeLogin';
import OfficeChatPanel from './OfficeChatPanel';
import ChatHeader from './chat/ChatHeader';
import SettingsDialog from './settings-dialog';
import AppListPanel from '../../../shared/components/AppListPanel';
import { officeLocale } from '../utilities/officeLocale';
import { getLocalizedContent } from '../../../utils/localizeContent';
import { useOfficeConfig } from '../contexts/OfficeConfigContext';
import { fetchApps } from '../../../api/api';
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

function SelectPage({ user, onLogout, onSelect }) {
  const [isSettingsOpen, setIsSettingsOpen] = React.useState(false);

  const menuItems = [
    { key: 'settings', label: 'Settings', onClick: () => setIsSettingsOpen(true) },
    { key: 'logout', label: 'Logout', onClick: onLogout }
  ];

  return (
    <div className="h-screen w-full flex flex-col p-0 bg-slate-50">
      <div className="flex-1 min-h-0 flex flex-col max-w-lg mx-auto w-full">
        <div className="flex flex-col h-full min-h-0 w-full overflow-hidden border border-[#e0e0e0] rounded-lg bg-white">
          <AppListPanel
            onSelect={onSelect}
            language={officeLocale}
            header={<ChatHeader title="Select App" showCheckmark={false} menuItems={menuItems} />}
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

const OfficeApp = ({ quickAction = null }) => {
  const config = useOfficeConfig();
  const navigate = useNavigate();
  const [authData, setAuthData] = React.useState(getStoredAuth);
  const [selectedApp, setSelectedApp] = React.useState(getStoredSelectedApp);
  const [sessionError, setSessionError] = React.useState(null);

  const pendingQuickActionRef = React.useRef(quickAction);
  const [pendingPrompt, setPendingPrompt] = React.useState(() =>
    quickAction ? getLocalizedContent(quickAction.prompt, officeLocale) || null : null
  );

  const handleSessionExpired = React.useCallback(() => {
    clearTokens();
    localStorage.removeItem(OFFICE_USER_KEY);
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

  const applyPendingQuickAction = React.useCallback(async () => {
    const qa = pendingQuickActionRef.current;
    if (!qa?.appId) return false;
    try {
      const apps = await fetchApps();
      const app = Array.isArray(apps) ? apps.find(a => a.id === qa.appId) : null;
      if (app) {
        setSelectedApp(app);
        storeSelectedApp(app);
        pendingQuickActionRef.current = null;
        navigate('/chat', { replace: true });
        return true;
      }
    } catch {
      // ignore
    }
    pendingQuickActionRef.current = null;
    return false;
  }, [navigate]);

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

      const applied = await applyPendingQuickAction();
      if (!applied) {
        navigate('/select', { replace: true });
      }
    },
    [config, navigate, applyPendingQuickAction]
  );

  const handleLogout = React.useCallback(() => {
    clearTokens();
    localStorage.removeItem(OFFICE_USER_KEY);
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
      navigate('/chat', { replace: true });
    },
    [navigate]
  );

  const handleSetSelectedApp = React.useCallback(app => {
    storeSelectedApp(app);
    setSelectedApp(app);
  }, []);

  React.useEffect(() => {
    if (!authData) return;
    if (!selectedApp) {
      applyPendingQuickAction().then(applied => {
        if (!applied) navigate('/select', { replace: true });
      });
    }
    // eslint-disable-next-line @eslint-react/exhaustive-deps
  }, []);

  React.useEffect(() => {
    if (!sessionError) return undefined;
    const id = window.setTimeout(() => setSessionError(null), 5000);
    return () => window.clearTimeout(id);
  }, [sessionError]);

  return (
    <Routes>
      <Route
        path="/"
        element={
          authData && !selectedApp ? (
            <SelectPage user={authData.user} onLogout={handleLogout} onSelect={handleAppSelect} />
          ) : authData ? (
            <OfficeChatPanel
              authData={authData}
              selectedApp={selectedApp}
              setSelectedApp={handleSetSelectedApp}
              onLogout={handleLogout}
              initialPrompt={pendingPrompt}
              onInitialPromptConsumed={() => setPendingPrompt(null)}
            />
          ) : (
            <OfficeLogin onSuccess={handleLoginSuccess} initialError={sessionError} />
          )
        }
      />
      <Route
        path="/select"
        element={
          authData ? (
            <SelectPage user={authData.user} onLogout={handleLogout} onSelect={handleAppSelect} />
          ) : (
            <Navigate to="/" replace />
          )
        }
      />
      <Route
        path="/chat"
        element={
          authData && selectedApp ? (
            <OfficeChatPanel
              authData={authData}
              selectedApp={selectedApp}
              setSelectedApp={handleSetSelectedApp}
              onLogout={handleLogout}
              initialPrompt={pendingPrompt}
              onInitialPromptConsumed={() => setPendingPrompt(null)}
            />
          ) : (
            <Navigate to="/" replace />
          )
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
};

export default OfficeApp;
