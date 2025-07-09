import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import DynamicLanguageEditor from '../components/DynamicLanguageEditor';
import Icon from '../components/Icon';

const AdminAppEditPage = () => {
  const { t } = useTranslation();
  const { appId } = useParams();
  const navigate = useNavigate();
  const [app, setApp] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [availableModels, setAvailableModels] = useState([]);

  useEffect(() => {
    // Load available models
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

    loadModels();
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
        sendChatHistory: true,
        enabled: true,
        order: 0,
        messagePlaceholder: { en: '' },
        prompt: { en: '' },
        variables: [],
        starterPrompts: []
      });
      setLoading(false);
    } else {
      loadApp();
    }
  }, [appId]);

  const loadApp = async () => {
    try {
      setLoading(true);
      const response = await fetch(`/api/admin/apps/${appId}`);
      if (!response.ok) {
        throw new Error('Failed to load app');
      }
      const data = await response.json();
      setApp(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async (e) => {
    e.preventDefault();
    
    if (!app.id) {
      setError('App ID is required');
      return;
    }

    try {
      setSaving(true);
      const method = appId === 'new' ? 'POST' : 'PUT';
      const url = appId === 'new' ? `/api/admin/apps` : `/api/admin/apps/${appId}`;
      
      const response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(app),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to save app');
      }

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

  const addVariable = () => {
    setApp(prev => ({
      ...prev,
      variables: [...(prev.variables || []), {
        name: '',
        label: { en: '' },
        type: 'string',
        required: false,
        defaultValue: { en: '' }
      }]
    }));
  };

  const removeVariable = (index) => {
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
      starterPrompts: [...(prev.starterPrompts || []), {
        title: { en: '' },
        message: { en: '' },
        variables: {}
      }]
    }));
  };

  const removeStarterPrompt = (index) => {
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
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
              </svg>
            </div>
            <div className="ml-3">
              <h3 className="text-sm font-medium text-red-800">
                {t('admin.apps.errorTitle', 'Error')}
              </h3>
              <div className="mt-2 text-sm text-red-700">
                {error}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="sm:flex sm:items-center">
        <div className="sm:flex-auto">
          <h1 className="text-2xl font-semibold text-gray-900">
            {appId === 'new' 
              ? t('admin.apps.edit.titleNew', 'Add New App')
              : t('admin.apps.edit.titleEdit', 'Edit App')
            }
          </h1>
          <p className="mt-2 text-sm text-gray-700">
            {appId === 'new'
              ? t('admin.apps.edit.subtitleNew', 'Configure a new AI Hub application')
              : t('admin.apps.edit.subtitleEdit', 'Modify app settings and configuration')
            }
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
                    onChange={(e) => handleInputChange('id', e.target.value)}
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
                    onChange={(e) => handleInputChange('order', parseInt(e.target.value) || 0)}
                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                  />
                </div>

                <div className="col-span-6">
                  <DynamicLanguageEditor
                    label={t('admin.apps.edit.name', 'Name')}
                    value={app.name}
                    onChange={(value) => handleLocalizedChange('name', value)}
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
                    onChange={(value) => handleLocalizedChange('description', value)}
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
                    onChange={(e) => handleInputChange('color', e.target.value)}
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
                    onChange={(e) => handleInputChange('icon', e.target.value)}
                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                  />
                </div>

                <div className="col-span-6 sm:col-span-3">
                  <label className="block text-sm font-medium text-gray-700">
                    {t('admin.apps.edit.preferredModel', 'Preferred Model')}
                  </label>
                  <select
                    value={app.preferredModel}
                    onChange={(e) => handleInputChange('preferredModel', e.target.value)}
                    className="mt-1 block w-full rounded-lg border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                  >
                    <option value="">{t('admin.apps.edit.selectModel', 'Select model...')}</option>
                    {availableModels.map(model => (
                      <option key={model.id} value={model.id}>
                        {model.name}
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
                    onChange={(e) => handleInputChange('preferredTemperature', parseFloat(e.target.value))}
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
                    onChange={(e) => handleInputChange('tokenLimit', parseInt(e.target.value))}
                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                  />
                </div>

                <div className="col-span-6 sm:col-span-3">
                  <label className="block text-sm font-medium text-gray-700">
                    {t('admin.apps.edit.outputFormat', 'Output Format')}
                  </label>
                  <select
                    value={app.preferredOutputFormat}
                    onChange={(e) => handleInputChange('preferredOutputFormat', e.target.value)}
                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                  >
                    <option value="markdown">Markdown</option>
                    <option value="text">Plain Text</option>
                    <option value="json">JSON</option>
                  </select>
                </div>

                <div className="col-span-6">
                  <div className="flex items-center">
                    <input
                      type="checkbox"
                      checked={app.enabled}
                      onChange={(e) => handleInputChange('enabled', e.target.checked)}
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
                {t('admin.apps.edit.systemInstructionsDesc', 'System prompts that define the app behavior')}
              </p>
            </div>
            <div className="mt-5 md:col-span-2 md:mt-0">
              <DynamicLanguageEditor
                label={t('admin.apps.edit.systemInstructions', 'System Instructions')}
                value={app.system}
                onChange={(value) => handleLocalizedChange('system', value)}
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
                onChange={(value) => handleLocalizedChange('messagePlaceholder', value)}
                placeholder={{
                  en: 'Enter message placeholder in English',
                  de: 'Nachrichtenplatzhalter auf Deutsch eingeben'
                }}
                className="mb-6"
              />
              
              <DynamicLanguageEditor
                label={t('admin.apps.edit.prompt', 'Prompt Template')}
                value={app.prompt}
                onChange={(value) => handleLocalizedChange('prompt', value)}
                type="textarea"
                placeholder={{
                  en: 'Enter prompt template in English',
                  de: 'Prompt-Vorlage auf Deutsch eingeben'
                }}
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
                {t('admin.apps.edit.variablesDesc', 'Define variables that users can set when using the app')}
              </p>
            </div>
            <div className="mt-5 md:col-span-2 md:mt-0">
              <div className="space-y-4">
                {app.variables?.map((variable, index) => (
                  <div key={index} className="border border-gray-200 rounded-lg p-4">
                    <div className="flex justify-between items-start mb-4">
                      <h4 className="text-sm font-medium text-gray-900">
                        {t('admin.apps.edit.variableTitle', 'Variable {{index}}', { index: index + 1 })}
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
                          onChange={(e) => handleVariableChange(index, 'name', e.target.value)}
                          className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">
                          {t('admin.apps.edit.variableType', 'Type')}
                        </label>
                        <select
                          value={variable.type}
                          onChange={(e) => handleVariableChange(index, 'type', e.target.value)}
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
                        onChange={(value) => handleVariableChange(index, 'label', value)}
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
                        onChange={(value) => handleVariableChange(index, 'defaultValue', value)}
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
                        onChange={(e) => handleVariableChange(index, 'required', e.target.checked)}
                        className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
                      />
                      <label className="ml-2 block text-sm text-gray-900">
                        {t('admin.apps.edit.variableRequired', 'Required')}
                      </label>
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
                {t('admin.apps.edit.starterPromptsDesc', 'Predefined prompts to help users get started')}
              </p>
            </div>
            <div className="mt-5 md:col-span-2 md:mt-0">
              <div className="space-y-4">
                {app.starterPrompts?.map((prompt, index) => (
                  <div key={index} className="border border-gray-200 rounded-lg p-4">
                    <div className="flex justify-between items-start mb-4">
                      <h4 className="text-sm font-medium text-gray-900">
                        {t('admin.apps.edit.starterPromptTitle', 'Starter Prompt {{index}}', { index: index + 1 })}
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
                        onChange={(value) => handleStarterPromptChange(index, 'title', value)}
                        required={true}
                        placeholder={{
                          en: 'Enter title in English',
                          de: 'Titel auf Deutsch eingeben'
                        }}
                      />
                      <DynamicLanguageEditor
                        label={t('admin.apps.edit.starterPromptMessage', 'Message')}
                        value={prompt.message}
                        onChange={(value) => handleStarterPromptChange(index, 'message', value)}
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
              : t('admin.apps.edit.save', 'Save App')
            }
          </button>
        </div>
      </form>
    </div>
  );
};

export default AdminAppEditPage;