import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import AdminAuth from '../components/AdminAuth';
import AdminNavigation from '../components/AdminNavigation';
import { makeAdminApiCall } from '../../../api/adminApi';
import LoadingSpinner from '../../../shared/components/LoadingSpinner';

function AdminOAuthPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [oauthEnabled, setOAuthEnabled] = useState(false);
  const [clientsEnabled, setClientsEnabled] = useState(false);
  const [clientCount, setClientCount] = useState(0);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const response = await makeAdminApiCall('/admin/configs/platform');
      const data = response.data;
      const enabled = data?.oauth?.enabled?.authz || false;
      const cEnabled = data?.oauth?.enabled?.clients || false;
      setOAuthEnabled(enabled);
      setClientsEnabled(cEnabled);

      if (cEnabled) {
        try {
          const clientsResponse = await makeAdminApiCall('/admin/oauth/clients');
          const clients = clientsResponse.data?.clients || [];
          setClientCount(clients.length);
        } catch {
          // OAuth may be enabled but clients endpoint could fail
          setClientCount(0);
        }
      }
    } catch (error) {
      console.error('Failed to load OAuth config:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <AdminAuth>
        <AdminNavigation />
        <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center">
          <LoadingSpinner size="lg" />
        </div>
      </AdminAuth>
    );
  }

  return (
    <AdminAuth>
      <AdminNavigation />
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
        {/* Header */}
        <div className="bg-white dark:bg-gray-800 shadow-sm border-b border-gray-200 dark:border-gray-700">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
            <div>
              <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">
                {t('admin.nav.oauth', 'OAuth')}
              </h1>
              <p className="text-gray-600 dark:text-gray-400 mt-1">
                {t(
                  'admin.auth.oauth.overview.subtitle',
                  'Manage the OAuth 2.0 authorization server and client applications'
                )}
              </p>
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Authorization Server Tile */}
            <button
              onClick={() => navigate('/admin/oauth/server')}
              className="bg-white dark:bg-gray-800 shadow rounded-lg p-6 text-left hover:shadow-md transition-shadow duration-200 border border-transparent hover:border-blue-200 dark:hover:border-blue-800"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center min-w-0">
                  <div className="flex-shrink-0 p-3 bg-blue-50 dark:bg-blue-900/30 rounded-lg">
                    <Icon name="settings" size="lg" className="text-blue-600 dark:text-blue-400" />
                  </div>
                  <div className="ml-4 min-w-0">
                    <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">
                      {t('admin.auth.oauth.server.title', 'Authorization Server')}
                    </h3>
                    <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                      {t(
                        'admin.auth.oauth.overview.serverDesc',
                        'Configure the OAuth 2.0 authorization server, endpoints, token settings, and grant types.'
                      )}
                    </p>
                  </div>
                </div>
                <div className="flex items-center space-x-3 ml-4 flex-shrink-0">
                  <span
                    className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                      oauthEnabled
                        ? 'bg-green-100 dark:bg-green-900/50 text-green-800 dark:text-green-300'
                        : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400'
                    }`}
                  >
                    {oauthEnabled
                      ? t('common.enabled', 'Enabled')
                      : t('common.disabled', 'Disabled')}
                  </span>
                  <Icon
                    name="chevron-right"
                    size="md"
                    className="text-gray-400 dark:text-gray-500"
                  />
                </div>
              </div>
            </button>

            {/* Clients Tile */}
            <button
              onClick={() => navigate('/admin/oauth/clients')}
              className="bg-white dark:bg-gray-800 shadow rounded-lg p-6 text-left hover:shadow-md transition-shadow duration-200 border border-transparent hover:border-blue-200 dark:hover:border-blue-800"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center min-w-0">
                  <div className="flex-shrink-0 p-3 bg-purple-50 dark:bg-purple-900/30 rounded-lg">
                    <Icon name="key" size="lg" className="text-purple-600 dark:text-purple-400" />
                  </div>
                  <div className="ml-4 min-w-0">
                    <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">
                      {t('admin.auth.oauth.title', 'OAuth Clients')}
                    </h3>
                    <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                      {t(
                        'admin.auth.oauth.overview.clientsDesc',
                        'Create and manage OAuth 2.0 client applications for external API access.'
                      )}
                    </p>
                  </div>
                </div>
                <div className="flex items-center space-x-3 ml-4 flex-shrink-0">
                  {clientsEnabled && clientCount > 0 && (
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-purple-100 dark:bg-purple-900/50 text-purple-800 dark:text-purple-300">
                      {clientCount}
                    </span>
                  )}
                  <span
                    className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                      clientsEnabled
                        ? 'bg-green-100 dark:bg-green-900/50 text-green-800 dark:text-green-300'
                        : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400'
                    }`}
                  >
                    {clientsEnabled
                      ? t('common.enabled', 'Enabled')
                      : t('common.disabled', 'Disabled')}
                  </span>
                  <Icon
                    name="chevron-right"
                    size="md"
                    className="text-gray-400 dark:text-gray-500"
                  />
                </div>
              </div>
            </button>
          </div>
        </div>
      </div>
    </AdminAuth>
  );
}

export default AdminOAuthPage;
