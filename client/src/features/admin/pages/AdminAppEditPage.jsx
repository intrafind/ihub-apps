import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import DynamicLanguageEditor from '../../../shared/components/DynamicLanguageEditor';
import ToolsSelector from '../../../shared/components/ToolsSelector';
import Icon from '../../../shared/components/Icon';
import { getLocalizedContent } from '../../../utils/localizeContent';
import { makeAdminApiCall } from '../../../api/adminApi';
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

  useEffect(() => {
    // Load available models and UI config
    const loadModels = async () => {
      try {
        const response = await fetch('/api/models');
        if (response.ok) {
          const models = await response.json();
          setAvailableModels(models);
        }
      } catch (err) {
        console.error('Failed to load models:', err);
      }
    };

    const loadUIConfig = async () => {
      try {
        const response = await fetch('/api/configs/ui');
        if (response.ok) {
          const config = await response.json();
          setUiConfig(config);
        }
      } catch (err) {
        console.error('Failed to load UI config:', err);
      }
    };

    loadModels();
    loadUIConfig();
  }, []);

  useEffect(() => {
    if (appId === 'new') {
      // Initialize new app
      setApp({
        id: '',
        name: { en: '' },
        description: { en: '' },
        color: '#4F46E5',
        icon: 'chat-bubbles',
        system: { en: '' },
        tokenLimit: 4096,
        preferredModel: 'gpt-4',
        preferredOutputFormat: 'markdown',
        preferredStyle: 'normal',
        preferredTemperature: 0.7,
        enabled: true,
        order: 0,
        messagePlaceholder: { en: '' },
        prompt: { en: '' },
        variables: [],
        starterPrompts: [],
        tools: [],
        greeting: {
          en: {
            title: '👋 Hello!',
            subtitle: 'How can I help you today?'
          }
        },
        allowEmptyContent: false,
        sendChatHistory: true,
        category: 'utility',
        features: {
          magicPrompt: {
            enabled: false,
            model: 'gpt-4',
            prompt:
              'You are a helpful assistant that improves user prompts to be more specific and effective. Improve this prompt: {{prompt}}'
          }
        },
        settings: {
          enabled: true,
          model: { enabled: true },
          temperature: { enabled: true },
          outputFormat: { enabled: true },
          chatHistory: { enabled: true },
          style: { enabled: true },
          speechRecognition: {
            service: 'default',
            host: ''
          }
        },
        inputMode: {
          type: 'multiline',
          rows: 5,
          microphone: {
            enabled: true,
            mode: 'manual',
            showTranscript: true
          }
        },
        imageUpload: {
          enabled: false,
          resizeImages: true,
          maxFileSizeMB: 10,
          supportedFormats: ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp']
        },
        fileUpload: {
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
      });
      setLoading(false);
    } else {
      loadApp();
    }
  }, [appId]);

  const loadApp = async () => {
    try {
      setLoading(true);
      const response = await makeAdminApiCall(`/api/admin/apps/${appId}`);
      const data = await response.json();

      // Ensure all configuration sections exist with defaults
      const appWithDefaults = {
        ...data,
        tools: data.tools || [],
        greeting: data.greeting || {
          en: {
            title: '👋 Hello!',
            subtitle: 'How can I help you today?'
          }
        },
        allowEmptyContent: data.allowEmptyContent ?? false,
        sendChatHistory: data.sendChatHistory ?? true,
        features: data.features || {
          magicPrompt: {
            enabled: false,
            model: 'gpt-4',
            prompt:
              'You are a helpful assistant that improves user prompts to be more specific and effective. Improve this prompt: {{prompt}}'
          }
        },
        settings: {
          enabled: true,
          model: { enabled: true },
          temperature: { enabled: true },
          outputFormat: { enabled: true },
          chatHistory: { enabled: true },
          style: { enabled: true },
          speechRecognition: {
            service: 'default',
            host: ''
          },
          ...(data.settings || {})
        },
        inputMode: {
          type: 'multiline',
          rows: 5,
          microphone: {
            enabled: true,
            mode: 'manual',
            showTranscript: true
          },
          ...(data.inputMode || {})
        },
        imageUpload: {
          enabled: false,
          resizeImages: true,
          maxFileSizeMB: 10,
          supportedFormats: ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'],
          ...(data.imageUpload || {})
        },
        fileUpload: {
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
          supportedPdfFormats: ['application/pdf'],
          ...(data.fileUpload || {})
        }
      };

      setApp(appWithDefaults);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async e => {
    e.preventDefault();

    if (!app.id) {
      setError('App ID is required');
      return;
    }

    try {
      setSaving(true);
      const method = appId === 'new' ? 'POST' : 'PUT';
      const url = appId === 'new' ? '/api/admin/apps' : `/api/admin/apps/${appId}`;

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

  const handleInputChange = (field, value) => {
    setApp(prev => ({
      ...prev,
      [field]: value
    }));
  };

  const addToList = (field, subField, defaultValue) => {
    const currentList = app[field]?.[subField] || [];
    handleInputChange(field, {
      ...app[field],
      [subField]: [...currentList, defaultValue]
    });
  };

  const removeFromList = (field, subField, index) => {
    const currentList = app[field]?.[subField] || [];
    handleInputChange(field, {
      ...app[field],
      [subField]: currentList.filter((_, i) => i !== index)
    });
  };

  const updateListItem = (field, subField, index, value) => {
    const currentList = app[field]?.[subField] || [];
    const newList = [...currentList];
    newList[index] = value;
    handleInputChange(field, {
      ...app[field],
      [subField]: newList
    });
  };

  const handleLocalizedChange = (field, value) => {
    setApp(prev => ({
      ...prev,
      [field]: value
    }));
  };

  const handleVariableChange = (index, field, value) => {
    setApp(prev => ({
      ...prev,
      variables: prev.variables.map((variable, i) =>
        i === index ? { ...variable, [field]: value } : variable
      )
    }));
  };

  const handleVariablePredefinedValueChange = (variableIndex, valueIndex, field, value) => {
    setApp(prev => ({
      ...prev,
      variables: prev.variables.map((variable, i) =>
        i === variableIndex
          ? {
              ...variable,
              predefinedValues: variable.predefinedValues.map((predefinedValue, j) =>
                j === valueIndex ? { ...predefinedValue, [field]: value } : predefinedValue
              )
            }
          : variable
      )
    }));
  };

  const addPredefinedValue = variableIndex => {
    setApp(prev => ({
      ...prev,
      variables: prev.variables.map((variable, i) =>
        i === variableIndex
          ? {
              ...variable,
              predefinedValues: [
                ...(variable.predefinedValues || []),
                {
                  label: { en: '' },
                  value: ''
                }
              ]
            }
          : variable
      )
    }));
  };

  const removePredefinedValue = (variableIndex, valueIndex) => {
    setApp(prev => ({
      ...prev,
      variables: prev.variables.map((variable, i) =>
        i === variableIndex
          ? {
              ...variable,
              predefinedValues: variable.predefinedValues.filter((_, j) => j !== valueIndex)
            }
          : variable
      )
    }));
  };

  const addVariable = () => {
    setApp(prev => ({
      ...prev,
      variables: [
        ...(prev.variables || []),
        {
          name: '',
          label: { en: '' },
          type: 'string',
          required: false,
          defaultValue: { en: '' },
          predefinedValues: []
        }
      ]
    }));
  };

  const removeVariable = index => {
    setApp(prev => ({
      ...prev,
      variables: prev.variables.filter((_, i) => i !== index)
    }));
  };

  const handleStarterPromptChange = (index, field, value) => {
    setApp(prev => ({
      ...prev,
      starterPrompts: prev.starterPrompts.map((prompt, i) =>
        i === index ? { ...prompt, [field]: value } : prompt
      )
    }));
  };

  const addStarterPrompt = () => {
    setApp(prev => ({
      ...prev,
      starterPrompts: [
        ...(prev.starterPrompts || []),
        {
          title: { en: '' },
          message: { en: '' },
          variables: {}
        }
      ]
    }));
  };

  const removeStarterPrompt = index => {
    setApp(prev => ({
      ...prev,
      starterPrompts: prev.starterPrompts.filter((_, i) => i !== index)
    }));
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
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <AdminAuth>
      <AdminNavigation />
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="sm:flex sm:items-center">
          <div className="sm:flex-auto">
            <h1 className="text-2xl font-semibold text-gray-900">
              {appId === 'new'
                ? t('admin.apps.edit.titleNew', 'Add New App')
                : t('admin.apps.edit.titleEdit', 'Edit App')}
            </h1>
            <p className="mt-2 text-sm text-gray-700">
              {appId === 'new'
                ? t('admin.apps.edit.subtitleNew', 'Configure a new AI Hub application')
                : t('admin.apps.edit.subtitleEdit', 'Modify app settings and configuration')}
            </p>
          </div>
          <div className="mt-4 sm:mt-0 sm:ml-16 sm:flex-none">
            <button
              type="button"
              className="inline-flex items-center justify-center rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 sm:w-auto"
              onClick={() => navigate('/admin/apps')}
            >
              {t('admin.apps.edit.back', 'Back to Apps')}
            </button>
          </div>
        </div>

        <form onSubmit={handleSave} className="mt-8 space-y-6">
          {/* Basic Information */}
          <div className="bg-white shadow px-4 py-5 sm:rounded-lg sm:p-6">
            <div className="md:grid md:grid-cols-3 md:gap-6">
              <div className="md:col-span-1">
                <h3 className="text-lg font-medium leading-6 text-gray-900">
                  {t('admin.apps.edit.basicInfo', 'Basic Information')}
                </h3>
                <p className="mt-1 text-sm text-gray-500">
                  {t('admin.apps.edit.basicInfoDesc', 'Basic app configuration and metadata')}
                </p>
              </div>
              <div className="mt-5 md:col-span-2 md:mt-0">
                <div className="grid grid-cols-6 gap-6">
                  <div className="col-span-6 sm:col-span-3">
                    <label className="block text-sm font-medium text-gray-700">
                      {t('admin.apps.edit.appId', 'App ID')}
                    </label>
                    <input
                      type="text"
                      required
                      value={app.id}
                      onChange={e => handleInputChange('id', e.target.value)}
                      disabled={appId !== 'new'}
                      className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm disabled:bg-gray-100"
                    />
                  </div>

                  <div className="col-span-6 sm:col-span-3">
                    <label className="block text-sm font-medium text-gray-700">
                      {t('admin.apps.edit.order', 'Order')}
                    </label>
                    <input
                      type="number"
                      value={app.order || 0}
                      onChange={e => handleInputChange('order', parseInt(e.target.value) || 0)}
                      className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                    />
                  </div>

                  <div className="col-span-6 sm:col-span-3">
                    <label className="block text-sm font-medium text-gray-700">
                      {t('admin.apps.edit.category', 'Category')}
                    </label>
                    <select
                      value={app.category || ''}
                      onChange={e => handleInputChange('category', e.target.value)}
                      className="mt-1 block w-full rounded-lg border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                    >
                      <option value="">
                        {t('admin.apps.edit.selectCategory', 'Select category...')}
                      </option>
                      {uiConfig?.appsList?.categories?.list
                        ?.filter(cat => cat.id !== 'all')
                        .map(category => (
                          <option key={category.id} value={category.id}>
                            {getLocalizedContent(category.name, currentLanguage)}
                          </option>
                        ))}
                    </select>
                  </div>

                  <div className="col-span-6">
                    <DynamicLanguageEditor
                      label={t('admin.apps.edit.name', 'Name')}
                      value={app.name}
                      onChange={value => handleLocalizedChange('name', value)}
                      required={true}
                      placeholder={{
                        en: 'Enter app name in English',
                        de: 'App-Name auf Deutsch eingeben'
                      }}
                    />
                  </div>

                  <div className="col-span-6">
                    <DynamicLanguageEditor
                      label={t('admin.apps.edit.description', 'Description')}
                      value={app.description}
                      onChange={value => handleLocalizedChange('description', value)}
                      required={true}
                      type="textarea"
                      placeholder={{
                        en: 'Enter app description in English',
                        de: 'App-Beschreibung auf Deutsch eingeben'
                      }}
                    />
                  </div>

                  <div className="col-span-6 sm:col-span-3">
                    <label className="block text-sm font-medium text-gray-700">
                      {t('admin.apps.edit.color', 'Color')}
                    </label>
                    <input
                      type="color"
                      value={app.color}
                      onChange={e => handleInputChange('color', e.target.value)}
                      className="mt-1 block w-full h-10 rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                    />
                  </div>

                  <div className="col-span-6 sm:col-span-3">
                    <label className="block text-sm font-medium text-gray-700">
                      {t('admin.apps.edit.icon', 'Icon')}
                    </label>
                    <input
                      type="text"
                      value={app.icon}
                      onChange={e => handleInputChange('icon', e.target.value)}
                      className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                    />
                  </div>

                  <div className="col-span-6 sm:col-span-3">
                    <label className="block text-sm font-medium text-gray-700">
                      {t('admin.apps.edit.preferredModel', 'Preferred Model')}
                    </label>
                    <select
                      value={app.preferredModel}
                      onChange={e => handleInputChange('preferredModel', e.target.value)}
                      className="mt-1 block w-full rounded-lg border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                    >
                      <option value="">
                        {t('admin.apps.edit.selectModel', 'Select model...')}
                      </option>
                      {availableModels.map(model => (
                        <option key={model.id} value={model.id}>
                          {getLocalizedContent(model.name, currentLanguage)}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="col-span-6 sm:col-span-3">
                    <label className="block text-sm font-medium text-gray-700">
                      {t('admin.apps.edit.temperature', 'Temperature')}
                    </label>
                    <input
                      type="number"
                      min="0"
                      max="2"
                      step="0.1"
                      value={app.preferredTemperature}
                      onChange={e =>
                        handleInputChange('preferredTemperature', parseFloat(e.target.value))
                      }
                      className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                    />
                  </div>

                  <div className="col-span-6 sm:col-span-3">
                    <label className="block text-sm font-medium text-gray-700">
                      {t('admin.apps.edit.tokenLimit', 'Token Limit')}
                    </label>
                    <input
                      type="number"
                      min="1"
                      value={app.tokenLimit}
                      onChange={e => handleInputChange('tokenLimit', parseInt(e.target.value))}
                      className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                    />
                  </div>

                  <div className="col-span-6 sm:col-span-3">
                    <label className="block text-sm font-medium text-gray-700">
                      {t('admin.apps.edit.outputFormat', 'Output Format')}
                    </label>
                    <select
                      value={app.preferredOutputFormat}
                      onChange={e => handleInputChange('preferredOutputFormat', e.target.value)}
                      className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                    >
                      <option value="markdown">{t('appConfig.markdown', 'Markdown')}</option>
                      <option value="text">{t('appConfig.plainText', 'Plain Text')}</option>
                      <option value="json">{t('appConfig.json', 'JSON')}</option>
                    </select>
                  </div>

                  <div className="col-span-6">
                    <div className="flex items-center">
                      <input
                        type="checkbox"
                        checked={app.enabled}
                        onChange={e => handleInputChange('enabled', e.target.checked)}
                        className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
                      />
                      <label className="ml-2 block text-sm text-gray-900">
                        {t('admin.apps.edit.enabled', 'Enabled')}
                      </label>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* System Instructions */}
          <div className="bg-white shadow px-4 py-5 sm:rounded-lg sm:p-6">
            <div className="md:grid md:grid-cols-3 md:gap-6">
              <div className="md:col-span-1">
                <h3 className="text-lg font-medium leading-6 text-gray-900">
                  {t('admin.apps.edit.systemInstructions', 'System Instructions')}
                </h3>
                <p className="mt-1 text-sm text-gray-500">
                  {t(
                    'admin.apps.edit.systemInstructionsDesc',
                    'System prompts that define the app behavior'
                  )}
                </p>
              </div>
              <div className="mt-5 md:col-span-2 md:mt-0">
                <DynamicLanguageEditor
                  label={t('admin.apps.edit.systemInstructions', 'System Instructions')}
                  value={app.system}
                  onChange={value => handleLocalizedChange('system', value)}
                  type="textarea"
                  placeholder={{
                    en: 'Enter system instructions in English',
                    de: 'Systeminstruktionen auf Deutsch eingeben'
                  }}
                  className="mb-6"
                />

                <DynamicLanguageEditor
                  label={t('admin.apps.edit.messagePlaceholder', 'Message Placeholder')}
                  value={app.messagePlaceholder}
                  onChange={value => handleLocalizedChange('messagePlaceholder', value)}
                  placeholder={{
                    en: 'Enter message placeholder in English',
                    de: 'Nachrichtenplatzhalter auf Deutsch eingeben'
                  }}
                  className="mb-6"
                />

                <DynamicLanguageEditor
                  label={t('admin.apps.edit.prompt', 'Prompt Template')}
                  value={app.prompt}
                  onChange={value => handleLocalizedChange('prompt', value)}
                  type="textarea"
                  placeholder={{
                    en: 'Enter prompt template in English',
                    de: 'Prompt-Vorlage auf Deutsch eingeben'
                  }}
                />
              </div>
            </div>
          </div>

          {/* Tools Configuration */}
          <div className="bg-white shadow px-4 py-5 sm:rounded-lg sm:p-6">
            <div className="md:grid md:grid-cols-3 md:gap-6">
              <div className="md:col-span-1">
                <h3 className="text-lg font-medium leading-6 text-gray-900">
                  {t('admin.apps.edit.tools', 'Tools')}
                </h3>
                <p className="mt-1 text-sm text-gray-500">
                  {t(
                    'admin.apps.edit.toolsDesc',
                    'Configure which tools are available for this app'
                  )}
                </p>
              </div>
              <div className="mt-5 md:mt-0 md:col-span-2">
                <ToolsSelector
                  selectedTools={app.tools || []}
                  onToolsChange={tools => handleInputChange('tools', tools)}
                />
              </div>
            </div>
          </div>

          {/* Variables */}
          <div className="bg-white shadow px-4 py-5 sm:rounded-lg sm:p-6">
            <div className="md:grid md:grid-cols-3 md:gap-6">
              <div className="md:col-span-1">
                <h3 className="text-lg font-medium leading-6 text-gray-900">
                  {t('admin.apps.edit.variables', 'Variables')}
                </h3>
                <p className="mt-1 text-sm text-gray-500">
                  {t(
                    'admin.apps.edit.variablesDesc',
                    'Define variables that users can set when using the app'
                  )}
                </p>
              </div>
              <div className="mt-5 md:col-span-2 md:mt-0">
                <div className="space-y-4">
                  {app.variables?.map((variable, index) => (
                    <div key={index} className="border border-gray-200 rounded-lg p-4">
                      <div className="flex justify-between items-start mb-4">
                        <h4 className="text-sm font-medium text-gray-900">
                          {t('admin.apps.edit.variableTitle', 'Variable {{index}}', {
                            index: index + 1
                          })}
                        </h4>
                        <button
                          type="button"
                          onClick={() => removeVariable(index)}
                          className="text-red-600 hover:text-red-900"
                        >
                          <Icon name="x" className="w-5 h-5" />
                        </button>
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className="block text-sm font-medium text-gray-700">
                            {t('admin.apps.edit.variableName', 'Name')}
                          </label>
                          <input
                            type="text"
                            value={variable.name}
                            onChange={e => handleVariableChange(index, 'name', e.target.value)}
                            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                          />
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700">
                            {t('admin.apps.edit.variableType', 'Type')}
                          </label>
                          <select
                            value={variable.type}
                            onChange={e => handleVariableChange(index, 'type', e.target.value)}
                            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                          >
                            <option value="string">String</option>
                            <option value="text">Text</option>
                            <option value="number">Number</option>
                            <option value="boolean">Boolean</option>
                          </select>
                        </div>
                      </div>
                      <div className="mt-4">
                        <DynamicLanguageEditor
                          label={t('admin.apps.edit.variableLabel', 'Label')}
                          value={variable.label}
                          onChange={value => handleVariableChange(index, 'label', value)}
                          required={true}
                          placeholder={{
                            en: 'Enter variable label in English',
                            de: 'Variablenbezeichnung auf Deutsch eingeben'
                          }}
                        />
                      </div>
                      <div className="mt-4">
                        <DynamicLanguageEditor
                          label={t('admin.apps.edit.variableDefaultValue', 'Default Value')}
                          value={variable.defaultValue}
                          onChange={value => handleVariableChange(index, 'defaultValue', value)}
                          placeholder={{
                            en: 'Enter default value in English',
                            de: 'Standardwert auf Deutsch eingeben'
                          }}
                        />
                      </div>
                      <div className="mt-4 flex items-center">
                        <input
                          type="checkbox"
                          checked={variable.required}
                          onChange={e => handleVariableChange(index, 'required', e.target.checked)}
                          className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
                        />
                        <label className="ml-2 block text-sm text-gray-900">
                          {t('admin.apps.edit.variableRequired', 'Required')}
                        </label>
                      </div>

                      {/* Predefined Values Section */}
                      <div className="mt-4">
                        <div className="flex items-center justify-between mb-2">
                          <label className="block text-sm font-medium text-gray-700">
                            {t('admin.apps.edit.predefinedValues', 'Predefined Values')}
                          </label>
                          <button
                            type="button"
                            onClick={() => addPredefinedValue(index)}
                            className="inline-flex items-center px-2 py-1 border border-transparent text-xs font-medium rounded-md text-indigo-700 bg-indigo-100 hover:bg-indigo-200"
                          >
                            <Icon name="plus-circle" className="w-3 h-3 mr-1" />
                            {t('admin.apps.edit.addPredefinedValue', 'Add Option')}
                          </button>
                        </div>

                        {variable.predefinedValues?.map((predefinedValue, valueIndex) => (
                          <div key={valueIndex} className="bg-gray-50 rounded-md p-3 mb-2">
                            <div className="flex items-start justify-between mb-2">
                              <h5 className="text-xs font-medium text-gray-700">
                                {t('admin.apps.edit.option', 'Option {{index}}', {
                                  index: valueIndex + 1
                                })}
                              </h5>
                              <button
                                type="button"
                                onClick={() => removePredefinedValue(index, valueIndex)}
                                className="text-red-500 hover:text-red-700"
                              >
                                <Icon name="x" className="w-3 h-3" />
                              </button>
                            </div>
                            <div className="space-y-2">
                              <div>
                                <label className="block text-xs font-medium text-gray-600 mb-1">
                                  {t('admin.apps.edit.value', 'Value')}
                                </label>
                                <input
                                  type="text"
                                  value={predefinedValue.value}
                                  onChange={e =>
                                    handleVariablePredefinedValueChange(
                                      index,
                                      valueIndex,
                                      'value',
                                      e.target.value
                                    )
                                  }
                                  className="block w-full text-sm rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                                  placeholder={t(
                                    'admin.apps.edit.valuePlaceholder',
                                    'Enter option value'
                                  )}
                                />
                              </div>
                              <div>
                                <DynamicLanguageEditor
                                  label={t('admin.apps.edit.displayLabel', 'Display Label')}
                                  value={predefinedValue.label}
                                  onChange={value =>
                                    handleVariablePredefinedValueChange(
                                      index,
                                      valueIndex,
                                      'label',
                                      value
                                    )
                                  }
                                  placeholder={{
                                    en: 'Enter display label in English',
                                    de: 'Anzeigebezeichnung auf Deutsch eingeben'
                                  }}
                                />
                              </div>
                            </div>
                          </div>
                        ))}

                        {(!variable.predefinedValues || variable.predefinedValues.length === 0) && (
                          <div className="text-xs text-gray-500 italic">
                            {t(
                              'admin.apps.edit.noPredefinedValues',
                              'No predefined values. Add options to create a dropdown selection.'
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={addVariable}
                    className="w-full inline-flex justify-center items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
                  >
                    <Icon name="plus-circle" className="w-5 h-5 mr-2" />
                    {t('admin.apps.edit.addVariable', 'Add Variable')}
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Starter Prompts */}
          <div className="bg-white shadow px-4 py-5 sm:rounded-lg sm:p-6">
            <div className="md:grid md:grid-cols-3 md:gap-6">
              <div className="md:col-span-1">
                <h3 className="text-lg font-medium leading-6 text-gray-900">
                  {t('admin.apps.edit.starterPrompts', 'Starter Prompts')}
                </h3>
                <p className="mt-1 text-sm text-gray-500">
                  {t(
                    'admin.apps.edit.starterPromptsDesc',
                    'Predefined prompts to help users get started'
                  )}
                </p>
              </div>
              <div className="mt-5 md:col-span-2 md:mt-0">
                <div className="space-y-4">
                  {app.starterPrompts?.map((prompt, index) => (
                    <div key={index} className="border border-gray-200 rounded-lg p-4">
                      <div className="flex justify-between items-start mb-4">
                        <h4 className="text-sm font-medium text-gray-900">
                          {t('admin.apps.edit.starterPromptTitle', 'Starter Prompt {{index}}', {
                            index: index + 1
                          })}
                        </h4>
                        <button
                          type="button"
                          onClick={() => removeStarterPrompt(index)}
                          className="text-red-600 hover:text-red-900"
                        >
                          <Icon name="x" className="w-5 h-5" />
                        </button>
                      </div>
                      <div className="space-y-4">
                        <DynamicLanguageEditor
                          label={t('admin.apps.edit.starterPromptTitleField', 'Title')}
                          value={prompt.title}
                          onChange={value => handleStarterPromptChange(index, 'title', value)}
                          required={true}
                          placeholder={{
                            en: 'Enter title in English',
                            de: 'Titel auf Deutsch eingeben'
                          }}
                        />
                        <DynamicLanguageEditor
                          label={t('admin.apps.edit.starterPromptMessage', 'Message')}
                          value={prompt.message}
                          onChange={value => handleStarterPromptChange(index, 'message', value)}
                          required={true}
                          type="textarea"
                          placeholder={{
                            en: 'Enter message in English',
                            de: 'Nachricht auf Deutsch eingeben'
                          }}
                        />
                      </div>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={addStarterPrompt}
                    className="w-full inline-flex justify-center items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
                  >
                    <Icon name="plus-circle" className="w-5 h-5 mr-2" />
                    {t('admin.apps.edit.addStarterPrompt', 'Add Starter Prompt')}
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Settings Configuration */}
          <div className="bg-white shadow px-4 py-5 sm:rounded-lg sm:p-6">
            <div className="md:grid md:grid-cols-3 md:gap-6">
              <div className="md:col-span-1">
                <h3 className="text-lg font-medium leading-6 text-gray-900">
                  {t('admin.apps.edit.settingsConfig', 'Settings Configuration')}
                </h3>
                <p className="mt-1 text-sm text-gray-500">
                  {t(
                    'admin.apps.edit.settingsConfigDesc',
                    'Configure which settings are available to users'
                  )}
                </p>
              </div>
              <div className="mt-5 md:col-span-2 md:mt-0">
                <div className="space-y-4">
                  <div className="flex items-center">
                    <input
                      type="checkbox"
                      checked={app.settings?.enabled}
                      onChange={e =>
                        handleInputChange('settings', {
                          ...app.settings,
                          enabled: e.target.checked
                        })
                      }
                      className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
                    />
                    <label className="ml-2 block text-sm text-gray-900">
                      {t('admin.apps.edit.settingsEnabled', 'Settings Panel Enabled')}
                    </label>
                  </div>

                  {app.settings?.enabled && (
                    <div className="ml-6 space-y-3">
                      <div className="flex items-center">
                        <input
                          type="checkbox"
                          checked={app.settings?.model?.enabled}
                          onChange={e =>
                            handleInputChange('settings', {
                              ...app.settings,
                              model: { ...app.settings.model, enabled: e.target.checked }
                            })
                          }
                          className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
                        />
                        <label className="ml-2 block text-sm text-gray-700">
                          {t('admin.apps.edit.modelSelectionEnabled', 'Model Selection')}
                        </label>
                      </div>

                      <div className="flex items-center">
                        <input
                          type="checkbox"
                          checked={app.settings?.temperature?.enabled}
                          onChange={e =>
                            handleInputChange('settings', {
                              ...app.settings,
                              temperature: {
                                ...app.settings.temperature,
                                enabled: e.target.checked
                              }
                            })
                          }
                          className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
                        />
                        <label className="ml-2 block text-sm text-gray-700">
                          {t('admin.apps.edit.temperatureEnabled', 'Temperature Control')}
                        </label>
                      </div>

                      <div className="flex items-center">
                        <input
                          type="checkbox"
                          checked={app.settings?.outputFormat?.enabled}
                          onChange={e =>
                            handleInputChange('settings', {
                              ...app.settings,
                              outputFormat: {
                                ...app.settings.outputFormat,
                                enabled: e.target.checked
                              }
                            })
                          }
                          className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
                        />
                        <label className="ml-2 block text-sm text-gray-700">
                          {t('admin.apps.edit.outputFormatEnabled', 'Output Format Selection')}
                        </label>
                      </div>

                      <div className="flex items-center">
                        <input
                          type="checkbox"
                          checked={app.settings?.chatHistory?.enabled}
                          onChange={e =>
                            handleInputChange('settings', {
                              ...app.settings,
                              chatHistory: {
                                ...app.settings.chatHistory,
                                enabled: e.target.checked
                              }
                            })
                          }
                          className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
                        />
                        <label className="ml-2 block text-sm text-gray-700">
                          {t('admin.apps.edit.chatHistoryEnabled', 'Chat History Control')}
                        </label>
                      </div>

                      <div className="flex items-center">
                        <input
                          type="checkbox"
                          checked={app.settings?.style?.enabled}
                          onChange={e =>
                            handleInputChange('settings', {
                              ...app.settings,
                              style: { ...app.settings.style, enabled: e.target.checked }
                            })
                          }
                          className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
                        />
                        <label className="ml-2 block text-sm text-gray-700">
                          {t('admin.apps.edit.styleEnabled', 'Style Selection')}
                        </label>
                      </div>

                      {/* Speech Recognition Settings */}
                      <div className="mt-6">
                        <h4 className="text-sm font-medium text-gray-900 mb-3">
                          {t('admin.apps.edit.speechRecognition', 'Speech Recognition')}
                        </h4>
                        <div className="space-y-4">
                          <div>
                            <label className="block text-sm font-medium text-gray-700">
                              {t('admin.apps.edit.speechService', 'Speech Service')}
                            </label>
                            <select
                              value={app.settings?.speechRecognition?.service}
                              onChange={e =>
                                handleInputChange('settings', {
                                  ...app.settings,
                                  speechRecognition: {
                                    ...app.settings.speechRecognition,
                                    service: e.target.value
                                  }
                                })
                              }
                              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                            >
                              <option value="default">
                                {t('admin.apps.edit.defaultService', 'Default (Browser)')}
                              </option>
                              <option value="azure">
                                {t('admin.apps.edit.azureService', 'Azure Speech Recognition')}
                              </option>
                            </select>
                          </div>

                          {app.settings?.speechRecognition?.service === 'azure' && (
                            <div>
                              <label className="block text-sm font-medium text-gray-700">
                                {t('admin.apps.edit.azureHost', 'Azure Host')}
                              </label>
                              <input
                                type="text"
                                value={app.settings?.speechRecognition?.host}
                                onChange={e =>
                                  handleInputChange('settings', {
                                    ...app.settings,
                                    speechRecognition: {
                                      ...app.settings.speechRecognition,
                                      host: e.target.value
                                    }
                                  })
                                }
                                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                                placeholder={t(
                                  'admin.apps.edit.azureHostPlaceholder',
                                  'e.g., https://your-resource.cognitiveservices.azure.com'
                                )}
                              />
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* General Settings */}
          <div className="bg-white shadow px-4 py-5 sm:rounded-lg sm:p-6">
            <div className="md:grid md:grid-cols-3 md:gap-6">
              <div className="md:col-span-1">
                <h3 className="text-lg font-medium leading-6 text-gray-900">
                  {t('admin.apps.edit.generalSettings', 'General Settings')}
                </h3>
                <p className="mt-1 text-sm text-gray-500">
                  {t('admin.apps.edit.generalSettingsDesc', 'Configure general app behavior')}
                </p>
              </div>
              <div className="mt-5 md:col-span-2 md:mt-0">
                <div className="space-y-4">
                  <div className="flex items-center">
                    <input
                      type="checkbox"
                      checked={app.allowEmptyContent}
                      onChange={e => handleInputChange('allowEmptyContent', e.target.checked)}
                      className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
                    />
                    <label className="ml-2 block text-sm text-gray-700">
                      {t('admin.apps.edit.allowEmptyContent', 'Allow Empty Content')}
                    </label>
                  </div>

                  <div className="flex items-center">
                    <input
                      type="checkbox"
                      checked={app.sendChatHistory}
                      onChange={e => handleInputChange('sendChatHistory', e.target.checked)}
                      className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
                    />
                    <label className="ml-2 block text-sm text-gray-700">
                      {t('admin.apps.edit.sendChatHistory', 'Send Chat History')}
                    </label>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Greeting Configuration */}
          <div className="bg-white shadow px-4 py-5 sm:rounded-lg sm:p-6">
            <div className="md:grid md:grid-cols-3 md:gap-6">
              <div className="md:col-span-1">
                <h3 className="text-lg font-medium leading-6 text-gray-900">
                  {t('admin.apps.edit.greeting', 'Greeting')}
                </h3>
                <p className="mt-1 text-sm text-gray-500">
                  {t(
                    'admin.apps.edit.greetingDesc',
                    'Configure the initial greeting message displayed to users'
                  )}
                </p>
              </div>
              <div className="mt-5 md:col-span-2 md:mt-0">
                <div className="space-y-4">
                  <div>
                    <DynamicLanguageEditor
                      label={t('admin.apps.edit.greetingTitle', 'Title')}
                      value={app.greeting || {}}
                      onChange={value => handleInputChange('greeting', value)}
                      placeholder={{
                        en: 'Enter greeting title in English',
                        de: 'Begrüßungstitel auf Deutsch eingeben'
                      }}
                      fieldType="title"
                    />
                  </div>

                  <div>
                    <DynamicLanguageEditor
                      label={t('admin.apps.edit.greetingSubtitle', 'Subtitle')}
                      value={app.greeting || {}}
                      onChange={value => handleInputChange('greeting', value)}
                      placeholder={{
                        en: 'Enter greeting subtitle in English',
                        de: 'Begrüßungsuntertitel auf Deutsch eingeben'
                      }}
                      fieldType="subtitle"
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Magic Prompt Configuration */}
          <div className="bg-white shadow px-4 py-5 sm:rounded-lg sm:p-6">
            <div className="md:grid md:grid-cols-3 md:gap-6">
              <div className="md:col-span-1">
                <h3 className="text-lg font-medium leading-6 text-gray-900">
                  {t('admin.apps.edit.magicPrompt', 'Magic Prompt')}
                </h3>
                <p className="mt-1 text-sm text-gray-500">
                  {t('admin.apps.edit.magicPromptDesc', 'Configure automatic prompt enhancement')}
                </p>
              </div>
              <div className="mt-5 md:col-span-2 md:mt-0">
                <div className="space-y-4">
                  <div className="flex items-center">
                    <input
                      type="checkbox"
                      checked={app.features?.magicPrompt?.enabled}
                      onChange={e =>
                        handleInputChange('features', {
                          ...app.features,
                          magicPrompt: {
                            ...app.features?.magicPrompt,
                            enabled: e.target.checked
                          }
                        })
                      }
                      className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
                    />
                    <label className="ml-2 block text-sm text-gray-700">
                      {t('admin.apps.edit.magicPromptEnabled', 'Enable Magic Prompt')}
                    </label>
                  </div>

                  {app.features?.magicPrompt?.enabled && (
                    <>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">
                          {t('admin.apps.edit.magicPromptModel', 'Model')}
                        </label>
                        <select
                          value={app.features?.magicPrompt?.model}
                          onChange={e =>
                            handleInputChange('features', {
                              ...app.features,
                              magicPrompt: {
                                ...app.features?.magicPrompt,
                                model: e.target.value
                              }
                            })
                          }
                          className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                        >
                          {availableModels.map(model => (
                            <option key={model.id} value={model.id}>
                              {getLocalizedContent(model.name, currentLanguage)}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-gray-700">
                          {t('admin.apps.edit.magicPromptPrompt', 'Enhancement Prompt')}
                        </label>
                        <textarea
                          value={app.features?.magicPrompt?.prompt}
                          onChange={e =>
                            handleInputChange('features', {
                              ...app.features,
                              magicPrompt: {
                                ...app.features?.magicPrompt,
                                prompt: e.target.value
                              }
                            })
                          }
                          rows={4}
                          className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                          placeholder={t(
                            'admin.apps.edit.magicPromptPromptPlaceholder',
                            'Enter the system prompt for enhancing user prompts'
                          )}
                        />
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Input Mode Configuration */}
          <div className="bg-white shadow px-4 py-5 sm:rounded-lg sm:p-6">
            <div className="md:grid md:grid-cols-3 md:gap-6">
              <div className="md:col-span-1">
                <h3 className="text-lg font-medium leading-6 text-gray-900">
                  {t('admin.apps.edit.inputMode', 'Input Mode')}
                </h3>
                <p className="mt-1 text-sm text-gray-500">
                  {t('admin.apps.edit.inputModeDesc', 'Configure how users input text and audio')}
                </p>
              </div>
              <div className="mt-5 md:col-span-2 md:mt-0">
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700">
                      {t('admin.apps.edit.inputType', 'Input Type')}
                    </label>
                    <select
                      value={app.inputMode?.type}
                      onChange={e =>
                        handleInputChange('inputMode', { ...app.inputMode, type: e.target.value })
                      }
                      className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                    >
                      <option value="singleline">
                        {t('admin.apps.edit.singleline', 'Single Line')}
                      </option>
                      <option value="multiline">
                        {t('admin.apps.edit.multiline', 'Multi Line')}
                      </option>
                    </select>
                  </div>

                  {app.inputMode?.type === 'multiline' && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700">
                        {t('admin.apps.edit.rows', 'Rows')}
                      </label>
                      <input
                        type="number"
                        min="1"
                        max="20"
                        value={app.inputMode?.rows}
                        onChange={e =>
                          handleInputChange('inputMode', {
                            ...app.inputMode,
                            rows: parseInt(e.target.value)
                          })
                        }
                        className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                      />
                    </div>
                  )}

                  <div>
                    <h4 className="text-sm font-medium text-gray-900 mb-3">
                      {t('admin.apps.edit.microphoneConfig', 'Microphone Configuration')}
                    </h4>
                    <div className="space-y-3">
                      <div className="flex items-center">
                        <input
                          type="checkbox"
                          checked={app.inputMode?.microphone?.enabled}
                          onChange={e =>
                            handleInputChange('inputMode', {
                              ...app.inputMode,
                              microphone: { ...app.inputMode.microphone, enabled: e.target.checked }
                            })
                          }
                          className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
                        />
                        <label className="ml-2 block text-sm text-gray-700">
                          {t('admin.apps.edit.microphoneEnabled', 'Microphone Enabled')}
                        </label>
                      </div>

                      {app.inputMode?.microphone?.enabled && (
                        <>
                          <div>
                            <label className="block text-sm font-medium text-gray-700">
                              {t('admin.apps.edit.microphoneMode', 'Microphone Mode')}
                            </label>
                            <select
                              value={app.inputMode?.microphone?.mode}
                              onChange={e =>
                                handleInputChange('inputMode', {
                                  ...app.inputMode,
                                  microphone: { ...app.inputMode.microphone, mode: e.target.value }
                                })
                              }
                              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                            >
                              <option value="manual">
                                {t('admin.apps.edit.manualMode', 'Manual')}
                              </option>
                              <option value="auto">{t('admin.apps.edit.autoMode', 'Auto')}</option>
                            </select>
                          </div>

                          <div className="flex items-center">
                            <input
                              type="checkbox"
                              checked={app.inputMode?.microphone?.showTranscript}
                              onChange={e =>
                                handleInputChange('inputMode', {
                                  ...app.inputMode,
                                  microphone: {
                                    ...app.inputMode.microphone,
                                    showTranscript: e.target.checked
                                  }
                                })
                              }
                              className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
                            />
                            <label className="ml-2 block text-sm text-gray-700">
                              {t('admin.apps.edit.showTranscript', 'Show Transcript')}
                            </label>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Image Upload Configuration */}
          <div className="bg-white shadow px-4 py-5 sm:rounded-lg sm:p-6">
            <div className="md:grid md:grid-cols-3 md:gap-6">
              <div className="md:col-span-1">
                <h3 className="text-lg font-medium leading-6 text-gray-900">
                  {t('admin.apps.edit.imageUpload', 'Image Upload')}
                </h3>
                <p className="mt-1 text-sm text-gray-500">
                  {t('admin.apps.edit.imageUploadDesc', 'Configure image upload functionality')}
                </p>
              </div>
              <div className="mt-5 md:col-span-2 md:mt-0">
                <div className="space-y-4">
                  <div className="flex items-center">
                    <input
                      type="checkbox"
                      checked={app.imageUpload?.enabled}
                      onChange={e =>
                        handleInputChange('imageUpload', {
                          ...app.imageUpload,
                          enabled: e.target.checked
                        })
                      }
                      className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
                    />
                    <label className="ml-2 block text-sm text-gray-900">
                      {t('admin.apps.edit.imageUploadEnabled', 'Image Upload Enabled')}
                    </label>
                  </div>

                  {app.imageUpload?.enabled && (
                    <div className="ml-6 space-y-4">
                      <div className="flex items-center">
                        <input
                          type="checkbox"
                          checked={app.imageUpload?.resizeImages}
                          onChange={e =>
                            handleInputChange('imageUpload', {
                              ...app.imageUpload,
                              resizeImages: e.target.checked
                            })
                          }
                          className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
                        />
                        <label className="ml-2 block text-sm text-gray-700">
                          {t('admin.apps.edit.resizeImages', 'Resize Images')}
                        </label>
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-gray-700">
                          {t('admin.apps.edit.maxImageSize', 'Max Image Size (MB)')}
                        </label>
                        <input
                          type="number"
                          min="1"
                          max="100"
                          value={app.imageUpload?.maxFileSizeMB}
                          onChange={e =>
                            handleInputChange('imageUpload', {
                              ...app.imageUpload,
                              maxFileSizeMB: parseInt(e.target.value)
                            })
                          }
                          className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                        />
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                          {t('admin.apps.edit.supportedImageFormats', 'Supported Image Formats')}
                        </label>
                        <div className="space-y-2">
                          {app.imageUpload?.supportedFormats?.map((format, index) => (
                            <div key={index} className="flex items-center gap-2">
                              <input
                                type="text"
                                value={format}
                                onChange={e =>
                                  updateListItem(
                                    'imageUpload',
                                    'supportedFormats',
                                    index,
                                    e.target.value
                                  )
                                }
                                className="flex-1 rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                                placeholder={t(
                                  'admin.apps.edit.formatPlaceholder',
                                  'e.g., image/jpeg'
                                )}
                              />
                              <button
                                type="button"
                                onClick={() =>
                                  removeFromList('imageUpload', 'supportedFormats', index)
                                }
                                className="text-red-500 hover:text-red-700"
                              >
                                <Icon name="x" className="w-4 h-4" />
                              </button>
                            </div>
                          ))}
                          <button
                            type="button"
                            onClick={() =>
                              addToList('imageUpload', 'supportedFormats', 'image/jpeg')
                            }
                            className="inline-flex items-center px-2 py-1 border border-transparent text-xs font-medium rounded-md text-indigo-700 bg-indigo-100 hover:bg-indigo-200"
                          >
                            <Icon name="plus-circle" className="w-3 h-3 mr-1" />
                            {t('admin.apps.edit.addFormat', 'Add Format')}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* File Upload Configuration */}
          <div className="bg-white shadow px-4 py-5 sm:rounded-lg sm:p-6">
            <div className="md:grid md:grid-cols-3 md:gap-6">
              <div className="md:col-span-1">
                <h3 className="text-lg font-medium leading-6 text-gray-900">
                  {t('admin.apps.edit.fileUpload', 'File Upload')}
                </h3>
                <p className="mt-1 text-sm text-gray-500">
                  {t(
                    'admin.apps.edit.fileUploadDesc',
                    'Configure file upload settings and supported formats'
                  )}
                </p>
              </div>
              <div className="mt-5 md:col-span-2 md:mt-0">
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700">
                      {t('admin.apps.edit.maxFileSize', 'Max File Size (MB)')}
                    </label>
                    <input
                      type="number"
                      min="1"
                      max="100"
                      value={app.fileUpload?.maxFileSizeMB}
                      onChange={e =>
                        handleInputChange('fileUpload', {
                          ...app.fileUpload,
                          maxFileSizeMB: parseInt(e.target.value)
                        })
                      }
                      className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      {t('admin.apps.edit.supportedTextFormats', 'Supported Text Formats')}
                    </label>
                    <div className="space-y-2">
                      {app.fileUpload?.supportedTextFormats?.map((format, index) => (
                        <div key={index} className="flex items-center gap-2">
                          <input
                            type="text"
                            value={format}
                            onChange={e =>
                              updateListItem(
                                'fileUpload',
                                'supportedTextFormats',
                                index,
                                e.target.value
                              )
                            }
                            className="flex-1 rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                            placeholder={t(
                              'admin.apps.edit.textFormatPlaceholder',
                              'e.g., text/plain'
                            )}
                          />
                          <button
                            type="button"
                            onClick={() =>
                              removeFromList('fileUpload', 'supportedTextFormats', index)
                            }
                            className="text-red-500 hover:text-red-700"
                          >
                            <Icon name="x" className="w-4 h-4" />
                          </button>
                        </div>
                      ))}
                      <button
                        type="button"
                        onClick={() =>
                          addToList('fileUpload', 'supportedTextFormats', 'text/plain')
                        }
                        className="inline-flex items-center px-2 py-1 border border-transparent text-xs font-medium rounded-md text-indigo-700 bg-indigo-100 hover:bg-indigo-200"
                      >
                        <Icon name="plus-circle" className="w-3 h-3 mr-1" />
                        {t('admin.apps.edit.addTextFormat', 'Add Text Format')}
                      </button>
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      {t('admin.apps.edit.supportedPdfFormats', 'Supported PDF Formats')}
                    </label>
                    <div className="space-y-2">
                      {app.fileUpload?.supportedPdfFormats?.map((format, index) => (
                        <div key={index} className="flex items-center gap-2">
                          <input
                            type="text"
                            value={format}
                            onChange={e =>
                              updateListItem(
                                'fileUpload',
                                'supportedPdfFormats',
                                index,
                                e.target.value
                              )
                            }
                            className="flex-1 rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                            placeholder={t(
                              'admin.apps.edit.pdfFormatPlaceholder',
                              'e.g., application/pdf'
                            )}
                          />
                          <button
                            type="button"
                            onClick={() =>
                              removeFromList('fileUpload', 'supportedPdfFormats', index)
                            }
                            className="text-red-500 hover:text-red-700"
                          >
                            <Icon name="x" className="w-4 h-4" />
                          </button>
                        </div>
                      ))}
                      <button
                        type="button"
                        onClick={() =>
                          addToList('fileUpload', 'supportedPdfFormats', 'application/pdf')
                        }
                        className="inline-flex items-center px-2 py-1 border border-transparent text-xs font-medium rounded-md text-indigo-700 bg-indigo-100 hover:bg-indigo-200"
                      >
                        <Icon name="plus-circle" className="w-3 h-3 mr-1" />
                        {t('admin.apps.edit.addPdfFormat', 'Add PDF Format')}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Save Button */}
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => navigate('/admin/apps')}
              className="bg-white py-2 px-4 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
            >
              {t('admin.apps.edit.cancel', 'Cancel')}
            </button>
            <button
              type="submit"
              disabled={saving}
              className="ml-3 inline-flex justify-center py-2 px-4 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50"
            >
              {saving
                ? t('admin.apps.edit.saving', 'Saving...')
                : t('admin.apps.edit.save', 'Save App')}
            </button>
          </div>
        </form>
      </div>
    </AdminAuth>
  );
};

export default AdminAppEditPage;
