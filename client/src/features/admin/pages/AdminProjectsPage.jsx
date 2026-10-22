// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import {
  deleteAdminProject,
  fetchAdminProjectDependencies,
  fetchAdminProjectKinds,
  fetchAdminProjects,
  fetchAdminProjectStats,
  getAdminApiErrorMessage,
  toggleAdminProjects
} from '../../../api/adminApi';
import { useFilterState } from '../hooks/useFilterState';
import { DataTable, FilterSelect, SearchInput } from '../components/data-table';
import MergeProjectsDialog from '../components/MergeProjectsDialog';
import ProjectDependenciesDialog from '../components/ProjectDependenciesDialog';
import { dependenciesFromDeleteError, filterProjects } from '../utils/projectAdmin';
import { kindIcon, localizedText, summarizeItemKinds } from '../../projects/utils/projectItems';

/**
 * One header statistic.
 *
 * @param {{label: string, value: number|string}} props
 */
function StatTile({ label, value }) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xs px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
        {label}
      </div>
      <div className="mt-1 text-xl font-semibold text-gray-900 dark:text-gray-100">{value}</div>
    </div>
  );
}

/**
 * Name, id and description of a project row.
 *
 * @param {{project: Object, language: string}} props
 */
function NameCell({ project, language }) {
  const description = localizedText(project.description, language);
  return (
    <div className="min-w-0">
      <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
        {localizedText(project.name, language) || project.id}
      </div>
      <div className="text-sm text-gray-500 dark:text-gray-400 font-mono truncate">
        {project.id}
      </div>
      {description && (
        <div className="text-xs text-gray-500 dark:text-gray-400 mt-1 truncate">{description}</div>
      )}
    </div>
  );
}

/**
 * Item count and a badge per item kind.
 *
 * @param {{project: Object, kindName: (kind: string) => string, t: Function}} props
 */
function ItemsCell({ project, kindName, t }) {
  const items = project.items || [];
  return (
    <div className="min-w-0">
      <div className="text-sm text-gray-900 dark:text-gray-100">
        {t('admin.projects.itemCount', '{{count}} items', { count: items.length })}
      </div>
      <div className="mt-1 flex flex-wrap gap-1">
        {summarizeItemKinds(items).map(({ kind, count }) => (
          <span
            key={kind}
            className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300"
          >
            <Icon name={kindIcon(kind)} size="xs" />
            {kindName(kind)} · {count}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * Admin → Projects: every admin project with filters, bulk enable/disable and
 * a delete that refuses while apps, workflows or agents link the project
 * (#1036, the successor of the admin sources page).
 *
 * @returns {JSX.Element}
 */
function AdminProjectsPage() {
  const { t, i18n } = useTranslation();
  const language = i18n?.language || 'en';
  const navigate = useNavigate();
  const [projects, setProjects] = useState([]);
  const [stats, setStats] = useState(null);
  const [kinds, setKinds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchTerm, setSearchTerm] = useFilterState('q', '');
  const [kindFilter, setKindFilter] = useFilterState('kind', 'all');
  const [statusFilter, setStatusFilter] = useFilterState('status', 'all');
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [bulkOperating, setBulkOperating] = useState(false);
  const [checkingDelete, setCheckingDelete] = useState(null);
  const [confirmDialog, setConfirmDialog] = useState(null);
  const [blockedDelete, setBlockedDelete] = useState(null);
  const [mergeOpen, setMergeOpen] = useState(false);

  // Statistics and kind names are extras: their failure never hides the list.
  const loadExtras = useCallback(async () => {
    const [statsResult, kindsResult] = await Promise.allSettled([
      fetchAdminProjectStats(),
      fetchAdminProjectKinds()
    ]);
    if (statsResult.status === 'fulfilled') setStats(statsResult.value);
    if (kindsResult.status === 'fulfilled') setKinds(kindsResult.value);
  }, []);

  const loadProjects = useCallback(async () => {
    void loadExtras();
    try {
      setLoading(true);
      setError(null);
      setProjects(await fetchAdminProjects());
    } catch (err) {
      setError(getAdminApiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [loadExtras]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  const kindName = useCallback(
    kind => {
      const entry = kinds.find(candidate => candidate.id === kind);
      return entry ? localizedText(entry.name, language) || kind : kind;
    },
    [kinds, language]
  );

  const filteredProjects = useMemo(
    () =>
      filterProjects(projects, {
        search: searchTerm,
        status: statusFilter,
        kind: kindFilter,
        language
      }),
    [projects, searchTerm, statusFilter, kindFilter, language]
  );

  const projectName = project => localizedText(project.name, language) || project.id;

  const applyEnabled = (ids, enabled) => {
    setProjects(prev =>
      prev.map(project => (ids.includes(project.id) ? { ...project, enabled } : project))
    );
    void loadExtras();
  };

  const handleToggle = async project => {
    try {
      const enabled = project.enabled === false;
      await toggleAdminProjects([project.id], enabled);
      applyEnabled([project.id], enabled);
    } catch (err) {
      setError(getAdminApiErrorMessage(err));
    }
  };

  const handleBulkToggle = async enabled => {
    try {
      setBulkOperating(true);
      const ids = Array.from(selectedIds);
      await toggleAdminProjects(ids, enabled);
      applyEnabled(ids, enabled);
      setSelectedIds(new Set());
    } catch (err) {
      setError(getAdminApiErrorMessage(err));
    } finally {
      setBulkOperating(false);
    }
  };

  const removeFromList = projectId => {
    setProjects(prev => prev.filter(project => project.id !== projectId));
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.delete(projectId);
      return next;
    });
    void loadExtras();
  };

  const performDelete = async project => {
    setConfirmDialog(null);
    try {
      await deleteAdminProject(project.id);
      removeFromList(project.id);
    } catch (err) {
      // The links may have changed since the dependency check.
      const dependencies = dependenciesFromDeleteError(err);
      if (dependencies) {
        setBlockedDelete({ projectName: projectName(project), dependencies });
      } else {
        setError(getAdminApiErrorMessage(err));
      }
    }
  };

  // Ask the server who links the project before offering to delete it.
  const handleDelete = async project => {
    try {
      setCheckingDelete(project.id);
      const dependencies = await fetchAdminProjectDependencies(project.id);
      if (dependencies.length > 0) {
        setBlockedDelete({ projectName: projectName(project), dependencies });
        return;
      }
      setConfirmDialog({
        title: t('admin.projects.deleteTitle', 'Delete project'),
        message: t(
          'admin.projects.deleteConfirm',
          'Delete "{{name}}" and all of its items? This cannot be undone.',
          { name: projectName(project) }
        ),
        onConfirm: () => performDelete(project)
      });
    } catch (err) {
      setError(getAdminApiErrorMessage(err));
    } finally {
      setCheckingDelete(null);
    }
  };

  const handleSelection = (projectId, checked) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (checked) next.add(projectId);
      else next.delete(projectId);
      return next;
    });
  };

  const allSelected = filteredProjects.length > 0 && selectedIds.size === filteredProjects.length;

  const checkboxClass =
    'h-4 w-4 text-indigo-600 border-gray-300 dark:border-gray-600 rounded-sm focus:ring-indigo-500';

  const columns = [
    {
      key: 'select',
      header: (
        <input
          type="checkbox"
          aria-label={t('admin.projects.selectAll', 'Select all projects')}
          checked={allSelected}
          onChange={e =>
            setSelectedIds(e.target.checked ? new Set(filteredProjects.map(p => p.id)) : new Set())
          }
          className={checkboxClass}
        />
      ),
      width: 'w-10',
      render: project => (
        <input
          type="checkbox"
          aria-label={t('admin.projects.selectProject', 'Select {{name}}', {
            name: projectName(project)
          })}
          checked={selectedIds.has(project.id)}
          onChange={e => handleSelection(project.id, e.target.checked)}
          onClick={e => e.stopPropagation()}
          className={checkboxClass}
        />
      )
    },
    {
      key: 'name',
      header: t('admin.projects.columns.name', 'Name'),
      sortable: true,
      sortAccessor: project => projectName(project).toLowerCase(),
      render: project => <NameCell project={project} language={language} />
    },
    {
      key: 'items',
      header: t('admin.projects.columns.items', 'Items'),
      sortable: true,
      hideBelow: 'md',
      sortAccessor: project => (project.items || []).length,
      render: project => <ItemsCell project={project} kindName={kindName} t={t} />
    },
    {
      key: 'enabled',
      header: t('admin.projects.columns.enabled', 'Status'),
      sortable: true,
      sortAccessor: project => (project.enabled !== false ? 1 : 0),
      render: project => (
        <span
          className={`px-2 py-1 text-xs font-medium rounded-full ${
            project.enabled !== false
              ? 'bg-green-100 dark:bg-green-900/50 text-green-800 dark:text-green-300'
              : 'bg-red-100 dark:bg-red-900/50 text-red-800 dark:text-red-300'
          }`}
        >
          {project.enabled !== false
            ? t('common.enabled', 'Enabled')
            : t('common.disabled', 'Disabled')}
        </span>
      )
    },
    {
      key: 'category',
      header: t('admin.projects.columns.categoryTags', 'Category / tags'),
      hideBelow: 'lg',
      sortable: true,
      sortAccessor: project => project.category || '',
      render: project => (
        <div className="min-w-0">
          {project.category && (
            <div className="text-sm text-gray-900 dark:text-gray-100 truncate">
              {project.category}
            </div>
          )}
          <div className="flex flex-wrap gap-1">
            {(project.tags || []).map(tag => (
              <span
                key={tag}
                className="px-2 py-0.5 text-xs rounded-full bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300"
              >
                {tag}
              </span>
            ))}
          </div>
          {!project.category && (project.tags || []).length === 0 && (
            <span className="text-gray-500 dark:text-gray-400">-</span>
          )}
        </div>
      )
    },
    {
      key: 'updated',
      header: t('admin.projects.columns.updated', 'Updated'),
      sortable: true,
      hideBelow: 'lg',
      sortAccessor: project => (project.updatedAt ? new Date(project.updatedAt).getTime() : 0),
      render: project =>
        project.updatedAt ? new Date(project.updatedAt).toLocaleDateString(language) : '-'
    }
  ];

  const actions = [
    {
      id: 'edit',
      label: t('admin.projects.actions.edit', 'Edit project'),
      icon: 'pencil',
      priority: 'primary',
      onClick: project => navigate(`/admin/projects/${encodeURIComponent(project.id)}`)
    },
    {
      id: 'toggle',
      label: t('admin.projects.actions.toggle', 'Enable or disable'),
      icon: 'eye',
      onClick: handleToggle
    },
    {
      id: 'delete',
      label: t('admin.projects.actions.delete', 'Delete project'),
      icon: 'trash',
      destructive: true,
      busy: project => checkingDelete === project.id,
      onClick: handleDelete
    }
  ];

  const kindOptions = [
    { value: 'all', label: t('admin.projects.filters.allKinds', 'All kinds') },
    ...kinds.map(kind => ({ value: kind.id, label: localizedText(kind.name, language) || kind.id }))
  ];

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <div className="max-w-7xl mx-auto py-6 px-4">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100 flex items-center">
              <Icon name="folder" className="h-6 w-6 mr-2" />
              {t('admin.nav.projects', 'Projects')}
            </h1>
            <p className="text-gray-600 dark:text-gray-400 mt-1">
              {t(
                'admin.projects.description',
                'Knowledge you link to apps, workflows and agents: uploaded files, web pages, iHub pages and iFinder documents.'
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={() => navigate('/admin/projects/new')}
            className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg font-medium flex items-center"
          >
            <Icon name="plus" className="h-4 w-4 mr-2" />
            {t('admin.projects.createNew', 'New project')}
          </button>
        </div>

        {stats && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6" data-testid="project-stats">
            <StatTile
              label={t('admin.projects.stats.total', 'Total')}
              value={stats.admin?.total ?? 0}
            />
            <StatTile
              label={t('admin.projects.stats.enabled', 'Enabled')}
              value={stats.admin?.enabled ?? 0}
            />
            <StatTile
              label={t('admin.projects.stats.disabled', 'Disabled')}
              value={stats.admin?.disabled ?? 0}
            />
            <StatTile
              label={t('admin.projects.stats.userProjects', 'User projects')}
              value={stats.user?.total ?? 0}
            />
          </div>
        )}

        {error && (
          <div
            role="alert"
            className="mb-6 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-lg p-4"
          >
            <div className="flex items-center">
              <Icon name="exclamation-circle" className="h-5 w-5 text-red-400 mr-2" />
              <p className="text-red-800 dark:text-red-200">{error}</p>
              <button
                type="button"
                onClick={() => setError(null)}
                aria-label={t('common.dismiss', 'Dismiss')}
                className="ml-auto text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-200"
              >
                <Icon name="x" className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}

        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xs p-4 mb-6">
          <div className="flex flex-wrap items-center gap-3">
            <SearchInput
              value={searchTerm}
              onChange={setSearchTerm}
              placeholder={t('admin.projects.searchPlaceholder', 'Search projects...')}
            />
            <FilterSelect
              label={t('admin.projects.filters.kind', 'Kind')}
              value={kindFilter}
              onChange={setKindFilter}
              options={kindOptions}
            />
            <FilterSelect
              label={t('admin.projects.filters.status', 'Status')}
              value={statusFilter}
              onChange={setStatusFilter}
              options={[
                { value: 'all', label: t('admin.projects.filters.allStatuses', 'All statuses') },
                { value: 'enabled', label: t('common.enabled', 'Enabled') },
                { value: 'disabled', label: t('common.disabled', 'Disabled') }
              ]}
            />
            <button
              type="button"
              onClick={loadProjects}
              className="ml-auto bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 px-3 py-2 rounded-lg text-sm font-medium flex items-center"
            >
              <Icon name="refresh" className="h-4 w-4 mr-2" />
              {t('common.refresh', 'Refresh')}
            </button>
          </div>
        </div>

        {selectedIds.size > 0 && (
          <div className="bg-indigo-50 dark:bg-indigo-900/30 border border-indigo-200 dark:border-indigo-800 rounded-lg p-4 mb-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="text-indigo-800 dark:text-indigo-200 font-medium">
                {t('admin.projects.selectedCount', '{{count}} projects selected', {
                  count: selectedIds.size
                })}
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => handleBulkToggle(true)}
                  disabled={bulkOperating}
                  className="bg-green-700 hover:bg-green-800 disabled:opacity-50 text-white px-3 py-1 rounded-sm text-sm font-medium"
                >
                  {t('admin.projects.enableSelected', 'Enable')}
                </button>
                <button
                  type="button"
                  onClick={() => handleBulkToggle(false)}
                  disabled={bulkOperating}
                  className="bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white px-3 py-1 rounded-sm text-sm font-medium"
                >
                  {t('admin.projects.disableSelected', 'Disable')}
                </button>
                <button
                  type="button"
                  onClick={() => setMergeOpen(true)}
                  disabled={bulkOperating || selectedIds.size < 2}
                  title={t(
                    'admin.projects.mergeHint',
                    'Move the items of the selected projects into one of them'
                  )}
                  className="bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white px-3 py-1 rounded-sm text-sm font-medium"
                >
                  {t('admin.projects.mergeSelected', 'Merge…')}
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedIds(new Set())}
                  className="bg-gray-500 hover:bg-gray-600 text-white px-3 py-1 rounded-sm text-sm font-medium"
                >
                  {t('common.clearSelection', 'Clear')}
                </button>
              </div>
            </div>
          </div>
        )}

        <DataTable
          columns={columns}
          data={filteredProjects}
          getRowId={project => project.id}
          actions={actions}
          loading={loading}
          empty={{
            icon: 'folder',
            title:
              projects.length === 0
                ? t('admin.projects.empty', 'No projects yet')
                : t('admin.projects.noMatches', 'No projects match your filters'),
            description:
              projects.length === 0
                ? t('admin.projects.emptyHint', 'Create your first project to get started.')
                : t('admin.projects.adjustFilters', 'Try adjusting your search and filters.'),
            action:
              projects.length === 0 ? (
                <button
                  type="button"
                  onClick={() => navigate('/admin/projects/new')}
                  className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg font-medium"
                >
                  {t('admin.projects.createNew', 'New project')}
                </button>
              ) : null
          }}
        />

        <div className="mt-6 text-center text-sm text-gray-500 dark:text-gray-400">
          {t('admin.projects.summary', 'Showing {{filtered}} of {{total}} projects', {
            filtered: filteredProjects.length,
            total: projects.length
          })}
        </div>
      </div>

      <ConfirmDialog
        isOpen={Boolean(confirmDialog)}
        title={confirmDialog?.title ?? ''}
        message={confirmDialog?.message ?? ''}
        confirmLabel={t('common.delete', 'Delete')}
        danger
        onConfirm={() => confirmDialog?.onConfirm()}
        onDeny={() => setConfirmDialog(null)}
      />
      <ProjectDependenciesDialog blocked={blockedDelete} onClose={() => setBlockedDelete(null)} />
      {mergeOpen && (
        <MergeProjectsDialog
          projects={projects.filter(project => selectedIds.has(project.id))}
          onClose={() => setMergeOpen(false)}
          onDone={() => {
            setSelectedIds(new Set());
            void loadProjects();
          }}
        />
      )}
    </div>
  );
}

export default AdminProjectsPage;
