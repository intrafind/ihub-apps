import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useFilterState } from '../hooks/useFilterState';
import { getLocalizedContent } from '../../../utils/localizeContent';
import Icon from '../../../shared/components/Icon';
import ModelDetailsPopup from '../../../shared/components/ModelDetailsPopup';
import { makeAdminApiCall, toggleModels } from '../../../api/adminApi';
import { DataTable, SearchInput, FilterSelect } from '../components/data-table';

function ModelNameCell({ model, currentLanguage }) {
  return (
    <div className="flex items-center">
      <div className="flex-shrink-0 h-8 w-8">
        <div className="h-8 w-8 rounded-full bg-indigo-100 dark:bg-indigo-900/50 flex items-center justify-center">
          <Icon name="cpu-chip" className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
        </div>
      </div>
      <div className="ml-3 min-w-0">
        <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
          {getLocalizedContent(model.name, currentLanguage)}
        </div>
        <div className="text-xs text-gray-500 dark:text-gray-400 truncate">{model.id}</div>
      </div>
    </div>
  );
}

function StatusCell({ model, t }) {
  return (
    <div className="flex items-center gap-2">
      <span
        className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
          model.enabled
            ? 'bg-green-100 dark:bg-green-900/50 text-green-800 dark:text-green-300'
            : 'bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-300'
        }`}
      >
        {model.enabled
          ? t('admin.models.enabled', 'Enabled')
          : t('admin.models.disabled', 'Disabled')}
      </span>
      {model.default && (
        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 dark:bg-blue-900/50 text-blue-800 dark:text-blue-300">
          {t('admin.models.default', 'Default')}
        </span>
      )}
    </div>
  );
}

function AdminModelsPage() {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const navigate = useNavigate();
  const [models, setModels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchTerm, setSearchTerm] = useFilterState('q', '');
  const [filterEnabled, setFilterEnabled] = useFilterState('enabled', 'all');
  const [testingModel, setTestingModel] = useState(null);
  const [testResults, setTestResults] = useState({});
  const [selectedModel, setSelectedModel] = useState(null);
  const [showModelDetails, setShowModelDetails] = useState(false);
  const [uploading, setUploading] = useState(false);

  const loadModels = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await makeAdminApiCall('/admin/models');
      const data = response.data;
      setModels(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err.message);
      setModels([]);
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
      setModels(prev => prev.map(m => (m.id === modelId ? { ...m, enabled: result.enabled } : m)));
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
      setTestResults(prev => ({ ...prev, [modelId]: response.data }));
    } catch (err) {
      const errorData = err.response?.data || {};
      setTestResults(prev => ({
        ...prev,
        [modelId]: {
          success: false,
          message: errorData.message || 'Test failed',
          error: errorData.error || err.message
        }
      }));
    } finally {
      setTestingModel(null);
    }
  };

  const handleCloneModel = model => {
    navigate('/admin/models/new', { state: { templateModel: model } });
  };

  const handleDeleteModel = async modelId => {
    if (!confirm(t('admin.models.deleteConfirm', 'Delete this model?'))) return;
    try {
      await makeAdminApiCall(`/admin/models/${modelId}`, { method: 'DELETE' });
      setModels(prev => prev.filter(m => m.id !== modelId));
    } catch (err) {
      setError(err.message);
    }
  };

  const downloadModelConfig = async modelId => {
    try {
      const response = await makeAdminApiCall(`/admin/models/${modelId}`);
      const model = response.data;
      const configData = JSON.stringify(model, null, 2);
      const blob = new Blob([configData], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `model-${modelId}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(`Failed to download model config: ${err.message}`);
    }
  };

  const handleUploadConfig = async event => {
    const file = event.target.files[0];
    if (!file) return;
    if (!file.name.endsWith('.json')) {
      setError('Please select a JSON file');
      return;
    }
    setUploading(true);
    let modelConfig;
    try {
      const fileContent = await file.text();
      modelConfig = JSON.parse(fileContent);
      if (
        !modelConfig.id ||
        !modelConfig.name ||
        !modelConfig.description ||
        !modelConfig.provider
      ) {
        throw new Error(
          'Invalid model config: missing required fields (id, name, description, provider)'
        );
      }
      await makeAdminApiCall('/admin/models', { method: 'POST', body: modelConfig });
      await loadModels();
      event.target.value = '';
    } catch (err) {
      if (err.message.includes('already exists')) {
        setError(`Model with ID "${modelConfig?.id || 'unknown'}" already exists`);
      } else if (err instanceof SyntaxError) {
        setError('Invalid JSON file format');
      } else {
        setError(`Failed to upload model config: ${err.message}`);
      }
    } finally {
      setUploading(false);
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

  const columns = [
    {
      key: 'name',
      header: t('admin.models.name', 'Name'),
      sortable: true,
      sortAccessor: m => getLocalizedContent(m.name, currentLanguage),
      render: m => <ModelNameCell model={m} currentLanguage={currentLanguage} />
    },
    {
      key: 'provider',
      header: t('admin.models.provider', 'Provider'),
      sortable: true,
      hideBelow: 'md',
      render: m => m.provider || '-'
    },
    {
      key: 'status',
      header: t('admin.models.table.status', 'Status'),
      sortable: true,
      sortAccessor: m => (m.enabled ? 1 : 0),
      render: m => <StatusCell model={m} t={t} />
    }
  ];

  const actions = [
    {
      id: 'edit',
      label: t('common.edit', 'Edit'),
      icon: 'pencil',
      priority: 'primary',
      onClick: m => navigate(`/admin/models/${m.id}`)
    },
    {
      id: 'toggle',
      label: t('admin.models.toggle', 'Toggle enabled'),
      icon: 'eye',
      priority: 'primary',
      onClick: m => toggleModel(m.id)
    },
    {
      id: 'test',
      label: t('admin.models.test', 'Test'),
      icon: 'play',
      busy: m => testingModel === m.id,
      onClick: m => testModel(m.id)
    },
    {
      id: 'clone',
      label: t('admin.models.clone', 'Clone'),
      icon: 'copy',
      onClick: m => handleCloneModel(m)
    },
    {
      id: 'download',
      label: t('admin.models.download', 'Download Config'),
      icon: 'download',
      onClick: m => downloadModelConfig(m.id)
    },
    {
      id: 'delete',
      label: t('admin.models.delete', 'Delete'),
      icon: 'trash',
      destructive: true,
      onClick: m => handleDeleteModel(m.id)
    }
  ];

  const getRowExpansion = model => {
    const result = testResults[model.id];
    if (!result) return null;
    return {
      expanded: true,
      content: (
        <div className="flex items-start space-x-3">
          {result.success ? (
            <>
              <Icon name="check-circle" className="h-5 w-5 text-green-500 flex-shrink-0 mt-0.5" />
              <div className="flex-1">
                <div className="text-sm font-medium text-green-800 dark:text-green-300">
                  {t('admin.models.test.success', 'Test Successful')}
                </div>
                <div className="text-sm text-gray-700 dark:text-gray-300 mt-1">
                  {result.response}
                </div>
              </div>
            </>
          ) : (
            <>
              <Icon
                name="exclamation-circle"
                className="h-5 w-5 text-red-500 flex-shrink-0 mt-0.5"
              />
              <div className="flex-1">
                <div className="text-sm font-medium text-red-800 dark:text-red-300">
                  {result.message || t('admin.models.test.failed', 'Test Failed')}
                </div>
                {result.error && (
                  <div className="text-sm text-gray-700 dark:text-gray-300 mt-1">
                    {result.error}
                  </div>
                )}
              </div>
            </>
          )}
          <button
            onClick={() =>
              setTestResults(prev => {
                const next = { ...prev };
                delete next[model.id];
                return next;
              })
            }
            className="text-gray-400 hover:text-gray-600"
            title={t('common.close', 'Close')}
          >
            <Icon name="x" className="h-5 w-5" />
          </button>
        </div>
      )
    };
  };

  if (error) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md p-4">
          <div className="flex">
            <Icon name="exclamation-triangle" className="h-5 w-5 text-red-400" />
            <div className="ml-3">
              <h3 className="text-sm font-medium text-red-800 dark:text-red-300">
                {t('admin.models.loadError', 'Error loading models')}
              </h3>
              <p className="mt-1 text-sm text-red-700 dark:text-red-400">{error}</p>
              <button
                onClick={() => window.location.reload()}
                className="mt-2 text-sm text-red-600 dark:text-red-300 hover:text-red-500"
              >
                {t('common.retry', 'Retry')}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="sm:flex sm:items-center">
          <div className="sm:flex-auto">
            <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
              {t('admin.models.title', 'Model Management')}
            </h1>
            <p className="mt-2 text-sm text-gray-700 dark:text-gray-300">
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
              <div className="relative">
                <input
                  type="file"
                  accept=".json"
                  onChange={handleUploadConfig}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                  disabled={uploading}
                />
                <button
                  type="button"
                  className="inline-flex items-center justify-center rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 shadow-sm hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
                  disabled={uploading}
                  title={t('admin.models.uploadConfig', 'Upload Model Config')}
                >
                  <Icon
                    name={uploading ? 'refresh' : 'upload'}
                    className={`h-4 w-4 mr-2 ${uploading ? 'animate-spin' : ''}`}
                  />
                  {uploading
                    ? t('admin.models.uploading', 'Uploading...')
                    : t('admin.models.uploadConfig', 'Upload Config')}
                </button>
              </div>
              <button
                type="button"
                className="inline-flex items-center justify-center rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 shadow-sm hover:bg-gray-50 dark:hover:bg-gray-600"
                onClick={enableAllModels}
              >
                {t('admin.common.enableAll', 'Enable All')}
              </button>
              <button
                type="button"
                className="inline-flex items-center justify-center rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 shadow-sm hover:bg-gray-50 dark:hover:bg-gray-600"
                onClick={disableAllModels}
              >
                {t('admin.common.disableAll', 'Disable All')}
              </button>
            </div>
          </div>
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <SearchInput
            value={searchTerm}
            onChange={setSearchTerm}
            placeholder={t('admin.models.searchPlaceholder', 'Search models...')}
          />
          <FilterSelect
            label={t('admin.models.statusLabel', 'Status')}
            value={filterEnabled}
            onChange={setFilterEnabled}
            options={[
              { value: 'all', label: t('admin.models.filterAll', 'All Models') },
              { value: 'enabled', label: t('admin.models.filterEnabled', 'Enabled Only') },
              { value: 'disabled', label: t('admin.models.filterDisabled', 'Disabled Only') }
            ]}
          />
        </div>

        <div className="mt-6">
          <DataTable
            columns={columns}
            data={filteredModels}
            getRowId={m => m.id}
            actions={actions}
            loading={loading}
            getRowExpansion={getRowExpansion}
            onRowClick={model => {
              setSelectedModel(model);
              setShowModelDetails(true);
            }}
            empty={{
              icon: 'cpu-chip',
              title: t('admin.models.noModels', 'No models found'),
              description: t('admin.models.noModelsDesc', 'Get started by creating a new model.'),
              action: (
                <button
                  onClick={() => navigate('/admin/models/new')}
                  className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
                >
                  <Icon name="plus" className="h-4 w-4 mr-2" />
                  {t('admin.models.addNew', 'Add New Model')}
                </button>
              )
            }}
          />
        </div>

        <ModelDetailsPopup
          model={selectedModel}
          isOpen={showModelDetails}
          onClose={() => setShowModelDetails(false)}
        />
      </div>
    </div>
  );
}

export default AdminModelsPage;
