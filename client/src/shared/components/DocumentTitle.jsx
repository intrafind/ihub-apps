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
  const { i18n } = useTranslation();
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

    let title = 'AI Hub Apps'; // Default fallback

    // Use the configurable title if available
    if (uiConfig?.title) {
      const localizedTitle = getLocalizedContent(uiConfig.title, currentLanguage);
      if (localizedTitle) {
        title = localizedTitle;
      }
    }

    // If we're on an app page and have app data, append the app name
    if (isAppPage && currentApp) {
      const appName = getLocalizedContent(currentApp.name, currentLanguage) || currentApp.id;
      if (appName) {
        title = `${title} - ${appName}`;
      }
    }

    document.title = title;
  }, [uiConfig, currentLanguage, isAppPage, currentApp, isLoading]);

  // This component doesn't render anything visible
  return null;
};

export default DocumentTitle;
