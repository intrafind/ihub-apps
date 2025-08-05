import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import AdminAuth from '../components/AdminAuth';
import AdminNavigation from '../components/AdminNavigation';
import { makeAdminApiCall } from '../../../api/adminApi';

const AdminSourcesPage = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [sources, setSources] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [selectedSources, setSelectedSources] = useState(new Set());
  const [bulkOperating, setBulkOperating] = useState(false);
  const [testingSource, setTestingSource] = useState(null);

  useEffect(() => {
    loadSources();
  }, []);

  const loadSources = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await makeAdminApiCall('/admin/sources');
      // Handle both array and object responses
      const sourcesData = Array.isArray(response) ? response : response?.data || [];
      setSources(sourcesData);
    } catch (err) {
      console.error('Failed to load sources:', err);
      setError(err.message || 'Failed to load sources');
    } finally {
      setLoading(false);
    }
  };

  const filteredSources = Array.isArray(sources)
    ? sources.filter(source => {
        const matchesSearch =
          !searchTerm ||
          Object.values(source.name || {}).some(name =>
            name.toLowerCase().includes(searchTerm.toLowerCase())
          ) ||
          source.id.toLowerCase().includes(searchTerm.toLowerCase());

        const matchesType = typeFilter === 'all' || source.type === typeFilter;
        const matchesStatus =
          statusFilter === 'all' ||
          (statusFilter === 'enabled' && source.enabled !== false) ||
          (statusFilter === 'disabled' && source.enabled === false);

        return matchesSearch && matchesType && matchesStatus;
      })
    : [];

  const handleSourceToggle = async sourceId => {
    try {
      const source = Array.isArray(sources) ? sources.find(s => s.id === sourceId) : null;
      const newEnabled = !source.enabled;

      await makeAdminApiCall(`/admin/sources/_toggle`, {
        method: 'POST',
        body: JSON.stringify({
          sourceIds: [sourceId],
          enabled: newEnabled
        })
      });

      setSources(prev => prev.map(s => (s.id === sourceId ? { ...s, enabled: newEnabled } : s)));
    } catch (err) {
      setError(err.message);
    }
  };

  const handleBulkToggle = async enabled => {
    try {
      setBulkOperating(true);
      const sourceIds = Array.from(selectedSources);

      await makeAdminApiCall('/admin/sources/_toggle', {
        method: 'POST',
        body: JSON.stringify({ sourceIds, enabled })
      });

      setSources(prev => prev.map(s => (sourceIds.includes(s.id) ? { ...s, enabled } : s)));

      setSelectedSources(new Set());
    } catch (err) {
      setError(err.message);
    } finally {
      setBulkOperating(false);
    }
  };

  const handleTestSource = async sourceId => {
    try {
      setTestingSource(sourceId);
      const response = await makeAdminApiCall(`/admin/sources/${sourceId}/test`, {
        method: 'POST'
      });

      if (response.success) {
        alert(`Source test successful:\n${JSON.stringify(response.result, null, 2)}`);
      } else {
        alert(`Source test failed: ${response.error}`);
      }
    } catch (err) {
      alert(`Source test failed: ${err.message}`);
    } finally {
      setTestingSource(null);
    }
  };

  const handleDeleteSource = async sourceId => {
    if (
      !window.confirm(
        t('admin.sources.deleteConfirm', 'Are you sure you want to delete this source?')
      )
    ) {
      return;
    }

    try {
      await makeAdminApiCall(`/admin/sources/${sourceId}`, {
        method: 'DELETE'
      });

      setSources(prev => prev.filter(s => s.id !== sourceId));
      setSelectedSources(prev => {
        const newSet = new Set(prev);
        newSet.delete(sourceId);
        return newSet;
      });
    } catch (err) {
      if (err.message.includes('dependencies')) {
        alert(
          t('admin.sources.deleteDependencies', 'Cannot delete source: it is used by other apps.')
        );
      } else {
        setError(err.message);
      }
    }
  };

  const handleSourceSelection = (sourceId, checked) => {
    setSelectedSources(prev => {
      const newSet = new Set(prev);
      if (checked) {
        newSet.add(sourceId);
      } else {
        newSet.delete(sourceId);
      }
      return newSet;
    });
  };

  const getStatusBadge = source => {
    const enabled = source.enabled !== false;
    return (
      <span
        className={`px-2 py-1 text-xs font-medium rounded-full ${
          enabled ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
        }`}
      >
        {enabled ? t('common.enabled', 'Enabled') : t('common.disabled', 'Disabled')}
      </span>
    );
  };

  const getTypeBadge = type => {
    const colors = {
      filesystem: 'bg-blue-100 text-blue-800',
      url: 'bg-purple-100 text-purple-800',
      ifinder: 'bg-orange-100 text-orange-800'
    };

    return (
      <span
        className={`px-2 py-1 text-xs font-medium rounded-full ${colors[type] || 'bg-gray-100 text-gray-800'}`}
      >
        {type}
      </span>
    );
  };

  if (loading) {
    return (
      <AdminAuth>
        <div className="min-h-screen bg-gray-50">
          <AdminNavigation />
          <div className="max-w-7xl mx-auto py-6 px-4">
            <div className="flex items-center justify-center h-64">
              <div className="text-center">
                <Icon
                  name="arrow-path"
                  className="animate-spin h-8 w-8 text-gray-400 mx-auto mb-4"
                />
                <p className="text-gray-500">{t('common.loading', 'Loading...')}</p>
              </div>
            </div>
          </div>
        </div>
      </AdminAuth>
    );
  }

  return (
    <AdminAuth>
      <div className="min-h-screen bg-gray-50">
        <AdminNavigation />
        <div className="max-w-7xl mx-auto py-6 px-4">
          {/* Header */}
          <div className="mb-8">
            <div className="flex items-center justify-between">
              <div>
                <h1 className="text-2xl font-semibold text-gray-900 flex items-center">
                  <Icon name="database" className="h-6 w-6 mr-2" />
                  {t('admin.navigation.sources', 'Sources')}
                </h1>
                <p className="text-gray-600 mt-1">
                  {t('admin.sources.description', 'Manage data sources for your applications')}
                </p>
              </div>
              <button
                onClick={() => navigate('/admin/sources/new')}
                className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg font-medium flex items-center"
              >
                <Icon name="plus" className="h-4 w-4 mr-2" />
                {t('admin.sources.createNew', 'Create Source')}
              </button>
            </div>
          </div>

          {/* Error Message */}
          {error && (
            <div className="mb-6 bg-red-50 border border-red-200 rounded-lg p-4">
              <div className="flex items-center">
                <Icon name="x-circle" className="h-5 w-5 text-red-400 mr-2" />
                <p className="text-red-800">{error}</p>
                <button
                  onClick={() => setError(null)}
                  className="ml-auto text-red-600 hover:text-red-800"
                >
                  <Icon name="x-mark" className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}

          {/* Filters */}
          <div className="bg-white rounded-lg shadow-sm p-6 mb-6">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  {t('admin.sources.search', 'Search')}
                </label>
                <div className="relative">
                  <Icon
                    name="magnifying-glass"
                    className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400"
                  />
                  <input
                    type="text"
                    value={searchTerm}
                    onChange={e => setSearchTerm(e.target.value)}
                    placeholder={t('admin.sources.searchPlaceholder', 'Search sources...')}
                    className="pl-10 w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  {t('admin.sources.filterType', 'Type')}
                </label>
                <select
                  value={typeFilter}
                  onChange={e => setTypeFilter(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                >
                  <option value="all">{t('admin.sources.allTypes', 'All Types')}</option>
                  <option value="filesystem">{t('admin.sources.filesystem', 'Filesystem')}</option>
                  <option value="url">{t('admin.sources.url', 'URL')}</option>
                  <option value="ifinder">{t('admin.sources.ifinder', 'iFinder')}</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  {t('admin.sources.filterStatus', 'Status')}
                </label>
                <select
                  value={statusFilter}
                  onChange={e => setStatusFilter(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                >
                  <option value="all">{t('admin.sources.allStatuses', 'All Statuses')}</option>
                  <option value="enabled">{t('common.enabled', 'Enabled')}</option>
                  <option value="disabled">{t('common.disabled', 'Disabled')}</option>
                </select>
              </div>

              <div className="flex items-end">
                <button
                  onClick={loadSources}
                  className="bg-gray-100 hover:bg-gray-200 text-gray-700 px-4 py-2 rounded-lg font-medium flex items-center"
                >
                  <Icon name="arrow-path" className="h-4 w-4 mr-2" />
                  {t('common.refresh', 'Refresh')}
                </button>
              </div>
            </div>
          </div>

          {/* Bulk Operations */}
          {selectedSources.size > 0 && (
            <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-4 mb-6">
              <div className="flex items-center justify-between">
                <div className="flex items-center">
                  <Icon name="check-circle" className="h-5 w-5 text-indigo-600 mr-2" />
                  <span className="text-indigo-800 font-medium">
                    {t('admin.sources.selectedCount', '{{count}} sources selected', {
                      count: selectedSources.size
                    })}
                  </span>
                </div>
                <div className="flex space-x-2">
                  <button
                    onClick={() => handleBulkToggle(true)}
                    disabled={bulkOperating}
                    className="bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white px-3 py-1 rounded text-sm font-medium"
                  >
                    {bulkOperating
                      ? t('common.processing', 'Processing...')
                      : t('admin.sources.enableSelected', 'Enable')}
                  </button>
                  <button
                    onClick={() => handleBulkToggle(false)}
                    disabled={bulkOperating}
                    className="bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white px-3 py-1 rounded text-sm font-medium"
                  >
                    {bulkOperating
                      ? t('common.processing', 'Processing...')
                      : t('admin.sources.disableSelected', 'Disable')}
                  </button>
                  <button
                    onClick={() => setSelectedSources(new Set())}
                    className="bg-gray-500 hover:bg-gray-600 text-white px-3 py-1 rounded text-sm font-medium"
                  >
                    {t('common.clearSelection', 'Clear')}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Sources Table */}
          <div className="bg-white rounded-lg shadow-sm overflow-hidden">
            {filteredSources.length === 0 ? (
              <div className="text-center py-12">
                <Icon name="database" className="h-12 w-12 text-gray-400 mx-auto mb-4" />
                <h3 className="text-lg font-medium text-gray-900 mb-2">
                  {(Array.isArray(sources) ? sources.length : 0) === 0
                    ? t('admin.sources.noSources', 'No sources configured')
                    : t('admin.sources.noFilteredSources', 'No sources match your filters')}
                </h3>
                <p className="text-gray-500 mb-4">
                  {(Array.isArray(sources) ? sources.length : 0) === 0
                    ? t(
                        'admin.sources.createFirstSource',
                        'Create your first source to get started'
                      )
                    : t('admin.sources.adjustFilters', 'Try adjusting your search and filters')}
                </p>
                {(Array.isArray(sources) ? sources.length : 0) === 0 && (
                  <button
                    onClick={() => navigate('/admin/sources/new')}
                    className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg font-medium"
                  >
                    {t('admin.sources.createNew', 'Create Source')}
                  </button>
                )}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-6 py-3 text-left">
                        <input
                          type="checkbox"
                          checked={
                            selectedSources.size === filteredSources.length &&
                            filteredSources.length > 0
                          }
                          onChange={e => {
                            if (e.target.checked) {
                              setSelectedSources(new Set(filteredSources.map(s => s.id)));
                            } else {
                              setSelectedSources(new Set());
                            }
                          }}
                          className="h-4 w-4 text-indigo-600 border-gray-300 rounded focus:ring-indigo-500"
                        />
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        {t('admin.sources.name', 'Name')}
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        {t('admin.sources.type', 'Type')}
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        {t('admin.sources.status', 'Status')}
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        {t('admin.sources.updated', 'Updated')}
                      </th>
                      <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                        {t('admin.sources.actions', 'Actions')}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {filteredSources.map(source => (
                      <tr key={source.id} className="hover:bg-gray-50">
                        <td className="px-6 py-4 whitespace-nowrap">
                          <input
                            type="checkbox"
                            checked={selectedSources.has(source.id)}
                            onChange={e => handleSourceSelection(source.id, e.target.checked)}
                            className="h-4 w-4 text-indigo-600 border-gray-300 rounded focus:ring-indigo-500"
                          />
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <div>
                            <div className="text-sm font-medium text-gray-900">
                              {Object.values(source.name || {})[0] || source.id}
                            </div>
                            <div className="text-sm text-gray-500 font-mono">{source.id}</div>
                            {source.description && Object.values(source.description)[0] && (
                              <div className="text-xs text-gray-400 mt-1">
                                {Object.values(source.description)[0]}
                              </div>
                            )}
                          </div>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">{getTypeBadge(source.type)}</td>
                        <td className="px-6 py-4 whitespace-nowrap">{getStatusBadge(source)}</td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                          {source.updated ? new Date(source.updated).toLocaleDateString() : '-'}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                          <div className="flex items-center justify-end space-x-2">
                            <button
                              onClick={() => handleTestSource(source.id)}
                              disabled={testingSource === source.id}
                              className="text-indigo-600 hover:text-indigo-900 disabled:opacity-50"
                              title={t('admin.sources.testSource', 'Test Source')}
                            >
                              <Icon
                                name={testingSource === source.id ? 'arrow-path' : 'beaker'}
                                className={`h-4 w-4 ${testingSource === source.id ? 'animate-spin' : ''}`}
                              />
                            </button>
                            <button
                              onClick={() => navigate(`/admin/sources/${source.id}`)}
                              className="text-gray-600 hover:text-gray-900"
                              title={t('admin.sources.editSource', 'Edit Source')}
                            >
                              <Icon name="pencil" className="h-4 w-4" />
                            </button>
                            <button
                              onClick={() => handleSourceToggle(source.id)}
                              className={`${source.enabled !== false ? 'text-red-600 hover:text-red-900' : 'text-green-600 hover:text-green-900'}`}
                              title={
                                source.enabled !== false
                                  ? t('common.disable', 'Disable')
                                  : t('common.enable', 'Enable')
                              }
                            >
                              <Icon
                                name={source.enabled !== false ? 'eye-slash' : 'eye'}
                                className="h-4 w-4"
                              />
                            </button>
                            <button
                              onClick={() => handleDeleteSource(source.id)}
                              className="text-red-600 hover:text-red-900"
                              title={t('admin.sources.deleteSource', 'Delete Source')}
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
            )}
          </div>

          {/* Summary */}
          <div className="mt-6 text-center text-sm text-gray-500">
            {t('admin.sources.summary', 'Showing {{filtered}} of {{total}} sources', {
              filtered: filteredSources.length,
              total: Array.isArray(sources) ? sources.length : 0
            })}
          </div>
        </div>
      </div>
    </AdminAuth>
  );
};

export default AdminSourcesPage;
