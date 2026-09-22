import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { makeAdminApiCall } from '../../../api/adminApi';
import LoadingSpinner from '../../../shared/components/LoadingSpinner';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import OAuthTabsHeader from '../components/OAuthTabsHeader';
import { useFilterState } from '../hooks/useFilterState';
import { SearchInput } from '../components/data-table';

const KIND_BADGE_CLASSES = {
  stored: 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300',
  cimd: 'bg-indigo-100 dark:bg-indigo-900/50 text-indigo-800 dark:text-indigo-300'
};

/**
 * Admin → OAuth → Connections.
 *
 * The clients tab answers "what software may connect"; this answers "who
 * actually did, and to what". They stopped being the same question the moment
 * one client record could serve every user — and they stay apart under client
 * metadata documents, where the client most people connect through has no
 * record to list at all.
 */
function AdminOAuthConnectionsPage() {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [connections, setConnections] = useState([]);
  const [cimdClients, setCimdClients] = useState([]);
  const [message, setMessage] = useState(null);
  const [confirmDialog, setConfirmDialog] = useState(null);
  const [userFilter, setUserFilter] = useFilterState('user', '');
  const [clientFilter, setClientFilter] = useFilterState('client', '');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await makeAdminApiCall('/admin/oauth/connections');
      setConnections(response.data?.connections || []);
      setCimdClients(response.data?.cimdClients || []);
    } catch (error) {
      setMessage({
        type: 'error',
        text: `${t('admin.auth.oauth.connections.loadError', 'Failed to load connections')}: ${error.message}`
      });
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    load();
  }, [load]);

  // Filtering client-side: the server already returns the whole (small) set
  // and typing should not cost a round trip per keystroke.
  const visible = useMemo(() => {
    const user = userFilter.trim().toLowerCase();
    const client = clientFilter.trim().toLowerCase();

    return connections.filter(connection => {
      if (
        user &&
        ![connection.userName, connection.userEmail, connection.userId]
          .filter(Boolean)
          .some(value => value.toLowerCase().includes(user))
      ) {
        return false;
      }
      if (
        client &&
        ![connection.clientName, connection.clientHost, connection.clientId]
          .filter(Boolean)
          .some(value => value.toLowerCase().includes(client))
      ) {
        return false;
      }
      return true;
    });
  }, [connections, userFilter, clientFilter]);

  const formatDate = value => {
    if (!value) return t('common.notAvailable', 'N/A');
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? t('common.notAvailable', 'N/A') : date.toLocaleString();
  };

  const encodeClientId = clientId =>
    // A metadata-document client id is a URL; base64url keeps it out of the
    // path grammar rather than relying on encodeURIComponent round-tripping.
    btoa(String.fromCharCode(...new TextEncoder().encode(clientId)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

  const handleRevokeAll = client => {
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
          load();
        } catch (error) {
          setMessage({
            type: 'error',
            text: `${t('admin.auth.oauth.cimd.revokeAllError', 'Failed to revoke the connections')}: ${error.message}`
          });
        }
      }
    });
  };

  const handleRevoke = connection => {
    setConfirmDialog({
      title: t('admin.auth.oauth.connections.revokeTitle', 'Revoke connection'),
      message: t(
        'admin.auth.oauth.connections.revokeConfirm',
        'Disconnect {{client}} from {{user}}? The application has to send them through sign-in and consent again; an access token it already holds keeps working until it expires.',
        { client: connection.clientName, user: connection.userName || connection.userId }
      ),
      danger: true,
      onConfirm: async () => {
        setConfirmDialog(null);
        try {
          await makeAdminApiCall(
            `/admin/oauth/connections/${encodeURIComponent(connection.clientId)}/${encodeURIComponent(connection.userId)}`,
            { method: 'DELETE' }
          );
          setMessage({
            type: 'success',
            text: t('admin.auth.oauth.connections.revokeSuccess', 'Connection revoked')
          });
          load();
        } catch (error) {
          setMessage({
            type: 'error',
            text: `${t('admin.auth.oauth.connections.revokeError', 'Failed to revoke the connection')}: ${error.message}`
          });
        }
      }
    });
  };

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
      <OAuthTabsHeader connectionCount={connections.length} />

      {message && (
        <div
          className={`mb-6 p-4 rounded-md ${
            message.type === 'success'
              ? 'bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-800 text-green-700 dark:text-green-300'
              : 'bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300'
          }`}
        >
          <p className="text-sm">{message.text}</p>
        </div>
      )}

      {cimdClients.length > 0 && (
        <div className="mb-6 bg-white dark:bg-gray-800 shadow-sm rounded-lg p-5">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-1">
            {t('admin.auth.oauth.connections.cimdTitle', 'Clients identified by metadata document')}
          </h2>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
            {t(
              'admin.auth.oauth.connections.cimdDesc',
              'Their client ID is the URL of a document they publish. They are listed here because people are connected through them — and because this is where you can disconnect all of them at once.'
            )}
          </p>
          <ul className="divide-y divide-gray-200 dark:divide-gray-700">
            {cimdClients.map(client => (
              <li key={client.clientId} className="py-2 flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                    {client.name}
                  </span>{' '}
                  <span className="text-xs font-mono text-gray-500 dark:text-gray-400">
                    {client.host}
                  </span>
                  {client.blocked && (
                    <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 dark:bg-red-900/50 text-red-800 dark:text-red-300">
                      {t('admin.auth.oauth.cimd.blockedBadge', 'Blocked')}
                    </span>
                  )}
                </div>
                <div className="shrink-0 flex items-center gap-3">
                  <span className="text-xs text-gray-500 dark:text-gray-400">
                    {t('admin.auth.oauth.connections.count', '{{count}} connections', {
                      count: client.connectionCount
                    })}
                  </span>
                  {client.connectionCount > 0 && (
                    <button
                      onClick={() => handleRevokeAll(client)}
                      className="inline-flex items-center px-3 py-1.5 border border-red-300 dark:border-red-700 text-xs font-medium rounded-md text-red-700 dark:text-red-400 bg-white dark:bg-gray-700 hover:bg-red-50 dark:hover:bg-red-900/30"
                    >
                      {t('admin.auth.oauth.cimd.revokeAll', 'Revoke all connections')}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <SearchInput
          value={userFilter}
          onChange={setUserFilter}
          placeholder={t('admin.auth.oauth.connections.filterUser', 'Filter by user')}
        />
        <SearchInput
          value={clientFilter}
          onChange={setClientFilter}
          placeholder={t('admin.auth.oauth.connections.filterClient', 'Filter by client')}
        />
      </div>

      {visible.length === 0 ? (
        <div className="text-center py-12 bg-white dark:bg-gray-800 rounded-lg shadow-sm">
          <Icon name="link" className="mx-auto h-12 w-12 text-gray-400" />
          <h3 className="mt-2 text-sm font-medium text-gray-900 dark:text-gray-100">
            {connections.length === 0
              ? t('admin.auth.oauth.connections.none', 'Nobody has connected an application yet')
              : t('admin.auth.oauth.connections.noMatches', 'No connections match these filters')}
          </h3>
        </div>
      ) : (
        <div className="bg-white dark:bg-gray-800 shadow-sm overflow-hidden sm:rounded-md overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
            <thead className="bg-gray-50 dark:bg-gray-900">
              <tr>
                {[
                  { id: 'user', label: t('admin.auth.oauth.connections.user', 'User') },
                  { id: 'client', label: t('admin.auth.oauth.connections.client', 'Client') },
                  { id: 'scopes', label: t('admin.auth.oauth.connections.scopesLabel', 'Scopes') },
                  { id: 'granted', label: t('admin.auth.oauth.connections.granted', 'Granted') },
                  {
                    id: 'lastUsed',
                    label: t('admin.auth.oauth.connections.lastUsed', 'Last used')
                  },
                  { id: 'actions', label: '' }
                ].map(column => (
                  <th
                    key={column.id}
                    className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider"
                  >
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
              {visible.map(connection => (
                <tr
                  key={`${connection.clientId}:${connection.userId}`}
                  className="hover:bg-gray-50 dark:hover:bg-gray-700"
                >
                  <td className="px-4 py-3 text-sm text-gray-900 dark:text-gray-100">
                    <div className="font-medium">{connection.userName || connection.userId}</div>
                    {connection.userEmail && (
                      <div className="text-xs text-gray-500 dark:text-gray-400">
                        {connection.userEmail}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-900 dark:text-gray-100">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium">{connection.clientName}</span>
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                          KIND_BADGE_CLASSES[connection.clientKind] || KIND_BADGE_CLASSES.stored
                        }`}
                      >
                        {t(
                          `admin.auth.oauth.kind.${connection.clientKind === 'cimd' ? 'cimd' : 'admin'}`,
                          connection.clientKind === 'cimd' ? 'Client metadata' : 'Admin'
                        )}
                      </span>
                    </div>
                    <div className="text-xs font-mono text-gray-500 dark:text-gray-400 break-all">
                      {connection.clientHost || connection.clientId}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-600 dark:text-gray-400">
                    {connection.scopes.join(' ')}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-600 dark:text-gray-400 whitespace-nowrap">
                    {formatDate(connection.grantedAt)}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-600 dark:text-gray-400 whitespace-nowrap">
                    {formatDate(connection.lastUsedAt)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => handleRevoke(connection)}
                      className="inline-flex items-center px-3 py-1.5 border border-red-300 dark:border-red-700 text-xs font-medium rounded-md text-red-700 dark:text-red-400 bg-white dark:bg-gray-700 hover:bg-red-50 dark:hover:bg-red-900/30"
                    >
                      {t('admin.auth.oauth.connections.revoke', 'Revoke')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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

export default AdminOAuthConnectionsPage;
