import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import AdminAuth from '../components/AdminAuth';
import AdminNavigation from '../components/AdminNavigation';
import DualModeEditor from '../../../shared/components/DualModeEditor';
import PlatformFormEditor from '../components/PlatformFormEditor';
import { makeAdminApiCall } from '../../../api/adminApi';
import LoadingSpinner from '../../../shared/components/LoadingSpinner';
import { usePlatformConfig } from '../../../shared/contexts/PlatformConfigContext';
import { getSchemaByType } from '../../../utils/schemaService';

const AdminAuthPage = () => {
  const { t } = useTranslation();
  const { refreshConfig } = usePlatformConfig();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [jsonSchema, setJsonSchema] = useState(null);
  const [config, setConfig] = useState({
    auth: {
      mode: 'proxy',
      authenticatedGroup: 'authenticated'
    },
    anonymousAuth: {
      enabled: true,
      defaultGroups: ['anonymous']
    },
    proxyAuth: {
      enabled: false,
      allowSelfSignup: false,
      userHeader: 'X-Forwarded-User',
      groupsHeader: 'X-Forwarded-Groups',
      jwtProviders: []
    },
    localAuth: {
      enabled: false,
      usersFile: 'contents/config/users.json',
      sessionTimeoutMinutes: 480,
      jwtSecret: '$' + '{JWT_SECRET}',
      showDemoAccounts: false
    },
    oidcAuth: {
      enabled: false,
      allowSelfSignup: false,
      providers: []
    },
    ntlmAuth: {
      enabled: false,
      domain: '',
      domainController: '',
      type: 'ntlm',
      debug: false,
      getUserInfo: true,
      getGroups: true,
      defaultGroups: [],
      sessionTimeoutMinutes: 480,
      generateJwtToken: true
    },
    authDebug: {
      enabled: false,
      maskTokens: true,
      redactPasswords: true,
      consoleLogging: false,
      includeRawData: false,
      providers: {
        oidc: {
          enabled: true
        },
        local: {
          enabled: true
        },
        proxy: {
          enabled: true
        },
        ldap: {
          enabled: true
        },
        ntlm: {
          enabled: true
        }
      }
    }
  });

  useEffect(() => {
    loadConfiguration();
    loadSchema();
  }, []);

  const loadSchema = async () => {
    try {
      const schema = await getSchemaByType('platform');
      setJsonSchema(schema);
    } catch (error) {
      console.error('Failed to load platform schema:', error);
    }
  };

  const loadConfiguration = async () => {
    try {
      const response = await makeAdminApiCall('/admin/configs/platform');
      const data = response.data;

      setConfig(prevConfig => ({
        ...prevConfig,
        ...data
      }));
    } catch (error) {
      setMessage({
        type: 'error',
        text: `Failed to load configuration: ${error.message}`
      });
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async data => {
    if (!data) data = config;

    setSaving(true);
    setMessage('');

    try {
      await makeAdminApiCall('/admin/configs/platform', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(data)
      });

      // Success - axios doesn't have response.ok, successful responses are returned directly
      setMessage({
        type: 'success',
        text: 'Authentication configuration saved successfully!'
      });
      // Refresh the platform config context to update navigation
      refreshConfig();
    } catch (error) {
      setMessage({
        type: 'error',
        text: `Failed to save configuration: ${error.message}`
      });
      throw error; // Re-throw to let DualModeEditor handle it
    } finally {
      setSaving(false);
    }
  };

  const handleDataChange = newData => {
    setConfig(newData);
  };

  if (loading) {
    return (
      <AdminAuth>
        <AdminNavigation />
        <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center">
          <LoadingSpinner size="lg" />
        </div>
      </AdminAuth>
    );
  }

  return (
    <AdminAuth>
      <AdminNavigation />
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
        {/* Header */}
        <div className="bg-white dark:bg-gray-800 shadow-sm border-b border-gray-200 dark:border-gray-700">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
            <div className="flex justify-between items-center">
              <div>
                <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">
                  {t('admin.auth.configuration', 'Authentication Configuration')}
                </h1>
                <p className="text-gray-600 dark:text-gray-400 mt-1">
                  Configure multiple authentication methods and user access settings. Enable dual
                  authentication for maximum flexibility.
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  const dataStr = JSON.stringify(config, null, 2);
                  const dataUri =
                    'data:application/json;charset=utf-8,' + encodeURIComponent(dataStr);
                  const exportFileDefaultName = `platform-config.json`;
                  const linkElement = document.createElement('a');
                  linkElement.setAttribute('href', dataUri);
                  linkElement.setAttribute('download', exportFileDefaultName);
                  linkElement.click();
                }}
                className="inline-flex items-center px-4 py-2 border border-gray-300 dark:border-gray-600 shadow-sm text-sm font-medium rounded-md text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
              >
                <Icon name="download" className="h-4 w-4 mr-2" />
                {t('common.download')}
              </button>
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          {message && (
            <div
              className={`mb-6 p-4 rounded-md ${
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

          <DualModeEditor
            value={config}
            onChange={handleDataChange}
            formComponent={PlatformFormEditor}
            jsonSchema={jsonSchema}
            title={t('admin.auth.configuration', 'Authentication Configuration')}
          />

          {/* Save buttons */}
          <div className="flex justify-end space-x-4 mt-8">
            <button
              type="button"
              onClick={() => handleSave()}
              disabled={saving}
              className="px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50"
            >
              {saving ? (
                <>
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2 inline-block"></div>
                  {t('admin.auth.saving', 'Saving...')}
                </>
              ) : (
                t('admin.auth.save', 'Save Configuration')
              )}
            </button>
          </div>
        </div>
      </div>
    </AdminAuth>
  );
};

export default AdminAuthPage;
