import React from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../components/Icon';
import AdminAuth from '../components/AdminAuth';

const AdminHome = () => {
  const { t } = useTranslation();

  const adminSections = [
    {
      title: t('admin.nav.usage', 'Usage Reports'),
      description: 'View application usage statistics and analytics',
      href: '/admin/usage',
      icon: 'chart-bar',
      color: 'bg-blue-500'
    },
    {
      title: t('admin.nav.apps', 'Apps Management'),
      description: 'Create, edit, and manage applications',
      href: '/admin/apps',
      icon: 'collection',
      color: 'bg-green-500'
    },
    {
      title: t('admin.nav.models', 'Models Management'),
      description: 'Configure and manage AI models',
      href: '/admin/models',
      icon: 'cpu-chip',
      color: 'bg-purple-500'
    },
    {
      title: t('admin.nav.prompts', 'Prompts Management'),
      description: 'Create and manage prompt templates',
      href: '/admin/prompts',
      icon: 'clipboard-document-list',
      color: 'bg-indigo-500'
    },
    {
      title: t('admin.nav.system', 'System Administration'),
      description: 'System settings and maintenance tools',
      href: '/admin/system',
      icon: 'cog',
      color: 'bg-orange-500'
    },
    {
      title: t('admin.nav.shortlinks', 'Short Links'),
      description: 'Manage application short links',
      href: '/admin/shortlinks',
      icon: 'link',
      color: 'bg-teal-500'
    }
  ];

  return (
    <AdminAuth>
      <div className="min-h-screen bg-gray-50">
        {/* Header */}
        <div className="bg-white shadow-sm border-b border-gray-200">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
            <div className="text-center">
              <div className="mx-auto h-16 w-16 flex items-center justify-center rounded-full bg-indigo-100 mb-4">
                <Icon name="shield-check" className="h-8 w-8 text-indigo-600" />
              </div>
              <h1 className="text-4xl font-bold text-gray-900">Admin Dashboard</h1>
              <p className="text-gray-600 mt-2 text-lg">
                Welcome to the AI Hub Apps administration center
              </p>
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {adminSections.map((section, index) => (
              <Link
                key={index}
                to={section.href}
                className="group relative bg-white rounded-lg shadow-sm border border-gray-200 hover:shadow-md hover:border-gray-300 transition-all duration-200 overflow-hidden"
              >
                <div className="p-6">
                  <div className="flex items-center mb-4">
                    <div className={`p-3 rounded-lg ${section.color} flex-shrink-0`}>
                      <Icon name={section.icon} className="h-6 w-6 text-white" />
                    </div>
                    <div className="ml-4">
                      <h3 className="text-lg font-semibold text-gray-900 group-hover:text-indigo-600">
                        {section.title}
                      </h3>
                    </div>
                  </div>
                  <p className="text-gray-600 text-sm leading-relaxed">
                    {section.description}
                  </p>
                </div>
                
                {/* Hover effect arrow */}
                <div className="absolute top-4 right-4 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                  <Icon name="arrow-right" className="h-5 w-5 text-gray-400" />
                </div>
              </Link>
            ))}
          </div>

          {/* Quick Actions */}
          <div className="mt-12 bg-white rounded-lg shadow-sm border border-gray-200 p-6">
            <h2 className="text-xl font-semibold text-gray-900 mb-6">Quick Actions</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <a
                href="/api/admin/cache/_refresh"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
              >
                <Icon name="refresh" className="h-4 w-4 mr-2" />
                Refresh Cache
              </a>
              
              <a
                href="/api/admin/cache/_clear"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500"
              >
                <Icon name="trash" className="h-4 w-4 mr-2" />
                Clear Cache
              </a>
              
              <Link
                to="/admin/system"
                className="inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
              >
                <Icon name="cog" className="h-4 w-4 mr-2" />
                System Settings
              </Link>
              
              <Link
                to="/"
                className="inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500"
              >
                <Icon name="home" className="h-4 w-4 mr-2" />
                Back to Apps
              </Link>
            </div>
          </div>
        </div>
      </div>
    </AdminAuth>
  );
};

export default AdminHome;