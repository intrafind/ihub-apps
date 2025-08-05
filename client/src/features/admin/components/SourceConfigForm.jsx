import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import DynamicLanguageEditor from '../../../shared/components/DynamicLanguageEditor';
import FileUploader from './FileUploader';

const SourceConfigForm = ({ source, onChange, onSave, saving, isEditing }) => {
  const { t } = useTranslation();
  const [formData, setFormData] = useState(source || {});
  const [validationErrors, setValidationErrors] = useState({});

  useEffect(() => {
    if (source) {
      setFormData(source);
    }
  }, [source]);

  const handleChange = (field, value) => {
    const newFormData = {
      ...formData,
      [field]: value
    };
    setFormData(newFormData);
    onChange(newFormData);

    // Clear validation errors for this field
    if (validationErrors[field]) {
      setValidationErrors(prev => {
        const { [field]: removed, ...rest } = prev;
        return rest;
      });
    }
  };

  const handleConfigChange = (configField, value) => {
    const newConfig = {
      ...formData.config,
      [configField]: value
    };
    handleChange('config', newConfig);
  };

  const validateForm = () => {
    const errors = {};

    // Required fields validation
    if (!formData.id?.trim()) {
      errors.id = t('admin.sources.validation.idRequired', 'Source ID is required');
    } else if (!/^[a-zA-Z0-9_-]+$/.test(formData.id)) {
      errors.id = t(
        'admin.sources.validation.idInvalid',
        'ID must contain only letters, numbers, underscores, and hyphens'
      );
    }

    if (!formData.name?.en?.trim()) {
      errors.name = t('admin.sources.validation.nameRequired', 'Source name is required');
    }

    if (!formData.type) {
      errors.type = t('admin.sources.validation.typeRequired', 'Source type is required');
    }

    // Type-specific validation
    if (formData.type === 'filesystem') {
      // File path will be set by FileUploader component
      // No manual validation needed here
    } else if (formData.type === 'url') {
      if (!formData.config?.url?.trim()) {
        errors.url = t('admin.sources.validation.urlRequired', 'URL is required');
      } else {
        try {
          new URL(formData.config.url);
        } catch {
          errors.url = t('admin.sources.validation.urlInvalid', 'Please enter a valid URL');
        }
      }
    } else if (formData.type === 'ifinder') {
      if (!formData.config?.baseUrl?.trim()) {
        errors.baseUrl = t('admin.sources.validation.baseUrlRequired', 'Base URL is required');
      }
      if (!formData.config?.apiKey?.trim()) {
        errors.apiKey = t('admin.sources.validation.apiKeyRequired', 'API key is required');
      }
    } else if (formData.type === 'page') {
      if (!formData.config?.pageId?.trim()) {
        errors.pageId = t('admin.sources.validation.pageIdRequired', 'Page ID is required');
      } else if (!/^[a-zA-Z0-9_-]+$/.test(formData.config.pageId)) {
        errors.pageId = t(
          'admin.sources.validation.pageIdInvalid',
          'Page ID must contain only letters, numbers, underscores, and hyphens'
        );
      }
    }

    setValidationErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = e => {
    e.preventDefault();
    if (validateForm()) {
      onSave(formData);
    }
  };

  const getDefaultConfigForType = type => {
    switch (type) {
      case 'filesystem':
        return {
          path: '',
          encoding: 'utf-8'
        };
      case 'url':
        return {
          url: '',
          method: 'GET',
          headers: {},
          timeout: 10000,
          followRedirects: true,
          maxRedirects: 5,
          retries: 3,
          maxContentLength: 1048576,
          cleanContent: true
        };
      case 'ifinder':
        return {
          baseUrl: '',
          apiKey: '',
          searchProfile: 'default',
          maxResults: 10,
          queryTemplate: '',
          filters: {},
          maxLength: 10000
        };
      case 'page':
        return {
          pageId: '',
          language: 'en'
        };
      default:
        return {};
    }
  };

  const handleTypeChange = newType => {
    const newConfig = getDefaultConfigForType(newType);
    setFormData(prev => ({
      ...prev,
      type: newType,
      config: newConfig
    }));
    onChange({
      ...formData,
      type: newType,
      config: newConfig
    });
  };

  const renderTypeSpecificConfig = () => {
    switch (formData.type) {
      case 'filesystem':
        return (
          <div className="space-y-6">
            <FileUploader source={formData} onChange={setFormData} isEditing={isEditing} />

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                {t('admin.sources.encoding', 'File Encoding')}
              </label>
              <select
                value={formData.config?.encoding || 'utf-8'}
                onChange={e => handleConfigChange('encoding', e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
              >
                <option value="utf-8">UTF-8</option>
                <option value="ascii">ASCII</option>
                <option value="latin1">Latin-1</option>
                <option value="base64">Base64</option>
              </select>
              <p className="mt-1 text-sm text-gray-500">
                {t('admin.sources.encodingHelp', 'Character encoding of the source file')}
              </p>
            </div>
          </div>
        );

      case 'url':
        return (
          <div className="space-y-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                {t('admin.sources.url', 'URL')} *
              </label>
              <input
                type="url"
                value={formData.config?.url || ''}
                onChange={e => handleConfigChange('url', e.target.value)}
                className={`w-full border rounded-lg px-3 py-2 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 ${
                  validationErrors.url ? 'border-red-300' : 'border-gray-300'
                }`}
                placeholder="https://example.com/content"
              />
              {validationErrors.url && (
                <p className="mt-1 text-sm text-red-600">{validationErrors.url}</p>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  {t('admin.sources.method', 'HTTP Method')}
                </label>
                <select
                  value={formData.config?.method || 'GET'}
                  onChange={e => handleConfigChange('method', e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                >
                  <option value="GET">GET</option>
                  <option value="POST">POST</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  {t('admin.sources.timeout', 'Timeout (ms)')}
                </label>
                <input
                  type="number"
                  value={formData.config?.timeout || 10000}
                  onChange={e => handleConfigChange('timeout', parseInt(e.target.value))}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                  min="1000"
                  max="60000"
                />
              </div>
            </div>

            <div className="flex items-center space-x-4">
              <label className="flex items-center">
                <input
                  type="checkbox"
                  checked={formData.config?.followRedirects !== false}
                  onChange={e => handleConfigChange('followRedirects', e.target.checked)}
                  className="h-4 w-4 text-indigo-600 border-gray-300 rounded focus:ring-indigo-500"
                />
                <span className="ml-2 text-sm text-gray-700">
                  {t('admin.sources.followRedirects', 'Follow redirects')}
                </span>
              </label>

              <label className="flex items-center">
                <input
                  type="checkbox"
                  checked={formData.config?.cleanContent !== false}
                  onChange={e => handleConfigChange('cleanContent', e.target.checked)}
                  className="h-4 w-4 text-indigo-600 border-gray-300 rounded focus:ring-indigo-500"
                />
                <span className="ml-2 text-sm text-gray-700">
                  {t('admin.sources.cleanContent', 'Clean HTML content')}
                </span>
              </label>
            </div>
          </div>
        );

      case 'ifinder':
        return (
          <div className="space-y-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                {t('admin.sources.baseUrl', 'iFinder Base URL')} *
              </label>
              <input
                type="url"
                value={formData.config?.baseUrl || ''}
                onChange={e => handleConfigChange('baseUrl', e.target.value)}
                className={`w-full border rounded-lg px-3 py-2 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 ${
                  validationErrors.baseUrl ? 'border-red-300' : 'border-gray-300'
                }`}
                placeholder="https://ifinder.example.com"
              />
              {validationErrors.baseUrl && (
                <p className="mt-1 text-sm text-red-600">{validationErrors.baseUrl}</p>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                {t('admin.sources.apiKey', 'API Key')} *
              </label>
              <input
                type="password"
                value={formData.config?.apiKey || ''}
                onChange={e => handleConfigChange('apiKey', e.target.value)}
                className={`w-full border rounded-lg px-3 py-2 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 ${
                  validationErrors.apiKey ? 'border-red-300' : 'border-gray-300'
                }`}
                placeholder="Enter API key"
              />
              {validationErrors.apiKey && (
                <p className="mt-1 text-sm text-red-600">{validationErrors.apiKey}</p>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  {t('admin.sources.searchProfile', 'Search Profile')}
                </label>
                <input
                  type="text"
                  value={formData.config?.searchProfile || 'default'}
                  onChange={e => handleConfigChange('searchProfile', e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                  placeholder="default"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  {t('admin.sources.maxResults', 'Max Results')}
                </label>
                <input
                  type="number"
                  value={formData.config?.maxResults || 10}
                  onChange={e => handleConfigChange('maxResults', parseInt(e.target.value))}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                  min="1"
                  max="100"
                />
              </div>
            </div>
          </div>
        );

      case 'page':
        return (
          <div className="space-y-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                {t('admin.sources.pageId', 'Page ID')} *
              </label>
              <input
                type="text"
                value={formData.config?.pageId || ''}
                onChange={e => handleConfigChange('pageId', e.target.value)}
                className={`w-full border rounded-lg px-3 py-2 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 ${
                  validationErrors.pageId ? 'border-red-300' : 'border-gray-300'
                }`}
                placeholder="dashboard"
              />
              {validationErrors.pageId && (
                <p className="mt-1 text-sm text-red-600">{validationErrors.pageId}</p>
              )}
              <p className="mt-1 text-sm text-gray-500">
                {t(
                  'admin.sources.pageIdHelp',
                  'Page identifier (e.g., dashboard, about, contact). Only letters, numbers, hyphens, and underscores allowed.'
                )}
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                {t('admin.sources.language', 'Language')}
              </label>
              <select
                value={formData.config?.language || 'en'}
                onChange={e => handleConfigChange('language', e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
              >
                <option value="en">English (en)</option>
                <option value="de">German (de)</option>
                <option value="es">Spanish (es)</option>
                <option value="fr">French (fr)</option>
                <option value="it">Italian (it)</option>
                <option value="pt">Portuguese (pt)</option>
                <option value="nl">Dutch (nl)</option>
              </select>
              <p className="mt-1 text-sm text-gray-500">
                {t('admin.sources.languageHelp', 'Language code for the page content')}
              </p>
            </div>
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-8">
      {/* Basic Information */}
      <div className="border-b border-gray-200 pb-8">
        <h3 className="text-lg font-medium text-gray-900 mb-6">
          {t('admin.sources.basicInfo', 'Basic Information')}
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              {t('admin.sources.id', 'Source ID')} *
            </label>
            <input
              type="text"
              value={formData.id || ''}
              onChange={e => handleChange('id', e.target.value)}
              disabled={isEditing}
              className={`w-full border rounded-lg px-3 py-2 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 ${
                isEditing ? 'bg-gray-100 cursor-not-allowed' : ''
              } ${validationErrors.id ? 'border-red-300' : 'border-gray-300'}`}
              placeholder="unique-source-id"
            />
            {validationErrors.id && (
              <p className="mt-1 text-sm text-red-600">{validationErrors.id}</p>
            )}
            {isEditing && (
              <p className="mt-1 text-sm text-gray-500">
                {t('admin.sources.idCannotBeChanged', 'Source ID cannot be changed after creation')}
              </p>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              {t('admin.sources.type', 'Source Type')} *
            </label>
            <select
              value={formData.type || 'filesystem'}
              onChange={e => handleTypeChange(e.target.value)}
              disabled={isEditing}
              className={`w-full border rounded-lg px-3 py-2 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 ${
                isEditing ? 'bg-gray-100 cursor-not-allowed' : 'border-gray-300'
              }`}
            >
              <option value="filesystem">{t('admin.sources.filesystem', 'Filesystem')}</option>
              <option value="url">{t('admin.sources.url', 'URL')}</option>
              <option value="ifinder">{t('admin.sources.ifinder', 'iFinder')}</option>
              <option value="page">{t('admin.sources.page', 'Page')}</option>
            </select>
            {isEditing && (
              <p className="mt-1 text-sm text-gray-500">
                {t(
                  'admin.sources.typeCannotBeChanged',
                  'Source type cannot be changed after creation'
                )}
              </p>
            )}
          </div>
        </div>

        <div className="mt-6">
          <label className="block text-sm font-medium text-gray-700 mb-2">
            {t('admin.sources.name', 'Name')} *
          </label>
          <DynamicLanguageEditor
            value={formData.name || {}}
            onChange={values => handleChange('name', values)}
            placeholder={t('admin.sources.namePlaceholder', 'Enter source name')}
            error={validationErrors.name}
          />
        </div>

        <div className="mt-6">
          <label className="block text-sm font-medium text-gray-700 mb-2">
            {t('admin.sources.description', 'Description')}
          </label>
          <DynamicLanguageEditor
            value={formData.description || {}}
            onChange={values => handleChange('description', values)}
            placeholder={t('admin.sources.descriptionPlaceholder', 'Enter source description')}
            type="textarea"
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-6">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              {t('admin.sources.exposeAs', 'Expose As')}
            </label>
            <select
              value={formData.exposeAs || 'prompt'}
              onChange={e => handleChange('exposeAs', e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
            >
              <option value="prompt">{t('admin.sources.exposeAsPrompt', 'Prompt Context')}</option>
              <option value="tool">{t('admin.sources.exposeAsTool', 'Tool Function')}</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              {t('admin.sources.category', 'Category')}
            </label>
            <input
              type="text"
              value={formData.category || ''}
              onChange={e => handleChange('category', e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
              placeholder={t('admin.sources.categoryPlaceholder', 'Optional category')}
            />
          </div>

          <div className="flex items-center">
            <label className="flex items-center">
              <input
                type="checkbox"
                checked={formData.enabled !== false}
                onChange={e => handleChange('enabled', e.target.checked)}
                className="h-4 w-4 text-indigo-600 border-gray-300 rounded focus:ring-indigo-500"
              />
              <span className="ml-2 text-sm text-gray-700">
                {t('admin.sources.enabled', 'Enabled')}
              </span>
            </label>
          </div>
        </div>
      </div>

      {/* Type-specific Configuration */}
      <div className="border-b border-gray-200 pb-8">
        <h3 className="text-lg font-medium text-gray-900 mb-6">
          {t('admin.sources.configuration', 'Configuration')}
        </h3>

        {renderTypeSpecificConfig()}
      </div>

      {/* Submit Buttons */}
      <div className="flex items-center justify-between pt-6">
        <button
          type="button"
          onClick={() => window.history.back()}
          className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
        >
          {t('common.cancel', 'Cancel')}
        </button>

        <button
          type="submit"
          disabled={saving}
          className="px-6 py-2 text-sm font-medium text-white bg-indigo-600 border border-transparent rounded-lg hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
        >
          {saving && <Icon name="arrow-path" className="animate-spin h-4 w-4 mr-2" />}
          {saving ? t('common.saving', 'Saving...') : t('common.save', 'Save')}
        </button>
      </div>
    </form>
  );
};

export default SourceConfigForm;
