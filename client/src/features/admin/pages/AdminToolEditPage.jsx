import { useState, useEffect } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import AdminNavigation from '../components/AdminNavigation';
import AdminAuth from '../components/AdminAuth';
import DynamicLanguageEditor from '../../../shared/components/DynamicLanguageEditor';
import {
  fetchAdminTools,
  createTool,
  updateTool,
  fetchToolScript,
  updateToolScript
} from '../../../api/adminApi';
import { clearApiCache } from '../../../api/api';

const AdminToolEditPage = () => {
  const { t } = useTranslation();
  const { toolId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const isNewTool = toolId === 'new';

  const [toolData, setToolData] = useState({
    id: '',
    name: { en: '' },
    description: { en: '' },
    script: '',
    enabled: true,
    concurrency: 5,
    isSpecialTool: false,
    provider: '',
    parameters: {
      type: 'object',
      properties: {},
      required: []
    },
    functions: {} // Support for multi-function tools
  });

  const [scriptContent, setScriptContent] = useState('');
  const [loading, setLoading] = useState(!isNewTool);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState('config'); // config or script

  useEffect(() => {
    if (isNewTool && location.state?.templateTool) {
      const tpl = location.state.templateTool;
      setToolData({
        ...tpl,
        id: '',
        enabled: tpl.enabled !== false
      });
      if (tpl.script) {
        // For template, we don't have a toolId yet, so just set empty script template
        setScriptContent(
          '// Script template\nexport default async function toolName(params) {\n  // Your code here\n}\n'
        );
      }
    } else if (!isNewTool) {
      loadTool();
    }
  }, [toolId, isNewTool]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadTool = async () => {
    try {
      setLoading(true);
      setError(null);

      const data = await fetchAdminTools();
      const tool = data.find(t => t.id === toolId);

      if (!tool) {
        throw new Error('Tool not found');
      }

      // Ensure proper structure
      setToolData({
        ...tool,
        name: tool.name || { en: '' },
        description: tool.description || { en: '' },
        enabled: tool.enabled !== false,
        concurrency: tool.concurrency || 5,
        isSpecialTool: tool.isSpecialTool || false,
        provider: tool.provider || '',
        parameters: tool.parameters || { type: 'object', properties: {}, required: [] },
        functions: tool.functions || {}
      });

      // Load script if available
      if (tool.script) {
        try {
          const scriptData = await fetchToolScript(toolId);
          setScriptContent(scriptData.content || '');
        } catch (err) {
          console.error('Error loading script:', err);
          setScriptContent('');
        }
      }
    } catch (err) {
      console.error('Error loading tool:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleSaveConfig = async () => {
    try {
      setSaving(true);
      setError(null);

      // Validate required fields
      if (!toolData.id || !toolData.name.en || !toolData.description.en) {
        throw new Error('Please fill in all required fields (ID, Name, Description)');
      }

      // For multi-function tools, remove the parameters field as it's defined per function
      const toolToSave = { ...toolData };
      if (toolToSave.functions && Object.keys(toolToSave.functions).length > 0) {
        // Multi-function tool - parameters are per function, not at tool level
        delete toolToSave.parameters;
      } else {
        // Regular tool - remove empty functions object
        delete toolToSave.functions;
      }

      if (isNewTool) {
        await createTool(toolToSave);
      } else {
        await updateTool(toolId, toolToSave);
      }

      // Clear cache
      clearApiCache('admin_tools');

      // If this is a new tool and we have script content, save it
      if (isNewTool && scriptContent && toolToSave.script) {
        await updateToolScript(toolToSave.id, scriptContent);
      }

      navigate('/admin/tools');
    } catch (err) {
      console.error('Error saving tool config:', err);
      setError(err.message || 'Failed to save tool configuration');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveScript = async () => {
    if (!toolData.script) {
      setError('No script file specified in configuration');
      return;
    }

    try {
      setSaving(true);
      setError(null);

      await updateToolScript(toolId, scriptContent);

      alert(t('admin.tools.scriptSaved', 'Script saved successfully'));
    } catch (err) {
      console.error('Error saving script:', err);
      setError(err.message || 'Failed to save script');
    } finally {
      setSaving(false);
    }
  };

  const handleInputChange = (field, value) => {
    setToolData(prev => ({
      ...prev,
      [field]: value
    }));
  };

  if (loading) {
    return (
      <AdminAuth>
        <AdminNavigation />
        <div className="flex justify-center items-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600"></div>
        </div>
      </AdminAuth>
    );
  }

  return (
    <AdminAuth>
      <div>
        <AdminNavigation />
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="md:flex md:items-center md:justify-between mb-6">
            <div className="flex-1 min-w-0">
              <h1 className="text-2xl font-semibold text-gray-900">
                {isNewTool
                  ? t('admin.tools.createNew', 'Create New Tool')
                  : t('admin.tools.editTool', 'Edit Tool')}
              </h1>
              <p className="mt-1 text-sm text-gray-500">
                {isNewTool
                  ? t('admin.tools.createDescription', 'Create a new AI tool / function')
                  : t('admin.tools.editDescription', 'Edit tool configuration and script')}
              </p>
            </div>
            <div className="mt-4 flex md:mt-0 md:ml-4">
              <button
                onClick={() => navigate('/admin/tools')}
                className="inline-flex items-center px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
              >
                <Icon name="arrow-left" className="h-4 w-4 mr-2" />
                {t('common.back', 'Back')}
              </button>
            </div>
          </div>

          {error && (
            <div className="mb-6 bg-red-50 border border-red-200 rounded-md p-4">
              <div className="flex">
                <Icon name="exclamation-triangle" className="h-5 w-5 text-red-400" />
                <div className="ml-3">
                  <h3 className="text-sm font-medium text-red-800">{t('common.error', 'Error')}</h3>
                  <p className="mt-1 text-sm text-red-700">{error}</p>
                </div>
              </div>
            </div>
          )}

          {/* Tabs */}
          <div className="border-b border-gray-200 mb-6">
            <nav className="-mb-px flex space-x-8">
              <button
                onClick={() => setActiveTab('config')}
                className={`${
                  activeTab === 'config'
                    ? 'border-indigo-500 text-indigo-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                } whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm`}
              >
                <Icon name="cog" className="h-4 w-4 inline mr-2" />
                {t('admin.tools.configTab', 'Configuration')}
              </button>
              {!isNewTool && toolData.script && (
                <button
                  onClick={() => setActiveTab('script')}
                  className={`${
                    activeTab === 'script'
                      ? 'border-indigo-500 text-indigo-600'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                  } whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm`}
                >
                  <Icon name="code" className="h-4 w-4 inline mr-2" />
                  {t('admin.tools.scriptTab', 'Script Editor')}
                </button>
              )}
            </nav>
          </div>

          {/* Configuration Tab */}
          {activeTab === 'config' && (
            <div className="bg-white shadow rounded-lg p-6">
              <div className="space-y-6">
                {/* Basic Info */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    {t('admin.tools.id', 'Tool ID')} <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={toolData.id}
                    onChange={e => handleInputChange('id', e.target.value)}
                    disabled={!isNewTool}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 disabled:bg-gray-100"
                    placeholder="braveSearch"
                  />
                  <p className="mt-1 text-sm text-gray-500">
                    {t('admin.tools.idHelp', 'Unique identifier for the tool')}
                  </p>
                </div>

                {/* Name (multilingual) */}
                <div>
                  <DynamicLanguageEditor
                    label={
                      <>
                        {t('admin.tools.name', 'Name')} <span className="text-red-500">*</span>
                      </>
                    }
                    value={toolData.name}
                    onChange={value => handleInputChange('name', value)}
                    required={true}
                    placeholder={{ en: 'Brave Search', de: 'Brave-Suche' }}
                  />
                  <p className="mt-1 text-sm text-gray-500">
                    {t('admin.tools.nameHelp', 'Display name for the tool in different languages')}
                  </p>
                </div>

                {/* Description (multilingual) */}
                <div>
                  <DynamicLanguageEditor
                    label={
                      <>
                        {t('admin.tools.description', 'Description')}{' '}
                        <span className="text-red-500">*</span>
                      </>
                    }
                    value={toolData.description}
                    onChange={value => handleInputChange('description', value)}
                    required={true}
                    type="textarea"
                    placeholder={{
                      en: 'Search the web using Brave for up-to-date information',
                      de: 'Durchsuchen Sie das Web mit Brave'
                    }}
                  />
                  <p className="mt-1 text-sm text-gray-500">
                    {t(
                      'admin.tools.descriptionHelp',
                      'Description shown to the LLM for tool selection'
                    )}
                  </p>
                </div>

                {/* Special Tool Toggle */}
                <div className="flex items-start">
                  <div className="flex items-center h-5">
                    <input
                      type="checkbox"
                      id="isSpecialTool"
                      checked={toolData.isSpecialTool}
                      onChange={e => handleInputChange('isSpecialTool', e.target.checked)}
                      className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
                    />
                  </div>
                  <div className="ml-3 text-sm">
                    <label htmlFor="isSpecialTool" className="font-medium text-gray-700">
                      {t('admin.tools.isSpecialTool', 'Special Tool')}
                    </label>
                    <p className="text-gray-500">
                      {t(
                        'admin.tools.isSpecialToolHelp',
                        'Provider-specific tools that are handled directly by the model provider (e.g., Google Search Grounding, OpenAI Web Search)'
                      )}
                    </p>
                  </div>
                </div>

                {/* Provider (shown only for special tools) */}
                {toolData.isSpecialTool && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      {t('admin.tools.provider', 'Provider')}
                    </label>
                    <input
                      type="text"
                      value={toolData.provider || ''}
                      onChange={e => handleInputChange('provider', e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                      placeholder="google, openai, openai-responses"
                    />
                    <p className="mt-1 text-sm text-gray-500">
                      {t(
                        'admin.tools.providerHelp',
                        'Provider identifier (e.g., "google" for Google Search, "openai" for OpenAI, "openai-responses" for response-based tools)'
                      )}
                    </p>
                  </div>
                )}

                {/* Script filename (hidden for special tools) */}
                {!toolData.isSpecialTool && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      {t('admin.tools.scriptFile', 'Script File')}
                    </label>
                    <input
                      type="text"
                      value={toolData.script || ''}
                      onChange={e => handleInputChange('script', e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                      placeholder="braveSearch.js"
                    />
                    <p className="mt-1 text-sm text-gray-500">
                      {t(
                        'admin.tools.scriptFileHelp',
                        'JavaScript file in server/tools/ directory'
                      )}
                    </p>
                  </div>
                )}

                {/* Concurrency */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    {t('admin.tools.concurrency', 'Concurrency Limit')}
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="100"
                    value={toolData.concurrency || 5}
                    onChange={e => handleInputChange('concurrency', parseInt(e.target.value, 10))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                  />
                  <p className="mt-1 text-sm text-gray-500">
                    {t('admin.tools.concurrencyHelp', 'Maximum number of concurrent executions')}
                  </p>
                </div>

                {/* Enabled toggle */}
                <div className="flex items-center">
                  <input
                    type="checkbox"
                    id="enabled"
                    checked={toolData.enabled}
                    onChange={e => handleInputChange('enabled', e.target.checked)}
                    className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
                  />
                  <label htmlFor="enabled" className="ml-2 block text-sm text-gray-900">
                    {t('admin.tools.enabled', 'Enabled')}
                  </label>
                </div>

                {/* Parameters (JSON editor) - Only for regular tools */}
                {(!toolData.functions || Object.keys(toolData.functions).length === 0) && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      {t('admin.tools.parameters', 'Parameters (JSON Schema)')}
                    </label>
                    <textarea
                      value={JSON.stringify(toolData.parameters, null, 2)}
                      onChange={e => {
                        try {
                          const parsed = JSON.parse(e.target.value);
                          handleInputChange('parameters', parsed);
                        } catch {
                          // Invalid JSON, just update the raw value
                        }
                      }}
                      rows={12}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 font-mono text-sm"
                      placeholder='{"type": "object", "properties": {}, "required": []}'
                    />
                    <p className="mt-1 text-sm text-gray-500">
                      {t(
                        'admin.tools.parametersHelp',
                        'JSON Schema definition for tool parameters'
                      )}
                    </p>
                  </div>
                )}

                {/* Multi-Function Configuration */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    {t('admin.tools.functions', 'Functions (Multi-Function Tool)')}
                  </label>
                  <textarea
                    value={JSON.stringify(toolData.functions || {}, null, 2)}
                    onChange={e => {
                      try {
                        const parsed = JSON.parse(e.target.value);
                        handleInputChange('functions', parsed);
                      } catch {
                        // Invalid JSON, just update the raw value
                      }
                    }}
                    rows={15}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 font-mono text-sm"
                    placeholder="{}"
                  />
                  <p className="mt-1 text-sm text-gray-500">
                    {t(
                      'admin.tools.functionsHelp',
                      'Define multiple functions for this tool (e.g., findUser, getAllUserDetails). Each function should have description and parameters. Leave empty {} for regular single-function tools.'
                    )}
                  </p>
                  <details className="mt-2">
                    <summary className="text-sm text-indigo-600 cursor-pointer hover:text-indigo-800">
                      {t(
                        'admin.tools.functionsExample',
                        'Show example multi-function configuration'
                      )}
                    </summary>
                    <pre className="mt-2 p-3 bg-gray-50 rounded text-xs overflow-auto">
                      {`{
  "findUser": {
    "description": {
      "en": "Find a user by name",
      "de": "Benutzer nach Name finden"
    },
    "parameters": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string",
          "description": {
            "en": "User name or email"
          }
        }
      },
      "required": ["name"]
    }
  },
  "getUserDetails": {
    "description": {
      "en": "Get user details by ID"
    },
    "parameters": {
      "type": "object",
      "properties": {
        "userId": {
          "type": "string",
          "description": {
            "en": "User ID"
          }
        }
      },
      "required": ["userId"]
    }
  }
}`}
                    </pre>
                  </details>
                </div>

                {/* Save button */}
                <div className="flex justify-end space-x-3">
                  <button
                    onClick={() => navigate('/admin/tools')}
                    className="px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
                  >
                    {t('common.cancel', 'Cancel')}
                  </button>
                  <button
                    onClick={handleSaveConfig}
                    disabled={saving}
                    className="inline-flex items-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50"
                  >
                    {saving ? (
                      <>
                        <Icon name="refresh" className="animate-spin h-4 w-4 mr-2" />
                        {t('common.saving', 'Saving...')}
                      </>
                    ) : (
                      <>
                        <Icon name="check" className="h-4 w-4 mr-2" />
                        {t('common.save', 'Save')}
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Script Editor Tab */}
          {activeTab === 'script' && !isNewTool && toolData.script && (
            <div className="bg-white shadow rounded-lg p-6">
              <div className="mb-4">
                <p className="text-sm text-gray-600">
                  {t(
                    'admin.tools.scriptEditorInfo',
                    'Edit the JavaScript code for this tool. Changes will be saved to server/tools/'
                  )}{' '}
                  <code className="bg-gray-100 px-2 py-1 rounded text-xs">{toolData.script}</code>
                </p>
              </div>

              <div className="mb-4">
                <textarea
                  value={scriptContent}
                  onChange={e => setScriptContent(e.target.value)}
                  rows={25}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 font-mono text-sm"
                  style={{ fontFamily: 'monospace' }}
                />
              </div>

              <div className="flex justify-end space-x-3">
                <button
                  onClick={() => setActiveTab('config')}
                  className="px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
                >
                  {t('common.cancel', 'Cancel')}
                </button>
                <button
                  onClick={handleSaveScript}
                  disabled={saving}
                  className="inline-flex items-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50"
                >
                  {saving ? (
                    <>
                      <Icon name="refresh" className="animate-spin h-4 w-4 mr-2" />
                      {t('common.saving', 'Saving...')}
                    </>
                  ) : (
                    <>
                      <Icon name="check" className="h-4 w-4 mr-2" />
                      {t('admin.tools.saveScript', 'Save Script')}
                    </>
                  )}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </AdminAuth>
  );
};

export default AdminToolEditPage;
