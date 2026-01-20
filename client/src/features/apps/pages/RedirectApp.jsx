import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../../../utils/localizeContent';
import Icon from '../../../shared/components/Icon';
import { useUIConfig } from '../../../shared/contexts/UIConfigContext';

/**
 * RedirectApp component
 * Handles redirect-type apps that navigate to external URLs
 */
const RedirectApp = ({ app }) => {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const { resetHeaderColor } = useUIConfig();
  const [redirecting, setRedirecting] = useState(false);

  // Reset header color on mount
  useEffect(() => {
    resetHeaderColor();
  }, [resetHeaderColor]);

  const redirectConfig = app.redirectConfig || {};
  const redirectUrl = redirectConfig.url || '';
  const openInNewTab = redirectConfig.openInNewTab !== false; // Default true
  const showWarning = redirectConfig.showWarning !== false; // Default true

  const appName = getLocalizedContent(app.name, currentLanguage) || app.id;
  const appDescription = getLocalizedContent(app.description, currentLanguage) || '';

  const handleRedirect = () => {
    if (!redirectUrl) {
      console.error('No redirect URL configured for app:', app.id);
      return;
    }

    setRedirecting(true);

    if (openInNewTab) {
      // Open in new tab
      window.open(redirectUrl, '_blank', 'noopener,noreferrer');
      // Reset state after a brief delay
      setTimeout(() => setRedirecting(false), 1000);
    } else {
      // Navigate in same window
      window.location.href = redirectUrl;
    }
  };

  // Auto-redirect if warning is disabled
  useEffect(() => {
    if (!showWarning && redirectUrl) {
      handleRedirect();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showWarning, redirectUrl]);

  return (
    <div className="container mx-auto px-4 py-8 max-w-2xl">
      {!showWarning && redirecting ? (
        // Simple loading state when warning is disabled
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-lg p-8">
          <div className="flex flex-col items-center justify-center min-h-[400px]">
            <div className="animate-spin rounded-full h-16 w-16 border-b-2 border-indigo-600 mb-4"></div>
            <p className="text-lg text-gray-700 dark:text-gray-300">
              {openInNewTab
                ? t('pages.redirectApp.openingInNewTab')
                : t('pages.redirectApp.redirecting')}
            </p>
          </div>
        </div>
      ) : (
        // Full warning page when warning is enabled
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-lg p-8">
          {/* App Icon and Title */}
          <div className="flex flex-col items-center mb-6">
            <div
              className="w-20 h-20 rounded-full flex items-center justify-center mb-4"
              style={{ backgroundColor: app.color || '#4F46E5' }}
            >
              <Icon name={app.icon || 'external-link'} size="2xl" className="text-white" />
            </div>
            <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-2">{appName}</h1>
            {appDescription && (
              <p className="text-gray-600 dark:text-gray-300 text-center">{appDescription}</p>
            )}
          </div>

          {/* Warning Message */}
          <div className="bg-yellow-50 dark:bg-yellow-900/20 border-l-4 border-yellow-400 p-4 mb-6">
            <div className="flex">
              <div className="flex-shrink-0">
                <Icon name="exclamation-triangle" className="h-5 w-5 text-yellow-400" />
              </div>
              <div className="ml-3">
                <p className="text-sm text-yellow-700 dark:text-yellow-300">
                  {t('pages.redirectApp.warning')}
                </p>
              </div>
            </div>
          </div>

          {/* Redirect URL Display */}
          <div className="mb-6">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              {t('pages.redirectApp.externalSite')}
            </label>
            <div className="flex items-center p-3 bg-gray-100 dark:bg-gray-700 rounded-md">
              <Icon name="link" className="h-5 w-5 text-gray-500 dark:text-gray-400 mr-2" />
              <span className="text-sm text-gray-900 dark:text-white break-all">{redirectUrl}</span>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex flex-col sm:flex-row gap-3">
            <button
              onClick={handleRedirect}
              disabled={redirecting || !redirectUrl}
              className="flex-1 flex items-center justify-center px-6 py-3 bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-400 text-white font-medium rounded-md transition-colors"
            >
              {redirecting ? (
                <>
                  <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white mr-2"></div>
                  {openInNewTab
                    ? t('pages.redirectApp.openingInNewTab')
                    : t('pages.redirectApp.redirecting')}
                </>
              ) : (
                <>
                  <Icon name="external-link" className="h-5 w-5 mr-2" />
                  {t('pages.redirectApp.continueButton', { appName })}
                </>
              )}
            </button>
            <button
              onClick={() => window.history.back()}
              className="flex-1 flex items-center justify-center px-6 py-3 bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-900 dark:text-white font-medium rounded-md transition-colors"
            >
              <Icon name="arrow-left" className="h-5 w-5 mr-2" />
              {t('common.back')}
            </button>
          </div>

          {/* Additional Info */}
          {openInNewTab && (
            <div className="mt-4 text-center text-sm text-gray-500 dark:text-gray-400">
              <Icon name="information-circle" className="inline h-4 w-4 mr-1" aria-hidden="true" />
              {t('pages.redirectApp.openingInNewTab')}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default RedirectApp;
