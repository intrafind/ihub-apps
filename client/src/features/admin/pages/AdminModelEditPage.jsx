import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { getLocalizedContent, DEFAULT_LANGUAGE } from '../../../utils/localizeContent';
import { makeAdminApiCall } from '../../../api/adminApi';
import { fetchJsonSchema } from '../../../utils/schemaService';
import Icon from '../../../shared/components/Icon';
import AdminAuth from '../components/AdminAuth';
import AdminNavigation from '../components/AdminNavigation';
import DualModeEditor from '../../../shared/components/DualModeEditor';
import ModelFormEditor from '../components/ModelFormEditor';

const AdminModelEditPage = () => {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const navigate = useNavigate();
  const { modelId } = useParams();
  const location = useLocation();
  const isNewModel = modelId === 'new';

  const [loading, setLoading] = useState(!isNewModel);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);
  const [apps, setApps] = useState([]);
  const [usage, setUsage] = useState(null);
  const [jsonSchema, setJsonSchema] = useState(null);

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
    default: false
  });

  useEffect(() => {
    const loadJsonSchema = async () => {
      try {
        const schema = await fetchJsonSchema('model');
        setJsonSchema(schema);
      } catch (err) {
        console.error('Failed to load model JSON schema:', err);
        // Continue without schema - validation will be server-side only
      }
    };

    if (isNewModel) {
      setLoading(false);
    } else {
      loadModel();
    }
    loadAppsUsingModel();
    loadUsageData();
    loadJsonSchema();
  }, [modelId, isNewModel]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (isNewModel && location.state?.templateModel) {
      const tpl = location.state.templateModel;
      setFormData(prev => ({
        ...prev,
        ...tpl,
        id: '',
        enabled: tpl.enabled !== undefined ? tpl.enabled : true,
        default: false
      }));
    }
  }, [isNewModel, location.state]);

  const loadModel = useCallback(async () => {
    try {
      setLoading(true);
      const response = await makeAdminApiCall(`/admin/models/${modelId}`);
      const model = response.data;
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

      const formDataObj = {
        id: model.id || '',
        modelId: model.modelId || '',
        name: ensureLocalizedObject(model.name),
        description: ensureLocalizedObject(model.description),
        url: model.url || '',
        provider: model.provider || '',
        tokenLimit: model.tokenLimit || '',
        supportsTools: model.supportsTools || false,
        enabled: model.enabled !== undefined ? model.enabled : true,
        default: model.default || false
      };

      // Only include optional number fields if they exist
      if (model.concurrency !== undefined) {
        formDataObj.concurrency = model.concurrency;
      }
      if (model.requestDelayMs !== undefined) {
        formDataObj.requestDelayMs = model.requestDelayMs;
      }

      setFormData(formDataObj);

      console.log('Form data set with name:', ensureLocalizedObject(model.name));
      console.log('Form data set with description:', ensureLocalizedObject(model.description));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [modelId]);

  const loadAppsUsingModel = useCallback(async () => {
    try {
      const response = await makeAdminApiCall('/admin/apps');
      const allApps = response.data;
      const appsUsingModel = allApps.filter(app => app.preferredModel === modelId);
      setApps(appsUsingModel);
    } catch (err) {
      console.error('Error loading apps:', err);
    }
  }, [modelId]);

  const loadUsageData = useCallback(async () => {
    try {
      const response = await makeAdminApiCall('/admin/usage');
      const usageData = response.data;
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
  }, [modelId]);

  const handleDataChange = newData => {
    setFormData(newData);
  };

  const handleFormSubmit = async e => {
    e.preventDefault();
    await handleSave(formData);
  };

  const handleSave = async data => {
    try {
      setSaving(true);
      setError(null);

      // Prepare the data to send
      const dataToSend = {
        ...data,
        tokenLimit: data.tokenLimit ? parseInt(data.tokenLimit) : undefined,
        concurrency: data.concurrency ? parseInt(data.concurrency) : undefined,
        requestDelayMs: data.requestDelayMs ? parseInt(data.requestDelayMs) : undefined
      };

      // Remove empty fields
      Object.keys(dataToSend).forEach(key => {
        if (dataToSend[key] === '' || dataToSend[key] === undefined) {
          delete dataToSend[key];
        }
      });

      const url = isNewModel ? '/admin/models' : `/admin/models/${modelId}`;
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
      throw err; // Re-throw to let DualModeEditor handle it
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <AdminAuth>
        <AdminNavigation />
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600 mx-auto"></div>
            <p className="mt-4 text-gray-600">{t('app.loading')}</p>
          </div>
        </div>
      </AdminAuth>
    );
  }

  return (
    <AdminAuth>
      <AdminNavigation />
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-semibold text-gray-900">
                {isNewModel ? t('admin.models.edit.titleNew') : t('admin.models.edit.title')}
              </h1>
              <p className="mt-1 text-sm text-gray-600">
                {isNewModel
                  ? t('admin.models.edit.subtitleNew')
                  : t('admin.models.edit.subtitle', {
                      name: getLocalizedContent(formData.name, currentLanguage)
                    })}
              </p>
            </div>
            <div className="flex space-x-3">
              {!isNewModel && (
                <button
                  type="button"
                  onClick={() => {
                    const dataStr = JSON.stringify(formData, null, 2);
                    const dataUri =
                      'data:application/json;charset=utf-8,' + encodeURIComponent(dataStr);
                    const exportFileDefaultName = `model-${formData.id}.json`;
                    const linkElement = document.createElement('a');
                    linkElement.setAttribute('href', dataUri);
                    linkElement.setAttribute('download', exportFileDefaultName);
                    linkElement.click();
                  }}
                  className="inline-flex items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
                >
                  <Icon name="download" className="h-4 w-4 mr-2" />
                  {t('common.download')}
                </button>
              )}
              <button
                onClick={() => navigate('/admin/models')}
                className="inline-flex items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
              >
                <Icon name="arrow-left" className="h-4 w-4 mr-2" />
                {t('admin.models.edit.backToModels')}
              </button>
            </div>
          </div>
        </div>

        {/* Error display */}
        {error && (
          <div className="mb-6 rounded-md bg-red-50 p-4">
            <div className="flex">
              <div className="flex-shrink-0">
                <Icon name="x-circle" className="h-5 w-5 text-red-400" />
              </div>
              <div className="ml-3">
                <h3 className="text-sm font-medium text-red-800">{t('common.error')}</h3>
                <div className="mt-2 text-sm text-red-700">
                  <p>{error}</p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Success display */}
        {success && (
          <div className="mb-6 rounded-md bg-green-50 p-4">
            <div className="flex">
              <div className="flex-shrink-0">
                <Icon name="check-circle" className="h-5 w-5 text-green-400" />
              </div>
              <div className="ml-3">
                <p className="text-sm font-medium text-green-800">
                  {t('admin.models.edit.success', {
                    action: isNewModel
                      ? t('admin.models.edit.successCreated')
                      : t('admin.models.edit.successUpdated')
                  })}
                </p>
              </div>
            </div>
          </div>
        )}

        <form onSubmit={handleFormSubmit} className="space-y-8">
          <div className="space-y-8">
            {/* Main Form Editor */}
            <DualModeEditor
              value={formData}
              onChange={handleDataChange}
              formComponent={ModelFormEditor}
              formProps={{
                isNewModel,
                apps,
                usage
              }}
              jsonSchema={jsonSchema}
              title={isNewModel ? t('admin.models.edit.titleNew') : t('admin.models.edit.title')}
            />

            {/* Usage Stats and Apps List - integrated as sections */}
            {!isNewModel && (
              <div className="space-y-8">
                {/* Usage Stats */}
                <div className="bg-white shadow rounded-lg">
                  <div className="px-6 py-4 border-b border-gray-200">
                    <h3 className="text-lg font-medium text-gray-900">
                      {t('admin.models.edit.usageStats')}
                    </h3>
                  </div>
                  <div className="px-6 py-4">
                    {usage ? (
                      <div className="grid grid-cols-2 gap-4">
                        <div className="text-center">
                          <div className="text-2xl font-semibold text-gray-900">
                            {usage.messages?.toLocaleString() || 0}
                          </div>
                          <div className="text-sm text-gray-500">
                            {t('admin.models.details.messages')}
                          </div>
                        </div>
                        <div className="text-center">
                          <div className="text-2xl font-semibold text-gray-900">
                            {usage.tokens?.toLocaleString() || 0}
                          </div>
                          <div className="text-sm text-gray-500">
                            {t('admin.models.details.tokens')}
                          </div>
                        </div>
                      </div>
                    ) : (
                      <p className="text-sm text-gray-500 text-center py-4">
                        {t('admin.models.edit.noUsageData')}
                      </p>
                    )}
                  </div>
                </div>

                {/* Apps Using Model */}
                <div className="bg-white shadow rounded-lg">
                  <div className="px-6 py-4 border-b border-gray-200">
                    <h3 className="text-lg font-medium text-gray-900">
                      {t('admin.models.edit.appsUsingModel')}
                    </h3>
                  </div>
                  <div className="px-6 py-4">
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
                      <p className="text-sm text-gray-500 text-center py-4">
                        {t('admin.models.edit.noApps')}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Save buttons */}
          <div className="flex justify-end space-x-4">
            <button
              type="button"
              onClick={() => navigate('/admin/models')}
              className="px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              disabled={saving}
              className="inline-flex justify-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50"
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
    </AdminAuth>
  );
};

export default AdminModelEditPage;
