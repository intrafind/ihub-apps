import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import DynamicLanguageEditor from '../../../shared/components/DynamicLanguageEditor';
import FileUploader from './FileUploader';
import { makeAdminApiCall } from '../../../api/adminApi';

const IDLE_TEST_STATE = { loading: false, data: null, error: null };

// Number inputs yield '' when cleared; store undefined instead of NaN so the
// server-side schema defaults apply on save.
const parseOptionalInt = value => {
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
};

function SourceConfigForm({ source, onChange, onSave, saving, isEditing }) {
  const { t } = useTranslation();
  const [formData, setFormData] = useState(source || {});
  const [validationErrors, setValidationErrors] = useState({});
  // Results of the iFinder "Connect" (document metadata) and query preview
  // checks — cleared whenever the fields they depend on change.
  const [docTest, setDocTest] = useState(IDLE_TEST_STATE);
  const [queryTest, setQueryTest] = useState(IDLE_TEST_STATE);

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
        const { [field]: _removed, ...rest } = prev;
        return rest;
      });
    }
  };

  const handleConfigChange = (configField, value) => {
    const newConfig = {
      ...formData.config,
      [configField]: value
    };

    if (formData.type === 'ifinder') {
      if (['documentId', 'searchProfile'].includes(configField)) {
        setDocTest(IDLE_TEST_STATE);
      }
      if (['query', 'searchProfile', 'maxResults'].includes(configField)) {
        setQueryTest(IDLE_TEST_STATE);
      }
      if (validationErrors.ifinderContent) {
        setValidationErrors(prev => {
          const { ifinderContent: _removed, ...rest } = prev;
          return rest;
        });
      }
    }

    handleChange('config', newConfig);
  };

  const handleIFinderConnect = async () => {
    const documentId = formData.config?.documentId?.trim();
    if (!documentId) return;

    setDocTest({ loading: true, data: null, error: null });
    try {
      const response = await makeAdminApiCall('/admin/sources/_ifinder/metadata', {
        method: 'POST',
        body: {
          documentId,
          searchProfile: formData.config?.searchProfile?.trim() || undefined
        }
      });
      setDocTest({ loading: false, data: response.data?.metadata || null, error: null });
    } catch (err) {
      setDocTest({
        loading: false,
        data: null,
        error:
          err.response?.data?.error ||
          err.message ||
          t('admin.sources.ifinderMetadataFailed', 'Failed to load document metadata')
      });
    }
  };

  const handleIFinderQueryTest = async () => {
    const query = formData.config?.query?.trim();
    if (!query) return;

    setQueryTest({ loading: true, data: null, error: null });
    try {
      const response = await makeAdminApiCall('/admin/sources/_ifinder/search', {
        method: 'POST',
        body: {
          query,
          searchProfile: formData.config?.searchProfile?.trim() || undefined,
          maxResults: formData.config?.maxResults || 10
        }
      });
      setQueryTest({ loading: false, data: response.data || null, error: null });
    } catch (err) {
      setQueryTest({
        loading: false,
        data: null,
        error:
          err.response?.data?.error ||
          err.message ||
          t('admin.sources.ifinderQueryFailed', 'Failed to run search query')
      });
    }
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
      // Validate that filesystem sources have content
      // Either path should be set (file uploaded) or there should be tempContent
      if (!formData.config?.path?.trim() && !formData.config?.tempContent && !isEditing) {
        errors.file = t(
          'admin.sources.validation.fileRequired',
          'Please upload a file or enter content for filesystem sources'
        );
      }
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
      // Tool sources may leave both empty — the model supplies them at call
      // time. Prompt sources must know up front what to load.
      if (formData.exposeAs !== 'tool') {
        const hasDocumentId = formData.config?.documentId?.trim();
        const hasQuery = formData.config?.query?.trim();
        if (!hasDocumentId && !hasQuery) {
          errors.ifinderContent = t(
            'admin.sources.validation.ifinderContentRequired',
            'Provide a document ID or a search query so the source knows which documents to load'
          );
        }
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
      onSave(prepareForSave(formData));
    }
  };

  // Drop empty optional iFinder fields so the stored config stays clean
  const prepareForSave = data => {
    if (data.type !== 'ifinder' || !data.config) {
      return data;
    }
    const config = { ...data.config };
    ['documentId', 'query', 'searchProfile'].forEach(field => {
      if (typeof config[field] === 'string' && config[field].trim() === '') {
        delete config[field];
      }
    });
    return { ...data, config };
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
          documentId: '',
          query: '',
          searchProfile: '',
          maxResults: 10,
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
    setDocTest(IDLE_TEST_STATE);
    setQueryTest(IDLE_TEST_STATE);
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
            {validationErrors.file && (
              <p className="mt-1 text-sm text-red-600">{validationErrors.file}</p>
            )}

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
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 flex items-start">
              <Icon
                name="information-circle"
                className="h-5 w-5 text-blue-600 mt-0.5 mr-2 flex-shrink-0"
              />
              <p className="text-sm text-blue-700">
                {t(
                  'admin.sources.ifinderConnectionInfo',
                  'The iFinder connection (URL and authentication) is managed centrally in the iFinder integration settings under Admin → Providers. Here you only choose which documents this source loads: pin a single document by ID, or use a search query to load the top matching documents.'
                )}
              </p>
            </div>

            {validationErrors.ifinderContent && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                <p className="text-sm text-red-600">{validationErrors.ifinderContent}</p>
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                {t('admin.sources.ifinderDocumentId', 'Document ID')}
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={formData.config?.documentId || ''}
                  onChange={e => handleConfigChange('documentId', e.target.value)}
                  className="flex-1 border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                  placeholder={t(
                    'admin.sources.ifinderDocumentIdPlaceholder',
                    'e.g. 5f2c9a1b3d4e…'
                  )}
                />
                <button
                  type="button"
                  onClick={handleIFinderConnect}
                  disabled={!formData.config?.documentId?.trim() || docTest.loading}
                  className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed flex items-center whitespace-nowrap"
                >
                  <Icon
                    name={docTest.loading ? 'arrow-path' : 'link'}
                    className={`h-4 w-4 mr-2 ${docTest.loading ? 'animate-spin' : ''}`}
                  />
                  {docTest.loading
                    ? t('admin.sources.ifinderConnecting', 'Connecting...')
                    : t('admin.sources.ifinderConnect', 'Connect')}
                </button>
              </div>
              <p className="mt-1 text-sm text-gray-500">
                {t(
                  'admin.sources.ifinderDocumentIdHelp',
                  'Pin this source to one specific iFinder document. Use Connect to load its metadata and verify it is the right one.'
                )}
              </p>

              {docTest.error && (
                <div className="mt-3 bg-red-50 border border-red-200 rounded-lg p-3 flex items-start">
                  <Icon name="x-circle" className="h-5 w-5 text-red-500 mr-2 flex-shrink-0" />
                  <p className="text-sm text-red-700">{docTest.error}</p>
                </div>
              )}

              {docTest.data && (
                <div className="mt-3 bg-green-50 border border-green-200 rounded-lg p-4">
                  <div className="flex items-center mb-2">
                    <Icon name="check-circle" className="h-5 w-5 text-green-600 mr-2" />
                    <span className="font-medium text-green-800">
                      {docTest.data.title ||
                        docTest.data.filename ||
                        t('admin.sources.ifinderUntitledDocument', 'Untitled document')}
                    </span>
                  </div>
                  <dl className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-1 text-sm text-gray-700">
                    {[
                      [t('admin.sources.ifinderMetaAuthor', 'Author'), docTest.data.author],
                      [
                        t('admin.sources.ifinderMetaMediaType', 'Media type'),
                        docTest.data.mediaType
                      ],
                      [t('admin.sources.ifinderMetaFilename', 'File name'), docTest.data.filename],
                      [t('admin.sources.ifinderMetaSize', 'Size'), docTest.data.sizeFormatted],
                      [t('admin.sources.ifinderMetaLanguage', 'Language'), docTest.data.language],
                      [
                        t('admin.sources.ifinderMetaModified', 'Modified'),
                        docTest.data.modificationDate
                      ],
                      [t('admin.sources.ifinderMetaSource', 'Source'), docTest.data.sourceName],
                      [
                        t('admin.sources.ifinderMetaProfile', 'Search profile'),
                        docTest.data.searchProfile
                      ]
                    ]
                      .filter(([, value]) => value !== null && value !== undefined && value !== '')
                      .map(([label, value]) => (
                        <div key={label} className="flex min-w-0">
                          <dt className="font-medium mr-1 flex-shrink-0">{label}:</dt>
                          <dd className="truncate">{String(value)}</dd>
                        </div>
                      ))}
                  </dl>
                  {docTest.data.link && (
                    <a
                      href={docTest.data.link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-2 inline-flex items-center text-sm text-indigo-600 hover:text-indigo-800"
                    >
                      <Icon name="link" className="h-4 w-4 mr-1" />
                      {t('admin.sources.ifinderOpenDocument', 'Open document')}
                    </a>
                  )}
                </div>
              )}
            </div>

            <div className="relative">
              <div className="absolute inset-0 flex items-center" aria-hidden="true">
                <div className="w-full border-t border-gray-200" />
              </div>
              <div className="relative flex justify-center">
                <span className="bg-white px-3 text-sm text-gray-500">
                  {t('admin.sources.ifinderOr', 'or')}
                </span>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                {t('admin.sources.ifinderQuery', 'Search Query')}
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={formData.config?.query || ''}
                  onChange={e => handleConfigChange('query', e.target.value)}
                  className="flex-1 border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                  placeholder={t(
                    'admin.sources.ifinderQueryPlaceholder',
                    'e.g. product manual OR title:"user guide"'
                  )}
                />
                <button
                  type="button"
                  onClick={handleIFinderQueryTest}
                  disabled={!formData.config?.query?.trim() || queryTest.loading}
                  className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed flex items-center whitespace-nowrap"
                >
                  <Icon
                    name={queryTest.loading ? 'arrow-path' : 'magnifying-glass'}
                    className={`h-4 w-4 mr-2 ${queryTest.loading ? 'animate-spin' : ''}`}
                  />
                  {queryTest.loading
                    ? t('admin.sources.ifinderTestingQuery', 'Searching...')
                    : t('admin.sources.ifinderTestQuery', 'Test Query')}
                </button>
              </div>
              <p className="mt-1 text-sm text-gray-500">
                {t(
                  'admin.sources.ifinderQueryHelp',
                  'Documents matching this query are loaded as source content, up to the configured maximum. Ignored when a document ID is set.'
                )}
              </p>

              {queryTest.error && (
                <div className="mt-3 bg-red-50 border border-red-200 rounded-lg p-3 flex items-start">
                  <Icon name="x-circle" className="h-5 w-5 text-red-500 mr-2 flex-shrink-0" />
                  <p className="text-sm text-red-700">{queryTest.error}</p>
                </div>
              )}

              {queryTest.data && (
                <div className="mt-3 bg-green-50 border border-green-200 rounded-lg p-4">
                  <div className="flex items-center mb-2">
                    <Icon name="check-circle" className="h-5 w-5 text-green-600 mr-2" />
                    <span className="font-medium text-green-800">
                      {t(
                        'admin.sources.ifinderQueryMatches',
                        '{{total}} documents found — the first {{shown}} would be loaded',
                        {
                          total: queryTest.data.totalFound ?? 0,
                          shown: queryTest.data.results?.length ?? 0
                        }
                      )}
                    </span>
                  </div>
                  {queryTest.data.results?.length > 0 && (
                    <ul className="divide-y divide-green-200">
                      {queryTest.data.results.map(result => (
                        <li key={result.documentId} className="py-2">
                          <p className="text-sm font-medium text-gray-900">
                            {result.title ||
                              result.filename ||
                              t('admin.sources.ifinderUntitledDocument', 'Untitled document')}
                          </p>
                          <p className="text-xs text-gray-500 truncate">
                            {[result.documentId, result.mediaType, result.sizeFormatted]
                              .filter(Boolean)
                              .join(' · ')}
                          </p>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  {t('admin.sources.searchProfile', 'Search Profile')}
                </label>
                <input
                  type="text"
                  value={formData.config?.searchProfile || ''}
                  onChange={e => handleConfigChange('searchProfile', e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                  placeholder={t('admin.sources.searchProfilePlaceholder', 'Platform default')}
                />
                <p className="mt-1 text-sm text-gray-500">
                  {t(
                    'admin.sources.searchProfileHelp',
                    'Leave empty to use the profile configured in the iFinder integration.'
                  )}
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  {t('admin.sources.maxResults', 'Max Results')}
                </label>
                <input
                  type="number"
                  value={formData.config?.maxResults || 10}
                  onChange={e => handleConfigChange('maxResults', parseOptionalInt(e.target.value))}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                  min="1"
                  max="100"
                />
                <p className="mt-1 text-sm text-gray-500">
                  {t(
                    'admin.sources.maxResultsHelp',
                    'Number of documents loaded when using a search query.'
                  )}
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  {t('admin.sources.maxLength', 'Max Content Length')}
                </label>
                <input
                  type="number"
                  value={formData.config?.maxLength || 10000}
                  onChange={e => handleConfigChange('maxLength', parseOptionalInt(e.target.value))}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                  min="1"
                />
                <p className="mt-1 text-sm text-gray-500">
                  {t(
                    'admin.sources.maxLengthHelp',
                    'Maximum characters loaded per document; longer content is truncated.'
                  )}
                </p>
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
}

export default SourceConfigForm;
