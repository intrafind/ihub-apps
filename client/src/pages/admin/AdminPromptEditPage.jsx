import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../components/Icon';
import AdminNavigation from '../../components/AdminNavigation';
import DynamicLanguageEditor from '../../components/DynamicLanguageEditor';
import SearchableAppsSelector from '../../components/SearchableAppsSelector';
import { getLocalizedContent } from '../../utils/localizeContent';
import { fetchAdminPrompts, createPrompt, updatePrompt, clearApiCache, fetchAdminApps } from '../../api/api';

const AdminPromptEditPage = () => {
  const { t, i18n } = useTranslation();
  const { promptId } = useParams();
  const navigate = useNavigate();
  const isNewPrompt = promptId === 'new';
  const currentLanguage = i18n.language;
  
  const [prompt, setPrompt] = useState({
    id: '',
    name: { en: '' },
    description: { en: '' },
    prompt: { en: '' },
    icon: 'clipboard',
    enabled: true,
    order: undefined,
    appId: '',
    variables: [],
    category: 'creative'
  });

  const [loading, setLoading] = useState(!isNewPrompt);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [apps, setApps] = useState([]);
  const [uiConfig, setUiConfig] = useState(null);

  useEffect(() => {
    // Load apps for the appId dropdown and UI config
    loadApps();
    loadUIConfig();
    
    if (!isNewPrompt) {
      loadPrompt();
    }
  }, [promptId]);

  const loadApps = async () => {
    try {
      const data = await fetchAdminApps();
      setApps(data);
    } catch (err) {
      console.error('Error loading apps:', err);
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

  const loadPrompt = async () => {
    try {
      setLoading(true);
      const data = await fetchAdminPrompts();
      const promptData = data.find(p => p.id === promptId);
      
      if (!promptData) {
        throw new Error('Prompt not found');
      }
      
      // Ensure proper structure for editing
      const processedPrompt = {
        ...promptData,
        name: promptData.name || { en: '' },
        description: promptData.description || { en: '' },
        prompt: promptData.prompt || { en: '' },
        variables: promptData.variables || [],
        appId: promptData.appId || '',
        order: promptData.order,
        enabled: promptData.enabled !== false
      };
      
      setPrompt(processedPrompt);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    // Validate required fields
    if (!prompt.id || !prompt.name.en || !prompt.prompt.en) {
      alert(t('admin.prompts.edit.requiredFields', 'Please fill in all required fields'));
      return;
    }
    
    // Validate ID format
    if (!/^[a-z0-9-]+$/.test(prompt.id)) {
      alert(t('admin.prompts.edit.invalidId', 'ID must contain only lowercase letters, numbers, and hyphens'));
      return;
    }
    
    try {
      setSaving(true);
      
      if (isNewPrompt) {
        await createPrompt(prompt);
      } else {
        await updatePrompt(promptId, prompt);
      }
      
      // Clear cache to force refresh
      clearApiCache('admin_prompts');
      clearApiCache('prompts');
      
      // Redirect to prompts list
      navigate('/admin/prompts');
    } catch (err) {
      console.error('Error saving prompt:', err);
      alert(`Error: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleVariableChange = (index, field, value) => {
    setPrompt(prev => ({
      ...prev,
      variables: prev.variables.map((variable, i) => 
        i === index ? { ...variable, [field]: value } : variable
      )
    }));
  };

  const addVariable = () => {
    setPrompt(prev => ({
      ...prev,
      variables: [...prev.variables, {
        name: '',
        label: { en: '' },
        type: 'string',
        required: false,
        defaultValue: ''
      }]
    }));
  };

  const removeVariable = (index) => {
    setPrompt(prev => ({
      ...prev,
      variables: prev.variables.filter((_, i) => i !== index)
    }));
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="bg-red-50 border border-red-200 rounded-md p-4">
          <div className="flex">
            <Icon name="exclamation-triangle" className="h-5 w-5 text-red-400" />
            <div className="ml-3">
              <h3 className="text-sm font-medium text-red-800">
                {t('admin.prompts.edit.loadError', 'Error loading prompt')}
              </h3>
              <p className="mt-1 text-sm text-red-700">{error}</p>
              <button
                onClick={() => navigate('/admin/prompts')}
                className="mt-2 text-sm text-red-600 hover:text-red-500"
              >
                {t('admin.prompts.edit.backToList', 'Back to Prompts')}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <AdminNavigation />
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-8">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900">
              {isNewPrompt 
                ? t('admin.prompts.edit.createTitle', 'Create New Prompt')
                : t('admin.prompts.edit.editTitle', 'Edit Prompt')
              }
            </h1>
            <p className="mt-1 text-sm text-gray-600">
              {isNewPrompt 
                ? t('admin.prompts.edit.createDesc', 'Create a new prompt for your AI Hub Apps')
                : t('admin.prompts.edit.editDesc', 'Edit the prompt details and configuration')
              }
            </p>
          </div>
          <button
            onClick={() => navigate('/admin/prompts')}
            className="inline-flex items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
          >
            <Icon name="arrow-left" className="h-4 w-4 mr-2" />
            {t('admin.prompts.edit.backToList', 'Back to Prompts')}
          </button>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-8">
        {/* Basic Information */}
        <div className="bg-white shadow px-4 py-5 sm:rounded-lg sm:p-6">
          <div className="md:grid md:grid-cols-3 md:gap-6">
            <div className="md:col-span-1">
              <h3 className="text-lg font-medium leading-6 text-gray-900">
                {t('admin.prompts.edit.basicInfo', 'Basic Information')}
              </h3>
              <p className="mt-1 text-sm text-gray-500">
                {t('admin.prompts.edit.basicInfoDesc', 'Basic prompt identification and metadata')}
              </p>
            </div>
            <div className="mt-5 md:col-span-2 md:mt-0">
              <div className="grid grid-cols-6 gap-6">
                {/* ID */}
                <div className="col-span-6 sm:col-span-3">
                  <label htmlFor="id" className="block text-sm font-medium text-gray-700">
                    {t('admin.prompts.edit.id', 'ID')} <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    id="id"
                    value={prompt.id}
                    onChange={(e) => setPrompt(prev => ({ ...prev, id: e.target.value }))}
                    disabled={!isNewPrompt}
                    className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm disabled:bg-gray-100"
                    placeholder="unique-prompt-id"
                    autoComplete="off"
                  />
                  <p className="mt-2 text-sm text-gray-500">
                    {t('admin.prompts.edit.idDesc', 'Unique identifier using lowercase letters, numbers, and hyphens')}
                  </p>
                </div>

                {/* Icon */}
                <div className="col-span-6 sm:col-span-3">
                  <label htmlFor="icon" className="block text-sm font-medium text-gray-700">
                    {t('admin.prompts.edit.icon', 'Icon')}
                  </label>
                  <input
                    type="text"
                    id="icon"
                    value={prompt.icon}
                    onChange={(e) => setPrompt(prev => ({ ...prev, icon: e.target.value }))}
                    className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
                    placeholder="clipboard"
                    autoComplete="off"
                  />
                  <p className="mt-2 text-sm text-gray-500">
                    {t('admin.prompts.edit.iconDesc', 'Heroicon name for the prompt')}
                  </p>
                </div>

                {/* Order */}
                <div className="col-span-6 sm:col-span-3">
                  <label htmlFor="order" className="block text-sm font-medium text-gray-700">
                    {t('admin.prompts.edit.order', 'Order')}
                  </label>
                  <input
                    type="number"
                    id="order"
                    value={prompt.order || ''}
                    onChange={(e) => setPrompt(prev => ({ ...prev, order: e.target.value ? parseInt(e.target.value) : undefined }))}
                    className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
                    placeholder="0"
                    autoComplete="off"
                  />
                  <p className="mt-2 text-sm text-gray-500">
                    {t('admin.prompts.edit.orderDesc', 'Display order in the prompts list')}
                  </p>
                </div>

                {/* Category */}
                <div className="col-span-6 sm:col-span-3">
                  <label htmlFor="category" className="block text-sm font-medium text-gray-700">
                    {t('admin.prompts.edit.category', 'Category')}
                  </label>
                  <select
                    id="category"
                    value={prompt.category || ''}
                    onChange={(e) => setPrompt(prev => ({ ...prev, category: e.target.value }))}
                    className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
                  >
                    <option value="">{t('admin.prompts.edit.selectCategory', 'Select category...')}</option>
                    {uiConfig?.promptsList?.categories?.list?.filter(cat => cat.id !== 'all').map(category => (
                      <option key={category.id} value={category.id}>
                        {getLocalizedContent(category.name, currentLanguage)}
                      </option>
                    ))}
                  </select>
                  <p className="mt-2 text-sm text-gray-500">
                    {t('admin.prompts.edit.categoryDesc', 'Category for organizing prompts')}
                  </p>
                </div>

                {/* App ID */}
                <div className="col-span-6 sm:col-span-3">
                  <label htmlFor="appId" className="block text-sm font-medium text-gray-700">
                    {t('admin.prompts.edit.appId', 'Linked App')}
                  </label>
                  <div className="mt-1">
                    <SearchableAppsSelector
                      apps={apps}
                      value={prompt.appId}
                      onChange={(value) => setPrompt(prev => ({ ...prev, appId: value }))}
                      placeholder={t('admin.prompts.edit.noApp', 'No linked app')}
                      currentLanguage={currentLanguage}
                    />
                  </div>
                  <p className="mt-2 text-sm text-gray-500">
                    {t('admin.prompts.edit.appIdDesc', 'Link this prompt to a specific app')}
                  </p>
                </div>

                {/* Enabled */}
                <div className="col-span-6">
                  <div className="flex items-center">
                    <input
                      id="enabled"
                      type="checkbox"
                      checked={prompt.enabled}
                      onChange={(e) => setPrompt(prev => ({ ...prev, enabled: e.target.checked }))}
                      className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
                    />
                    <label htmlFor="enabled" className="ml-2 block text-sm text-gray-900">
                      {t('admin.prompts.edit.enabled', 'Enabled')}
                    </label>
                  </div>
                  <p className="mt-2 text-sm text-gray-500">
                    {t('admin.prompts.edit.enabledDesc', 'Whether this prompt is visible to users')}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Localized Content */}
        <div className="bg-white shadow px-4 py-5 sm:rounded-lg sm:p-6">
          <div className="md:grid md:grid-cols-3 md:gap-6">
            <div className="md:col-span-1">
              <h3 className="text-lg font-medium leading-6 text-gray-900">
                {t('admin.prompts.edit.content', 'Content')}
              </h3>
              <p className="mt-1 text-sm text-gray-500">
                {t('admin.prompts.edit.contentDesc', 'Localized content for different languages')}
              </p>
            </div>
            <div className="mt-5 md:col-span-2 md:mt-0">
              <div className="space-y-6">
                <DynamicLanguageEditor
                  label={t('admin.prompts.edit.name', 'Name')}
                  value={prompt.name}
                  onChange={(value) => setPrompt(prev => ({ ...prev, name: value }))}
                  required={true}
                  placeholder={{
                    en: 'Prompt name',
                    de: 'Prompt Name',
                    es: 'Nombre del prompt',
                    fr: 'Nom du prompt'
                  }}
                />
                
                <DynamicLanguageEditor
                  label={t('admin.prompts.edit.description', 'Description')}
                  value={prompt.description}
                  onChange={(value) => setPrompt(prev => ({ ...prev, description: value }))}
                  type="textarea"
                  placeholder={{
                    en: 'Brief description of the prompt',
                    de: 'Kurze Beschreibung des Prompts',
                    es: 'Breve descripción del prompt',
                    fr: 'Brève description du prompt'
                  }}
                />
                
                <DynamicLanguageEditor
                  label={t('admin.prompts.edit.prompt', 'Prompt')}
                  value={prompt.prompt}
                  onChange={(value) => setPrompt(prev => ({ ...prev, prompt: value }))}
                  required={true}
                  type="textarea"
                  placeholder={{
                    en: 'The actual prompt text. Use {{variableName}} for variables.',
                    de: 'Der eigentliche Prompt-Text. Verwenden Sie {{variableName}} für Variablen.',
                    es: 'El texto del prompt real. Use {{variableName}} para variables.',
                    fr: 'Le texte du prompt réel. Utilisez {{variableName}} pour les variables.'
                  }}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Variables */}
        <div className="bg-white shadow px-4 py-5 sm:rounded-lg sm:p-6">
          <div className="md:grid md:grid-cols-3 md:gap-6">
            <div className="md:col-span-1">
              <h3 className="text-lg font-medium leading-6 text-gray-900">
                {t('admin.prompts.edit.variables', 'Variables')}
              </h3>
              <p className="mt-1 text-sm text-gray-500">
                {t('admin.prompts.edit.variablesDesc', 'Define variables that can be prefilled when using this prompt')}
              </p>
            </div>
            <div className="mt-5 md:col-span-2 md:mt-0">
              <div className="space-y-4">
                {prompt.variables.map((variable, index) => (
                  <div key={index} className="border border-gray-200 rounded-lg p-4">
                    <div className="flex justify-between items-start mb-4">
                      <h4 className="text-sm font-medium text-gray-900">
                        {t('admin.prompts.edit.variable', 'Variable {{index}}', { index: index + 1 })}
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
                          {t('admin.prompts.edit.variableName', 'Name')}
                        </label>
                        <input
                          type="text"
                          value={variable.name}
                          onChange={(e) => handleVariableChange(index, 'name', e.target.value)}
                          className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
                          placeholder="variable_name"
                          autoComplete="off"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">
                          {t('admin.prompts.edit.variableType', 'Type')}
                        </label>
                        <select
                          value={variable.type}
                          onChange={(e) => handleVariableChange(index, 'type', e.target.value)}
                          className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
                        >
                          <option value="string">String</option>
                          <option value="number">Number</option>
                          <option value="boolean">Boolean</option>
                        </select>
                      </div>
                      <div className="col-span-2">
                        <DynamicLanguageEditor
                          label={t('admin.prompts.edit.variableLabel', 'Label')}
                          value={variable.label || { en: '' }}
                          onChange={(value) => handleVariableChange(index, 'label', value)}
                          placeholder={{
                            en: 'Variable label',
                            de: 'Variablen-Label',
                            es: 'Etiqueta de variable',
                            fr: 'Libellé de variable'
                          }}
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">
                          {t('admin.prompts.edit.variableDefault', 'Default Value')}
                        </label>
                        <input
                          type="text"
                          value={variable.defaultValue || ''}
                          onChange={(e) => handleVariableChange(index, 'defaultValue', e.target.value)}
                          className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
                          placeholder="Default value"
                          autoComplete="off"
                        />
                      </div>
                    </div>
                    <div className="mt-4">
                      <div className="flex items-center">
                        <input
                          type="checkbox"
                          checked={variable.required}
                          onChange={(e) => handleVariableChange(index, 'required', e.target.checked)}
                          className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
                        />
                        <label className="ml-2 block text-sm text-gray-900">
                          {t('admin.prompts.edit.variableRequired', 'Required')}
                        </label>
                      </div>
                    </div>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={addVariable}
                  className="w-full flex justify-center py-2 px-4 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
                >
                  <Icon name="plus" className="w-5 h-5 mr-2" />
                  {t('admin.prompts.edit.addVariable', 'Add Variable')}
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex justify-end space-x-4">
          <button
            type="button"
            onClick={() => navigate('/admin/prompts')}
            className="px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
          >
            {t('admin.prompts.edit.cancel', 'Cancel')}
          </button>
          <button
            type="submit"
            disabled={saving}
            className="px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50"
          >
            {saving ? (
              <>
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2 inline-block"></div>
                {t('admin.prompts.edit.saving', 'Saving...')}
              </>
            ) : (
              t('admin.prompts.edit.save', 'Save Prompt')
            )}
          </button>
        </div>
      </form>
    </div>
    </div>
  );
};

export default AdminPromptEditPage;