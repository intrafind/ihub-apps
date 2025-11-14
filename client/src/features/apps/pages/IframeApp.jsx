import { useEffect, useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../../../utils/localizeContent';
import Icon from '../../../shared/components/Icon';
import { useUIConfig } from '../../../shared/contexts/UIConfigContext';

/**
 * IframeApp component
 * Handles iframe-type apps that embed external applications
 */
const IframeApp = ({ app }) => {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const { resetHeaderColor } = useUIConfig();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const iframeRef = useRef(null);

  // Reset header color on mount
  useEffect(() => {
    resetHeaderColor();
  }, [resetHeaderColor]);

  const iframeConfig = app.iframeConfig || {};
  const iframeUrl = iframeConfig.url || '';
  const allowFullscreen = iframeConfig.allowFullscreen !== false; // Default true
  const sandbox = iframeConfig.sandbox || ['allow-scripts', 'allow-same-origin', 'allow-forms'];

  const appName = getLocalizedContent(app.name, currentLanguage) || app.id;

  const handleIframeLoad = () => {
    setLoading(false);
    setError(null);
  };

  const handleIframeError = () => {
    setLoading(false);
    setError(t('pages.iframeApp.loadError'));
  };

  const handleReload = () => {
    if (iframeRef.current) {
      setLoading(true);
      setError(null);
      // Reload iframe by resetting src
      iframeRef.current.src = iframeUrl;
    }
  };

  const handleOpenInNewTab = () => {
    if (iframeUrl) {
      window.open(iframeUrl, '_blank', 'noopener,noreferrer');
    }
  };

  if (!iframeUrl) {
    return (
      <div className="container mx-auto px-4 py-8 max-w-2xl">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-lg p-8">
          <div className="text-center">
            <Icon name="exclamation-circle" className="h-12 w-12 text-red-500 mx-auto mb-4" />
            <h2 className="text-xl font-bold text-gray-900 dark:text-white mb-2">
              {t('common.error')}
            </h2>
            <p className="text-gray-600 dark:text-gray-300">
              No iframe URL configured for this app.
            </p>
            <button
              onClick={() => window.history.back()}
              className="mt-4 px-6 py-2 bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-900 dark:text-white font-medium rounded-md transition-colors"
            >
              {t('common.back')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)]">
      {/* Header Bar */}
      <div className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div
              className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0"
              style={{ backgroundColor: app.color || '#4F46E5' }}
            >
              <Icon name={app.icon || 'window'} className="text-white" />
            </div>
            <div>
              <h1 className="text-lg font-semibold text-gray-900 dark:text-white">{appName}</h1>
              <p className="text-sm text-gray-500 dark:text-gray-400 truncate max-w-md">
                {iframeUrl}
              </p>
            </div>
          </div>
          <div className="flex items-center space-x-2">
            <button
              onClick={handleReload}
              disabled={loading}
              className="p-2 text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white rounded-md hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors disabled:opacity-50"
              title={t('pages.iframeApp.reload')}
            >
              <Icon
                name="arrow-path"
                className={`h-5 w-5 ${loading ? 'animate-spin' : ''}`}
                aria-label={t('pages.iframeApp.reload')}
              />
            </button>
            <button
              onClick={handleOpenInNewTab}
              className="p-2 text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white rounded-md hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
              title={t('pages.iframeApp.openInNewTab')}
            >
              <Icon
                name="external-link"
                className="h-5 w-5"
                aria-label={t('pages.iframeApp.openInNewTab')}
              />
            </button>
            <button
              onClick={() => window.history.back()}
              className="p-2 text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white rounded-md hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
              title={t('common.back')}
            >
              <Icon name="x" className="h-5 w-5" aria-label={t('common.close')} />
            </button>
          </div>
        </div>
      </div>

      {/* Loading Overlay */}
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-white dark:bg-gray-900 bg-opacity-75 dark:bg-opacity-75 z-10">
          <div className="text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600 mx-auto mb-4"></div>
            <p className="text-gray-600 dark:text-gray-300">{t('pages.iframeApp.loading')}</p>
          </div>
        </div>
      )}

      {/* Error Message */}
      {error && (
        <div className="bg-red-50 dark:bg-red-900/20 border-l-4 border-red-500 p-4 m-4">
          <div className="flex items-center">
            <Icon name="exclamation-circle" className="h-5 w-5 text-red-500 mr-3" />
            <div>
              <p className="text-sm text-red-700 dark:text-red-300">{error}</p>
              <button
                onClick={handleReload}
                className="mt-2 text-sm text-red-700 dark:text-red-300 underline hover:no-underline"
              >
                {t('pages.iframeApp.reload')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Iframe Container */}
      <div className="flex-1 relative bg-gray-50 dark:bg-gray-900">
        <iframe
          ref={iframeRef}
          src={iframeUrl}
          className="w-full h-full border-0"
          onLoad={handleIframeLoad}
          onError={handleIframeError}
          sandbox={sandbox.join(' ')}
          allow={allowFullscreen ? 'fullscreen' : ''}
          allowFullScreen={allowFullscreen}
          title={appName}
        />
      </div>
    </div>
  );
};

export default IframeApp;
