import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import DualModeEditor from '../../../shared/components/DualModeEditor';
import AppFormEditor from '../components/AppFormEditor';
import Icon from '../../../shared/components/Icon';
import { makeAdminApiCall } from '../../../api/adminApi';
import { fetchModels, fetchUIConfig } from '../../../api';
import { fetchJsonSchema } from '../../../utils/schemaService';
import AdminAuth from '../components/AdminAuth';
import AdminNavigation from '../components/AdminNavigation';

const AdminAppEditPage = () => {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const { appId } = useParams();
  const navigate = useNavigate();
  const [app, setApp] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [availableModels, setAvailableModels] = useState([]);
  const [uiConfig, setUiConfig] = useState(null);
  const [jsonSchema, setJsonSchema] = useState(null);
  const [editingMode, setEditingMode] = useState('form');
  const [validationState, setValidationState] = useState({ isValid: true, errors: [] });

  useEffect(() => {
    // Load available models, UI config, and JSON schema
    const loadModels = async () => {
      try {
        const models = await fetchModels();
        setAvailableModels(models);
      } catch (err) {
        console.error('Failed to load models:', err);
      }
    };

    const loadUIConfig = async () => {
      try {
        const config = await fetchUIConfig();
        setUiConfig(config);
      } catch (err) {
        console.error('Failed to load UI config:', err);
      }
    };

    const loadJsonSchema = async () => {
      try {
        const schema = await fetchJsonSchema('app');
        setJsonSchema(schema);
      } catch (err) {
        console.error('Failed to load app JSON schema:', err);
        // Continue without schema - validation will be server-side only
      }
    };

    loadModels();
    loadUIConfig();
    loadJsonSchema();
  }, []);

  useEffect(() => {
    if (appId === 'new') {
      // Initialize new app
      setApp({
        id: '',
        order: 0,
        name: { en: '' },
        description: { en: '' },
        color: '#4F46E5',
        icon: 'chat-bubbles',
        system: { en: '' },
        tokenLimit: 4096,
        preferredModel: 'gpt-4',
        preferredOutputFormat: 'markdown',
        preferredStyle: 'keep',
        preferredTemperature: 0.7,
        enabled: true,
        variables: [],
        starterPrompts: [],
        tools: [],
        greeting: {
          en: {
            title: '👋 Hello!',
            subtitle: 'How can I help you today?'
          },
          de: {
            title: '👋 Hallo!',
            subtitle: 'Wie kann ich Ihnen heute helfen?'
          }
        },
        allowEmptyContent: false,
        sendChatHistory: true,
        category: 'utility',
        inputMode: {
          type: 'singleline',
          rows: 5,
          microphone: {
            enabled: true,
            mode: 'manual',
            showTranscript: true
          }
        },
        upload: {
          enabled: false,
          imageUpload: {
            enabled: false,
            resizeImages: true,
            maxFileSizeMB: 10,
            supportedFormats: ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp']
          },
          fileUpload: {
            enabled: false,
            maxFileSizeMB: 5,
            supportedTextFormats: [
              'text/plain',
              'text/markdown',
              'text/csv',
              'application/json',
              'text/html',
              'text/css',
              'text/javascript',
              'application/javascript',
              'text/xml'
            ],
            supportedPdfFormats: ['application/pdf']
          }
        }
      });
      setLoading(false);
    } else {
      loadApp();
    }
  }, [appId]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadApp = useCallback(async () => {
    try {
      setLoading(true);
      const response = await makeAdminApiCall(`/admin/apps/${appId}`);
      const data = response.data;

      // Ensure all configuration sections exist with defaults
      const appWithDefaults = {
        ...data,
        tools: data.tools || [],
        greeting: data.greeting || {
          en: {
            title: '👋 Hello!',
            subtitle: 'How can I help you today?'
          },
          de: {
            title: '👋 Hallo!',
            subtitle: 'Wie kann ich Ihnen heute helfen?'
          }
        },
        allowEmptyContent: data.allowEmptyContent ?? false,
        sendChatHistory: data.sendChatHistory ?? true,
        inputMode: {
          type: 'singleline',
          rows: 5,
          microphone: {
            enabled: true,
            mode: 'manual',
            showTranscript: true
          },
          ...(data.inputMode || {})
        },
        upload: {
          enabled: data.upload?.enabled || false,
          imageUpload: {
            enabled: data.upload?.imageUpload?.enabled || false,
            resizeImages: data.upload?.imageUpload?.resizeImages ?? true,
            maxFileSizeMB: data.upload?.imageUpload?.maxFileSizeMB || 10,
            supportedFormats: data.upload?.imageUpload?.supportedFormats || [
              'image/jpeg',
              'image/jpg',
              'image/png',
              'image/gif',
              'image/webp'
            ]
          },
          fileUpload: {
            enabled: data.upload?.fileUpload?.enabled || false,
            maxFileSizeMB: data.upload?.fileUpload?.maxFileSizeMB || 5,
            supportedTextFormats: data.upload?.fileUpload?.supportedTextFormats || [
              'text/plain',
              'text/markdown',
              'text/csv',
              'application/json',
              'text/html',
              'text/css',
              'text/javascript',
              'application/javascript',
              'text/xml'
            ],
            supportedPdfFormats: data.upload?.fileUpload?.supportedPdfFormats || ['application/pdf']
          },
          ...(data.upload || {})
        }
      };

      setApp(appWithDefaults);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [appId]);

  const handleSave = async e => {
    e.preventDefault();

    // Check validation state
    if (!validationState.isValid) {
      setError(
        t('admin.apps.edit.validationErrorsExist', 'Please fix validation errors before saving')
      );
      return;
    }

    if (!app.id) {
      setError('App ID is required');
      return;
    }

    try {
      setSaving(true);
      const method = appId === 'new' ? 'POST' : 'PUT';
      const url = appId === 'new' ? '/admin/apps' : `/admin/apps/${appId}`;

      await makeAdminApiCall(url, {
        method,
        body: JSON.stringify(app)
      });

      navigate('/admin/apps');
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleAppChange = updatedApp => {
    setApp(updatedApp);
  };

  const handleValidationChange = validation => {
    setValidationState(validation);
  };

  const handleModeChange = mode => {
    setEditingMode(mode);
  };

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600 mx-auto"></div>
          <p className="mt-2 text-gray-600">{t('admin.apps.loading', 'Loading...')}</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="bg-red-50 border border-red-200 rounded-md p-4">
          <div className="flex">
            <div className="flex-shrink-0">
              <svg className="h-5 w-5 text-red-400" viewBox="0 0 20 20" fill="currentColor">
                <path
                  fillRule="evenodd"
                  d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
                  clipRule="evenodd"
                />
              </svg>
            </div>
            <div className="ml-3">
              <h3 className="text-sm font-medium text-red-800">
                {t('admin.apps.errorTitle', 'Error')}
              </h3>
              <div className="mt-2 text-sm text-red-700">{error}</div>
              <button
                type="button"
                onClick={() => setError(null)}
                className="mt-2 text-sm text-red-600 hover:text-red-500 underline"
              >
                {t('common.dismiss', 'Dismiss')}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <AdminAuth>
      <AdminNavigation />
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="sm:flex sm:items-center">
          <div className="sm:flex-auto">
            <h1 className="text-2xl font-semibold text-gray-900">
              {appId === 'new'
                ? t('admin.apps.edit.titleNew', 'Add New App')
                : t('admin.apps.edit.titleEdit', 'Edit App')}
            </h1>
            <p className="mt-2 text-sm text-gray-700">
              {appId === 'new'
                ? t('admin.apps.edit.subtitleNew', 'Configure a new iHub application')
                : t('admin.apps.edit.subtitleEdit', 'Modify app settings and configuration')}
            </p>
          </div>
          <div className="mt-4 sm:mt-0 sm:ml-16 sm:flex-none">
            <div className="flex space-x-3">
              {appId !== 'new' && (
                <button
                  type="button"
                  onClick={() => {
                    const dataStr = JSON.stringify(app, null, 2);
                    const dataUri =
                      'data:application/json;charset=utf-8,' + encodeURIComponent(dataStr);
                    const exportFileDefaultName = `app-${app.id}.json`;
                    const linkElement = document.createElement('a');
                    linkElement.setAttribute('href', dataUri);
                    linkElement.setAttribute('download', exportFileDefaultName);
                    linkElement.click();
                  }}
                  className="inline-flex items-center justify-center rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 sm:w-auto"
                >
                  <Icon name="download" className="w-4 h-4 mr-2" />
                  {t('common.download')}
                </button>
              )}
              <button
                type="button"
                className="inline-flex items-center justify-center rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 sm:w-auto"
                onClick={() => navigate('/admin/apps')}
              >
                {t('admin.apps.edit.back', 'Back to Apps')}
              </button>
            </div>
          </div>
        </div>

        <form onSubmit={handleSave} className="mt-8">
          {/* Dual Mode Editor */}
          <DualModeEditor
            value={app}
            onChange={handleAppChange}
            formComponent={AppFormEditor}
            formProps={{
              availableModels,
              uiConfig
            }}
            jsonSchema={jsonSchema}
            defaultMode={editingMode}
            onModeChange={handleModeChange}
            onValidationChange={handleValidationChange}
            title={
              appId === 'new'
                ? t('admin.apps.edit.configureNewApp', 'Configure New App')
                : t('admin.apps.edit.editAppConfig', 'Edit App Configuration')
            }
            description={
              appId === 'new'
                ? t(
                    'admin.apps.edit.configureNewAppDesc',
                    'Set up the configuration for your new iHub app using the form interface or JSON editor.'
                  )
                : t(
                    'admin.apps.edit.editAppConfigDesc',
                    'Modify the app configuration using the form interface or raw JSON editor.'
                  )
            }
            showValidationSummary={true}
            className="mb-6"
          />

          {/* Save Button */}
          <div className="flex justify-end space-x-3">
            <button
              type="button"
              onClick={() => navigate('/admin/apps')}
              className="bg-white py-2 px-4 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
            >
              {t('admin.apps.edit.cancel', 'Cancel')}
            </button>
            <button
              type="submit"
              disabled={saving || !validationState.isValid}
              className="inline-flex justify-center py-2 px-4 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? (
                <div className="flex items-center">
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                  {t('admin.apps.edit.saving', 'Saving...')}
                </div>
              ) : (
                <div className="flex items-center">
                  <Icon name="check" className="h-4 w-4 mr-2" />
                  {t('admin.apps.edit.save', 'Save App')}
                </div>
              )}
            </button>
          </div>
        </form>
      </div>
    </AdminAuth>
  );
};

export default AdminAppEditPage;
