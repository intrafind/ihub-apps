import { useTranslation } from 'react-i18next';
import AdminAuth from '../components/AdminAuth';
import AdminNavigation from '../components/AdminNavigation';
import QuickActions from '../components/QuickActions';
import AdminSectionCard from '../components/AdminSectionCard';
import { usePlatformConfig } from '../../../shared/contexts/PlatformConfigContext';
import useFeatureFlags from '../../../shared/hooks/useFeatureFlags';

const AdminHome = () => {
  const { t } = useTranslation();
  const { platformConfig } = usePlatformConfig();
  const featureFlags = useFeatureFlags();
  const pageConfig = platformConfig?.admin?.pages || {};
  const isEnabled = key => {
    // Check if feature is disabled - prompts requires promptsLibrary feature
    if (key === 'prompts' && !featureFlags.isEnabled('promptsLibrary', true)) {
      return false;
    }
    return pageConfig[key] !== false;
  };

  const adminSections = [
    {
      key: 'apps',
      title: t('admin.nav.apps', 'Apps Management'),
      description: t('admin.home.sections.appsDesc', 'Create, edit, and manage applications'),
      href: '/admin/apps',
      //icon: 'collection',
      color: 'bg-green-500'
    },
    {
      key: 'models',
      title: t('admin.nav.models', 'Models Management'),
      description: t('admin.home.sections.modelsDesc', 'Configure and manage AI models'),
      href: '/admin/models',
      //icon: 'cpu-chip',
      color: 'bg-purple-500'
    },
    {
      key: 'prompts',
      title: t('admin.nav.prompts', 'Prompts Management'),
      description: t('admin.home.sections.promptsDesc', 'Create and manage prompt templates'),
      href: '/admin/prompts',
      //icon: 'clipboard-document-list',
      color: 'bg-indigo-500'
    },
    {
      key: 'tools',
      title: t('admin.nav.tools', 'Tools Management'),
      description: t(
        'admin.home.sections.toolsDesc',
        'Configure and manage AI tools / function calling'
      ),
      href: '/admin/tools',
      //icon: 'wrench',
      color: 'bg-amber-500'
    },
    {
      key: 'shortlinks',
      title: t('admin.nav.shortlinks', 'Short Links'),
      description: t('admin.home.sections.shortlinksDesc', 'Manage application short links'),
      href: '/admin/shortlinks',
      //icon: 'link',
      color: 'bg-teal-500'
    },
    {
      key: 'usage',
      title: t('admin.nav.usage', 'Usage Reports'),
      description: t(
        'admin.home.sections.usageDesc',
        'View application usage statistics and analytics'
      ),
      href: '/admin/usage',
      //icon: 'chart-bar',
      color: 'bg-blue-500'
    },
    {
      key: 'system',
      title: t('admin.nav.system', 'System Administration'),
      description: t('admin.home.sections.systemDesc', 'System settings and maintenance tools'),
      href: '/admin/system',
      //icon: 'none',
      color: 'bg-orange-500'
    },
    {
      key: 'ui',
      title: t('admin.nav.ui', 'UI Customization'),
      description: t(
        'admin.home.sections.uiDesc',
        'Customize the appearance, branding, and content of your iHub Apps'
      ),
      href: '/admin/ui',
      //icon: 'paint-brush',
      color: 'bg-pink-500'
    },
    {
      key: 'logging',
      title: t('admin.nav.logging', 'Logging Configuration'),
      description: t(
        'admin.home.sections.loggingDesc',
        'Configure logging levels, components, metadata, and debug settings'
      ),
      href: '/admin/logging',
      //icon: 'adjustments',
      color: 'bg-yellow-500'
    },
    {
      key: 'features',
      title: t('admin.nav.features', 'Features'),
      description: t(
        'admin.home.sections.featuresDesc',
        'Enable or disable platform features like workflows, prompts library, and more'
      ),
      href: '/admin/features',
      color: 'bg-cyan-500'
    },
    ...(featureFlags.isEnabled('marketplace', false)
      ? [
          {
            key: 'marketplace',
            title: t('admin.nav.marketplace', 'Marketplace'),
            description: t(
              'admin.home.sections.marketplaceDesc',
              'Discover and install apps, models, prompts, skills, and workflows from registries'
            ),
            href: '/admin/marketplace',
            color: 'bg-indigo-500'
          }
        ]
      : [])
  ];

  return (
    <AdminAuth>
      <AdminNavigation />
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
        {/* Header */}
        <div className="bg-white dark:bg-gray-800 shadow-sm border-b border-gray-200 dark:border-gray-700">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
            <div className="text-center">
              <h1 className="text-4xl font-bold text-gray-900 dark:text-gray-100">
                {t('admin.home.title', 'Admin Dashboard')}
              </h1>
              <p className="text-gray-600 dark:text-gray-400 mt-2 text-lg">
                {t('admin.home.welcome', 'Welcome to the iHub Apps administration center')}
              </p>
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <QuickActions isEnabled={isEnabled} />
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {adminSections
              .filter(s => isEnabled(s.key))
              .map((section, index) => (
                <AdminSectionCard key={index} section={section} />
              ))}
          </div>
        </div>
      </div>
    </AdminAuth>
  );
};

export default AdminHome;
