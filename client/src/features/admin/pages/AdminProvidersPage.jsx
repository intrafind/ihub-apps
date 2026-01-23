import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../../../utils/localizeContent';
import Icon from '../../../shared/components/Icon';
import AdminAuth from '../components/AdminAuth';
import AdminNavigation from '../components/AdminNavigation';
import { makeAdminApiCall } from '../../../api/adminApi';

const AdminProvidersPage = () => {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const navigate = useNavigate();
  const [providers, setProviders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');

  const loadProviders = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await makeAdminApiCall('/admin/providers');
      const data = response.data;

      // Ensure we have an array
      const providersArray = Array.isArray(data) ? data : [];
      setProviders(providersArray);

      if (providersArray.length === 0) {
        console.warn('No providers returned from API');
      }
    } catch (err) {
      console.error('Error loading providers:', err);
      setError(err.message);
      setProviders([]); // Set empty array on error
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadProviders();
  }, []);

  const editProvider = providerId => {
    navigate(`/admin/providers/${providerId}`);
  };

  // Filter providers based on search term
  const filteredProviders = providers.filter(provider => {
    const name = getLocalizedContent(provider.name, currentLanguage).toLowerCase();
    const description = getLocalizedContent(provider.description, currentLanguage).toLowerCase();
    const search = searchTerm.toLowerCase();
    return name.includes(search) || description.includes(search) || provider.id.includes(search);
  });

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
                'Manage API keys for LLM providers. Provider-level keys are used as fallback for models that do not have their own API key configured.'
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
          </div>

          {/* Providers List */}
          {loading ? (
            <div className="flex justify-center items-center py-12">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
            </div>
          ) : (
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
                    <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                      {t('admin.providers.table.actions', 'Actions')}
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                  {filteredProviders.length === 0 ? (
                    <tr>
                      <td
                        colSpan="5"
                        className="px-6 py-12 text-center text-gray-500 dark:text-gray-400"
                      >
                        {searchTerm
                          ? t(
                              'admin.providers.noResults',
                              'No providers found matching your search.'
                            )
                          : t('admin.providers.noProviders', 'No providers configured.')}
                      </td>
                    </tr>
                  ) : (
                    filteredProviders.map(provider => (
                      <tr
                        key={provider.id}
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
                              <Icon name="ExclamationTriangleIcon" className="w-3 h-3 mr-1" />
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
                        <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                          <button
                            onClick={e => {
                              e.stopPropagation();
                              editProvider(provider.id);
                            }}
                            className="text-blue-600 hover:text-blue-900 dark:text-blue-400 dark:hover:text-blue-300"
                          >
                            {t('admin.providers.configure', 'Configure')}
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
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
        </div>
      </div>
    </AdminAuth>
  );
};

export default AdminProvidersPage;
