import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { makeAdminApiCall } from '../../../api/adminApi';
import LoadingSpinner from '../../../shared/components/LoadingSpinner';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import OAuthTabsHeader from '../components/OAuthTabsHeader';
import { useFilterState } from '../hooks/useFilterState';
import { FilterSelect } from '../components/data-table';

/**
 * Which kind of client a record is, for the badge and the kind filter.
 *
 * `dynamic` records come from RFC 7591 registration and are the ones that
 * arrive in bulk — one per piece of MCP client software since de-duplication,
 * one per user before it — so the list hides them by default.
 */
function clientKind(client) {
  if (client?.metadata?.dcr === true) return 'dynamic';
  if (client?.personal === true) return 'personal';
  return 'admin';
}

const KIND_BADGE_CLASSES = {
  admin: 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300',
  personal: 'bg-teal-100 dark:bg-teal-900/50 text-teal-800 dark:text-teal-300',
  dynamic: 'bg-amber-100 dark:bg-amber-900/50 text-amber-800 dark:text-amber-300'
};

function AdminOAuthClientsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [clients, setClients] = useState([]);
  // Clients identified by a metadata document are not stored anywhere, so they
  // are derived from the connections that exist rather than listed.
  const [cimdClients, setCimdClients] = useState([]);
  const [kindFilter, setKindFilter] = useFilterState('kind', 'standard');
  const [pruneDays, setPruneDays] = useState(90);
  const [message, setMessage] = useState('');
  const [clientsEnabled, setClientsEnabled] = useState(false);
  const [showTokenModal, setShowTokenModal] = useState(false);
  const [generatedToken, setGeneratedToken] = useState(null);
  const [tokenExpirationDays, setTokenExpirationDays] = useState(365);
  const [selectedClientForToken, setSelectedClientForToken] = useState(null);
  const [isGeneratingToken, setIsGeneratingToken] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState(null);

  useEffect(() => {
    checkOAuthStatus();
    loadClients();
    // eslint-disable-next-line @eslint-react/exhaustive-deps
  }, []);

  const checkOAuthStatus = async () => {
    try {
      const response = await makeAdminApiCall('/admin/configs/platform');
      const data = response.data;
      setClientsEnabled(data?.oauth?.enabled?.clients || false);
    } catch (error) {
      console.error('Failed to check OAuth status:', error);
    }
  };

  const handleToggleClientsEnabled = async () => {
    const newStatus = !clientsEnabled;

    try {
      const response = await makeAdminApiCall('/admin/configs/platform');
      const platformConfig = response.data;

      const updatedConfig = {
        ...platformConfig,
        oauth: {
          ...(platformConfig.oauth || {}),
          enabled: {
            authz: platformConfig.oauth?.enabled?.authz ?? false,
            clients: newStatus
          }
        }
      };

      await makeAdminApiCall('/admin/configs/platform', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: updatedConfig
      });

      setClientsEnabled(newStatus);
      setMessage({
        type: 'success',
        text: t(
          newStatus
            ? 'admin.auth.oauth.clients.enabledSuccess'
            : 'admin.auth.oauth.clients.disabledSuccess',
          `OAuth Clients ${newStatus ? 'enabled' : 'disabled'} successfully`
        )
      });

      if (newStatus) {
        loadClients();
      }
    } catch (error) {
      setMessage({
        type: 'error',
        text: `${t('admin.auth.oauth.updateError', 'Failed to update client')}: ${error.message}`
      });
    }
  };

  const loadClients = async () => {
    try {
      const response = await makeAdminApiCall('/admin/oauth/clients');
      const data = response.data;
      setClients(data.clients || []);
      setCimdClients(data.cimdClients || []);
    } catch (error) {
      if (error.response?.data?.error?.includes('OAuth clients are not enabled')) {
        setMessage({
          type: 'warning',
          text: t(
            'admin.auth.oauth.clients.disabledWarning',
            'OAuth Clients are not enabled. Use the toggle above to enable them.'
          )
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

  const handlePruneDynamicClients = () => {
    setConfirmDialog({
      title: t('admin.auth.oauth.pruneDynamicTitle', 'Remove unused dynamic clients'),
      message: t(
        'admin.auth.oauth.pruneDynamicConfirm',
        'Delete every dynamically registered client that has not been used in the last {{days}} days? Anyone still connected through one of them has to sign in and consent again; nothing else is affected.',
        { days: pruneDays }
      ),
      danger: true,
      onConfirm: async () => {
        setConfirmDialog(null);
        try {
          const response = await makeAdminApiCall(
            `/admin/oauth/clients/dynamic?unusedForDays=${pruneDays}`,
            { method: 'DELETE' }
          );
          setMessage({
            type: 'success',
            text: t(
              'admin.auth.oauth.pruneDynamicSuccess',
              'Removed {{count}} unused dynamic client(s)',
              { count: response.data?.deleted ?? 0 }
            )
          });
          loadClients();
        } catch (error) {
          setMessage({
            type: 'error',
            text: `${t('admin.auth.oauth.pruneDynamicError', 'Failed to remove unused dynamic clients')}: ${error.message}`
          });
        }
      }
    });
  };

  const handleDeleteClient = clientId => {
    setConfirmDialog({
      title: t('admin.auth.oauth.deleteTitle', 'Delete OAuth Client'),
      message: t(
        'admin.auth.oauth.deleteConfirm',
        'Are you sure you want to delete this OAuth client? All issued tokens will stop working.'
      ),
      danger: true,
      onConfirm: async () => {
        setConfirmDialog(null);
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
      }
    });
  };

  const handleToggleClientStatus = async client => {
    const newStatus = !client.active;

    try {
      await makeAdminApiCall(`/admin/oauth/clients/${client.clientId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json'
        },
        body: {
          active: newStatus
        }
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

  const encodeClientId = clientId =>
    // The client id of a metadata-document client is a URL, so it cannot be a
    // path segment. base64url keeps it out of the path grammar entirely.
    btoa(String.fromCharCode(...new TextEncoder().encode(clientId)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

  const patchCimdClient = async (client, patch, successKey, successFallback) => {
    try {
      const response = await makeAdminApiCall(
        `/admin/oauth/clients/cimd/${encodeClientId(client.clientId)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: patch
        }
      );
      const revoked = response.data?.revoked;
      setMessage({
        type: 'success',
        text: revoked
          ? t(
              'admin.auth.oauth.cimd.blockedWithRevoke',
              'Blocked {{name}} and revoked {{count}} connection(s)',
              { name: client.name, count: revoked.connectionsRevoked }
            )
          : t(successKey, successFallback, { name: client.name })
      });
      loadClients();
    } catch (error) {
      setMessage({
        type: 'error',
        text: `${t('admin.auth.oauth.cimd.saveError', 'Failed to save the policy')}: ${error.message}`
      });
    }
  };

  const handleBlockCimdClient = client => {
    setConfirmDialog({
      title: t('admin.auth.oauth.cimd.blockTitle', 'Block this client'),
      message: t(
        'admin.auth.oauth.cimd.blockConfirm',
        'Block {{name}}? Its {{count}} connection(s) are revoked immediately and nobody can reconnect until you unblock it. An access token it already holds keeps working until it expires — at most {{minutes}} minutes.',
        {
          name: client.name,
          count: client.connectionCount ?? 0,
          minutes: client.effective?.tokenExpirationMinutes ?? 60
        }
      ),
      danger: true,
      onConfirm: async () => {
        setConfirmDialog(null);
        await patchCimdClient(
          client,
          { active: false },
          'admin.auth.oauth.cimd.blocked',
          'Blocked {{name}}'
        );
      }
    });
  };

  const handleUnblockCimdClient = client =>
    patchCimdClient(
      client,
      { active: true },
      'admin.auth.oauth.cimd.unblocked',
      'Unblocked {{name}}'
    );

  const handleApproveCimdClient = client =>
    patchCimdClient(
      client,
      { approvalState: 'approved', active: true },
      'admin.auth.oauth.cimd.approved',
      'Approved {{name}}'
    );

  const handleRevokeCimdConnections = client => {
    setConfirmDialog({
      title: t('admin.auth.oauth.cimd.revokeAllTitle', 'Revoke all connections'),
      message: t(
        'admin.auth.oauth.cimd.revokeAllConfirm',
        'Disconnect all {{count}} user(s) from {{name}}? They can reconnect by signing in and consenting again — block the client first if that is not what you want.',
        { name: client.name, count: client.connectionCount ?? 0 }
      ),
      danger: true,
      onConfirm: async () => {
        setConfirmDialog(null);
        try {
          const response = await makeAdminApiCall(
            `/admin/oauth/clients/${encodeClientId(client.clientId)}/connections`,
            { method: 'DELETE' }
          );
          setMessage({
            type: 'success',
            text: t(
              'admin.auth.oauth.cimd.revokeAllSuccess',
              'Revoked {{count}} connection(s) of {{name}}',
              { name: client.name, count: response.data?.connectionsRevoked ?? 0 }
            )
          });
          loadClients();
        } catch (error) {
          setMessage({
            type: 'error',
            text: `${t('admin.auth.oauth.cimd.revokeAllError', 'Failed to revoke the connections')}: ${error.message}`
          });
        }
      }
    });
  };

  const handleRotateSecret = clientId => {
    setConfirmDialog({
      title: t('admin.auth.oauth.rotateSecretTitle', 'Rotate Client Secret'),
      message: t(
        'admin.auth.oauth.rotateSecretConfirm',
        'Are you sure you want to rotate the secret? The old secret will stop working immediately.'
      ),
      danger: true,
      onConfirm: async () => {
        setConfirmDialog(null);
        try {
          const response = await makeAdminApiCall(
            `/admin/oauth/clients/${clientId}/rotate-secret`,
            {
              method: 'POST'
            }
          );
          const data = response.data;
          const newSecret = data.clientSecret;
          // Show the new secret — intentional alert so the admin can copy it before dismissing
          alert(
            `${t('admin.auth.oauth.rotateSecretSuccess', 'Secret rotated successfully. Save the new secret now.')}\n\n${t('admin.auth.oauth.clientSecret', 'Client Secret')}: ${newSecret}\n\n${t('admin.auth.oauth.clientSecretWarning', 'Save this secret now. It will not be shown again.')}`
          );
          loadClients();
        } catch (error) {
          setMessage({
            type: 'error',
            text: `Failed to rotate secret: ${error.message}`
          });
        }
      }
    });
  };

  const openTokenGenerationModal = clientId => {
    setSelectedClientForToken(clientId);
    setTokenExpirationDays(365);
    setGeneratedToken(null);
    setShowTokenModal(true);
  };

  const handleGenerateToken = async () => {
    if (!selectedClientForToken) return;

    setIsGeneratingToken(true);
    try {
      const response = await makeAdminApiCall(
        `/admin/oauth/clients/${selectedClientForToken}/generate-token`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: {
            expirationDays: tokenExpirationDays
          }
        }
      );

      const data = response.data;
      setGeneratedToken({
        token: data.api_key,
        expiresAt: data.expires_at,
        clientId: selectedClientForToken
      });
    } catch (error) {
      setMessage({
        type: 'error',
        text: `Failed to generate token: ${error.message}`
      });
      closeTokenModal();
    } finally {
      setIsGeneratingToken(false);
    }
  };

  const closeTokenModal = () => {
    setShowTokenModal(false);
    setGeneratedToken(null);
    setTokenExpirationDays(365);
    setSelectedClientForToken(null);
    setIsGeneratingToken(false);
  };

  const formatDate = dateString => {
    if (!dateString) return t('common.notAvailable', 'N/A');
    return new Date(dateString).toLocaleString();
  };

  const dynamicCount = useMemo(
    () => clients.filter(c => clientKind(c) === 'dynamic').length,
    [clients]
  );

  // 'standard' is the default because a deployment with dynamic registration on
  // accumulates one dynamic record per piece of MCP client software — and, for
  // anything registered before de-duplication shipped, one per user.
  const visibleClients = useMemo(() => {
    if (kindFilter === 'all') return clients;
    if (kindFilter === 'standard') return clients.filter(c => clientKind(c) !== 'dynamic');
    return clients.filter(c => clientKind(c) === kindFilter);
  }, [clients, kindFilter]);

  const kindOptions = [
    { value: 'standard', label: t('admin.auth.oauth.kindFilter.standard', 'Admin & personal') },
    { value: 'all', label: t('admin.auth.oauth.kindFilter.all', 'All kinds') },
    { value: 'admin', label: t('admin.auth.oauth.kind.admin', 'Admin') },
    { value: 'personal', label: t('admin.auth.oauth.kind.personal', 'Personal') },
    { value: 'dynamic', label: t('admin.auth.oauth.kind.dynamic', 'Dynamic') }
  ];

  if (loading) {
    return (
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <OAuthTabsHeader />
        <div className="flex items-center justify-center py-16">
          <LoadingSpinner size="lg" />
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <OAuthTabsHeader clientCount={clients.length} />
      {clientsEnabled && (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <FilterSelect
              label={t('admin.auth.oauth.kindFilter.label', 'Kind')}
              value={kindFilter}
              onChange={setKindFilter}
              options={kindOptions}
            />
            {dynamicCount > 0 && (
              <div className="flex items-center gap-2">
                <label className="inline-flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                  <span>{t('admin.auth.oauth.pruneDynamicDays', 'Unused for (days)')}</span>
                  <input
                    type="number"
                    min="0"
                    max="3650"
                    value={pruneDays}
                    onChange={e => setPruneDays(Number(e.target.value))}
                    className="w-20 text-sm rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 px-2 py-2"
                  />
                </label>
                <button
                  onClick={handlePruneDynamicClients}
                  className="inline-flex items-center px-3 py-2 border border-red-300 dark:border-red-700 text-sm font-medium rounded-md text-red-700 dark:text-red-400 bg-white dark:bg-gray-700 hover:bg-red-50 dark:hover:bg-red-900/50 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-red-500"
                >
                  <Icon name="trash" size="sm" className="mr-2" />
                  {t('admin.auth.oauth.pruneDynamic', 'Remove unused dynamic clients')}
                </button>
              </div>
            )}
          </div>
          <button
            onClick={() => navigate('/admin/oauth/clients/new')}
            className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-xs text-white bg-blue-600 hover:bg-blue-700 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
          >
            <Icon name="plus" size="md" className="mr-2" />
            {t('admin.auth.oauth.createClient', 'Create OAuth Client')}
          </button>
        </div>
      )}
      <div>
        {/* Enable/Disable Card */}
        <div className="bg-white dark:bg-gray-800 shadow-sm rounded-lg p-6 mb-6">
          <div className="flex items-center justify-between">
            <div className="flex-1">
              <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">
                {t('admin.auth.oauth.clients.enable', 'OAuth Clients')}
              </h3>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                {clientsEnabled
                  ? t(
                      'admin.auth.oauth.clients.enabledDesc',
                      'OAuth Clients are active. External applications can authenticate using client credentials.'
                    )
                  : t(
                      'admin.auth.oauth.clients.disabledDesc',
                      'Enable OAuth Clients to allow external applications to authenticate using client credentials.'
                    )}
              </p>
            </div>
            <button
              onClick={handleToggleClientsEnabled}
              className={`ml-4 relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-hidden focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${
                clientsEnabled ? 'bg-blue-600' : 'bg-gray-200 dark:bg-gray-600'
              }`}
            >
              <span className="sr-only">
                {t('admin.auth.oauth.clients.enable', 'OAuth Clients')}
              </span>
              <span
                className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                  clientsEnabled ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </button>
          </div>
        </div>

        {message && (
          <div
            className={`mb-6 p-4 rounded-md ${
              message.type === 'success'
                ? 'bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-800'
                : message.type === 'warning'
                  ? 'bg-yellow-50 dark:bg-yellow-900/30 border border-yellow-200 dark:border-yellow-800'
                  : 'bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800'
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
                    ? 'text-green-700 dark:text-green-300'
                    : message.type === 'warning'
                      ? 'text-yellow-700 dark:text-yellow-300'
                      : 'text-red-700 dark:text-red-300'
                }`}
              >
                {message.text}
              </p>
            </div>
          </div>
        )}

        {cimdClients.length > 0 && (
          <div className="mb-6 bg-white dark:bg-gray-800 shadow-sm rounded-lg p-5">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-1">
              {t('admin.auth.oauth.cimdTitle', 'Clients identified by metadata document')}
            </h2>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
              {t(
                'admin.auth.oauth.cimdDesc',
                'Their client ID is the URL of a document they publish, so their name, redirect URIs and grant types are never stored here. What they may do is yours to set — per client, or globally under MCP gateway → Client identification.'
              )}
            </p>
            <ul className="divide-y divide-gray-200 dark:divide-gray-700">
              {cimdClients.map(client => (
                <li
                  key={client.clientId}
                  className="py-3 flex flex-wrap items-start justify-between gap-4"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                        {client.name}
                      </span>
                      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-indigo-100 dark:bg-indigo-900/50 text-indigo-800 dark:text-indigo-300">
                        {t('admin.auth.oauth.kind.cimd', 'Client metadata')}
                      </span>
                      {client.approvalState === 'pending' && (
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-amber-100 dark:bg-amber-900/50 text-amber-800 dark:text-amber-300">
                          {t('admin.auth.oauth.cimd.pending', 'Waiting for approval')}
                        </span>
                      )}
                      {client.blocked && (
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 dark:bg-red-900/50 text-red-800 dark:text-red-300">
                          {t('admin.auth.oauth.cimd.blockedBadge', 'Blocked')}
                        </span>
                      )}
                      {!client.blocked && client.approvalState !== 'pending' && !client.active && (
                        <span
                          className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300"
                          title={client.inactiveCode || ''}
                        >
                          {t('admin.auth.oauth.cimd.inactive', 'Not connectable')}
                        </span>
                      )}
                    </div>
                    <code className="text-xs text-gray-500 dark:text-gray-400 break-all">
                      {client.clientId}
                    </code>
                    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
                      <span>
                        {t('admin.auth.oauth.connectionsCount', '{{count}} connections', {
                          count: client.connectionCount
                        })}
                      </span>
                      <span>
                        {t('admin.auth.oauth.cimd.firstSeen', 'First seen')}:{' '}
                        {formatDate(client.firstSeenAt)}
                      </span>
                      <span>
                        {t('admin.auth.oauth.lastUsed', 'Last Used')}:{' '}
                        {formatDate(client.lastUsedAt)}
                      </span>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2 shrink-0">
                    {client.approvalState === 'pending' && (
                      <button
                        onClick={() => handleApproveCimdClient(client)}
                        className="inline-flex items-center px-3 py-1.5 border border-green-300 dark:border-green-700 text-xs font-medium rounded-md text-green-700 dark:text-green-400 bg-white dark:bg-gray-700 hover:bg-green-50 dark:hover:bg-green-900/30"
                      >
                        {t('admin.auth.oauth.cimd.approve', 'Approve')}
                      </button>
                    )}
                    <button
                      onClick={() =>
                        navigate(`/admin/oauth/clients/cimd/${encodeClientId(client.clientId)}`)
                      }
                      className="inline-flex items-center px-3 py-1.5 border border-gray-300 dark:border-gray-600 text-xs font-medium rounded-md text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600"
                    >
                      {t('admin.auth.oauth.cimd.editPolicy', 'Edit policy')}
                    </button>
                    {client.connectionCount > 0 && (
                      <button
                        onClick={() => handleRevokeCimdConnections(client)}
                        className="inline-flex items-center px-3 py-1.5 border border-red-300 dark:border-red-700 text-xs font-medium rounded-md text-red-700 dark:text-red-400 bg-white dark:bg-gray-700 hover:bg-red-50 dark:hover:bg-red-900/30"
                      >
                        {t('admin.auth.oauth.cimd.revokeAll', 'Revoke all connections')}
                      </button>
                    )}
                    {client.blocked ? (
                      <button
                        onClick={() => handleUnblockCimdClient(client)}
                        className="inline-flex items-center px-3 py-1.5 border border-green-300 dark:border-green-700 text-xs font-medium rounded-md text-green-700 dark:text-green-400 bg-white dark:bg-gray-700 hover:bg-green-50 dark:hover:bg-green-900/30"
                      >
                        {t('admin.auth.oauth.cimd.unblock', 'Unblock')}
                      </button>
                    ) : (
                      <button
                        onClick={() => handleBlockCimdClient(client)}
                        className="inline-flex items-center px-3 py-1.5 border border-red-300 dark:border-red-700 text-xs font-medium rounded-md text-red-700 dark:text-red-400 bg-white dark:bg-gray-700 hover:bg-red-50 dark:hover:bg-red-900/30"
                      >
                        {t('admin.auth.oauth.cimd.block', 'Block')}
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {kindFilter === 'standard' && dynamicCount > 0 && (
          <div className="mb-6 p-4 rounded-md bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700">
            <p className="text-sm text-gray-600 dark:text-gray-400">
              {t(
                'admin.auth.oauth.dynamicHidden',
                '{{count}} dynamically registered client(s) are hidden. They are created by MCP clients such as Claude at /api/oauth/register — switch the kind filter to see them.',
                { count: dynamicCount }
              )}
            </p>
          </div>
        )}

        {visibleClients.length === 0 ? (
          <div className="text-center py-12 bg-white dark:bg-gray-800 rounded-lg shadow-sm">
            <Icon name="key" className="mx-auto h-12 w-12 text-gray-400" />
            <h3 className="mt-2 text-sm font-medium text-gray-900 dark:text-gray-100">
              {clients.length === 0
                ? t('admin.auth.oauth.noClients', 'No OAuth clients configured')
                : t('admin.auth.oauth.noClientsForKind', 'No OAuth clients of this kind')}
            </h3>
            {clientsEnabled && (
              <>
                <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                  Get started by creating a new OAuth client.
                </p>
                <div className="mt-6">
                  <button
                    onClick={() => navigate('/admin/oauth/clients/new')}
                    className="inline-flex items-center px-4 py-2 border border-transparent shadow-xs text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                  >
                    <Icon name="plus" size="md" className="mr-2" />
                    {t('admin.auth.oauth.createClient', 'Create OAuth Client')}
                  </button>
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="bg-white dark:bg-gray-800 shadow-sm overflow-hidden sm:rounded-md">
            <ul className="divide-y divide-gray-200 dark:divide-gray-700">
              {visibleClients.map(client => (
                <li key={client.clientId}>
                  <div className="px-4 py-4 sm:px-6 hover:bg-gray-50 dark:hover:bg-gray-700">
                    <div className="flex items-center justify-between">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center space-x-3">
                          <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 truncate">
                            {client.name}
                          </h3>
                          <span
                            className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                              client.active
                                ? 'bg-green-100 dark:bg-green-900/50 text-green-800 dark:text-green-300'
                                : 'bg-red-100 dark:bg-red-900/50 text-red-800 dark:text-red-300'
                            }`}
                          >
                            {client.active
                              ? t('admin.auth.oauth.active', 'Active')
                              : t('admin.auth.oauth.suspended', 'Suspended')}
                          </span>
                          <span
                            className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${KIND_BADGE_CLASSES[clientKind(client)]}`}
                          >
                            {t(
                              `admin.auth.oauth.kind.${clientKind(client)}`,
                              clientKind(client) === 'dynamic'
                                ? 'Dynamic'
                                : clientKind(client) === 'personal'
                                  ? 'Personal'
                                  : 'Admin'
                            )}
                          </span>
                          {client.clientType && (
                            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 dark:bg-blue-900/50 text-blue-800 dark:text-blue-300">
                              {client.clientType}
                            </span>
                          )}
                          {(client.grantTypes || []).includes('authorization_code') && (
                            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-purple-100 dark:bg-purple-900/50 text-purple-800 dark:text-purple-300">
                              {t('admin.auth.oauth.badgeAuthCode', 'auth-code')}
                            </span>
                          )}
                        </div>
                        <div className="mt-2 flex items-center text-sm text-gray-500 dark:text-gray-400">
                          <code className="bg-gray-100 dark:bg-gray-700 px-2 py-1 rounded-sm text-xs mr-4">
                            {client.clientId}
                          </code>
                          {client.description && <p className="truncate">{client.description}</p>}
                        </div>
                        <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm text-gray-500 dark:text-gray-400">
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
                          <div>
                            <span className="font-medium">
                              {t('admin.auth.oauth.connectionsLabel', 'Connections')}:
                            </span>{' '}
                            {client.connectionCount ?? 0}
                          </div>
                          {clientKind(client) === 'dynamic' && (
                            <>
                              <div>
                                <span className="font-medium">
                                  {t('admin.auth.oauth.registrations', 'Registrations')}:
                                </span>{' '}
                                {client.metadata?.registrationCount ?? 1}
                              </div>
                              <div>
                                <span className="font-medium">
                                  {t('admin.auth.oauth.firstUser', 'First user')}:
                                </span>{' '}
                                {client.metadata?.firstUserName ||
                                  client.metadata?.firstUserId ||
                                  t('common.notAvailable', 'N/A')}
                              </div>
                            </>
                          )}
                        </div>
                      </div>
                      <div className="flex space-x-2 ml-4">
                        <button
                          onClick={() => navigate(`/admin/oauth/clients/${client.clientId}`)}
                          className="inline-flex items-center px-3 py-2 border border-gray-300 dark:border-gray-600 shadow-xs text-sm leading-4 font-medium rounded-md text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                          title={t('common.edit', 'Edit')}
                        >
                          <Icon name="pencil" size="sm" />
                        </button>
                        <button
                          onClick={() => openTokenGenerationModal(client.clientId)}
                          className="inline-flex items-center px-3 py-2 border border-gray-300 dark:border-gray-600 shadow-xs text-sm leading-4 font-medium rounded-md text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                          title={t('admin.auth.oauth.generateToken', 'Generate Long-Term Token')}
                        >
                          <Icon name="key" size="sm" />
                        </button>
                        <button
                          onClick={() => handleRotateSecret(client.clientId)}
                          className="inline-flex items-center px-3 py-2 border border-gray-300 dark:border-gray-600 shadow-xs text-sm leading-4 font-medium rounded-md text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                          title={t('admin.auth.oauth.rotateSecret', 'Rotate Secret')}
                        >
                          <Icon name="refresh" size="sm" />
                        </button>
                        <button
                          onClick={() => handleToggleClientStatus(client)}
                          className={`inline-flex items-center px-3 py-2 border shadow-xs text-sm leading-4 font-medium rounded-md focus:outline-hidden focus:ring-2 focus:ring-offset-2 ${
                            client.active
                              ? 'border-red-300 dark:border-red-700 text-red-700 dark:text-red-400 bg-white dark:bg-gray-700 hover:bg-red-50 dark:hover:bg-red-900/50 focus:ring-red-500'
                              : 'border-green-300 dark:border-green-700 text-green-700 dark:text-green-400 bg-white dark:bg-gray-700 hover:bg-green-50 dark:hover:bg-green-900/50 focus:ring-green-500'
                          }`}
                          title={
                            client.active
                              ? t('common.disable', 'Disable')
                              : t('common.enable', 'Enable')
                          }
                        >
                          <Icon name={client.active ? 'eye-slash' : 'eye'} size="sm" />
                        </button>
                        <button
                          onClick={() => handleDeleteClient(client.clientId)}
                          className="inline-flex items-center px-3 py-2 border border-red-300 dark:border-red-700 shadow-xs text-sm leading-4 font-medium rounded-md text-red-700 dark:text-red-400 bg-white dark:bg-gray-700 hover:bg-red-50 dark:hover:bg-red-900/50 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-red-500"
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

      {/* Token Generation Modal */}
      {showTokenModal && (
        <div className="fixed z-10 inset-0 overflow-y-auto">
          <div className="flex items-end justify-center min-h-screen pt-4 px-4 pb-20 text-center sm:block sm:p-0">
            <div className="fixed inset-0 bg-gray-500/75 dark:bg-gray-900/75 transition-opacity" />

            <span className="hidden sm:inline-block sm:align-middle sm:h-screen">&#8203;</span>

            <div className="inline-block align-bottom bg-white dark:bg-gray-800 rounded-lg px-4 pt-5 pb-4 text-left overflow-hidden shadow-xl transform transition-all sm:my-8 sm:align-middle sm:max-w-lg sm:w-full sm:p-6">
              {!generatedToken ? (
                /* Token generation form */
                <div>
                  <div className="mx-auto flex items-center justify-center h-12 w-12 rounded-full bg-blue-100 dark:bg-blue-900/50">
                    <Icon name="key" className="h-6 w-6 text-blue-600 dark:text-blue-400" />
                  </div>
                  <div className="mt-3 text-center sm:mt-5">
                    <h3 className="text-lg leading-6 font-medium text-gray-900 dark:text-gray-100">
                      {t('admin.auth.oauth.generateToken', 'Generate Long-Term Token')}
                    </h3>
                    <div className="mt-4">
                      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
                        {t(
                          'admin.auth.oauth.generateTokenDesc',
                          'Select the expiration period for this token and click Generate.'
                        )}
                      </p>
                      <div className="mb-4">
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                          {t('admin.auth.oauth.expirationDays', 'Expiration (days)')}
                        </label>
                        <input
                          type="number"
                          min="1"
                          max="3650"
                          value={tokenExpirationDays}
                          onChange={e => setTokenExpirationDays(Number(e.target.value))}
                          className="w-full rounded-md border-gray-300 dark:border-gray-600 shadow-xs bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:border-blue-500 focus:ring-blue-500"
                        />
                        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                          {t(
                            'admin.auth.oauth.expirationRange',
                            'Enter a value between 1 and 3650 days (10 years)'
                          )}
                        </p>
                      </div>
                    </div>
                  </div>
                  <div className="mt-5 sm:mt-6 sm:grid sm:grid-cols-2 sm:gap-3 sm:grid-flow-row-dense">
                    <button
                      type="button"
                      disabled={isGeneratingToken}
                      onClick={handleGenerateToken}
                      className="w-full inline-flex justify-center rounded-md border border-transparent shadow-xs px-4 py-2 bg-blue-600 text-base font-medium text-white hover:bg-blue-700 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 sm:col-start-2 sm:text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {isGeneratingToken ? (
                        <>
                          <LoadingSpinner size="sm" className="mr-2" />
                          {t('admin.auth.oauth.generating', 'Generating...')}
                        </>
                      ) : (
                        t('admin.auth.oauth.generate', 'Generate')
                      )}
                    </button>
                    <button
                      type="button"
                      disabled={isGeneratingToken}
                      onClick={closeTokenModal}
                      className="mt-3 w-full inline-flex justify-center rounded-md border border-gray-300 dark:border-gray-600 shadow-xs px-4 py-2 bg-white dark:bg-gray-700 text-base font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 sm:mt-0 sm:col-start-1 sm:text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {t('common.cancel', 'Cancel')}
                    </button>
                  </div>
                </div>
              ) : (
                /* Token display */
                <div>
                  <div className="mx-auto flex items-center justify-center h-12 w-12 rounded-full bg-green-100 dark:bg-green-900/50">
                    <Icon name="check" className="h-6 w-6 text-green-600 dark:text-green-400" />
                  </div>
                  <div className="mt-3 text-center sm:mt-5">
                    <h3 className="text-lg leading-6 font-medium text-gray-900 dark:text-gray-100">
                      {t('admin.auth.oauth.tokenGenerated', 'Long-Term Token Generated')}
                    </h3>
                    <div className="mt-4">
                      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
                        {t(
                          'admin.auth.oauth.tokenWarning',
                          'Save this token now. It will not be shown again.'
                        )}
                      </p>
                      <div className="bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-sm p-3 mb-2">
                        <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                          {t('admin.auth.oauth.token', 'Token')}:
                        </label>
                        <code className="block text-xs break-all bg-white dark:bg-gray-800 p-2 rounded-sm border dark:border-gray-600 text-gray-900 dark:text-gray-100">
                          {generatedToken.token}
                        </code>
                      </div>
                      <div className="bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-sm p-3">
                        <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                          {t('admin.auth.oauth.expiresAt', 'Expires At')}:
                        </label>
                        <p className="text-sm text-gray-900 dark:text-gray-100">
                          {new Date(generatedToken.expiresAt).toLocaleString()}
                        </p>
                      </div>
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(generatedToken.token);
                          setMessage({
                            type: 'success',
                            text: t('common.copiedToClipboard', 'Copied to clipboard')
                          });
                        }}
                        className="mt-4 w-full inline-flex justify-center items-center px-4 py-2 border border-gray-300 dark:border-gray-600 shadow-xs text-sm font-medium rounded-md text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                      >
                        <Icon name="clipboard" size="sm" className="mr-2" />
                        {t('common.copyToClipboard', 'Copy to Clipboard')}
                      </button>
                    </div>
                  </div>
                  <div className="mt-5 sm:mt-6">
                    <button
                      type="button"
                      onClick={closeTokenModal}
                      className="w-full inline-flex justify-center rounded-md border border-transparent shadow-xs px-4 py-2 bg-blue-600 text-base font-medium text-white hover:bg-blue-700 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 sm:text-sm"
                    >
                      {t('common.close', 'Close')}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      <ConfirmDialog
        isOpen={!!confirmDialog}
        title={confirmDialog?.title ?? ''}
        message={confirmDialog?.message ?? ''}
        danger={confirmDialog?.danger}
        onConfirm={() => confirmDialog?.onConfirm()}
        onDeny={() => setConfirmDialog(null)}
      />
    </div>
  );
}

export default AdminOAuthClientsPage;
