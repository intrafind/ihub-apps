import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';
import { useUIConfig } from '../contexts/UIConfigContext';
import { getLocalizedContent } from '../../utils/localizeContent';
import { fetchAppDetails } from '../../api/api';

/**
 * DocumentTitle component manages the browser tab title dynamically
 * based on UI configuration, current language, and current page/app
 */
const DocumentTitle = () => {
  const { i18n, t } = useTranslation();
  const { uiConfig, isLoading } = useUIConfig();
  const location = useLocation();
  const currentLanguage = i18n.language || 'en';
  const [currentApp, setCurrentApp] = useState(null);

  // Check if we're on an app page and extract appId manually
  const isAppPage = location.pathname.startsWith('/apps/');
  const appId = isAppPage ? location.pathname.split('/apps/')[1]?.split('/')[0] : null;

  // Fetch app details when we're on an app page
  useEffect(() => {
    if (isAppPage && appId) {
      fetchAppDetails(appId)
        .then(appData => {
          setCurrentApp(appData);
        })
        .catch(() => {
          setCurrentApp(null);
        });
    } else {
      setCurrentApp(null);
    }
  }, [isAppPage, appId]);

  useEffect(() => {
    // Don't update title if UI config is still loading
    if (isLoading) {
      console.log('📍 DocumentTitle: Skipping update, UI config still loading');
      return;
    }

    // Get base app name from config
    let baseAppName = 'iHub Apps'; // Default fallback
    if (uiConfig?.title) {
      const localizedTitle = getLocalizedContent(uiConfig.title, currentLanguage);
      if (localizedTitle) {
        baseAppName = localizedTitle;
      }
    }

    // Determine page-specific prefix based on route
    let pagePrefix = '';
    const pathname = location.pathname;

    if (pathname.startsWith('/admin')) {
      // Admin routes
      pagePrefix = t('documentTitle.admin', 'Admin');
    } else if (pathname.startsWith('/settings')) {
      // Settings routes
      pagePrefix = t('documentTitle.settings', 'Settings');
    } else if (pathname.startsWith('/workflows')) {
      // Workflows routes
      pagePrefix = t('documentTitle.workflows', 'Workflows');
    } else if (pathname.startsWith('/prompts')) {
      // Prompts routes
      pagePrefix = t('documentTitle.prompts', 'Prompts');
    } else if (isAppPage && currentApp) {
      // App-specific page
      const appName = getLocalizedContent(currentApp.name, currentLanguage) || currentApp.id;
      pagePrefix = appName;
    }

    // Construct final title
    const title = pagePrefix ? `${pagePrefix} | ${baseAppName}` : baseAppName;

    document.title = title;
  }, [uiConfig, currentLanguage, isAppPage, currentApp, isLoading, location.pathname, t]);

  // This component doesn't render anything visible
  return null;
};

export default DocumentTitle;
