import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { fetchAppDetails } from '../../../api/api';
import LoadingSpinner from '../../../shared/components/LoadingSpinner';
import { useTranslation } from 'react-i18next';
import AppChat from '../pages/AppChat';
import RedirectApp from '../pages/RedirectApp';
import IframeApp from '../pages/IframeApp';

/**
 * AppRouterWrapper component
 * Routes to the appropriate component based on the app type
 */
const AppRouterWrapper = () => {
  const { appId } = useParams();
  const { t } = useTranslation();
  const [app, setApp] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const loadApp = async () => {
      try {
        setLoading(true);
        setError(null);
        const appData = await fetchAppDetails(appId);
        setApp(appData);
      } catch (err) {
        console.error('Error loading app:', err);
        setError(err.message || t('app.error'));
      } finally {
        setLoading(false);
      }
    };

    if (appId) {
      loadApp();
    }
  }, [appId, t]);

  if (loading) {
    return (
      <div className="min-h-[60vh] flex flex-col items-center justify-center">
        <LoadingSpinner message={t('app.loading')} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-12">
        <div className="text-red-500 mb-4">{error}</div>
        <button
          className="bg-indigo-600 text-white px-4 py-2 rounded hover:bg-indigo-700"
          onClick={() => window.location.reload()}
        >
          {t('app.retry')}
        </button>
      </div>
    );
  }

  if (!app) {
    return (
      <div className="text-center py-12">
        <div className="text-red-500 mb-4">{t('pages.notFound.title')}</div>
      </div>
    );
  }

  // Route to appropriate component based on app type
  const appType = app.type || 'chat'; // Default to chat for backward compatibility

  switch (appType) {
    case 'redirect':
      return <RedirectApp app={app} />;
    case 'iframe':
      return <IframeApp app={app} />;
    case 'chat':
    default:
      // Render the existing AppChat component for chat type
      // Pass the app data as a prop to avoid re-fetching
      return <AppChat preloadedApp={app} />;
  }
};

export default AppRouterWrapper;
