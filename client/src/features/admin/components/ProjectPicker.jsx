// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckIcon, MagnifyingGlassIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { fetchAdminProjects, fetchAdminProjectTokens } from '../../../api/adminApi';
import ProjectTokenCount from './ProjectTokenCount';
import {
  PROJECT_LINK_MODES,
  filterProjects,
  normalizeProjectLinks,
  setProjectLinkMode,
  toggleProjectLink
} from '../utils/projectAdmin';
import { localizedText } from '../../projects/utils/projectItems';
import AdminLoadError from './AdminLoadError';

/**
 * Picks the admin projects linked to an app, a workflow prompt node or an
 * agent profile (#1036).
 *
 * The value is the link list `[{ id, mode, write }]`. Bare string ids are
 * accepted on input and normalized to `{ id, mode: 'auto', write: false }`;
 * `onChange` always receives the normalized list. Each linked project shows
 * a mode select (`auto`, `context` = always in the prompt, `tools` = search
 * tools only) and its estimated size. `write` is kept as it came in.
 *
 * Renders nothing when the projects feature is disabled on the server.
 *
 * @param {Object} props
 * @param {Array<string|{id: string, mode?: string, write?: boolean}>} [props.value=[]]
 * @param {(links: Array<{id: string, mode: string, write: boolean}>) => void} props.onChange
 * @param {boolean} [props.disabled=false]
 * @param {boolean} [props.compact=false] - Narrow layout (workflow editor side panel).
 * @param {string} [props.className]
 * @returns {JSX.Element|null}
 */
function ProjectPicker({
  value = [],
  onChange,
  disabled = false,
  compact = false,
  className = ''
}) {
  const { t, i18n } = useTranslation();
  const language = i18n?.language || 'en';
  const [projects, setProjects] = useState([]);
  const [estimates, setEstimates] = useState({ projects: {} });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [featureDisabled, setFeatureDisabled] = useState(false);
  const [search, setSearch] = useState('');

  const links = useMemo(() => normalizeProjectLinks(value), [value]);
  const linkedIds = useMemo(() => new Set(links.map(link => link.id)), [links]);
  const projectsById = useMemo(
    () => new Map(projects.map(project => [project.id, project])),
    [projects]
  );

  const loadProjects = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setProjects(await fetchAdminProjects());
    } catch (err) {
      if (err?.response?.status === 403 && err.response?.data?.code === 'FEATURE_DISABLED') {
        setFeatureDisabled(true);
      } else {
        setError(
          t('admin.projects.picker.loadError', 'Failed to load the projects. Please try again.')
        );
      }
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadProjects();
    // Sizes are a hint only: a failure leaves them blank, never the picker.
    fetchAdminProjectTokens()
      .then(data => setEstimates(data || { projects: {} }))
      .catch(err => console.error('Failed to load project token estimates:', err));
  }, [loadProjects]);

  const emit = next => {
    if (!disabled) onChange?.(next);
  };

  // Disabled projects are not offered, but stay visible once linked.
  const available = filterProjects(
    projects.filter(project => project.enabled !== false || linkedIds.has(project.id)),
    { search, language }
  );

  const modeLabels = {
    auto: t('admin.projects.picker.modes.auto', 'Auto'),
    context: t('admin.projects.picker.modes.context', 'Always in the prompt'),
    tools: t('admin.projects.picker.modes.tools', 'Search tools only')
  };

  if (featureDisabled) return null;

  const tokenProps = {
    loadAllBudgetTokens: estimates.loadAllBudgetTokens,
    toolResultBudgetTokens: estimates.toolResultBudgetTokens
  };

  return (
    <div className={`project-picker space-y-3 ${className}`}>
      {/* Linked projects with their mode */}
      {links.length > 0 && (
        <div className="border border-gray-200 dark:border-gray-700 rounded-md divide-y divide-gray-200 dark:divide-gray-700">
          <h4 className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
            {t('admin.projects.picker.linked', 'Linked projects ({{count}})', {
              count: links.length
            })}
          </h4>
          {links.map(link => {
            const project = projectsById.get(link.id);
            const name = project ? localizedText(project.name, language) || link.id : link.id;
            return (
              <div
                key={link.id}
                data-testid={`project-link-${link.id}`}
                className={`flex ${compact ? 'flex-col gap-2' : 'flex-wrap items-center gap-3'} p-3`}
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                    {name}
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400 font-mono truncate">
                    {link.id}
                  </div>
                  {!loading && !project && (
                    <div className="text-xs text-red-600 dark:text-red-400">
                      {t('admin.projects.picker.missing', 'This project does not exist.')}
                    </div>
                  )}
                  {project?.enabled === false && (
                    <div className="text-xs text-amber-700 dark:text-amber-400">
                      {t('admin.projects.picker.disabled', 'This project is disabled.')}
                    </div>
                  )}
                </div>
                <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
                  <span>{t('admin.projects.picker.mode', 'Mode')}</span>
                  <select
                    value={link.mode}
                    disabled={disabled}
                    aria-label={t('admin.projects.picker.modeFor', 'Mode of {{name}}', { name })}
                    onChange={e => emit(setProjectLinkMode(links, link.id, e.target.value))}
                    className="text-sm border border-gray-300 dark:border-gray-600 rounded-md px-2 py-1 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                  >
                    {PROJECT_LINK_MODES.map(mode => (
                      <option key={mode} value={mode}>
                        {modeLabels[mode]}
                      </option>
                    ))}
                  </select>
                </label>
                <ProjectTokenCount
                  inline={compact}
                  estimate={estimates.projects?.[link.id]}
                  mode={link.mode}
                  {...tokenProps}
                />
                <button
                  type="button"
                  onClick={() => emit(toggleProjectLink(links, link.id))}
                  disabled={disabled}
                  aria-label={t('admin.projects.picker.unlink', 'Unlink {{name}}', { name })}
                  className="p-1 rounded-md text-gray-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30 disabled:cursor-not-allowed"
                >
                  <XMarkIcon className="h-4 w-4" />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Search */}
      <div className="relative">
        <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
          <MagnifyingGlassIcon className="h-5 w-5 text-gray-500 dark:text-gray-400" />
        </div>
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder={t('admin.projects.picker.searchPlaceholder', 'Search projects...')}
          disabled={disabled || loading}
          className="block w-full pl-10 pr-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-500 dark:placeholder-gray-300 focus:outline-hidden focus:ring-1 focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
        />
      </div>

      {loading && (
        <div className="flex items-center justify-center py-6">
          <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-blue-500 dark:border-blue-400" />
          <span className="ml-2 text-sm text-gray-500 dark:text-gray-400">
            {t('admin.projects.picker.loading', 'Loading projects...')}
          </span>
        </div>
      )}

      {error && (
        <AdminLoadError
          message={error}
          framed={false}
          action={{ label: t('common.retry', 'Try again'), onClick: loadProjects }}
        />
      )}

      {!loading && !error && (
        <div className="border border-gray-200 dark:border-gray-700 rounded-md max-h-64 overflow-y-auto">
          {available.length === 0 ? (
            <p className="p-4 text-center text-sm text-gray-500 dark:text-gray-400">
              {projects.length === 0
                ? t(
                    'admin.projects.picker.empty',
                    'No projects yet. Create projects under Admin → Projects first.'
                  )
                : t('admin.projects.picker.noMatches', 'No projects match your search.')}
            </p>
          ) : (
            <div className="divide-y divide-gray-200 dark:divide-gray-700">
              {available.map(project => {
                const selected = linkedIds.has(project.id);
                const name = localizedText(project.name, language) || project.id;
                const description = localizedText(project.description, language);
                return (
                  <div
                    key={project.id}
                    role="checkbox"
                    aria-checked={selected}
                    aria-disabled={disabled || undefined}
                    aria-label={name}
                    tabIndex={disabled ? -1 : 0}
                    onClick={() => emit(toggleProjectLink(links, project.id))}
                    onKeyDown={e => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        emit(toggleProjectLink(links, project.id));
                      }
                    }}
                    className={`flex items-center p-3 cursor-pointer transition-colors ${
                      selected
                        ? 'bg-blue-50 dark:bg-blue-900/30 hover:bg-blue-100 dark:hover:bg-blue-900/40'
                        : 'hover:bg-gray-50 dark:hover:bg-gray-700'
                    } ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
                  >
                    <div
                      className={`w-5 h-5 rounded border-2 flex items-center justify-center mr-3 shrink-0 ${
                        selected
                          ? 'bg-blue-600 border-blue-600'
                          : 'border-gray-300 dark:border-gray-600'
                      }`}
                    >
                      {selected && <CheckIcon className="w-3 h-3 text-white" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                          {name}
                        </span>
                        {!compact && (
                          <span className="px-2 py-0.5 text-xs bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 rounded-sm font-mono">
                            {project.id}
                          </span>
                        )}
                      </div>
                      {description && !compact && (
                        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400 truncate">
                          {description}
                        </p>
                      )}
                      <div className="mt-1 flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                        <span>
                          {t('admin.projects.itemCount', '{{count}} items', {
                            count: (project.items || []).length
                          })}
                        </span>
                        <span>•</span>
                        <ProjectTokenCount inline estimate={estimates.projects?.[project.id]} />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default ProjectPicker;
