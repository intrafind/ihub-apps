import { useTranslation } from 'react-i18next';
import DynamicLanguageEditor from '../../../shared/components/DynamicLanguageEditor';

/**
 * ToolFormEditor - Form interface for editing tool configurations
 * Used within DualModeEditor to provide form-based tool editing
 */
const ToolFormEditor = ({ value, onChange, isNewTool }) => {
  const { t } = useTranslation();

  const handleInputChange = (field, fieldValue) => {
    onChange({ ...value, [field]: fieldValue });
  };

  return (
    <div className="space-y-6">
      {/* Basic Info */}
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
          {t('admin.tools.id', 'Tool ID')} <span className="text-red-500">*</span>
        </label>
        <input
          type="text"
          value={value.id || ''}
          onChange={e => handleInputChange('id', e.target.value)}
          disabled={!isNewTool}
          className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 disabled:bg-gray-100 dark:disabled:bg-gray-700 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
          placeholder="braveSearch"
        />
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
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
          value={value.name || { en: '' }}
          onChange={val => handleInputChange('name', val)}
          required={true}
          placeholder={{ en: 'Brave Search', de: 'Brave-Suche' }}
        />
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          {t('admin.tools.nameHelp', 'Display name for the tool in different languages')}
        </p>
      </div>

      {/* Description (multilingual) */}
      <div>
        <DynamicLanguageEditor
          label={
            <>
              {t('admin.tools.description', 'Description')} <span className="text-red-500">*</span>
            </>
          }
          value={value.description || { en: '' }}
          onChange={val => handleInputChange('description', val)}
          required={true}
          type="textarea"
          placeholder={{
            en: 'Search the web using Brave for up-to-date information',
            de: 'Durchsuchen Sie das Web mit Brave'
          }}
        />
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          {t('admin.tools.descriptionHelp', 'Description shown to the LLM for tool selection')}
        </p>
      </div>

      {/* Special Tool Toggle */}
      <div className="flex items-start">
        <div className="flex items-center h-5">
          <input
            type="checkbox"
            id="isSpecialTool"
            checked={value.isSpecialTool || false}
            onChange={e => handleInputChange('isSpecialTool', e.target.checked)}
            className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 dark:border-gray-600 rounded"
          />
        </div>
        <div className="ml-3 text-sm">
          <label htmlFor="isSpecialTool" className="font-medium text-gray-700 dark:text-gray-300">
            {t('admin.tools.isSpecialTool', 'Special Tool')}
          </label>
          <p className="text-gray-500 dark:text-gray-400">
            {t(
              'admin.tools.isSpecialToolHelp',
              'Provider-specific tools that are handled directly by the model provider (e.g., Google Search Grounding, OpenAI Web Search)'
            )}
          </p>
        </div>
      </div>

      {/* Provider (shown only for special tools) */}
      {value.isSpecialTool && (
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            {t('admin.tools.provider', 'Provider')}
          </label>
          <input
            type="text"
            value={value.provider || ''}
            onChange={e => handleInputChange('provider', e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
            placeholder="google, openai, openai-responses"
          />
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t(
              'admin.tools.providerHelp',
              'Provider identifier (e.g., "google" for Google Search, "openai" for OpenAI, "openai-responses" for response-based tools)'
            )}
          </p>
        </div>
      )}

      {/* Script filename (hidden for special tools) */}
      {!value.isSpecialTool && (
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            {t('admin.tools.scriptFile', 'Script File')}
          </label>
          <input
            type="text"
            value={value.script || ''}
            onChange={e => handleInputChange('script', e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
            placeholder="braveSearch.js"
          />
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t('admin.tools.scriptFileHelp', 'JavaScript file in server/tools/ directory')}
          </p>
        </div>
      )}

      {/* Concurrency */}
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
          {t('admin.tools.concurrency', 'Concurrency Limit')}
        </label>
        <input
          type="number"
          min="1"
          max="100"
          value={value.concurrency || 5}
          onChange={e => handleInputChange('concurrency', parseInt(e.target.value, 10))}
          className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
        />
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          {t('admin.tools.concurrencyHelp', 'Maximum number of concurrent executions')}
        </p>
      </div>

      {/* Enabled toggle */}
      <div className="flex items-center">
        <input
          type="checkbox"
          id="enabled"
          checked={value.enabled !== false}
          onChange={e => handleInputChange('enabled', e.target.checked)}
          className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 dark:border-gray-600 rounded"
        />
        <label htmlFor="enabled" className="ml-2 block text-sm text-gray-900 dark:text-gray-100">
          {t('admin.tools.enabled', 'Enabled')}
        </label>
      </div>

      {/* Parameters (JSON editor) - Only for regular tools */}
      {(!value.functions || Object.keys(value.functions).length === 0) && (
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            {t('admin.tools.parameters', 'Parameters (JSON Schema)')}
          </label>
          <textarea
            value={JSON.stringify(
              value.parameters || { type: 'object', properties: {}, required: [] },
              null,
              2
            )}
            onChange={e => {
              try {
                const parsed = JSON.parse(e.target.value);
                handleInputChange('parameters', parsed);
              } catch {
                // Invalid JSON, ignore
              }
            }}
            rows={12}
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 font-mono text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
            placeholder='{"type": "object", "properties": {}, "required": []}'
          />
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t('admin.tools.parametersHelp', 'JSON Schema definition for tool parameters')}
          </p>
        </div>
      )}

      {/* Multi-Function Configuration */}
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
          {t('admin.tools.functions', 'Functions (Multi-Function Tool)')}
        </label>
        <textarea
          value={JSON.stringify(value.functions || {}, null, 2)}
          onChange={e => {
            try {
              const parsed = JSON.parse(e.target.value);
              handleInputChange('functions', parsed);
            } catch {
              // Invalid JSON, ignore
            }
          }}
          rows={15}
          className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 font-mono text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
          placeholder="{}"
        />
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          {t(
            'admin.tools.functionsHelp',
            'Define multiple functions for this tool (e.g., findUser, getAllUserDetails). Each function should have description and parameters. Leave empty {} for regular single-function tools.'
          )}
        </p>
        <details className="mt-2">
          <summary className="text-sm text-indigo-600 dark:text-indigo-400 cursor-pointer hover:text-indigo-800 dark:hover:text-indigo-300">
            {t('admin.tools.functionsExample', 'Show example multi-function configuration')}
          </summary>
          <pre className="mt-2 p-3 bg-gray-50 dark:bg-gray-800 rounded text-xs overflow-auto text-gray-800 dark:text-gray-200">
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
    </div>
  );
};

export default ToolFormEditor;
