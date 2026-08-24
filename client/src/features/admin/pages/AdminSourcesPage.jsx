import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { getAdminApiErrorMessage, makeAdminApiCall } from '../../../api/adminApi';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import { useFilterState } from '../hooks/useFilterState';
import { DataTable, SearchInput, FilterSelect } from '../components/data-table';

function NameCell({ source }) {
  return (
    <div className="min-w-0">
      <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
        {Object.values(source.name || {})[0] || source.id}
      </div>
      <div className="text-sm text-gray-500 dark:text-gray-400 font-mono truncate">{source.id}</div>
      {source.description && Object.values(source.description)[0] && (
        <div className="text-xs text-gray-400 dark:text-gray-500 mt-1 truncate">
          {Object.values(source.description)[0]}
        </div>
      )}
    </div>
  );
}

function TypeBadge({ type }) {
  const colors = {
    filesystem: 'bg-blue-100 dark:bg-blue-900/50 text-blue-800 dark:text-blue-300',
    url: 'bg-purple-100 dark:bg-purple-900/50 text-purple-800 dark:text-purple-300',
    ifinder: 'bg-orange-100 dark:bg-orange-900/50 text-orange-800 dark:text-orange-300'
  };
  return (
    <span
      className={`px-2 py-1 text-xs font-medium rounded-full ${
        colors[type] || 'bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-300'
      }`}
    >
      {type}
    </span>
  );
}

function AdminSourcesPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [sources, setSources] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchTerm, setSearchTerm] = useFilterState('q', '');
  const [typeFilter, setTypeFilter] = useFilterState('type', 'all');
  const [statusFilter, setStatusFilter] = useFilterState('status', 'all');
  const [selectedSources, setSelectedSources] = useState(new Set());
  const [bulkOperating, setBulkOperating] = useState(false);
  const [testingSource, setTestingSource] = useState(null);
  const [confirmDialog, setConfirmDialog] = useState(null);

  useEffect(() => {
    loadSources();
  }, []);

  const loadSources = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await makeAdminApiCall('/admin/sources');
      const sourcesData = Array.isArray(response) ? response : response?.data || [];
      setSources(sourcesData);
    } catch (err) {
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
        body: { sourceIds: [sourceId], enabled: newEnabled }
      });
      setSources(prev => prev.map(s => (s.id === sourceId ? { ...s, enabled: newEnabled } : s)));
    } catch (err) {
      setError(getAdminApiErrorMessage(err));
    }
  };

  const handleBulkToggle = async enabled => {
    try {
      setBulkOperating(true);
      const sourceIds = Array.from(selectedSources);
      await makeAdminApiCall('/admin/sources/_toggle', {
        method: 'POST',
        body: { sourceIds, enabled }
      });
      setSources(prev => prev.map(s => (sourceIds.includes(s.id) ? { ...s, enabled } : s)));
      setSelectedSources(new Set());
    } catch (err) {
      setError(getAdminApiErrorMessage(err));
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
      if (response.data.success) {
        alert(`Source test successful:\n${JSON.stringify(response.data.result, null, 2)}`);
      } else {
        alert(`Source test failed: ${response.data.error}`);
      }
    } catch (err) {
      alert(`Source test failed: ${err.message}`);
    } finally {
      setTestingSource(null);
    }
  };

  const handleDeleteSource = sourceId => {
    setConfirmDialog({
      title: t('admin.sources.deleteTitle', 'Delete Source'),
      message: t('admin.sources.deleteConfirm', 'Are you sure you want to delete this source?'),
      danger: true,
      onConfirm: async () => {
        setConfirmDialog(null);
        try {
          await makeAdminApiCall(`/admin/sources/${sourceId}`, { method: 'DELETE' });
          setSources(prev => prev.filter(s => s.id !== sourceId));
          setSelectedSources(prev => {
            const newSet = new Set(prev);
            newSet.delete(sourceId);
            return newSet;
          });
        } catch (err) {
          if (getAdminApiErrorMessage(err).includes('dependencies')) {
            setError(
              t(
                'admin.sources.deleteDependencies',
                'Cannot delete source: it is used by other apps.'
              )
            );
          } else {
            setError(getAdminApiErrorMessage(err));
          }
        }
      }
    });
  };

  const handleSourceSelection = (sourceId, checked) => {
    setSelectedSources(prev => {
      const newSet = new Set(prev);
      if (checked) newSet.add(sourceId);
      else newSet.delete(sourceId);
      return newSet;
    });
  };

  const allSelected =
    selectedSources.size > 0 &&
    selectedSources.size === filteredSources.length &&
    filteredSources.length > 0;

  const columns = [
    {
      key: 'select',
      header: (
        <input
          type="checkbox"
          checked={allSelected}
          onChange={e => {
            if (e.target.checked) {
              setSelectedSources(new Set(filteredSources.map(s => s.id)));
            } else {
              setSelectedSources(new Set());
            }
          }}
          className="h-4 w-4 text-indigo-600 border-gray-300 dark:border-gray-600 rounded focus:ring-indigo-500"
        />
      ),
      width: 'w-10',
      render: source => (
        <input
          type="checkbox"
          checked={selectedSources.has(source.id)}
          onChange={e => handleSourceSelection(source.id, e.target.checked)}
          onClick={e => e.stopPropagation()}
          className="h-4 w-4 text-indigo-600 border-gray-300 dark:border-gray-600 rounded focus:ring-indigo-500"
        />
      )
    },
    {
      key: 'name',
      header: t('admin.sources.name', 'Name'),
      sortable: true,
      sortAccessor: s => Object.values(s.name || {})[0] || s.id,
      render: s => <NameCell source={s} />
    },
    {
      key: 'type',
      header: t('admin.sources.type', 'Type'),
      sortable: true,
      hideBelow: 'md',
      render: s => <TypeBadge type={s.type} />
    },
    {
      key: 'status',
      header: t('admin.sources.status', 'Status'),
      sortable: true,
      sortAccessor: s => (s.enabled !== false ? 1 : 0),
      render: s => (
        <span
          className={`px-2 py-1 text-xs font-medium rounded-full ${
            s.enabled !== false
              ? 'bg-green-100 dark:bg-green-900/50 text-green-800 dark:text-green-300'
              : 'bg-red-100 dark:bg-red-900/50 text-red-800 dark:text-red-300'
          }`}
        >
          {s.enabled !== false ? t('common.enabled', 'Enabled') : t('common.disabled', 'Disabled')}
        </span>
      )
    },
    {
      key: 'updated',
      header: t('admin.sources.updated', 'Updated'),
      sortable: true,
      hideBelow: 'lg',
      sortAccessor: s => (s.updated ? new Date(s.updated).getTime() : 0),
      render: s => (s.updated ? new Date(s.updated).toLocaleDateString() : '-')
    }
  ];

  const actions = [
    {
      id: 'test',
      label: t('admin.sources.testSource', 'Test Source'),
      icon: 'beaker',
      priority: 'primary',
      busy: s => testingSource === s.id,
      onClick: s => handleTestSource(s.id)
    },
    {
      id: 'edit',
      label: t('admin.sources.editSource', 'Edit Source'),
      icon: 'pencil',
      priority: 'primary',
      onClick: s => navigate(`/admin/sources/${s.id}`)
    },
    {
      id: 'toggle',
      label: t('admin.sources.toggle', 'Toggle enabled'),
      icon: 'eye',
      onClick: s => handleSourceToggle(s.id)
    },
    {
      id: 'delete',
      label: t('admin.sources.deleteSource', 'Delete Source'),
      icon: 'trash',
      destructive: true,
      onClick: s => handleDeleteSource(s.id)
    }
  ];

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <div className="max-w-7xl mx-auto py-6 px-4">
        <div className="mb-8">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100 flex items-center">
                <Icon name="database" className="h-6 w-6 mr-2" />
                {t('admin.navigation.sources', 'Sources')}
              </h1>
              <p className="text-gray-600 dark:text-gray-400 mt-1">
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

        {error && (
          <div className="mb-6 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-lg p-4">
            <div className="flex items-center">
              <Icon name="exclamation-circle" className="h-5 w-5 text-red-400 mr-2" />
              <p className="text-red-800 dark:text-red-200">{error}</p>
              <button
                onClick={() => setError(null)}
                className="ml-auto text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-200"
              >
                <Icon name="x" className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}

        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm p-4 mb-6">
          <div className="flex flex-wrap items-center gap-3">
            <SearchInput
              value={searchTerm}
              onChange={setSearchTerm}
              placeholder={t('admin.sources.searchPlaceholder', 'Search sources...')}
            />
            <FilterSelect
              label={t('admin.sources.filterType', 'Type')}
              value={typeFilter}
              onChange={setTypeFilter}
              options={[
                { value: 'all', label: t('admin.sources.allTypes', 'All Types') },
                { value: 'filesystem', label: t('admin.sources.filesystem', 'Filesystem') },
                { value: 'url', label: t('admin.sources.url', 'URL') },
                { value: 'ifinder', label: t('admin.sources.ifinder', 'iFinder') }
              ]}
            />
            <FilterSelect
              label={t('admin.sources.filterStatus', 'Status')}
              value={statusFilter}
              onChange={setStatusFilter}
              options={[
                { value: 'all', label: t('admin.sources.allStatuses', 'All Statuses') },
                { value: 'enabled', label: t('common.enabled', 'Enabled') },
                { value: 'disabled', label: t('common.disabled', 'Disabled') }
              ]}
            />
            <button
              onClick={loadSources}
              className="ml-auto bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 px-3 py-2 rounded-lg text-sm font-medium flex items-center"
            >
              <Icon name="refresh" className="h-4 w-4 mr-2" />
              {t('common.refresh', 'Refresh')}
            </button>
          </div>
        </div>

        {selectedSources.size > 0 && (
          <div className="bg-indigo-50 dark:bg-indigo-900/30 border border-indigo-200 dark:border-indigo-800 rounded-lg p-4 mb-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center">
                <Icon
                  name="check-circle"
                  className="h-5 w-5 text-indigo-600 dark:text-indigo-400 mr-2"
                />
                <span className="text-indigo-800 dark:text-indigo-200 font-medium">
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

        <DataTable
          columns={columns}
          data={filteredSources}
          getRowId={s => s.id}
          actions={actions}
          loading={loading}
          empty={{
            icon: 'database',
            title:
              sources.length === 0
                ? t('admin.sources.noSources', 'No sources configured')
                : t('admin.sources.noFilteredSources', 'No sources match your filters'),
            description:
              sources.length === 0
                ? t('admin.sources.createFirstSource', 'Create your first source to get started')
                : t('admin.sources.adjustFilters', 'Try adjusting your search and filters'),
            action:
              sources.length === 0 ? (
                <button
                  onClick={() => navigate('/admin/sources/new')}
                  className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg font-medium"
                >
                  {t('admin.sources.createNew', 'Create Source')}
                </button>
              ) : null
          }}
        />

        <div className="mt-6 text-center text-sm text-gray-500 dark:text-gray-400">
          {t('admin.sources.summary', 'Showing {{filtered}} of {{total}} sources', {
            filtered: filteredSources.length,
            total: Array.isArray(sources) ? sources.length : 0
          })}
        </div>
      </div>
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

export default AdminSourcesPage;
