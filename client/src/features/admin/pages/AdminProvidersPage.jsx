import { useState, useEffect, Fragment } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../../../utils/localizeContent';
import Icon from '../../../shared/components/Icon';
import AdminAuth from '../components/AdminAuth';
import AdminNavigation from '../components/AdminNavigation';
import CloudStorageConfig from '../components/CloudStorageConfig';
import IFinderConfig from '../components/IFinderConfig';
import JiraConfig from '../components/JiraConfig';
import { useFeatureFlags } from '../../../shared/hooks/useFeatureFlags';
import { makeAdminApiCall } from '../../../api/adminApi';

function HealthBadge({ status }) {
  const { t } = useTranslation();

  if (!status || status === 'idle') {
    return (
      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400">
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

function AdminProvidersPage() {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const navigate = useNavigate();
  const featureFlags = useFeatureFlags();
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
      setError(err.message);
      setProviders([]);
      setModels([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  // Group enabled models by provider
  const enabledModelsByProvider = models.reduce((acc, model) => {
    if (!model.enabled) return acc;
    const provider = model.provider || 'unknown';
    if (!acc[provider]) acc[provider] = [];
    acc[provider].push(model);
    return acc;
  }, {});

  const testProvider = async providerId => {
    const providerModels = enabledModelsByProvider[providerId] || [];
    if (providerModels.length === 0) return;

    setHealthStatus(prev => ({
      ...prev,
      [providerId]: { status: 'testing', results: [], expanded: true }
    }));

    // Use fetch directly to bypass the axios auth interceptor.
    // The model test endpoint returns 401 when a model has no API key configured —
    // a normal testable condition, not an auth failure. Using makeAdminApiCall here
    // would cause the axios interceptor to clear tokens and redirect the admin.
    const API_URL = import.meta.env.VITE_API_URL || '/api';
    const authToken = localStorage.getItem('authToken') || localStorage.getItem('adminToken');
    const fetchHeaders = { 'Content-Type': 'application/json' };
    if (authToken) fetchHeaders['Authorization'] = `Bearer ${authToken}`;

    const results = [];
    for (const model of providerModels) {
      try {
        const fetchResponse = await fetch(`${API_URL}/admin/models/${model.id}/test`, {
          method: 'POST',
          headers: fetchHeaders,
          credentials: 'include'
        });
        const data = await fetchResponse.json().catch(() => ({}));
        if (fetchResponse.ok) {
          results.push({
            model,
            success: true,
            message: data?.message || t('admin.providers.health.testSuccessful', 'Test successful'),
            response: data?.response
          });
        } else {
          results.push({
            model,
            success: false,
            message: data?.message || t('admin.providers.health.testFailed', 'Test failed'),
            error: data?.error || `HTTP ${fetchResponse.status}`
          });
        }
      } catch (err) {
        results.push({
          model,
          success: false,
          message: t('admin.providers.health.testFailed', 'Test failed'),
          error: err.message
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
    if (!confirm(`Delete provider "${providerName}"?`)) {
      return;
    }

    try {
      await makeAdminApiCall(`/admin/providers/${providerId}`, {
        method: 'DELETE'
      });
      await loadData();
    } catch (err) {
      console.error('Error deleting provider:', err);
      setError(err.message);
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
    const category = provider.category || 'llm';
    if (!acc[category]) {
      acc[category] = [];
    }
    acc[category].push(provider);
    return acc;
  }, {});

  const categoryOrder = ['llm', 'websearch', 'cloudstorage', 'custom'];
  const categoryLabels = {
    llm: t('admin.providers.category.llm', 'LLM Providers'),
    websearch: t('admin.providers.category.websearch', 'Web Search Providers'),
    cloudstorage: t('admin.providers.category.cloudstorage', 'Cloud Storage Providers'),
    custom: t('admin.providers.category.custom', 'Custom / Generic API Keys')
  };

  // Count how many LLM providers have enabled models (for "Test All" button visibility)
  const testableProviderCount = providers.filter(
    p => (p.category === 'llm' || !p.category) && (enabledModelsByProvider[p.id] || []).length > 0
  ).length;

  return (
    <AdminAuth>
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
        <AdminNavigation />

        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="mb-6">
            <h1 className="text-3xl font-bold text-gray-900 dark:text-white">
              {t('admin.providers.title', 'Provider Credentials')}
            </h1>
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
              {t(
                'admin.providers.description',
                'Manage API keys for LLM providers, web search services, and custom integrations. Provider-level keys are used as fallback for models that do not have their own API key configured.'
              )}
            </p>
          </div>

          {/* Error Display */}
          {error && (
            <div className="mb-6 p-4 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-lg">
              <div className="flex items-center">
                <Icon
                  name="ExclamationCircleIcon"
                  className="w-5 h-5 text-red-600 dark:text-red-400 mr-2"
                />
                <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
              </div>
            </div>
          )}

          {/* Search and Actions Bar */}
          <div className="mb-6 flex flex-col sm:flex-row gap-4">
            <div className="flex-1">
              <div className="relative">
                <Icon
                  name="MagnifyingGlassIcon"
                  className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-gray-400"
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
            {testableProviderCount > 0 && (
              <button
                onClick={testAllProviders}
                disabled={testingAll}
                className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
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
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 flex items-center justify-center gap-2"
            >
              <Icon name="PlusIcon" className="w-5 h-5" />
              {t('admin.providers.createNew', 'Create New Provider')}
            </button>
          </div>

          {/* Providers List - Grouped by Category */}
          {loading ? (
            <div className="flex justify-center items-center py-12">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
            </div>
          ) : (
            <div className="space-y-6">
              {categoryOrder.map(category => {
                const categoryProviders = groupedProviders[category] || [];
                if (categoryProviders.length === 0) return null;
                const isLlm = category === 'llm';

                return (
                  <div key={category}>
                    <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-3 px-2">
                      {categoryLabels[category]}
                    </h2>
                    <div className="bg-white dark:bg-gray-800 shadow rounded-lg overflow-hidden">
                      <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                        <thead className="bg-gray-50 dark:bg-gray-900">
                          <tr>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                              {t('admin.providers.table.provider', 'Provider')}
                            </th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                              {t('admin.providers.table.description', 'Description')}
                            </th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                              {t('admin.providers.table.apiKey', 'API Key')}
                            </th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                              {t('admin.providers.table.status', 'Status')}
                            </th>
                            {isLlm && (
                              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                                {t('admin.providers.table.models', 'Models')}
                              </th>
                            )}
                            {isLlm && (
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
                            const isExpanded = providerHealth.expanded;
                            const hasResults =
                              providerHealth.results && providerHealth.results.length > 0;
                            const colSpan = isLlm ? 7 : 5;

                            return (
                              <Fragment key={provider.id}>
                                <tr
                                  className="hover:bg-gray-50 dark:hover:bg-gray-700 cursor-pointer"
                                  onClick={() => editProvider(provider.id)}
                                >
                                  <td className="px-6 py-4 whitespace-nowrap">
                                    <div className="flex items-center">
                                      <div>
                                        <div className="text-sm font-medium text-gray-900 dark:text-white">
                                          {getLocalizedContent(provider.name, currentLanguage)}
                                        </div>
                                        <div className="text-sm text-gray-500 dark:text-gray-400">
                                          {provider.id}
                                        </div>
                                      </div>
                                    </div>
                                  </td>
                                  <td className="px-6 py-4">
                                    <div className="text-sm text-gray-900 dark:text-gray-300">
                                      {getLocalizedContent(provider.description, currentLanguage)}
                                    </div>
                                  </td>
                                  <td className="px-6 py-4 whitespace-nowrap">
                                    {provider.apiKeySet ? (
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
                                  <td className="px-6 py-4 whitespace-nowrap">
                                    {provider.enabled ? (
                                      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-200">
                                        {t('admin.providers.enabled', 'Enabled')}
                                      </span>
                                    ) : (
                                      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-300">
                                        {t('admin.providers.disabled', 'Disabled')}
                                      </span>
                                    )}
                                  </td>
                                  {isLlm && (
                                    <td className="px-6 py-4 whitespace-nowrap">
                                      <span className="text-sm text-gray-700 dark:text-gray-300">
                                        {enabledModels.length > 0 ? (
                                          <span className="font-medium">
                                            {enabledModels.length}
                                          </span>
                                        ) : (
                                          <span className="text-gray-400 dark:text-gray-500">
                                            —
                                          </span>
                                        )}
                                      </span>
                                    </td>
                                  )}
                                  {isLlm && (
                                    <td className="px-6 py-4 whitespace-nowrap">
                                      <div className="flex items-center gap-2">
                                        <HealthBadge status={providerHealth.status || 'idle'} />
                                        {hasResults && (
                                          <button
                                            onClick={e => {
                                              e.stopPropagation();
                                              toggleExpanded(provider.id);
                                            }}
                                            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
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
                                    <div className="flex justify-end gap-2">
                                      {isLlm && enabledModels.length > 0 && (
                                        <button
                                          onClick={e => {
                                            e.stopPropagation();
                                            testProvider(provider.id);
                                          }}
                                          disabled={
                                            providerHealth.status === 'testing' || testingAll
                                          }
                                          className="text-green-600 hover:text-green-900 dark:text-green-400 dark:hover:text-green-300 disabled:opacity-50 disabled:cursor-not-allowed"
                                        >
                                          {t('admin.providers.test', 'Test')}
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
                                      {provider.category && provider.category !== 'llm' && (
                                        <button
                                          onClick={e => {
                                            e.stopPropagation();
                                            deleteProvider(
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
                                              className={`w-4 h-4 mt-0.5 flex-shrink-0 ${
                                                result.success
                                                  ? 'text-green-600 dark:text-green-400'
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
                  </div>
                );
              })}

              {filteredProviders.length === 0 && (
                <div className="bg-white dark:bg-gray-800 shadow rounded-lg p-12 text-center">
                  <p className="text-gray-500 dark:text-gray-400">
                    {searchTerm
                      ? t('admin.providers.noResults', 'No providers found matching your search.')
                      : t('admin.providers.noProviders', 'No providers configured.')}
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Info Box */}
          <div className="mt-6 bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
            <div className="flex items-start">
              <Icon
                name="InformationCircleIcon"
                className="w-5 h-5 text-blue-600 dark:text-blue-400 mt-0.5 mr-2 flex-shrink-0"
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

          {/* Integration Configuration Sections — gated by integrations feature flag */}
          {featureFlags.isEnabled('integrations', true) && (
            <div className="mt-8 space-y-6">
              <IFinderConfig />
              <CloudStorageConfig />
              <JiraConfig />
            </div>
          )}
        </div>
      </div>
    </AdminAuth>
  );
}

export default AdminProvidersPage;
