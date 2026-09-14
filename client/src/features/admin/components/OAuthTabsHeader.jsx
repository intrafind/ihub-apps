import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import AdminTabs from './AdminTabs';

/**
 * Shared header (title + description + tabs) for the OAuth admin surface.
 *
 * Renders the same tab bar across `/admin/oauth`, `/admin/oauth/server`,
 * `/admin/oauth/clients` and `/admin/oauth/connections` so the pages read as
 * one tabbed area. Each tab is its own route, which keeps every tab
 * deep-linkable and preserves the existing standalone pages.
 *
 * @param {Object} props
 * @param {number} [props.clientCount] Count badge for the Clients tab
 * @param {number} [props.connectionCount] Count badge for the Connections tab
 */
function OAuthTabsHeader({ clientCount, connectionCount }) {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();

  const tabs = [
    { id: 'overview', label: t('admin.auth.oauth.tabs.overview', 'Overview') },
    { id: 'server', label: t('admin.auth.oauth.tabs.server', 'Authorization Server') },
    {
      id: 'clients',
      label: t('admin.auth.oauth.tabs.clients', 'Clients'),
      count: typeof clientCount === 'number' ? clientCount : undefined
    },
    {
      id: 'connections',
      label: t('admin.auth.oauth.tabs.connections', 'Connections'),
      count: typeof connectionCount === 'number' ? connectionCount : undefined
    }
  ];

  const activeId = location.pathname.endsWith('/connections')
    ? 'connections'
    : location.pathname.endsWith('/clients')
      ? 'clients'
      : location.pathname.endsWith('/server')
        ? 'server'
        : 'overview';

  const handleChange = id => {
    if (id === activeId) return;
    const target =
      id === 'overview'
        ? '/admin/oauth'
        : id === 'server'
          ? '/admin/oauth/server'
          : id === 'clients'
            ? '/admin/oauth/clients'
            : '/admin/oauth/connections';
    navigate(target);
  };

  return (
    <div className="mb-6">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
        {t('admin.nav.oauth', 'OAuth')}
      </h1>
      <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
        {t(
          'admin.auth.oauth.overview.subtitle',
          'Manage the OAuth 2.0 authorization server and client applications'
        )}
      </p>
      <div className="mt-4">
        <AdminTabs
          tabs={tabs}
          activeId={activeId}
          onChange={handleChange}
          ariaLabel={t('admin.auth.oauth.tabs.aria', 'OAuth sections')}
        />
      </div>
    </div>
  );
}

export default OAuthTabsHeader;
