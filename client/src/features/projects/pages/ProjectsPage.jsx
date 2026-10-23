// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import DataTablePagination from '../../admin/components/data-table/DataTablePagination';
import CreateProjectDialog from '../components/CreateProjectDialog';
import ProjectCatalogDialog from '../components/ProjectCatalogDialog';
import ProjectRoleBadge, { ProjectAudienceBadges } from '../components/ProjectRoleBadge';
import {
  invalidateProjectsConfig,
  invalidateProjectsList,
  useMyProjects,
  useProjectsConfig
} from '../hooks/useProjects';
import { projectErrorMessage } from '../utils/projectErrors';
import { localizedText } from '../utils/projectItems';
import {
  PROJECT_LIST_FILTERS,
  countProjectGroups,
  filterProjectList,
  memberCountOf,
  projectCreation,
  projectDisplayName
} from '../utils/projectView';

/** Projects per page: the default, and the choices. */
const PAGE_SIZE_OPTIONS = [10, 25, 50];

/** The list shows the viewer's own and shared projects; admin ones are not listed. */
const USER_PROJECT_LIST_FILTERS = PROJECT_LIST_FILTERS.filter(id => id !== 'apps');

/** A date in the user's language. */
function formatDate(value, language) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(language || undefined, { dateStyle: 'medium' }).format(date);
}

/**
 * One project in the list.
 *
 * @param {{project: Object, language: string}} props
 * @returns {JSX.Element}
 */
function ProjectCard({ project, language }) {
  const { t } = useTranslation();
  const description = localizedText(project.description, language);
  const members = memberCountOf(project);
  return (
    <li className="bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-xl p-4 hover:border-gray-300 dark:hover:border-gray-600 transition-colors">
      <div className="flex items-start gap-3">
        <span className="w-10 h-10 rounded-xl flex items-center justify-center flex-none bg-indigo-100 dark:bg-indigo-900/40 text-indigo-600 dark:text-indigo-300">
          <Icon name="folder" size="md" />
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Link
              to={`/projects/${encodeURIComponent(project.id)}`}
              className="font-medium text-gray-900 dark:text-gray-100 hover:text-indigo-600 dark:hover:text-indigo-400 truncate"
            >
              {projectDisplayName(project, language)}
            </Link>
            <ProjectRoleBadge project={project} />
            <ProjectAudienceBadges project={project} />
          </div>
          {description && (
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400 line-clamp-2">
              {description}
            </p>
          )}
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400 flex flex-wrap gap-x-3 gap-y-1">
            <span>
              {t('projects.list.itemCount', '{{count}} items', {
                count: project.usage?.items ?? 0
              })}
            </span>
            {project.ownership === 'user' && members > 0 && (
              <span>{t('projects.list.memberCount', '{{count}} members', { count: members })}</span>
            )}
            {project.ownership === 'user' &&
              !project.permissions?.isOwner &&
              project.owner?.name && (
                <span>
                  {t('projects.list.ownedBy', 'Owner: {{name}}', { name: project.owner.name })}
                </span>
              )}
            {project.lastActivityAt && (
              <span>
                {t('projects.list.lastActivity', 'Active {{date}}', {
                  date: formatDate(project.lastActivityAt, language)
                })}
              </span>
            )}
          </p>
        </div>
      </div>
    </li>
  );
}

/**
 * `/projects` — the viewer's projects: owned, shared with them, and the
 * projects their apps bring along; create one, open one (#1036).
 *
 * @returns {JSX.Element}
 */
export default function ProjectsPage() {
  const { t, i18n } = useTranslation();
  const language = i18n.language;
  const navigate = useNavigate();
  const { config } = useProjectsConfig();
  const { projects: allProjects, loading, error } = useMyProjects();
  // Projects an admin created are linked to apps and managed by admins: a user
  // cannot start a chat in one, so they are not listed here.
  const projects = useMemo(
    () => allProjects.filter(project => project.ownership === 'user'),
    [allProjects]
  );
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  // A message the previous page left, e.g. after handing a project over.
  const location = useLocation();
  const [notice, setNotice] = useState(() =>
    typeof location.state?.notice === 'string' ? location.state.notice : null
  );
  useEffect(() => {
    // Shown once: a reload or a step back in history does not repeat it.
    if (location.state?.notice) navigate(location.pathname, { replace: true, state: null });
  }, [location.state, location.pathname, navigate]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE_OPTIONS[0]);

  const counts = useMemo(() => countProjectGroups(projects), [projects]);
  const visible = useMemo(
    () => filterProjectList(projects, { filter, search, language }),
    [projects, filter, search, language]
  );
  // A page at a time: the list never grows with the number of shared projects.
  const lastPage = Math.max(1, Math.ceil(visible.length / pageSize));
  const shownPage = Math.min(page, lastPage);
  const pageRows = useMemo(
    () => visible.slice((shownPage - 1) * pageSize, shownPage * pageSize),
    [visible, shownPage, pageSize]
  );
  const creation = projectCreation(config);
  const filterLabels = {
    all: t('projects.list.filters.all', 'All'),
    mine: t('projects.list.filters.mine', 'Mine'),
    shared: t('projects.list.filters.shared', 'Shared with me')
  };

  const handleCreated = project => {
    setCreating(false);
    invalidateProjectsList();
    invalidateProjectsConfig();
    navigate(`/projects/${encodeURIComponent(project.id)}`);
  };

  const createButton = config?.userProjects?.canCreate && (
    <button
      type="button"
      onClick={() => setCreating(true)}
      disabled={!creation.allowed}
      title={
        creation.reason === 'quota'
          ? t('projects.list.limitReached', 'You have reached the limit of {{limit}} projects', {
              limit: creation.limit
            })
          : undefined
      }
      className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-300 disabled:cursor-not-allowed"
    >
      <Icon name="plus" size="sm" />
      {t('projects.list.newProject', 'New project')}
    </button>
  );

  return (
    <div className="min-h-full bg-gray-50 dark:bg-gray-900 px-4 sm:px-6 py-8">
      <div className="max-w-5xl mx-auto">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
              {t('projects.list.title', 'Projects')}
            </h1>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
              {t(
                'projects.list.subtitle',
                'Documents, instructions and chats in one place, private or shared with your team.'
              )}
            </p>
            {creation.limit !== null && config?.userProjects?.canCreate && (
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {t('projects.list.quota', '{{used}} of {{limit}} own projects', {
                  used: creation.used,
                  limit: creation.limit
                })}
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {config?.sharing?.allowCatalog && (
              <button
                type="button"
                onClick={() => setBrowsing(true)}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700"
              >
                <Icon name="globe" size="sm" />
                {t('projects.catalog.browse', 'Browse catalog')}
              </button>
            )}
            {createButton}
          </div>
        </div>

        {notice && (
          <div
            role="status"
            className="mt-4 flex items-start gap-2 rounded-lg border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/30 px-4 py-3 text-sm text-green-800 dark:text-green-200"
          >
            <Icon name="check-circle" size="sm" className="mt-0.5 flex-none" />
            <span className="flex-1">{notice}</span>
            <button
              type="button"
              onClick={() => setNotice(null)}
              aria-label={t('common.close', 'Close')}
              className="flex-none text-green-700 dark:text-green-300 hover:text-green-900 dark:hover:text-green-100"
            >
              <Icon name="x" size="sm" />
            </button>
          </div>
        )}

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <div
            role="tablist"
            aria-label={t('projects.list.filterLabel', 'Show')}
            className="flex flex-wrap gap-1"
          >
            {USER_PROJECT_LIST_FILTERS.map(id => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={filter === id}
                onClick={() => {
                  setFilter(id);
                  setPage(1);
                }}
                className={`px-3 py-1.5 text-sm rounded-md ${
                  filter === id
                    ? 'bg-indigo-600 text-white'
                    : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700'
                }`}
              >
                {filterLabels[id]} <span className="opacity-70">({counts[id]})</span>
              </button>
            ))}
          </div>
          <input
            type="search"
            value={search}
            onChange={e => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder={t('projects.list.search', 'Search projects')}
            aria-label={t('projects.list.search', 'Search projects')}
            className="ml-auto w-full sm:w-64 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm px-3 py-2 text-gray-900 dark:text-gray-100"
          />
        </div>

        {error && (
          <div
            role="alert"
            className="mt-6 rounded-lg border border-red-200 bg-red-50 dark:bg-red-900/20 dark:border-red-800 px-4 py-3 text-sm text-red-700 dark:text-red-300"
          >
            {projectErrorMessage(error, t)}
          </div>
        )}

        {loading && projects.length === 0 ? (
          <p className="mt-10 text-sm text-gray-500">{t('common.loading', 'Loading…')}</p>
        ) : visible.length === 0 ? (
          <div className="mt-10 rounded-xl border border-dashed border-gray-300 dark:border-gray-700 p-10 text-center">
            <Icon name="folder-open" size="xl" className="mx-auto text-gray-500" />
            <h2 className="mt-3 text-base font-semibold text-gray-900 dark:text-gray-100">
              {projects.length === 0
                ? t('projects.list.emptyTitle', 'No projects yet')
                : t('projects.list.noMatches', 'No projects match')}
            </h2>
            {projects.length === 0 && (
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                {t(
                  'projects.list.emptyText',
                  'Create a project, add your documents and instructions, and start chats that know them.'
                )}
              </p>
            )}
          </div>
        ) : (
          <ul className="mt-6 space-y-3">
            {pageRows.map(project => (
              <ProjectCard key={project.id} project={project} language={language} />
            ))}
          </ul>
        )}
        {visible.length > PAGE_SIZE_OPTIONS[0] && (
          <div className="mt-3 overflow-hidden rounded-xl border border-gray-200 dark:border-gray-700">
            <DataTablePagination
              page={shownPage}
              pageSize={pageSize}
              pageSizeOptions={PAGE_SIZE_OPTIONS}
              total={visible.length}
              onPageChange={setPage}
              onPageSizeChange={size => {
                setPageSize(size);
                setPage(1);
              }}
              labels={{
                showing: (start, end, total) =>
                  t('projects.list.pager.showing', 'Projects {{start}}–{{end}} of {{total}}', {
                    start,
                    end,
                    total
                  }),
                rowsPerPage: t('projects.list.pager.perPage', 'Per page'),
                first: t('projects.chats.pager.first', 'First page'),
                previous: t('projects.chats.pager.previous', 'Previous page'),
                next: t('projects.chats.pager.next', 'Next page'),
                last: t('projects.chats.pager.last', 'Last page'),
                page: number => t('projects.chats.pager.page', 'Page {{number}}', { number })
              }}
            />
          </div>
        )}
      </div>
      {browsing && (
        <ProjectCatalogDialog
          onClose={() => setBrowsing(false)}
          onChanged={() => invalidateProjectsList()}
        />
      )}
      {creating && (
        <CreateProjectDialog onClose={() => setCreating(false)} onCreated={handleCreated} />
      )}
    </div>
  );
}
