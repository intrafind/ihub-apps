// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState, useEffect, Fragment } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../../../utils/localizeContent';
import Icon from '../../../shared/components/Icon';
import { useFeatureFlags } from '../../../shared/hooks/useFeatureFlags';
import { getAdminApiErrorMessage, makeAdminApiCall } from '../../../api/adminApi';
import AdminPageSkeleton from '../components/AdminPageSkeleton';
import AdminEmptyState from '../components/AdminEmptyState';
import ApiKeyStatusBadge from '../components/ApiKeyStatusBadge';
import useApiKeyStatus from '../hooks/useApiKeyStatus';
import { translateModelTestMessage } from '../utils/modelTestMessages';
import { apiTypeLabel } from '../utils/modelImport';
import {
  BUILT_IN_LLM_PROVIDERS,
  CUSTOM_PROVIDER_API_TYPES,
  getModelProviderId,
  getProviderApiType
} from '../../../../../shared/llmProviders.js';
import AdminLoadError from '../components/AdminLoadError';
import LlmTimeoutsCard from '../components/LlmTimeoutsCard';
import ModelsTabsHeader from '../components/ModelsTabsHeader';
import useAdminPageAccess from '../hooks/useAdminPageAccess';
import { isLlmProviderEntry } from '../utils/modelsArea';

/** Linked model names shown in the list before "+N more". */
const LINKED_MODEL_PREVIEW = 3;

function HealthBadge({ status }) {
  const { t } = useTranslation();

  if (!status || status === 'idle') {
    return (
      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
        {t('admin.providers.health.notTested', 'Not tested')}
      </span>
    );
  }

  const configs = {
    testing: {
      bg: 'bg-blue-100 dark:bg-blue-900',
      text: 'text-blue-800 dark:text-blue-200',
      label: t('admin.providers.health.testing', 'Testing...'),
      spinning: true
    },
    ok: {
      bg: 'bg-green-100 dark:bg-green-900',
      text: 'text-green-800 dark:text-green-200',
      label: t('admin.providers.health.allOk', 'All OK')
    },
    partial: {
      bg: 'bg-yellow-100 dark:bg-yellow-900',
      text: 'text-yellow-800 dark:text-yellow-200',
      label: t('admin.providers.health.partial', 'Partial')
    },
    error: {
      bg: 'bg-red-100 dark:bg-red-900',
      text: 'text-red-800 dark:text-red-200',
      label: t('admin.providers.health.failed', 'Failed')
    },
    // A provider refusing this server's IP is not a failed configuration, and
    // labelling it "Failed" sends the admin looking for a setting to fix. It
    // gets its own state so the row agrees with the diagnosis panel below it.
    blocked: {
      bg: 'bg-orange-100 dark:bg-orange-900',
      text: 'text-orange-800 dark:text-orange-200',
      label: t('admin.providers.health.blocked', 'Blocked')
    }
  };

  const config = configs[status] || configs.error;

  return (
    <span
      className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium ${config.bg} ${config.text}`}
    >
      {config.spinning && (
        <span className="animate-spin rounded-full h-3 w-3 border-b-2 border-current inline-block" />
      )}
      {config.label}
    </span>
  );
}

/**
 * The provider's model count as a link to the Models tab filtered to it, or plain text when the
 * admin may not open the models page.
 */
function ModelsLink({ enabled, providerId, children, ...rest }) {
  if (!enabled) return <div {...rest}>{children}</div>;
  return (
    <Link
      to={`/admin/models?provider=${encodeURIComponent(providerId)}`}
      onClick={e => e.stopPropagation()}
      {...rest}
    >
      {children}
    </Link>
  );
}

/**
 * One group of provider entries. Model providers are the page; entries of any other
 * category (left from before web search, storage and tools became integrations) stay
 * reachable under a collapsed heading instead of vanishing.
 */
function CategorySection({ isLlm, title, count, children }) {
  if (isLlm) {
    return (
      <div>
        <h2 className="sr-only">{title}</h2>
        {children}
      </div>
    );
  }
  return (
    <details className="group">
      <summary className="cursor-pointer text-sm font-medium text-gray-700 dark:text-gray-300 mb-3 px-2 py-1 rounded-sm focus:outline-hidden focus:ring-2 focus:ring-indigo-500">
        {title} ({count})
      </summary>
      <div className="mt-3">{children}</div>
    </details>
  );
}

function AdminProvidersPage() {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const navigate = useNavigate();
  const featureFlags = useFeatureFlags();
  // The models page may be hidden (admin.pages.models): then its links are not offered.
  const access = useAdminPageAccess();
  const { statuses: keyStatuses } = useApiKeyStatus('providers');
  const [providers, setProviders] = useState([]);
  const [models, setModels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  // healthStatus[providerId] = { status: 'idle'|'testing'|'ok'|'partial'|'error', results: [], expanded: false }
  const [healthStatus, setHealthStatus] = useState({});
  const [testingAll, setTestingAll] = useState(false);

  const loadData = async () => {
    try {
      setLoading(true);
      setError(null);
      const [providersResponse, modelsResponse] = await Promise.all([
        makeAdminApiCall('/admin/providers'),
        makeAdminApiCall('/admin/models').catch(() => ({ data: [] }))
      ]);

      const providersArray = Array.isArray(providersResponse.data) ? providersResponse.data : [];
      const modelsArray = Array.isArray(modelsResponse.data) ? modelsResponse.data : [];
      setProviders(providersArray);
      setModels(modelsArray);

      if (providersArray.length === 0) {
        console.warn('No providers returned from API');
      }
    } catch (err) {
      console.error('Error loading data:', err);
      setError(getAdminApiErrorMessage(err));
      setProviders([]);
      setModels([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, []);

  // Group models by the provider entry they take their key from: `providerId`
  // for a model linked to a custom provider, else its `provider`.
  const linkedModelsByProvider = models.reduce((acc, model) => {
    const provider = getModelProviderId(model) || 'unknown';
    if (!acc[provider]) acc[provider] = [];
    acc[provider].push(model);
    return acc;
  }, {});
  const enabledModelsByProvider = Object.fromEntries(
    Object.entries(linkedModelsByProvider).map(([id, list]) => [id, list.filter(m => m.enabled)])
  );

  const testProvider = async providerId => {
    const providerModels = enabledModelsByProvider[providerId] || [];
    if (providerModels.length === 0) return;

    setHealthStatus(prev => ({
      ...prev,
      [providerId]: { status: 'testing', results: [], expanded: true }
    }));

    // The model test endpoint maps a provider rejecting the server's key onto
    // 502 (not 401), so the shared admin client is safe here: a 401 really is
    // an expired admin session and must go through the global
    // re-authentication flow.
    const results = [];
    for (const model of providerModels) {
      try {
        const response = await makeAdminApiCall(`/admin/models/${model.id}/test`, {
          method: 'POST'
        });
        const data = response?.data || {};
        const successFallback =
          data?.message || t('admin.providers.health.testSuccessful', 'Test successful');
        results.push({
          model,
          success: true,
          message: translateModelTestMessage(t, data?.messageKey, successFallback),
          response: data?.response
        });
      } catch (err) {
        // Server body: { error: headline, details: remediation text, code, messageKey }
        const body = err?.response?.data || {};
        const failureFallback = body.error || t('admin.providers.health.testFailed', 'Test failed');
        results.push({
          model,
          success: false,
          message: translateModelTestMessage(t, body.messageKey, failureFallback),
          error:
            body.details || (err?.response?.status ? `HTTP ${err.response.status}` : err.message)
        });
      }
      // Update incrementally so user sees progress
      setHealthStatus(prev => ({
        ...prev,
        [providerId]: { ...prev[providerId], results: [...results] }
      }));
    }

    const successCount = results.filter(r => r.success).length;
    const finalStatus =
      results.length === 0
        ? 'idle'
        : successCount === results.length
          ? 'ok'
          : successCount > 0
            ? 'partial'
            : 'error';

    setHealthStatus(prev => ({
      ...prev,
      [providerId]: { status: finalStatus, results, expanded: true }
    }));
  };

  const testAllProviders = async () => {
    setTestingAll(true);
    const llmProviders = providers.filter(
      p => (p.category === 'llm' || !p.category) && (enabledModelsByProvider[p.id] || []).length > 0
    );
    for (const provider of llmProviders) {
      await testProvider(provider.id);
    }
    setTestingAll(false);
  };

  const toggleExpanded = providerId => {
    setHealthStatus(prev => ({
      ...prev,
      [providerId]: {
        ...prev[providerId],
        expanded: !prev[providerId]?.expanded
      }
    }));
  };

  const editProvider = providerId => {
    navigate(`/admin/providers/${providerId}`);
  };

  const createProvider = () => {
    navigate('/admin/providers/new');
  };

  const deleteProvider = async (providerId, providerName) => {
    if (
      !confirm(
        t('admin.providers.deleteConfirm', 'Delete provider "{{name}}"?', { name: providerName })
      )
    ) {
      return;
    }

    try {
      await makeAdminApiCall(`/admin/providers/${providerId}`, {
        method: 'DELETE'
      });
      await loadData();
    } catch (err) {
      console.error('Error deleting provider:', err);
      setError(getAdminApiErrorMessage(err));
    }
  };

  // Filter providers based on search term
  const filteredProviders = providers.filter(provider => {
    const name = getLocalizedContent(provider.name, currentLanguage).toLowerCase();
    const description = getLocalizedContent(provider.description, currentLanguage).toLowerCase();
    const search = searchTerm.toLowerCase();
    return name.includes(search) || description.includes(search) || provider.id.includes(search);
  });

  // Group providers by category
  const groupedProviders = filteredProviders.reduce((acc, provider) => {
    const category = isLlmProviderEntry(provider) ? 'llm' : 'other';
    if (!acc[category]) {
      acc[category] = [];
    }
    acc[category].push(provider);
    return acc;
  }, {});

  // Model providers are the page; entries of any other category (left over from before web search,
  // storage and tools became integrations) sit in a collapsed group below.
  const categoryOrder = ['llm', 'other'];
  const categoryLabels = {
    llm: t('admin.providers.category.llm', 'LLM Providers'),
    other: t('admin.providers.category.other', 'Other credentials')
  };

  // Count how many LLM providers have enabled models (for "Test All" button visibility)
  const testableProviderCount = providers.filter(
    p => (p.category === 'llm' || !p.category) && (enabledModelsByProvider[p.id] || []).length > 0
  ).length;

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <ModelsTabsHeader
          modelCount={loading ? undefined : models.length}
          providerCount={loading ? undefined : providers.length}
          actions={
            <>
              {testableProviderCount > 0 && (
                <button
                  onClick={testAllProviders}
                  disabled={testingAll}
                  className="px-4 py-2 bg-green-700 text-white rounded-lg hover:bg-green-800 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {testingAll ? (
                    <span className="animate-spin rounded-full h-4 w-4 border-b-2 border-white inline-block" />
                  ) : (
                    <Icon name="SignalIcon" className="w-5 h-5" />
                  )}
                  {t('admin.providers.testAll', 'Test All')}
                </button>
              )}
              <button
                onClick={createProvider}
                className="inline-flex items-center justify-center rounded-md border border-transparent bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-xs hover:bg-indigo-700 focus:outline-hidden focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
              >
                <Icon name="plus" className="h-4 w-4 mr-2" />
                {t('admin.providers.add', 'Add provider')}
              </button>
            </>
          }
        />

        <div role="tabpanel" id="tabpanel-providers" aria-labelledby="tab-providers">
          {/* Error Display */}
          {error && (
            <AdminLoadError message={error} framed={false} className="mb-6" action={null} />
          )}

          {/* Search and Actions Bar */}
          <div className="mb-6 flex flex-col sm:flex-row gap-4">
            <div className="flex-1">
              <div className="relative">
                <Icon
                  name="MagnifyingGlassIcon"
                  className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-gray-500"
                />
                <input
                  type="text"
                  placeholder={t('admin.providers.search', 'Search providers...')}
                  value={searchTerm}
                  onChange={e => setSearchTerm(e.target.value)}
                  className="pl-10 w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
                />
              </div>
            </div>
          </div>

          {/* Installation-wide LLM timeouts (providers and models can override them) */}
          <LlmTimeoutsCard />

          {/* Providers List - Grouped by Category */}
          {loading ? (
            <AdminPageSkeleton rows={5} />
          ) : (
            <div className="space-y-6">
              {categoryOrder.map(category => {
                const categoryProviders = groupedProviders[category] || [];
                if (categoryProviders.length === 0) return null;
                const isLlm = category === 'llm';
                const hasConnectivity = isLlm;

                return (
                  <CategorySection
                    key={category}
                    isLlm={isLlm}
                    title={categoryLabels[category]}
                    count={categoryProviders.length}
                  >
                    <div className="bg-white dark:bg-gray-800 shadow-sm rounded-lg overflow-x-auto">
                      <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                        <thead className="bg-gray-50 dark:bg-gray-900">
                          <tr>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                              {t('admin.providers.table.provider', 'Provider')}
                            </th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                              {t('admin.providers.table.apiKey', 'API Key')}
                            </th>
                            {isLlm && (
                              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                                {t('admin.providers.table.models', 'Models')}
                              </th>
                            )}
                            {hasConnectivity && (
                              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                                {t('admin.providers.table.connectivity', 'Connectivity')}
                              </th>
                            )}
                            <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                              {t('admin.providers.table.actions', 'Actions')}
                            </th>
                          </tr>
                        </thead>
                        <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                          {categoryProviders.map(provider => {
                            const providerHealth = healthStatus[provider.id] || {};
                            const enabledModels = enabledModelsByProvider[provider.id] || [];
                            const linkedModels = linkedModelsByProvider[provider.id] || [];
                            const isExpanded = providerHealth.expanded;
                            const hasResults =
                              providerHealth.results && providerHealth.results.length > 0;
                            const colSpan = isLlm ? 5 : 3;

                            return (
                              <Fragment key={provider.id}>
                                <tr
                                  className="hover:bg-gray-50 dark:hover:bg-gray-700 cursor-pointer"
                                  onClick={() => editProvider(provider.id)}
                                >
                                  <td className="px-6 py-4">
                                    <div className="flex items-center">
                                      <div>
                                        <div
                                          className="text-sm font-medium text-gray-900 dark:text-white"
                                          title={
                                            getLocalizedContent(
                                              provider.description,
                                              currentLanguage
                                            ) || undefined
                                          }
                                        >
                                          {getLocalizedContent(provider.name, currentLanguage)}
                                          {provider.enabled === false && (
                                            <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-300">
                                              {t('admin.providers.disabled', 'Disabled')}
                                            </span>
                                          )}
                                          {(Number.isFinite(provider.connectTimeoutMs) ||
                                            Number.isFinite(provider.streamIdleTimeoutMs)) && (
                                            <span
                                              className="ml-1.5 text-xs font-normal text-gray-500 dark:text-gray-400"
                                              title={t(
                                                'admin.providers.ownTimeouts',
                                                'Sets its own timeouts'
                                              )}
                                            >
                                              <span aria-hidden="true">⏱</span>
                                              <span className="sr-only">
                                                {t(
                                                  'admin.providers.ownTimeouts',
                                                  'Sets its own timeouts'
                                                )}
                                              </span>
                                            </span>
                                          )}
                                        </div>
                                        <div className="text-sm text-gray-500 dark:text-gray-400">
                                          {provider.id}
                                          {isLlm && getProviderApiType(provider) && (
                                            <span className="ml-1 text-xs">
                                              · {apiTypeLabel(t, getProviderApiType(provider))}
                                            </span>
                                          )}
                                        </div>
                                      </div>
                                    </div>
                                  </td>
                                  <td className="px-6 py-4 whitespace-nowrap">
                                    {provider.requiresApiKey === false ? (
                                      // Keyless provider (e.g. Qwant): "Not Configured" would
                                      // read as broken when there is nothing to configure.
                                      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200">
                                        {t(
                                          'admin.providers.noApiKeyRequired',
                                          'No API key required'
                                        )}
                                      </span>
                                    ) : isLlm && keyStatuses[provider.id] ? (
                                      // The server's verdict: a stored key it cannot decrypt
                                      // looks "Configured" below but does not work.
                                      <ApiKeyStatusBadge status={keyStatuses[provider.id]} />
                                    ) : provider.apiKeySet ? (
                                      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-200">
                                        <Icon name="KeyIcon" className="w-3 h-3 mr-1" />
                                        {t('admin.providers.configured', 'Configured')}
                                      </span>
                                    ) : (
                                      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-300">
                                        <Icon
                                          name="ExclamationTriangleIcon"
                                          className="w-3 h-3 mr-1"
                                        />
                                        {t('admin.providers.notConfigured', 'Not Configured')}
                                      </span>
                                    )}
                                  </td>
                                  {isLlm && (
                                    <td className="px-6 py-4">
                                      {linkedModels.length > 0 ? (
                                        <ModelsLink
                                          enabled={access.models}
                                          providerId={provider.id}
                                          className="block rounded-sm text-sm text-gray-700 dark:text-gray-300 hover:text-indigo-700 dark:hover:text-indigo-300 focus:outline-hidden focus:ring-2 focus:ring-indigo-500"
                                          title={linkedModels.map(m => m.id).join('\n')}
                                        >
                                          <div className="font-medium whitespace-nowrap">
                                            {t(
                                              'admin.providers.linkedModels.count',
                                              '{{count}} linked, {{enabled}} enabled',
                                              {
                                                count: linkedModels.length,
                                                enabled: enabledModels.length
                                              }
                                            )}
                                          </div>
                                          <div className="text-xs text-gray-500 dark:text-gray-400 max-w-56 truncate">
                                            {linkedModels
                                              .slice(0, LINKED_MODEL_PREVIEW)
                                              .map(m =>
                                                getLocalizedContent(m.name, currentLanguage)
                                              )
                                              .join(', ')}
                                            {linkedModels.length > LINKED_MODEL_PREVIEW &&
                                              ` ${t(
                                                'admin.providers.linkedModels.more',
                                                '+{{count}} more',
                                                {
                                                  count: linkedModels.length - LINKED_MODEL_PREVIEW
                                                }
                                              )}`}
                                          </div>
                                        </ModelsLink>
                                      ) : (
                                        <span className="text-sm text-gray-500 dark:text-gray-400">
                                          —
                                        </span>
                                      )}
                                    </td>
                                  )}
                                  {hasConnectivity && (
                                    <td className="px-6 py-4 whitespace-nowrap">
                                      <div className="flex items-center gap-2">
                                        <HealthBadge status={providerHealth.status || 'idle'} />
                                        {hasResults && (
                                          <button
                                            onClick={e => {
                                              e.stopPropagation();
                                              toggleExpanded(provider.id);
                                            }}
                                            className="text-gray-500 hover:text-gray-600 dark:hover:text-gray-200"
                                            title={
                                              isExpanded
                                                ? t(
                                                    'admin.providers.health.hideResults',
                                                    'Hide results'
                                                  )
                                                : t(
                                                    'admin.providers.health.showResults',
                                                    'Show results'
                                                  )
                                            }
                                          >
                                            <Icon
                                              name={
                                                isExpanded ? 'ChevronUpIcon' : 'ChevronDownIcon'
                                              }
                                              className="w-4 h-4"
                                            />
                                          </button>
                                        )}
                                      </div>
                                    </td>
                                  )}
                                  <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                                    <div className="flex flex-wrap justify-end gap-x-3 gap-y-1">
                                      {isLlm && enabledModels.length > 0 && (
                                        <button
                                          onClick={e => {
                                            e.stopPropagation();
                                            void testProvider(provider.id);
                                          }}
                                          disabled={
                                            providerHealth.status === 'testing' || testingAll
                                          }
                                          className="text-green-700 hover:text-green-900 dark:text-green-400 dark:hover:text-green-300 disabled:opacity-50 disabled:cursor-not-allowed"
                                        >
                                          {t('admin.providers.test', 'Test')}
                                        </button>
                                      )}
                                      {isLlm &&
                                        access.models &&
                                        CUSTOM_PROVIDER_API_TYPES.includes(
                                          getProviderApiType(provider)
                                        ) && (
                                          <button
                                            onClick={e => {
                                              e.stopPropagation();
                                              navigate('/admin/models', {
                                                state: { importProviderId: provider.id }
                                              });
                                            }}
                                            className="text-indigo-600 hover:text-indigo-900 dark:text-indigo-400 dark:hover:text-indigo-300"
                                          >
                                            {t('admin.providers.import', 'Import models')}
                                          </button>
                                        )}
                                      <button
                                        onClick={e => {
                                          e.stopPropagation();
                                          editProvider(provider.id);
                                        }}
                                        className="text-blue-600 hover:text-blue-900 dark:text-blue-400 dark:hover:text-blue-300"
                                      >
                                        {t('admin.providers.configure', 'Configure')}
                                      </button>
                                      {provider.category &&
                                        !BUILT_IN_LLM_PROVIDERS.includes(provider.id) && (
                                          <button
                                            onClick={e => {
                                              e.stopPropagation();
                                              void deleteProvider(
                                                provider.id,
                                                getLocalizedContent(provider.name, currentLanguage)
                                              );
                                            }}
                                            className="text-red-600 hover:text-red-900 dark:text-red-400 dark:hover:text-red-300"
                                          >
                                            {t('admin.providers.delete', 'Delete')}
                                          </button>
                                        )}
                                    </div>
                                  </td>
                                </tr>
                                {/* Expandable model test results row */}
                                {isLlm && isExpanded && hasResults && (
                                  <tr>
                                    <td
                                      colSpan={colSpan}
                                      className="px-6 py-3 bg-gray-50 dark:bg-gray-900/50"
                                    >
                                      <div className="space-y-1.5">
                                        <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">
                                          {t('admin.providers.modelResults', 'Model Test Results')}
                                        </p>
                                        {providerHealth.results.map((result, idx) => (
                                          <div
                                            key={idx}
                                            className={`flex items-start gap-3 p-2 rounded text-sm ${
                                              result.success
                                                ? 'bg-green-50 dark:bg-green-900/20'
                                                : 'bg-red-50 dark:bg-red-900/20'
                                            }`}
                                          >
                                            <Icon
                                              name={
                                                result.success ? 'CheckCircleIcon' : 'XCircleIcon'
                                              }
                                              className={`w-4 h-4 mt-0.5 shrink-0 ${
                                                result.success
                                                  ? 'text-green-700 dark:text-green-400'
                                                  : 'text-red-600 dark:text-red-400'
                                              }`}
                                            />
                                            <div className="min-w-0 flex-1">
                                              <span className="font-medium text-gray-900 dark:text-white">
                                                {getLocalizedContent(
                                                  result.model.name,
                                                  currentLanguage
                                                )}
                                              </span>
                                              <span className="text-gray-500 dark:text-gray-400 ml-1 text-xs">
                                                ({result.model.id})
                                              </span>
                                              {result.error && (
                                                <p className="text-xs text-red-600 dark:text-red-400 mt-0.5">
                                                  {result.error}
                                                </p>
                                              )}
                                            </div>
                                            <span
                                              className={`text-xs whitespace-nowrap ${
                                                result.success
                                                  ? 'text-green-700 dark:text-green-300'
                                                  : 'text-red-700 dark:text-red-300'
                                              }`}
                                            >
                                              {result.message}
                                            </span>
                                          </div>
                                        ))}
                                        {/* Show spinner for models still being tested */}
                                        {providerHealth.status === 'testing' && (
                                          <div className="flex items-center gap-2 p-2 text-sm text-gray-500 dark:text-gray-400">
                                            <span className="animate-spin rounded-full h-3 w-3 border-b-2 border-blue-500 inline-block" />
                                            {t(
                                              'admin.providers.testingMore',
                                              'Testing remaining models...'
                                            )}
                                          </div>
                                        )}
                                      </div>
                                    </td>
                                  </tr>
                                )}
                              </Fragment>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </CategorySection>
                );
              })}

              {filteredProviders.length === 0 && (
                <AdminEmptyState
                  icon="wrench-screwdriver"
                  title={
                    searchTerm
                      ? t('admin.providers.noResults', 'No providers found matching your search.')
                      : t('admin.providers.noProviders', 'No providers configured.')
                  }
                  description={
                    searchTerm
                      ? t('admin.providers.adjustSearch', 'Try adjusting your search term.')
                      : t(
                          'admin.providers.createFirst',
                          'Create your first provider to get started.'
                        )
                  }
                  action={
                    !searchTerm ? (
                      <button
                        onClick={createProvider}
                        className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 flex items-center justify-center gap-2"
                      >
                        <Icon name="PlusIcon" className="w-5 h-5" />
                        {t('admin.providers.add', 'Add provider')}
                      </button>
                    ) : null
                  }
                />
              )}
            </div>
          )}
        </div>

        {/* Info Box */}
        <div className="mt-6 bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
          <div className="flex items-start">
            <Icon
              name="InformationCircleIcon"
              className="w-5 h-5 text-blue-600 dark:text-blue-400 mt-0.5 mr-2 shrink-0"
            />
            <div className="text-sm text-blue-700 dark:text-blue-300">
              <p className="font-medium mb-1">
                {t('admin.providers.info.title', 'API Key Priority')}
              </p>
              <p>
                {t(
                  'admin.providers.info.description',
                  'When a model requests an API key, the system checks in this order: 1) Model-specific API key, 2) Provider-level API key (configured here), 3) Environment variable. This allows you to set a default API key for all models of a provider while still allowing individual models to override it.'
                )}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default AdminProvidersPage;
