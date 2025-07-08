import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

const AdminAppsPage = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [apps, setApps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterEnabled, setFilterEnabled] = useState('all'); // all, enabled, disabled

  useEffect(() => {
    loadApps();
  }, []);

  const loadApps = async () => {
    try {
      setLoading(true);
      const response = await fetch('/api/admin/apps');
      if (!response.ok) {
        throw new Error('Failed to load apps');
      }
      const data = await response.json();
      setApps(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const toggleApp = async (appId) => {
    try {
      const response = await fetch(`/api/admin/apps/${appId}/toggle`, {
        method: 'POST',
      });
      
      if (!response.ok) {
        throw new Error('Failed to toggle app');
      }
      
      const result = await response.json();
      
      // Update the app in the local state
      setApps(prevApps => 
        prevApps.map(app => 
          app.id === appId ? { ...app, enabled: result.enabled } : app
        )
      );
    } catch (err) {
      setError(err.message);
    }
  };

  const deleteApp = async (appId) => {
    if (!window.confirm(t('admin.apps.deleteConfirm', 'Are you sure you want to delete this app?'))) {
      return;
    }
    
    try {
      const response = await fetch(`/api/admin/apps/${appId}`, {
        method: 'DELETE',
      });
      
      if (!response.ok) {
        throw new Error('Failed to delete app');
      }
      
      // Remove the app from the local state
      setApps(prevApps => prevApps.filter(app => app.id !== appId));
    } catch (err) {
      setError(err.message);
    }
  };

  // Filter apps based on search term and enabled status
  const filteredApps = apps.filter(app => {
    const matchesSearch = app.name.en.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         app.description.en.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         app.id.toLowerCase().includes(searchTerm.toLowerCase());
    
    const matchesFilter = filterEnabled === 'all' || 
                         (filterEnabled === 'enabled' && app.enabled) ||
                         (filterEnabled === 'disabled' && !app.enabled);
    
    return matchesSearch && matchesFilter;
  });

  const getLocalizedContent = (content, lang = 'en') => {
    if (typeof content === 'string') return content;
    return content?.[lang] || content?.en || '';
  };

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600 mx-auto"></div>
          <p className="mt-2 text-gray-600">{t('admin.apps.loading', 'Loading apps...')}</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="bg-red-50 border border-red-200 rounded-md p-4">
          <div className="flex">
            <div className="flex-shrink-0">
              <svg className="h-5 w-5 text-red-400" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
              </svg>
            </div>
            <div className="ml-3">
              <h3 className="text-sm font-medium text-red-800">
                {t('admin.apps.errorTitle', 'Error')}
              </h3>
              <div className="mt-2 text-sm text-red-700">
                {error}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="sm:flex sm:items-center">
        <div className="sm:flex-auto">
          <h1 className="text-2xl font-semibold text-gray-900">
            {t('admin.apps.title', 'Apps Administration')}
          </h1>
          <p className="mt-2 text-sm text-gray-700">
            {t('admin.apps.subtitle', 'Manage your AI Hub applications')}
          </p>
        </div>
        <div className="mt-4 sm:mt-0 sm:ml-16 sm:flex-none">
          <button
            type="button"
            className="inline-flex items-center justify-center rounded-md border border-transparent bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 sm:w-auto"
            onClick={() => navigate('/admin/apps/new')}
          >
            {t('admin.apps.addNew', 'Add New App')}
          </button>
        </div>
      </div>

      {/* Search and filter controls */}
      <div className="mt-6 flex flex-col sm:flex-row gap-4">
        <div className="flex-1">
          <input
            type="text"
            placeholder={t('admin.apps.searchPlaceholder', 'Search apps...')}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
          />
        </div>
        <div>
          <select
            value={filterEnabled}
            onChange={(e) => setFilterEnabled(e.target.value)}
            className="block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
          >
            <option value="all">{t('admin.apps.filterAll', 'All Apps')}</option>
            <option value="enabled">{t('admin.apps.filterEnabled', 'Enabled Only')}</option>
            <option value="disabled">{t('admin.apps.filterDisabled', 'Disabled Only')}</option>
          </select>
        </div>
      </div>

      {/* Stats */}
      <div className="mt-6 grid grid-cols-1 gap-5 sm:grid-cols-3">
        <div className="bg-white overflow-hidden shadow rounded-lg">
          <div className="p-5">
            <div className="flex items-center">
              <div className="flex-shrink-0">
                <svg className="h-6 w-6 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                </svg>
              </div>
              <div className="ml-5 w-0 flex-1">
                <dl>
                  <dt className="text-sm font-medium text-gray-500 truncate">
                    {t('admin.apps.totalApps', 'Total Apps')}
                  </dt>
                  <dd className="text-lg font-medium text-gray-900">
                    {apps.length}
                  </dd>
                </dl>
              </div>
            </div>
          </div>
        </div>

        <div className="bg-white overflow-hidden shadow rounded-lg">
          <div className="p-5">
            <div className="flex items-center">
              <div className="flex-shrink-0">
                <svg className="h-6 w-6 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <div className="ml-5 w-0 flex-1">
                <dl>
                  <dt className="text-sm font-medium text-gray-500 truncate">
                    {t('admin.apps.enabledApps', 'Enabled Apps')}
                  </dt>
                  <dd className="text-lg font-medium text-gray-900">
                    {apps.filter(app => app.enabled).length}
                  </dd>
                </dl>
              </div>
            </div>
          </div>
        </div>

        <div className="bg-white overflow-hidden shadow rounded-lg">
          <div className="p-5">
            <div className="flex items-center">
              <div className="flex-shrink-0">
                <svg className="h-6 w-6 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728L5.636 5.636m12.728 12.728L5.636 5.636" />
                </svg>
              </div>
              <div className="ml-5 w-0 flex-1">
                <dl>
                  <dt className="text-sm font-medium text-gray-500 truncate">
                    {t('admin.apps.disabledApps', 'Disabled Apps')}
                  </dt>
                  <dd className="text-lg font-medium text-gray-900">
                    {apps.filter(app => !app.enabled).length}
                  </dd>
                </dl>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Apps table */}
      <div className="mt-8 flex flex-col">
        <div className="-my-2 -mx-4 overflow-x-auto sm:-mx-6 lg:-mx-8">
          <div className="inline-block min-w-full py-2 align-middle md:px-6 lg:px-8">
            <div className="overflow-hidden shadow ring-1 ring-black ring-opacity-5 md:rounded-lg">
              <table className="min-w-full divide-y divide-gray-300">
                <thead className="bg-gray-50">
                  <tr>
                    <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">
                      {t('admin.apps.table.app', 'App')}
                    </th>
                    <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">
                      {t('admin.apps.table.status', 'Status')}
                    </th>
                    <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">
                      {t('admin.apps.table.order', 'Order')}
                    </th>
                    <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">
                      {t('admin.apps.table.model', 'Model')}
                    </th>
                    <th scope="col" className="relative px-6 py-3">
                      <span className="sr-only">{t('admin.apps.table.actions', 'Actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {filteredApps.map((app) => (
                    <tr key={app.id} className="hover:bg-gray-50">
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="flex items-center">
                          <div className="flex-shrink-0 h-10 w-10">
                            <div 
                              className="h-10 w-10 rounded-full flex items-center justify-center text-white font-bold"
                              style={{ backgroundColor: app.color || '#6B7280' }}
                            >
                              {getLocalizedContent(app.name).charAt(0).toUpperCase()}
                            </div>
                          </div>
                          <div className="ml-4">
                            <div className="text-sm font-medium text-gray-900">
                              {getLocalizedContent(app.name)}
                            </div>
                            <div className="text-sm text-gray-500">
                              {app.id}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
                          app.enabled 
                            ? 'bg-green-100 text-green-800' 
                            : 'bg-red-100 text-red-800'
                        }`}>
                          {app.enabled 
                            ? t('admin.apps.status.enabled', 'Enabled')
                            : t('admin.apps.status.disabled', 'Disabled')
                          }
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                        {app.order ?? 'N/A'}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                        {app.preferredModel || 'N/A'}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                        <div className="flex justify-end space-x-2">
                          <button
                            onClick={() => navigate(`/admin/apps/${app.id}`)}
                            className="text-indigo-600 hover:text-indigo-900"
                          >
                            {t('admin.apps.actions.edit', 'Edit')}
                          </button>
                          <button
                            onClick={() => navigate(`/admin/apps/${app.id}/test`)}
                            className="text-green-600 hover:text-green-900"
                          >
                            {t('admin.apps.actions.test', 'Test')}
                          </button>
                          <button
                            onClick={() => toggleApp(app.id)}
                            className={`${
                              app.enabled 
                                ? 'text-red-600 hover:text-red-900' 
                                : 'text-green-600 hover:text-green-900'
                            }`}
                          >
                            {app.enabled 
                              ? t('admin.apps.actions.disable', 'Disable')
                              : t('admin.apps.actions.enable', 'Enable')
                            }
                          </button>
                          <button
                            onClick={() => deleteApp(app.id)}
                            className="text-red-600 hover:text-red-900"
                          >
                            {t('admin.apps.actions.delete', 'Delete')}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      {filteredApps.length === 0 && (
        <div className="text-center py-12">
          <svg className="mx-auto h-12 w-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
          </svg>
          <h3 className="mt-2 text-sm font-medium text-gray-900">
            {t('admin.apps.noApps', 'No apps found')}
          </h3>
          <p className="mt-1 text-sm text-gray-500">
            {t('admin.apps.noAppsDescription', 'Try adjusting your search or filter criteria.')}
          </p>
        </div>
      )}
    </div>
  );
};

export default AdminAppsPage;