import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { usePlatformConfig } from '../../../shared/contexts/PlatformConfigContext';

/**
 * Cloud Storage Picker component
 * Allows users to select files from configured cloud storage providers (SharePoint, Google Drive)
 */
const CloudStoragePicker = ({ onFileSelect, onClose, preSelectedProvider = null }) => {
  const { t } = useTranslation();
  const { platformConfig } = usePlatformConfig();
  const [selectedProvider, setSelectedProvider] = useState(preSelectedProvider);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);

  // Get cloud storage configuration
  const cloudStorage = platformConfig?.cloudStorage || { enabled: false, providers: [] };
  const enabledProviders = cloudStorage.enabled
    ? cloudStorage.providers.filter(p => p.enabled)
    : [];

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
    setError(null);
  };

  const handleFileSelection = async () => {
    if (!selectedProvider) {
      setError(t('appsList.noCloudProviders'));
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      if (selectedProvider.type === 'sharepoint') {
        // Open SharePoint file picker
        await openSharePointPicker(selectedProvider);
      } else if (selectedProvider.type === 'googledrive') {
        // Open Google Drive file picker
        await openGoogleDrivePicker(selectedProvider);
      }
    } catch (err) {
      setError(err.message || t('errors.cloudStorageError', 'Failed to access cloud storage'));
    } finally {
      setIsLoading(false);
    }
  };

  const openSharePointPicker = async provider => {
    // This is a placeholder - actual implementation would use Microsoft Graph API
    // and the OneDrive File Picker SDK
    setError(
      t(
        'errors.notImplemented',
        'SharePoint file picker is not yet implemented. Please use local file upload.'
      )
    );

    // Future implementation would look like:
    /*
    const pickerOptions = {
      clientId: provider.clientId,
      action: 'share',
      multiSelect: false,
      advanced: {
        redirectUri: provider.redirectUri || window.location.origin
      },
      success: (files) => {
        // Process selected files
        onFileSelect(files);
        onClose();
      },
      cancel: () => {
        onClose();
      },
      error: (error) => {
        setError(error.message);
      }
    };
    
    // Initialize and launch picker
    OneDrive.open(pickerOptions);
    */
  };

  const openGoogleDrivePicker = async provider => {
    // This is a placeholder - actual implementation would use Google Picker API
    setError(
      t(
        'errors.notImplemented',
        'Google Drive file picker is not yet implemented. Please use local file upload.'
      )
    );

    // Future implementation would look like:
    /*
    const picker = new google.picker.PickerBuilder()
      .addView(google.picker.ViewId.DOCS)
      .setOAuthToken(oauthToken)
      .setDeveloperKey(provider.developerKey)
      .setCallback((data) => {
        if (data.action === google.picker.Action.PICKED) {
          // Process selected files
          onFileSelect(data.docs);
          onClose();
        } else if (data.action === google.picker.Action.CANCEL) {
          onClose();
        }
      })
      .build();
    picker.setVisible(true);
    */
  };

  if (!cloudStorage.enabled || enabledProviders.length === 0) {
    return (
      <div className="fixed inset-0 bg-gray-500 bg-opacity-75 flex items-center justify-center z-50">
        <div className="bg-white rounded-lg shadow-xl max-w-md w-full m-4 p-6">
          <div className="flex items-start mb-4">
            <div className="flex-shrink-0">
              <Icon name="warning" size="lg" className="text-yellow-500" />
            </div>
            <div className="ml-3">
              <h3 className="text-lg font-medium text-gray-900">
                {t('appsList.cloudStorageNotEnabled')}
              </h3>
              <p className="mt-2 text-sm text-gray-500">{t('appsList.noCloudProviders')}</p>
            </div>
          </div>
          <div className="mt-4 flex justify-end">
            <button
              onClick={onClose}
              className="px-4 py-2 bg-gray-600 text-white rounded-md hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-gray-500"
            >
              {t('common.close')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-gray-500 bg-opacity-75 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full m-4 p-6">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-semibold text-gray-900">
            {t('appsList.uploadFromCloud')}
          </h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600"
            aria-label={t('common.close')}
          >
            <Icon name="x" size="md" />
          </button>
        </div>

        {/* Provider Selection */}
        {enabledProviders.length > 1 && (
          <div className="mb-6">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              {t('appsList.selectCloudProvider')}
            </label>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {enabledProviders.map(provider => (
                <button
                  key={provider.id}
                  onClick={() => handleProviderSelect(provider)}
                  className={`flex items-center p-4 border-2 rounded-lg transition-colors ${
                    selectedProvider?.id === provider.id
                      ? 'border-indigo-600 bg-indigo-50'
                      : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                  }`}
                >
                  <Icon
                    name={provider.type === 'sharepoint' ? 'cloud' : 'cloud'}
                    size="lg"
                    className={
                      selectedProvider?.id === provider.id ? 'text-indigo-600' : 'text-gray-400'
                    }
                  />
                  <div className="ml-3 text-left">
                    <p className="text-sm font-medium text-gray-900">{provider.displayName}</p>
                    <p className="text-xs text-gray-500">
                      {provider.type === 'sharepoint'
                        ? 'Microsoft SharePoint'
                        : 'Google Drive'}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Selected Provider Display (for single provider) */}
        {enabledProviders.length === 1 && selectedProvider && (
          <div className="mb-6">
            <div className="flex items-center p-4 border border-gray-200 rounded-lg bg-gray-50">
              <Icon name="cloud" size="lg" className="text-indigo-600" />
              <div className="ml-3">
                <p className="text-sm font-medium text-gray-900">{selectedProvider.displayName}</p>
                <p className="text-xs text-gray-500">
                  {selectedProvider.type === 'sharepoint'
                    ? 'Microsoft SharePoint'
                    : 'Google Drive'}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Error Message */}
        {error && (
          <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-md">
            <div className="flex">
              <Icon name="warning" size="md" className="text-red-500 mt-0.5 mr-3" />
              <p className="text-sm text-red-700">{error}</p>
            </div>
          </div>
        )}

        {/* Action Buttons */}
        <div className="flex justify-end space-x-3">
          <button
            onClick={onClose}
            className="px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={handleFileSelection}
            disabled={!selectedProvider || isLoading}
            className={`px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white ${
              !selectedProvider || isLoading
                ? 'bg-gray-400 cursor-not-allowed'
                : 'bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500'
            }`}
          >
            {isLoading ? (
              <>
                <svg
                  className="animate-spin -ml-1 mr-3 h-4 w-4 text-white inline"
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
                {t('common.loading')}
              </>
            ) : (
              <>
                <Icon name="cloud-arrow-down" size="md" className="inline mr-2" />
                {t('appsList.selectFilesFromCloud', {
                  provider: selectedProvider?.displayName || ''
                })}
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

export default CloudStoragePicker;
