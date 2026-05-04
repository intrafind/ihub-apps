import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { makeAdminApiCall } from '../../../api/adminApi';

function CookieSettingsConfig() {
  const { t } = useTranslation();
  const [config, setConfig] = useState({
    disableSecure: false
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  // Fetch current cookie settings configuration on mount
  useEffect(() => {
    const fetchCookieSettings = async () => {
      try {
        const response = await makeAdminApiCall('/admin/configs/platform', {
          method: 'GET'
        });
        setConfig({
          disableSecure: response.data?.cookieSettings?.disableSecure || false
        });
        setMessage('');
      } catch (error) {
        setMessage({
          type: 'error',
          text: error.message || t('admin.system.cookieSettings.configSaveError')
        });
      } finally {
        setLoading(false);
      }
    };

    fetchCookieSettings();
  }, [t]);

  const handleToggleDisableSecure = e => {
    setConfig(prev => ({
      ...prev,
      disableSecure: e.target.checked
    }));
  };

  const handleSaveConfig = async () => {
    setSaving(true);
    setMessage('');

    try {
      // Fetch full platform config first
      const platformResponse = await makeAdminApiCall('/admin/configs/platform', {
        method: 'GET'
      });

      const updatedPlatform = {
        ...platformResponse.data,
        cookieSettings: {
          disableSecure: config.disableSecure
        }
      };

      // Save the updated platform config
      await makeAdminApiCall('/admin/configs/platform', {
        method: 'PUT',
        data: updatedPlatform
      });

      setMessage({
        type: 'success',
        text: t('admin.system.cookieSettings.configSaved')
      });
    } catch (error) {
      setMessage({
        type: 'error',
        text: error.message || t('admin.system.cookieSettings.configSaveError')
      });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Icon name="loader" className="h-6 w-6 animate-spin text-primary-600" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
          {t('admin.system.cookieSettings.title')}
        </h2>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          {t('admin.system.cookieSettings.description')}
        </p>
      </div>

      {/* Default Behavior Info */}
      <div className="rounded-md bg-blue-50 dark:bg-blue-900/20 p-4">
        <div className="flex">
          <div className="flex-shrink-0">
            <Icon name="info" className="h-5 w-5 text-blue-400" />
          </div>
          <div className="ml-3">
            <p className="text-sm text-blue-700 dark:text-blue-300">
              {t('admin.system.cookieSettings.defaultBehavior')}
            </p>
          </div>
        </div>
      </div>

      {/* Security Warning - Only show when disableSecure is enabled */}
      {config.disableSecure && (
        <div className="rounded-md bg-yellow-50 dark:bg-yellow-900/20 p-4">
          <div className="flex">
            <div className="flex-shrink-0">
              <Icon name="alert-triangle" className="h-5 w-5 text-yellow-400" />
            </div>
            <div className="ml-3">
              <h3 className="text-sm font-medium text-yellow-800 dark:text-yellow-200">
                {t('admin.system.cookieSettings.securityWarning')}
              </h3>
              <div className="mt-2 text-sm text-yellow-700 dark:text-yellow-300">
                <p>{t('admin.system.cookieSettings.securityWarningDesc')}</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Disable Secure Cookie Flag Toggle */}
      <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-4">
        <div className="flex items-start">
          <div className="flex h-5 items-center">
            <input
              id="disableSecure"
              name="disableSecure"
              type="checkbox"
              checked={config.disableSecure}
              onChange={handleToggleDisableSecure}
              className="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500 dark:border-gray-600 dark:bg-gray-700"
            />
          </div>
          <div className="ml-3 text-sm">
            <label htmlFor="disableSecure" className="font-medium text-gray-900 dark:text-white">
              {t('admin.system.cookieSettings.disableSecure')}
            </label>
            <p className="text-gray-600 dark:text-gray-400">
              {t('admin.system.cookieSettings.disableSecureDesc')}
            </p>
          </div>
        </div>
      </div>

      {/* Save Button */}
      <div className="flex items-center justify-between border-t border-gray-200 dark:border-gray-700 pt-4">
        <div className="flex-1">
          {message && (
            <div
              className={`text-sm ${
                message.type === 'success'
                  ? 'text-green-600 dark:text-green-400'
                  : 'text-red-600 dark:text-red-400'
              }`}
            >
              {message.text}
            </div>
          )}
        </div>
        <button
          onClick={handleSaveConfig}
          disabled={saving}
          className="inline-flex items-center rounded-md bg-primary-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-primary-500 dark:hover:bg-primary-400"
        >
          {saving ? (
            <>
              <Icon name="loader" className="mr-2 h-4 w-4 animate-spin" />
              {t('admin.system.cookieSettings.savingConfig')}
            </>
          ) : (
            t('admin.system.cookieSettings.saveConfig')
          )}
        </button>
      </div>
    </div>
  );
}

export default CookieSettingsConfig;
