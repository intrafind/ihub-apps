import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useFilterState } from '../hooks/useFilterState';
import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../../../utils/localizeContent';
import Icon from '../../../shared/components/Icon';
import {
  createAdminWorkflow,
  deleteAdminWorkflow,
  fetchAdminWorkflows,
  getAdminApiErrorMessage,
  makeAdminApiCall,
  toggleAdminWorkflow
} from '../../../api/adminApi';
import { DataTable, SearchInput, FilterSelect } from '../components/data-table';

function WorkflowNameCell({ workflow, currentLanguage }) {
  return (
    <div className="flex flex-col min-w-0">
      <span className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
        {getLocalizedContent(workflow.name, currentLanguage)}
      </span>
      <span className="text-xs text-gray-500 dark:text-gray-400 truncate">{workflow.id}</span>
    </div>
  );
}

function GroupsCell({ workflow }) {
  const groups = workflow.allowedGroups || workflow.groups || [];
  if (groups.length === 0) {
    return <span className="text-gray-400 text-xs">—</span>;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {groups.slice(0, 3).map(g => (
        <span
          key={g}
          className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-200"
        >
          {g}
        </span>
      ))}
      {groups.length > 3 && (
        <span className="text-xs text-gray-500 dark:text-gray-400">+{groups.length - 3}</span>
      )}
    </div>
  );
}

function AdminWorkflowsPage() {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const navigate = useNavigate();
  const [workflows, setWorkflows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchTerm, setSearchTerm] = useFilterState('q', '');
  const [filterEnabled, setFilterEnabled] = useFilterState('enabled', 'all');
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    loadWorkflows();
  }, []);

  const loadWorkflows = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await fetchAdminWorkflows();
      setWorkflows(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(getAdminApiErrorMessage(err));
      setWorkflows([]);
    } finally {
      setLoading(false);
    }
  };

  const handleToggleWorkflow = async workflowId => {
    try {
      await toggleAdminWorkflow(workflowId);
      await loadWorkflows();
    } catch (err) {
      setError(getAdminApiErrorMessage(err));
    }
  };

  const handleDeleteWorkflow = async workflowId => {
    if (
      !confirm(t('admin.workflows.deleteConfirm', 'Are you sure you want to delete this workflow?'))
    ) {
      return;
    }
    try {
      await deleteAdminWorkflow(workflowId);
      await loadWorkflows();
    } catch (err) {
      alert(err.message || 'Failed to delete workflow');
    }
  };

  const handleCloneWorkflow = async workflow => {
    try {
      const clonedWorkflow = { ...workflow, id: `${workflow.id}-copy` };
      if (typeof clonedWorkflow.name === 'object') {
        const updatedName = {};
        for (const [lang, value] of Object.entries(clonedWorkflow.name)) {
          updatedName[lang] = `${value} (Copy)`;
        }
        clonedWorkflow.name = updatedName;
      }
      await createAdminWorkflow(clonedWorkflow);
      await loadWorkflows();
    } catch (err) {
      if (getAdminApiErrorMessage(err).includes('already exists')) {
        alert(
          t(
            'admin.workflows.cloneExists',
            'A workflow with ID "${id}" already exists. Please rename before cloning.'
          ).replace('${id}', `${workflow.id}-copy`)
        );
      } else {
        alert(err.message || 'Failed to clone workflow');
      }
    }
  };

  const downloadWorkflowConfig = async workflowId => {
    try {
      const response = await makeAdminApiCall(`/workflows/${workflowId}`);
      const workflow = response.data;
      const configData = JSON.stringify(workflow, null, 2);
      const blob = new Blob([configData], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `workflow-${workflowId}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(`Failed to download workflow config: ${getAdminApiErrorMessage(err)}`);
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
    let workflowConfig;
    try {
      const fileContent = await file.text();
      workflowConfig = JSON.parse(fileContent);
      if (!workflowConfig.id || !workflowConfig.name || !workflowConfig.nodes) {
        throw new Error('Invalid workflow config: missing required fields (id, name, nodes)');
      }
      await createAdminWorkflow(workflowConfig);
      await loadWorkflows();
      event.target.value = '';
    } catch (err) {
      if (getAdminApiErrorMessage(err).includes('already exists')) {
        setError(`Workflow with ID "${workflowConfig?.id || 'unknown'}" already exists`);
      } else if (err instanceof SyntaxError) {
        setError('Invalid JSON file format');
      } else {
        setError(`Failed to upload workflow config: ${getAdminApiErrorMessage(err)}`);
      }
    } finally {
      setUploading(false);
    }
  };

  const filteredWorkflows = workflows.filter(workflow => {
    const matchesSearch =
      searchTerm === '' ||
      getLocalizedContent(workflow.name, currentLanguage)
        .toLowerCase()
        .includes(searchTerm.toLowerCase()) ||
      (workflow.description &&
        getLocalizedContent(workflow.description, currentLanguage)
          .toLowerCase()
          .includes(searchTerm.toLowerCase())) ||
      workflow.id.toLowerCase().includes(searchTerm.toLowerCase());

    const matchesFilter =
      filterEnabled === 'all' ||
      (filterEnabled === 'enabled' && workflow.enabled !== false) ||
      (filterEnabled === 'disabled' && workflow.enabled === false);

    return matchesSearch && matchesFilter;
  });

  const columns = [
    {
      key: 'name',
      header: t('admin.workflows.table.name', 'Name'),
      sortable: true,
      sortAccessor: w => getLocalizedContent(w.name, currentLanguage),
      render: w => <WorkflowNameCell workflow={w} currentLanguage={currentLanguage} />
    },
    {
      key: 'version',
      header: t('admin.workflows.table.version', 'Version'),
      sortable: true,
      hideBelow: 'md',
      render: w => (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-200">
          {w.version || '1'}
        </span>
      )
    },
    {
      key: 'nodes',
      header: t('admin.workflows.table.nodes', 'Nodes'),
      sortable: true,
      sortAccessor: w => (Array.isArray(w.nodes) ? w.nodes.length : 0),
      hideBelow: 'md',
      align: 'right',
      render: w => (Array.isArray(w.nodes) ? w.nodes.length : '—')
    },
    {
      key: 'groups',
      header: t('admin.workflows.table.groups', 'Groups'),
      hideBelow: 'lg',
      render: w => <GroupsCell workflow={w} />
    },
    {
      key: 'status',
      header: t('admin.workflows.table.status', 'Status'),
      sortable: true,
      sortAccessor: w => (w.enabled !== false ? 1 : 0),
      render: w => (
        <span
          className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
            w.enabled !== false
              ? 'bg-green-100 dark:bg-green-900/50 text-green-800 dark:text-green-300'
              : 'bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-300'
          }`}
        >
          {w.enabled !== false
            ? t('admin.workflows.enabled', 'Enabled')
            : t('admin.workflows.disabled', 'Disabled')}
        </span>
      )
    }
  ];

  const actions = [
    {
      id: 'edit',
      label: t('admin.workflows.edit', 'Edit'),
      icon: 'pencil',
      priority: 'primary',
      onClick: w => navigate(`/admin/workflows/${w.id}`)
    },
    {
      id: 'visual',
      label: t('admin.workflows.visualEditor', 'Visual editor'),
      icon: 'share',
      priority: 'primary',
      onClick: w => navigate(`/admin/workflows/${w.id}/editor`)
    },
    {
      id: 'toggle',
      label: t('admin.workflows.toggle', 'Toggle enabled'),
      icon: 'eye',
      onClick: w => handleToggleWorkflow(w.id)
    },
    {
      id: 'clone',
      label: t('admin.workflows.clone', 'Clone'),
      icon: 'copy',
      onClick: w => handleCloneWorkflow(w)
    },
    {
      id: 'download',
      label: t('admin.workflows.download', 'Download Config'),
      icon: 'download',
      onClick: w => downloadWorkflowConfig(w.id)
    },
    {
      id: 'delete',
      label: t('admin.workflows.delete', 'Delete'),
      icon: 'trash',
      destructive: true,
      onClick: w => handleDeleteWorkflow(w.id)
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
                {t('admin.workflows.loadError', 'Error loading workflows')}
              </h3>
              <p className="mt-1 text-sm text-red-700 dark:text-red-300">{error}</p>
              <button
                onClick={() => window.location.reload()}
                className="mt-2 text-sm text-red-600 dark:text-red-400 hover:text-red-500"
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
    <div>
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="sm:flex sm:items-center">
          <div className="sm:flex-auto">
            <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
              {t('admin.workflows.title', 'Workflow Management')}
            </h1>
            <p className="mt-2 text-sm text-gray-700 dark:text-gray-300">
              {t(
                'admin.workflows.subtitle',
                'Create, edit, and manage agentic workflows for your iHub Apps'
              )}
            </p>
          </div>
          <div className="mt-4 sm:mt-0 sm:ml-16 sm:flex-none">
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => navigate('/admin/workflows/executions')}
                className="inline-flex items-center justify-center rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 shadow-sm hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 sm:w-auto"
              >
                <Icon name="list" className="h-4 w-4 mr-2" />
                {t('admin.workflows.viewExecutions', 'View Executions')}
              </button>
              <button
                onClick={() => navigate('/admin/workflows/new')}
                className="inline-flex items-center justify-center rounded-md border border-transparent bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 sm:w-auto"
              >
                <Icon name="plus" className="h-4 w-4 mr-2" />
                {t('admin.workflows.createNew', 'Create New Workflow')}
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
                  title={t('admin.workflows.uploadConfig', 'Upload Workflow Config')}
                >
                  <Icon
                    name={uploading ? 'refresh' : 'upload'}
                    className={`h-4 w-4 mr-2 ${uploading ? 'animate-spin' : ''}`}
                  />
                  {uploading
                    ? t('admin.workflows.uploading', 'Uploading...')
                    : t('admin.workflows.uploadConfig', 'Upload Config')}
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <SearchInput
            value={searchTerm}
            onChange={setSearchTerm}
            placeholder={t('admin.workflows.searchPlaceholder', 'Search workflows...')}
          />
          <FilterSelect
            label={t('admin.workflows.statusLabel', 'Status')}
            value={filterEnabled}
            onChange={setFilterEnabled}
            options={[
              { value: 'all', label: t('admin.workflows.filterAll', 'All Workflows') },
              { value: 'enabled', label: t('admin.workflows.filterEnabled', 'Enabled Only') },
              { value: 'disabled', label: t('admin.workflows.filterDisabled', 'Disabled Only') }
            ]}
          />
        </div>

        <div className="mt-6">
          <DataTable
            columns={columns}
            data={filteredWorkflows}
            getRowId={w => w.id}
            actions={actions}
            loading={loading}
            empty={{
              icon: 'share',
              title: t('admin.workflows.noWorkflows', 'No workflows found'),
              description: t(
                'admin.workflows.noWorkflowsDescription',
                'Get started by creating a new workflow.'
              )
            }}
          />
        </div>
      </div>
    </div>
  );
}

export default AdminWorkflowsPage;
