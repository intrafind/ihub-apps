import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../../../utils/localizeContent';
import DynamicLanguageEditor from '../../../shared/components/DynamicLanguageEditor';
import SearchableAppsSelector from '../../apps/components/SearchableAppsSelector';
import Icon from '../../../shared/components/Icon';
import {
  validateWithSchema,
  errorsToFieldErrors,
  isFieldRequired
} from '../../../utils/schemaValidation';

/**
 * Form-based editor for prompt configuration
 * @param {Object} props
 * @param {Object} props.value - Prompt configuration data
 * @param {Function} props.onChange - Callback when data changes
 * @param {Object} props.errors - Validation errors object
 * @param {boolean} props.isNewPrompt - Whether this is a new prompt
 * @param {Array} props.apps - Available apps for linking
 * @param {Array} props.categories - Available categories
 */
const PromptFormEditor = ({
  value: data,
  onChange,
  onValidationChange,
  errors = {},
  isNewPrompt = false,
  apps = [],
  categories = [],
  jsonSchema
}) => {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const [validationErrors, setValidationErrors] = useState({});

  // Validation function
  const validatePrompt = promptData => {
    let errors = {};

    // Use schema validation if available
    if (jsonSchema) {
      const validation = validateWithSchema(promptData, jsonSchema);
      if (!validation.isValid) {
        errors = errorsToFieldErrors(validation.errors);
      }
    } else {
      // Fallback to basic validation if no schema
      if (!promptData.id) {
        errors.id = 'Prompt ID is required';
      }
      if (!promptData.name) {
        errors.name = 'Prompt name is required';
      }
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

  // Validate on data changes
  useEffect(() => {
    if (data) {
      validatePrompt(data);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, jsonSchema]);

  const handleChange = (field, value) => {
    onChange({ ...data, [field]: value });
  };

  const handleInputChange = e => {
    const { name, value, type, checked } = e.target;
    if (name === 'order') {
      handleChange(name, value ? parseInt(value) : undefined);
    } else {
      handleChange(name, type === 'checkbox' ? checked : value);
    }
  };

  const handleVariableChange = (index, field, value) => {
    const newVariables = [...(data.variables || [])];
    newVariables[index] = { ...newVariables[index], [field]: value };
    handleChange('variables', newVariables);
  };

  const addVariable = () => {
    const newVariables = [
      ...(data.variables || []),
      {
        name: '',
        label: { en: '' },
        type: 'string',
        required: false,
        defaultValue: ''
      }
    ];
    handleChange('variables', newVariables);
  };

  const removeVariable = index => {
    const newVariables = data.variables?.filter((_, i) => i !== index) || [];
    handleChange('variables', newVariables);
  };

  const variableTypes = [
    { value: 'string', label: t('admin.prompts.variableTypes.string', 'String') },
    { value: 'number', label: t('admin.prompts.variableTypes.number', 'Number') },
    { value: 'boolean', label: t('admin.prompts.variableTypes.boolean', 'Boolean') },
    { value: 'select', label: t('admin.prompts.variableTypes.select', 'Select') },
    { value: 'textarea', label: t('admin.prompts.variableTypes.textarea', 'Textarea') }
  ];

  return (
    <div className="space-y-8">
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
                  {t('admin.prompts.edit.id', 'ID')}
                  {isFieldRequired('id', jsonSchema) && <span className="text-red-500"> *</span>}
                </label>
                <input
                  type="text"
                  id="id"
                  value={data.id || ''}
                  onChange={e => handleChange('id', e.target.value)}
                  disabled={!isNewPrompt}
                  required={isFieldRequired('id', jsonSchema)}
                  className={`mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm disabled:bg-gray-100 ${
                    validationErrors.id || errors.id
                      ? 'border-red-300 text-red-900 placeholder-red-300'
                      : ''
                  }`}
                  placeholder="unique-prompt-id"
                  autoComplete="off"
                />
                {(validationErrors.id || errors.id) && (
                  <p className="mt-2 text-sm text-red-600">{validationErrors.id || errors.id}</p>
                )}
                <p className="mt-2 text-sm text-gray-500">
                  {t(
                    'admin.prompts.edit.idDesc',
                    'Unique identifier using lowercase letters, numbers, and hyphens'
                  )}
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
                  value={data.icon || ''}
                  onChange={e => handleChange('icon', e.target.value)}
                  className={`mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm ${
                    errors.icon ? 'border-red-300 text-red-900' : ''
                  }`}
                  placeholder="clipboard"
                  autoComplete="off"
                />
                {errors.icon && <p className="mt-2 text-sm text-red-600">{errors.icon}</p>}
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
                  name="order"
                  value={data.order || ''}
                  onChange={handleInputChange}
                  className={`mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm ${
                    errors.order ? 'border-red-300 text-red-900' : ''
                  }`}
                  placeholder="0"
                  autoComplete="off"
                />
                {errors.order && <p className="mt-2 text-sm text-red-600">{errors.order}</p>}
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
                  value={data.category || ''}
                  onChange={e => handleChange('category', e.target.value)}
                  className={`mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm ${
                    errors.category ? 'border-red-300 text-red-900' : ''
                  }`}
                >
                  <option value="">
                    {t('admin.prompts.edit.selectCategory', 'Select category...')}
                  </option>
                  {categories
                    ?.filter(cat => cat.id !== 'all')
                    .map(category => (
                      <option key={category.id} value={category.id}>
                        {getLocalizedContent(category.name, currentLanguage)}
                      </option>
                    ))}
                </select>
                {errors.category && <p className="mt-2 text-sm text-red-600">{errors.category}</p>}
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
                    value={data.appId || ''}
                    onChange={value => handleChange('appId', value)}
                    placeholder={t('admin.prompts.edit.noApp', 'No linked app')}
                    currentLanguage={currentLanguage}
                  />
                </div>
                {errors.appId && <p className="mt-2 text-sm text-red-600">{errors.appId}</p>}
                <p className="mt-2 text-sm text-gray-500">
                  {t('admin.prompts.edit.appIdDesc', 'Link this prompt to a specific app')}
                </p>
              </div>

              {/* Enabled */}
              <div className="col-span-6">
                <div className="flex items-center">
                  <input
                    id="enabled"
                    name="enabled"
                    type="checkbox"
                    checked={data.enabled !== false}
                    onChange={handleInputChange}
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
                label={`${t('admin.prompts.edit.name', 'Name')} *`}
                value={data.name || { en: '' }}
                onChange={value => handleChange('name', value)}
                required={true}
                placeholder={{
                  en: 'Prompt name',
                  de: 'Prompt Name',
                  es: 'Nombre del prompt',
                  fr: 'Nom du prompt'
                }}
                error={errors.name}
              />

              <DynamicLanguageEditor
                label={t('admin.prompts.edit.description', 'Description')}
                value={data.description || { en: '' }}
                onChange={value => handleChange('description', value)}
                type="textarea"
                placeholder={{
                  en: 'Brief description of the prompt',
                  de: 'Kurze Beschreibung des Prompts',
                  es: 'Breve descripción del prompt',
                  fr: 'Brève description du prompt'
                }}
                error={errors.description}
              />

              <DynamicLanguageEditor
                label={`${t('admin.prompts.edit.prompt', 'Prompt')} *`}
                value={data.prompt || { en: '' }}
                onChange={value => handleChange('prompt', value)}
                required={true}
                type="textarea"
                placeholder={{
                  en: 'The actual prompt text. Use {{variableName}} for variables.',
                  de: 'Der eigentliche Prompt-Text. Verwenden Sie {{variableName}} für Variablen.',
                  es: 'El texto del prompt real. Use {{variableName}} para variables.',
                  fr: 'Le texte du prompt réel. Utilisez {{variableName}} pour les variables.'
                }}
                error={errors.prompt}
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
              {t(
                'admin.prompts.edit.variablesDesc',
                'Define variables that can be prefilled when using this prompt'
              )}
            </p>
          </div>
          <div className="mt-5 md:col-span-2 md:mt-0">
            <div className="space-y-4">
              {data.variables?.map((variable, index) => (
                <div key={index} className="border border-gray-200 rounded-lg p-4">
                  <div className="flex justify-between items-start mb-4">
                    <h4 className="text-sm font-medium text-gray-900">
                      {t('admin.prompts.edit.variable', 'Variable {{index}}', {
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
                        {t('admin.prompts.edit.variableName', 'Name')} *
                      </label>
                      <input
                        type="text"
                        value={variable.name || ''}
                        onChange={e => handleVariableChange(index, 'name', e.target.value)}
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
                        value={variable.type || 'string'}
                        onChange={e => handleVariableChange(index, 'type', e.target.value)}
                        className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
                      >
                        {variableTypes.map(type => (
                          <option key={type.value} value={type.value}>
                            {type.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="col-span-2">
                      <DynamicLanguageEditor
                        label={t('admin.prompts.edit.variableLabel', 'Label')}
                        value={variable.label || { en: '' }}
                        onChange={value => handleVariableChange(index, 'label', value)}
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
                        onChange={e => handleVariableChange(index, 'defaultValue', e.target.value)}
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
                        checked={variable.required || false}
                        onChange={e => handleVariableChange(index, 'required', e.target.checked)}
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
    </div>
  );
};

export default PromptFormEditor;
