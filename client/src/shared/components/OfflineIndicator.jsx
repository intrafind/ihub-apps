import { useNetworkStatus, CONNECTION_STATES } from '../contexts/NetworkStatusContext';
import { useTranslation } from 'react-i18next';
import Icon from './Icon';

const OfflineIndicator = () => {
  const { connectionState, isRetrying, retryAttempts, retryConnection } = useNetworkStatus();
  const { t } = useTranslation();

  // Don't show anything when online
  if (connectionState === CONNECTION_STATES.ONLINE) {
    return null;
  }

  // Don't show during initial checking
  if (connectionState === CONNECTION_STATES.CHECKING && retryAttempts === 0) {
    return null;
  }

  const getIndicatorConfig = () => {
    switch (connectionState) {
      case CONNECTION_STATES.OFFLINE:
        return {
          icon: 'exclamation-triangle',
          bgColor: 'bg-gray-600',
          textColor: 'text-white',
          title: t('network.status.offline.title', 'You\'re offline'),
          message: t('network.status.offline.message', 'Check your internet connection'),
          showRetry: false
        };
      
      case CONNECTION_STATES.BACKEND_OFFLINE:
        return {
          icon: 'globe',
          bgColor: 'bg-orange-600',
          textColor: 'text-white',
          title: t('network.status.backend_offline.title', 'Server unavailable'),
          message: isRetrying 
            ? t('network.status.backend_offline.retrying', 'Attempting to reconnect...')
            : t('network.status.backend_offline.message', 'Unable to reach the server'),
          showRetry: !isRetrying
        };
      
      case CONNECTION_STATES.CHECKING:
        return {
          icon: 'refresh',
          bgColor: 'bg-blue-600',
          textColor: 'text-white',
          title: t('network.status.checking.title', 'Checking connection'),
          message: t('network.status.checking.message', 'Please wait...'),
          showRetry: false
        };
      
      default:
        return null;
    }
  };

  const config = getIndicatorConfig();
  if (!config) return null;

  return (
    <div className={`fixed top-0 left-0 right-0 z-50 ${config.bgColor} ${config.textColor} px-4 py-2 shadow-lg`}>
      <div className="flex items-center justify-between max-w-7xl mx-auto">
        <div className="flex items-center space-x-3">
          <Icon 
            name={config.icon} 
            className={`w-5 h-5 ${isRetrying || connectionState === CONNECTION_STATES.CHECKING ? 'animate-spin' : ''}`} 
          />
          <div className="flex-1">
            <p className="font-medium text-sm">{config.title}</p>
            <p className="text-xs opacity-90">{config.message}</p>
            {retryAttempts > 0 && connectionState === CONNECTION_STATES.BACKEND_OFFLINE && (
              <p className="text-xs opacity-75">
                {t('network.status.retry_attempt', 'Retry attempt {{count}}', { count: retryAttempts })}
              </p>
            )}
          </div>
        </div>
        
        {config.showRetry && (
          <button
            onClick={retryConnection}
            className="bg-white bg-opacity-20 hover:bg-opacity-30 transition-colors duration-200 px-3 py-1 rounded text-sm font-medium"
            disabled={isRetrying}
          >
            {t('network.actions.retry', 'Retry')}
          </button>
        )}
      </div>
    </div>
  );
};

export default OfflineIndicator;