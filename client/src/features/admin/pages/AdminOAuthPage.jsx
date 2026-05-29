import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { makeAdminApiCall } from '../../../api/adminApi';
import LoadingSpinner from '../../../shared/components/LoadingSpinner';
import OAuthTabsHeader from '../components/OAuthTabsHeader';

function StatusRow({ icon, iconColor, title, description, enabled, count, onClick, t }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 hover:shadow-md hover:border-gray-300 dark:hover:border-gray-600 p-5 transition-all active:scale-[0.99]"
    >
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-start gap-4 min-w-0">
          <div className={`p-3 rounded-lg ${iconColor}`}>
            <Icon name={icon} size="lg" />
          </div>
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">{title}</h3>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{description}</p>
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {typeof count === 'number' && count > 0 && (
            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300">
              {count}
            </span>
          )}
          <span
            className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
              enabled
                ? 'bg-green-100 dark:bg-green-900/50 text-green-800 dark:text-green-300'
                : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400'
            }`}
          >
            {enabled ? t('common.enabled', 'Enabled') : t('common.disabled', 'Disabled')}
          </span>
          <Icon name="chevron-right" size="md" className="text-gray-400 dark:text-gray-500" />
        </div>
      </div>
    </button>
  );
}

function AdminOAuthPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [oauthEnabled, setOAuthEnabled] = useState(false);
  const [clientsEnabled, setClientsEnabled] = useState(false);
  const [clientCount, setClientCount] = useState(0);

  useEffect(() => {
    const load = async () => {
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
            setClientCount(0);
          }
        }
      } catch (error) {
        console.error('Failed to load OAuth config:', error);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

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
      <OAuthTabsHeader clientCount={clientsEnabled ? clientCount : undefined} />

      <div className="space-y-4">
        <StatusRow
          icon="settings"
          iconColor="bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400"
          title={t('admin.auth.oauth.server.title', 'Authorization Server')}
          description={t(
            'admin.auth.oauth.overview.serverDesc',
            'Configure the OAuth 2.0 authorization server, endpoints, token settings, and grant types.'
          )}
          enabled={oauthEnabled}
          onClick={() => navigate('/admin/oauth/server')}
          t={t}
        />
        <StatusRow
          icon="key"
          iconColor="bg-purple-50 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400"
          title={t('admin.auth.oauth.title', 'OAuth Clients')}
          description={t(
            'admin.auth.oauth.overview.clientsDesc',
            'Create and manage OAuth 2.0 client applications for external API access.'
          )}
          enabled={clientsEnabled}
          count={clientsEnabled ? clientCount : undefined}
          onClick={() => navigate('/admin/oauth/clients')}
          t={t}
        />
      </div>
    </div>
  );
}

export default AdminOAuthPage;
