// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import {
  HELP_CLASS,
  INPUT_CLASS,
  LABEL_CLASS,
  MONO_INPUT_CLASS,
  PRIMARY_BUTTON_CLASS,
  SECONDARY_BUTTON_CLASS
} from './formStyles';

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
  const baseId = useId();
  const ids = {
    context: `${baseId}-context`,
    contextHelp: `${baseId}-context-help`,
    newKey: `${baseId}-new-key`,
    newKeyHelp: `${baseId}-new-key-help`,
    newValue: `${baseId}-new-value`
  };

  const variables = value?.variables || {};
  const context = value?.context || '';

  // Built-in variables that cannot be modified
  const builtInVariables = [
    { key: 'year', description: t('admin.platform.builtIn.year', 'Current year') },
    { key: 'month', description: t('admin.platform.builtIn.month', 'Current month (zero-padded)') },
    { key: 'date', description: t('admin.platform.builtIn.date', 'Localized full date') },
    { key: 'time', description: t('admin.platform.builtIn.time', 'Localized time') },
    {
      key: 'day_of_week',
      description: t('admin.platform.builtIn.day_of_week', 'Localized day of week')
    },
    { key: 'timezone', description: t('admin.platform.builtIn.timezone', "User's timezone") },
    { key: 'locale', description: t('admin.platform.builtIn.locale', 'Current language/locale') },
    {
      key: 'user_name',
      description: t('admin.platform.builtIn.user_name', "Authenticated user's display name")
    },
    {
      key: 'user_email',
      description: t('admin.platform.builtIn.user_email', "Authenticated user's email")
    },
    {
      key: 'model_name',
      description: t('admin.platform.builtIn.model_name', 'Current model being used')
    },
    { key: 'tone', description: t('admin.platform.builtIn.tone', 'Selected tone/style setting') },
    {
      key: 'location',
      description: t('admin.platform.builtIn.location', "User's location (if configured)")
    },
    {
      key: 'platform_context',
      description: t('admin.platform.builtIn.platform_context', 'The processed global context')
    }
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
      setError(t('admin.platform.errors.keyRequired', 'Variable key is required'));
      return;
    }

    // Check if key already exists (built-in or custom)
    const keyLower = newVariableKey.toLowerCase();
    if (builtInVariables.some(v => v.key.toLowerCase() === keyLower)) {
      setError(
        t(
          'admin.platform.errors.keyReserved',
          'This variable name is reserved for built-in variables'
        )
      );
      return;
    }

    if (variables.hasOwnProperty(newVariableKey)) {
      setError(
        t('admin.platform.errors.keyExists', 'A custom variable with this key already exists')
      );
      return;
    }

    // Validate key format (alphanumeric and underscores only)
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(newVariableKey)) {
      setError(
        'Variable key must start with a letter or underscore and contain only letters, numbers, and underscores'
      );
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
    const { [key]: _removed, ...rest } = variables;
    onChange({
      ...value,
      variables: rest
    });
  };

  const handleCopyToClipboard = async text => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (error) {
      console.error('Failed to copy to clipboard:', error);
    }
  };

  return (
    <div className="space-y-6">
      {/* Global Context */}
      <div>
        <label htmlFor={ids.context} className={LABEL_CLASS}>
          {t('admin.platform.globalContext', 'Global Context')}
        </label>
        <p id={ids.contextHelp} className="text-sm text-gray-600 dark:text-gray-400 mb-2">
          {t(
            'admin.platform.globalContextDescription',
            'This context is automatically prepended to all system prompts. You can use variables here by wrapping them in double curly braces, e.g., {{date}} or {{company}}.'
          )}
        </p>
        <textarea
          id={ids.context}
          aria-describedby={ids.contextHelp}
          value={context}
          onChange={handleContextChange}
          rows={6}
          className={MONO_INPUT_CLASS}
          placeholder={t(
            'admin.platform.globalContextPlaceholder',
            'e.g., Current date: {{date}}. Company: {{company}}. User: {{user_name}}'
          )}
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
              className="flex items-center justify-between p-2 bg-white dark:bg-gray-700 rounded-sm border border-gray-200 dark:border-gray-600"
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
                type="button"
                onClick={() => handleCopyToClipboard(`{{${variable.key}}}`)}
                className="ml-2 p-1 rounded-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-admin-accent"
                title={t('common.copy', 'Copy')}
                aria-label={`${t('common.copy', 'Copy')} {{${variable.key}}}`}
              >
                <Icon name="clipboard" className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Custom Variables Section */}
      <div>
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <h3 className="text-lg font-medium text-gray-900 dark:text-white">
            {t('admin.platform.customVariables', 'Custom Variables')}
          </h3>
          <button
            type="button"
            onClick={() => setShowAddVariable(!showAddVariable)}
            aria-expanded={showAddVariable}
            className={SECONDARY_BUTTON_CLASS}
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
                <label htmlFor={ids.newKey} className={LABEL_CLASS}>
                  {t('admin.platform.variableKey', 'Variable Key')}
                </label>
                <input
                  id={ids.newKey}
                  aria-describedby={ids.newKeyHelp}
                  type="text"
                  value={newVariableKey}
                  onChange={e => setNewVariableKey(e.target.value)}
                  placeholder={t(
                    'admin.platform.variableKeyPlaceholder',
                    'e.g., company, department, region'
                  )}
                  className={MONO_INPUT_CLASS}
                />
                <p id={ids.newKeyHelp} className={HELP_CLASS}>
                  {t(
                    'admin.platform.variableKeyHelp',
                    'Use lowercase letters, numbers, and underscores. Must start with a letter or underscore.'
                  )}
                </p>
              </div>
              <div>
                <label htmlFor={ids.newValue} className={LABEL_CLASS}>
                  {t('admin.platform.variableValue', 'Variable Value')}
                </label>
                <textarea
                  id={ids.newValue}
                  value={newVariableValue}
                  onChange={e => setNewVariableValue(e.target.value)}
                  rows={3}
                  placeholder={t(
                    'admin.platform.variableValuePlaceholder',
                    'e.g., We are a leading provider of AI solutions…'
                  )}
                  className={INPUT_CLASS}
                />
              </div>
              {error && (
                <div role="alert" className="text-sm text-red-700 dark:text-red-300">
                  {error}
                </div>
              )}
              <div className="flex gap-2">
                <button type="button" onClick={handleAddVariable} className={PRIMARY_BUTTON_CLASS}>
                  {t('common.add', 'Add')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowAddVariable(false);
                    setError('');
                    setNewVariableKey('');
                    setNewVariableValue('');
                  }}
                  className={SECONDARY_BUTTON_CLASS}
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
            {t(
              'admin.platform.noCustomVariables',
              'No custom variables defined yet. Click "Add Variable" to create one.'
            )}
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
                        type="button"
                        onClick={() => handleCopyToClipboard(`{{${key}}}`)}
                        className="p-1 rounded-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-admin-accent"
                        title={t('common.copy', 'Copy')}
                        aria-label={`${t('common.copy', 'Copy')} {{${key}}}`}
                      >
                        <Icon name="clipboard" className="w-4 h-4" />
                      </button>
                    </div>
                    <textarea
                      value={value}
                      onChange={e => handleUpdateVariable(key, e.target.value)}
                      rows={3}
                      aria-label={`{{${key}}}`}
                      className={INPUT_CLASS}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => handleDeleteVariable(key)}
                    className="ml-3 p-2 rounded-sm text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-red-500"
                    title={t('common.delete', 'Delete')}
                    aria-label={`${t('common.delete', 'Delete')} {{${key}}}`}
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
          <Icon
            name="lightbulb"
            className="w-5 h-5 text-yellow-700 dark:text-yellow-400 mr-2 shrink-0 mt-0.5"
          />
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
