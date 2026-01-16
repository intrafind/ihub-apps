import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../../../utils/localizeContent';
import Icon from '../../../shared/components/Icon';
import AdminAuth from '../components/AdminAuth';
import AdminNavigation from '../components/AdminNavigation';
import { makeAdminApiCall } from '../../../api/adminApi';

const AdminToolsPage = () => {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const navigate = useNavigate();
  const [tools, setTools] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterEnabled, setFilterEnabled] = useState('all'); // all, enabled, disabled
  const [uploading, setUploading] = useState(false);

  const loadTools = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await makeAdminApiCall('/admin/tools');
      const data = response.data;

      // Ensure we have an array
      const toolsArray = Array.isArray(data) ? data : [];
      setTools(toolsArray);

      if (toolsArray.length === 0) {
        console.warn('No tools returned from API');
      }
    } catch (err) {
      console.error('Error loading tools:', err);
      setError(err.message);
      setTools([]); // Set empty array on error
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadTools();
  }, []);

  const toggleTool = async toolId => {
    try {
      const response = await makeAdminApiCall(`/admin/tools/${toolId}/toggle`, {
        method: 'POST'
      });

      const result = response.data;

      // Update the tool in the local state
      setTools(prevTools =>
        prevTools.map(tool => (tool.id === toolId ? { ...tool, enabled: result.enabled } : tool))
      );
    } catch (err) {
      setError(err.message);
    }
  };

  const enableAllTools = async () => {
    try {
      await makeAdminApiCall('/admin/tools/*/_toggle', {
        method: 'POST',
        body: { enabled: true }
      });
      setTools(prev => prev.map(t => ({ ...t, enabled: true })));
    } catch (err) {
      setError(err.message);
    }
  };

  const disableAllTools = async () => {
    try {
      await makeAdminApiCall('/admin/tools/*/_toggle', {
        method: 'POST',
        body: { enabled: false }
      });
      setTools(prev => prev.map(t => ({ ...t, enabled: false })));
    } catch (err) {
      setError(err.message);
    }
  };

  const handleCloneTool = tool => {
    navigate('/admin/tools/new', { state: { templateTool: tool } });
  };

  const handleDeleteTool = async toolId => {
    if (!confirm(t('admin.tools.deleteConfirm', 'Delete this tool?'))) {
      return;
    }
    try {
      await makeAdminApiCall(`/admin/tools/${toolId}`, { method: 'DELETE' });
      setTools(prev => prev.filter(t => t.id !== toolId));
    } catch (err) {
      setError(err.message);
    }
  };

  const downloadToolConfig = async toolId => {
    try {
      const response = await makeAdminApiCall(`/admin/tools/${toolId}`);
      const tool = response.data;

      // Create a clean config object for download
      const configData = JSON.stringify(tool, null, 2);
      const blob = new Blob([configData], { type: 'application/json' });
      const url = URL.createObjectURL(blob);

      // Create download link
      const link = document.createElement('a');
      link.href = url;
      link.download = `tool-${toolId}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(`Failed to download tool config: ${err.message}`);
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

      // Validate required fields
      if (!toolConfig.id || !toolConfig.name || !toolConfig.description) {
        throw new Error('Invalid tool config: missing required fields (id, name, description)');
      }

      // Upload the config
      await makeAdminApiCall('/admin/tools', {
        method: 'POST',
        body: toolConfig
      });

      // Reload tools to show the new one
      await loadTools();

      // Clear the file input
      event.target.value = '';
    } catch (err) {
      if (err.message.includes('already exists')) {
        setError(`Tool with ID "${toolConfig?.id || 'unknown'}" already exists`);
      } else if (err instanceof SyntaxError) {
        setError('Invalid JSON file format');
      } else {
        setError(`Failed to upload tool config: ${err.message}`);
      }
    } finally {
      setUploading(false);
    }
  };

  const filteredTools = tools.filter(tool => {
    const matchesSearch =
      searchTerm === '' ||
      getLocalizedContent(tool.name, currentLanguage).toLowerCase().includes(searchTerm.toLowerCase()) ||
      getLocalizedContent(tool.description, currentLanguage)
        .toLowerCase()
        .includes(searchTerm.toLowerCase()) ||
      tool.id.toLowerCase().includes(searchTerm.toLowerCase());

    const matchesFilter =
      filterEnabled === 'all' ||
      (filterEnabled === 'enabled' && tool.enabled !== false) ||
      (filterEnabled === 'disabled' && tool.enabled === false);

    return matchesSearch && matchesFilter;
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
              {t('admin.tools.loadError', 'Error loading tools')}
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
                {t('admin.tools.title', 'Tool Management')}
              </h1>
              <p className="mt-2 text-sm text-gray-700">
                {t('admin.tools.subtitle', 'Configure and manage tools for your applications')}
              </p>
            </div>
            <div className="mt-4 sm:mt-0 sm:ml-16 sm:flex-none">
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => navigate('/admin/tools/new')}
                  className="inline-flex items-center justify-center rounded-md border border-transparent bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 sm:w-auto"
                >
                  <Icon name="plus" className="h-4 w-4 mr-2" />
                  {t('admin.tools.addNew', 'Add New Tool')}
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
                    title={t('admin.tools.uploadConfig', 'Upload Tool Config')}
                  >
                    <Icon
                      name={uploading ? 'refresh' : 'upload'}
                      className={`h-4 w-4 mr-2 ${uploading ? 'animate-spin' : ''}`}
                    />
                    {uploading
                      ? t('admin.tools.uploading', 'Uploading...')
                      : t('admin.tools.uploadConfig', 'Upload Config')}
                  </button>
                </div>
                <button
                  type="button"
                  className="inline-flex items-center justify-center rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50"
                  onClick={enableAllTools}
                >
                  {t('admin.common.enableAll', 'Enable All')}
                </button>
                <button
                  type="button"
                  className="inline-flex items-center justify-center rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50"
                  onClick={disableAllTools}
                >
                  {t('admin.common.disableAll', 'Disable All')}
                </button>
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
                  placeholder={t('admin.tools.searchPlaceholder', 'Search tools...')}
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
                <option value="all">{t('admin.tools.filterAll', 'All Tools')}</option>
                <option value="enabled">{t('admin.tools.filterEnabled', 'Enabled Only')}</option>
                <option value="disabled">{t('admin.tools.filterDisabled', 'Disabled Only')}</option>
              </select>
            </div>
          </div>

          {/* Tools Table */}
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
                          {t('admin.tools.name', 'Name')}
                        </th>
                        <th
                          scope="col"
                          className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
                        >
                          {t('admin.tools.script', 'Script')}
                        </th>
                        <th
                          scope="col"
                          className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
                        >
                          {t('admin.tools.table.status', 'Status')}
                        </th>
                        <th scope="col" className="relative px-6 py-3">
                          <span className="sr-only">{t('admin.tools.actions', 'Actions')}</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                      {filteredTools.map(tool => (
                        <tr key={tool.id} className="hover:bg-gray-50">
                          <td className="px-6 py-4 whitespace-nowrap">
                            <div className="flex items-center">
                              <div className="flex-shrink-0 h-8 w-8">
                                <div className="h-8 w-8 rounded-full bg-indigo-100 flex items-center justify-center">
                                  <Icon name="wrench-screwdriver" className="h-4 w-4 text-indigo-600" />
                                </div>
                              </div>
                              <div className="ml-4">
                                <div className="text-sm font-medium text-gray-900">
                                  {getLocalizedContent(tool.name, currentLanguage)}
                                </div>
                                <div className="text-sm text-gray-500">{tool.id}</div>
                              </div>
                            </div>
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                            {tool.script || tool.provider || '-'}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap">
                            <span
                              className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                                tool.enabled !== false
                                  ? 'bg-green-100 text-green-800'
                                  : 'bg-gray-100 text-gray-800'
                              }`}
                            >
                              {tool.enabled !== false
                                ? t('admin.tools.enabled', 'Enabled')
                                : t('admin.tools.disabled', 'Disabled')}
                            </span>
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                            <div className="flex items-center justify-end space-x-2">
                              <button
                                onClick={() => toggleTool(tool.id)}
                                className={`p-2 rounded-full ${
                                  tool.enabled !== false
                                    ? 'text-red-600 hover:bg-red-50'
                                    : 'text-green-600 hover:bg-green-50'
                                }`}
                                title={
                                  tool.enabled !== false
                                    ? t('admin.tools.disable', 'Disable')
                                    : t('admin.tools.enable', 'Enable')
                                }
                              >
                                <Icon
                                  name={tool.enabled !== false ? 'eye-slash' : 'eye'}
                                  className="h-4 w-4"
                                />
                              </button>
                              <button
                                onClick={() => navigate(`/admin/tools/${tool.id}`)}
                                className="p-2 text-indigo-600 hover:bg-indigo-50 rounded-full"
                                title={t('common.edit', 'Edit')}
                              >
                                <Icon name="pencil" className="h-4 w-4" />
                              </button>
                              <button
                                onClick={() => handleCloneTool(tool)}
                                className="p-2 text-blue-600 hover:bg-blue-50 rounded-full"
                                title={t('admin.tools.clone', 'Clone')}
                              >
                                <Icon name="copy" className="h-4 w-4" />
                              </button>
                              <button
                                onClick={() => downloadToolConfig(tool.id)}
                                className="p-2 text-green-600 hover:bg-green-50 rounded-full"
                                title={t('admin.tools.download', 'Download Config')}
                              >
                                <Icon name="download" className="h-4 w-4" />
                              </button>
                              <button
                                onClick={() => handleDeleteTool(tool.id)}
                                className="p-2 text-red-600 hover:bg-red-50 rounded-full"
                                title={t('admin.tools.delete', 'Delete')}
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

          {filteredTools.length === 0 && (
            <div className="text-center py-12">
              <Icon name="wrench-screwdriver" className="mx-auto h-12 w-12 text-gray-400" />
              <h3 className="mt-2 text-sm font-medium text-gray-900">
                {t('admin.tools.noTools', 'No tools found')}
              </h3>
              <p className="mt-1 text-sm text-gray-500">
                {t('admin.tools.noToolsDesc', 'Get started by creating a new tool.')}
              </p>
              <div className="mt-6">
                <button
                  onClick={() => navigate('/admin/tools/new')}
                  className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
                >
                  <Icon name="plus" className="h-4 w-4 mr-2" />
                  {t('admin.tools.addNew', 'Add New Tool')}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </AdminAuth>
  );
};

export default AdminToolsPage;
