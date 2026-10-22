// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useFilterState } from '../hooks/useFilterState';
import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../../../utils/localizeContent';
import Icon from '../../../shared/components/Icon';
import {
  deleteTool,
  fetchAdminTools,
  getAdminApiErrorMessage,
  makeAdminApiCall,
  toggleTool
} from '../../../api/adminApi';
import { DataTable, SearchInput, FilterSelect } from '../components/data-table';
import UploadConfigButton from '../components/UploadConfigButton';
import AdminLoadError from '../components/AdminLoadError';

function ToolNameCell({ tool, currentLanguage }) {
  const iconName = tool.functions ? 'layers' : tool.isSpecialTool ? 'star' : 'wrench';
  return (
    <div className="flex items-center">
      <div className="shrink-0 h-8 w-8">
        <div className="h-8 w-8 rounded-full bg-indigo-100 dark:bg-indigo-900/50 flex items-center justify-center">
          <Icon name={iconName} className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
        </div>
      </div>
      <div className="ml-3 min-w-0">
        <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
          {getLocalizedContent(tool.name, currentLanguage)}
        </div>
        <div className="text-xs text-gray-500 dark:text-gray-400 truncate">{tool.id}</div>
      </div>
    </div>
  );
}

function getToolType(tool) {
  if (tool.isSpecialTool || tool.provider) return 'special';
  if (tool.functions && Object.keys(tool.functions).length > 0) return 'multi-function';
  return 'regular';
}

function AdminToolsPage() {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const navigate = useNavigate();
  const [tools, setTools] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchTerm, setSearchTerm] = useFilterState('q', '');
  const [filterEnabled, setFilterEnabled] = useFilterState('enabled', 'all');
  const [filterType, setFilterType] = useFilterState('type', 'all');
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    void loadTools();
  }, []);

  const loadTools = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await fetchAdminTools();
      setTools(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(getAdminApiErrorMessage(err));
      setTools([]);
    } finally {
      setLoading(false);
    }
  };

  const handleToggleTool = async toolId => {
    try {
      await toggleTool(toolId);
      await loadTools();
    } catch (err) {
      setError(getAdminApiErrorMessage(err));
    }
  };

  const handleDeleteTool = async toolId => {
    if (!confirm(t('admin.tools.deleteConfirm', 'Are you sure you want to delete this tool?'))) {
      return;
    }
    try {
      await deleteTool(toolId);
      await loadTools();
    } catch (err) {
      alert(err.message || 'Failed to delete tool');
    }
  };

  const handleCloneTool = tool => {
    navigate('/admin/tools/new', { state: { templateTool: tool } });
  };

  const downloadToolConfig = async toolId => {
    try {
      const response = await makeAdminApiCall(`/admin/tools/${toolId}`);
      const tool = response.data;
      const configData = JSON.stringify(tool, null, 2);
      const blob = new Blob([configData], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `tool-${toolId}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(`Failed to download tool config: ${getAdminApiErrorMessage(err)}`);
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
    let toolConfig;
    try {
      const fileContent = await file.text();
      toolConfig = JSON.parse(fileContent);
      if (!toolConfig.id || !toolConfig.name || !toolConfig.description) {
        throw new Error('Invalid tool config: missing required fields (id, name, description)');
      }
      await makeAdminApiCall('/admin/tools', { method: 'POST', body: toolConfig });
      await loadTools();
      event.target.value = '';
    } catch (err) {
      if (getAdminApiErrorMessage(err).includes('already exists')) {
        setError(`Tool with ID "${toolConfig?.id || 'unknown'}" already exists`);
      } else if (err instanceof SyntaxError) {
        setError('Invalid JSON file format');
      } else {
        setError(`Failed to upload tool config: ${getAdminApiErrorMessage(err)}`);
      }
    } finally {
      setUploading(false);
    }
  };

  const filteredTools = tools.filter(tool => {
    const matchesSearch =
      searchTerm === '' ||
      getLocalizedContent(tool.name, currentLanguage)
        .toLowerCase()
        .includes(searchTerm.toLowerCase()) ||
      getLocalizedContent(tool.description, currentLanguage)
        .toLowerCase()
        .includes(searchTerm.toLowerCase()) ||
      tool.id.toLowerCase().includes(searchTerm.toLowerCase());

    const matchesFilter =
      filterEnabled === 'all' ||
      (filterEnabled === 'enabled' && tool.enabled !== false) ||
      (filterEnabled === 'disabled' && tool.enabled === false);

    const matchesType = filterType === 'all' || getToolType(tool) === filterType;

    return matchesSearch && matchesFilter && matchesType;
  });

  const columns = [
    {
      key: 'name',
      header: t('admin.tools.table.name', 'Name'),
      sortable: true,
      sortAccessor: tool => getLocalizedContent(tool.name, currentLanguage),
      render: tool => <ToolNameCell tool={tool} currentLanguage={currentLanguage} />
    },
    {
      key: 'type',
      header: t('admin.tools.table.type', 'Type'),
      sortable: true,
      sortAccessor: getToolType,
      hideBelow: 'md',
      render: tool => {
        const type = getToolType(tool);
        const cls =
          type === 'special'
            ? 'bg-yellow-100 dark:bg-yellow-900/50 text-yellow-800 dark:text-yellow-300'
            : type === 'multi-function'
              ? 'bg-purple-100 dark:bg-purple-900/50 text-purple-800 dark:text-purple-300'
              : 'bg-blue-100 dark:bg-blue-900/50 text-blue-800 dark:text-blue-300';
        const label =
          type === 'special'
            ? t('admin.tools.typeSpecial', 'Special')
            : type === 'multi-function'
              ? t('admin.tools.typeMultiFunction', 'Multi-Function')
              : t('admin.tools.typeRegular', 'Regular');
        return (
          <span
            className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${cls}`}
          >
            {label}
          </span>
        );
      }
    },
    {
      key: 'description',
      header: t('admin.tools.table.description', 'Description'),
      hideBelow: 'lg',
      truncate: true,
      render: tool =>
        tool.description ? getLocalizedContent(tool.description, currentLanguage) : '-'
    },
    {
      key: 'script',
      header: t('admin.tools.table.script', 'Script'),
      hideBelow: 'xl',
      render: tool =>
        tool.script ? (
          <code className="text-xs bg-gray-100 dark:bg-gray-800 px-2 py-1 rounded-sm">
            {tool.script}
          </code>
        ) : tool.provider ? (
          <span className="text-gray-500 text-xs">{tool.provider}</span>
        ) : (
          <span className="text-gray-500">-</span>
        )
    },
    {
      key: 'status',
      header: t('admin.tools.table.status', 'Status'),
      sortable: true,
      sortAccessor: tool => (tool.enabled !== false ? 1 : 0),
      render: tool => (
        <span
          className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
            tool.enabled !== false
              ? 'bg-green-100 dark:bg-green-900/50 text-green-800 dark:text-green-300'
              : 'bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-300'
          }`}
        >
          {tool.enabled !== false
            ? t('admin.tools.enabled', 'Enabled')
            : t('admin.tools.disabled', 'Disabled')}
        </span>
      )
    }
  ];

  const actions = [
    {
      id: 'edit',
      label: t('admin.tools.edit', 'Edit'),
      icon: 'pencil',
      priority: 'primary',
      onClick: tool => navigate(`/admin/tools/${tool.id}`)
    },
    {
      id: 'toggle',
      label: t('admin.tools.toggle', 'Toggle enabled'),
      icon: 'eye',
      priority: 'primary',
      onClick: tool => handleToggleTool(tool.id)
    },
    {
      id: 'clone',
      label: t('admin.tools.clone', 'Clone'),
      icon: 'copy',
      onClick: tool => handleCloneTool(tool)
    },
    {
      id: 'download',
      label: t('admin.tools.download', 'Download Config'),
      icon: 'download',
      onClick: tool => downloadToolConfig(tool.id)
    },
    {
      id: 'delete',
      label: t('admin.tools.delete', 'Delete'),
      icon: 'trash',
      destructive: true,
      onClick: tool => handleDeleteTool(tool.id)
    }
  ];

  if (error) {
    return (
      <AdminLoadError title={t('admin.tools.loadError', 'Error loading tools')} message={error} />
    );
  }

  return (
    <div>
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="sm:flex sm:items-center">
          <div className="sm:flex-auto">
            <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
              {t('admin.tools.title', 'Tool Management')}
            </h1>
            <p className="mt-2 text-sm text-gray-700 dark:text-gray-300">
              {t(
                'admin.tools.subtitle',
                'Create, edit, and manage AI tools / function calling for your iHub Apps'
              )}
            </p>
          </div>
          <div className="mt-4 sm:mt-0 sm:ml-16 sm:flex-none">
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => navigate('/admin/tools/new')}
                className="inline-flex items-center justify-center rounded-md border border-transparent bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-xs hover:bg-indigo-700 focus:outline-hidden focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 sm:w-auto"
              >
                <Icon name="plus" className="h-4 w-4 mr-2" />
                {t('admin.tools.createNew', 'Create New Tool')}
              </button>
              <UploadConfigButton
                onChange={handleUploadConfig}
                uploading={uploading}
                title={t('admin.tools.uploadConfig', 'Upload Tool Config')}
                uploadingLabel={t('admin.tools.uploading', 'Uploading...')}
                label={t('admin.tools.uploadConfig', 'Upload Config')}
              />
            </div>
          </div>
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <SearchInput
            value={searchTerm}
            onChange={setSearchTerm}
            placeholder={t('admin.tools.searchPlaceholder', 'Search tools...')}
          />
          <FilterSelect
            label={t('admin.tools.statusLabel', 'Status')}
            value={filterEnabled}
            onChange={setFilterEnabled}
            options={[
              { value: 'all', label: t('admin.tools.filterAll', 'All Tools') },
              { value: 'enabled', label: t('admin.tools.filterEnabled', 'Enabled Only') },
              { value: 'disabled', label: t('admin.tools.filterDisabled', 'Disabled Only') }
            ]}
          />
          <FilterSelect
            label={t('admin.tools.typeLabel', 'Type')}
            value={filterType}
            onChange={setFilterType}
            options={[
              { value: 'all', label: t('admin.tools.filterAllTypes', 'All Types') },
              { value: 'regular', label: t('admin.tools.filterRegular', 'Regular Tools') },
              {
                value: 'multi-function',
                label: t('admin.tools.filterMultiFunction', 'Multi-Function')
              },
              { value: 'special', label: t('admin.tools.filterSpecial', 'Special Tools') }
            ]}
          />
        </div>

        <div className="mt-6">
          <DataTable
            columns={columns}
            data={filteredTools}
            getRowId={tool => tool.id}
            actions={actions}
            loading={loading}
            onRowClick={tool => navigate(`/admin/tools/${tool.id}`)}
            empty={{
              icon: 'wrench',
              title: t('admin.tools.noTools', 'No tools found'),
              description: t(
                'admin.tools.noToolsDescription',
                'Get started by creating a new tool.'
              )
            }}
          />
        </div>
      </div>
    </div>
  );
}

export default AdminToolsPage;
