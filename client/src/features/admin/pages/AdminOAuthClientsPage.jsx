import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import AdminAuth from '../components/AdminAuth';
import AdminNavigation from '../components/AdminNavigation';
import { makeAdminApiCall } from '../../../api/adminApi';
import LoadingSpinner from '../../../shared/components/LoadingSpinner';

const AdminOAuthClientsPage = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [clients, setClients] = useState([]);
  const [message, setMessage] = useState('');
  const [oauthEnabled, setOAuthEnabled] = useState(false);

  useEffect(() => {
    checkOAuthStatus();
    loadClients();
  }, []);

  const checkOAuthStatus = async () => {
    try {
      const response = await makeAdminApiCall('/admin/configs/platform');
      const data = response.data;
      setOAuthEnabled(data?.oauth?.enabled || false);
    } catch (error) {
      console.error('Failed to check OAuth status:', error);
    }
  };

  const loadClients = async () => {
    try {
      const response = await makeAdminApiCall('/admin/oauth/clients');
      const data = response.data;
      setClients(data.clients || []);
    } catch (error) {
      if (error.response?.data?.error?.includes('OAuth is not enabled')) {
        setMessage({
          type: 'warning',
          text: t('admin.auth.oauth.disabled', 'OAuth is not enabled. Enable it in Authentication settings.')
        });
      } else {
        setMessage({
          type: 'error',
          text: `${t('admin.auth.oauth.loadError', 'Failed to load OAuth clients')}: ${error.message}`
        });
      }
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteClient = async clientId => {
    if (!window.confirm(t('admin.auth.oauth.deleteConfirm', 'Are you sure you want to delete this OAuth client? All issued tokens will stop working.'))) {
      return;
    }

    try {
      await makeAdminApiCall(`/admin/oauth/clients/${clientId}`, {
        method: 'DELETE'
      });

      setMessage({
        type: 'success',
        text: t('admin.auth.oauth.deleteSuccess', 'OAuth client deleted successfully')
      });
      loadClients();
    } catch (error) {
      setMessage({
        type: 'error',
        text: `${t('admin.auth.oauth.deleteError', 'Failed to delete OAuth client')}: ${error.message}`
      });
    }
  };

  const handleToggleClientStatus = async client => {
    const newStatus = !client.active;

    try {
      await makeAdminApiCall(`/admin/oauth/clients/${client.clientId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          active: newStatus
        })
      });

      setMessage({
        type: 'success',
        text: t(
          newStatus ? 'admin.auth.oauth.enabledSuccess' : 'admin.auth.oauth.disabledSuccess',
          `Client ${newStatus ? 'enabled' : 'disabled'} successfully`
        )
      });
      loadClients();
    } catch (error) {
      setMessage({
        type: 'error',
        text: `${t('admin.auth.oauth.updateError', 'Failed to update client')}: ${error.message}`
      });
    }
  };

  const handleToggleOAuth = async () => {
    const newStatus = !oauthEnabled;

    try {
      // Load current platform config
      const response = await makeAdminApiCall('/admin/configs/platform');
      const platformConfig = response.data;

      // Update OAuth enabled status
      const updatedConfig = {
        ...platformConfig,
        oauth: {
          ...(platformConfig.oauth || {}),
          enabled: newStatus,
          clientsFile: platformConfig.oauth?.clientsFile || 'contents/config/oauth-clients.json',
          defaultTokenExpirationMinutes: platformConfig.oauth?.defaultTokenExpirationMinutes || 60,
          maxTokenExpirationMinutes: platformConfig.oauth?.maxTokenExpirationMinutes || 1440
        }
      };

      // Save updated config
      await makeAdminApiCall('/admin/configs/platform', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(updatedConfig)
      });

      setOAuthEnabled(newStatus);
      setMessage({
        type: 'success',
        text: `OAuth ${newStatus ? 'enabled' : 'disabled'} successfully`
      });

      // Reload clients if enabling
      if (newStatus) {
        loadClients();
      }
    } catch (error) {
      setMessage({
        type: 'error',
        text: `Failed to ${newStatus ? 'enable' : 'disable'} OAuth: ${error.message}`
      });
    }
  };

  const handleRotateSecret = async clientId => {
    if (!window.confirm(t('admin.auth.oauth.rotateSecretConfirm', 'Are you sure you want to rotate the secret? The old secret will stop working immediately.'))) {
      return;
    }

    try {
      const response = await makeAdminApiCall(`/admin/oauth/clients/${clientId}/rotate-secret`, {
        method: 'POST'
      });

      const data = response.data;
      const newSecret = data.clientSecret;

      // Show the new secret in a modal or alert
      alert(`${t('admin.auth.oauth.rotateSecretSuccess', 'Secret rotated successfully. Save the new secret now.')}\n\n${t('admin.auth.oauth.clientSecret', 'Client Secret')}: ${newSecret}\n\n${t('admin.auth.oauth.clientSecretWarning', 'Save this secret now. It will not be shown again.')}`);
      
      loadClients();
    } catch (error) {
      setMessage({
        type: 'error',
        text: `Failed to rotate secret: ${error.message}`
      });
    }
  };

  const formatDate = dateString => {
    if (!dateString) return t('common.notAvailable', 'N/A');
    return new Date(dateString).toLocaleString();
  };

  if (loading) {
    return (
      <AdminAuth>
        <AdminNavigation />
        <div className="min-h-screen bg-gray-50 flex items-center justify-center">
          <LoadingSpinner size="lg" />
        </div>
      </AdminAuth>
    );
  }

  return (
    <AdminAuth>
      <AdminNavigation />
      <div className="min-h-screen bg-gray-50">
        {/* Header */}
        <div className="bg-white shadow-sm border-b border-gray-200">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
            <div className="flex justify-between items-center">
              <div>
                <h1 className="text-3xl font-bold text-gray-900">
                  {t('admin.auth.oauth.title', 'OAuth Clients')}
                </h1>
                <p className="text-gray-600 mt-1">
                  {t('admin.auth.oauth.subtitle', 'Manage OAuth 2.0 clients for external API access')}
                </p>
              </div>
              {oauthEnabled && (
                <button
                  onClick={() => navigate('/admin/oauth/clients/new')}
                  className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                >
                  <Icon name="plus" size="md" className="mr-2" />
                  {t('admin.auth.oauth.createClient', 'Create OAuth Client')}
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          {/* OAuth Enable/Disable Card */}
          <div className="bg-white shadow rounded-lg p-6 mb-6">
            <div className="flex items-center justify-between">
              <div className="flex-1">
                <h3 className="text-lg font-medium text-gray-900">
                  OAuth 2.0 Authentication
                </h3>
                <p className="mt-1 text-sm text-gray-500">
                  {oauthEnabled
                    ? 'OAuth is currently enabled. External applications can authenticate using client credentials.'
                    : 'Enable OAuth to allow external applications to authenticate and access your APIs programmatically.'}
                </p>
              </div>
              <button
                onClick={handleToggleOAuth}
                className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${
                  oauthEnabled ? 'bg-blue-600' : 'bg-gray-200'
                }`}
              >
                <span className="sr-only">Enable OAuth</span>
                <span
                  className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                    oauthEnabled ? 'translate-x-5' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>
          </div>

          {message && (
            <div
              className={`mb-6 p-4 rounded-md ${
                message.type === 'success'
                  ? 'bg-green-50 border border-green-200'
                  : message.type === 'warning'
                    ? 'bg-yellow-50 border border-yellow-200'
                    : 'bg-red-50 border border-red-200'
              }`}
            >
              <div className="flex">
                <Icon
                  name={message.type === 'success' ? 'check' : 'warning'}
                  size="md"
                  className={`mt-0.5 mr-3 ${
                    message.type === 'success'
                      ? 'text-green-500'
                      : message.type === 'warning'
                        ? 'text-yellow-500'
                        : 'text-red-500'
                  }`}
                />
                <p
                  className={`text-sm ${
                    message.type === 'success'
                      ? 'text-green-700'
                      : message.type === 'warning'
                        ? 'text-yellow-700'
                        : 'text-red-700'
                  }`}
                >
                  {message.text}
                </p>
              </div>
            </div>
          )}

          {clients.length === 0 ? (
            <div className="text-center py-12 bg-white rounded-lg shadow">
              <Icon name="key" className="mx-auto h-12 w-12 text-gray-400" />
              <h3 className="mt-2 text-sm font-medium text-gray-900">
                {t('admin.auth.oauth.noClients', 'No OAuth clients configured')}
              </h3>
              {oauthEnabled && (
                <>
                  <p className="mt-1 text-sm text-gray-500">
                    Get started by creating a new OAuth client.
                  </p>
                  <div className="mt-6">
                    <button
                      onClick={() => navigate('/admin/oauth/clients/new')}
                      className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                    >
                      <Icon name="plus" size="md" className="mr-2" />
                      {t('admin.auth.oauth.createClient', 'Create OAuth Client')}
                    </button>
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="bg-white shadow overflow-hidden sm:rounded-md">
              <ul className="divide-y divide-gray-200">
                {clients.map(client => (
                  <li key={client.clientId}>
                    <div className="px-4 py-4 sm:px-6 hover:bg-gray-50">
                      <div className="flex items-center justify-between">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center space-x-3">
                            <h3 className="text-lg font-medium text-gray-900 truncate">
                              {client.name}
                            </h3>
                            <span
                              className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                                client.active
                                  ? 'bg-green-100 text-green-800'
                                  : 'bg-red-100 text-red-800'
                              }`}
                            >
                              {client.active
                                ? t('admin.auth.oauth.active', 'Active')
                                : t('admin.auth.oauth.suspended', 'Suspended')}
                            </span>
                          </div>
                          <div className="mt-2 flex items-center text-sm text-gray-500">
                            <code className="bg-gray-100 px-2 py-1 rounded text-xs mr-4">
                              {client.clientId}
                            </code>
                            {client.description && (
                              <p className="truncate">{client.description}</p>
                            )}
                          </div>
                          <div className="mt-2 grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm text-gray-500">
                            <div>
                              <span className="font-medium">
                                {t('admin.auth.oauth.scopes', 'Scopes')}:
                              </span>{' '}
                              {client.scopes?.join(', ') || t('common.none', 'None')}
                            </div>
                            <div>
                              <span className="font-medium">
                                {t('admin.auth.oauth.createdAt', 'Created')}:
                              </span>{' '}
                              {formatDate(client.createdAt)}
                            </div>
                            <div>
                              <span className="font-medium">
                                {t('admin.auth.oauth.lastUsed', 'Last Used')}:
                              </span>{' '}
                              {formatDate(client.lastUsed)}
                            </div>
                          </div>
                        </div>
                        <div className="flex space-x-2 ml-4">
                          <button
                            onClick={() => navigate(`/admin/oauth/clients/${client.clientId}`)}
                            className="inline-flex items-center px-3 py-2 border border-gray-300 shadow-sm text-sm leading-4 font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                            title={t('common.edit', 'Edit')}
                          >
                            <Icon name="pencil" size="sm" />
                          </button>
                          <button
                            onClick={() => handleRotateSecret(client.clientId)}
                            className="inline-flex items-center px-3 py-2 border border-gray-300 shadow-sm text-sm leading-4 font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                            title={t('admin.auth.oauth.rotateSecret', 'Rotate Secret')}
                          >
                            <Icon name="refresh" size="sm" />
                          </button>
                          <button
                            onClick={() => handleToggleClientStatus(client)}
                            className={`inline-flex items-center px-3 py-2 border shadow-sm text-sm leading-4 font-medium rounded-md focus:outline-none focus:ring-2 focus:ring-offset-2 ${
                              client.active
                                ? 'border-red-300 text-red-700 bg-white hover:bg-red-50 focus:ring-red-500'
                                : 'border-green-300 text-green-700 bg-white hover:bg-green-50 focus:ring-green-500'
                            }`}
                            title={
                              client.active
                                ? t('common.disable', 'Disable')
                                : t('common.enable', 'Enable')
                            }
                          >
                            <Icon name={client.active ? 'ban' : 'check'} size="sm" />
                          </button>
                          <button
                            onClick={() => handleDeleteClient(client.clientId)}
                            className="inline-flex items-center px-3 py-2 border border-red-300 shadow-sm text-sm leading-4 font-medium rounded-md text-red-700 bg-white hover:bg-red-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500"
                            title={t('common.delete', 'Delete')}
                          >
                            <Icon name="trash" size="sm" />
                          </button>
                        </div>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </AdminAuth>
  );
};

export default AdminOAuthClientsPage;
