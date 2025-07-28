import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../../../utils/localizeContent';
import AppDetailsPopup from '../../apps/components/AppDetailsPopup';
import AppCreationWizard from '../../apps/components/AppCreationWizard';
import AppTemplateSelector from '../../apps/components/AppTemplateSelector';
import Icon from '../../../shared/components/Icon';
import AdminAuth from '../components/AdminAuth';
import AdminNavigation from '../components/AdminNavigation';
import { fetchAdminApps, makeAdminApiCall, toggleApps } from '../../../api/adminApi';
import { fetchUIConfig } from '../../../api';

const AdminAppsPage = () => {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const navigate = useNavigate();
  const [apps, setApps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterEnabled, setFilterEnabled] = useState('all'); // all, enabled, disabled
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [selectedApp, setSelectedApp] = useState(null);
  const [showAppDetails, setShowAppDetails] = useState(false);
  const [showCreationWizard, setShowCreationWizard] = useState(false);
  const [showTemplateSelector, setShowTemplateSelector] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState(null);
  const [uiConfig, setUiConfig] = useState(null);

  useEffect(() => {
    loadApps();
    loadUIConfig();
  }, []);

  const loadUIConfig = async () => {
    try {
      const config = await fetchUIConfig();
      setUiConfig(config);
    } catch (err) {
      console.error('Failed to load UI config:', err);
    }
  };

  const loadApps = async () => {
    try {
      setLoading(true);
      const data = await fetchAdminApps();
      setApps(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const toggleApp = async appId => {
    try {
      const response = await makeAdminApiCall(`/admin/apps/${appId}/toggle`, {
        method: 'POST'
      });

      const result = response.data;

      // Update the app in the local state
      setApps(prevApps =>
        prevApps.map(app => (app.id === appId ? { ...app, enabled: result.enabled } : app))
      );
    } catch (err) {
      setError(err.message);
    }
  };

  const enableAllApps = async () => {
    try {
      await toggleApps('*', true);
      setApps(prev => prev.map(app => ({ ...app, enabled: true })));
    } catch (err) {
      setError(err.message);
    }
  };

  const disableAllApps = async () => {
    try {
      await toggleApps('*', false);
      setApps(prev => prev.map(app => ({ ...app, enabled: false })));
    } catch (err) {
      setError(err.message);
    }
  };

  const deleteApp = async appId => {
    if (
      !window.confirm(t('admin.apps.deleteConfirm', 'Are you sure you want to delete this app?'))
    ) {
      return;
    }

    try {
      await makeAdminApiCall(`/admin/apps/${appId}`, {
        method: 'DELETE'
      });

      // Remove the app from the local state
      setApps(prevApps => prevApps.filter(app => app.id !== appId));
    } catch (err) {
      setError(err.message);
    }
  };

  // Filter apps based on search term, enabled status, and category
  const filteredApps = apps.filter(app => {
    const matchesSearch =
      getLocalizedContent(app.name, currentLanguage)
        .toLowerCase()
        .includes(searchTerm.toLowerCase()) ||
      getLocalizedContent(app.description, currentLanguage)
        .toLowerCase()
        .includes(searchTerm.toLowerCase()) ||
      app.id.toLowerCase().includes(searchTerm.toLowerCase());

    const matchesFilter =
      filterEnabled === 'all' ||
      (filterEnabled === 'enabled' && app.enabled) ||
      (filterEnabled === 'disabled' && !app.enabled);

    const matchesCategory =
      selectedCategory === 'all' || (app.category || 'utility') === selectedCategory;

    return matchesSearch && matchesFilter && matchesCategory;
  });

  const getLocalizedValue = content => {
    return getLocalizedContent(content, currentLanguage);
  };

  const handleAppClick = app => {
    setSelectedApp(app);
    setShowAppDetails(true);
  };

  const clearSearch = () => {
    setSearchTerm('');
  };

  const handleCreateApp = () => {
    setShowTemplateSelector(true);
  };

  const handleTemplateSelected = template => {
    setSelectedTemplate(template);
    setShowTemplateSelector(false);
    setShowCreationWizard(true);
  };

  const handleWizardClose = () => {
    setShowCreationWizard(false);
    setSelectedTemplate(null);
    // Reload apps to show any newly created app
    loadApps();
  };

  const handleCloneApp = app => {
    setSelectedTemplate(app);
    setShowCreationWizard(true);
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
                <path
                  fillRule="evenodd"
                  d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
                  clipRule="evenodd"
                />
              </svg>
            </div>
            <div className="ml-3">
              <h3 className="text-sm font-medium text-red-800">
                {t('admin.apps.errorTitle', 'Error')}
              </h3>
              <div className="mt-2 text-sm text-red-700">{error}</div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <AdminAuth>
      <AdminNavigation />
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
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="inline-flex items-center justify-center rounded-md border border-transparent bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 sm:w-auto"
                onClick={handleCreateApp}
              >
                <Icon name="plus" className="h-4 w-4 mr-2" />
                {t('admin.apps.createApp', 'Create App')}
              </button>
              <button
                type="button"
                className="inline-flex items-center justify-center rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50"
                onClick={enableAllApps}
              >
                {t('admin.common.enableAll', 'Enable All')}
              </button>
              <button
                type="button"
                className="inline-flex items-center justify-center rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50"
                onClick={disableAllApps}
              >
                {t('admin.common.disableAll', 'Disable All')}
              </button>
            </div>
          </div>
        </div>

        {/* Search and filter controls */}
        <div className="mt-6 flex flex-col sm:flex-row gap-4">
          <div className="flex-1 relative">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <Icon name="search" className="h-5 w-5 text-gray-400" />
            </div>
            <input
              type="text"
              placeholder={t('admin.apps.searchPlaceholder', 'Search apps...')}
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              className="block w-full pl-10 pr-10 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
              autoComplete="off"
            />
            {searchTerm && (
              <button
                onClick={clearSearch}
                className="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-400 hover:text-gray-600"
                aria-label={t('common.clearSearch', 'Clear search')}
              >
                <Icon name="x" className="h-5 w-5" />
              </button>
            )}
          </div>
          <div className="flex-shrink-0">
            <select
              value={filterEnabled}
              onChange={e => setFilterEnabled(e.target.value)}
              className="block w-full rounded-lg border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm py-2 px-3"
            >
              <option value="all">{t('admin.apps.filterAll', 'All Apps')}</option>
              <option value="enabled">{t('admin.apps.filterEnabled', 'Enabled Only')}</option>
              <option value="disabled">{t('admin.apps.filterDisabled', 'Disabled Only')}</option>
            </select>
          </div>
        </div>

        {/* Category filter */}
        {uiConfig?.appsList?.categories?.enabled && (
          <div className="mt-4 flex flex-wrap gap-2 justify-center">
            {uiConfig.appsList.categories.list.map(category => (
              <button
                key={category.id}
                onClick={() => setSelectedCategory(category.id)}
                className={`px-4 py-2 rounded-full text-sm font-medium transition-all ${
                  selectedCategory === category.id
                    ? 'text-white shadow-lg transform scale-105'
                    : 'text-gray-600 bg-gray-100 hover:bg-gray-200'
                }`}
                style={{
                  backgroundColor: selectedCategory === category.id ? category.color : undefined
                }}
              >
                {getLocalizedContent(category.name, currentLanguage)}
              </button>
            ))}
          </div>
        )}

        {/* Stats */}
        {/* <div className="mt-6 grid grid-cols-1 gap-5 sm:grid-cols-3">
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
      </div> */}

        {/* Apps table */}
        <div className="mt-8 flex flex-col">
          <div className="-my-2 -mx-4 sm:-mx-6 lg:-mx-8">
            <div className="inline-block w-full py-2 align-middle md:px-6 lg:px-8">
              <div className="overflow-hidden shadow ring-1 ring-black ring-opacity-5 md:rounded-lg">
                <table className="w-full divide-y divide-gray-300">
                  <thead className="bg-gray-50">
                    <tr>
                      <th
                        scope="col"
                        className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide"
                      >
                        {t('admin.apps.table.app', 'App')}
                      </th>
                      <th
                        scope="col"
                        className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide"
                      >
                        {t('admin.apps.table.category', 'Category')}
                      </th>
                      <th
                        scope="col"
                        className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide"
                      >
                        {t('admin.apps.table.status', 'Status')}
                      </th>
                      <th
                        scope="col"
                        className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide"
                      >
                        {t('admin.apps.table.order', 'Order')}
                      </th>
                      <th
                        scope="col"
                        className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide"
                      >
                        {t('admin.apps.table.model', 'Model')}
                      </th>
                      <th scope="col" className="relative px-6 py-3">
                        <span className="sr-only">{t('admin.apps.table.actions', 'Actions')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {filteredApps.map(app => (
                      <tr
                        key={app.id}
                        className="hover:bg-gray-50 cursor-pointer"
                        onClick={() => handleAppClick(app)}
                      >
                        <td className="px-6 py-4 whitespace-nowrap">
                          <div className="flex items-center">
                            <div className="flex-shrink-0 h-10 w-10">
                              <div
                                className="h-10 w-10 rounded-full flex items-center justify-center text-white font-bold"
                                style={{ backgroundColor: app.color || '#6B7280' }}
                              >
                                {getLocalizedValue(app.name).charAt(0).toUpperCase()}
                              </div>
                            </div>
                            <div className="ml-4">
                              <div className="text-sm font-medium text-gray-900">
                                {getLocalizedValue(app.name)}
                              </div>
                              <div className="text-sm text-gray-500">{app.id}</div>
                            </div>
                          </div>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          {app.category ? (
                            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-indigo-100 text-indigo-800">
                              {uiConfig?.appsList?.categories?.list?.find(
                                cat => cat.id === app.category
                              )?.name
                                ? getLocalizedContent(
                                    uiConfig.appsList.categories.list.find(
                                      cat => cat.id === app.category
                                    ).name,
                                    currentLanguage
                                  )
                                : app.category}
                            </span>
                          ) : (
                            <span className="text-gray-400 text-sm">
                              {t('common.notAvailable', 'N/A')}
                            </span>
                          )}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <span
                            className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
                              app.enabled
                                ? 'bg-green-100 text-green-800'
                                : 'bg-red-100 text-red-800'
                            }`}
                          >
                            {app.enabled
                              ? t('admin.apps.status.enabled', 'Enabled')
                              : t('admin.apps.status.disabled', 'Disabled')}
                          </span>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                          {app.order ?? t('common.notAvailable', 'N/A')}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                          {app.preferredModel || t('common.notAvailable', 'N/A')}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                          <div className="flex justify-end space-x-2">
                            <button
                              onClick={e => {
                                e.stopPropagation();
                                toggleApp(app.id);
                              }}
                              className={`p-2 rounded-full ${
                                app.enabled
                                  ? 'text-red-600 hover:bg-red-50'
                                  : 'text-green-600 hover:bg-green-50'
                              }`}
                              title={
                                app.enabled
                                  ? t('admin.apps.actions.disable', 'Disable')
                                  : t('admin.apps.actions.enable', 'Enable')
                              }
                            >
                              <Icon name={app.enabled ? 'eye-slash' : 'eye'} className="h-4 w-4" />
                            </button>
                            <button
                              onClick={e => {
                                e.stopPropagation();
                                handleCloneApp(app);
                              }}
                              className="p-2 text-blue-600 hover:bg-blue-50 rounded-full"
                              title={t('admin.apps.actions.clone', 'Clone')}
                            >
                              <Icon name="copy" className="h-4 w-4" />
                            </button>
                            <button
                              onClick={e => {
                                e.stopPropagation();
                                navigate(`/admin/apps/${app.id}`);
                              }}
                              className="p-2 text-indigo-600 hover:bg-indigo-50 rounded-full"
                              title={t('admin.apps.actions.edit', 'Edit')}
                            >
                              <Icon name="pencil" className="h-4 w-4" />
                            </button>
                            <button
                              onClick={e => {
                                e.stopPropagation();
                                deleteApp(app.id);
                              }}
                              className="p-2 text-red-600 hover:bg-red-50 rounded-full"
                              title={t('admin.apps.actions.delete', 'Delete')}
                            >
                              <Icon name="trash" className="h-4 w-4" />
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
            <svg
              className="mx-auto h-12 w-12 text-gray-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
              />
            </svg>
            <h3 className="mt-2 text-sm font-medium text-gray-900">
              {t('admin.apps.noApps', 'No apps found')}
            </h3>
            <p className="mt-1 text-sm text-gray-500">
              {t('admin.apps.noAppsDescription', 'Try adjusting your search or filter criteria.')}
            </p>
          </div>
        )}

        {/* App Details Popup */}
        <AppDetailsPopup
          app={selectedApp}
          isOpen={showAppDetails}
          onClose={() => setShowAppDetails(false)}
        />

        {/* Template Selector */}
        {showTemplateSelector && (
          <AppTemplateSelector
            onSelect={handleTemplateSelected}
            onClose={() => setShowTemplateSelector(false)}
          />
        )}

        {/* App Creation Wizard */}
        {showCreationWizard && (
          <AppCreationWizard templateApp={selectedTemplate} onClose={handleWizardClose} />
        )}
      </div>
    </AdminAuth>
  );
};

export default AdminAppsPage;
