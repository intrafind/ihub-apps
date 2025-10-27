import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import DynamicLanguageEditor from '../../../shared/components/DynamicLanguageEditor';
import ToolsSelector from '../../../shared/components/ToolsSelector';
import SourcePicker from './SourcePicker';
import Icon from '../../../shared/components/Icon';
import { getLocalizedContent } from '../../../utils/localizeContent';
import {
  validateWithSchema,
  errorsToFieldErrors,
  isFieldRequired
} from '../../../utils/schemaValidation';

/**
 * AppFormEditor - Form-based editor for app configuration
 * This component contains all the form fields for editing app configuration
 * and is designed to be integrated with the DualModeEditor component.
 *
 * @component
 * @param {Object} props - Component props
 * @param {Object} props.value - The app configuration object
 * @param {Function} props.onChange - Callback fired when configuration changes
 * @param {Function} props.onValidationChange - Callback fired when validation state changes
 * @param {Array} props.availableModels - Available AI models
 * @param {Object} props.uiConfig - UI configuration for categories etc.
 * @returns {React.Component} AppFormEditor component
 */
const AppFormEditor = ({
  value: app,
  onChange,
  onValidationChange,
  availableModels = [],
  uiConfig = null,
  jsonSchema
}) => {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const [validationErrors, setValidationErrors] = useState({});

  // Validation function
  const validateApp = appData => {
    let errors = {};

    // Use schema validation if available
    if (jsonSchema) {
      const validation = validateWithSchema(appData, jsonSchema);
      if (!validation.isValid) {
        errors = errorsToFieldErrors(validation.errors);
      }
    } else {
      // Fallback to manual validation if no schema
      if (!appData.id) {
        errors.id = t('admin.apps.edit.validation.idRequired', 'App ID is required');
      } else if (!/^[a-zA-Z0-9_-]+$/.test(appData.id)) {
        errors.id = t(
          'admin.apps.edit.validation.idInvalid',
          'App ID can only contain letters, numbers, hyphens, and underscores'
        );
      }

      if (!appData.name || !Object.keys(appData.name).length) {
        errors.name = t('admin.apps.edit.validation.nameRequired', 'App name is required');
      }
    }

    if (!appData.description || !Object.keys(appData.description).length) {
      errors.description = t(
        'admin.apps.edit.validation.descriptionRequired',
        'App description is required'
      );
    }

    if (!appData.system || !Object.keys(appData.system).length) {
      errors.system = t(
        'admin.apps.edit.validation.systemRequired',
        'System instructions are required'
      );
    }

    if (!appData.color) {
      errors.color = t('admin.apps.edit.validation.colorRequired', 'Color is required');
    } else if (!/^#[0-9A-Fa-f]{6}$/.test(appData.color)) {
      errors.color = t('admin.apps.edit.validation.colorInvalid', 'Color must be a valid hex code');
    }

    if (!appData.icon) {
      errors.icon = t('admin.apps.edit.validation.iconRequired', 'Icon is required');
    }

    if (!appData.tokenLimit || appData.tokenLimit < 1) {
      errors.tokenLimit = t(
        'admin.apps.edit.validation.tokenLimitRequired',
        'Token limit must be at least 1'
      );
    }

    setValidationErrors(errors);

    const isValid = Object.keys(errors).length === 0;
    if (onValidationChange) {
      onValidationChange({
        isValid,
        errors: Object.entries(errors).map(([field, message]) => ({
          field,
          message,
          severity: 'error'
        }))
      });
    }

    return isValid;
  };

  // Validate on app changes
  useEffect(() => {
    if (app) {
      validateApp(app);
    }
  }, [app, jsonSchema]);

  const handleInputChange = (field, value) => {
    const updatedApp = {
      ...app,
      [field]: value
    };
    onChange(updatedApp);
  };

  const handleLocalizedChange = (field, value) => {
    const updatedApp = {
      ...app,
      [field]: value
    };
    onChange(updatedApp);
  };

  const handleVariableChange = (index, field, value) => {
    const updatedApp = {
      ...app,
      variables: app.variables.map((variable, i) =>
        i === index ? { ...variable, [field]: value } : variable
      )
    };
    onChange(updatedApp);
  };

  const handleVariablePredefinedValueChange = (variableIndex, valueIndex, field, value) => {
    const updatedApp = {
      ...app,
      variables: app.variables.map((variable, i) =>
        i === variableIndex
          ? {
              ...variable,
              predefinedValues: variable.predefinedValues.map((predefinedValue, j) =>
                j === valueIndex ? { ...predefinedValue, [field]: value } : predefinedValue
              )
            }
          : variable
      )
    };
    onChange(updatedApp);
  };

  const addPredefinedValue = variableIndex => {
    const updatedApp = {
      ...app,
      variables: app.variables.map((variable, i) =>
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
    };
    onChange(updatedApp);
  };

  const removePredefinedValue = (variableIndex, valueIndex) => {
    const updatedApp = {
      ...app,
      variables: app.variables.map((variable, i) =>
        i === variableIndex
          ? {
              ...variable,
              predefinedValues: variable.predefinedValues.filter((_, j) => j !== valueIndex)
            }
          : variable
      )
    };
    onChange(updatedApp);
  };

  const addVariable = () => {
    const updatedApp = {
      ...app,
      variables: [
        ...(app.variables || []),
        {
          name: '',
          label: { en: '' },
          type: 'string',
          required: false
          // Don't initialize defaultValue and predefinedValues - they'll be added only when needed
        }
      ]
    };
    onChange(updatedApp);
  };

  const removeVariable = index => {
    const updatedApp = {
      ...app,
      variables: app.variables.filter((_, i) => i !== index)
    };
    onChange(updatedApp);
  };

  const handleStarterPromptChange = (index, field, value) => {
    const updatedApp = {
      ...app,
      starterPrompts: app.starterPrompts.map((prompt, i) =>
        i === index ? { ...prompt, [field]: value } : prompt
      )
    };
    onChange(updatedApp);
  };

  const addStarterPrompt = () => {
    const updatedApp = {
      ...app,
      starterPrompts: [
        ...(app.starterPrompts || []),
        {
          title: { en: '' },
          message: { en: '' },
          variables: {}
        }
      ]
    };
    onChange(updatedApp);
  };

  const removeStarterPrompt = index => {
    const updatedApp = {
      ...app,
      starterPrompts: app.starterPrompts.filter((_, i) => i !== index)
    };
    onChange(updatedApp);
  };

  // Source handling functions
  const handleSourcesChange = selectedSourceIds => {
    const updatedApp = {
      ...app,
      sources: selectedSourceIds
    };
    onChange(updatedApp);
  };

  if (!app) {
    return (
      <div className="p-8 text-center text-gray-500">
        <Icon name="exclamation-triangle" className="h-12 w-12 mx-auto mb-4 text-gray-400" />
        <p className="text-lg font-medium">
          {t('admin.apps.edit.noAppData', 'No app data available')}
        </p>
      </div>
    );
  }

  return (
    <div className="app-form-editor space-y-6">
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
                  {isFieldRequired('id', jsonSchema) && (
                    <span className="text-red-500 ml-1">*</span>
                  )}
                </label>
                <input
                  type="text"
                  required={isFieldRequired('id', jsonSchema)}
                  value={app.id || ''}
                  onChange={e => handleInputChange('id', e.target.value)}
                  className={`mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm ${
                    validationErrors.id ? 'border-red-300' : ''
                  }`}
                />
                {validationErrors.id && (
                  <p className="mt-1 text-sm text-red-600">{validationErrors.id}</p>
                )}
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
                  label={
                    <span>
                      {t('admin.apps.edit.name', 'Name')}
                      <span className="text-red-500 ml-1">*</span>
                    </span>
                  }
                  value={app.name || {}}
                  onChange={value => handleLocalizedChange('name', value)}
                  required={true}
                  placeholder={{
                    en: 'Enter app name in English',
                    de: 'App-Name auf Deutsch eingeben'
                  }}
                  error={validationErrors.name}
                />
              </div>

              <div className="col-span-6">
                <DynamicLanguageEditor
                  label={
                    <span>
                      {t('admin.apps.edit.description', 'Description')}
                      <span className="text-red-500 ml-1">*</span>
                    </span>
                  }
                  value={app.description || {}}
                  onChange={value => handleLocalizedChange('description', value)}
                  required={true}
                  type="textarea"
                  placeholder={{
                    en: 'Enter app description in English',
                    de: 'App-Beschreibung auf Deutsch eingeben'
                  }}
                  error={validationErrors.description}
                />
              </div>

              <div className="col-span-6 sm:col-span-3">
                <label className="block text-sm font-medium text-gray-700">
                  {t('admin.apps.edit.color', 'Color')}
                  <span className="text-red-500 ml-1">*</span>
                </label>
                <input
                  type="color"
                  value={app.color || '#4F46E5'}
                  onChange={e => handleInputChange('color', e.target.value)}
                  className={`mt-1 block w-full h-10 rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm ${
                    validationErrors.color ? 'border-red-300' : ''
                  }`}
                />
                {validationErrors.color && (
                  <p className="mt-1 text-sm text-red-600">{validationErrors.color}</p>
                )}
              </div>

              <div className="col-span-6 sm:col-span-3">
                <label className="block text-sm font-medium text-gray-700">
                  {t('admin.apps.edit.icon', 'Icon')}
                  <span className="text-red-500 ml-1">*</span>
                </label>
                <input
                  type="text"
                  value={app.icon || ''}
                  onChange={e => handleInputChange('icon', e.target.value)}
                  className={`mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm ${
                    validationErrors.icon ? 'border-red-300' : ''
                  }`}
                />
                {validationErrors.icon && (
                  <p className="mt-1 text-sm text-red-600">{validationErrors.icon}</p>
                )}
              </div>

              <div className="col-span-6 sm:col-span-3">
                <label className="block text-sm font-medium text-gray-700">
                  {t('admin.apps.edit.preferredModel', 'Preferred Model')}
                </label>
                <select
                  value={app.preferredModel || ''}
                  onChange={e => handleInputChange('preferredModel', e.target.value)}
                  className="mt-1 block w-full rounded-lg border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                >
                  <option value="">{t('admin.apps.edit.selectModel', 'Select model...')}</option>
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
                  value={app.preferredTemperature || 0.7}
                  onChange={e =>
                    handleInputChange('preferredTemperature', parseFloat(e.target.value))
                  }
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                />
              </div>

              <div className="col-span-6 sm:col-span-3">
                <label className="block text-sm font-medium text-gray-700">
                  {t('admin.apps.edit.tokenLimit', 'Token Limit')}
                  <span className="text-red-500 ml-1">*</span>
                </label>
                <input
                  type="number"
                  min="1"
                  value={app.tokenLimit || 4096}
                  onChange={e => handleInputChange('tokenLimit', parseInt(e.target.value))}
                  className={`mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm ${
                    validationErrors.tokenLimit ? 'border-red-300' : ''
                  }`}
                />
                {validationErrors.tokenLimit && (
                  <p className="mt-1 text-sm text-red-600">{validationErrors.tokenLimit}</p>
                )}
              </div>

              <div className="col-span-6 sm:col-span-3">
                <label className="block text-sm font-medium text-gray-700">
                  {t('admin.apps.edit.outputFormat', 'Output Format')}
                </label>
                <select
                  value={app.preferredOutputFormat || 'markdown'}
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
                    checked={app.enabled !== false}
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
              label={
                <span>
                  {t('admin.apps.edit.systemInstructions', 'System Instructions')}
                  <span className="text-red-500 ml-1">*</span>
                </span>
              }
              value={app.system || {}}
              onChange={value => handleLocalizedChange('system', value)}
              type="textarea"
              placeholder={{
                en: 'Enter system instructions in English',
                de: 'Systeminstruktionen auf Deutsch eingeben'
              }}
              className="mb-6"
              error={validationErrors.system}
            />

            <DynamicLanguageEditor
              label={t('admin.apps.edit.messagePlaceholder', 'Message Placeholder')}
              value={app.messagePlaceholder || {}}
              onChange={value => handleLocalizedChange('messagePlaceholder', value)}
              placeholder={{
                en: 'Enter message placeholder in English',
                de: 'Nachrichtenplatzhalter auf Deutsch eingeben'
              }}
              className="mb-6"
            />

            <DynamicLanguageEditor
              label={t('admin.apps.edit.prompt', 'Prompt Template')}
              value={app.prompt || {}}
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
              {t('admin.apps.edit.toolsDesc', 'Configure which tools are available for this app')}
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

      {/* Variables Configuration */}
      <div className="bg-white shadow px-4 py-5 sm:rounded-lg sm:p-6">
        <div className="md:grid md:grid-cols-3 md:gap-6">
          <div className="md:col-span-1">
            <h3 className="text-lg font-medium leading-6 text-gray-900">
              {t('admin.apps.edit.variables', 'Variables')}
            </h3>
            <p className="mt-1 text-sm text-gray-500">
              {t('admin.apps.edit.variablesDesc', 'Configure input variables for dynamic prompts')}
            </p>
          </div>
          <div className="mt-5 md:col-span-2 md:mt-0">
            <div className="space-y-4">
              {(app.variables || []).map((variable, index) => (
                <div key={index} className="border border-gray-200 rounded-lg p-4">
                  <div className="flex justify-between items-start mb-4">
                    <h4 className="text-sm font-medium text-gray-900">
                      {t('admin.apps.edit.variable', 'Variable')} {index + 1}
                    </h4>
                    <button
                      type="button"
                      onClick={() => removeVariable(index)}
                      className="text-red-600 hover:text-red-800"
                    >
                      <Icon name="trash" className="h-4 w-4" />
                    </button>
                  </div>

                  <div className="grid grid-cols-6 gap-4">
                    <div className="col-span-6 sm:col-span-2">
                      <label className="block text-sm font-medium text-gray-700">
                        {t('admin.apps.edit.variableName', 'Name')}
                      </label>
                      <input
                        type="text"
                        value={variable.name || ''}
                        onChange={e => handleVariableChange(index, 'name', e.target.value)}
                        className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                      />
                    </div>

                    <div className="col-span-6 sm:col-span-2">
                      <label className="block text-sm font-medium text-gray-700">
                        {t('admin.apps.edit.variableType', 'Type')}
                      </label>
                      <select
                        value={variable.type || 'string'}
                        onChange={e => handleVariableChange(index, 'type', e.target.value)}
                        className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                      >
                        <option value="string">{t('admin.apps.edit.typeString', 'String')}</option>
                        <option value="text">{t('admin.apps.edit.typeText', 'Text')}</option>
                        <option value="select">{t('admin.apps.edit.typeSelect', 'Select')}</option>
                        <option value="date">{t('admin.apps.edit.typeDate', 'Date')}</option>
                        <option value="number">{t('admin.apps.edit.typeNumber', 'Number')}</option>
                      </select>
                    </div>

                    <div className="col-span-6 sm:col-span-2 flex items-end">
                      <div className="flex items-center h-5">
                        <input
                          type="checkbox"
                          checked={variable.required || false}
                          onChange={e => handleVariableChange(index, 'required', e.target.checked)}
                          className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
                        />
                        <label className="ml-2 block text-sm text-gray-900">
                          {t('admin.apps.edit.required', 'Required')}
                        </label>
                      </div>
                    </div>

                    <div className="col-span-6">
                      <DynamicLanguageEditor
                        label={t('admin.apps.edit.variableLabel', 'Label')}
                        value={variable.label || {}}
                        onChange={value => handleVariableChange(index, 'label', value)}
                        placeholder={{
                          en: 'Enter variable label in English',
                          de: 'Variablenbeschriftung auf Deutsch eingeben'
                        }}
                      />
                    </div>

                    <div className="col-span-6">
                      <DynamicLanguageEditor
                        label={t('admin.apps.edit.defaultValue', 'Default Value')}
                        value={variable.defaultValue || {}}
                        onChange={value => handleVariableChange(index, 'defaultValue', value)}
                        placeholder={{
                          en: 'Enter default value in English',
                          de: 'Standardwert auf Deutsch eingeben'
                        }}
                      />
                    </div>

                    {variable.type === 'select' && (
                      <div className="col-span-6">
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                          {t('admin.apps.edit.predefinedValues', 'Predefined Values')}
                        </label>
                        <div className="space-y-2">
                          {(variable.predefinedValues || []).map((predefinedValue, valueIndex) => (
                            <div key={valueIndex} className="flex items-center space-x-2">
                              <div className="flex-1">
                                <DynamicLanguageEditor
                                  label={`${t('admin.apps.edit.option', 'Option')} ${valueIndex + 1}`}
                                  value={predefinedValue.label || {}}
                                  onChange={value =>
                                    handleVariablePredefinedValueChange(
                                      index,
                                      valueIndex,
                                      'label',
                                      value
                                    )
                                  }
                                  placeholder={{
                                    en: 'Option label',
                                    de: 'Options-Beschriftung'
                                  }}
                                />
                              </div>
                              <div className="w-32">
                                <input
                                  type="text"
                                  value={predefinedValue.value || ''}
                                  onChange={e =>
                                    handleVariablePredefinedValueChange(
                                      index,
                                      valueIndex,
                                      'value',
                                      e.target.value
                                    )
                                  }
                                  placeholder={t('admin.apps.edit.value', 'Value')}
                                  className="block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                                />
                              </div>
                              <button
                                type="button"
                                onClick={() => removePredefinedValue(index, valueIndex)}
                                className="text-red-600 hover:text-red-800"
                              >
                                <Icon name="trash" className="h-4 w-4" />
                              </button>
                            </div>
                          ))}
                          <button
                            type="button"
                            onClick={() => addPredefinedValue(index)}
                            className="inline-flex items-center px-3 py-2 border border-gray-300 shadow-sm text-sm leading-4 font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
                          >
                            <Icon name="plus" className="h-4 w-4 mr-2" />
                            {t('admin.apps.edit.addOption', 'Add Option')}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              ))}

              <button
                type="button"
                onClick={addVariable}
                className="inline-flex items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
              >
                <Icon name="plus" className="h-4 w-4 mr-2" />
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
                'Pre-defined prompts to help users get started'
              )}
            </p>
          </div>
          <div className="mt-5 md:col-span-2 md:mt-0">
            <div className="space-y-4">
              {(app.starterPrompts || []).map((prompt, index) => (
                <div key={index} className="border border-gray-200 rounded-lg p-4">
                  <div className="flex justify-between items-start mb-4">
                    <h4 className="text-sm font-medium text-gray-900">
                      {t('admin.apps.edit.starterPrompt', 'Starter Prompt')} {index + 1}
                    </h4>
                    <button
                      type="button"
                      onClick={() => removeStarterPrompt(index)}
                      className="text-red-600 hover:text-red-800"
                    >
                      <Icon name="trash" className="h-4 w-4" />
                    </button>
                  </div>

                  <div className="space-y-4">
                    <DynamicLanguageEditor
                      label={t('admin.apps.edit.title', 'Title')}
                      value={prompt.title || {}}
                      onChange={value => handleStarterPromptChange(index, 'title', value)}
                      placeholder={{
                        en: 'Enter prompt title in English',
                        de: 'Prompt-Titel auf Deutsch eingeben'
                      }}
                    />

                    <DynamicLanguageEditor
                      label={t('admin.apps.edit.message', 'Message')}
                      value={prompt.message || {}}
                      onChange={value => handleStarterPromptChange(index, 'message', value)}
                      type="textarea"
                      placeholder={{
                        en: 'Enter prompt message in English',
                        de: 'Prompt-Nachricht auf Deutsch eingeben'
                      }}
                    />
                  </div>
                </div>
              ))}

              <button
                type="button"
                onClick={addStarterPrompt}
                className="inline-flex items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
              >
                <Icon name="plus" className="h-4 w-4 mr-2" />
                {t('admin.apps.edit.addStarterPrompt', 'Add Starter Prompt')}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Upload Configuration */}
      <div className="bg-white shadow px-4 py-5 sm:rounded-lg sm:p-6">
        <div className="md:grid md:grid-cols-3 md:gap-6">
          <div className="md:col-span-1">
            <h3 className="text-lg font-medium leading-6 text-gray-900">
              {t('admin.apps.edit.upload', 'Upload Configuration')}
            </h3>
            <p className="mt-1 text-sm text-gray-500">
              {t('admin.apps.edit.uploadDesc', 'Configure file and image upload capabilities')}
            </p>
          </div>
          <div className="mt-5 md:col-span-2 md:mt-0">
            <div className="space-y-6">
              <div className="flex items-center">
                <input
                  type="checkbox"
                  checked={app.upload?.enabled || false}
                  onChange={e =>
                    handleInputChange('upload', { ...app.upload, enabled: e.target.checked })
                  }
                  className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
                />
                <label className="ml-2 block text-sm text-gray-900">
                  {t('admin.apps.edit.enableUpload', 'Enable Upload')}
                </label>
              </div>

              {app.upload?.enabled && (
                <div className="space-y-4 pl-6">
                  <div className="flex items-center">
                    <input
                      type="checkbox"
                      checked={app.upload?.allowMultiple || false}
                      onChange={e =>
                        handleInputChange('upload', {
                          ...app.upload,
                          allowMultiple: e.target.checked
                        })
                      }
                      className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
                    />
                    <label className="ml-2 block text-sm text-gray-900">
                      {t('admin.apps.edit.allowMultiple', 'Allow Multiple Files')}
                    </label>
                  </div>

                  <div>
                    <div className="flex items-center mb-2">
                      <input
                        type="checkbox"
                        checked={app.upload?.imageUpload?.enabled || false}
                        onChange={e =>
                          handleInputChange('upload', {
                            ...app.upload,
                            imageUpload: { ...app.upload.imageUpload, enabled: e.target.checked }
                          })
                        }
                        className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
                      />
                      <label className="ml-2 block text-sm font-medium text-gray-900">
                        {t('admin.apps.edit.enableImageUpload', 'Enable Image Upload')}
                      </label>
                    </div>
                    {app.upload?.imageUpload?.enabled && (
                      <div className="ml-6 space-y-3">
                        <div>
                          <label className="block text-xs font-medium text-gray-700">
                            {t('admin.apps.edit.maxImageSize', 'Max Image Size (MB)')}
                          </label>
                          <input
                            type="number"
                            min="1"
                            max="50"
                            value={app.upload?.imageUpload?.maxFileSizeMB || 10}
                            onChange={e =>
                              handleInputChange('upload', {
                                ...app.upload,
                                imageUpload: {
                                  ...app.upload.imageUpload,
                                  maxFileSizeMB: parseInt(e.target.value)
                                }
                              })
                            }
                            className="mt-1 block w-20 rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 text-xs"
                          />
                        </div>
                        <div className="flex items-center">
                          <input
                            type="checkbox"
                            checked={app.upload?.imageUpload?.resizeImages !== false}
                            onChange={e =>
                              handleInputChange('upload', {
                                ...app.upload,
                                imageUpload: {
                                  ...app.upload.imageUpload,
                                  resizeImages: e.target.checked
                                }
                              })
                            }
                            className="h-3 w-3 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
                          />
                          <label className="ml-2 block text-xs text-gray-700">
                            {t('admin.apps.edit.resizeImages', 'Resize Images')}
                          </label>
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-gray-700">
                            {t('admin.apps.edit.supportedImageFormats', 'Supported Image Formats')}
                          </label>
                          <div className="mt-1 space-y-1">
                            {[
                              'image/jpeg',
                              'image/jpg',
                              'image/png',
                              'image/gif',
                              'image/webp'
                            ].map(format => (
                              <div key={format} className="flex items-center">
                                <input
                                  type="checkbox"
                                  checked={
                                    app.upload?.imageUpload?.supportedFormats?.includes(format) !==
                                    false
                                  }
                                  onChange={e => {
                                    const currentFormats = app.upload?.imageUpload
                                      ?.supportedFormats || [
                                      'image/jpeg',
                                      'image/jpg',
                                      'image/png',
                                      'image/gif',
                                      'image/webp'
                                    ];
                                    const newFormats = e.target.checked
                                      ? [...currentFormats.filter(f => f !== format), format]
                                      : currentFormats.filter(f => f !== format);
                                    handleInputChange('upload', {
                                      ...app.upload,
                                      imageUpload: {
                                        ...app.upload.imageUpload,
                                        supportedFormats: newFormats
                                      }
                                    });
                                  }}
                                  className="h-3 w-3 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
                                />
                                <label className="ml-2 block text-xs text-gray-700">
                                  {format.replace('image/', '').toUpperCase()}
                                </label>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  <div>
                    <div className="flex items-center mb-2">
                      <input
                        type="checkbox"
                        checked={app.upload?.fileUpload?.enabled || false}
                        onChange={e =>
                          handleInputChange('upload', {
                            ...app.upload,
                            fileUpload: { ...app.upload.fileUpload, enabled: e.target.checked }
                          })
                        }
                        className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
                      />
                      <label className="ml-2 block text-sm font-medium text-gray-900">
                        {t('admin.apps.edit.enableFileUpload', 'Enable File Upload')}
                      </label>
                    </div>
                    {app.upload?.fileUpload?.enabled && (
                      <div className="ml-6 space-y-3">
                        <div>
                          <label className="block text-xs font-medium text-gray-700">
                            {t('admin.apps.edit.maxFileSize', 'Max File Size (MB)')}
                          </label>
                          <input
                            type="number"
                            min="1"
                            max="100"
                            value={app.upload?.fileUpload?.maxFileSizeMB || 5}
                            onChange={e =>
                              handleInputChange('upload', {
                                ...app.upload,
                                fileUpload: {
                                  ...app.upload.fileUpload,
                                  maxFileSizeMB: parseInt(e.target.value)
                                }
                              })
                            }
                            className="mt-1 block w-20 rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 text-xs"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-gray-700">
                            {t('admin.apps.edit.supportedTextFormats', 'Supported Text Formats')}
                          </label>
                          <div className="mt-1 space-y-1">
                            {[
                              'text/plain',
                              'text/markdown',
                              'text/csv',
                              'application/json',
                              'text/html',
                              'text/css',
                              'text/javascript',
                              'application/javascript',
                              'text/xml'
                            ].map(format => (
                              <div key={format} className="flex items-center">
                                <input
                                  type="checkbox"
                                  checked={
                                    app.upload?.fileUpload?.supportedTextFormats?.includes(
                                      format
                                    ) !== false
                                  }
                                  onChange={e => {
                                    const currentFormats = app.upload?.fileUpload
                                      ?.supportedTextFormats || [
                                      'text/plain',
                                      'text/markdown',
                                      'text/csv',
                                      'application/json',
                                      'text/html',
                                      'text/css',
                                      'text/javascript',
                                      'application/javascript',
                                      'text/xml'
                                    ];
                                    const newFormats = e.target.checked
                                      ? [...currentFormats.filter(f => f !== format), format]
                                      : currentFormats.filter(f => f !== format);
                                    handleInputChange('upload', {
                                      ...app.upload,
                                      fileUpload: {
                                        ...app.upload.fileUpload,
                                        supportedTextFormats: newFormats
                                      }
                                    });
                                  }}
                                  className="h-3 w-3 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
                                />
                                <label className="ml-2 block text-xs text-gray-700">
                                  {format
                                    .replace('text/', '')
                                    .replace('application/', '')
                                    .toUpperCase()}
                                </label>
                              </div>
                            ))}
                          </div>
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-gray-700">
                            {t('admin.apps.edit.supportedPdfFormats', 'PDF Support')}
                          </label>
                          <div className="mt-1">
                            <div className="flex items-center">
                              <input
                                type="checkbox"
                                checked={
                                  app.upload?.fileUpload?.supportedPdfFormats?.includes(
                                    'application/pdf'
                                  ) !== false
                                }
                                onChange={e => {
                                  const newFormats = e.target.checked ? ['application/pdf'] : [];
                                  handleInputChange('upload', {
                                    ...app.upload,
                                    fileUpload: {
                                      ...app.upload.fileUpload,
                                      supportedPdfFormats: newFormats
                                    }
                                  });
                                }}
                                className="h-3 w-3 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
                              />
                              <label className="ml-2 block text-xs text-gray-700">
                                {t('admin.apps.edit.enablePdfUpload', 'Enable PDF Upload')}
                              </label>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
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
              {t('admin.apps.edit.magicPromptDesc', 'AI-powered prompt enhancement feature')}
            </p>
          </div>
          <div className="mt-5 md:col-span-2 md:mt-0">
            <div className="space-y-4">
              <div className="flex items-center">
                <input
                  type="checkbox"
                  checked={app.features?.magicPrompt?.enabled || false}
                  onChange={e =>
                    handleInputChange('features', {
                      ...app.features,
                      magicPrompt: { ...app.features?.magicPrompt, enabled: e.target.checked }
                    })
                  }
                  className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
                />
                <label className="ml-2 block text-sm text-gray-900">
                  {t('admin.apps.edit.enableMagicPrompt', 'Enable Magic Prompt')}
                </label>
              </div>

              {app.features?.magicPrompt?.enabled && (
                <div className="space-y-4 pl-6">
                  <div>
                    <label className="block text-sm font-medium text-gray-700">
                      {t('admin.apps.edit.magicPromptModel', 'Magic Prompt Model')}
                    </label>
                    <select
                      value={app.features?.magicPrompt?.model || 'gpt-4'}
                      onChange={e =>
                        handleInputChange('features', {
                          ...app.features,
                          magicPrompt: { ...app.features?.magicPrompt, model: e.target.value }
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
                      {t('admin.apps.edit.magicPromptInstructions', 'Magic Prompt Instructions')}
                    </label>
                    <textarea
                      value={
                        app.features?.magicPrompt?.prompt ||
                        'You are a helpful assistant that improves user prompts to be more specific and effective. Improve this prompt: {{prompt}}'
                      }
                      onChange={e =>
                        handleInputChange('features', {
                          ...app.features,
                          magicPrompt: { ...app.features?.magicPrompt, prompt: e.target.value }
                        })
                      }
                      rows={3}
                      className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                      placeholder="Enter instructions for the magic prompt feature..."
                    />
                    <p className="mt-1 text-xs text-gray-500">
                      {t(
                        'admin.apps.edit.magicPromptPlaceholder',
                        "Use {{prompt}} to reference the user's original prompt"
                      )}
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Input Mode & Microphone Configuration */}
      <div className="bg-white shadow px-4 py-5 sm:rounded-lg sm:p-6">
        <div className="md:grid md:grid-cols-3 md:gap-6">
          <div className="md:col-span-1">
            <h3 className="text-lg font-medium leading-6 text-gray-900">
              {t('admin.apps.edit.inputMode', 'Input Mode & Microphone')}
            </h3>
            <p className="mt-1 text-sm text-gray-500">
              {t('admin.apps.edit.inputModeDesc', 'Configure input methods and voice recognition')}
            </p>
          </div>
          <div className="mt-5 md:col-span-2 md:mt-0">
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700">
                  {t('admin.apps.edit.inputType', 'Input Type')}
                </label>
                <select
                  value={app.inputMode?.type || 'multiline'}
                  onChange={e =>
                    handleInputChange('inputMode', {
                      ...app.inputMode,
                      type: e.target.value
                    })
                  }
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                >
                  <option value="singleline">
                    {t('admin.apps.edit.singleLine', 'Single Line')}
                  </option>
                  <option value="multiline">{t('admin.apps.edit.multiLine', 'Multi Line')}</option>
                </select>
              </div>

              {app.inputMode?.type === 'multiline' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    {t('admin.apps.edit.textareaRows', 'Textarea Rows')}
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="20"
                    value={app.inputMode?.rows || 5}
                    onChange={e =>
                      handleInputChange('inputMode', {
                        ...app.inputMode,
                        rows: parseInt(e.target.value)
                      })
                    }
                    className="mt-1 block w-20 rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                  />
                </div>
              )}

              <div>
                <div className="flex items-center mb-2">
                  <input
                    type="checkbox"
                    checked={app.inputMode?.microphone?.enabled !== false}
                    onChange={e =>
                      handleInputChange('inputMode', {
                        ...app.inputMode,
                        microphone: { ...app.inputMode?.microphone, enabled: e.target.checked }
                      })
                    }
                    className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
                  />
                  <label className="ml-2 block text-sm font-medium text-gray-900">
                    {t('admin.apps.edit.enableMicrophone', 'Enable Microphone')}
                  </label>
                </div>

                {app.inputMode?.microphone?.enabled && (
                  <div className="space-y-3 pl-6">
                    <div>
                      <label className="block text-sm font-medium text-gray-700">
                        {t('admin.apps.edit.microphoneMode', 'Microphone Mode')}
                      </label>
                      <select
                        value={app.inputMode?.microphone?.mode || 'manual'}
                        onChange={e =>
                          handleInputChange('inputMode', {
                            ...app.inputMode,
                            microphone: { ...app.inputMode?.microphone, mode: e.target.value }
                          })
                        }
                        className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                      >
                        <option value="manual">
                          {t('admin.apps.edit.manualMode', 'Manual (Click to Record)')}
                        </option>
                        <option value="continuous">
                          {t('admin.apps.edit.continuousMode', 'Continuous (Voice Activation)')}
                        </option>
                      </select>
                    </div>

                    <div className="flex items-center">
                      <input
                        type="checkbox"
                        checked={app.inputMode?.microphone?.showTranscript !== false}
                        onChange={e =>
                          handleInputChange('inputMode', {
                            ...app.inputMode,
                            microphone: {
                              ...app.inputMode?.microphone,
                              showTranscript: e.target.checked
                            }
                          })
                        }
                        className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
                      />
                      <label className="ml-2 block text-sm text-gray-900">
                        {t('admin.apps.edit.showTranscript', 'Show Transcript')}
                      </label>
                    </div>
                  </div>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700">
                  {t('admin.apps.edit.speechRecognitionService', 'Speech Recognition Service')}
                </label>
                <select
                  value={app.settings?.speechRecognition?.service || 'default'}
                  onChange={e =>
                    handleInputChange('settings', {
                      ...app.settings,
                      speechRecognition: {
                        ...app.settings?.speechRecognition,
                        service: e.target.value
                      }
                    })
                  }
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                >
                  <option value="default">
                    {t('admin.apps.edit.defaultService', 'Default (Browser)')}
                  </option>
                  <option value="custom">
                    {t('admin.apps.edit.customService', 'Custom Service')}
                  </option>
                </select>
              </div>

              {app.settings?.speechRecognition?.service === 'custom' && (
                <div className="pl-6">
                  <label className="block text-sm font-medium text-gray-700">
                    {t('admin.apps.edit.customServiceHost', 'Custom Service Host')}
                  </label>
                  <input
                    type="url"
                    value={app.settings?.speechRecognition?.host || ''}
                    onChange={e =>
                      handleInputChange('settings', {
                        ...app.settings,
                        speechRecognition: {
                          ...app.settings?.speechRecognition,
                          host: e.target.value
                        }
                      })
                    }
                    placeholder="https://your-speech-service.com"
                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                  />
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Sources Configuration */}
      <div className="bg-white shadow px-4 py-5 sm:rounded-lg sm:p-6">
        <div className="md:grid md:grid-cols-3 md:gap-6">
          <div className="md:col-span-1">
            <h3 className="text-lg font-medium leading-6 text-gray-900">
              {t('admin.apps.edit.sources', 'Sources Configuration')}
            </h3>
            <p className="mt-1 text-sm text-gray-500">
              {t(
                'admin.apps.edit.sourcesDesc',
                'Configure data sources that provide content to this app'
              )}
            </p>
          </div>
          <div className="mt-5 md:col-span-2 md:mt-0">
            <div className="space-y-6">
              {/* Source References */}
              <div>
                <p className="text-sm text-gray-600 mb-4">
                  {t(
                    'admin.apps.edit.sourcesDesc',
                    'Select data sources configured in the admin interface to provide content to this app'
                  )}
                </p>
                <SourcePicker
                  value={app.sources || []}
                  onChange={handleSourcesChange}
                  allowMultiple={true}
                  className="mb-4"
                />
              </div>

              {/* Sources Summary */}
              {app.sources && app.sources.length > 0 && (
                <div className="bg-blue-50 border border-blue-200 rounded-md p-4">
                  <div className="flex">
                    <div className="flex-shrink-0">
                      <Icon name="information-circle" className="h-5 w-5 text-blue-400" />
                    </div>
                    <div className="ml-3">
                      <h3 className="text-sm font-medium text-blue-800">
                        {t('admin.apps.edit.sourcesConfigured', 'Sources Configured')}
                      </h3>
                      <div className="mt-2 text-sm text-blue-700">
                        <p>
                          {t(
                            'admin.apps.edit.sourcesCount',
                            'This app has {{count}} source(s) configured:',
                            { count: app.sources.length }
                          )}
                        </p>
                        <ul className="list-disc list-inside mt-1 space-y-1">
                          {app.sources.map((sourceId, index) => (
                            <li key={`source-${index}`}>
                              <span className="font-mono text-xs bg-blue-100 px-1 rounded">
                                {sourceId}
                              </span>
                            </li>
                          ))}
                        </ul>
                        <p className="mt-2 text-xs">
                          {t(
                            'admin.apps.edit.sourcesUsage',
                            'Sources will be loaded and their content made available via {{sources}} template in system prompts.'
                          )}
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Settings Configuration */}
      <div className="bg-white shadow px-4 py-5 sm:rounded-lg sm:p-6">
        <div className="md:grid md:grid-cols-3 md:gap-6">
          <div className="md:col-span-1">
            <h3 className="text-lg font-medium leading-6 text-gray-900">
              {t('admin.apps.edit.settings', 'User Settings')}
            </h3>
            <p className="mt-1 text-sm text-gray-500">
              {t('admin.apps.edit.settingsDesc', 'Configure which settings users can modify')}
            </p>
          </div>
          <div className="mt-5 md:col-span-2 md:mt-0">
            <div className="space-y-4">
              <div className="flex items-center">
                <input
                  type="checkbox"
                  checked={app.settings?.model?.enabled !== false}
                  onChange={e =>
                    handleInputChange('settings', {
                      ...app.settings,
                      model: { enabled: e.target.checked }
                    })
                  }
                  className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
                />
                <label className="ml-2 block text-sm text-gray-900">
                  {t('admin.apps.edit.enableModelSelection', 'Enable Model Selection')}
                </label>
              </div>

              <div className="flex items-center">
                <input
                  type="checkbox"
                  checked={app.settings?.temperature?.enabled !== false}
                  onChange={e =>
                    handleInputChange('settings', {
                      ...app.settings,
                      temperature: { enabled: e.target.checked }
                    })
                  }
                  className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
                />
                <label className="ml-2 block text-sm text-gray-900">
                  {t('admin.apps.edit.enableTemperatureControl', 'Enable Temperature Control')}
                </label>
              </div>

              <div className="flex items-center">
                <input
                  type="checkbox"
                  checked={app.settings?.outputFormat?.enabled !== false}
                  onChange={e =>
                    handleInputChange('settings', {
                      ...app.settings,
                      outputFormat: { enabled: e.target.checked }
                    })
                  }
                  className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
                />
                <label className="ml-2 block text-sm text-gray-900">
                  {t('admin.apps.edit.enableOutputFormat', 'Enable Output Format Selection')}
                </label>
              </div>

              <div className="flex items-center">
                <input
                  type="checkbox"
                  checked={app.settings?.chatHistory?.enabled !== false}
                  onChange={e =>
                    handleInputChange('settings', {
                      ...app.settings,
                      chatHistory: { enabled: e.target.checked }
                    })
                  }
                  className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
                />
                <label className="ml-2 block text-sm text-gray-900">
                  {t('admin.apps.edit.enableChatHistory', 'Enable Chat History Control')}
                </label>
              </div>

              <div className="flex items-center">
                <input
                  type="checkbox"
                  checked={app.settings?.style?.enabled !== false}
                  onChange={e =>
                    handleInputChange('settings', {
                      ...app.settings,
                      style: { enabled: e.target.checked }
                    })
                  }
                  className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
                />
                <label className="ml-2 block text-sm text-gray-900">
                  {t('admin.apps.edit.enableStyleControl', 'Enable Style Control')}
                </label>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AppFormEditor;
