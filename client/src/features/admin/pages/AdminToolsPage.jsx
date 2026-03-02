import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../../../utils/localizeContent';
import Icon from '../../../shared/components/Icon';
import AdminAuth from '../components/AdminAuth';
import AdminNavigation from '../components/AdminNavigation';
import { fetchAdminTools, makeAdminApiCall, toggleTool, deleteTool } from '../../../api/adminApi';

const AdminToolsPage = () => {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const navigate = useNavigate();
  const [tools, setTools] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterEnabled, setFilterEnabled] = useState('all'); // all, enabled, disabled
  const [filterType, setFilterType] = useState('all'); // all, regular, special, multi-function
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    loadTools();
  }, []);

  const loadTools = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await fetchAdminTools();

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

  const handleToggleTool = async toolId => {
    try {
      await toggleTool(toolId);
      await loadTools();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleDeleteTool = async toolId => {
    if (!confirm(t('admin.tools.deleteConfirm', 'Are you sure you want to delete this tool?'))) {
      return;
    }

    try {
      await deleteTool(toolId);
      await loadTools();
      alert(t('admin.tools.deleteSuccess', 'Tool deleted successfully'));
    } catch (err) {
      console.error('Error deleting tool:', err);
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

  const getToolType = tool => {
    if (tool.isSpecialTool || tool.provider) {
      return 'special';
    }
    if (tool.functions && Object.keys(tool.functions).length > 0) {
      return 'multi-function';
    }
    return 'regular';
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

  const sortedTools = [...filteredTools].sort((a, b) => {
    const aName = getLocalizedContent(a.name, currentLanguage);
    const bName = getLocalizedContent(b.name, currentLanguage);
    return aName.localeCompare(bName);
  });

  if (loading) {
    return (
      <div className="flex justify-center items-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600 dark:border-indigo-400"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-md p-4">
        <div className="flex">
          <Icon name="exclamation-triangle" className="h-5 w-5 text-red-400" />
          <div className="ml-3">
            <h3 className="text-sm font-medium text-red-800 dark:text-red-200">
              {t('admin.tools.loadError', 'Error loading tools')}
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
    );
  }

  return (
    <AdminAuth>
      <div>
        <AdminNavigation />
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
                  className="inline-flex items-center justify-center rounded-md border border-transparent bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 sm:w-auto"
                >
                  <Icon name="plus" className="h-4 w-4 mr-2" />
                  {t('admin.tools.createNew', 'Create New Tool')}
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
                  className="block w-full pl-10 pr-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md leading-5 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-500 dark:placeholder-gray-400 focus:outline-none focus:placeholder-gray-400 focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
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
                className="block w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
              >
                <option value="all">{t('admin.tools.filterAll', 'All Tools')}</option>
                <option value="enabled">{t('admin.tools.filterEnabled', 'Enabled Only')}</option>
                <option value="disabled">{t('admin.tools.filterDisabled', 'Disabled Only')}</option>
              </select>
            </div>
            <div className="sm:w-48">
              <select
                value={filterType}
                onChange={e => setFilterType(e.target.value)}
                className="block w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
              >
                <option value="all">{t('admin.tools.filterAllTypes', 'All Types')}</option>
                <option value="regular">{t('admin.tools.filterRegular', 'Regular Tools')}</option>
                <option value="multi-function">
                  {t('admin.tools.filterMultiFunction', 'Multi-Function')}
                </option>
                <option value="special">{t('admin.tools.filterSpecial', 'Special Tools')}</option>
              </select>
            </div>
          </div>

          {/* Tools Table */}
          <div className="mt-8 flex flex-col">
            <div className="-my-2 -mx-4 overflow-x-auto sm:-mx-6 lg:-mx-8">
              <div className="inline-block min-w-full py-2 align-middle md:px-6 lg:px-8">
                <div className="overflow-hidden shadow ring-1 ring-black ring-opacity-5 dark:ring-gray-700 md:rounded-lg">
                  <table className="min-w-full divide-y divide-gray-300 dark:divide-gray-700">
                    <thead className="bg-gray-50 dark:bg-gray-800">
                      <tr>
                        <th
                          scope="col"
                          className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider"
                        >
                          {t('admin.tools.table.name', 'Name')}
                        </th>
                        <th
                          scope="col"
                          className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider"
                        >
                          {t('admin.tools.table.type', 'Type')}
                        </th>
                        <th
                          scope="col"
                          className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider"
                        >
                          {t('admin.tools.table.description', 'Description')}
                        </th>
                        <th
                          scope="col"
                          className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider"
                        >
                          {t('admin.tools.table.script', 'Script')}
                        </th>
                        <th
                          scope="col"
                          className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider"
                        >
                          {t('admin.tools.table.status', 'Status')}
                        </th>
                        <th scope="col" className="relative px-6 py-3">
                          <span className="sr-only">
                            {t('admin.tools.table.actions', 'Actions')}
                          </span>
                        </th>
                      </tr>
                    </thead>
                    <tbody className="bg-white dark:bg-gray-900 divide-y divide-gray-200 dark:divide-gray-700">
                      {sortedTools.map(tool => (
                        <tr
                          key={tool.id}
                          className="hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer"
                          onClick={() => navigate(`/admin/tools/${tool.id}`)}
                        >
                          <td className="px-6 py-4">
                            <div className="flex items-center">
                              <div className="flex-shrink-0 h-8 w-8">
                                <div className="h-8 w-8 rounded-full bg-indigo-100 dark:bg-indigo-900/50 flex items-center justify-center">
                                  <Icon
                                    name={
                                      tool.functions
                                        ? 'layers'
                                        : tool.isSpecialTool
                                          ? 'star'
                                          : 'wrench'
                                    }
                                    className="h-4 w-4 text-indigo-600 dark:text-indigo-400"
                                  />
                                </div>
                              </div>
                              <div className="ml-4">
                                <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                                  {getLocalizedContent(tool.name, currentLanguage)}
                                </div>
                                <div className="text-sm text-gray-500 dark:text-gray-400">
                                  {tool.id}
                                </div>
                              </div>
                            </div>
                          </td>
                          <td className="px-6 py-4">
                            {getToolType(tool) === 'special' ? (
                              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-100 dark:bg-yellow-900/50 text-yellow-800 dark:text-yellow-300">
                                {t('admin.tools.typeSpecial', 'Special')}
                              </span>
                            ) : getToolType(tool) === 'multi-function' ? (
                              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-purple-100 dark:bg-purple-900/50 text-purple-800 dark:text-purple-300">
                                {t('admin.tools.typeMultiFunction', 'Multi-Function')}
                              </span>
                            ) : (
                              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 dark:bg-blue-900/50 text-blue-800 dark:text-blue-300">
                                {t('admin.tools.typeRegular', 'Regular')}
                              </span>
                            )}
                          </td>
                          <td className="px-6 py-4">
                            <div className="text-sm text-gray-900 dark:text-gray-100 max-w-xs truncate">
                              {tool.description
                                ? getLocalizedContent(tool.description, currentLanguage)
                                : '-'}
                            </div>
                          </td>
                          <td className="px-6 py-4 text-sm text-gray-900 dark:text-gray-100">
                            {tool.script ? (
                              <code className="text-xs bg-gray-100 dark:bg-gray-800 px-2 py-1 rounded">
                                {tool.script}
                              </code>
                            ) : tool.provider ? (
                              <span className="text-gray-400 text-xs">{tool.provider}</span>
                            ) : (
                              <span className="text-gray-400">-</span>
                            )}
                          </td>
                          <td className="px-6 py-4">
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
                          </td>
                          <td className="px-6 py-4 text-right text-sm font-medium">
                            <div className="flex items-center justify-end space-x-2">
                              <button
                                onClick={e => {
                                  e.stopPropagation();
                                  handleToggleTool(tool.id);
                                }}
                                className={`p-2 rounded-full ${
                                  tool.enabled !== false
                                    ? 'text-red-600 hover:bg-red-50 dark:hover:bg-red-900/50'
                                    : 'text-green-600 hover:bg-green-50 dark:hover:bg-green-900/50'
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
                                onClick={e => {
                                  e.stopPropagation();
                                  handleCloneTool(tool);
                                }}
                                className="p-2 text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/50 rounded-full"
                                title={t('admin.tools.clone', 'Clone')}
                              >
                                <Icon name="copy" className="h-4 w-4" />
                              </button>
                              <button
                                onClick={e => {
                                  e.stopPropagation();
                                  downloadToolConfig(tool.id);
                                }}
                                className="p-2 text-green-600 hover:bg-green-50 dark:hover:bg-green-900/50 rounded-full"
                                title={t('admin.tools.download', 'Download Config')}
                              >
                                <Icon name="download" className="h-4 w-4" />
                              </button>
                              <button
                                onClick={e => {
                                  e.stopPropagation();
                                  navigate(`/admin/tools/${tool.id}`);
                                }}
                                className="p-2 text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-900/50 rounded-full"
                                title={t('admin.tools.edit', 'Edit')}
                              >
                                <Icon name="pencil" className="h-4 w-4" />
                              </button>
                              <button
                                onClick={e => {
                                  e.stopPropagation();
                                  handleDeleteTool(tool.id);
                                }}
                                className="p-2 text-red-600 hover:bg-red-50 dark:hover:bg-red-900/50 rounded-full"
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
                  {sortedTools.length === 0 && (
                    <div className="text-center py-12 bg-gray-50 dark:bg-gray-800">
                      <Icon name="wrench" className="mx-auto h-12 w-12 text-gray-400" />
                      <h3 className="mt-2 text-sm font-medium text-gray-900 dark:text-gray-100">
                        {t('admin.tools.noTools', 'No tools found')}
                      </h3>
                      <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                        {t('admin.tools.noToolsDescription', 'Get started by creating a new tool.')}
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

export default AdminToolsPage;
