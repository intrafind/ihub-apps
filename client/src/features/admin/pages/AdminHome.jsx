import React from 'react';
import { useTranslation } from 'react-i18next';
import AdminAuth from '../components/AdminAuth';
import AdminNavigation from '../components/AdminNavigation';
import QuickActions from '../components/QuickActions';
import AdminSectionCard from '../components/AdminSectionCard';
import { makeAdminApiCall } from '../../../api/adminApi';
import { usePlatformConfig } from '../../../shared/contexts/PlatformConfigContext';

const AdminHome = () => {
  const { t } = useTranslation();
  const { platformConfig } = usePlatformConfig();
  const pageConfig = platformConfig?.admin?.pages || {};
  const isEnabled = key => pageConfig[key] !== false;

  const handleCacheRefresh = async () => {
    try {
      await makeAdminApiCall('/api/admin/cache/_refresh', { method: 'POST' });
      alert(t('admin.home.cacheRefreshSuccess', 'Cache refreshed successfully'));
    } catch (error) {
      alert(
        t('admin.home.cacheRefreshError', 'Error refreshing cache: {{message}}', {
          message: error.message
        })
      );
    }
  };

  const handleCacheClear = async () => {
    if (confirm(t('admin.home.clearCacheConfirm', 'Are you sure you want to clear the cache?'))) {
      try {
        await makeAdminApiCall('/api/admin/cache/_clear', { method: 'POST' });
        alert(t('admin.home.cacheClearSuccess', 'Cache cleared successfully'));
      } catch (error) {
        alert(
          t('admin.home.cacheClearError', 'Error clearing cache: {{message}}', {
            message: error.message
          })
        );
      }
    }
  };

  const adminSections = [
    {
      key: 'apps',
      title: t('admin.nav.apps', 'Apps Management'),
      description: t('admin.home.sections.appsDesc', 'Create, edit, and manage applications'),
      href: '/admin/apps',
      icon: 'collection',
      color: 'bg-green-500'
    },
    {
      key: 'models',
      title: t('admin.nav.models', 'Models Management'),
      description: t('admin.home.sections.modelsDesc', 'Configure and manage AI models'),
      href: '/admin/models',
      icon: 'cpu-chip',
      color: 'bg-purple-500'
    },
    {
      key: 'prompts',
      title: t('admin.nav.prompts', 'Prompts Management'),
      description: t('admin.home.sections.promptsDesc', 'Create and manage prompt templates'),
      href: '/admin/prompts',
      icon: 'clipboard-document-list',
      color: 'bg-indigo-500'
    },
    {
      key: 'shortlinks',
      title: t('admin.nav.shortlinks', 'Short Links'),
      description: t('admin.home.sections.shortlinksDesc', 'Manage application short links'),
      href: '/admin/shortlinks',
      icon: 'link',
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
      icon: 'chart-bar',
      color: 'bg-blue-500'
    },
    {
      key: 'system',
      title: t('admin.nav.system', 'System Administration'),
      description: t('admin.home.sections.systemDesc', 'System settings and maintenance tools'),
      href: '/admin/system',
      icon: 'none',
      color: 'bg-orange-500'
    }
  ];

  return (
    <AdminAuth>
      <AdminNavigation />
      <div className="min-h-screen bg-gray-50">
        {/* Header */}
        <div className="bg-white shadow-sm border-b border-gray-200">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
            <div className="text-center">
              <h1 className="text-4xl font-bold text-gray-900">
                {t('admin.home.title', 'Admin Dashboard')}
              </h1>
              <p className="text-gray-600 mt-2 text-lg">
                {t('admin.home.welcome', 'Welcome to the AI Hub Apps administration center')}
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
