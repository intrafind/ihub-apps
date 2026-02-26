import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { makeAdminApiCall } from '../../../api/adminApi';

const CloudStorageConfig = () => {
  const { t } = useTranslation();
  const [config, setConfig] = useState({
    enabled: false,
    providers: []
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [editingProvider, setEditingProvider] = useState(null);
  const [showAddProvider, setShowAddProvider] = useState(false);

  // Fetch current cloud storage configuration on mount
  useEffect(() => {
    const fetchCloudStorageConfig = async () => {
      try {
        const response = await makeAdminApiCall('/admin/configs/platform', {
          method: 'GET'
        });
        const cloudStorage = response.data.cloudStorage || { enabled: false, providers: [] };
        setConfig(cloudStorage);
        setMessage('');
      } catch (error) {
        setMessage({
          type: 'error',
          text: error.message || t('admin.cloudStorage.saveError')
        });
      } finally {
        setLoading(false);
      }
    };

    fetchCloudStorageConfig();
  }, [t]);

  const handleToggleEnabled = e => {
    setConfig(prev => ({
      ...prev,
      enabled: e.target.checked
    }));
  };

  const handleAddProvider = () => {
    setEditingProvider({
      id: '',
      name: '', // This will be same as id for cloud storage providers
      displayName: '',
      type: 'office365',
      enabled: true,
      tenantId: '',
      clientId: '',
      clientSecret: '',
      siteUrl: '',
      driveId: '',
      redirectUri: '',
      sources: {
        personalDrive: true,
        followedSites: true,
        teams: true
      }
    });
    setShowAddProvider(true);
  };

  const handleEditProvider = provider => {
    setEditingProvider({ ...provider });
    setShowAddProvider(true);
  };

  const handleDeleteProvider = async providerId => {
    if (!confirm(t('admin.cloudStorage.deleteConfirm'))) {
      return;
    }

    const updatedProviders = config.providers.filter(p => p.id !== providerId);
    const updatedConfig = {
      ...config,
      providers: updatedProviders
    };

    setConfig(updatedConfig);
    await saveConfig(updatedConfig);
  };

  const handleSaveProvider = () => {
    // Validate required fields
    if (!editingProvider.id || !editingProvider.displayName) {
      setMessage({
        type: 'error',
        text: t('admin.cloudStorage.validation.nameRequired')
      });
      return;
    }

    // Set name to be same as id if not provided (for cloud storage providers)
    const providerToSave = {
      ...editingProvider,
      name: editingProvider.name || editingProvider.id
    };

    if (providerToSave.type === 'office365') {
      if (!providerToSave.tenantId || !providerToSave.clientId || !providerToSave.clientSecret) {
        setMessage({
          type: 'error',
          text: t('admin.cloudStorage.validation.clientSecretRequired')
        });
        return;
      }
    }

    let updatedProviders;
    const existingIndex = config.providers.findIndex(p => p.id === providerToSave.id);

    if (existingIndex >= 0) {
      // Update existing provider
      updatedProviders = [...config.providers];
      updatedProviders[existingIndex] = providerToSave;
    } else {
      // Add new provider
      updatedProviders = [...config.providers, providerToSave];
    }

    const updatedConfig = {
      ...config,
      providers: updatedProviders
    };

    setConfig(updatedConfig);
    setShowAddProvider(false);
    setEditingProvider(null);
    saveConfig(updatedConfig);
  };

  const handleCancelEdit = () => {
    setShowAddProvider(false);
    setEditingProvider(null);
  };

  const saveConfig = async configToSave => {
    setSaving(true);
    setMessage('');

    try {
      // Get current platform config
      const response = await makeAdminApiCall('/admin/configs/platform', {
        method: 'GET'
      });

      // Update only the cloudStorage section
      const updatedPlatformConfig = {
        ...response.data,
        cloudStorage: configToSave
      };

      // Save the updated platform config
      await makeAdminApiCall('/admin/configs/platform', {
        method: 'POST',
        data: updatedPlatformConfig
      });

      setMessage({
        type: 'success',
        text: t('admin.cloudStorage.saveSuccess')
      });
    } catch (error) {
      setMessage({
        type: 'error',
        text: error.message || t('admin.cloudStorage.saveError')
      });
    } finally {
      setSaving(false);
    }
  };

  const handleSaveConfig = () => {
    saveConfig(config);
  };

  if (loading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-6">
        <div className="flex items-center justify-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600"></div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-6">
      <div className="flex items-start space-x-4">
        <div className="flex-shrink-0 mt-1">
          <div className="p-3 rounded-full bg-indigo-100 dark:bg-indigo-900/50">
            <Icon name="cloud" size="lg" className="text-indigo-600 dark:text-indigo-400" />
          </div>
        </div>
        <div className="flex-1">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">
            {t('admin.cloudStorage.title')}
          </h3>
          <p className="text-gray-600 dark:text-gray-400 mb-4">{t('admin.cloudStorage.subtitle')}</p>

          {/* Info Card */}
          <div className="bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-800 rounded-md p-4 mb-4">
            <div className="flex">
              <Icon name="info" size="md" className="text-blue-500 mt-0.5 mr-3" />
              <div>
                <h4 className="text-sm font-medium text-blue-800 dark:text-blue-200">
                  {t('admin.cloudStorage.info.title')}
                </h4>
                <p className="text-sm text-blue-700 dark:text-blue-300 mt-1">
                  {t('admin.cloudStorage.info.description')}
                </p>
              </div>
            </div>
          </div>

          {/* Enable/Disable Toggle */}
          <div className="flex items-center mb-6">
            <input
              type="checkbox"
              id="cloudStorageEnabled"
              checked={config.enabled}
              onChange={handleToggleEnabled}
              className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 dark:border-gray-600 rounded"
            />
            <label htmlFor="cloudStorageEnabled" className="ml-2 block text-sm text-gray-900 dark:text-gray-100">
              {config.enabled ? t('admin.cloudStorage.enabled') : t('admin.cloudStorage.disabled')}
            </label>
          </div>

          {/* Provider List */}
          {config.enabled && (
            <div className="mb-4">
              <div className="flex justify-between items-center mb-3">
                <h4 className="text-sm font-medium text-gray-900 dark:text-gray-100">
                  {t('admin.cloudStorage.providers')}
                </h4>
                <button
                  onClick={handleAddProvider}
                  className="inline-flex items-center px-3 py-1.5 border border-transparent text-xs font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
                >
                  <Icon name="plus" size="sm" className="mr-1" />
                  {t('admin.cloudStorage.addProvider')}
                </button>
              </div>

              {config.providers.length === 0 ? (
                <p className="text-sm text-gray-500 dark:text-gray-400 italic">
                  {t('admin.cloudStorage.noProviders')}
                </p>
              ) : (
                <div className="space-y-2">
                  {config.providers.map(provider => (
                    <div
                      key={provider.id}
                      className="flex items-center justify-between p-3 border border-gray-200 dark:border-gray-700 rounded-md hover:bg-gray-50 dark:hover:bg-gray-700"
                    >
                      <div className="flex items-center space-x-3">
                        <Icon
                          name={provider.type === 'office365' ? 'cloud' : 'cloud'}
                          size="md"
                          className="text-gray-400"
                        />
                        <div>
                          <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                            {provider.displayName}
                          </p>
                          <p className="text-xs text-gray-500 dark:text-gray-400">
                            {provider.type === 'office365'
                              ? t('admin.cloudStorage.office365')
                              : t('admin.cloudStorage.googledrive')}
                            {' • '}
                            {provider.enabled
                              ? t('admin.cloudStorage.providerEnabled')
                              : t('common.disabled')}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center space-x-2">
                        <button
                          onClick={() => handleEditProvider(provider)}
                          className="text-indigo-600 dark:text-indigo-400 hover:text-indigo-900 dark:hover:text-indigo-300 text-sm font-medium"
                        >
                          {t('common.edit')}
                        </button>
                        <button
                          onClick={() => handleDeleteProvider(provider.id)}
                          className="text-red-600 dark:text-red-400 hover:text-red-900 dark:hover:text-red-300 text-sm font-medium"
                        >
                          {t('common.delete')}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Provider Editor Modal */}
          {showAddProvider && editingProvider && (
            <div className="fixed inset-0 bg-gray-500 dark:bg-gray-900 bg-opacity-75 dark:bg-opacity-75 flex items-center justify-center z-50">
              <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto m-4">
                <div className="p-6">
                  <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
                    {editingProvider.id
                      ? t('admin.cloudStorage.editProvider')
                      : t('admin.cloudStorage.addProvider')}
                  </h3>

                  <div className="space-y-4">
                    {/* Provider ID */}
                    <div>
                      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                        {t('admin.cloudStorage.name')} *
                      </label>
                      <input
                        type="text"
                        value={editingProvider.id}
                        onChange={e =>
                          setEditingProvider({
                            ...editingProvider,
                            id: e.target.value,
                            name: e.target.value // Keep name in sync with id
                          })
                        }
                        className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
                        placeholder="office365-main"
                      />
                    </div>

                    {/* Display Name */}
                    <div>
                      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                        {t('admin.cloudStorage.displayName')} *
                      </label>
                      <input
                        type="text"
                        value={editingProvider.displayName}
                        onChange={e =>
                          setEditingProvider({ ...editingProvider, displayName: e.target.value })
                        }
                        className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
                        placeholder="Company Office 365"
                      />
                    </div>

                    {/* Provider Type */}
                    <div>
                      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                        {t('admin.cloudStorage.providerType')} *
                      </label>
                      <select
                        value={editingProvider.type}
                        onChange={e =>
                          setEditingProvider({ ...editingProvider, type: e.target.value })
                        }
                        className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
                      >
                        <option value="office365">{t('admin.cloudStorage.office365')}</option>
                        <option value="googledrive">{t('admin.cloudStorage.googledrive')}</option>
                      </select>
                    </div>

                    {/* Office 365-specific fields */}
                    {editingProvider.type === 'office365' && (
                      <>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                            {t('admin.cloudStorage.tenantId')} *
                          </label>
                          <input
                            type="text"
                            value={editingProvider.tenantId}
                            onChange={e =>
                              setEditingProvider({ ...editingProvider, tenantId: e.target.value })
                            }
                            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
                            placeholder="your-tenant-id"
                          />
                        </div>

                        <div>
                          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                            {t('admin.cloudStorage.clientId')} *
                          </label>
                          <input
                            type="text"
                            value={editingProvider.clientId}
                            onChange={e =>
                              setEditingProvider({ ...editingProvider, clientId: e.target.value })
                            }
                            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
                            placeholder="your-client-id"
                          />
                        </div>

                        <div>
                          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                            {t('admin.cloudStorage.clientSecret')} *
                          </label>
                          <input
                            type="password"
                            value={editingProvider.clientSecret}
                            onChange={e =>
                              setEditingProvider({
                                ...editingProvider,
                                clientSecret: e.target.value
                              })
                            }
                            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
                            placeholder="your-client-secret"
                          />
                        </div>

                        <div>
                          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                            {t('admin.cloudStorage.siteUrl')}
                          </label>
                          <input
                            type="url"
                            value={editingProvider.siteUrl}
                            onChange={e =>
                              setEditingProvider({ ...editingProvider, siteUrl: e.target.value })
                            }
                            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
                            placeholder="https://yourcompany.sharepoint.com"
                          />
                        </div>

                        <div>
                          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                            {t('admin.cloudStorage.driveId')}
                          </label>
                          <input
                            type="text"
                            value={editingProvider.driveId}
                            onChange={e =>
                              setEditingProvider({ ...editingProvider, driveId: e.target.value })
                            }
                            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
                            placeholder="drive-id"
                          />
                        </div>

                        {/* Sources configuration */}
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-2">
                            {t('admin.cloudStorage.sources', 'Available Sources')}
                          </label>
                          <div className="space-y-2">
                            <label className="flex items-center">
                              <input
                                type="checkbox"
                                checked={editingProvider.sources?.personalDrive !== false}
                                onChange={e =>
                                  setEditingProvider({
                                    ...editingProvider,
                                    sources: {
                                      ...editingProvider.sources,
                                      personalDrive: e.target.checked
                                    }
                                  })
                                }
                                className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
                              />
                              <span className="ml-2 text-sm text-gray-700">
                                {t('admin.cloudStorage.personalOneDrive', 'Personal OneDrive')}
                              </span>
                            </label>
                            <label className="flex items-center">
                              <input
                                type="checkbox"
                                checked={editingProvider.sources?.followedSites !== false}
                                onChange={e =>
                                  setEditingProvider({
                                    ...editingProvider,
                                    sources: {
                                      ...editingProvider.sources,
                                      followedSites: e.target.checked
                                    }
                                  })
                                }
                                className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
                              />
                              <span className="ml-2 text-sm text-gray-700">
                                {t(
                                  'admin.cloudStorage.followedSharePointSites',
                                  'Followed SharePoint Sites'
                                )}
                              </span>
                            </label>
                            <label className="flex items-center">
                              <input
                                type="checkbox"
                                checked={editingProvider.sources?.teams !== false}
                                onChange={e =>
                                  setEditingProvider({
                                    ...editingProvider,
                                    sources: {
                                      ...editingProvider.sources,
                                      teams: e.target.checked
                                    }
                                  })
                                }
                                className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
                              />
                              <span className="ml-2 text-sm text-gray-700">
                                {t('admin.cloudStorage.microsoftTeams', 'Microsoft Teams')}
                              </span>
                            </label>
                          </div>
                        </div>
                      </>
                    )}

                    {/* Google Drive-specific fields */}
                    {editingProvider.type === 'googledrive' && (
                      <>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                            {t('admin.cloudStorage.clientId')} *
                          </label>
                          <input
                            type="text"
                            value={editingProvider.clientId}
                            onChange={e =>
                              setEditingProvider({ ...editingProvider, clientId: e.target.value })
                            }
                            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
                            placeholder="your-client-id.apps.googleusercontent.com"
                          />
                        </div>

                        <div>
                          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                            {t('admin.cloudStorage.clientSecret')} *
                          </label>
                          <input
                            type="password"
                            value={editingProvider.clientSecret}
                            onChange={e =>
                              setEditingProvider({
                                ...editingProvider,
                                clientSecret: e.target.value
                              })
                            }
                            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
                            placeholder="your-client-secret"
                          />
                        </div>
                      </>
                    )}

                    {/* Redirect URI (optional for all) */}
                    <div>
                      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                        {t('admin.cloudStorage.redirectUri')}
                      </label>
                      <input
                        type="url"
                        value={editingProvider.redirectUri}
                        onChange={e =>
                          setEditingProvider({ ...editingProvider, redirectUri: e.target.value })
                        }
                        className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
                        placeholder="https://your-app.com/auth/callback"
                      />
                    </div>

                    {/* Enabled Toggle */}
                    <div className="flex items-center">
                      <input
                        type="checkbox"
                        id="providerEnabled"
                        checked={editingProvider.enabled}
                        onChange={e =>
                          setEditingProvider({ ...editingProvider, enabled: e.target.checked })
                        }
                        className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
                      />
                      <label htmlFor="providerEnabled" className="ml-2 block text-sm text-gray-900">
                        {t('admin.cloudStorage.providerEnabled')}
                      </label>
                    </div>
                  </div>

                  {/* Action Buttons */}
                  <div className="mt-6 flex justify-end space-x-3">
                    <button
                      onClick={handleCancelEdit}
                      className="px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
                    >
                      {t('common.cancel')}
                    </button>
                    <button
                      onClick={handleSaveProvider}
                      className="px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
                    >
                      {t('common.save')}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Messages */}
          {message && (
            <div
              className={`p-4 rounded-md mb-4 ${
                message.type === 'success'
                  ? 'bg-green-50 border border-green-200'
                  : 'bg-red-50 border border-red-200'
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
                    message.type === 'success' ? 'text-green-700' : 'text-red-700'
                  }`}
                >
                  {message.text}
                </p>
              </div>
            </div>
          )}

          {/* Save Button */}
          <button
            onClick={handleSaveConfig}
            disabled={saving}
            className={`
              inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium 
              rounded-md shadow-sm text-white 
              ${
                saving
                  ? 'bg-gray-400 cursor-not-allowed'
                  : 'bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500'
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
                {t('admin.cloudStorage.saving')}
              </>
            ) : (
              <>
                <Icon name="save" size="md" className="mr-2" />
                {t('admin.cloudStorage.save')}
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

export default CloudStorageConfig;
