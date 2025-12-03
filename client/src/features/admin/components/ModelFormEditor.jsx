import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { DEFAULT_LANGUAGE } from '../../../utils/localizeContent';
import DynamicLanguageEditor from '../../../shared/components/DynamicLanguageEditor';
import {
  validateWithSchema,
  errorsToFieldErrors,
  isFieldRequired
} from '../../../utils/schemaValidation';

/**
 * Form-based editor for model configuration
 * @param {Object} props
 * @param {Object} props.value - Model configuration data
 * @param {Function} props.onChange - Callback when data changes
 * @param {Object} props.errors - Validation errors object
 * @param {boolean} props.isNewModel - Whether this is a new model
 */
const ModelFormEditor = ({
  value: data,
  onChange,
  onValidationChange,
  errors = {},
  isNewModel = false,
  jsonSchema
}) => {
  const { t } = useTranslation();
  const [validationErrors, setValidationErrors] = useState({});

  // Validation function
  const validateModel = modelData => {
    let errors = {};

    // Use schema validation if available
    if (jsonSchema) {
      const validation = validateWithSchema(modelData, jsonSchema);
      if (!validation.isValid) {
        errors = errorsToFieldErrors(validation.errors);
      }
    } else {
      // Fallback to basic validation if no schema
      if (!modelData.id) {
        errors.id = 'Model ID is required';
      }
      if (!modelData.name) {
        errors.name = 'Model name is required';
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
      validateModel(data);
    }
  }, [data, jsonSchema]);

  const handleChange = (field, value) => {
    onChange({ ...data, [field]: value });
  };

  const handleInputChange = e => {
    const { name, value, type, checked } = e.target;
    handleChange(name, type === 'checkbox' ? checked : value);
  };

  const providerOptions = [
    { value: 'openai', label: 'OpenAI' },
    { value: 'anthropic', label: 'Anthropic' },
    { value: 'google', label: 'Google' },
    { value: 'mistral', label: 'Mistral' },
    { value: 'local', label: 'Local' }
  ];

  return (
    <div className="space-y-6">
      {/* Basic Information */}
      <div className="bg-white shadow px-4 py-5 sm:rounded-lg sm:p-6">
        <div className="md:grid md:grid-cols-3 md:gap-6">
          <div className="md:col-span-1">
            <h3 className="text-lg font-medium leading-6 text-gray-900">
              {t('admin.models.edit.basicInfo')}
            </h3>
            <p className="mt-1 text-sm text-gray-500">
              {t('admin.models.edit.basicInfoDesc', 'Basic information about the model')}
            </p>
          </div>
          <div className="mt-5 md:mt-0 md:col-span-2">
            <div className="grid grid-cols-6 gap-6">
              <div className="col-span-6 sm:col-span-3">
                <label htmlFor="id" className="block text-sm font-medium text-gray-700">
                  {t('admin.models.fields.id')}
                  {isFieldRequired('id', jsonSchema) && <span className="text-red-500"> *</span>}
                </label>
                <input
                  type="text"
                  name="id"
                  id="id"
                  value={data.id || ''}
                  onChange={handleInputChange}
                  disabled={!isNewModel}
                  className={`mt-1 focus:ring-indigo-500 focus:border-indigo-500 block w-full shadow-sm sm:text-sm border-gray-300 rounded-md disabled:bg-gray-100 ${
                    validationErrors.id || errors.id
                      ? 'border-red-300 text-red-900 placeholder-red-300'
                      : ''
                  }`}
                  required={isFieldRequired('id', jsonSchema)}
                />
                {(validationErrors.id || errors.id) && (
                  <p className="mt-2 text-sm text-red-600">{validationErrors.id || errors.id}</p>
                )}
                <p className="mt-2 text-sm text-gray-500">{t('admin.models.hints.modelId')}</p>
              </div>

              <div className="col-span-6 sm:col-span-3">
                <DynamicLanguageEditor
                  label={`${t('admin.models.fields.name')} *`}
                  value={data.name || { [DEFAULT_LANGUAGE]: '' }}
                  onChange={value => handleChange('name', value)}
                  required={true}
                  error={errors.name}
                />
              </div>

              <div className="col-span-6">
                <DynamicLanguageEditor
                  label={`${t('admin.models.fields.description')} *`}
                  value={data.description || { [DEFAULT_LANGUAGE]: '' }}
                  onChange={value => handleChange('description', value)}
                  required={true}
                  type="textarea"
                  error={errors.description}
                />
              </div>

              <div className="col-span-6 sm:col-span-3">
                <label htmlFor="provider" className="block text-sm font-medium text-gray-700">
                  {t('admin.models.fields.provider')} <span className="text-red-500">*</span>
                </label>
                <select
                  id="provider"
                  name="provider"
                  value={data.provider || ''}
                  onChange={handleInputChange}
                  className={`mt-1 block w-full py-2 px-3 border border-gray-300 bg-white rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm ${
                    errors.provider ? 'border-red-300 text-red-900' : ''
                  }`}
                  required
                >
                  <option value="">{t('admin.models.placeholders.selectProvider')}</option>
                  {providerOptions.map(option => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                {errors.provider && <p className="mt-2 text-sm text-red-600">{errors.provider}</p>}
              </div>

              <div className="col-span-6 sm:col-span-3">
                <label htmlFor="modelId" className="block text-sm font-medium text-gray-700">
                  {t('admin.models.fields.modelId')}
                </label>
                <input
                  type="text"
                  name="modelId"
                  id="modelId"
                  value={data.modelId || ''}
                  onChange={handleInputChange}
                  placeholder={t('admin.models.placeholders.apiModelId')}
                  className={`mt-1 focus:ring-indigo-500 focus:border-indigo-500 block w-full shadow-sm sm:text-sm border-gray-300 rounded-md ${
                    errors.modelId ? 'border-red-300 text-red-900 placeholder-red-300' : ''
                  }`}
                />
                {errors.modelId && <p className="mt-2 text-sm text-red-600">{errors.modelId}</p>}
                <p className="mt-2 text-sm text-gray-500">{t('admin.models.hints.apiModelId')}</p>
              </div>

              <div className="col-span-6">
                <label htmlFor="url" className="block text-sm font-medium text-gray-700">
                  {t('admin.models.fields.url')} <span className="text-red-500">*</span>
                </label>
                <input
                  type="url"
                  name="url"
                  id="url"
                  value={data.url || ''}
                  onChange={handleInputChange}
                  placeholder={t('admin.models.placeholders.apiUrl')}
                  className={`mt-1 focus:ring-indigo-500 focus:border-indigo-500 block w-full shadow-sm sm:text-sm border-gray-300 rounded-md ${
                    errors.url ? 'border-red-300 text-red-900 placeholder-red-300' : ''
                  }`}
                  required
                />
                {errors.url && <p className="mt-2 text-sm text-red-600">{errors.url}</p>}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Configuration */}
      <div className="bg-white shadow px-4 py-5 sm:rounded-lg sm:p-6">
        <div className="md:grid md:grid-cols-3 md:gap-6">
          <div className="md:col-span-1">
            <h3 className="text-lg font-medium leading-6 text-gray-900">
              {t('admin.models.edit.configuration')}
            </h3>
            <p className="mt-1 text-sm text-gray-500">
              {t(
                'admin.models.edit.configurationDesc',
                'Advanced configuration options for the model'
              )}
            </p>
          </div>
          <div className="mt-5 md:mt-0 md:col-span-2">
            <div className="grid grid-cols-6 gap-6">
              <div className="col-span-6 sm:col-span-2">
                <label htmlFor="tokenLimit" className="block text-sm font-medium text-gray-700">
                  {t('admin.models.fields.tokenLimit')}
                  {isFieldRequired('tokenLimit', jsonSchema) && (
                    <span className="text-red-500"> *</span>
                  )}
                </label>
                <input
                  type="number"
                  name="tokenLimit"
                  id="tokenLimit"
                  value={data.tokenLimit || ''}
                  onChange={handleInputChange}
                  min="1"
                  className={`mt-1 focus:ring-indigo-500 focus:border-indigo-500 block w-full shadow-sm sm:text-sm border-gray-300 rounded-md ${
                    errors.tokenLimit ? 'border-red-300 text-red-900' : ''
                  }`}
                  required={isFieldRequired('tokenLimit', jsonSchema)}
                />
                {errors.tokenLimit && (
                  <p className="mt-2 text-sm text-red-600">{errors.tokenLimit}</p>
                )}
              </div>

              <div className="col-span-6 sm:col-span-2">
                <label htmlFor="concurrency" className="block text-sm font-medium text-gray-700">
                  {t('admin.models.fields.concurrency')}
                </label>
                <input
                  type="number"
                  name="concurrency"
                  id="concurrency"
                  value={data.concurrency || ''}
                  onChange={handleInputChange}
                  min="1"
                  className={`mt-1 focus:ring-indigo-500 focus:border-indigo-500 block w-full shadow-sm sm:text-sm border-gray-300 rounded-md ${
                    errors.concurrency ? 'border-red-300 text-red-900' : ''
                  }`}
                />
                {errors.concurrency && (
                  <p className="mt-2 text-sm text-red-600">{errors.concurrency}</p>
                )}
              </div>

              <div className="col-span-6 sm:col-span-2">
                <label htmlFor="requestDelayMs" className="block text-sm font-medium text-gray-700">
                  {t('admin.models.fields.requestDelay')}
                </label>
                <input
                  type="number"
                  name="requestDelayMs"
                  id="requestDelayMs"
                  value={data.requestDelayMs || ''}
                  onChange={handleInputChange}
                  min="0"
                  className={`mt-1 focus:ring-indigo-500 focus:border-indigo-500 block w-full shadow-sm sm:text-sm border-gray-300 rounded-md ${
                    errors.requestDelayMs ? 'border-red-300 text-red-900' : ''
                  }`}
                />
                {errors.requestDelayMs && (
                  <p className="mt-2 text-sm text-red-600">{errors.requestDelayMs}</p>
                )}
              </div>

              <div className="col-span-6">
                <fieldset>
                  <legend className="text-base font-medium text-gray-900">Options</legend>
                  <div className="mt-4 space-y-4">
                    <div className="flex items-start">
                      <div className="flex items-center h-5">
                        <input
                          id="supportsTools"
                          name="supportsTools"
                          type="checkbox"
                          checked={data.supportsTools || false}
                          onChange={handleInputChange}
                          className="focus:ring-indigo-500 h-4 w-4 text-indigo-600 border-gray-300 rounded"
                        />
                      </div>
                      <div className="ml-3 text-sm">
                        <label htmlFor="supportsTools" className="font-medium text-gray-700">
                          {t('admin.models.fields.supportsTools')}
                        </label>
                      </div>
                    </div>
                    <div className="flex items-start">
                      <div className="flex items-center h-5">
                        <input
                          id="enabled"
                          name="enabled"
                          type="checkbox"
                          checked={data.enabled !== false}
                          onChange={handleInputChange}
                          className="focus:ring-indigo-500 h-4 w-4 text-indigo-600 border-gray-300 rounded"
                        />
                      </div>
                      <div className="ml-3 text-sm">
                        <label htmlFor="enabled" className="font-medium text-gray-700">
                          {t('admin.models.fields.enabled')}
                        </label>
                      </div>
                    </div>
                    <div className="flex items-start">
                      <div className="flex items-center h-5">
                        <input
                          id="default"
                          name="default"
                          type="checkbox"
                          checked={data.default || false}
                          onChange={handleInputChange}
                          className="focus:ring-indigo-500 h-4 w-4 text-indigo-600 border-gray-300 rounded"
                        />
                      </div>
                      <div className="ml-3 text-sm">
                        <label htmlFor="default" className="font-medium text-gray-700">
                          {t('admin.models.fields.defaultModel')}
                        </label>
                      </div>
                    </div>
                  </div>
                </fieldset>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ModelFormEditor;
