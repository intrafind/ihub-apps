import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../../../utils/localizeContent';
import Icon from '../../../shared/components/Icon';
import ModelDetailsPopup from '../../../shared/components/ModelDetailsPopup';
import AdminAuth from '../components/AdminAuth';
import AdminNavigation from '../components/AdminNavigation';
import { makeAdminApiCall, toggleModels } from '../../../api/adminApi';

const AdminModelsPage = () => {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const navigate = useNavigate();
  const [models, setModels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterEnabled, setFilterEnabled] = useState('all'); // all, enabled, disabled
  const [testingModel, setTestingModel] = useState(null);
  const [, setTestResults] = useState({});
  const [selectedModel, setSelectedModel] = useState(null);
  const [showModelDetails, setShowModelDetails] = useState(false);

  const loadModels = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await makeAdminApiCall('/admin/models');
      const data = response.data;

      console.log('Models loaded:', data);
      console.log('Models count:', Array.isArray(data) ? data.length : 'Not an array');

      // Ensure we have an array
      const modelsArray = Array.isArray(data) ? data : [];
      setModels(modelsArray);

      if (modelsArray.length === 0) {
        console.warn('No models returned from API');
      }
    } catch (err) {
      console.error('Error loading models:', err);
      setError(err.message);
      setModels([]); // Set empty array on error
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadModels();
  }, []);

  const toggleModel = async modelId => {
    try {
      const response = await makeAdminApiCall(`/admin/models/${modelId}/toggle`, {
        method: 'POST'
      });

      const result = response.data;

      // Update the model in the local state
      setModels(prevModels =>
        prevModels.map(model =>
          model.id === modelId ? { ...model, enabled: result.enabled } : model
        )
      );
    } catch (err) {
      setError(err.message);
    }
  };

  const enableAllModels = async () => {
    try {
      await toggleModels('*', true);
      setModels(prev => prev.map(m => ({ ...m, enabled: true })));
    } catch (err) {
      setError(err.message);
    }
  };

  const disableAllModels = async () => {
    try {
      await toggleModels('*', false);
      setModels(prev => prev.map(m => ({ ...m, enabled: false, default: false })));
    } catch (err) {
      setError(err.message);
    }
  };

  const testModel = async modelId => {
    try {
      setTestingModel(modelId);
      const response = await makeAdminApiCall(`/admin/models/${modelId}/test`, {
        method: 'POST'
      });

      const result = response.data;

      setTestResults(prevResults => ({
        ...prevResults,
        [modelId]: result
      }));
    } catch (err) {
      setTestResults(prevResults => ({
        ...prevResults,
        [modelId]: { error: err.message }
      }));
    } finally {
      setTestingModel(null);
    }
  };

  const handleModelClick = model => {
    setSelectedModel(model);
    setShowModelDetails(true);
  };

  const handleCloneModel = model => {
    navigate('/admin/models/new', { state: { templateModel: model } });
  };

  const handleDeleteModel = async modelId => {
    if (!confirm(t('admin.models.deleteConfirm', 'Delete this model?'))) {
      return;
    }
    try {
      await makeAdminApiCall(`/admin/models/${modelId}`, { method: 'DELETE' });
      setModels(prev => prev.filter(m => m.id !== modelId));
    } catch (err) {
      setError(err.message);
    }
  };

  const filteredModels = models.filter(model => {
    const matchesSearch =
      searchTerm === '' ||
      getLocalizedContent(model.name, currentLanguage)
        .toLowerCase()
        .includes(searchTerm.toLowerCase()) ||
      getLocalizedContent(model.description, currentLanguage)
        .toLowerCase()
        .includes(searchTerm.toLowerCase()) ||
      model.id.toLowerCase().includes(searchTerm.toLowerCase());

    const matchesFilter =
      filterEnabled === 'all' ||
      (filterEnabled === 'enabled' && model.enabled) ||
      (filterEnabled === 'disabled' && !model.enabled);

    return matchesSearch && matchesFilter;
  });

  if (loading) {
    return (
      <div className="flex justify-center items-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-md p-4">
        <div className="flex">
          <Icon name="exclamation-triangle" className="h-5 w-5 text-red-400" />
          <div className="ml-3">
            <h3 className="text-sm font-medium text-red-800">
              {t('admin.models.loadError', 'Error loading models')}
            </h3>
            <p className="mt-1 text-sm text-red-700">{error}</p>
            <button
              onClick={() => window.location.reload()}
              className="mt-2 text-sm text-red-600 hover:text-red-500"
            >
              {t('common.retry', 'Retry')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <AdminAuth>
      <div>
        <AdminNavigation />
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="sm:flex sm:items-center">
            <div className="sm:flex-auto">
              <h1 className="text-2xl font-semibold text-gray-900">
                {t('admin.models.title', 'Model Management')}
              </h1>
              <p className="mt-2 text-sm text-gray-700">
                {t('admin.models.subtitle', 'Configure and manage AI models for your applications')}
              </p>
            </div>
            <div className="mt-4 sm:mt-0 sm:ml-16 sm:flex-none">
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => navigate('/admin/models/new')}
                  className="inline-flex items-center justify-center rounded-md border border-transparent bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 sm:w-auto"
                >
                  <Icon name="plus" className="h-4 w-4 mr-2" />
                  {t('admin.models.addNew', 'Add New Model')}
                </button>
                <button
                  type="button"
                  className="inline-flex items-center justify-center rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50"
                  onClick={enableAllModels}
                >
                  {t('admin.common.enableAll', 'Enable All')}
                </button>
                <button
                  type="button"
                  className="inline-flex items-center justify-center rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50"
                  onClick={disableAllModels}
                >
                  {t('admin.common.disableAll', 'Disable All')}
                </button>
              </div>
            </div>
          </div>

          {/* Search and Filter */}
          <div className="mt-8 flex flex-col sm:flex-row gap-4">
            <div className="flex-1">
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <Icon name="search" className="h-5 w-5 text-gray-400" />
                </div>
                <input
                  type="text"
                  className="block w-full pl-10 pr-3 py-2 border border-gray-300 rounded-md leading-5 bg-white placeholder-gray-500 focus:outline-none focus:placeholder-gray-400 focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
                  placeholder={t('admin.models.searchPlaceholder', 'Search models...')}
                  value={searchTerm}
                  onChange={e => setSearchTerm(e.target.value)}
                />
              </div>
            </div>
            <div className="sm:w-48">
              <select
                value={filterEnabled}
                onChange={e => setFilterEnabled(e.target.value)}
                className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
              >
                <option value="all">{t('admin.models.filterAll', 'All Models')}</option>
                <option value="enabled">{t('admin.models.filterEnabled', 'Enabled Only')}</option>
                <option value="disabled">
                  {t('admin.models.filterDisabled', 'Disabled Only')}
                </option>
              </select>
            </div>
          </div>

          {/* Models Table */}
          <div className="mt-8 flex flex-col">
            <div className="-my-2 -mx-4 overflow-x-auto sm:-mx-6 lg:-mx-8">
              <div className="inline-block min-w-full py-2 align-middle md:px-6 lg:px-8">
                <div className="overflow-hidden shadow ring-1 ring-black ring-opacity-5 md:rounded-lg">
                  <table className="min-w-full divide-y divide-gray-300">
                    <thead className="bg-gray-50">
                      <tr>
                        <th
                          scope="col"
                          className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
                        >
                          {t('admin.models.name', 'Name')}
                        </th>
                        <th
                          scope="col"
                          className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
                        >
                          {t('admin.models.provider', 'Provider')}
                        </th>
                        <th
                          scope="col"
                          className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
                        >
                          {t('admin.models.table.status', 'Status')}
                        </th>
                        <th scope="col" className="relative px-6 py-3">
                          <span className="sr-only">{t('admin.models.actions', 'Actions')}</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                      {filteredModels.map(model => (
                        <tr
                          key={model.id}
                          className="hover:bg-gray-50 cursor-pointer"
                          onClick={() => handleModelClick(model)}
                        >
                          <td className="px-6 py-4 whitespace-nowrap">
                            <div className="flex items-center">
                              <div className="flex-shrink-0 h-8 w-8">
                                <div className="h-8 w-8 rounded-full bg-indigo-100 flex items-center justify-center">
                                  <Icon name="cpu-chip" className="h-4 w-4 text-indigo-600" />
                                </div>
                              </div>
                              <div className="ml-4">
                                <div className="text-sm font-medium text-gray-900">
                                  {getLocalizedContent(model.name, currentLanguage)}
                                </div>
                                <div className="text-sm text-gray-500">{model.id}</div>
                              </div>
                            </div>
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                            {model.provider || '-'}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap">
                            <span
                              className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                                model.enabled
                                  ? 'bg-green-100 text-green-800'
                                  : 'bg-gray-100 text-gray-800'
                              }`}
                            >
                              {model.enabled
                                ? t('admin.models.enabled', 'Enabled')
                                : t('admin.models.disabled', 'Disabled')}
                            </span>
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                            <div className="flex items-center justify-end space-x-2">
                              <button
                                onClick={e => {
                                  e.stopPropagation();
                                  testModel(model.id);
                                }}
                                disabled={testingModel === model.id}
                                className="p-2 text-blue-600 hover:bg-blue-50 rounded-full disabled:opacity-50"
                                title={t('admin.models.test', 'Test')}
                              >
                                <Icon name="play" className="h-4 w-4" />
                              </button>
                              <button
                                onClick={e => {
                                  e.stopPropagation();
                                  toggleModel(model.id);
                                }}
                                className={`p-2 rounded-full ${
                                  model.enabled
                                    ? 'text-red-600 hover:bg-red-50'
                                    : 'text-green-600 hover:bg-green-50'
                                }`}
                                title={
                                  model.enabled
                                    ? t('admin.models.disable', 'Disable')
                                    : t('admin.models.enable', 'Enable')
                                }
                              >
                                <Icon
                                  name={model.enabled ? 'eye-slash' : 'eye'}
                                  className="h-4 w-4"
                                />
                              </button>
                              <button
                                onClick={e => {
                                  e.stopPropagation();
                                  navigate(`/admin/models/${model.id}`);
                                }}
                                className="p-2 text-indigo-600 hover:bg-indigo-50 rounded-full"
                                title={t('common.edit', 'Edit')}
                              >
                                <Icon name="pencil" className="h-4 w-4" />
                              </button>
                              <button
                                onClick={e => {
                                  e.stopPropagation();
                                  handleCloneModel(model);
                                }}
                                className="p-2 text-blue-600 hover:bg-blue-50 rounded-full"
                                title={t('admin.models.clone', 'Clone')}
                              >
                                <Icon name="copy" className="h-4 w-4" />
                              </button>
                              <button
                                onClick={e => {
                                  e.stopPropagation();
                                  handleDeleteModel(model.id);
                                }}
                                className="p-2 text-red-600 hover:bg-red-50 rounded-full"
                                title={t('admin.models.delete', 'Delete')}
                              >
                                <Icon name="trash" className="h-4 w-4" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>

          {filteredModels.length === 0 && (
            <div className="text-center py-12">
              <Icon name="cpu-chip" className="mx-auto h-12 w-12 text-gray-400" />
              <h3 className="mt-2 text-sm font-medium text-gray-900">
                {t('admin.models.noModels', 'No models found')}
              </h3>
              <p className="mt-1 text-sm text-gray-500">
                {t('admin.models.noModelsDesc', 'Get started by creating a new model.')}
              </p>
              <div className="mt-6">
                <button
                  onClick={() => navigate('/admin/models/new')}
                  className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
                >
                  <Icon name="plus" className="h-4 w-4 mr-2" />
                  {t('admin.models.addNew', 'Add New Model')}
                </button>
              </div>
            </div>
          )}

          {/* Model Details Popup */}
          <ModelDetailsPopup
            model={selectedModel}
            isOpen={showModelDetails}
            onClose={() => setShowModelDetails(false)}
          />
        </div>
      </div>
    </AdminAuth>
  );
};

export default AdminModelsPage;
