import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../../../utils/localizeContent';
import Icon from '../../../shared/components/Icon';
import AdminAuth from '../components/AdminAuth';
import AdminNavigation from '../components/AdminNavigation';
import {
  fetchAdminWorkflows,
  toggleAdminWorkflow,
  deleteAdminWorkflow,
  createAdminWorkflow,
  makeAdminApiCall
} from '../../../api/adminApi';

/**
 * Admin page for managing workflow definitions.
 * Displays a searchable, filterable table of all workflows with actions
 * for toggling, editing, cloning, downloading, and deleting.
 *
 * Follows the exact same patterns as AdminToolsPage.jsx.
 */
const AdminWorkflowsPage = () => {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const navigate = useNavigate();
  const [workflows, setWorkflows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterEnabled, setFilterEnabled] = useState('all'); // all, enabled, disabled
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    loadWorkflows();
  }, []);

  /**
   * Loads all workflow definitions from the admin API.
   * Sets loading and error state accordingly.
   */
  const loadWorkflows = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await fetchAdminWorkflows();

      const workflowsArray = Array.isArray(data) ? data : [];
      setWorkflows(workflowsArray);

      if (workflowsArray.length === 0) {
        console.warn('No workflows returned from API');
      }
    } catch (err) {
      console.error('Error loading workflows:', err);
      setError(err.message);
      setWorkflows([]);
    } finally {
      setLoading(false);
    }
  };

  /**
   * Toggles the enabled/disabled state of a workflow.
   * @param {string} workflowId - The workflow ID to toggle
   */
  const handleToggleWorkflow = async workflowId => {
    try {
      await toggleAdminWorkflow(workflowId);
      await loadWorkflows();
    } catch (err) {
      setError(err.message);
    }
  };

  /**
   * Deletes a workflow after user confirmation.
   * @param {string} workflowId - The workflow ID to delete
   */
  const handleDeleteWorkflow = async workflowId => {
    if (
      !confirm(t('admin.workflows.deleteConfirm', 'Are you sure you want to delete this workflow?'))
    ) {
      return;
    }

    try {
      await deleteAdminWorkflow(workflowId);
      await loadWorkflows();
      alert(t('admin.workflows.deleteSuccess', 'Workflow deleted successfully'));
    } catch (err) {
      console.error('Error deleting workflow:', err);
      alert(err.message || 'Failed to delete workflow');
    }
  };

  /**
   * Clones a workflow by creating a copy with a new ID suffix.
   * POSTs the cloned workflow config to the create endpoint.
   * @param {Object} workflow - The workflow object to clone
   */
  const handleCloneWorkflow = async workflow => {
    try {
      const clonedWorkflow = {
        ...workflow,
        id: `${workflow.id}-copy`
      };

      // Update localized name to indicate it's a copy
      if (typeof clonedWorkflow.name === 'object') {
        const updatedName = {};
        for (const [lang, value] of Object.entries(clonedWorkflow.name)) {
          updatedName[lang] = `${value} (Copy)`;
        }
        clonedWorkflow.name = updatedName;
      }

      await createAdminWorkflow(clonedWorkflow);
      await loadWorkflows();
      alert(t('admin.workflows.cloneSuccess', 'Workflow cloned successfully'));
    } catch (err) {
      console.error('Error cloning workflow:', err);
      if (err.message?.includes('already exists')) {
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

  /**
   * Downloads a workflow definition as a JSON file.
   * @param {string} workflowId - The workflow ID to download
   */
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
      setError(`Failed to download workflow config: ${err.message}`);
    }
  };

  /**
   * Handles uploading a workflow JSON configuration file.
   * Validates the file format and required fields before uploading.
   * @param {Event} event - File input change event
   */
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

      // Validate required fields
      if (!workflowConfig.id || !workflowConfig.name || !workflowConfig.nodes) {
        throw new Error('Invalid workflow config: missing required fields (id, name, nodes)');
      }

      await createAdminWorkflow(workflowConfig);
      await loadWorkflows();

      // Clear the file input
      event.target.value = '';
    } catch (err) {
      if (err.message.includes('already exists')) {
        setError(`Workflow with ID "${workflowConfig?.id || 'unknown'}" already exists`);
      } else if (err instanceof SyntaxError) {
        setError('Invalid JSON file format');
      } else {
        setError(`Failed to upload workflow config: ${err.message}`);
      }
    } finally {
      setUploading(false);
    }
  };

  /**
   * Filters workflows based on the current search term and enabled filter.
   */
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

  /**
   * Sorts filtered workflows alphabetically by localized name.
   */
  const sortedWorkflows = [...filteredWorkflows].sort((a, b) => {
    const aName = getLocalizedContent(a.name, currentLanguage);
    const bName = getLocalizedContent(b.name, currentLanguage);
    return aName.localeCompare(bName);
  });

  if (loading) {
    return (
      <div className="flex justify-center items-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-md p-4">
        <div className="flex">
          <Icon name="exclamation-triangle" className="h-5 w-5 text-red-400" />
          <div className="ml-3">
            <h3 className="text-sm font-medium text-red-800">
              {t('admin.workflows.loadError', 'Error loading workflows')}
            </h3>
            <p className="mt-1 text-sm text-red-700">{error}</p>
            <button
              onClick={() => window.location.reload()}
              className="mt-2 text-sm text-red-600 hover:text-red-500"
            >
              {t('common.retry', 'Retry')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <AdminAuth>
      <div>
        <AdminNavigation />
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="sm:flex sm:items-center">
            <div className="sm:flex-auto">
              <h1 className="text-2xl font-semibold text-gray-900">
                {t('admin.workflows.title', 'Workflow Management')}
              </h1>
              <p className="mt-2 text-sm text-gray-700">
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
                  className="inline-flex items-center justify-center rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 sm:w-auto"
                >
                  <Icon name="list-bullet" className="h-4 w-4 mr-2" />
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
                    className="inline-flex items-center justify-center rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
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

          {/* Search and Filter */}
          <div className="mt-8 flex flex-col sm:flex-row gap-4">
            <div className="flex-1">
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <Icon name="search" className="h-5 w-5 text-gray-400" />
                </div>
                <input
                  type="text"
                  className="block w-full pl-10 pr-3 py-2 border border-gray-300 rounded-md leading-5 bg-white placeholder-gray-500 focus:outline-none focus:placeholder-gray-400 focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
                  placeholder={t('admin.workflows.searchPlaceholder', 'Search workflows...')}
                  value={searchTerm}
                  onChange={e => setSearchTerm(e.target.value)}
                />
              </div>
            </div>
            <div className="sm:w-48">
              <select
                value={filterEnabled}
                onChange={e => setFilterEnabled(e.target.value)}
                className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
              >
                <option value="all">{t('admin.workflows.filterAll', 'All Workflows')}</option>
                <option value="enabled">
                  {t('admin.workflows.filterEnabled', 'Enabled Only')}
                </option>
                <option value="disabled">
                  {t('admin.workflows.filterDisabled', 'Disabled Only')}
                </option>
              </select>
            </div>
          </div>

          {/* Workflows Table */}
          <div className="mt-8 flex flex-col">
            <div className="-my-2 -mx-4 overflow-x-auto sm:-mx-6 lg:-mx-8">
              <div className="inline-block min-w-full py-2 align-middle md:px-6 lg:px-8">
                <div className="overflow-hidden shadow ring-1 ring-black ring-opacity-5 md:rounded-lg">
                  <table className="min-w-full divide-y divide-gray-300">
                    <thead className="bg-gray-50">
                      <tr>
                        <th
                          scope="col"
                          className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
                        >
                          {t('admin.workflows.table.name', 'Name')}
                        </th>
                        <th
                          scope="col"
                          className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
                        >
                          {t('admin.workflows.table.version', 'Version')}
                        </th>
                        <th
                          scope="col"
                          className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
                        >
                          {t('admin.workflows.table.nodes', 'Nodes')}
                        </th>
                        <th
                          scope="col"
                          className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
                        >
                          {t('admin.workflows.table.groups', 'Groups')}
                        </th>
                        <th
                          scope="col"
                          className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
                        >
                          {t('admin.workflows.table.status', 'Status')}
                        </th>
                        <th scope="col" className="relative px-6 py-3">
                          <span className="sr-only">
                            {t('admin.workflows.table.actions', 'Actions')}
                          </span>
                        </th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                      {sortedWorkflows.map(workflow => (
                        <tr
                          key={workflow.id}
                          className="hover:bg-gray-50 cursor-pointer"
                          onClick={() => navigate(`/admin/workflows/${workflow.id}`)}
                        >
                          <td className="px-6 py-4">
                            <div className="flex items-center">
                              <div className="flex-shrink-0 h-8 w-8">
                                <div className="h-8 w-8 rounded-full bg-indigo-100 flex items-center justify-center">
                                  <Icon
                                    name="arrows-right-left"
                                    className="h-4 w-4 text-indigo-600"
                                  />
                                </div>
                              </div>
                              <div className="ml-4">
                                <div className="text-sm font-medium text-gray-900">
                                  {getLocalizedContent(workflow.name, currentLanguage)}
                                </div>
                                <div className="text-sm text-gray-500">{workflow.id}</div>
                              </div>
                            </div>
                          </td>
                          <td className="px-6 py-4">
                            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                              {workflow.version || '1.0.0'}
                            </span>
                          </td>
                          <td className="px-6 py-4 text-sm text-gray-900">
                            {workflow.nodes?.length || 0}
                          </td>
                          <td className="px-6 py-4">
                            <div className="flex flex-wrap gap-1">
                              {workflow.allowedGroups && workflow.allowedGroups.length > 0 ? (
                                workflow.allowedGroups.map(group => (
                                  <span
                                    key={group}
                                    className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-800"
                                  >
                                    {group}
                                  </span>
                                ))
                              ) : (
                                <span className="text-sm text-gray-400">
                                  {t('admin.workflows.allUsers', 'All users')}
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-6 py-4">
                            <span
                              className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                                workflow.enabled !== false
                                  ? 'bg-green-100 text-green-800'
                                  : 'bg-gray-100 text-gray-800'
                              }`}
                            >
                              {workflow.enabled !== false
                                ? t('admin.workflows.enabled', 'Enabled')
                                : t('admin.workflows.disabled', 'Disabled')}
                            </span>
                          </td>
                          <td className="px-6 py-4 text-right text-sm font-medium">
                            <div className="flex items-center justify-end space-x-2">
                              <button
                                onClick={e => {
                                  e.stopPropagation();
                                  handleToggleWorkflow(workflow.id);
                                }}
                                className={`p-2 rounded-full ${
                                  workflow.enabled !== false
                                    ? 'text-red-600 hover:bg-red-50'
                                    : 'text-green-600 hover:bg-green-50'
                                }`}
                                title={
                                  workflow.enabled !== false
                                    ? t('admin.workflows.disable', 'Disable')
                                    : t('admin.workflows.enable', 'Enable')
                                }
                              >
                                <Icon
                                  name={workflow.enabled !== false ? 'eye-slash' : 'eye'}
                                  className="h-4 w-4"
                                />
                              </button>
                              <button
                                onClick={e => {
                                  e.stopPropagation();
                                  handleCloneWorkflow(workflow);
                                }}
                                className="p-2 text-blue-600 hover:bg-blue-50 rounded-full"
                                title={t('admin.workflows.clone', 'Clone')}
                              >
                                <Icon name="copy" className="h-4 w-4" />
                              </button>
                              <button
                                onClick={e => {
                                  e.stopPropagation();
                                  downloadWorkflowConfig(workflow.id);
                                }}
                                className="p-2 text-green-600 hover:bg-green-50 rounded-full"
                                title={t('admin.workflows.download', 'Download Config')}
                              >
                                <Icon name="download" className="h-4 w-4" />
                              </button>
                              <button
                                onClick={e => {
                                  e.stopPropagation();
                                  navigate(`/admin/workflows/${workflow.id}`);
                                }}
                                className="p-2 text-indigo-600 hover:bg-indigo-50 rounded-full"
                                title={t('admin.workflows.edit', 'Edit')}
                              >
                                <Icon name="pencil" className="h-4 w-4" />
                              </button>
                              <button
                                onClick={e => {
                                  e.stopPropagation();
                                  handleDeleteWorkflow(workflow.id);
                                }}
                                className="p-2 text-red-600 hover:bg-red-50 rounded-full"
                                title={t('admin.workflows.delete', 'Delete')}
                              >
                                <Icon name="trash" className="h-4 w-4" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {sortedWorkflows.length === 0 && (
                    <div className="text-center py-12 bg-gray-50">
                      <Icon name="arrows-right-left" className="mx-auto h-12 w-12 text-gray-400" />
                      <h3 className="mt-2 text-sm font-medium text-gray-900">
                        {t('admin.workflows.noWorkflows', 'No workflows found')}
                      </h3>
                      <p className="mt-1 text-sm text-gray-500">
                        {t(
                          'admin.workflows.noWorkflowsDescription',
                          'Get started by creating a new workflow.'
                        )}
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </AdminAuth>
  );
};

export default AdminWorkflowsPage;
