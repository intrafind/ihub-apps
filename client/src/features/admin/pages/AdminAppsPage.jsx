import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useFilterState } from '../hooks/useFilterState';
import { getLocalizedContent } from '../../../utils/localizeContent';
import AppDetailsPopup from '../../apps/components/AppDetailsPopup';
import AppCreationWizard from '../../apps/components/AppCreationWizard';
import AppTemplateSelector from '../../apps/components/AppTemplateSelector';
import Icon from '../../../shared/components/Icon';
import {
  fetchAdminApps,
  getAdminApiErrorMessage,
  makeAdminApiCall,
  toggleApps
} from '../../../api/adminApi';
import { fetchUIConfig } from '../../../api';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import { DataTable, SearchInput, FilterSelect } from '../components/data-table';

function AppNameCell({ app, currentLanguage }) {
  return (
    <div className="flex items-center">
      <div className="flex-shrink-0 h-10 w-10">
        <div
          className="h-10 w-10 rounded-full flex items-center justify-center text-white font-bold"
          style={{ backgroundColor: app.color || '#6B7280' }}
        >
          {getLocalizedContent(app.name, currentLanguage).charAt(0).toUpperCase()}
        </div>
      </div>
      <div className="ml-3 min-w-0">
        <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
          {getLocalizedContent(app.name, currentLanguage)}
        </div>
        <div className="text-xs text-gray-500 dark:text-gray-400 truncate">{app.id}</div>
      </div>
    </div>
  );
}

function AdminAppsPage() {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const navigate = useNavigate();
  const [apps, setApps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchTerm, setSearchTerm] = useFilterState('q', '');
  const [filterEnabled, setFilterEnabled] = useFilterState('enabled', 'all');
  const [selectedCategory, setSelectedCategory] = useFilterState('category', 'all');
  const [selectedApp, setSelectedApp] = useState(null);
  const [showAppDetails, setShowAppDetails] = useState(false);
  const [showCreationWizard, setShowCreationWizard] = useState(false);
  const [showTemplateSelector, setShowTemplateSelector] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState(null);
  const [uiConfig, setUiConfig] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState(null);

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
      setError(getAdminApiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const toggleApp = async appId => {
    try {
      const response = await makeAdminApiCall(`/admin/apps/${appId}/toggle`, { method: 'POST' });
      const result = response.data;
      setApps(prev =>
        prev.map(app => (app.id === appId ? { ...app, enabled: result.enabled } : app))
      );
    } catch (err) {
      setError(getAdminApiErrorMessage(err));
    }
  };

  const enableAllApps = async () => {
    try {
      await toggleApps('*', true);
      setApps(prev => prev.map(app => ({ ...app, enabled: true })));
    } catch (err) {
      setError(getAdminApiErrorMessage(err));
    }
  };

  const disableAllApps = async () => {
    try {
      await toggleApps('*', false);
      setApps(prev => prev.map(app => ({ ...app, enabled: false })));
    } catch (err) {
      setError(getAdminApiErrorMessage(err));
    }
  };

  const deleteApp = appId => {
    setConfirmDialog({
      title: t('admin.apps.deleteTitle', 'Delete App'),
      message: t('admin.apps.deleteConfirm', 'Are you sure you want to delete this app?'),
      danger: true,
      onConfirm: async () => {
        setConfirmDialog(null);
        try {
          await makeAdminApiCall(`/admin/apps/${appId}`, { method: 'DELETE' });
          setApps(prev => prev.filter(app => app.id !== appId));
        } catch (err) {
          setError(getAdminApiErrorMessage(err));
        }
      }
    });
  };

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

  const handleCreateApp = () => setShowTemplateSelector(true);

  const handleTemplateSelected = template => {
    setSelectedTemplate(template);
    setShowTemplateSelector(false);
    setShowCreationWizard(true);
  };

  const handleWizardClose = () => {
    setShowCreationWizard(false);
    setSelectedTemplate(null);
    loadApps();
  };

  const handleCloneApp = app => {
    setSelectedTemplate(app);
    setShowCreationWizard(true);
  };

  const downloadAppConfig = async appId => {
    try {
      const response = await makeAdminApiCall(`/admin/apps/${appId}`);
      const app = response.data;
      const configData = JSON.stringify(app, null, 2);
      const blob = new Blob([configData], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `app-${appId}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(`Failed to download app config: ${getAdminApiErrorMessage(err)}`);
    }
  };

  const handleUploadConfig = async event => {
    const file = event.target.files[0];
    if (!file) return;
    if (!file.name.endsWith('.json')) {
      setError('Please select a JSON file');
      return;
    }
    setUploading(true);
    let appConfig;
    try {
      const fileContent = await file.text();
      appConfig = JSON.parse(fileContent);
      if (!appConfig.id || !appConfig.name || !appConfig.description) {
        throw new Error('Invalid app config: missing required fields (id, name, description)');
      }
      await makeAdminApiCall('/admin/apps', { method: 'POST', body: appConfig });
      await loadApps();
      event.target.value = '';
    } catch (err) {
      if (getAdminApiErrorMessage(err).includes('already exists')) {
        setError(`App with ID "${appConfig?.id || 'unknown'}" already exists`);
      } else if (err instanceof SyntaxError) {
        setError('Invalid JSON file format');
      } else {
        setError(`Failed to upload app config: ${getAdminApiErrorMessage(err)}`);
      }
    } finally {
      setUploading(false);
    }
  };

  const getCategoryLabel = app => {
    if (!app.category) return null;
    const found = uiConfig?.appsList?.categories?.list?.find(cat => cat.id === app.category);
    return found ? getLocalizedContent(found.name, currentLanguage) : app.category;
  };

  const columns = [
    {
      key: 'app',
      header: t('admin.apps.table.app', 'App'),
      sortable: true,
      sortAccessor: app => getLocalizedContent(app.name, currentLanguage),
      render: app => <AppNameCell app={app} currentLanguage={currentLanguage} />
    },
    {
      key: 'category',
      header: t('admin.apps.table.category', 'Category'),
      sortable: true,
      sortAccessor: app => app.category || '',
      hideBelow: 'md',
      render: app => {
        const label = getCategoryLabel(app);
        return label ? (
          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-indigo-100 dark:bg-indigo-900/50 text-indigo-800 dark:text-indigo-300">
            {label}
          </span>
        ) : (
          <span className="text-gray-400 text-sm">{t('common.notAvailable', 'N/A')}</span>
        );
      }
    },
    {
      key: 'status',
      header: t('admin.apps.table.status', 'Status'),
      sortable: true,
      sortAccessor: app => (app.enabled ? 1 : 0),
      render: app => (
        <span
          className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
            app.enabled
              ? 'bg-green-100 dark:bg-green-900/50 text-green-800 dark:text-green-300'
              : 'bg-red-100 dark:bg-red-900/50 text-red-800 dark:text-red-300'
          }`}
        >
          {app.enabled
            ? t('admin.apps.status.enabled', 'Enabled')
            : t('admin.apps.status.disabled', 'Disabled')}
        </span>
      )
    },
    {
      key: 'order',
      header: t('admin.apps.table.order', 'Order'),
      sortable: true,
      hideBelow: 'lg',
      align: 'right',
      render: app => app.order ?? t('common.notAvailable', 'N/A')
    },
    {
      key: 'preferredModel',
      header: t('admin.apps.table.model', 'Model'),
      hideBelow: 'lg',
      render: app => app.preferredModel || t('common.notAvailable', 'N/A')
    }
  ];

  const actions = [
    {
      id: 'edit',
      label: t('admin.apps.actions.edit', 'Edit'),
      icon: 'pencil',
      priority: 'primary',
      onClick: app => navigate(`/admin/apps/${app.id}`)
    },
    {
      id: 'toggle',
      label: t('admin.apps.actions.toggle', 'Toggle enabled'),
      icon: 'eye',
      priority: 'primary',
      onClick: app => toggleApp(app.id)
    },
    {
      id: 'clone',
      label: t('admin.apps.actions.clone', 'Clone'),
      icon: 'copy',
      onClick: app => handleCloneApp(app)
    },
    {
      id: 'download',
      label: t('admin.apps.actions.download', 'Download Config'),
      icon: 'download',
      onClick: app => downloadAppConfig(app.id)
    },
    {
      id: 'delete',
      label: t('admin.apps.actions.delete', 'Delete'),
      icon: 'trash',
      destructive: true,
      onClick: app => deleteApp(app.id)
    }
  ];

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="sm:flex sm:items-center">
        <div className="sm:flex-auto">
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
            {t('admin.apps.title', 'Apps Administration')}
          </h1>
          <p className="mt-2 text-sm text-gray-700 dark:text-gray-300">
            {t('admin.apps.subtitle', 'Manage your iHub applications')}
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
            <div className="relative">
              <input
                type="file"
                accept=".json"
                onChange={handleUploadConfig}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                disabled={uploading}
              />
              <button
                type="button"
                className="inline-flex items-center justify-center rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 shadow-sm hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={uploading}
                title={t('admin.apps.uploadConfig', 'Upload App Config')}
              >
                <Icon
                  name={uploading ? 'refresh' : 'upload'}
                  className={`h-4 w-4 mr-2 ${uploading ? 'animate-spin' : ''}`}
                />
                {uploading
                  ? t('admin.apps.uploading', 'Uploading...')
                  : t('admin.apps.uploadConfig', 'Upload Config')}
              </button>
            </div>
            <button
              type="button"
              className="inline-flex items-center justify-center rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 shadow-sm hover:bg-gray-50 dark:hover:bg-gray-600"
              onClick={enableAllApps}
            >
              {t('admin.common.enableAll', 'Enable All')}
            </button>
            <button
              type="button"
              className="inline-flex items-center justify-center rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 shadow-sm hover:bg-gray-50 dark:hover:bg-gray-600"
              onClick={disableAllApps}
            >
              {t('admin.common.disableAll', 'Disable All')}
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="mt-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md p-4 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <SearchInput
          value={searchTerm}
          onChange={setSearchTerm}
          placeholder={t('admin.apps.searchPlaceholder', 'Search apps...')}
        />
        <FilterSelect
          label={t('admin.apps.statusLabel', 'Status')}
          value={filterEnabled}
          onChange={setFilterEnabled}
          options={[
            { value: 'all', label: t('admin.apps.filterAll', 'All Apps') },
            { value: 'enabled', label: t('admin.apps.filterEnabled', 'Enabled Only') },
            { value: 'disabled', label: t('admin.apps.filterDisabled', 'Disabled Only') }
          ]}
        />
      </div>

      {uiConfig?.appsList?.categories?.enabled && (
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            onClick={() => setSelectedCategory('all')}
            className={`px-3 py-1.5 rounded-full text-sm font-medium transition-all ${
              selectedCategory === 'all'
                ? 'bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900'
                : 'text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600'
            }`}
          >
            {t('admin.apps.allCategories', 'All Categories')}
          </button>
          {uiConfig.appsList.categories.list.map(category => (
            <button
              key={category.id}
              onClick={() => setSelectedCategory(category.id)}
              className={`px-3 py-1.5 rounded-full text-sm font-medium transition-all ${
                selectedCategory === category.id
                  ? 'text-white shadow'
                  : 'text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600'
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

      <div className="mt-6">
        <DataTable
          columns={columns}
          data={filteredApps}
          getRowId={app => app.id}
          actions={actions}
          loading={loading}
          onRowClick={app => {
            setSelectedApp(app);
            setShowAppDetails(true);
          }}
          empty={{
            icon: 'sparkles',
            title: t('admin.apps.noApps', 'No apps found'),
            description: t(
              'admin.apps.noAppsDescription',
              'Try adjusting your search or filter criteria.'
            ),
            action: (
              <button
                onClick={handleCreateApp}
                className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
              >
                <Icon name="plus" className="h-4 w-4 mr-2" />
                {t('admin.apps.createApp', 'Create App')}
              </button>
            )
          }}
        />
      </div>

      <AppDetailsPopup
        app={selectedApp}
        isOpen={showAppDetails}
        onClose={() => setShowAppDetails(false)}
      />

      {showTemplateSelector && (
        <AppTemplateSelector
          onSelect={handleTemplateSelected}
          onClose={() => setShowTemplateSelector(false)}
        />
      )}

      {showCreationWizard && (
        <AppCreationWizard templateApp={selectedTemplate} onClose={handleWizardClose} />
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

export default AdminAppsPage;
