import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../../../shared/components/Modal';
import Icon from '../../../shared/components/Icon';
import { getAdminApiErrorMessage, makeAdminApiCall } from '../../../api/adminApi';
import { getLocalizedContent } from '../../../utils/localizeContent';
import {
  CUSTOM_PROVIDER_API_TYPES,
  getProviderApiType,
  isCustomLlmProvider,
  isReservedProviderId
} from '../../../../../shared/llmProviders.js';
import {
  apiTypeLabel,
  buildImportedModelConfig,
  buildNewProviderConfig,
  findIdProblems,
  getImportableProviders,
  isValidId,
  slugify,
  suggestModelId,
  translateDiscoveryError
} from '../utils/modelImport';

const NEW_PROVIDER = '__new__';

const FIELD =
  'mt-1 block w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-xs px-3 py-2 text-sm focus:border-indigo-500 focus:ring-indigo-500';
const LABEL = 'block text-sm font-medium text-gray-700 dark:text-gray-300';
const HINT = 'mt-1 text-xs text-gray-500 dark:text-gray-400';
const PRIMARY_BUTTON =
  'inline-flex items-center justify-center rounded-md border border-transparent bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-xs hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed';
const SECONDARY_BUTTON =
  'inline-flex items-center justify-center rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 shadow-xs hover:bg-gray-50 dark:hover:bg-gray-600 disabled:opacity-50';
const BADGE = 'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium';

const EMPTY_NEW_PROVIDER = {
  name: '',
  id: '',
  idEdited: false,
  description: '',
  apiType: 'openai',
  apiKey: ''
};

function typeLabel(t, type) {
  const labels = {
    embedding: t('admin.models.import.types.embedding', 'Embedding'),
    rerank: t('admin.models.import.types.rerank', 'Reranker'),
    audio: t('admin.models.import.types.audio', 'Audio'),
    image: t('admin.models.import.types.image', 'Image'),
    moderation: t('admin.models.import.types.moderation', 'Moderation'),
    other: t('admin.models.import.types.other', 'Not a chat model')
  };
  return labels[type] || type;
}

function formatTokens(value) {
  if (!value) return '—';
  if (value >= 1000000) return `${Math.round(value / 100000) / 10}M`;
  if (value >= 1000) return `${Math.round(value / 1000)}k`;
  return String(value);
}

/**
 * "Import from URL": list the models an endpoint offers and create the ones the
 * admin picks. The models are linked to a provider — an existing one, or a new
 * one created here with the endpoint's API type and key — so the key lives on
 * the provider and not on every model.
 *
 * Mount it only while it is open: its state is not reset between openings.
 */
function ModelImportDialog({ onClose, onImported, existingModelIds, initialProviderId }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;

  const [step, setStep] = useState('connect');
  const [providers, setProviders] = useState([]);
  const [providersError, setProvidersError] = useState(null);
  const [providerChoice, setProviderChoice] = useState(NEW_PROVIDER);
  const [newProvider, setNewProvider] = useState(EMPTY_NEW_PROVIDER);
  const [url, setUrl] = useState('');

  const [discovering, setDiscovering] = useState(false);
  const [discoveryError, setDiscoveryError] = useState(null);
  const [discovery, setDiscovery] = useState(null);

  const [selected, setSelected] = useState({});
  const [editedIds, setEditedIds] = useState({});
  const [prefix, setPrefix] = useState('');
  const [enableModels, setEnableModels] = useState(true);
  const [search, setSearch] = useState('');

  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState(null);
  const [createdProviderId, setCreatedProviderId] = useState(null);
  const [results, setResults] = useState([]);

  const importableProviders = useMemo(() => getImportableProviders(providers), [providers]);
  const existingProvider =
    providerChoice === NEW_PROVIDER ? null : providers.find(p => p.id === providerChoice);
  const providerIds = useMemo(() => new Set(providers.map(p => p.id)), [providers]);

  // The page mounts the dialog only while it is open, so every opening starts
  // from fresh state; the provider list is loaded once per opening.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await makeAdminApiCall('/admin/providers');
        if (cancelled) return;
        const list = Array.isArray(response.data) ? response.data : [];
        setProviders(list);
        setProvidersError(null);
        const initial = getImportableProviders(list).find(p => p.id === initialProviderId);
        if (initial) {
          setProviderChoice(initial.id);
          setUrl(initial.baseUrl || '');
        }
      } catch (err) {
        if (!cancelled) setProvidersError(getAdminApiErrorMessage(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [initialProviderId]);

  const chooseProvider = value => {
    setProviderChoice(value);
    setDiscoveryError(null);
    const provider = providers.find(p => p.id === value);
    setUrl(provider?.baseUrl || '');
  };

  const updateNewProvider = (field, value) => {
    setNewProvider(prev => {
      const next = { ...prev, [field]: value };
      if (field === 'name' && !prev.idEdited) next.id = slugify(value);
      if (field === 'id') next.idEdited = true;
      return next;
    });
  };

  const newProviderIdProblem = (() => {
    if (providerChoice !== NEW_PROVIDER || !newProvider.id) return null;
    if (!isValidId(newProvider.id)) {
      return t(
        'admin.models.import.errors.providerIdInvalid',
        'Use lowercase letters, numbers, dots, hyphens and underscores only.'
      );
    }
    if (isReservedProviderId(newProvider.id)) {
      return t(
        'admin.models.import.errors.providerIdReserved',
        'This ID is the name of an API type. Choose another ID.'
      );
    }
    if (providerIds.has(newProvider.id)) {
      return t(
        'admin.models.import.errors.providerIdExists',
        'A provider with this ID already exists. Select it above or choose another ID.'
      );
    }
    return null;
  })();

  const canDiscover =
    url.trim() &&
    !discovering &&
    (providerChoice !== NEW_PROVIDER ||
      (newProvider.name.trim() && newProvider.id && !newProviderIdProblem));

  const apiType =
    providerChoice === NEW_PROVIDER ? newProvider.apiType : getProviderApiType(existingProvider);
  const targetProviderId = providerChoice === NEW_PROVIDER ? newProvider.id : providerChoice;

  const discover = async e => {
    e?.preventDefault();
    if (!canDiscover) return;
    setDiscovering(true);
    setDiscoveryError(null);
    try {
      const body =
        providerChoice === NEW_PROVIDER
          ? { url: url.trim(), apiType: newProvider.apiType, apiKey: newProvider.apiKey }
          : { url: url.trim(), providerId: providerChoice };
      const response = await makeAdminApiCall('/admin/models/_discover', {
        method: 'POST',
        body
      });
      const data = response.data;
      setDiscovery(data);
      setSelected({});
      setEditedIds({});
      setSearch('');
      const isBuiltIn = existingProvider && !isCustomLlmProvider(existingProvider);
      setPrefix(isBuiltIn ? '' : `${targetProviderId}-`);
      setStep('select');
    } catch (err) {
      const body = err?.response?.data || {};
      setDiscoveryError({
        message: translateDiscoveryError(
          t,
          body.messageKey,
          body.error || getAdminApiErrorMessage(err)
        ),
        details: body.details
      });
    } finally {
      setDiscovering(false);
    }
  };

  const models = useMemo(() => discovery?.models || [], [discovery]);
  const targetIdOf = model => editedIds[model.id] ?? suggestModelId(model.id, prefix);

  const visibleModels = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return models;
    return models.filter(m =>
      [m.id, m.name, m.ownedBy].some(v => v && v.toLowerCase().includes(q))
    );
  }, [models, search]);

  const selectedModels = models.filter(m => selected[m.id]);
  const idProblems = findIdProblems(
    selectedModels.map(m => ({ key: m.id, id: targetIdOf(m) })),
    existingModelIds
  );
  const hasProblems = Object.keys(idProblems).length > 0;

  // "Select all" picks the visible chat models not configured yet; other types
  // and duplicates can still be ticked one by one.
  const selectableByDefault = visibleModels.filter(m => m.type === 'chat' && !m.existingModelId);
  const allSelected =
    selectableByDefault.length > 0 && selectableByDefault.every(m => selected[m.id]);

  const toggleAll = () => {
    setSelected(prev => {
      const next = { ...prev };
      for (const m of selectableByDefault) next[m.id] = !allSelected;
      return next;
    });
  };

  const problemText = problem =>
    ({
      invalid: t(
        'admin.models.import.errors.idInvalid',
        'Use lowercase letters, numbers, dots, hyphens and underscores only.'
      ),
      exists: t('admin.models.import.errors.idExists', 'A model with this ID already exists.'),
      duplicate: t(
        'admin.models.import.errors.idDuplicate',
        'Two selected models would get this ID.'
      )
    })[problem];

  const runImport = async () => {
    if (selectedModels.length === 0 || hasProblems) return;
    setImporting(true);
    setImportError(null);

    if (providerChoice === NEW_PROVIDER && !createdProviderId) {
      try {
        await makeAdminApiCall('/admin/providers', {
          method: 'POST',
          body: buildNewProviderConfig({
            ...newProvider,
            baseUrl: discovery.baseUrl
          })
        });
        setCreatedProviderId(newProvider.id);
      } catch (err) {
        setImportError(
          t(
            'admin.models.import.errors.providerCreateFailed',
            'Could not create the provider: {{error}}',
            {
              error: getAdminApiErrorMessage(err)
            }
          )
        );
        setImporting(false);
        return;
      }
    }

    const outcome = [];
    for (const model of selectedModels) {
      const id = targetIdOf(model);
      try {
        await makeAdminApiCall('/admin/models', {
          method: 'POST',
          body: buildImportedModelConfig(model, {
            id,
            apiType: discovery.apiType,
            providerId: targetProviderId,
            modelsUrl: discovery.modelsUrl,
            enabled: enableModels
          })
        });
        outcome.push({ id, remoteId: model.id, ok: true });
      } catch (err) {
        outcome.push({ id, remoteId: model.id, ok: false, error: getAdminApiErrorMessage(err) });
      }
    }
    setResults(outcome);
    setImporting(false);
    setStep('done');
    onImported?.();
  };

  const providerDisplayName =
    providerChoice === NEW_PROVIDER
      ? newProvider.name
      : getLocalizedContent(existingProvider?.name, lang) || providerChoice;

  const renderConnect = () => (
    <form onSubmit={discover} className="space-y-4">
      {providersError && <p className="text-sm text-red-600 dark:text-red-400">{providersError}</p>}
      <div>
        <label htmlFor="import-provider" className={LABEL}>
          {t('admin.models.import.provider', 'Provider')}
        </label>
        <select
          id="import-provider"
          value={providerChoice}
          onChange={e => chooseProvider(e.target.value)}
          className={FIELD}
        >
          <option value={NEW_PROVIDER}>
            {t('admin.models.import.newProvider', '+ New provider')}
          </option>
          {importableProviders.map(p => (
            <option key={p.id} value={p.id}>
              {getLocalizedContent(p.name, lang) || p.id} — {apiTypeLabel(t, getProviderApiType(p))}
            </option>
          ))}
        </select>
        <p className={HINT}>
          {t(
            'admin.models.import.providerHint',
            'The provider holds the API key for all imported models. Create one for a new endpoint, such as T-Systems LLM Hub.'
          )}
        </p>
      </div>

      {providerChoice === NEW_PROVIDER ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 rounded-md border border-gray-200 dark:border-gray-700 p-4">
          <div>
            <label htmlFor="import-provider-name" className={LABEL}>
              {t('admin.providers.fields.name', 'Name')} <span className="text-red-500">*</span>
            </label>
            <input
              id="import-provider-name"
              type="text"
              value={newProvider.name}
              onChange={e => updateNewProvider('name', e.target.value)}
              placeholder="T-Systems LLM Hub"
              className={FIELD}
            />
          </div>
          <div>
            <label htmlFor="import-provider-id" className={LABEL}>
              {t('admin.providers.fields.id', 'ID')} <span className="text-red-500">*</span>
            </label>
            <input
              id="import-provider-id"
              type="text"
              value={newProvider.id}
              onChange={e => updateNewProvider('id', e.target.value)}
              placeholder="t-systems-llm-hub"
              className={FIELD}
            />
            {newProviderIdProblem && (
              <p className="mt-1 text-xs text-red-600 dark:text-red-400">{newProviderIdProblem}</p>
            )}
          </div>
          <div className="sm:col-span-2">
            <label htmlFor="import-provider-description" className={LABEL}>
              {t('admin.providers.fields.description', 'Description')}
            </label>
            <input
              id="import-provider-description"
              type="text"
              value={newProvider.description}
              onChange={e => updateNewProvider('description', e.target.value)}
              className={FIELD}
            />
          </div>
          <div className="sm:col-span-2">
            <label htmlFor="import-provider-api-type" className={LABEL}>
              {t('admin.providers.fields.apiType', 'API type')}
            </label>
            <select
              id="import-provider-api-type"
              value={newProvider.apiType}
              onChange={e => updateNewProvider('apiType', e.target.value)}
              className={FIELD}
            >
              {CUSTOM_PROVIDER_API_TYPES.map(type => (
                <option key={type} value={type}>
                  {apiTypeLabel(t, type)}
                </option>
              ))}
            </select>
            <p className={HINT}>
              {t(
                'admin.providers.hints.apiType',
                'Which API the endpoint speaks. Gateways such as T-Systems LLM Hub are OpenAI-compatible; choose vLLM for a self-hosted vLLM server.'
              )}
            </p>
          </div>
        </div>
      ) : (
        existingProvider && (
          <div className="rounded-md bg-gray-50 dark:bg-gray-900/40 p-3 text-sm text-gray-700 dark:text-gray-300">
            <div>
              {t('admin.providers.fields.apiType', 'API type')}:{' '}
              <span className="font-medium">{apiTypeLabel(t, apiType)}</span>
            </div>
            <div className="mt-1">
              {existingProvider.apiKeySet
                ? t(
                    'admin.models.import.usesProviderKey',
                    'The API key stored on this provider is used.'
                  )
                : t(
                    'admin.models.import.noProviderKey',
                    'No API key is stored on this provider: its environment variable is used if set, otherwise the endpoint is called without a key.'
                  )}
            </div>
          </div>
        )
      )}

      <div>
        <label htmlFor="import-url" className={LABEL}>
          {t('admin.models.import.url', 'Endpoint URL')} <span className="text-red-500">*</span>
        </label>
        <input
          id="import-url"
          type="url"
          value={url}
          onChange={e => setUrl(e.target.value)}
          placeholder="https://llm-server.llmhub.t-systems.net/v2"
          className={FIELD}
        />
        <p className={HINT}>
          {t(
            'admin.models.import.urlHint',
            'The API base (…/v1), its /models listing or a chat completions URL. iHub reads the model list from /models.'
          )}
        </p>
      </div>

      {providerChoice === NEW_PROVIDER && (
        <div>
          <label htmlFor="import-api-key" className={LABEL}>
            {t('admin.models.import.apiKey', 'API key')}
          </label>
          <input
            id="import-api-key"
            type="password"
            autoComplete="off"
            value={newProvider.apiKey}
            onChange={e => updateNewProvider('apiKey', e.target.value)}
            className={FIELD}
          />
          <p className={HINT}>
            {t(
              'admin.models.import.apiKeyHint',
              'Optional. Stored encrypted on the new provider, not on the models. Leave empty for endpoints without authentication, such as a local vLLM server.'
            )}
          </p>
        </div>
      )}

      {discoveryError && (
        <div className="rounded-md border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/30 p-3">
          <p className="text-sm font-medium text-red-800 dark:text-red-300">
            {discoveryError.message}
          </p>
          {discoveryError.details && (
            <p className="mt-1 text-sm text-red-700 dark:text-red-400">{discoveryError.details}</p>
          )}
        </div>
      )}
      <button type="submit" className="hidden" aria-hidden="true" tabIndex={-1} />
    </form>
  );

  const renderSelect = () => (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-gray-600 dark:text-gray-400">
        <span>
          {t('admin.models.import.found', '{{count}} models at {{url}}', {
            count: models.length,
            url: discovery.modelsUrl
          })}
        </span>
        <button
          type="button"
          onClick={() => setStep('connect')}
          className="text-indigo-600 dark:text-indigo-400 hover:underline"
        >
          {t('admin.models.import.changeConnection', 'Change endpoint')}
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="sm:col-span-1">
          <label htmlFor="import-search" className={LABEL}>
            {t('common.search', 'Search')}
          </label>
          <input
            id="import-search"
            type="search"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className={FIELD}
          />
        </div>
        <div>
          <label htmlFor="import-prefix" className={LABEL}>
            {t('admin.models.import.idPrefix', 'ID prefix')}
          </label>
          <input
            id="import-prefix"
            type="text"
            value={prefix}
            onChange={e => setPrefix(e.target.value)}
            placeholder="llmhub-"
            className={FIELD}
          />
        </div>
        <label className="flex items-end gap-2 pb-2 text-sm text-gray-700 dark:text-gray-300">
          <input
            type="checkbox"
            checked={enableModels}
            onChange={e => setEnableModels(e.target.checked)}
            className="h-4 w-4 rounded-sm border-gray-300 text-indigo-600"
          />
          {t('admin.models.import.enableModels', 'Enable imported models')}
        </label>
      </div>

      {models.length === 0 ? (
        <p className="py-8 text-center text-sm text-gray-500 dark:text-gray-400">
          {t('admin.models.import.noModels', 'The endpoint lists no models.')}
        </p>
      ) : (
        <div className="rounded-md border border-gray-200 dark:border-gray-700 overflow-hidden">
          <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700 text-sm">
            <thead className="bg-gray-50 dark:bg-gray-900">
              <tr>
                <th className="px-3 py-2 w-8">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleAll}
                    aria-label={t('admin.models.import.selectAll', 'Select all chat models')}
                    className="h-4 w-4 rounded-sm border-gray-300 text-indigo-600"
                  />
                </th>
                <th className="px-3 py-2 text-left font-medium text-gray-500 dark:text-gray-400">
                  {t('admin.models.import.model', 'Model')}
                </th>
                <th className="px-3 py-2 text-left font-medium text-gray-500 dark:text-gray-400 hidden sm:table-cell">
                  {t('admin.models.import.context', 'Context')}
                </th>
                <th className="px-3 py-2 text-left font-medium text-gray-500 dark:text-gray-400">
                  {t('admin.models.import.targetId', 'iHub model ID')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {visibleModels.map(model => {
                const checked = Boolean(selected[model.id]);
                const problem = checked ? idProblems[model.id] : null;
                return (
                  <tr
                    key={model.id}
                    className={checked ? 'bg-indigo-50/50 dark:bg-indigo-900/10' : ''}
                  >
                    <td className="px-3 py-2 align-top">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={e =>
                          setSelected(prev => ({ ...prev, [model.id]: e.target.checked }))
                        }
                        aria-label={model.name}
                        className="mt-1 h-4 w-4 rounded-sm border-gray-300 text-indigo-600"
                      />
                    </td>
                    <td className="px-3 py-2 align-top">
                      <div className="font-medium text-gray-900 dark:text-gray-100">
                        {model.name}
                      </div>
                      <div className="text-xs text-gray-500 dark:text-gray-400 break-all">
                        {model.id}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {model.type !== 'chat' && (
                          <span
                            className={`${BADGE} bg-amber-100 dark:bg-amber-900/50 text-amber-800 dark:text-amber-300`}
                          >
                            {typeLabel(t, model.type)}
                          </span>
                        )}
                        {model.supportsVision && (
                          <span
                            className={`${BADGE} bg-blue-100 dark:bg-blue-900/50 text-blue-800 dark:text-blue-300`}
                          >
                            {t('admin.models.import.vision', 'Vision')}
                          </span>
                        )}
                        {model.existingModelId && (
                          <span
                            className={`${BADGE} bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300`}
                          >
                            {t('admin.models.import.alreadyAdded', 'Already added as {{id}}', {
                              id: model.existingModelId
                            })}
                          </span>
                        )}
                        {model.endOfLife && (
                          <span
                            className={`${BADGE} bg-red-100 dark:bg-red-900/50 text-red-800 dark:text-red-300`}
                          >
                            {t('admin.models.import.endOfLife', 'End of life: {{date}}', {
                              date: model.endOfLife.slice(0, 10)
                            })}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2 align-top text-gray-700 dark:text-gray-300 hidden sm:table-cell">
                      {formatTokens(model.contextWindow)}
                    </td>
                    <td className="px-3 py-2 align-top">
                      <input
                        type="text"
                        value={targetIdOf(model)}
                        onChange={e =>
                          setEditedIds(prev => ({ ...prev, [model.id]: e.target.value }))
                        }
                        disabled={!checked}
                        aria-label={t(
                          'admin.models.import.targetIdFor',
                          'iHub model ID for {{name}}',
                          {
                            name: model.name
                          }
                        )}
                        className={`${FIELD} mt-0 disabled:opacity-60 ${problem ? 'border-red-400' : ''}`}
                      />
                      {problem && (
                        <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                          {problemText(problem)}
                        </p>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {importError && <p className="text-sm text-red-600 dark:text-red-400">{importError}</p>}
    </div>
  );

  const renderDone = () => {
    const ok = results.filter(r => r.ok);
    const failed = results.filter(r => !r.ok);
    return (
      <div className="space-y-4">
        <div className="flex items-start gap-3">
          <Icon
            name={failed.length === 0 ? 'check-circle' : 'exclamation-triangle'}
            className={`h-6 w-6 shrink-0 ${failed.length === 0 ? 'text-green-500' : 'text-amber-500'}`}
          />
          <div className="text-sm text-gray-700 dark:text-gray-300">
            <p className="font-medium text-gray-900 dark:text-gray-100">
              {t(
                'admin.models.import.doneSummary',
                'Imported {{ok}} of {{total}} models into {{provider}}.',
                {
                  ok: ok.length,
                  total: results.length,
                  provider: providerDisplayName
                }
              )}
            </p>
            {createdProviderId && (
              <p className="mt-1">
                {t(
                  'admin.models.import.providerCreated',
                  'The provider "{{provider}}" was created and holds the API key. Manage it under Providers.',
                  { provider: providerDisplayName }
                )}
              </p>
            )}
            <p className="mt-1">
              {t(
                'admin.models.import.testHint',
                'Use "Test" in the model list to check each model, and fill in details the endpoint did not report, such as tool support.'
              )}
            </p>
          </div>
        </div>
        {failed.length > 0 && (
          <ul className="space-y-1 text-sm">
            {failed.map(r => (
              <li
                key={r.id}
                className="rounded-md bg-red-50 dark:bg-red-900/20 p-2 text-red-700 dark:text-red-300"
              >
                <span className="font-medium">{r.id}</span>: {r.error}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  };

  return (
    <Modal isOpen onClose={onClose} maxWidthClassName="max-w-4xl" closeOnBackdropClick={false}>
      <div className="flex items-start justify-between border-b border-gray-200 dark:border-gray-700 px-6 py-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {t('admin.models.import.title', 'Import models from URL')}
          </h2>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            {t(
              'admin.models.import.subtitle',
              'Read the model list of an OpenAI-compatible, vLLM, Mistral, Anthropic or Google endpoint and add the models you pick.'
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('common.close', 'Close')}
          className="ml-4 p-1 rounded-md text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
        >
          <Icon name="x" className="h-5 w-5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        {step === 'connect' && renderConnect()}
        {step === 'select' && discovery && renderSelect()}
        {step === 'done' && renderDone()}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-gray-200 dark:border-gray-700 px-6 py-3">
        {step === 'done' ? (
          <button type="button" className={PRIMARY_BUTTON} onClick={onClose}>
            {t('common.close', 'Close')}
          </button>
        ) : (
          <>
            <button type="button" className={SECONDARY_BUTTON} onClick={onClose}>
              {t('common.cancel', 'Cancel')}
            </button>
            {step === 'connect' ? (
              <button
                type="button"
                className={PRIMARY_BUTTON}
                onClick={discover}
                disabled={!canDiscover}
              >
                <Icon
                  name={discovering ? 'refresh' : 'search'}
                  className={`h-4 w-4 mr-2 ${discovering ? 'animate-spin' : ''}`}
                />
                {discovering
                  ? t('admin.models.import.loading', 'Loading models…')
                  : t('admin.models.import.loadModels', 'Load models')}
              </button>
            ) : (
              <button
                type="button"
                className={PRIMARY_BUTTON}
                onClick={runImport}
                disabled={importing || selectedModels.length === 0 || hasProblems}
              >
                <Icon
                  name={importing ? 'refresh' : 'download'}
                  className={`h-4 w-4 mr-2 ${importing ? 'animate-spin' : ''}`}
                />
                {importing
                  ? t('admin.models.import.importing', 'Importing…')
                  : t('admin.models.import.importCount', 'Import {{count}} models', {
                      count: selectedModels.length
                    })}
              </button>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

export default ModelImportDialog;
