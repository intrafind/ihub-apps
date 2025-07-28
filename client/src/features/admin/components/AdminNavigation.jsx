import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { usePlatformConfig } from '../../../shared/contexts/PlatformConfigContext';

const AdminNavigation = () => {
  const { t } = useTranslation();
  const location = useLocation();
  const { platformConfig } = usePlatformConfig();
  const pageConfig = platformConfig?.admin?.pages || {};
  const isEnabled = key => pageConfig[key] !== false;

  const navItems = [
    {
      key: 'home',
      name: t('admin.nav.home', 'Home'),
      href: '/admin',
      // icon: 'home',
      current: location.pathname === '/admin'
    },
    {
      key: 'apps',
      name: t('admin.nav.apps', 'Apps'),
      href: '/admin/apps',
      // icon: 'collection',
      current: location.pathname.startsWith('/admin/apps')
    },
    {
      key: 'models',
      name: t('admin.nav.models', 'Models'),
      href: '/admin/models',
      // icon: 'cpu-chip',
      current: location.pathname.startsWith('/admin/models')
    },
    {
      key: 'prompts',
      name: t('admin.nav.prompts', 'Prompts'),
      href: '/admin/prompts',
      // icon: 'clipboard-document-list',
      current: location.pathname.startsWith('/admin/prompts')
    },
    {
      key: 'pages',
      name: t('admin.nav.pages', 'Pages'),
      href: '/admin/pages',
      // icon: 'document',
      current: location.pathname.startsWith('/admin/pages')
    },
    {
      key: 'shortlinks',
      name: t('admin.nav.shortlinks', 'Short Links'),
      href: '/admin/shortlinks',
      // icon: 'link',
      current: location.pathname.startsWith('/admin/shortlinks')
    },
    {
      key: 'usage',
      name: t('admin.nav.usage', 'Usage Reports'),
      href: '/admin/usage',
      // icon: 'chart-bar',
      current: location.pathname === '/admin/usage'
    },
    {
      key: 'auth',
      name: t('admin.nav.auth', 'Authentication'),
      href: '/admin/auth',
      // icon: 'shield-check',
      current: location.pathname.startsWith('/admin/auth')
    },
    // Only show Users navigation if local auth is enabled (since users are only managed locally)
    ...(platformConfig?.localAuth?.enabled ||
    platformConfig?.oidcAuth?.enabled ||
    platformConfig?.proxyAuth?.enabled
      ? [
          {
            key: 'users',
            name: t('admin.nav.users', 'Users'),
            href: '/admin/users',
            // icon: 'user',
            current: location.pathname.startsWith('/admin/users')
          }
        ]
      : []),
    // Only show Groups navigation if authentication is enabled (not anonymous-only mode)
    ...(platformConfig?.localAuth?.enabled ||
    platformConfig?.oidcAuth?.enabled ||
    platformConfig?.proxyAuth?.enabled
      ? [
          {
            key: 'groups',
            name: t('admin.nav.groups', 'Groups'),
            href: '/admin/groups',
            // icon: 'users',
            current: location.pathname.startsWith('/admin/groups')
          }
        ]
      : []),
    {
      key: 'ui',
      name: t('admin.nav.ui', 'UI'),
      href: '/admin/ui',
      // icon: 'cog',
      current: location.pathname === '/admin/ui'
    },
    {
      key: 'system',
      name: t('admin.nav.system', 'System'),
      href: '/admin/system',
      // icon: 'cog',
      current: location.pathname === '/admin/system'
    }
  ];

  return (
    <nav className="bg-white shadow-sm border-b border-gray-200">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex space-x-8">
          {navItems
            .filter(item => isEnabled(item.key))
            .map(item => (
              <Link
                key={item.name}
                to={item.href}
                className={`
                inline-flex items-center px-1 pt-1 border-b-2 text-sm font-medium
                ${
                  item.current
                    ? 'border-indigo-500 text-indigo-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }
              `}
              >
                <Icon name={item.icon} className="w-4 h-4 mr-2" />
                {item.name}
              </Link>
            ))}
        </div>
      </div>
    </nav>
  );
};

export default AdminNavigation;
