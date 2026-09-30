import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useFilterState } from '../hooks/useFilterState';
import { getLocalizedContent } from '../../../utils/localizeContent';
import Icon from '../../../shared/components/Icon';
import ModelDetailsPopup from '../../../shared/components/ModelDetailsPopup';
import {
  getAdminApiErrorMessage,
  makeAdminApiCall,
  toggleModel as toggleModelRequest,
  toggleModels
} from '../../../api/adminApi';
import { DataTable, SearchInput, FilterSelect } from '../components/data-table';
import { translateModelTestMessage } from '../utils/modelTestMessages';
import JustificationDialog from '../../../shared/components/JustificationDialog';
import {
  JUSTIFICATION_FIELD,
  getModelMarkingFlag,
  getUnmarkedModelError,
  serializeConfigForDownload
} from '../utils/aiTransparencyAdmin';

/**
 * "Not marked" warning for a chat model whose free-form text is not
 * watermarked (EU AI Act Code of Practice, Measure 1.1.2). Text plus icon,
 * with the explanation as tooltip and screen-reader text. An acknowledged
 * model keeps the badge — the acknowledgement documents the gap, it does not
 * close it.
 *
 * @param {Object} props
 * @param {Object} props.model - Model config
 * @param {Function} props.t - i18n translate function
 * @returns {JSX.Element|null}
 */
function MarkingBadge({ model, t }) {
  const flag = getModelMarkingFlag(model);
  if (!flag) return null;
  const tooltip = t(
    'admin.models.marking.notMarkedTooltip',
    'Free-form text over 200 tokens from this model is not watermarked — non-conforming under the EU AI Act Code of Practice'
  );
  return (
    <span
      className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-amber-100 dark:bg-amber-900/50 text-amber-900 dark:text-amber-100"
      title={tooltip}
    >
      <Icon name="exclamation-triangle" className="h-3.5 w-3.5" aria-hidden="true" />
      {flag.acknowledged
        ? t('admin.models.marking.notMarkedAcknowledged', 'Not marked · acknowledged')
        : t('admin.models.marking.notMarked', 'Not marked')}
      <span className="sr-only">{`: ${tooltip}`}</span>
    </span>
  );
}

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

function StatusCell({ model, t }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
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
      <MarkingBadge model={model} t={t} />
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
  // EU AI Act: an enable the server refused until a justification is given —
  // `{ models: string[], retry: (justification) => Promise<void> }`.
  const [pendingAcknowledgement, setPendingAcknowledgement] = useState(null);

  const loadModels = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await makeAdminApiCall('/admin/models');
      const data = response.data;
      setModels(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(getAdminApiErrorMessage(err));
      setModels([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadModels();
  }, []);

  /**
   * Run an enable call; when the server asks for a justification for unmarked
   * models (409), open the dialog and retry the same call with it.
   *
   * @param {(justification?: string) => Promise<void>} run - The call, applying its result
   * @returns {Promise<void>}
   */
  const runWithUnmarkedModelGate = async run => {
    try {
      await run();
    } catch (err) {
      const gate = getUnmarkedModelError(err);
      if (!gate) {
        setError(getAdminApiErrorMessage(err));
        return;
      }
      setPendingAcknowledgement({
        models: gate.models,
        retry: async justification => {
          await run(justification);
          setPendingAcknowledgement(null);
          // The acknowledgement is stored with the models: reload to show it.
          loadModels();
        }
      });
    }
  };

  const toggleModel = modelId =>
    runWithUnmarkedModelGate(async justification => {
      const result = await toggleModelRequest(modelId, justification);
      setModels(prev => prev.map(m => (m.id === modelId ? { ...m, enabled: result.enabled } : m)));
    });

  const enableAllModels = () =>
    runWithUnmarkedModelGate(async justification => {
      await toggleModels('*', true, justification);
      setModels(prev => prev.map(m => ({ ...m, enabled: true })));
    });

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
      const response = await makeAdminApiCall(`/admin/models/${modelId}/test`, {
        method: 'POST'
      });
      setTestResults(prev => ({ ...prev, [modelId]: response?.data || {} }));
    } catch (err) {
      // Server body: { error: headline, details: remediation text, code, messageKey }
      const body = err?.response?.data || {};
      const fallbackMessage = body.error || t('admin.models.testResults.failed', 'Test Failed');
      setTestResults(prev => ({
        ...prev,
        [modelId]: {
          success: false,
          message: translateModelTestMessage(t, body.messageKey, fallbackMessage),
          error:
            body.details || (err?.response?.status ? `HTTP ${err.response.status}` : err.message)
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
      // Without this installation's unmarked-model acknowledgement (EU AI Act
      // record): the importing installation has to decide again.
      const configData = serializeConfigForDownload('model', model);
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
      const gate = getUnmarkedModelError(err);
      if (gate) {
        // Enabled on upload but not marked: same justification gate as the toggle.
        const uploaded = modelConfig;
        const input = event.target;
        setPendingAcknowledgement({
          models: gate.models,
          // Cleared on cancel too, so choosing the same file again fires onChange.
          input,
          retry: async justification => {
            await makeAdminApiCall('/admin/models', {
              method: 'POST',
              body: { ...uploaded, [JUSTIFICATION_FIELD]: justification }
            });
            setPendingAcknowledgement(null);
            input.value = '';
            await loadModels();
          }
        });
      } else if (getAdminApiErrorMessage(err).includes('already exists')) {
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
                className="inline-flex items-center justify-center rounded-md border border-transparent bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-xs hover:bg-indigo-700 focus:outline-hidden focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 sm:w-auto"
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
                  className="inline-flex items-center justify-center rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 shadow-xs hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-hidden focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
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
                className="inline-flex items-center justify-center rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 shadow-xs hover:bg-gray-50 dark:hover:bg-gray-600"
                onClick={enableAllModels}
              >
                {t('admin.common.enableAll', 'Enable All')}
              </button>
              <button
                type="button"
                className="inline-flex items-center justify-center rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 shadow-xs hover:bg-gray-50 dark:hover:bg-gray-600"
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
                  className="inline-flex items-center px-4 py-2 border border-transparent shadow-xs text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
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

        <JustificationDialog
          isOpen={pendingAcknowledgement !== null}
          title={t(
            'admin.models.marking.enableDialog.title',
            'Enable a model that does not mark its output?'
          )}
          description={
            <>
              <p>
                {t(
                  'admin.models.marking.enableDialog.body',
                  'These models do not watermark the text they generate. Under the EU AI Act Code of Practice (Measure 1.1.2) free-form text over 200 tokens must carry an invisible watermark, so answers of these models are non-conforming.'
                )}
              </p>
              {pendingAcknowledgement?.models?.length > 0 && (
                <ul className="mt-2 list-disc pl-5 font-mono text-xs">
                  {pendingAcknowledgement.models.map(id => (
                    <li key={id}>{id}</li>
                  ))}
                </ul>
              )}
              <p className="mt-2">
                {t(
                  'admin.models.marking.enableDialog.stays',
                  'Your justification is recorded as an acknowledgement for this installation. The model stays listed as non-conforming on the EU AI Act page until it is marked.'
                )}
              </p>
            </>
          }
          label={t('admin.models.marking.enableDialog.justification', 'Justification')}
          placeholder={t(
            'admin.models.marking.enableDialog.placeholder',
            'e.g. Needed for the legal team until the self-hosted watermarked model is available (planned Q1).'
          )}
          confirmLabel={t('admin.models.marking.enableDialog.confirm', 'Enable anyway')}
          onConfirm={justification => pendingAcknowledgement.retry(justification)}
          onCancel={() => {
            if (pendingAcknowledgement?.input) pendingAcknowledgement.input.value = '';
            setPendingAcknowledgement(null);
          }}
        />
      </div>
    </div>
  );
}

export default AdminModelsPage;
