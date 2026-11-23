// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState, useEffect, useRef } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useFilterState } from '../hooks/useFilterState';
import { getLocalizedContent } from '../../../utils/localizeContent';
import Icon from '../../../shared/components/Icon';
import ModelDetailsPopup from '../../../shared/components/ModelDetailsPopup';
import {
  assignedDefaultModelId,
  fetchModelDependants,
  getAdminApiErrorMessage,
  makeAdminApiCall,
  makeDefaultModel,
  toggleModels
} from '../../../api/adminApi';
import { DataTable, SearchInput, FilterSelect } from '../components/data-table';
import { runModelTest } from '../utils/modelTestMessages';
import ModelTestResult from '../components/ModelTestResult';
import Switch from '../../../shared/components/Switch';
import EditorToast, { useEditorToast } from '../components/app-editor/EditorMessages';
import { deleteWithHistoryMessage, modelDeleteConsequences } from '../utils/deleteDependants';
import ModelImportDialog from '../components/ModelImportDialog';
import ApiKeyStatusBadge from '../components/ApiKeyStatusBadge';
import useApiKeyStatus from '../hooks/useApiKeyStatus';
import AdminLoadError from '../components/AdminLoadError';
import { listCount } from '../utils/listLoadState';
import useAdminPageAccess from '../hooks/useAdminPageAccess';
import useFeatureFlags from '../../../shared/hooks/useFeatureFlags';
import ModelsTabsHeader from '../components/ModelsTabsHeader';
import ModelsSetupStrip from '../components/ModelsSetupStrip';
import MoreActionsMenu from '../components/MoreActionsMenu';
import { describeModelProvider } from '../utils/modelsArea';
import { apiTypeLabel } from '../utils/modelImport';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import { useConfirmAction } from '../hooks/useConfirmAction';
import { buildBulkToggleConfirm } from '../utils/bulkToggleConfirm';
import { deleteConfirmText } from '../utils/confirmText';
import { copyId } from '../utils/copyId';

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

/**
 * Whether the model is on, as a switch that turns it on or off for every user
 * with access, and the "Default" badge. The switch does not open the row's details.
 */
function StatusCell({ model, name, onToggle, t }) {
  return (
    <div className="flex items-center gap-2">
      <Switch
        size="sm"
        checked={Boolean(model.enabled)}
        onChange={(_next, event) => {
          event?.stopPropagation();
          onToggle(model.id);
        }}
        aria-label={t('admin.models.enabledSwitch', { name, defaultValue: 'Enabled: {{name}}' })}
        data-testid={`model-enabled-${model.id}`}
      />
      <span className="text-xs text-gray-700 dark:text-gray-300">
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
  const { requestConfirm, dialogProps: confirmDialogProps } = useConfirmAction();
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
  // `error`: a failed action (toggle, download, upload). `loadError`: the list could not be
  // loaded; the table then shows it with Retry instead of the empty state.
  const [error, setError] = useState(null);
  const [loadError, setLoadError] = useState(null);
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
  // Tells the admin when the server made a model the default on its own (AI-B13).
  const [toast, showToast] = useEditorToast();
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
      setLoadError(null);
    } catch (err) {
      // The models loaded before (if any) stay listed below the error.
      setLoadError(getAdminApiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const modelName = model => getLocalizedContent(model.name, currentLanguage) || model.id;
  const modelNameById = id => {
    const model = models.find(m => m.id === id);
    return model ? modelName(model) : id;
  };

  /**
   * Says that the server made `modelId` the default on its own: every app that
   * names no model answers with it now.
   *
   * @param {string|null|undefined} modelId
   */
  const announceAssignedDefault = modelId => {
    if (!modelId) return;
    showToast(
      t('admin.models.defaultAssigned', {
        name: modelNameById(modelId),
        defaultValue: '"{{name}}" is now the default model.'
      })
    );
  };

  useEffect(() => {
    void loadModels();
  }, []);

  // The editor hands over a default the server assigned while saving.
  const handedOverDefault = location.state?.defaultAssigned;
  useEffect(() => {
    if (!handedOverDefault || loading) return;
    announceAssignedDefault(handedOverDefault);
    navigate(location.pathname + location.search, { replace: true, state: null });
  }, [handedOverDefault, loading]); // eslint-disable-line @eslint-react/exhaustive-deps

  const toggleModel = async modelId => {
    try {
      // The route sets the state it is told: flip from what the list shows.
      const enabled = !models.find(m => m.id === modelId)?.enabled;
      const result = await toggleModels(modelId, enabled);
      const assigned = result?.assignedDefaultModelId;
      setModels(prev =>
        prev.map(m => {
          // A disabled model loses the default flag on the server.
          if (m.id === modelId) return { ...m, enabled, ...(enabled ? {} : { default: false }) };
          return assigned ? { ...m, default: m.id === assigned } : m;
        })
      );
      announceAssignedDefault(assigned);
    } catch (err) {
      setError(getAdminApiErrorMessage(err));
    }
  };

  /** Makes an enabled chat model the default, from its row. */
  const makeDefault = async model => {
    try {
      await makeDefaultModel(model.id);
      setModels(prev => prev.map(m => ({ ...m, default: m.id === model.id })));
      showToast(
        t('admin.models.madeDefault', {
          name: modelName(model),
          defaultValue: '"{{name}}" is the default model now.'
        })
      );
    } catch (err) {
      setError(getAdminApiErrorMessage(err));
    }
  };

  /**
   * Enable All / Disable All toggle every model (`*`) for every user, so they
   * open a confirmation naming the count and the models first (AI-B2).
   *
   * Disable All also clears the default flag on every model (the server sets
   * `default: false` on each disabled model). When models are enabled again,
   * the server makes the first enabled chat model the default, which is not
   * necessarily the previous one. The dialog says so.
   *
   * @param {boolean} enable - Target state.
   */
  const confirmToggleAll = enable => {
    const currentDefault = models.find(m => m.default === true);
    const extraConsequences = enable
      ? []
      : [
          currentDefault
            ? t('admin.models.disableAllDefaultNamed', {
                name: modelName(currentDefault),
                defaultValue:
                  'The default model setting is cleared ("{{name}}" is the default now). When models are enabled again, the first chat model in the list becomes the default, not necessarily "{{name}}".'
              })
            : t(
                'admin.models.disableAllDefault',
                'The default model setting is cleared. When models are enabled again, the first chat model in the list becomes the default.'
              )
        ];
    requestConfirm({
      ...buildBulkToggleConfirm({
        items: models,
        enable,
        itemsLabel: t('admin.confirm.plural.models', 'models'),
        getName: modelName,
        t,
        extraConsequences
      }),
      action: async () => {
        const result = await toggleModels('*', enable);
        // Reload instead of patching the list: enabling makes the server pick
        // a new default model, which only the server's list shows.
        await loadModels();
        announceAssignedDefault(result?.assignedDefaultModelId);
      }
    });
  };

  const testModel = async modelId => {
    setTestingModel(modelId);
    const result = await runModelTest(modelId, t, makeAdminApiCall);
    setTestResults(prev => ({ ...prev, [modelId]: result }));
    setTestingModel(null);
  };

  // The clone opens as a new model with the ID `<id>-copy` (or the next free one) proposed.
  const handleCloneModel = model => {
    const cloneId = copyId(
      model.id,
      models.map(m => m.id)
    );
    navigate('/admin/models/new', { state: { templateModel: model, cloneId } });
  };

  /**
   * Opens the delete dialog once the server said what names the model (apps,
   * workflows, groups, the default status), so the dialog can list it. A
   * failed check still opens the dialog, which then says it could not check.
   */
  const handleDeleteModel = async model => {
    const dependants = await fetchModelDependants(model.id).catch(() => null);
    requestConfirm({
      ...deleteConfirmText({
        typeKey: 'model',
        typeFallback: 'model',
        name: modelName(model),
        t,
        message: deleteWithHistoryMessage({ type: 'model', path: `/admin/models/${model.id}`, t })
      }),
      consequences: modelDeleteConsequences(dependants, {
        t,
        language: currentLanguage,
        modelName: modelNameById
      }),
      action: async () => {
        const response = await makeAdminApiCall(`/admin/models/${model.id}`, { method: 'DELETE' });
        const assigned = assignedDefaultModelId(response);
        setModels(prev =>
          prev
            .filter(m => m.id !== model.id)
            .map(m => (assigned ? { ...m, default: m.id === assigned } : m))
        );
        announceAssignedDefault(assigned);
      }
    });
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
      setError(t('admin.models.downloadError', { error: getAdminApiErrorMessage(err) }));
    }
  };

  const handleUploadConfig = async event => {
    const file = event.target.files[0];
    if (!file) return;
    if (!file.name.endsWith('.json')) {
      setError(t('admin.common.selectJsonFile', 'Please select a JSON file'));
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
        setError(t('admin.models.uploadExists', { id: modelConfig?.id || 'unknown' }));
      } else if (err instanceof SyntaxError) {
        setError(t('admin.common.invalidJsonFile', 'Invalid JSON file format'));
      } else {
        setError(t('admin.models.uploadError', { error: getAdminApiErrorMessage(err) }));
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
      render: m => <StatusCell model={m} name={modelName(m)} onToggle={toggleModel} t={t} />
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
      id: 'makeDefault',
      label: t('admin.models.makeDefault', 'Make default'),
      icon: 'star',
      priority: 'primary',
      // Only a chat model can be the default, and only one that is enabled.
      hidden: m => m.default === true || (m.modelType || 'chat') !== 'chat',
      disabled: m => !m.enabled,
      title: m =>
        m.enabled ? undefined : t('admin.models.makeDefaultDisabled', 'Enable the model first'),
      onClick: m => makeDefault(m)
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
      onClick: m => handleDeleteModel(m)
    }
  ];

  const getRowExpansion = model => {
    const result = testResults[model.id];
    if (!result) return null;
    return {
      expanded: true,
      content: (
        <ModelTestResult
          result={result}
          onDismiss={() =>
            setTestResults(prev => {
              const next = { ...prev };
              delete next[model.id];
              return next;
            })
          }
        />
      )
    };
  };

  // A failed load keeps the tabs, the actions and any models loaded before; the table shows
  // the error with Retry instead of "No models found" (AI-B11).
  return (
    <div>
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <ModelsTabsHeader
          modelCount={listCount(models.length, { loading, error: loadError })}
          providerCount={listCount(providers.length, { loading, error: loadError })}
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
                    onSelect: () => confirmToggleAll(true)
                  },
                  {
                    id: 'disableAll',
                    label: t('admin.common.disableAll', 'Disable All'),
                    destructive: true,
                    onSelect: () => confirmToggleAll(false)
                  }
                ]}
              />
            </>
          }
        />

        <div role="tabpanel" id="tabpanel-models" aria-labelledby="tab-models">
          {error && (
            <AdminLoadError message={error} framed={false} className="mb-4" action={null} />
          )}
          {/* The setup strip reads an empty list as "nothing set up yet": not after a failed load. */}
          {listCount(models.length, { loading, error: loadError }) !== undefined && (
            <ModelsSetupStrip
              keyStatuses={providerKeyStatuses}
              models={models}
              providers={providers}
              onConnect={access.providers ? () => navigate('/admin/providers/connect') : undefined}
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
              error={loadError}
              onRetry={loadModels}
              errorTitle={t('admin.models.loadError', 'Error loading models')}
              getRowExpansion={getRowExpansion}
              onRowClick={model => {
                setSelectedModel(model);
                setShowModelDetails(true);
              }}
              empty={{
                icon: 'cpu-chip',
                title: t('admin.models.noModels', 'No models found'),
                description: t('admin.models.noModelsDesc', 'Get started by creating a new model.'),
                action:
                  // With no model at all the way in is connecting a provider;
                  // a filter that hides every model keeps "Add New Model".
                  models.length === 0 && access.providers ? (
                    <button
                      onClick={() => navigate('/admin/providers/connect')}
                      className="inline-flex items-center px-4 py-2 border border-transparent shadow-xs text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
                    >
                      <Icon name="link" className="h-4 w-4 mr-2" />
                      {t('admin.providers.connect.title', 'Connect a model provider')}
                    </button>
                  ) : (
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
      <ConfirmDialog {...confirmDialogProps} />
      <EditorToast message={toast} />
    </div>
  );
}

export default AdminModelsPage;
