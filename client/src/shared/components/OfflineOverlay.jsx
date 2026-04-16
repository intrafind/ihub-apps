import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNetworkStatus } from '../hooks/useNetworkStatus';

function WifiOffIcon({ className }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      {/* Wifi arcs */}
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M8.288 15.038a5.25 5.25 0 017.424 0M5.106 11.856c3.807-3.808 9.98-3.808 13.788 0M1.924 8.674c5.565-5.565 14.587-5.565 20.152 0"
      />
      {/* Center dot */}
      <circle cx="12" cy="18" r="1.5" fill="currentColor" stroke="none" />
      {/* Slash line */}
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 3l18 18" strokeWidth={2} />
    </svg>
  );
}

export default function OfflineOverlay() {
  const { t } = useTranslation();
  const { isOnline, retryCount } = useNetworkStatus();
  const [showReconnected, setShowReconnected] = useState(false);
  const [wasOffline, setWasOffline] = useState(false);

  useEffect(() => {
    if (!isOnline) {
      setWasOffline(true);
    } else if (wasOffline) {
      // Just reconnected — show brief toast then reload to get fresh assets
      setShowReconnected(true);
      const timer = setTimeout(() => {
        setShowReconnected(false);
        setWasOffline(false);
        window.location.reload();
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, [isOnline, wasOffline]);

  // Reconnected toast
  if (showReconnected) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 dark:bg-black/50">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl p-6 text-center">
          <div className="text-green-500 text-4xl mb-2">&#10003;</div>
          <p className="text-gray-800 dark:text-gray-200 font-medium">
            {t('network.reconnected', 'Connection restored')}
          </p>
        </div>
      </div>
    );
  }

  if (isOnline) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 dark:bg-black/60 backdrop-blur-sm">
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl p-8 max-w-md mx-4 text-center">
        <WifiOffIcon className="w-16 h-16 mx-auto text-red-500 mb-4" />

        <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100 mb-2">
          {t('network.offline.title', 'Server Unreachable')}
        </h2>

        <p className="text-gray-600 dark:text-gray-400 mb-6">
          {t(
            'network.offline.description',
            'The connection to the server was lost. This usually happens when the VPN disconnects. Trying to reconnect...'
          )}
        </p>

        <div className="flex items-center justify-center mb-6 text-sm text-gray-500 dark:text-gray-400">
          <div className="animate-spin rounded-full h-4 w-4 border-2 border-indigo-600 border-t-transparent mr-2" />
          {t('network.offline.reconnecting', 'Reconnecting... (attempt {{count}})', {
            count: retryCount
          })}
        </div>

        <button
          onClick={() => window.location.reload()}
          className="w-full bg-indigo-600 hover:bg-indigo-700 text-white py-2 px-4 rounded transition-colors"
        >
          {t('network.offline.reloadPage', 'Reload Page')}
        </button>
      </div>
    </div>
  );
}
