import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';

export default function IntegrationCard({
  icon,
  iconBgClassName = 'bg-blue-600',
  connectButtonClassName = 'bg-blue-600 hover:bg-blue-700',
  title,
  description,
  connected,
  userInfo,
  tokenExpiring,
  features = [],
  connectLabel,
  onConnect,
  onDisconnect,
  extraActions
}) {
  const { t } = useTranslation();

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-6">
      <div className="flex items-start space-x-4">
        <div className="flex-shrink-0">
          <div
            className={`w-12 h-12 ${iconBgClassName} rounded-lg flex items-center justify-center`}
          >
            <Icon name={icon} className="w-7 h-7 text-white" />
          </div>
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{title}</h3>
              <p className="text-gray-600 dark:text-gray-400 text-sm">{description}</p>
            </div>

            <div className="flex items-center">
              <span
                className={`px-3 py-1 text-xs font-medium rounded-full ${
                  connected
                    ? 'bg-green-100 dark:bg-green-900/50 text-green-800 dark:text-green-300'
                    : 'bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-300'
                }`}
              >
                {connected
                  ? t('integrations.page.card.connected')
                  : t('integrations.page.card.notConnected')}
              </span>
            </div>
          </div>

          {connected && userInfo && (
            <div className="mt-3 p-3 bg-gray-50 dark:bg-gray-900/50 rounded-md">
              <div className="flex items-center text-sm text-gray-700 dark:text-gray-300">
                <Icon name="user" className="w-4 h-4 mr-2" />
                <span className="font-medium">{userInfo.displayName}</span>
                {userInfo.email && (
                  <span className="ml-2 text-gray-500 dark:text-gray-400">({userInfo.email})</span>
                )}
              </div>
              {tokenExpiring && (
                <div className="mt-2 flex items-center text-sm text-amber-600 dark:text-amber-400">
                  <Icon name="exclamationTriangle" className="w-4 h-4 mr-2" />
                  <span>{t('integrations.page.card.tokenExpiring')}</span>
                </div>
              )}
            </div>
          )}

          <div className="mt-4 flex items-center space-x-3">
            {connected ? (
              <>
                {extraActions}
                <button
                  onClick={onDisconnect}
                  className="bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-md font-medium transition-colors flex items-center"
                >
                  <Icon name="x-circle" className="w-4 h-4 mr-2" />
                  {t('integrations.page.card.disconnect')}
                </button>
              </>
            ) : (
              <button
                onClick={onConnect}
                className={`${connectButtonClassName} text-white px-4 py-2 rounded-md font-medium transition-colors flex items-center`}
              >
                <Icon name="link" className="w-4 h-4 mr-2" />
                {connectLabel}
              </button>
            )}
          </div>

          {connected && features.length > 0 && (
            <div className="mt-3">
              <h4 className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-2">
                {t('integrations.page.card.availableFeatures')}
              </h4>
              <ul className="text-sm text-gray-700 dark:text-gray-300 space-y-1">
                {features.map(feature => (
                  <li key={feature} className="flex items-center">
                    <Icon name="check" className="w-4 h-4 text-green-500 mr-2 flex-shrink-0" />
                    {feature}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
