import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../components/Icon';
import AdminNavigation from '../components/AdminNavigation';

const AdminPromptEditPage = () => {
  const { t } = useTranslation();
  const { promptId } = useParams();
  const navigate = useNavigate();
  const isNewPrompt = promptId === 'new';
  
  const [prompt, setPrompt] = useState({
    id: '',
    name: { en: '', de: '' },
    description: { en: '', de: '' },
    prompt: { en: '', de: '' },
    icon: 'clipboard',
    enabled: true,
    order: undefined,
    appId: '',
    variables: []
  });

  const [loading, setLoading] = useState(!isNewPrompt);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [apps, setApps] = useState([]);

  useEffect(() => {
    // Load apps for the appId dropdown
    loadApps();
    
    if (!isNewPrompt) {
      loadPrompt();
    }
  }, [promptId]);

  const loadApps = async () => {
    try {
      const response = await fetch('/api/admin/apps');
      if (response.ok) {
        const data = await response.json();
        setApps(data);
      }
    } catch (err) {
      console.error('Error loading apps:', err);
    }
  };

  const loadPrompt = async () => {
    try {
      setLoading(true);
      const response = await fetch(`/api/admin/prompts/${promptId}`);
      if (!response.ok) {
        throw new Error('Failed to load prompt');
      }
      const data = await response.json();
      
      // Ensure proper structure for editing
      const promptData = {
        ...data,
        name: typeof data.name === 'string' ? { en: data.name, de: data.name } : data.name || { en: '', de: '' },
        description: typeof data.description === 'string' ? { en: data.description, de: data.description } : data.description || { en: '', de: '' },
        prompt: typeof data.prompt === 'string' ? { en: data.prompt, de: data.prompt } : data.prompt || { en: '', de: '' },
        variables: data.variables || [],
        appId: data.appId || '',
        order: data.order,
        enabled: data.enabled !== false
      };
      
      setPrompt(promptData);
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
      
      const url = isNewPrompt ? '/api/admin/prompts' : `/api/admin/prompts/${promptId}`;
      const method = isNewPrompt ? 'POST' : 'PUT';
      
      const response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(prompt),
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to save prompt');
      }
      
      const result = await response.json();
      console.log(result.message);
      
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
        label: { en: '', de: '' },
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
                  />
                  <p className="mt-2 text-sm text-gray-500">
                    {t('admin.prompts.edit.orderDesc', 'Display order in the prompts list')}
                  </p>
                </div>

                {/* App ID */}
                <div className="col-span-6 sm:col-span-3">
                  <label htmlFor="appId" className="block text-sm font-medium text-gray-700">
                    {t('admin.prompts.edit.appId', 'Linked App')}
                  </label>
                  <select
                    id="appId"
                    value={prompt.appId || ''}
                    onChange={(e) => setPrompt(prev => ({ ...prev, appId: e.target.value }))}
                    className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
                  >
                    <option value="">{t('admin.prompts.edit.noApp', 'No linked app')}</option>
                    {apps.map(app => (
                      <option key={app.id} value={app.id}>
                        {typeof app.name === 'object' ? app.name.en : app.name} ({app.id})
                      </option>
                    ))}
                  </select>
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
                {/* English Content */}
                <div>
                  <h4 className="text-md font-medium text-gray-900 mb-4">
                    {t('admin.prompts.edit.english', 'English')}
                  </h4>
                  <div className="space-y-4">
                    <div>
                      <label htmlFor="name-en" className="block text-sm font-medium text-gray-700">
                        {t('admin.prompts.edit.name', 'Name')} <span className="text-red-500">*</span>
                      </label>
                      <input
                        type="text"
                        id="name-en"
                        value={prompt.name.en}
                        onChange={(e) => setPrompt(prev => ({ 
                          ...prev, 
                          name: { ...prev.name, en: e.target.value } 
                        }))}
                        className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
                        placeholder="Prompt name"
                      />
                    </div>
                    <div>
                      <label htmlFor="description-en" className="block text-sm font-medium text-gray-700">
                        {t('admin.prompts.edit.description', 'Description')}
                      </label>
                      <textarea
                        id="description-en"
                        rows={2}
                        value={prompt.description.en}
                        onChange={(e) => setPrompt(prev => ({ 
                          ...prev, 
                          description: { ...prev.description, en: e.target.value } 
                        }))}
                        className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
                        placeholder="Brief description of the prompt"
                      />
                    </div>
                    <div>
                      <label htmlFor="prompt-en" className="block text-sm font-medium text-gray-700">
                        {t('admin.prompts.edit.prompt', 'Prompt')} <span className="text-red-500">*</span>
                      </label>
                      <textarea
                        id="prompt-en"
                        rows={4}
                        value={prompt.prompt.en}
                        onChange={(e) => setPrompt(prev => ({ 
                          ...prev, 
                          prompt: { ...prev.prompt, en: e.target.value } 
                        }))}
                        className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
                        placeholder="The actual prompt text. Use [content] for user input placeholder."
                      />
                    </div>
                  </div>
                </div>

                {/* German Content */}
                <div>
                  <h4 className="text-md font-medium text-gray-900 mb-4">
                    {t('admin.prompts.edit.german', 'German')}
                  </h4>
                  <div className="space-y-4">
                    <div>
                      <label htmlFor="name-de" className="block text-sm font-medium text-gray-700">
                        {t('admin.prompts.edit.name', 'Name')}
                      </label>
                      <input
                        type="text"
                        id="name-de"
                        value={prompt.name.de}
                        onChange={(e) => setPrompt(prev => ({ 
                          ...prev, 
                          name: { ...prev.name, de: e.target.value } 
                        }))}
                        className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
                        placeholder="Prompt name"
                      />
                    </div>
                    <div>
                      <label htmlFor="description-de" className="block text-sm font-medium text-gray-700">
                        {t('admin.prompts.edit.description', 'Description')}
                      </label>
                      <textarea
                        id="description-de"
                        rows={2}
                        value={prompt.description.de}
                        onChange={(e) => setPrompt(prev => ({ 
                          ...prev, 
                          description: { ...prev.description, de: e.target.value } 
                        }))}
                        className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
                        placeholder="Brief description of the prompt"
                      />
                    </div>
                    <div>
                      <label htmlFor="prompt-de" className="block text-sm font-medium text-gray-700">
                        {t('admin.prompts.edit.prompt', 'Prompt')}
                      </label>
                      <textarea
                        id="prompt-de"
                        rows={4}
                        value={prompt.prompt.de}
                        onChange={(e) => setPrompt(prev => ({ 
                          ...prev, 
                          prompt: { ...prev.prompt, de: e.target.value } 
                        }))}
                        className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
                        placeholder="The actual prompt text. Use [content] for user input placeholder."
                      />
                    </div>
                  </div>
                </div>
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
                      <div>
                        <label className="block text-sm font-medium text-gray-700">
                          {t('admin.prompts.edit.variableLabel', 'Label (EN)')}
                        </label>
                        <input
                          type="text"
                          value={variable.label?.en || ''}
                          onChange={(e) => handleVariableChange(index, 'label', { ...variable.label, en: e.target.value })}
                          className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
                          placeholder="Variable label"
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