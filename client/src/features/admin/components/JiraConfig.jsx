import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { makeAdminApiCall } from '../../../api/adminApi';

const JiraConfig = () => {
  const { t } = useTranslation();
  const [config, setConfig] = useState({
    enabled: false,
    baseUrl: '',
    clientId: '',
    clientSecret: '',
    redirectUri: ''
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  // Fetch current Jira configuration on mount
  useEffect(() => {
    const fetchJiraConfig = async () => {
      try {
        const response = await makeAdminApiCall('/admin/configs/platform', {
          method: 'GET'
        });
        const jira = response.data.jira || {
          enabled: false,
          baseUrl: '',
          clientId: '',
          clientSecret: '',
          redirectUri: ''
        };
        setConfig(jira);
        setMessage('');
      } catch (error) {
        setMessage({
          type: 'error',
          text: error.message || t('admin.jira.loadError', 'Failed to load Jira configuration')
        });
      } finally {
        setLoading(false);
      }
    };

    fetchJiraConfig();
  }, [t]);

  const handleToggleEnabled = e => {
    setConfig(prev => ({
      ...prev,
      enabled: e.target.checked
    }));
  };

  const handleFieldChange = (field, value) => {
    setConfig(prev => ({
      ...prev,
      [field]: value
    }));
  };

  const handleSave = async () => {
    setSaving(true);
    setMessage('');

    try {
      // Get current platform config
      const response = await makeAdminApiCall('/admin/configs/platform', {
        method: 'GET'
      });

      // Update only the jira section
      const updatedPlatformConfig = {
        ...response.data,
        jira: config
      };

      // Save the updated platform config
      await makeAdminApiCall('/admin/configs/platform', {
        method: 'POST',
        data: updatedPlatformConfig
      });

      setMessage({
        type: 'success',
        text: t('admin.jira.saveSuccess', 'Jira configuration saved successfully')
      });
    } catch (error) {
      setMessage({
        type: 'error',
        text: error.message || t('admin.jira.saveError', 'Failed to save Jira configuration')
      });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-6">
        <div className="flex items-center justify-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-6">
      <div className="flex items-start space-x-4">
        <div className="flex-shrink-0 mt-1">
          <div className="p-3 rounded-full bg-blue-100 dark:bg-blue-900/50">
            <Icon name="ticket" size="lg" className="text-blue-600 dark:text-blue-400" />
          </div>
        </div>
        <div className="flex-1">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">
            {t('admin.jira.title', 'Jira Integration')}
          </h3>
          <p className="text-gray-600 dark:text-gray-400 mb-4">
            {t(
              'admin.jira.subtitle',
              'Configure Atlassian Jira OAuth credentials for ticket management integration.'
            )}
          </p>

          {/* Info Card */}
          <div className="bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-800 rounded-md p-4 mb-4">
            <div className="flex">
              <Icon name="info" size="md" className="text-blue-500 mt-0.5 mr-3" />
              <div>
                <h4 className="text-sm font-medium text-blue-800 dark:text-blue-200">
                  {t('admin.jira.info.title', 'Atlassian Cloud OAuth 2.0')}
                </h4>
                <p className="text-sm text-blue-700 dark:text-blue-300 mt-1">
                  {t(
                    'admin.jira.info.description',
                    'Create an OAuth 2.0 (3LO) app in your Atlassian Developer Console to obtain the Client ID and Secret. Set the redirect URI to match your deployment URL.'
                  )}
                </p>
              </div>
            </div>
          </div>

          {/* Enable/Disable Toggle */}
          <div className="flex items-center mb-6">
            <input
              type="checkbox"
              id="jiraEnabled"
              checked={config.enabled}
              onChange={handleToggleEnabled}
              className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 dark:border-gray-600 rounded"
            />
            <label htmlFor="jiraEnabled" className="ml-2 block text-sm text-gray-900 dark:text-gray-100">
              {config.enabled
                ? t('admin.jira.enabled', 'Jira integration enabled')
                : t('admin.jira.disabled', 'Jira integration disabled')}
            </label>
          </div>

          {/* Configuration Fields */}
          {config.enabled && (
            <div className="space-y-4 mb-6">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  {t('admin.jira.baseUrl', 'Jira Site URL')}
                </label>
                <input
                  type="url"
                  value={config.baseUrl}
                  onChange={e => handleFieldChange('baseUrl', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
                  placeholder="https://your-company.atlassian.net"
                />
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {t('admin.jira.baseUrlHelp', 'Your Atlassian Cloud site URL (for reference)')}
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  {t('admin.jira.clientId', 'Client ID')} *
                </label>
                <input
                  type="text"
                  value={config.clientId}
                  onChange={e => handleFieldChange('clientId', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
                  placeholder="your-oauth-client-id"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  {t('admin.jira.clientSecret', 'Client Secret')} *
                </label>
                <input
                  type="password"
                  value={config.clientSecret}
                  onChange={e => handleFieldChange('clientSecret', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
                  placeholder="your-oauth-client-secret"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  {t('admin.jira.redirectUri', 'Redirect URI')}
                </label>
                <input
                  type="url"
                  value={config.redirectUri}
                  onChange={e => handleFieldChange('redirectUri', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
                  placeholder="https://your-app.com/api/integrations/jira/callback"
                />
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {t(
                    'admin.jira.redirectUriHelp',
                    'Must match the callback URL registered in your Atlassian OAuth app'
                  )}
                </p>
              </div>
            </div>
          )}

          {/* Messages */}
          {message && (
            <div
              className={`p-4 rounded-md mb-4 ${
                message.type === 'success'
                  ? 'bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-800'
                  : 'bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800'
              }`}
            >
              <div className="flex">
                <Icon
                  name={message.type === 'success' ? 'check' : 'warning'}
                  size="md"
                  className={`mt-0.5 mr-3 ${
                    message.type === 'success' ? 'text-green-500' : 'text-red-500'
                  }`}
                />
                <p
                  className={`text-sm ${
                    message.type === 'success' ? 'text-green-700 dark:text-green-300' : 'text-red-700 dark:text-red-300'
                  }`}
                >
                  {message.text}
                </p>
              </div>
            </div>
          )}

          {/* Save Button */}
          <button
            onClick={handleSave}
            disabled={saving}
            className={`
              inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium
              rounded-md shadow-sm text-white
              ${
                saving
                  ? 'bg-gray-400 cursor-not-allowed'
                  : 'bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500'
              }
            `}
          >
            {saving ? (
              <>
                <svg
                  className="animate-spin -ml-1 mr-3 h-4 w-4 text-white"
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  ></circle>
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  ></path>
                </svg>
                {t('admin.jira.saving', 'Saving...')}
              </>
            ) : (
              <>
                <Icon name="save" size="md" className="mr-2" />
                {t('admin.jira.save', 'Save Jira Configuration')}
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

export default JiraConfig;
