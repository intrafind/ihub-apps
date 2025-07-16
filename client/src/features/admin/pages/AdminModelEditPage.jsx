import React, { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { getLocalizedContent, DEFAULT_LANGUAGE } from '../../../utils/localizeContent';
import { makeAdminApiCall } from '../../../api/adminApi';
import Icon from '../../../shared/components/Icon';
import DynamicLanguageEditor from '../../../shared/components/DynamicLanguageEditor';
import AdminAuth from '../components/AdminAuth';
import AdminNavigation from '../components/AdminNavigation';

const AdminModelEditPage = () => {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const navigate = useNavigate();
  const { modelId } = useParams();
  const isNewModel = modelId === 'new';

  const [loading, setLoading] = useState(!isNewModel);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);
  const [apps, setApps] = useState([]);
  const [usage, setUsage] = useState(null);

  const [formData, setFormData] = useState({
    id: '',
    modelId: '',
    name: { [DEFAULT_LANGUAGE]: '' },
    description: { [DEFAULT_LANGUAGE]: '' },
    url: '',
    provider: '',
    tokenLimit: '',
    supportsTools: false,
    enabled: true,
    default: false,
    concurrency: '',
    requestDelayMs: ''
  });

  useEffect(() => {
    if (isNewModel) {
      setLoading(false);
    } else {
      loadModel();
    }
    loadAppsUsingModel();
    loadUsageData();
  }, [modelId]);

  const loadModel = async () => {
    try {
      setLoading(true);
      const response = await makeAdminApiCall(`/api/admin/models/${modelId}`);
      const model = await response.json();
      console.log('Model loaded:', model);
      console.log('Model name structure:', model.name);
      console.log('Model description structure:', model.description);

      // Ensure name and description are proper localized objects
      const ensureLocalizedObject = value => {
        if (!value) return { [DEFAULT_LANGUAGE]: '' };
        if (typeof value === 'string') return { [DEFAULT_LANGUAGE]: value };
        if (typeof value === 'object' && value !== null) return value;
        return { [DEFAULT_LANGUAGE]: '' };
      };

      setFormData({
        id: model.id || '',
        modelId: model.modelId || '',
        name: ensureLocalizedObject(model.name),
        description: ensureLocalizedObject(model.description),
        url: model.url || '',
        provider: model.provider || '',
        tokenLimit: model.tokenLimit || '',
        supportsTools: model.supportsTools || false,
        enabled: model.enabled !== undefined ? model.enabled : true,
        default: model.default || false,
        concurrency: model.concurrency || '',
        requestDelayMs: model.requestDelayMs || ''
      });

      console.log('Form data set with name:', ensureLocalizedObject(model.name));
      console.log('Form data set with description:', ensureLocalizedObject(model.description));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const loadAppsUsingModel = async () => {
    try {
      const response = await makeAdminApiCall('/api/admin/apps');
      const allApps = await response.json();
      const appsUsingModel = allApps.filter(app => app.preferredModel === modelId);
      setApps(appsUsingModel);
    } catch (err) {
      console.error('Error loading apps:', err);
    }
  };

  const loadUsageData = async () => {
    try {
      const response = await makeAdminApiCall('/api/admin/usage');
      const usageData = await response.json();
      if (
        usageData.messages &&
        usageData.messages.perModel &&
        usageData.messages.perModel[modelId]
      ) {
        setUsage({
          messages: usageData.messages.perModel[modelId],
          tokens: usageData.tokens.perModel[modelId] || 0
        });
      }
    } catch (err) {
      console.error('Error loading usage data:', err);
    }
  };

  const handleChange = e => {
    const { name, value, type, checked } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value
    }));
  };

  const handleLocalizedChange = (field, value) => {
    setFormData(prev => ({
      ...prev,
      [field]: value
    }));
  };

  const handleSubmit = async e => {
    e.preventDefault();

    try {
      setSaving(true);
      setError(null);

      // Validate required fields
      if (
        !formData.id ||
        !getLocalizedContent(formData.name, DEFAULT_LANGUAGE) ||
        !getLocalizedContent(formData.description, DEFAULT_LANGUAGE) ||
        !formData.provider
      ) {
        throw new Error(t('admin.models.edit.requiredFields'));
      }

      // Prepare the data to send
      const dataToSend = {
        ...formData,
        tokenLimit: formData.tokenLimit ? parseInt(formData.tokenLimit) : undefined,
        concurrency: formData.concurrency ? parseInt(formData.concurrency) : undefined,
        requestDelayMs: formData.requestDelayMs ? parseInt(formData.requestDelayMs) : undefined
      };

      // Remove empty fields
      Object.keys(dataToSend).forEach(key => {
        if (dataToSend[key] === '' || dataToSend[key] === undefined) {
          delete dataToSend[key];
        }
      });

      const url = isNewModel ? '/api/admin/models' : `/api/admin/models/${modelId}`;
      const method = isNewModel ? 'POST' : 'PUT';

      await makeAdminApiCall(url, {
        method,
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(dataToSend)
      });

      setSuccess(true);

      // Redirect after a short delay
      setTimeout(() => {
        navigate('/admin/models');
      }, 1500);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const providerOptions = [
    { value: 'openai', label: 'OpenAI' },
    { value: 'anthropic', label: 'Anthropic' },
    { value: 'google', label: 'Google' },
    { value: 'mistral', label: 'Mistral' },
    { value: 'local', label: 'Local' }
  ];

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">{t('app.loading')}</p>
        </div>
      </div>
    );
  }

  return (
    <AdminAuth>
      <div className="min-h-screen bg-gray-100">
        <AdminNavigation />
        {/* Header */}
        <div className="bg-white shadow">
          <div className="max-w-7xl mx-auto py-6 px-4 sm:px-6 lg:px-8">
            <div className="flex items-center">
              <button
                onClick={() => navigate('/admin/models')}
                className="mr-4 inline-flex items-center p-2 border border-transparent rounded-md text-gray-400 hover:text-gray-500 hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-indigo-500"
              >
                <Icon name="arrow-left" className="w-5 h-5" />
                <span className="sr-only">{t('admin.models.edit.backToModels')}</span>
              </button>
              <div>
                <h1 className="text-2xl font-bold text-gray-900">
                  {isNewModel ? t('admin.models.edit.titleNew') : t('admin.models.edit.title')}
                </h1>
                <p className="mt-1 text-sm text-gray-500">
                  {isNewModel
                    ? t('admin.models.edit.subtitleNew')
                    : t('admin.models.edit.subtitle', {
                        name: getLocalizedContent(formData.name, currentLanguage)
                      })}
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
          <div className="px-4 py-6 sm:px-0">
            <div className="lg:grid lg:grid-cols-12 lg:gap-x-5">
              <div className="space-y-6 sm:px-6 lg:px-0 lg:col-span-8">
                <form onSubmit={handleSubmit} className="space-y-6">
                  <div className="bg-white shadow px-4 py-5 sm:rounded-lg sm:p-6">
                    <div className="md:grid md:grid-cols-3 md:gap-6">
                      <div className="md:col-span-1">
                        <h3 className="text-lg font-medium leading-6 text-gray-900">
                          {t('admin.models.edit.basicInfo')}
                        </h3>
                        <p className="mt-1 text-sm text-gray-500">
                          {t(
                            'admin.models.edit.basicInfoDesc',
                            'Basic information about the model'
                          )}
                        </p>
                      </div>
                      <div className="mt-5 md:mt-0 md:col-span-2">
                        <div className="grid grid-cols-6 gap-6">
                          <div className="col-span-6 sm:col-span-3">
                            <label htmlFor="id" className="block text-sm font-medium text-gray-700">
                              {t('admin.models.fields.id')} *
                            </label>
                            <input
                              type="text"
                              name="id"
                              id="id"
                              value={formData.id}
                              onChange={handleChange}
                              disabled={!isNewModel}
                              className="mt-1 focus:ring-indigo-500 focus:border-indigo-500 block w-full shadow-sm sm:text-sm border-gray-300 rounded-md disabled:bg-gray-100"
                              required
                            />
                            <p className="mt-2 text-sm text-gray-500">
                              {t('admin.models.hints.modelId')}
                            </p>
                          </div>

                          <div className="col-span-6 sm:col-span-3">
                            <DynamicLanguageEditor
                              label={t('admin.models.fields.name')}
                              value={formData.name}
                              onChange={value => handleLocalizedChange('name', value)}
                              required={true}
                            />
                          </div>

                          <div className="col-span-6">
                            <DynamicLanguageEditor
                              label={t('admin.models.fields.description')}
                              value={formData.description}
                              onChange={value => handleLocalizedChange('description', value)}
                              required={true}
                              type="textarea"
                            />
                          </div>

                          <div className="col-span-6 sm:col-span-3">
                            <label
                              htmlFor="provider"
                              className="block text-sm font-medium text-gray-700"
                            >
                              {t('admin.models.fields.provider')} *
                            </label>
                            <select
                              id="provider"
                              name="provider"
                              value={formData.provider}
                              onChange={handleChange}
                              className="mt-1 block w-full py-2 px-3 border border-gray-300 bg-white rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
                              required
                            >
                              <option value="">
                                {t('admin.models.placeholders.selectProvider')}
                              </option>
                              {providerOptions.map(option => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </select>
                          </div>

                          <div className="col-span-6 sm:col-span-3">
                            <label
                              htmlFor="modelId"
                              className="block text-sm font-medium text-gray-700"
                            >
                              {t('admin.models.fields.modelId')}
                            </label>
                            <input
                              type="text"
                              name="modelId"
                              id="modelId"
                              value={formData.modelId}
                              onChange={handleChange}
                              placeholder={t('admin.models.placeholders.apiModelId')}
                              className="mt-1 focus:ring-indigo-500 focus:border-indigo-500 block w-full shadow-sm sm:text-sm border-gray-300 rounded-md"
                            />
                            <p className="mt-2 text-sm text-gray-500">
                              {t('admin.models.hints.apiModelId')}
                            </p>
                          </div>

                          <div className="col-span-6">
                            <label
                              htmlFor="url"
                              className="block text-sm font-medium text-gray-700"
                            >
                              {t('admin.models.fields.url')}
                            </label>
                            <input
                              type="url"
                              name="url"
                              id="url"
                              value={formData.url}
                              onChange={handleChange}
                              placeholder={t('admin.models.placeholders.apiUrl')}
                              className="mt-1 focus:ring-indigo-500 focus:border-indigo-500 block w-full shadow-sm sm:text-sm border-gray-300 rounded-md"
                            />
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

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
                            <label
                              htmlFor="tokenLimit"
                              className="block text-sm font-medium text-gray-700"
                            >
                              {t('admin.models.fields.tokenLimit')}
                            </label>
                            <input
                              type="number"
                              name="tokenLimit"
                              id="tokenLimit"
                              value={formData.tokenLimit}
                              onChange={handleChange}
                              min="1"
                              className="mt-1 focus:ring-indigo-500 focus:border-indigo-500 block w-full shadow-sm sm:text-sm border-gray-300 rounded-md"
                            />
                          </div>

                          <div className="col-span-6 sm:col-span-2">
                            <label
                              htmlFor="concurrency"
                              className="block text-sm font-medium text-gray-700"
                            >
                              {t('admin.models.fields.concurrency')}
                            </label>
                            <input
                              type="number"
                              name="concurrency"
                              id="concurrency"
                              value={formData.concurrency}
                              onChange={handleChange}
                              min="1"
                              className="mt-1 focus:ring-indigo-500 focus:border-indigo-500 block w-full shadow-sm sm:text-sm border-gray-300 rounded-md"
                            />
                          </div>

                          <div className="col-span-6 sm:col-span-2">
                            <label
                              htmlFor="requestDelayMs"
                              className="block text-sm font-medium text-gray-700"
                            >
                              {t('admin.models.fields.requestDelay')}
                            </label>
                            <input
                              type="number"
                              name="requestDelayMs"
                              id="requestDelayMs"
                              value={formData.requestDelayMs}
                              onChange={handleChange}
                              min="0"
                              className="mt-1 focus:ring-indigo-500 focus:border-indigo-500 block w-full shadow-sm sm:text-sm border-gray-300 rounded-md"
                            />
                          </div>

                          <div className="col-span-6">
                            <fieldset>
                              <legend className="text-base font-medium text-gray-900">
                                Options
                              </legend>
                              <div className="mt-4 space-y-4">
                                <div className="flex items-start">
                                  <div className="flex items-center h-5">
                                    <input
                                      id="supportsTools"
                                      name="supportsTools"
                                      type="checkbox"
                                      checked={formData.supportsTools}
                                      onChange={handleChange}
                                      className="focus:ring-indigo-500 h-4 w-4 text-indigo-600 border-gray-300 rounded"
                                    />
                                  </div>
                                  <div className="ml-3 text-sm">
                                    <label
                                      htmlFor="supportsTools"
                                      className="font-medium text-gray-700"
                                    >
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
                                      checked={formData.enabled}
                                      onChange={handleChange}
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
                                      checked={formData.default}
                                      onChange={handleChange}
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

                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={() => navigate('/admin/models')}
                      className="bg-white py-2 px-4 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
                    >
                      {t('common.cancel')}
                    </button>
                    <button
                      type="submit"
                      disabled={saving}
                      className="ml-3 inline-flex justify-center py-2 px-4 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50"
                    >
                      {saving
                        ? t('admin.models.edit.saving')
                        : isNewModel
                          ? t('admin.models.edit.createModel')
                          : t('admin.models.edit.saveChanges')}
                    </button>
                  </div>
                </form>
              </div>

              <div className="mt-6 lg:mt-0 lg:col-span-4">
                <div className="space-y-6">
                  {/* Usage Stats */}
                  {!isNewModel && (
                    <div className="bg-white shadow px-4 py-5 sm:rounded-lg sm:p-6">
                      <h3 className="text-lg font-medium leading-6 text-gray-900 mb-4">
                        {t('admin.models.edit.usageStats')}
                      </h3>
                      {usage ? (
                        <div className="space-y-4">
                          <div className="flex justify-between items-center">
                            <span className="text-sm text-gray-500">
                              {t('admin.models.details.messages')}:
                            </span>
                            <span className="text-sm font-medium text-gray-900">
                              {usage.messages?.toLocaleString() || 0}
                            </span>
                          </div>
                          <div className="flex justify-between items-center">
                            <span className="text-sm text-gray-500">
                              {t('admin.models.details.tokens')}:
                            </span>
                            <span className="text-sm font-medium text-gray-900">
                              {usage.tokens?.toLocaleString() || 0}
                            </span>
                          </div>
                        </div>
                      ) : (
                        <p className="text-sm text-gray-500">
                          {t('admin.models.edit.noUsageData')}
                        </p>
                      )}
                    </div>
                  )}

                  {/* Apps Using Model */}
                  {!isNewModel && (
                    <div className="bg-white shadow px-4 py-5 sm:rounded-lg sm:p-6">
                      <h3 className="text-lg font-medium leading-6 text-gray-900 mb-4">
                        {t('admin.models.edit.appsUsingModel')}
                      </h3>
                      {apps.length > 0 ? (
                        <div className="space-y-3">
                          {apps.map(app => (
                            <div
                              key={app.id}
                              className="flex items-center justify-between p-3 bg-gray-50 rounded-lg"
                            >
                              <div className="flex items-center space-x-3">
                                <div
                                  className="w-8 h-8 rounded-md flex items-center justify-center text-white text-xs font-bold"
                                  style={{ backgroundColor: app.color || '#6B7280' }}
                                >
                                  <Icon name={app.icon || 'chat-bubbles'} className="w-4 h-4" />
                                </div>
                                <div>
                                  <span className="text-sm font-medium text-gray-900">
                                    {getLocalizedContent(app.name, currentLanguage)}
                                  </span>
                                  <div className="text-xs text-gray-500">{app.id}</div>
                                </div>
                              </div>
                              <span
                                className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
                                  app.enabled
                                    ? 'bg-green-100 text-green-800'
                                    : 'bg-red-100 text-red-800'
                                }`}
                              >
                                {app.enabled
                                  ? t('admin.models.status.enabled')
                                  : t('admin.models.status.disabled')}
                              </span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-sm text-gray-500">{t('admin.models.edit.noApps')}</p>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Status Messages */}
        {error && (
          <div className="fixed inset-x-0 top-0 flex items-end justify-center px-4 py-6 pointer-events-none sm:p-6 sm:items-start sm:justify-end">
            <div className="max-w-sm w-full bg-white shadow-lg rounded-lg pointer-events-auto ring-1 ring-black ring-opacity-5 overflow-hidden">
              <div className="p-4">
                <div className="flex items-start">
                  <div className="flex-shrink-0">
                    <Icon name="x-circle" className="w-5 h-5 text-red-400" />
                  </div>
                  <div className="ml-3 w-0 flex-1 pt-0.5">
                    <p className="text-sm font-medium text-gray-900">{t('common.error')}</p>
                    <p className="mt-1 text-sm text-gray-500">{error}</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {success && (
          <div className="fixed inset-x-0 top-0 flex items-end justify-center px-4 py-6 pointer-events-none sm:p-6 sm:items-start sm:justify-end">
            <div className="max-w-sm w-full bg-white shadow-lg rounded-lg pointer-events-auto ring-1 ring-black ring-opacity-5 overflow-hidden">
              <div className="p-4">
                <div className="flex items-start">
                  <div className="flex-shrink-0">
                    <Icon name="check-circle" className="w-5 h-5 text-green-400" />
                  </div>
                  <div className="ml-3 w-0 flex-1 pt-0.5">
                    <p className="text-sm font-medium text-gray-900">
                      {t('admin.models.edit.success', {
                        action: isNewModel
                          ? t('admin.models.edit.successCreated')
                          : t('admin.models.edit.successUpdated')
                      })}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </AdminAuth>
  );
};

export default AdminModelEditPage;
