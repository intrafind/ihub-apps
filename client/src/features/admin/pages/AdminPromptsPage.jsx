// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../../../utils/localizeContent';
import Icon from '../../../shared/components/Icon';
import PromptDetailsPopup from '../../prompts/components/PromptDetailsPopup';
import GlobalPromptVariablesEditor from '../components/GlobalPromptVariablesEditor';
import AdminUserPromptsTab from '../components/AdminUserPromptsTab';
import {
  fetchAdminPrompts,
  getAdminApiErrorMessage,
  makeAdminApiCall,
  togglePrompts
} from '../../../api/adminApi';
import { fetchUIConfig } from '../../../api';
import useFeatureFlags from '../../../shared/hooks/useFeatureFlags';
import { useFilterState } from '../hooks/useFilterState';
import { DataTable, SearchInput, FilterSelect } from '../components/data-table';
import UploadConfigButton from '../components/UploadConfigButton';
import AdminLoadError from '../components/AdminLoadError';
import AdminSaveBar from '../components/AdminSaveBar';
import UnsavedChangesDialog from '../components/UnsavedChangesDialog';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import { useConfirmAction } from '../hooks/useConfirmAction';
import { buildBulkToggleConfirm } from '../utils/bulkToggleConfirm';
import { deleteConfirmText } from '../utils/confirmText';
import { copyId } from '../utils/copyId';

function PromptNameCell({ prompt, currentLanguage }) {
  return (
    <div className="flex items-center">
      <div className="shrink-0 h-8 w-8">
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
  const { requestConfirm, dialogProps: confirmDialogProps } = useConfirmAction();
  const headingRef = useRef(null);
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const featureFlags = useFeatureFlags();

  const promptsLibraryEnabled = featureFlags.isEnabled('promptsLibrary', true);
  const defaultTab = promptsLibraryEnabled ? 'prompts' : 'variables';
  const [activeTab, setActiveTab] = useState(searchParams.get('tab') || defaultTab);

  const [prompts, setPrompts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchTerm, setSearchTerm] = useFilterState('q', '');
  const [filterEnabled, setFilterEnabled] = useFilterState('enabled', 'all');
  const [selectedCategory, setSelectedCategory] = useFilterState('category', 'all');
  const [selectedPrompt, setSelectedPrompt] = useState(null);
  const [showPromptDetails, setShowPromptDetails] = useState(false);
  const [uiConfig, setUiConfig] = useState(null);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    if (promptsLibraryEnabled) void loadPrompts();
    else setLoading(false);
    void loadUIConfig();
  }, [promptsLibraryEnabled]);

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

  const loadPrompts = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await fetchAdminPrompts();
      setPrompts(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(getAdminApiErrorMessage(err));
      setPrompts([]);
    } finally {
      setLoading(false);
    }
  };

  const handleTogglePrompt = async promptId => {
    try {
      const enabled = !prompts.find(p => p.id === promptId)?.enabled;
      await togglePrompts(promptId, enabled);
      await loadPrompts();
    } catch (err) {
      setError(getAdminApiErrorMessage(err));
    }
  };

  const promptName = prompt => getLocalizedContent(prompt.name, currentLanguage) || prompt.id;

  /**
   * Enable All / Disable All toggle every prompt (`*`) for every user, so they
   * open a confirmation naming the count and the prompts first (AI-B2).
   *
   * @param {boolean} enable - Target state.
   */
  const confirmToggleAll = enable => {
    requestConfirm({
      ...buildBulkToggleConfirm({
        items: prompts,
        enable,
        itemsLabel: t('admin.confirm.plural.prompts', 'prompts'),
        getName: promptName,
        t
      }),
      action: async () => {
        await togglePrompts('*', enable);
        await loadPrompts();
      }
    });
  };

  const handleDeletePrompt = prompt => {
    requestConfirm({
      ...deleteConfirmText({
        typeKey: 'prompt',
        typeFallback: 'prompt',
        name: promptName(prompt),
        t
      }),
      action: async () => {
        await makeAdminApiCall(`/admin/prompts/${prompt.id}`, { method: 'DELETE' });
        await loadPrompts();
        // The row's Delete button is gone: keep keyboard focus on the page.
        headingRef.current?.focus();
      }
    });
  };

  // The clone opens as a new prompt with the ID `<id>-copy` (or the next free one) proposed.
  const handleClonePrompt = prompt => {
    const cloneId = copyId(
      prompt.id,
      prompts.map(p => p.id)
    );
    navigate('/admin/prompts/new', { state: { templatePrompt: prompt, cloneId } });
  };

  const downloadPromptConfig = async promptId => {
    try {
      const response = await makeAdminApiCall(`/admin/prompts/${promptId}`);
      const prompt = response.data;
      const configData = JSON.stringify(prompt, null, 2);
      const blob = new Blob([configData], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `prompt-${promptId}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(t('admin.prompts.downloadError', { error: getAdminApiErrorMessage(err) }));
    }
  };

  const handleUploadConfig = async event => {
    const file = event.target.files[0];
    if (!file) return;
    if (!file.name.endsWith('.json')) {
      setError(t('admin.common.selectJsonFile', 'Please select a JSON file'));
      return;
    }
    setUploading(true);
    let promptConfig;
    try {
      const fileContent = await file.text();
      promptConfig = JSON.parse(fileContent);
      if (!promptConfig.id || !promptConfig.name || !promptConfig.prompt) {
        throw new Error('Invalid prompt config: missing required fields (id, name, prompt)');
      }
      await makeAdminApiCall('/admin/prompts', { method: 'POST', body: promptConfig });
      await loadPrompts();
      event.target.value = '';
    } catch (err) {
      if (getAdminApiErrorMessage(err).includes('already exists')) {
        setError(t('admin.prompts.uploadExists', { id: promptConfig?.id || 'unknown' }));
      } else if (err instanceof SyntaxError) {
        setError(t('admin.common.invalidJsonFile', 'Invalid JSON file format'));
      } else {
        setError(t('admin.prompts.uploadError', { error: getAdminApiErrorMessage(err) }));
      }
    } finally {
      setUploading(false);
    }
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
          <span className="text-gray-500 text-sm">{t('common.notAvailable', 'N/A')}</span>
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
          <Icon name="check" className="h-5 w-5 text-green-700" />
        ) : (
          <span className="text-gray-500">-</span>
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
      label: t('common.edit', 'Edit'),
      icon: 'pencil',
      priority: 'primary',
      onClick: p => navigate(`/admin/prompts/${p.id}`)
    },
    {
      id: 'toggle',
      label: t('admin.prompts.toggle', 'Toggle enabled'),
      icon: 'eye',
      priority: 'primary',
      onClick: p => handleTogglePrompt(p.id)
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
      onClick: p => handleDeletePrompt(p)
    }
  ];

  if (error) {
    return (
      <AdminLoadError
        title={t('admin.prompts.loadError', 'Error loading prompts')}
        message={error}
      />
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="sm:flex sm:items-center">
          <div className="sm:flex-auto">
            <h1
              ref={headingRef}
              tabIndex={-1}
              className="text-2xl font-semibold text-gray-900 dark:text-gray-100 focus:outline-hidden"
            >
              {activeTab === 'variables'
                ? t('admin.promptVariables.title', 'Global Prompt Variables')
                : activeTab === 'user'
                  ? t('admin.prompts.userPrompts.title', 'User Prompts')
                  : t('admin.prompts.title', 'Prompt Management')}
            </h1>
            <p className="mt-2 text-sm text-gray-700 dark:text-gray-300">
              {activeTab === 'variables'
                ? t(
                    'admin.promptVariables.subtitle',
                    'Manage custom variables for use across all apps and prompts'
                  )
                : activeTab === 'user'
                  ? t(
                      'admin.prompts.userPrompts.subtitle',
                      'Prompts your users wrote and shared with groups or everyone'
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
                  className="inline-flex items-center justify-center rounded-md border border-transparent bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-xs hover:bg-indigo-700 focus:outline-hidden focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 sm:w-auto"
                >
                  <Icon name="plus" className="h-4 w-4 mr-2" />
                  {t('admin.prompts.createNew', 'Create New Prompt')}
                </button>
                <UploadConfigButton
                  onChange={handleUploadConfig}
                  uploading={uploading}
                  title={t('admin.prompts.uploadConfigTitle', 'Upload Prompt Config')}
                  uploadingLabel={t('admin.prompts.uploading', 'Uploading...')}
                  label={t('admin.prompts.uploadConfig', 'Upload Config')}
                />
                <button
                  type="button"
                  className="inline-flex items-center justify-center rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 shadow-xs hover:bg-gray-50 dark:hover:bg-gray-600"
                  onClick={() => confirmToggleAll(true)}
                >
                  {t('admin.common.enableAll', 'Enable All')}
                </button>
                <button
                  type="button"
                  className="inline-flex items-center justify-center rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 shadow-xs hover:bg-gray-50 dark:hover:bg-gray-600"
                  onClick={() => confirmToggleAll(false)}
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
            {promptsLibraryEnabled && (
              <button
                onClick={() => setActiveTab('user')}
                className={`whitespace-nowrap pb-4 px-1 border-b-2 font-medium text-sm ${
                  activeTab === 'user'
                    ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 dark:text-gray-400 dark:hover:text-gray-300'
                }`}
              >
                <Icon name="users" className="inline-block h-5 w-5 mr-2" />
                {t('admin.prompts.tabs.userPrompts', 'User prompts')}
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
                        ? 'text-white shadow-sm'
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
                      className="inline-flex items-center px-4 py-2 border border-transparent shadow-xs text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
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
        ) : activeTab === 'user' && promptsLibraryEnabled ? (
          <AdminUserPromptsTab />
        ) : (
          <VariablesTabContent />
        )}
      </div>
      <ConfirmDialog {...confirmDialogProps} />
    </div>
  );
}

function VariablesTabContent() {
  const { t } = useTranslation();
  const [globalPromptVariables, setGlobalPromptVariables] = useState(null);
  // What the server has (loaded, or last saved): the bar shows while the form differs from it.
  const [savedVariables, setSavedVariables] = useState(null);
  // The revision of the configuration this form loaded (or last saved): its
  // save sends exactly this as If-Match, whatever other reads in the tab saw.
  const revisionRef = useRef(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const { blocker, markSaved, isDirty } = useUnsavedChanges(savedVariables, globalPromptVariables);

  useEffect(() => {
    void loadPlatformConfig();
  }, []);

  const loadPlatformConfig = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await makeAdminApiCall('/admin/configs/platform', {
        revision: revisionRef
      });
      const loaded = response.data.globalPromptVariables || { context: '', variables: {} };
      setSavedVariables(loaded);
      setGlobalPromptVariables(loaded);
    } catch (err) {
      console.error('Error loading platform config:', err);
      setError(getAdminApiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    try {
      setSaving(true);
      setError(null);
      // Only this section: the server keeps every section a save omits, while
      // echoing back the whole config read here would overwrite what the read
      // left out (the proxy JWT providers' `jwkUrl`, for one).
      await makeAdminApiCall('/admin/configs/platform', {
        method: 'POST',
        body: { globalPromptVariables },
        revision: revisionRef
      });
      markSaved();
      setSavedVariables(globalPromptVariables);
    } catch (err) {
      console.error('Error saving platform config:', err);
      // Shown in the page's error callout; no native alert on top of it.
      setError(getAdminApiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDiscard = () => {
    setGlobalPromptVariables(savedVariables);
    setError(null);
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
      <AdminLoadError
        title={t('admin.promptVariables.loadError', 'Error loading configuration')}
        message={error}
        framed={false}
        className="mt-8"
        action={{ label: t('common.retry', 'Retry'), onClick: loadPlatformConfig }}
      />
    );
  }

  return (
    <div className="mt-8">
      {error && (
        <AdminLoadError
          title={t('admin.promptVariables.error', 'Error')}
          message={error}
          framed={false}
          className="mb-4"
          action={null}
        />
      )}

      <GlobalPromptVariablesEditor
        value={globalPromptVariables}
        onChange={setGlobalPromptVariables}
      />

      <AdminSaveBar
        dirty={isDirty}
        saving={saving}
        message={error || undefined}
        onSave={handleSave}
        onDiscard={handleDiscard}
      />
      <UnsavedChangesDialog blocker={blocker} />
    </div>
  );
}

export default AdminPromptsPage;
