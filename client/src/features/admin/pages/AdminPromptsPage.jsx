import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../../../utils/localizeContent';
import Icon from '../../../shared/components/Icon';
import PromptDetailsPopup from '../../prompts/components/PromptDetailsPopup';
import GlobalPromptVariablesEditor from '../components/GlobalPromptVariablesEditor';
import { fetchAdminPrompts, makeAdminApiCall, togglePrompts } from '../../../api/adminApi';
import { fetchUIConfig } from '../../../api';
import useFeatureFlags from '../../../shared/hooks/useFeatureFlags';
import { useFilterState } from '../hooks/useFilterState';
import { useAdminResourceList } from '../hooks/useAdminResourceList';
import { DataTable, SearchInput, FilterSelect } from '../components/data-table';

function PromptNameCell({ prompt, currentLanguage }) {
  return (
    <div className="flex items-center">
      <div className="flex-shrink-0 h-8 w-8">
        <div className="h-8 w-8 rounded-full bg-indigo-100 dark:bg-indigo-900/50 flex items-center justify-center">
          <Icon
            name={prompt.icon || 'clipboard'}
            className="h-4 w-4 text-indigo-600 dark:text-indigo-400"
          />
        </div>
      </div>
      <div className="ml-3 min-w-0">
        <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
          {getLocalizedContent(prompt.name, currentLanguage)}
        </div>
        <div className="text-xs text-gray-500 dark:text-gray-400 truncate">{prompt.id}</div>
      </div>
    </div>
  );
}

function AdminPromptsPage() {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const featureFlags = useFeatureFlags();

  const promptsLibraryEnabled = featureFlags.isEnabled('promptsLibrary', true);
  const defaultTab = promptsLibraryEnabled ? 'prompts' : 'variables';
  const [activeTab, setActiveTab] = useState(searchParams.get('tab') || defaultTab);

  const {
    items: prompts,
    loading,
    error,
    uploading,
    toggleOne: toggleOnePrompt,
    toggleAll,
    remove: removePrompt,
    downloadConfig: downloadPromptConfig,
    uploadConfig: handleUploadConfig
  } = useAdminResourceList({
    fetchFn: fetchAdminPrompts,
    toggleAllFn: togglePrompts,
    resourcePath: 'prompts',
    resourceLabel: 'prompt',
    requiredFields: ['id', 'name', 'prompt'],
    autoLoad: promptsLibraryEnabled
  });
  const [searchTerm, setSearchTerm] = useFilterState('q', '');
  const [filterEnabled, setFilterEnabled] = useFilterState('enabled', 'all');
  const [selectedCategory, setSelectedCategory] = useFilterState('category', 'all');
  const [selectedPrompt, setSelectedPrompt] = useState(null);
  const [showPromptDetails, setShowPromptDetails] = useState(false);
  const [uiConfig, setUiConfig] = useState(null);

  useEffect(() => {
    loadUIConfig();
  }, []);

  useEffect(() => {
    setSearchParams(
      prev => {
        const next = new URLSearchParams(prev);
        if (activeTab) next.set('tab', activeTab);
        else next.delete('tab');
        return next;
      },
      { replace: true }
    );
  }, [activeTab, setSearchParams]);

  const loadUIConfig = async () => {
    try {
      const config = await fetchUIConfig();
      setUiConfig(config);
    } catch (err) {
      console.error('Failed to load UI config:', err);
    }
  };

  const enableAllPrompts = () => toggleAll(true);
  const disableAllPrompts = () => toggleAll(false);

  const handleDeletePrompt = async promptId => {
    if (
      !confirm(t('admin.prompts.deleteConfirm', 'Are you sure you want to delete this prompt?'))
    ) {
      return;
    }
    try {
      await removePrompt(promptId);
    } catch (err) {
      alert(err.message || 'Failed to delete prompt');
    }
  };

  const handleClonePrompt = prompt => {
    navigate('/admin/prompts/new', { state: { templatePrompt: prompt } });
  };

  const filteredPrompts = prompts.filter(prompt => {
    const matchesSearch =
      searchTerm === '' ||
      getLocalizedContent(prompt.name, currentLanguage)
        .toLowerCase()
        .includes(searchTerm.toLowerCase()) ||
      getLocalizedContent(prompt.prompt, currentLanguage)
        .toLowerCase()
        .includes(searchTerm.toLowerCase()) ||
      (prompt.description &&
        getLocalizedContent(prompt.description, currentLanguage)
          .toLowerCase()
          .includes(searchTerm.toLowerCase())) ||
      prompt.id.toLowerCase().includes(searchTerm.toLowerCase());

    const matchesFilter =
      filterEnabled === 'all' ||
      (filterEnabled === 'enabled' && prompt.enabled !== false) ||
      (filterEnabled === 'disabled' && prompt.enabled === false);

    const matchesCategory =
      selectedCategory === 'all' || (prompt.category || 'creative') === selectedCategory;

    return matchesSearch && matchesFilter && matchesCategory;
  });

  const getCategoryLabel = prompt => {
    if (!prompt.category) return null;
    const found = uiConfig?.promptsList?.categories?.list?.find(cat => cat.id === prompt.category);
    return found ? getLocalizedContent(found.name, currentLanguage) : prompt.category;
  };

  const columns = [
    {
      key: 'name',
      header: t('admin.prompts.table.name', 'Name'),
      sortable: true,
      sortAccessor: prompt => getLocalizedContent(prompt.name, currentLanguage),
      render: prompt => <PromptNameCell prompt={prompt} currentLanguage={currentLanguage} />
    },
    {
      key: 'category',
      header: t('admin.prompts.table.category', 'Category'),
      sortable: true,
      sortAccessor: prompt => prompt.category || '',
      hideBelow: 'md',
      render: prompt => {
        const label = getCategoryLabel(prompt);
        return label ? (
          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-purple-100 dark:bg-purple-900/50 text-purple-800 dark:text-purple-300">
            {label}
          </span>
        ) : (
          <span className="text-gray-400 text-sm">{t('common.notAvailable', 'N/A')}</span>
        );
      }
    },
    {
      key: 'description',
      header: t('admin.prompts.table.description', 'Description'),
      hideBelow: 'lg',
      truncate: true,
      render: prompt =>
        prompt.description ? getLocalizedContent(prompt.description, currentLanguage) : '-'
    },
    {
      key: 'order',
      header: t('admin.prompts.table.order', 'Order'),
      sortable: true,
      hideBelow: 'xl',
      align: 'right',
      render: prompt => (prompt.order !== undefined ? prompt.order : '-')
    },
    {
      key: 'appConnected',
      header: t('admin.prompts.table.appConnected', 'App Connected'),
      hideBelow: 'xl',
      align: 'center',
      render: prompt =>
        prompt.appId ? (
          <Icon name="check" className="h-5 w-5 text-green-600" />
        ) : (
          <span className="text-gray-400">-</span>
        )
    },
    {
      key: 'status',
      header: t('admin.prompts.table.status', 'Status'),
      sortable: true,
      sortAccessor: prompt => (prompt.enabled !== false ? 1 : 0),
      render: prompt => (
        <span
          className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
            prompt.enabled !== false
              ? 'bg-green-100 dark:bg-green-900/50 text-green-800 dark:text-green-300'
              : 'bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-300'
          }`}
        >
          {prompt.enabled !== false
            ? t('admin.prompts.enabled', 'Enabled')
            : t('admin.prompts.disabled', 'Disabled')}
        </span>
      )
    }
  ];

  const actions = [
    {
      id: 'edit',
      label: t('admin.prompts.edit', 'Edit'),
      icon: 'pencil',
      priority: 'primary',
      onClick: p => navigate(`/admin/prompts/${p.id}`)
    },
    {
      id: 'toggle',
      label: t('admin.prompts.toggle', 'Toggle enabled'),
      icon: 'eye',
      priority: 'primary',
      onClick: p => toggleOnePrompt(p.id)
    },
    {
      id: 'clone',
      label: t('admin.prompts.clone', 'Clone'),
      icon: 'copy',
      onClick: p => handleClonePrompt(p)
    },
    {
      id: 'download',
      label: t('admin.prompts.download', 'Download Config'),
      icon: 'download',
      onClick: p => downloadPromptConfig(p.id)
    },
    {
      id: 'delete',
      label: t('admin.prompts.delete', 'Delete'),
      icon: 'trash',
      destructive: true,
      onClick: p => handleDeletePrompt(p.id)
    }
  ];

  if (error) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-md p-4">
          <div className="flex">
            <Icon name="exclamation-triangle" className="h-5 w-5 text-red-400" />
            <div className="ml-3">
              <h3 className="text-sm font-medium text-red-800 dark:text-red-200">
                {t('admin.prompts.loadError', 'Error loading prompts')}
              </h3>
              <p className="mt-1 text-sm text-red-700 dark:text-red-300">{error}</p>
              <button
                onClick={() => window.location.reload()}
                className="mt-2 text-sm text-red-600 dark:text-red-400 hover:text-red-500 dark:hover:text-red-300"
              >
                {t('common.retry', 'Retry')}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="sm:flex sm:items-center">
          <div className="sm:flex-auto">
            <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
              {activeTab === 'variables'
                ? t('admin.promptVariables.title', 'Global Prompt Variables')
                : t('admin.prompts.title', 'Prompt Management')}
            </h1>
            <p className="mt-2 text-sm text-gray-700 dark:text-gray-300">
              {activeTab === 'variables'
                ? t(
                    'admin.promptVariables.subtitle',
                    'Manage custom variables for use across all apps and prompts'
                  )
                : t(
                    'admin.prompts.subtitle',
                    'Create, edit, and manage prompts for your iHub Apps'
                  )}
            </p>
          </div>
          {activeTab === 'prompts' && (
            <div className="mt-4 sm:mt-0 sm:ml-16 sm:flex-none">
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => navigate('/admin/prompts/new')}
                  className="inline-flex items-center justify-center rounded-md border border-transparent bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 sm:w-auto"
                >
                  <Icon name="plus" className="h-4 w-4 mr-2" />
                  {t('admin.prompts.createNew', 'Create New Prompt')}
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
                    title={t('admin.prompts.uploadConfig', 'Upload Prompt Config')}
                  >
                    <Icon
                      name={uploading ? 'refresh' : 'upload'}
                      className={`h-4 w-4 mr-2 ${uploading ? 'animate-spin' : ''}`}
                    />
                    {uploading
                      ? t('admin.prompts.uploading', 'Uploading...')
                      : t('admin.prompts.uploadConfig', 'Upload Config')}
                  </button>
                </div>
                <button
                  type="button"
                  className="inline-flex items-center justify-center rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 shadow-sm hover:bg-gray-50 dark:hover:bg-gray-600"
                  onClick={enableAllPrompts}
                >
                  {t('admin.common.enableAll', 'Enable All')}
                </button>
                <button
                  type="button"
                  className="inline-flex items-center justify-center rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 shadow-sm hover:bg-gray-50 dark:hover:bg-gray-600"
                  onClick={disableAllPrompts}
                >
                  {t('admin.common.disableAll', 'Disable All')}
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="mt-6 border-b border-gray-200 dark:border-gray-700">
          <nav className="-mb-px flex space-x-8">
            {promptsLibraryEnabled && (
              <button
                onClick={() => setActiveTab('prompts')}
                className={`whitespace-nowrap pb-4 px-1 border-b-2 font-medium text-sm ${
                  activeTab === 'prompts'
                    ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 dark:text-gray-400 dark:hover:text-gray-300'
                }`}
              >
                <Icon name="clipboard" className="inline-block h-5 w-5 mr-2" />
                {t('admin.prompts.tabs.prompts', 'Prompts')}
              </button>
            )}
            <button
              onClick={() => setActiveTab('variables')}
              className={`whitespace-nowrap pb-4 px-1 border-b-2 font-medium text-sm ${
                activeTab === 'variables'
                  ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 dark:text-gray-400 dark:hover:text-gray-300'
              }`}
            >
              <Icon name="sliders" className="inline-block h-5 w-5 mr-2" />
              {t('admin.prompts.tabs.variables', 'Variables')}
            </button>
          </nav>
        </div>

        {activeTab === 'prompts' ? (
          <>
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <SearchInput
                value={searchTerm}
                onChange={setSearchTerm}
                placeholder={t('admin.prompts.searchPlaceholder', 'Search prompts...')}
              />
              <FilterSelect
                label={t('admin.prompts.statusLabel', 'Status')}
                value={filterEnabled}
                onChange={setFilterEnabled}
                options={[
                  { value: 'all', label: t('admin.prompts.filterAll', 'All Prompts') },
                  { value: 'enabled', label: t('admin.prompts.filterEnabled', 'Enabled Only') },
                  { value: 'disabled', label: t('admin.prompts.filterDisabled', 'Disabled Only') }
                ]}
              />
            </div>

            {uiConfig?.promptsList?.categories?.enabled && (
              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  onClick={() => setSelectedCategory('all')}
                  className={`px-3 py-1.5 rounded-full text-sm font-medium transition-all ${
                    selectedCategory === 'all'
                      ? 'bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900'
                      : 'text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600'
                  }`}
                >
                  {t('admin.prompts.allCategories', 'All Categories')}
                </button>
                {uiConfig.promptsList.categories.list.map(category => (
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
                data={filteredPrompts}
                getRowId={p => p.id}
                actions={actions}
                loading={loading}
                onRowClick={prompt => {
                  setSelectedPrompt(prompt);
                  setShowPromptDetails(true);
                }}
                empty={{
                  icon: 'document-text',
                  title: t('admin.prompts.noPrompts', 'No prompts found'),
                  description: t(
                    'admin.prompts.noPromptsDesc',
                    'Get started by creating a new prompt.'
                  ),
                  action: (
                    <button
                      onClick={() => navigate('/admin/prompts/new')}
                      className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
                    >
                      <Icon name="plus" className="h-4 w-4 mr-2" />
                      {t('admin.prompts.createNew', 'Create New Prompt')}
                    </button>
                  )
                }}
              />
            </div>

            <PromptDetailsPopup
              prompt={selectedPrompt}
              isOpen={showPromptDetails}
              onClose={() => setShowPromptDetails(false)}
            />
          </>
        ) : (
          <VariablesTabContent />
        )}
      </div>
    </div>
  );
}

function VariablesTabContent() {
  const { t } = useTranslation();
  const [platformConfig, setPlatformConfig] = useState(null);
  const [globalPromptVariables, setGlobalPromptVariables] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    loadPlatformConfig();
  }, []);

  const loadPlatformConfig = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await makeAdminApiCall('/admin/configs/platform');
      setPlatformConfig(response.data);
      setGlobalPromptVariables(
        response.data.globalPromptVariables || { context: '', variables: {} }
      );
    } catch (err) {
      console.error('Error loading platform config:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleVariablesChange = updatedVariables => {
    setGlobalPromptVariables(updatedVariables);
    setHasChanges(true);
  };

  const handleSave = async () => {
    try {
      setSaving(true);
      setError(null);
      const updatedConfig = { ...platformConfig, globalPromptVariables };
      await makeAdminApiCall('/admin/configs/platform', {
        method: 'PUT',
        body: updatedConfig
      });
      setPlatformConfig(updatedConfig);
      setHasChanges(false);
    } catch (err) {
      console.error('Error saving platform config:', err);
      setError(err.message);
      alert(err.message || 'Failed to save global prompt variables');
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    if (platformConfig) {
      setGlobalPromptVariables(
        platformConfig.globalPromptVariables || { context: '', variables: {} }
      );
      setHasChanges(false);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center h-64 mt-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600 dark:border-indigo-400"></div>
      </div>
    );
  }

  if (error && !globalPromptVariables) {
    return (
      <div className="mt-8 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-md p-4">
        <div className="flex">
          <Icon name="exclamation-triangle" className="h-5 w-5 text-red-400" />
          <div className="ml-3">
            <h3 className="text-sm font-medium text-red-800 dark:text-red-200">
              {t('admin.promptVariables.loadError', 'Error loading configuration')}
            </h3>
            <p className="mt-1 text-sm text-red-700 dark:text-red-300">{error}</p>
            <button
              onClick={loadPlatformConfig}
              className="mt-2 text-sm text-red-600 dark:text-red-400 hover:text-red-500 dark:hover:text-red-300"
            >
              {t('common.retry', 'Retry')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-8">
      {error && (
        <div className="mb-4 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-md p-4">
          <div className="flex">
            <Icon name="exclamation-triangle" className="h-5 w-5 text-red-400" />
            <div className="ml-3">
              <h3 className="text-sm font-medium text-red-800 dark:text-red-200">
                {t('admin.promptVariables.error', 'Error')}
              </h3>
              <p className="mt-1 text-sm text-red-700 dark:text-red-300">{error}</p>
            </div>
          </div>
        </div>
      )}

      <GlobalPromptVariablesEditor value={globalPromptVariables} onChange={handleVariablesChange} />

      <div className="mt-6 flex justify-end gap-3">
        <button
          onClick={handleCancel}
          disabled={!hasChanges || saving}
          className="px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm text-sm font-medium text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {t('common.cancel', 'Cancel')}
        </button>
        <button
          onClick={handleSave}
          disabled={!hasChanges || saving}
          className="px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center"
        >
          {saving && <Icon name="refresh" className="animate-spin h-4 w-4 mr-2" />}
          {t('common.save', 'Save Changes')}
        </button>
      </div>
    </div>
  );
}

export default AdminPromptsPage;
