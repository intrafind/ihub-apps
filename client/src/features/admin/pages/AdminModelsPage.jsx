// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState, useEffect, useRef } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useFilterState } from '../hooks/useFilterState';
import { getLocalizedContent } from '../../../utils/localizeContent';
import Icon from '../../../shared/components/Icon';
import ModelDetailsPopup from '../../../shared/components/ModelDetailsPopup';
import { getAdminApiErrorMessage, makeAdminApiCall, toggleModels } from '../../../api/adminApi';
import { DataTable, SearchInput, FilterSelect } from '../components/data-table';
import { translateModelTestMessage } from '../utils/modelTestMessages';
import ModelImportDialog from '../components/ModelImportDialog';
import ApiKeyStatusBadge from '../components/ApiKeyStatusBadge';
import useApiKeyStatus from '../hooks/useApiKeyStatus';
import AdminLoadError from '../components/AdminLoadError';
import useAdminPageAccess from '../hooks/useAdminPageAccess';
import useFeatureFlags from '../../../shared/hooks/useFeatureFlags';
import ModelsTabsHeader from '../components/ModelsTabsHeader';
import ModelsSetupStrip from '../components/ModelsSetupStrip';
import MoreActionsMenu from '../components/MoreActionsMenu';
import { describeModelProvider } from '../utils/modelsArea';
import { apiTypeLabel } from '../utils/modelImport';

function ModelNameCell({ model, currentLanguage }) {
  return (
    <div className="flex items-center">
      <div className="shrink-0 h-8 w-8">
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

/**
 * How a model's output is marked as AI generated. "Not marked" is a hint, not a
 * warning: there is no gate. `ihub` (own watermark) is shown only as far as it exists.
 */
function MarkingBadge({ marking, t }) {
  const by = marking?.by === 'provider' || marking?.by === 'ihub' ? marking.by : 'none';
  const styles =
    by === 'none'
      ? 'bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-300'
      : 'bg-green-100 dark:bg-green-900/50 text-green-800 dark:text-green-300';
  const labels = {
    none: t('admin.models.marking.none', 'Not marked'),
    provider: t('admin.models.marking.provider', 'Provider-marked'),
    ihub: t('admin.models.marking.ihub', 'iHub watermark')
  };
  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${styles}`}
      data-testid="model-marking-badge"
    >
      {labels[by]}
    </span>
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

/**
 * The provider a model takes its key from: its name, linking to the provider's page, and a
 * marker when that provider sets its own timeouts. A model that uses no provider entry shows its
 * API type.
 */
function ProviderCell({ model, providers, language, t }) {
  const { entry, name } = describeModelProvider(model, providers, language);
  if (!entry) return <span>{model.provider ? apiTypeLabel(t, model.provider) : '-'}</span>;
  const ownTimeouts =
    Number.isFinite(entry.connectTimeoutMs) || Number.isFinite(entry.streamIdleTimeoutMs);
  return (
    <span className="inline-flex items-center gap-1.5">
      <Link
        to={`/admin/providers/${entry.id}`}
        onClick={event => event.stopPropagation()}
        className="text-indigo-600 dark:text-indigo-400 hover:underline"
      >
        {name}
      </Link>
      {ownTimeouts && (
        <span
          title={t('admin.models.providerOwnTimeouts', 'This provider sets its own timeouts')}
          className="text-xs text-gray-500 dark:text-gray-400"
        >
          <span aria-hidden="true">⏱</span>
          <span className="sr-only">
            {t('admin.models.providerOwnTimeouts', 'This provider sets its own timeouts')}
          </span>
        </span>
      )}
    </span>
  );
}

function AdminModelsPage() {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const navigate = useNavigate();
  const location = useLocation();
  const featureFlags = useFeatureFlags();
  const access = useAdminPageAccess();
  const [models, setModels] = useState([]);
  const [providers, setProviders] = useState([]);
  const { statuses: keyStatuses, reload: reloadKeyStatus } = useApiKeyStatus('models');
  const { statuses: providerKeyStatuses, reload: reloadProviderKeyStatus } =
    useApiKeyStatus('providers');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchTerm, setSearchTerm] = useFilterState('q', '');
  const [filterEnabled, setFilterEnabled] = useFilterState('enabled', 'all');
  const [filterProvider, setFilterProvider] = useFilterState('provider', 'all');
  const [filterType, setFilterType] = useFilterState('type', 'all');
  const [testingModel, setTestingModel] = useState(null);
  const [testResults, setTestResults] = useState({});
  const [selectedModel, setSelectedModel] = useState(null);
  const [showModelDetails, setShowModelDetails] = useState(false);
  const [uploading, setUploading] = useState(false);
  const uploadInputRef = useRef(null);
  // The Providers page opens the import dialog for one provider through
  // navigation state ({ importProviderId }).
  const [importDialog, setImportDialog] = useState(() =>
    location.state?.importProviderId
      ? { open: true, providerId: location.state.importProviderId }
      : { open: false, providerId: null }
  );

  const loadModels = async () => {
    reloadKeyStatus();
    reloadProviderKeyStatus();
    try {
      setLoading(true);
      setError(null);
      // The provider list only adds names and a count; a failure there never blocks the models.
      const [response, providersResponse] = await Promise.all([
        makeAdminApiCall('/admin/models'),
        makeAdminApiCall('/admin/providers').catch(() => ({ data: [] }))
      ]);
      const data = response.data;
      setModels(Array.isArray(data?.items) ? data.items : []);
      setProviders(
        Array.isArray(providersResponse.data?.items) ? providersResponse.data.items : []
      );
    } catch (err) {
      setError(getAdminApiErrorMessage(err));
      setModels([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadModels();
  }, []);

  const toggleModel = async modelId => {
    try {
      // The route sets the state it is told: flip from what the list shows.
      const enabled = !models.find(m => m.id === modelId)?.enabled;
      await toggleModels(modelId, enabled);
      setModels(prev => prev.map(m => (m.id === modelId ? { ...m, enabled } : m)));
    } catch (err) {
      setError(getAdminApiErrorMessage(err));
    }
  };

  const enableAllModels = async () => {
    try {
      await toggleModels('*', true);
      setModels(prev => prev.map(m => ({ ...m, enabled: true })));
    } catch (err) {
      setError(getAdminApiErrorMessage(err));
    }
  };

  const disableAllModels = async () => {
    try {
      await toggleModels('*', false);
      setModels(prev => prev.map(m => ({ ...m, enabled: false, default: false })));
    } catch (err) {
      setError(getAdminApiErrorMessage(err));
    }
  };

  const testModel = async modelId => {
    setTestingModel(modelId);
    // The test endpoint maps a provider rejecting the server's key onto 502 (not
    // 401), so the shared admin client is safe here: a 401 really is an expired
    // admin session and must go through the global re-authentication flow.
    try {
      const response = await makeAdminApiCall(`/admin/models/${modelId}/_test`, {
        method: 'POST'
      });
      // A failed test is an HTTP error (the catch below); an answer is a passed test.
      setTestResults(prev => ({
        ...prev,
        [modelId]: { ...(response?.data || {}), success: true }
      }));
    } catch (err) {
      // Server body: { error: headline, code, details: { remediation, messageKey } }
      const body = err?.response?.data || {};
      const fallbackMessage = body.detail || t('admin.models.testResults.failed', 'Test Failed');
      setTestResults(prev => ({
        ...prev,
        [modelId]: {
          success: false,
          message: translateModelTestMessage(t, body.details?.messageKey, fallbackMessage),
          error:
            body.details?.remediation ||
            (err?.response?.status ? `HTTP ${err.response.status}` : err.message)
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
      setError(getAdminApiErrorMessage(err));
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
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(`Failed to download model config: ${getAdminApiErrorMessage(err)}`);
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
      if (getAdminApiErrorMessage(err).includes('already exists')) {
        setError(`Model with ID "${modelConfig?.id || 'unknown'}" already exists`);
      } else if (err instanceof SyntaxError) {
        setError('Invalid JSON file format');
      } else {
        setError(`Failed to upload model config: ${getAdminApiErrorMessage(err)}`);
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

    const matchesProvider =
      filterProvider === 'all' || describeModelProvider(model, providers).id === filterProvider;
    const matchesType = filterType === 'all' || (model.modelType || 'chat') === filterType;

    return matchesSearch && matchesFilter && matchesProvider && matchesType;
  });

  // Providers the models actually use, for the filter: an entry's name, else its id / API type.
  const providerOptions = [
    ...new Map(
      models.map(model => {
        const { id, name } = describeModelProvider(model, providers, currentLanguage);
        return [id, name || id];
      })
    )
  ]
    .filter(([id]) => id)
    .sort((a, b) => String(a[1]).localeCompare(String(b[1])))
    .map(([value, label]) => ({ value, label }));

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
      sortAccessor: m =>
        describeModelProvider(m, providers, currentLanguage).name || m.provider || '',
      render: m => <ProviderCell model={m} providers={providers} language={currentLanguage} t={t} />
    },
    {
      key: 'apiKey',
      header: t('admin.models.table.apiKey', 'API key'),
      hideBelow: 'md',
      render: m => <ApiKeyStatusBadge status={keyStatuses[m.id]} />
    },
    {
      key: 'marking',
      header: t('admin.models.table.marking', 'Output marking'),
      hideBelow: 'lg',
      render: m =>
        m.modelType === 'transcription' || m.modelType === 'tts' ? null : (
          <MarkingBadge marking={m.contentMarking?.text} t={t} />
        )
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
              <Icon name="check-circle" className="h-5 w-5 text-green-500 shrink-0 mt-0.5" />
              <div className="flex-1">
                <div className="text-sm font-medium text-green-800 dark:text-green-300">
                  {t('admin.models.testResults.success', 'Test Successful')}
                </div>
                <div className="text-sm text-gray-700 dark:text-gray-300 mt-1">
                  {result.response}
                </div>
              </div>
            </>
          ) : (
            <>
              <Icon name="exclamation-circle" className="h-5 w-5 text-red-500 shrink-0 mt-0.5" />
              <div className="flex-1">
                <div className="text-sm font-medium text-red-800 dark:text-red-300">
                  {result.message || t('admin.models.testResults.failed', 'Test Failed')}
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
            className="text-gray-500 hover:text-gray-600"
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
      <AdminLoadError title={t('admin.models.loadError', 'Error loading models')} message={error} />
    );
  }

  return (
    <div>
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <ModelsTabsHeader
          modelCount={loading ? undefined : models.length}
          providerCount={loading ? undefined : providers.length}
          actions={
            <>
              <button
                type="button"
                onClick={() => navigate('/admin/models/new')}
                className="inline-flex items-center justify-center rounded-md border border-transparent bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-xs hover:bg-indigo-700 focus:outline-hidden focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
              >
                <Icon name="plus" className="h-4 w-4 mr-2" />
                {t('admin.models.addNew', 'Add New Model')}
              </button>
              <button
                type="button"
                onClick={() => setImportDialog({ open: true, providerId: null })}
                className="inline-flex items-center justify-center rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 shadow-xs hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-hidden focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
              >
                <Icon name="link" className="h-4 w-4 mr-2" />
                {t('admin.models.import.models', 'Import models')}
              </button>
              <input
                ref={uploadInputRef}
                type="file"
                accept=".json,application/json"
                onChange={handleUploadConfig}
                className="sr-only"
                tabIndex={-1}
                aria-hidden="true"
                disabled={uploading}
              />
              <MoreActionsMenu
                label={t('admin.models.moreActions', 'More model actions')}
                items={[
                  {
                    id: 'upload',
                    label: uploading
                      ? t('admin.models.uploading', 'Uploading...')
                      : t('admin.models.uploadConfig', 'Upload Config'),
                    disabled: uploading,
                    onSelect: () => uploadInputRef.current?.click()
                  },
                  ...(featureFlags.isEnabled('marketplace', true)
                    ? [
                        {
                          id: 'marketplace',
                          label: t('admin.models.fromMarketplace', 'Install from Marketplace'),
                          onSelect: () => navigate('/admin/marketplace?type=model')
                        }
                      ]
                    : []),
                  {
                    id: 'enableAll',
                    label: t('admin.common.enableAll', 'Enable All'),
                    onSelect: enableAllModels
                  },
                  {
                    id: 'disableAll',
                    label: t('admin.common.disableAll', 'Disable All'),
                    destructive: true,
                    onSelect: disableAllModels
                  }
                ]}
              />
            </>
          }
        />

        <div role="tabpanel" id="tabpanel-models" aria-labelledby="tab-models">
          {!loading && (
            <ModelsSetupStrip
              keyStatuses={providerKeyStatuses}
              models={models}
              onConnect={access.providers ? () => navigate('/admin/providers') : undefined}
              onImport={() => setImportDialog({ open: true, providerId: null })}
              onShowEnabled={() => setFilterEnabled('enabled')}
            />
          )}

          <div className="flex flex-wrap items-end gap-3">
            <SearchInput
              value={searchTerm}
              onChange={setSearchTerm}
              placeholder={t('admin.models.searchPlaceholder', 'Search models...')}
            />
            <FilterSelect
              ariaLabel={t('admin.models.providerFilter', 'Provider')}
              value={filterProvider}
              onChange={setFilterProvider}
              options={[
                { value: 'all', label: t('admin.models.filterAllProviders', 'All providers') },
                ...providerOptions
              ]}
            />
            <FilterSelect
              ariaLabel={t('admin.models.typeFilter', 'Type')}
              value={filterType}
              onChange={setFilterType}
              options={[
                { value: 'all', label: t('admin.models.filterAllTypes', 'All types') },
                { value: 'chat', label: t('admin.models.types.chat', 'Chat') },
                {
                  value: 'transcription',
                  label: t('admin.models.types.transcription', 'Transcription')
                },
                { value: 'tts', label: t('admin.models.types.tts', 'Text-to-speech') }
              ]}
            />
            <FilterSelect
              ariaLabel={t('admin.models.statusLabel', 'Status')}
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
                    className="inline-flex items-center px-4 py-2 border border-transparent shadow-xs text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
                  >
                    <Icon name="plus" className="h-4 w-4 mr-2" />
                    {t('admin.models.addNew', 'Add New Model')}
                  </button>
                )
              }}
            />
          </div>
        </div>

        <ModelDetailsPopup
          model={selectedModel}
          isOpen={showModelDetails}
          onClose={() => setShowModelDetails(false)}
        />

        {importDialog.open && (
          <ModelImportDialog
            initialProviderId={importDialog.providerId}
            existingModelIds={models.map(m => m.id)}
            onImported={loadModels}
            onClose={() => {
              setImportDialog({ open: false, providerId: null });
              if (location.state?.importProviderId) {
                navigate(location.pathname, { replace: true, state: null });
              }
            }}
          />
        )}
      </div>
    </div>
  );
}

export default AdminModelsPage;
