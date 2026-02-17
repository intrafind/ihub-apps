import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { usePlatformConfig } from '../../../shared/contexts/PlatformConfigContext';
import Office365FileBrowser from './Office365FileBrowser';

/**
 * Cloud Storage Picker component
 * Modal for selecting files from cloud storage providers (Office 365, Google Drive)
 */
const CloudStoragePicker = ({
  onFileSelect,
  onClose,
  preSelectedProvider = null,
  uploadConfig = {}
}) => {
  const { t } = useTranslation();
  const { platformConfig } = usePlatformConfig();
  const [selectedProvider, setSelectedProvider] = useState(preSelectedProvider);

  // Get cloud storage configuration
  const cloudStorage = platformConfig?.cloudStorage || { enabled: false, providers: [] };
  const enabledProviders = useMemo(
    () => (cloudStorage.enabled ? cloudStorage.providers.filter(p => p.enabled) : []),
    [cloudStorage.enabled, cloudStorage.providers]
  );

  useEffect(() => {
    // Auto-select first provider if only one is available and no pre-selected provider
    if (enabledProviders.length === 1 && !selectedProvider) {
      setSelectedProvider(enabledProviders[0]);
    }
    // If pre-selected provider is provided, use it
    if (preSelectedProvider) {
      setSelectedProvider(preSelectedProvider);
    }
  }, [enabledProviders, selectedProvider, preSelectedProvider]);

  const handleProviderSelect = provider => {
    setSelectedProvider(provider);
  };

  const handleFilesProcessed = processedData => {
    if (processedData && processedData.length > 0) {
      onFileSelect(processedData);
    }
  };

  // No cloud storage enabled
  if (!cloudStorage.enabled || enabledProviders.length === 0) {
    return (
      <div className="fixed inset-0 bg-gray-500 bg-opacity-75 dark:bg-gray-900 dark:bg-opacity-75 flex items-center justify-center z-50">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full m-4 p-6">
          <div className="flex items-start mb-4">
            <div className="flex-shrink-0">
              <Icon name="warning" size="lg" className="text-yellow-500" />
            </div>
            <div className="ml-3">
              <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">
                {t('cloudStorage.notEnabled', 'Cloud Storage Not Enabled')}
              </h3>
              <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                {t('cloudStorage.noProviders', 'No cloud storage providers are configured')}
              </p>
            </div>
          </div>
          <div className="mt-4 flex justify-end">
            <button
              onClick={onClose}
              className="px-4 py-2 bg-gray-600 text-white rounded-md hover:bg-gray-700 dark:bg-gray-700 dark:hover:bg-gray-600"
            >
              {t('common.close', 'Close')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-gray-500 bg-opacity-75 dark:bg-gray-900 dark:bg-opacity-75 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-4xl w-full m-4 p-6 max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex justify-between items-center mb-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {t('cloudStorage.selectFiles', 'Select Files from Cloud Storage')}
          </h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
            aria-label={t('common.close', 'Close')}
          >
            <Icon name="x" size="md" />
          </button>
        </div>

        {/* Provider Selection (if multiple providers) */}
        {enabledProviders.length > 1 && !selectedProvider && (
          <div className="space-y-3">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
              {t('cloudStorage.selectProvider', 'Select a Provider')}
            </label>
            {enabledProviders.map(provider => (
              <button
                key={provider.id}
                onClick={() => handleProviderSelect(provider)}
                className="w-full flex items-center p-4 border-2 border-gray-200 dark:border-gray-700 rounded-lg hover:border-indigo-500 dark:hover:border-indigo-400 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
              >
                <Icon
                  name={provider.type === 'office365' ? 'cloud' : 'cloud'}
                  size="xl"
                  className="text-indigo-600 dark:text-indigo-400"
                />
                <div className="ml-4 text-left">
                  <p className="text-base font-medium text-gray-900 dark:text-gray-100">
                    {provider.displayName}
                  </p>
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    {provider.type === 'office365' ? 'Microsoft Office 365' : 'Google Drive'}
                  </p>
                </div>
              </button>
            ))}
          </div>
        )}

        {/* File Browser for selected provider */}
        {selectedProvider && (
          <div>
            {/* Show provider info if multiple providers */}
            {enabledProviders.length > 1 && (
              <div className="mb-4 pb-3 border-b border-gray-200 dark:border-gray-700">
                <button
                  onClick={() => setSelectedProvider(null)}
                  className="text-sm text-indigo-600 dark:text-indigo-400 hover:text-indigo-700 dark:hover:text-indigo-300 flex items-center"
                >
                  <Icon name="arrowLeft" size="sm" className="mr-1" />
                  {t('cloudStorage.changeProvider', 'Change Provider')}
                </button>
              </div>
            )}

            {/* Render provider-specific browser */}
            {selectedProvider.type === 'office365' ? (
              <Office365FileBrowser
                provider={selectedProvider}
                onFilesProcessed={handleFilesProcessed}
                onClose={onClose}
                uploadConfig={uploadConfig}
              />
            ) : selectedProvider.type === 'googledrive' ? (
              <div className="flex flex-col items-center justify-center py-12 px-6 text-center">
                <Icon
                  name="information-circle"
                  size="xl"
                  className="text-gray-400 dark:text-gray-500 mb-4"
                />
                <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">
                  {t('cloudStorage.comingSoon', 'Coming Soon')}
                </h3>
                <p className="text-sm text-gray-600 dark:text-gray-400 mb-6">
                  {t(
                    'cloudStorage.googleDriveNotYet',
                    'Google Drive integration is not yet available. Please use Office 365 or local file upload.'
                  )}
                </p>
                <button
                  onClick={onClose}
                  className="px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 dark:bg-indigo-500 dark:hover:bg-indigo-600"
                >
                  {t('common.close', 'Close')}
                </button>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
};

export default CloudStoragePicker;
