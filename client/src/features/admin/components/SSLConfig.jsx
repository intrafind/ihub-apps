import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { makeAdminApiCall } from '../../../api/adminApi';

const SSLConfig = () => {
  const { t } = useTranslation();
  const [config, setConfig] = useState({
    ignoreInvalidCertificates: false,
    domainWhitelist: []
  });
  const [newDomain, setNewDomain] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  // Fetch current SSL configuration on mount
  useEffect(() => {
    const fetchSSLConfig = async () => {
      try {
        const response = await makeAdminApiCall('/admin/configs/platform', {
          method: 'GET'
        });
        const sslConfig = response.data?.ssl || {
          ignoreInvalidCertificates: false,
          domainWhitelist: []
        };
        // Ensure domainWhitelist is always an array for backward compatibility
        setConfig({
          ignoreInvalidCertificates: sslConfig.ignoreInvalidCertificates || false,
          domainWhitelist: Array.isArray(sslConfig.domainWhitelist) ? sslConfig.domainWhitelist : []
        });
        setMessage('');
      } catch (error) {
        setMessage({
          type: 'error',
          text: error.message || t('admin.system.ssl.configSaveError')
        });
      } finally {
        setLoading(false);
      }
    };

    fetchSSLConfig();
  }, [t]);

  const handleToggleIgnoreCerts = e => {
    setConfig(prev => ({
      ...prev,
      ignoreInvalidCertificates: e.target.checked
    }));
  };

  const handleAddDomain = () => {
    if (!newDomain.trim()) return;

    // Basic validation for domain format
    const domain = newDomain.trim();
    const whitelist = config.domainWhitelist || [];
    if (!whitelist.includes(domain)) {
      setConfig(prev => ({
        ...prev,
        domainWhitelist: [...(prev.domainWhitelist || []), domain]
      }));
      setNewDomain('');
    }
  };

  const handleRemoveDomain = domainToRemove => {
    setConfig(prev => ({
      ...prev,
      domainWhitelist: (prev.domainWhitelist || []).filter(d => d !== domainToRemove)
    }));
  };

  const handleSaveConfig = async () => {
    setSaving(true);
    setMessage('');

    try {
      // Get the full platform config first
      const currentConfigResponse = await makeAdminApiCall('/admin/configs/platform', {
        method: 'GET'
      });

      // Update only the SSL section
      const updatedConfig = {
        ...currentConfigResponse.data,
        ssl: config
      };

      // Save the updated config
      await makeAdminApiCall('/admin/configs/platform', {
        method: 'PUT',
        data: updatedConfig
      });

      setMessage({
        type: 'success',
        text: t('admin.system.ssl.configSaved')
      });
    } catch (error) {
      setMessage({
        type: 'error',
        text: error.message || t('admin.system.ssl.configSaveError')
      });
    } finally {
      setSaving(false);
    }
  };

  const handleKeyPress = e => {
    if (e.key === 'Enter') {
      handleAddDomain();
    }
  };

  if (loading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
        <h2 className="text-xl font-semibold mb-4 text-gray-900 dark:text-gray-100">
          {t('admin.system.ssl.title')}
        </h2>
        <p className="text-gray-600 dark:text-gray-400">{t('common.loading', 'Loading...')}</p>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
      <div className="flex items-start mb-4">
        <Icon name="ShieldCheckIcon" className="w-6 h-6 mr-2 text-blue-500 flex-shrink-0" />
        <div>
          <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
            {t('admin.system.ssl.title')}
          </h2>
          <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
            {t('admin.system.ssl.description')}
          </p>
        </div>
      </div>

      {/* Security Warning */}
      <div className="mb-6 p-4 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg">
        <div className="flex">
          <Icon
            name="ExclamationTriangleIcon"
            className="w-5 h-5 text-yellow-600 dark:text-yellow-400 mt-0.5 mr-3 flex-shrink-0"
          />
          <div>
            <h4 className="text-sm font-medium text-yellow-800 dark:text-yellow-300">
              {t('admin.system.ssl.securityWarning')}
            </h4>
            <p className="text-sm text-yellow-700 dark:text-yellow-400 mt-1">
              {t('admin.system.ssl.securityWarningDesc')}
            </p>
          </div>
        </div>
      </div>

      {/* Message Display */}
      {message && (
        <div
          className={`p-4 rounded-md mb-4 ${
            message.type === 'success'
              ? 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800'
              : 'bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800'
          }`}
        >
          <div className="flex">
            <Icon
              name={message.type === 'success' ? 'CheckCircleIcon' : 'ExclamationCircleIcon'}
              className={`w-5 h-5 mt-0.5 mr-3 ${
                message.type === 'success'
                  ? 'text-green-500 dark:text-green-400'
                  : 'text-red-500 dark:text-red-400'
              }`}
            />
            <p
              className={`text-sm ${
                message.type === 'success'
                  ? 'text-green-700 dark:text-green-300'
                  : 'text-red-700 dark:text-red-300'
              }`}
            >
              {message.text}
            </p>
          </div>
        </div>
      )}

      {/* Ignore Invalid Certificates Toggle */}
      <div className="mb-6 p-4 bg-gray-50 dark:bg-gray-700 rounded-lg">
        <div className="flex items-start">
          <div className="flex-1">
            <label
              htmlFor="ignoreInvalidCerts"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              {t('admin.system.ssl.ignoreInvalidCertificates')}
            </label>
            <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
              {t('admin.system.ssl.ignoreInvalidCertificatesDesc')}
            </p>
          </div>
          <div className="ml-4">
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                id="ignoreInvalidCerts"
                checked={config.ignoreInvalidCertificates}
                onChange={handleToggleIgnoreCerts}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 dark:peer-focus:ring-blue-800 rounded-full peer dark:bg-gray-600 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-blue-600"></div>
            </label>
          </div>
        </div>
      </div>

      {/* Domain Whitelist */}
      {config.ignoreInvalidCertificates && (
        <div className="mb-6">
          <h3 className="text-md font-semibold text-gray-900 dark:text-gray-100 mb-2">
            {t('admin.system.ssl.domainWhitelist')}
          </h3>
          <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
            {t('admin.system.ssl.domainWhitelistDesc')}
          </p>

          {/* Info message if whitelist is empty - this is now the secure default */}
          {config.domainWhitelist && config.domainWhitelist.length === 0 && (
            <div className="mb-4 p-4 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
              <div className="flex">
                <Icon
                  name="InformationCircleIcon"
                  className="w-5 h-5 text-blue-600 dark:text-blue-400 mt-0.5 mr-3 flex-shrink-0"
                />
                <p className="text-sm text-blue-700 dark:text-blue-300">
                  {t('admin.system.ssl.globalWarning')}
                </p>
              </div>
            </div>
          )}

          {/* Add Domain Input */}
          <div className="flex gap-2 mb-4">
            <input
              type="text"
              value={newDomain}
              onChange={e => setNewDomain(e.target.value)}
              onKeyPress={handleKeyPress}
              placeholder={t('admin.system.ssl.domainWhitelistPlaceholder')}
              className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 dark:bg-gray-700 dark:text-gray-100 text-sm"
            />
            <button
              onClick={handleAddDomain}
              disabled={!newDomain.trim()}
              className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:bg-gray-400 disabled:cursor-not-allowed"
            >
              <Icon name="PlusIcon" className="w-4 h-4 mr-1" />
              {t('admin.system.ssl.addDomain')}
            </button>
          </div>

          {/* Domain Pattern Help */}
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
            {t('admin.system.ssl.domainPatternHelp')}
          </p>

          {/* Domain List */}
          {config.domainWhitelist && config.domainWhitelist.length > 0 ? (
            <div className="space-y-2">
              {config.domainWhitelist.map((domain, index) => (
                <div
                  key={index}
                  className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-700 rounded-md"
                >
                  <div className="flex items-center">
                    <Icon
                      name="GlobeAltIcon"
                      className="w-4 h-4 text-gray-500 dark:text-gray-400 mr-2"
                    />
                    <span className="text-sm text-gray-900 dark:text-gray-100">{domain}</span>
                  </div>
                  <button
                    onClick={() => handleRemoveDomain(domain)}
                    className="text-red-600 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300 text-sm font-medium"
                  >
                    {t('admin.system.ssl.removeDomain')}
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="p-4 bg-gray-50 dark:bg-gray-700 rounded-md text-center">
              <p className="text-sm text-gray-600 dark:text-gray-400">
                {t('admin.system.ssl.noDomains')}
              </p>
            </div>
          )}
        </div>
      )}

      {/* Save Button */}
      <div className="flex justify-end">
        <button
          onClick={handleSaveConfig}
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
              {t('admin.system.ssl.savingConfig')}
            </>
          ) : (
            <>
              <Icon name="CheckIcon" className="w-4 h-4 mr-2" />
              {t('admin.system.ssl.saveConfig')}
            </>
          )}
        </button>
      </div>
    </div>
  );
};

export default SSLConfig;
