import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../Icon';

/**
 * Generic Integration Connection Card Component
 * Displays when OAuth integration authentication is required
 */
const IntegrationConnectionCard = ({
  integration,
  config,
  state = {},
  onConnect,
  className = ''
}) => {
  const { t, i18n } = useTranslation();
  const [isExpanded, setIsExpanded] = useState(false);
  const currentLang = i18n.language?.split('-')[0] || 'en';

  if (!integration || !config) return null;

  const handleConnect = () => {
    if (onConnect) {
      onConnect(integration);
    } else {
      // Direct OAuth initiation if no custom handler
      window.location.href = config.authUrl;
    }
  };

  const description = config.description?.[currentLang] || config.description?.en || '';
  const features = config.features?.[currentLang] || config.features?.en || [];

  return (
    <div
      className={`bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-lg p-4 mb-4 shadow-sm ${className}`}
    >
      <div className="flex items-start space-x-3">
        <div className="flex-shrink-0">
          <div className="w-10 h-10 bg-blue-600 rounded-lg flex items-center justify-center">
            <Icon name={config.icon || 'link'} className="w-6 h-6 text-white" />
          </div>
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-gray-900">
              {t(`integrations.${integration}.connectionRequired`, `Connect to ${config.name}`)}
            </h3>
            {features.length > 0 && (
              <button
                onClick={() => setIsExpanded(!isExpanded)}
                className="text-blue-600 hover:text-blue-700 p-1"
                title={isExpanded ? 'Collapse' : 'Learn more'}
              >
                <Icon name={isExpanded ? 'chevron-up' : 'chevron-down'} className="w-5 h-5" />
              </button>
            )}
          </div>

          <p className="text-sm text-gray-600 mt-1">
            {description ||
              t(
                `integrations.${integration}.connectionDescription`,
                `Link your ${config.name} account to access additional features.`
              )}
          </p>

          {isExpanded && features.length > 0 && (
            <div className="mt-3 p-3 bg-blue-50 rounded-md">
              <h4 className="text-sm font-medium text-gray-900 mb-2">
                {t(
                  `integrations.${integration}.whatCanYouDo`,
                  `What you can do with ${config.name} integration:`
                )}
              </h4>
              <ul className="text-sm text-gray-700 space-y-1">
                {features.map((feature, index) => (
                  <li key={index} className="flex items-center">
                    <Icon name="check" className="w-4 h-4 text-green-500 mr-2 flex-shrink-0" />
                    {feature}
                  </li>
                ))}
              </ul>

              <div className="mt-3 p-2 bg-yellow-50 rounded border-l-4 border-yellow-400">
                <p className="text-sm text-yellow-800">
                  <Icon name="lock" className="w-4 h-4 inline mr-1" />
                  {t(
                    `integrations.${integration}.securityNote`,
                    'Secure OAuth connection - you control your permissions and can disconnect anytime.'
                  )}
                </p>
              </div>
            </div>
          )}

          {state.error && (
            <div className="mt-3 p-2 bg-red-50 border border-red-200 rounded text-sm text-red-700">
              <Icon name="warning" className="w-4 h-4 inline mr-1" />
              {state.error}
            </div>
          )}
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between">
        <div className="flex items-center text-sm text-gray-500">
          <Icon name="info" className="w-4 h-4 mr-1" />
          {t(
            `integrations.${integration}.redirectNote`,
            `You'll be redirected to ${config.name} to authorize access`
          )}
        </div>

        <button
          onClick={handleConnect}
          disabled={state.connecting}
          className="bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white px-6 py-2 rounded-md font-medium transition-colors flex items-center"
        >
          {state.connecting ? (
            <>
              <Icon name="spinner" className="w-4 h-4 mr-2 animate-spin" />
              {t(`integrations.${integration}.connecting`, 'Connecting...')}
            </>
          ) : (
            <>
              <Icon name="link" className="w-4 h-4 mr-2" />
              {t(`integrations.${integration}.connect`, `Connect ${config.name} Account`)}
            </>
          )}
        </button>
      </div>
    </div>
  );
};

export default IntegrationConnectionCard;
