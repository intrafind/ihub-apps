import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';

/**
 * GlobalPromptVariablesEditor - Component for managing global prompt variables
 * @param {Object} props
 * @param {Object} props.value - The globalPromptVariables configuration object
 * @param {Function} props.onChange - Callback fired when configuration changes
 */
function GlobalPromptVariablesEditor({ value, onChange }) {
  const { t } = useTranslation();
  const [showAddVariable, setShowAddVariable] = useState(false);
  const [newVariableKey, setNewVariableKey] = useState('');
  const [newVariableValue, setNewVariableValue] = useState('');
  const [error, setError] = useState('');

  const variables = value?.variables || {};
  const context = value?.context || '';

  // Built-in variables that cannot be modified
  const builtInVariables = [
    { key: 'year', description: 'Current year' },
    { key: 'month', description: 'Current month (zero-padded)' },
    { key: 'date', description: 'Localized full date' },
    { key: 'time', description: 'Localized time' },
    { key: 'day_of_week', description: 'Localized day of week' },
    { key: 'timezone', description: "User's timezone" },
    { key: 'locale', description: 'Current language/locale' },
    { key: 'user_name', description: "Authenticated user's display name" },
    { key: 'user_email', description: "Authenticated user's email" },
    { key: 'model_name', description: 'Current model being used' },
    { key: 'tone', description: 'Selected tone/style setting' },
    { key: 'location', description: "User's location (if configured)" },
    { key: 'platform_context', description: 'The processed global context' }
  ];

  const handleContextChange = e => {
    onChange({
      ...value,
      context: e.target.value
    });
  };

  const handleAddVariable = () => {
    setError('');

    // Validate variable key
    if (!newVariableKey.trim()) {
      setError('Variable key is required');
      return;
    }

    // Check if key already exists (built-in or custom)
    const keyLower = newVariableKey.toLowerCase();
    if (builtInVariables.some(v => v.key.toLowerCase() === keyLower)) {
      setError('This variable name is reserved for built-in variables');
      return;
    }

    if (variables.hasOwnProperty(newVariableKey)) {
      setError('A custom variable with this key already exists');
      return;
    }

    // Validate key format (alphanumeric and underscores only)
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(newVariableKey)) {
      setError('Variable key must start with a letter or underscore and contain only letters, numbers, and underscores');
      return;
    }

    // Add the variable
    onChange({
      ...value,
      variables: {
        ...variables,
        [newVariableKey]: newVariableValue
      }
    });

    // Reset form
    setNewVariableKey('');
    setNewVariableValue('');
    setShowAddVariable(false);
  };

  const handleUpdateVariable = (key, newValue) => {
    onChange({
      ...value,
      variables: {
        ...variables,
        [key]: newValue
      }
    });
  };

  const handleDeleteVariable = key => {
    const { [key]: removed, ...rest } = variables;
    onChange({
      ...value,
      variables: rest
    });
  };

  const handleCopyToClipboard = text => {
    navigator.clipboard.writeText(text);
  };

  return (
    <div className="space-y-6">
      {/* Global Context */}
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
          {t('admin.platform.globalContext', 'Global Context')}
        </label>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">
          {t(
            'admin.platform.globalContextDescription',
            'This context is automatically prepended to all system prompts. You can use variables here by wrapping them in double curly braces, e.g., {{date}} or {{company}}.'
          )}
        </p>
        <textarea
          value={context}
          onChange={handleContextChange}
          rows={6}
          className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white font-mono text-sm"
          placeholder="e.g., Current date: {{date}}. Company: {{company}}. User: {{user_name}}"
        />
      </div>

      {/* Built-in Variables Section */}
      <div>
        <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-3">
          {t('admin.platform.builtInVariables', 'Built-in Variables')}
        </h3>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">
          {t(
            'admin.platform.builtInVariablesDescription',
            'These variables are automatically available and populated by the system.'
          )}
        </p>
        <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-4 space-y-2 max-h-96 overflow-y-auto">
          {builtInVariables.map(variable => (
            <div
              key={variable.key}
              className="flex items-center justify-between p-2 bg-white dark:bg-gray-700 rounded border border-gray-200 dark:border-gray-600"
            >
              <div className="flex-1">
                <code className="text-sm font-mono text-blue-600 dark:text-blue-400">
                  {`{{${variable.key}}}`}
                </code>
                <span className="ml-3 text-sm text-gray-600 dark:text-gray-400">
                  {variable.description}
                </span>
              </div>
              <button
                onClick={() => handleCopyToClipboard(`{{${variable.key}}}`)}
                className="ml-2 p-1 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
                title={t('common.copy', 'Copy')}
              >
                <Icon name="clipboard" className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Custom Variables Section */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-medium text-gray-900 dark:text-white">
            {t('admin.platform.customVariables', 'Custom Variables')}
          </h3>
          <button
            onClick={() => setShowAddVariable(!showAddVariable)}
            className="px-3 py-1 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 flex items-center gap-2"
          >
            <Icon name="plus" className="w-4 h-4" />
            {t('admin.platform.addVariable', 'Add Variable')}
          </button>
        </div>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">
          {t(
            'admin.platform.customVariablesDescription',
            'Create custom variables that can be used across all apps and prompts. For example, create a {{company}} variable with your company description.'
          )}
        </p>

        {/* Add Variable Form */}
        {showAddVariable && (
          <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4 mb-4">
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  {t('admin.platform.variableKey', 'Variable Key')}
                </label>
                <input
                  type="text"
                  value={newVariableKey}
                  onChange={e => setNewVariableKey(e.target.value)}
                  placeholder="e.g., company, department, region"
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
                />
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                  {t('admin.platform.variableKeyHelp', 'Use lowercase letters, numbers, and underscores. Must start with a letter or underscore.')}
                </p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  {t('admin.platform.variableValue', 'Variable Value')}
                </label>
                <textarea
                  value={newVariableValue}
                  onChange={e => setNewVariableValue(e.target.value)}
                  rows={3}
                  placeholder="e.g., We are a leading provider of AI solutions..."
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
                />
              </div>
              {error && (
                <div className="text-sm text-red-600 dark:text-red-400">{error}</div>
              )}
              <div className="flex gap-2">
                <button
                  onClick={handleAddVariable}
                  className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
                >
                  {t('common.add', 'Add')}
                </button>
                <button
                  onClick={() => {
                    setShowAddVariable(false);
                    setError('');
                    setNewVariableKey('');
                    setNewVariableValue('');
                  }}
                  className="px-4 py-2 bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded hover:bg-gray-300 dark:hover:bg-gray-600"
                >
                  {t('common.cancel', 'Cancel')}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Custom Variables List */}
        {Object.keys(variables).length === 0 ? (
          <div className="text-center py-8 text-gray-500 dark:text-gray-400">
            {t('admin.platform.noCustomVariables', 'No custom variables defined yet. Click "Add Variable" to create one.')}
          </div>
        ) : (
          <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-4 space-y-3">
            {Object.entries(variables).map(([key, value]) => (
              <div
                key={key}
                className="bg-white dark:bg-gray-700 rounded-lg border border-gray-200 dark:border-gray-600 p-4"
              >
                <div className="flex items-start justify-between mb-2">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-2">
                      <code className="text-sm font-mono text-blue-600 dark:text-blue-400 font-semibold">
                        {`{{${key}}}`}
                      </code>
                      <button
                        onClick={() => handleCopyToClipboard(`{{${key}}}`)}
                        className="p-1 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
                        title={t('common.copy', 'Copy')}
                      >
                        <Icon name="clipboard" className="w-4 h-4" />
                      </button>
                    </div>
                    <textarea
                      value={value}
                      onChange={e => handleUpdateVariable(key, e.target.value)}
                      rows={3}
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-600 dark:text-white text-sm"
                    />
                  </div>
                  <button
                    onClick={() => handleDeleteVariable(key)}
                    className="ml-3 p-2 text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
                    title={t('common.delete', 'Delete')}
                  >
                    <Icon name="trash" className="w-5 h-5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Usage Example */}
      <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4">
        <div className="flex">
          <Icon name="lightbulb" className="w-5 h-5 text-yellow-600 dark:text-yellow-400 mr-2 flex-shrink-0 mt-0.5" />
          <div>
            <h4 className="font-medium text-gray-900 dark:text-white mb-1">
              {t('admin.platform.usageExample', 'Usage Example')}
            </h4>
            <p className="text-sm text-gray-700 dark:text-gray-300">
              {t(
                'admin.platform.usageExampleText',
                'Once you create a custom variable like {{company}}, you can use it in app system prompts, the global context above, or in any app prompt template. The variable will be replaced with its value automatically.'
              )}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default GlobalPromptVariablesEditor;
