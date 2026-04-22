import * as React from 'react';
import { officeLocale } from '../utilities/officeLocale';
import { useOfficeConfig } from '../contexts/OfficeConfigContext';

// Hardcoded bilingual strings — intentionally NOT using useTranslation() because
// i18n translations are loaded from the server, which is unreachable in offline mode.
const STRINGS = {
  en: {
    heading: 'Server Not Reachable',
    body: 'Please check your network connection and try again.',
    retry: 'Retry',
    checking: 'Checking connection...'
  },
  de: {
    heading: 'Server nicht erreichbar',
    body: 'Bitte überprüfen Sie Ihre Netzwerkverbindung und versuchen Sie es erneut.',
    retry: 'Erneut versuchen',
    checking: 'Verbindung wird geprüft...'
  }
};

const RETRY_INTERVAL_MS = 30_000;

function OfficeOfflineScreen({ onRetry }) {
  const config = useOfficeConfig();
  const t = STRINGS[officeLocale] ?? STRINGS.en;
  const [checking, setChecking] = React.useState(false);

  const checkConnection = React.useCallback(async () => {
    if (checking) return;
    setChecking(true);
    try {
      const res = await fetch(`${config.baseUrl}/api/integrations/office-addin/config`, {
        signal: AbortSignal.timeout(5000)
      });
      if (res.ok) {
        onRetry();
        return;
      }
    } catch {
      // still offline
    }
    setChecking(false);
  }, [checking, config.baseUrl, onRetry]);

  // Auto-retry when the browser reports it came back online.
  React.useEffect(() => {
    window.addEventListener('online', checkConnection);
    return () => window.removeEventListener('online', checkConnection);
  }, [checkConnection]);

  // Periodic background check every 30 seconds.
  React.useEffect(() => {
    const id = window.setInterval(checkConnection, RETRY_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [checkConnection]);

  return (
    <div className="h-screen w-full flex items-center justify-center bg-slate-50 p-6">
      <div className="bg-white border border-slate-200 rounded-xl p-8 max-w-xs w-full text-center shadow-sm">
        {/* Wifi-off icon */}
        <div className="flex justify-center mb-4 text-slate-300">
          <svg
            width="48"
            height="48"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <line x1="1" y1="1" x2="23" y2="23" />
            <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55" />
            <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39" />
            <path d="M10.71 5.05A16 16 0 0 1 22.56 9" />
            <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88" />
            <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
            <line x1="12" y1="20" x2="12.01" y2="20" />
          </svg>
        </div>

        <h2 className="text-base font-semibold text-slate-800 mb-2">{t.heading}</h2>
        <p className="text-sm text-slate-500 leading-relaxed mb-6">{t.body}</p>

        <button
          onClick={checkConnection}
          disabled={checking}
          className="w-full py-2.5 px-4 rounded-lg text-sm font-medium bg-blue-500 hover:bg-blue-600 disabled:bg-slate-300 disabled:cursor-not-allowed text-white transition-colors"
        >
          {checking ? t.checking : t.retry}
        </button>
      </div>
    </div>
  );
}

export default OfficeOfflineScreen;
