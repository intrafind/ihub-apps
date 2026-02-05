import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import AdminAuth from '../components/AdminAuth';
import AdminNavigation from '../components/AdminNavigation';
import { makeAdminApiCall } from '../../../api/adminApi';

const AdminLoggingPage = () => {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [loggingConfig, setLoggingConfig] = useState({
    level: 'info',
    format: 'json',
    file: {
      enabled: false,
      path: 'logs/app.log',
      maxSize: 10485760,
      maxFiles: 5
    },
    components: {
      enabled: false,
      filter: []
    },
    metadata: {
      includeTimestamp: true,
      includeComponent: true,
      includeLevel: true
    }
  });
  const [authDebugConfig, setAuthDebugConfig] = useState({
    enabled: false,
    maskTokens: true,
    redactPasswords: true,
    consoleLogging: false,
    includeRawData: false,
    providers: {
      oidc: { enabled: true },
      local: { enabled: true },
      proxy: { enabled: true },
      ldap: { enabled: true },
      ntlm: { enabled: true }
    }
  });

  const availableLevels = ['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly'];
  const availableComponents = [
    'Server',
    'ChatService',
    'AuthService',
    'ConfigCache',
    'ApiKeyVerifier',
    'ToolExecutor',
    'Version',
    'DataRoutes',
    'AdminRoutes'
  ];

  useEffect(() => {
    loadConfiguration();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadConfiguration = async () => {
    try {
      setLoading(true);
      // Load logging config
      const loggingResponse = await makeAdminApiCall('/admin/logging/config', {
        method: 'GET'
      });
      setLoggingConfig(prevConfig => ({
        ...prevConfig,
        ...loggingResponse.data
      }));

      // Load platform config for authDebug
      const platformResponse = await makeAdminApiCall('/admin/configs/platform', {
        method: 'GET'
      });
      if (platformResponse.data?.authDebug) {
        setAuthDebugConfig(platformResponse.data.authDebug);
      }

      setMessage('');
    } catch (error) {
      setMessage({
        type: 'error',
        text: error.message || t('admin.logging.loadError', 'Failed to load logging configuration')
      });
    } finally {
      setLoading(false);
    }
  };

  const handleSaveLoggingConfig = async () => {
    try {
      setSaving(true);
      setMessage('');

      await makeAdminApiCall('/admin/logging/config', {
        method: 'PUT',
        data: loggingConfig
      });

      setMessage({
        type: 'success',
        text: t('admin.logging.saveSuccess', 'Logging configuration saved successfully')
      });
    } catch (error) {
      setMessage({
        type: 'error',
        text: error.message || t('admin.logging.saveError', 'Failed to save logging configuration')
      });
    } finally {
      setSaving(false);
    }
  };

  const handleSaveAuthDebugConfig = async () => {
    try {
      setSaving(true);
      setMessage('');

      // Load current platform config
      const platformResponse = await makeAdminApiCall('/admin/configs/platform', {
        method: 'GET'
      });
      const platformConfig = platformResponse.data;

      // Update authDebug section
      platformConfig.authDebug = authDebugConfig;

      // Save back
      await makeAdminApiCall('/admin/configs/platform', {
        method: 'POST',
        data: platformConfig
      });

      setMessage({
        type: 'success',
        text: t(
          'admin.logging.authDebugSaveSuccess',
          'Authentication debug configuration saved successfully'
        )
      });
    } catch (error) {
      setMessage({
        type: 'error',
        text:
          error.message ||
          t('admin.logging.authDebugSaveError', 'Failed to save authentication debug configuration')
      });
    } finally {
      setSaving(false);
    }
  };

  const handleLevelChange = newLevel => {
    setLoggingConfig(prev => ({ ...prev, level: newLevel }));
  };

  const handleFormatChange = newFormat => {
    setLoggingConfig(prev => ({ ...prev, format: newFormat }));
  };

  const handleComponentToggle = component => {
    setLoggingConfig(prev => {
      const currentFilter = prev.components?.filter || [];
      const newFilter = currentFilter.includes(component)
        ? currentFilter.filter(c => c !== component)
        : [...currentFilter, component];
      return {
        ...prev,
        components: {
          ...prev.components,
          filter: newFilter
        }
      };
    });
  };

  if (loading) {
    return (
      <AdminAuth>
        <AdminNavigation />
        <div className="min-h-screen bg-gray-50 dark:bg-gray-900 p-6">
          <div className="max-w-6xl mx-auto">
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
              <p className="text-gray-600 dark:text-gray-400">
                {t('common.loading', 'Loading...')}
              </p>
            </div>
          </div>
        </div>
      </AdminAuth>
    );
  }

  return (
    <AdminAuth>
      <AdminNavigation />
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900 p-6">
        <div className="max-w-6xl mx-auto space-y-6">
          {/* Header */}
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
            <div className="flex items-start mb-2">
              <Icon
                name="AdjustmentsHorizontalIcon"
                className="w-8 h-8 mr-3 text-blue-500 flex-shrink-0"
              />
              <div>
                <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
                  {t('admin.logging.title', 'Logging Configuration')}
                </h1>
                <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                  {t(
                    'admin.logging.description',
                    'Configure logging levels, components, metadata, and debug settings'
                  )}
                </p>
              </div>
            </div>
          </div>

          {/* Status Message */}
          {message && (
            <div
              className={`p-4 rounded-lg ${
                message.type === 'success'
                  ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300'
                  : 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300'
              }`}
            >
              <div className="flex items-start">
                <Icon
                  name={message.type === 'success' ? 'CheckCircleIcon' : 'ExclamationCircleIcon'}
                  className="w-5 h-5 mr-2 flex-shrink-0"
                />
                <p className="text-sm">{message.text}</p>
              </div>
            </div>
          )}

          {/* Log Level Configuration */}
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
            <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-4 flex items-center">
              <Icon name="AdjustmentsVerticalIcon" className="w-5 h-5 mr-2 text-blue-500" />
              {t('admin.logging.levelSection', 'Log Level')}
            </h2>

            {/* Current Level Display */}
            <div className="mb-6 p-4 bg-gray-50 dark:bg-gray-700 rounded-lg">
              <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                {t('admin.logging.currentLevel', 'Current Level')}:
              </p>
              <p className="text-lg font-bold text-blue-600 dark:text-blue-400">
                {loggingConfig.level}
              </p>
            </div>

            {/* Level Selector */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
              {availableLevels.map(level => (
                <button
                  key={level}
                  onClick={() => handleLevelChange(level)}
                  disabled={loggingConfig.level === level}
                  className={`
                    p-3 rounded-lg border-2 text-left transition-all
                    ${
                      loggingConfig.level === level
                        ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                        : 'border-gray-200 dark:border-gray-600 hover:border-blue-300 dark:hover:border-blue-500'
                    }
                    disabled:cursor-not-allowed cursor-pointer
                  `}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-semibold text-gray-900 dark:text-gray-100 capitalize">
                      {level}
                    </span>
                    {loggingConfig.level === level && (
                      <Icon name="CheckCircleIcon" className="w-5 h-5 text-blue-500" />
                    )}
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Log Format Configuration */}
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
            <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-4 flex items-center">
              <Icon name="DocumentTextIcon" className="w-5 h-5 mr-2 text-blue-500" />
              {t('admin.logging.formatSection', 'Log Format')}
            </h2>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {['json', 'text'].map(format => (
                <button
                  key={format}
                  onClick={() => handleFormatChange(format)}
                  disabled={loggingConfig.format === format}
                  className={`
                    p-4 rounded-lg border-2 text-left transition-all
                    ${
                      loggingConfig.format === format
                        ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                        : 'border-gray-200 dark:border-gray-600 hover:border-blue-300 dark:hover:border-blue-500'
                    }
                    disabled:cursor-not-allowed cursor-pointer
                  `}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-semibold text-gray-900 dark:text-gray-100 capitalize">
                      {format}
                    </span>
                    {loggingConfig.format === format && (
                      <Icon name="CheckCircleIcon" className="w-5 h-5 text-blue-500" />
                    )}
                  </div>
                  <p className="text-xs text-gray-600 dark:text-gray-400">
                    {format === 'json'
                      ? t('admin.logging.jsonDescription', 'Structured JSON logging')
                      : t('admin.logging.textDescription', 'Human-readable text format')}
                  </p>
                </button>
              ))}
            </div>
          </div>

          {/* Component Filtering */}
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
            <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-4 flex items-center">
              <Icon name="FunnelIcon" className="w-5 h-5 mr-2 text-blue-500" />
              {t('admin.logging.componentSection', 'Component Filtering')}
            </h2>

            <div className="mb-4">
              <label className="flex items-center">
                <input
                  type="checkbox"
                  checked={loggingConfig.components?.enabled || false}
                  onChange={e =>
                    setLoggingConfig(prev => ({
                      ...prev,
                      components: { ...prev.components, enabled: e.target.checked }
                    }))
                  }
                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="ml-2 text-sm text-gray-700 dark:text-gray-300">
                  {t('admin.logging.enableComponentFilter', 'Enable component filtering')}
                </span>
              </label>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 ml-6">
                {t(
                  'admin.logging.componentFilterHelp',
                  'When enabled, only logs from selected components will be shown'
                )}
              </p>
            </div>

            {loggingConfig.components?.enabled && (
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
                {availableComponents.map(component => (
                  <label key={component} className="flex items-center">
                    <input
                      type="checkbox"
                      checked={loggingConfig.components?.filter?.includes(component) || false}
                      onChange={() => handleComponentToggle(component)}
                      className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    <span className="ml-2 text-sm text-gray-700 dark:text-gray-300">
                      {component}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>

          {/* File Logging */}
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
            <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-4 flex items-center">
              <Icon name="DocumentIcon" className="w-5 h-5 mr-2 text-blue-500" />
              {t('admin.logging.fileSection', 'File Logging')}
            </h2>

            <div className="space-y-4">
              <label className="flex items-center">
                <input
                  type="checkbox"
                  checked={loggingConfig.file?.enabled || false}
                  onChange={e =>
                    setLoggingConfig(prev => ({
                      ...prev,
                      file: { ...prev.file, enabled: e.target.checked }
                    }))
                  }
                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="ml-2 text-sm text-gray-700 dark:text-gray-300">
                  {t('admin.logging.enableFileLogging', 'Enable file logging')}
                </span>
              </label>

              {loggingConfig.file?.enabled && (
                <div className="ml-6 space-y-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                      {t('admin.logging.filePath', 'Log File Path')}
                    </label>
                    <input
                      type="text"
                      value={loggingConfig.file?.path || ''}
                      onChange={e =>
                        setLoggingConfig(prev => ({
                          ...prev,
                          file: { ...prev.file, path: e.target.value }
                        }))
                      }
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                    />
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                        {t('admin.logging.maxSize', 'Max Size (bytes)')}
                      </label>
                      <input
                        type="number"
                        value={loggingConfig.file?.maxSize || 10485760}
                        onChange={e =>
                          setLoggingConfig(prev => ({
                            ...prev,
                            file: { ...prev.file, maxSize: parseInt(e.target.value) }
                          }))
                        }
                        className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                        {t('admin.logging.maxFiles', 'Max Files')}
                      </label>
                      <input
                        type="number"
                        value={loggingConfig.file?.maxFiles || 5}
                        onChange={e =>
                          setLoggingConfig(prev => ({
                            ...prev,
                            file: { ...prev.file, maxFiles: parseInt(e.target.value) }
                          }))
                        }
                        className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Authentication Debug Logging */}
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
            <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-4 flex items-center">
              <Icon name="ShieldCheckIcon" className="w-5 h-5 mr-2 text-blue-500" />
              {t('admin.logging.authDebugSection', 'Authentication Debug Logging')}
            </h2>

            <div className="space-y-4">
              <label className="flex items-center">
                <input
                  type="checkbox"
                  checked={authDebugConfig.enabled || false}
                  onChange={e =>
                    setAuthDebugConfig(prev => ({ ...prev, enabled: e.target.checked }))
                  }
                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="ml-2 text-sm font-medium text-gray-700 dark:text-gray-300">
                  {t('admin.logging.enableAuthDebug', 'Enable authentication debug logging')}
                </span>
              </label>

              {authDebugConfig.enabled && (
                <div className="ml-6 space-y-3 border-l-2 border-blue-200 dark:border-blue-800 pl-4">
                  <label className="flex items-center">
                    <input
                      type="checkbox"
                      checked={authDebugConfig.maskTokens !== false}
                      onChange={e =>
                        setAuthDebugConfig(prev => ({ ...prev, maskTokens: e.target.checked }))
                      }
                      className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    <span className="ml-2 text-sm text-gray-700 dark:text-gray-300">
                      {t('admin.logging.maskTokens', 'Mask tokens in logs')}
                    </span>
                  </label>

                  <label className="flex items-center">
                    <input
                      type="checkbox"
                      checked={authDebugConfig.redactPasswords !== false}
                      onChange={e =>
                        setAuthDebugConfig(prev => ({
                          ...prev,
                          redactPasswords: e.target.checked
                        }))
                      }
                      className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    <span className="ml-2 text-sm text-gray-700 dark:text-gray-300">
                      {t('admin.logging.redactPasswords', 'Redact passwords in logs')}
                    </span>
                  </label>

                  <label className="flex items-center">
                    <input
                      type="checkbox"
                      checked={authDebugConfig.consoleLogging || false}
                      onChange={e =>
                        setAuthDebugConfig(prev => ({
                          ...prev,
                          consoleLogging: e.target.checked
                        }))
                      }
                      className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    <span className="ml-2 text-sm text-gray-700 dark:text-gray-300">
                      {t('admin.logging.consoleLogging', 'Enable console logging')}
                    </span>
                  </label>

                  <label className="flex items-center">
                    <input
                      type="checkbox"
                      checked={authDebugConfig.includeRawData || false}
                      onChange={e =>
                        setAuthDebugConfig(prev => ({
                          ...prev,
                          includeRawData: e.target.checked
                        }))
                      }
                      className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    <span className="ml-2 text-sm text-gray-700 dark:text-gray-300">
                      {t('admin.logging.includeRawData', 'Include raw authentication data')}
                    </span>
                  </label>

                  {/* Provider-specific debug settings */}
                  <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700">
                    <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                      {t('admin.logging.authProviders', 'Debug by Provider')}
                    </p>
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                      {Object.keys(authDebugConfig.providers || {}).map(provider => (
                        <label key={provider} className="flex items-center">
                          <input
                            type="checkbox"
                            checked={authDebugConfig.providers?.[provider]?.enabled !== false}
                            onChange={e =>
                              setAuthDebugConfig(prev => ({
                                ...prev,
                                providers: {
                                  ...prev.providers,
                                  [provider]: { enabled: e.target.checked }
                                }
                              }))
                            }
                            className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                          />
                          <span className="ml-2 text-sm text-gray-700 dark:text-gray-300 capitalize">
                            {provider}
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="mt-4">
              <button
                onClick={handleSaveAuthDebugConfig}
                disabled={saving}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white rounded-lg transition-colors"
              >
                {saving
                  ? t('common.saving', 'Saving...')
                  : t('admin.logging.saveAuthDebug', 'Save Authentication Debug Settings')}
              </button>
            </div>
          </div>

          {/* Save Button */}
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">
                  {t('admin.logging.saveChanges', 'Save Changes')}
                </h3>
                <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                  {t(
                    'admin.logging.saveDescription',
                    'Save logging configuration and apply changes immediately'
                  )}
                </p>
              </div>
              <button
                onClick={handleSaveLoggingConfig}
                disabled={saving}
                className="px-6 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white rounded-lg transition-colors font-medium"
              >
                {saving
                  ? t('common.saving', 'Saving...')
                  : t('admin.logging.save', 'Save Logging Configuration')}
              </button>
            </div>
          </div>

          {/* Info Box */}
          <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800 p-4">
            <div className="flex items-start">
              <Icon
                name="InformationCircleIcon"
                className="w-5 h-5 mr-2 text-blue-600 dark:text-blue-400 flex-shrink-0 mt-0.5"
              />
              <div className="text-sm text-blue-800 dark:text-blue-300">
                <p className="font-medium mb-1">{t('common.note', 'Note')}:</p>
                <ul className="list-disc list-inside space-y-1 text-xs">
                  <li>
                    {t(
                      'admin.logging.note1',
                      'Changes take effect immediately across all server processes'
                    )}
                  </li>
                  <li>
                    {t(
                      'admin.logging.note2',
                      'Log level changes are persisted to platform.json configuration'
                    )}
                  </li>
                  <li>
                    {t(
                      'admin.logging.note3',
                      'Lower levels (error, warn) show fewer messages, higher levels (debug, silly) show more'
                    )}
                  </li>
                  <li>
                    {t(
                      'admin.logging.note4',
                      'Use "info" level for production, "debug" for development'
                    )}
                  </li>
                  <li>
                    {t(
                      'admin.logging.note5',
                      'Authentication debug logging is separate and requires restart'
                    )}
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      </div>
    </AdminAuth>
  );
};

export default AdminLoggingPage;
