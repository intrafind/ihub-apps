// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useUsableProjects } from '../../projects/hooks/useProjects';
import { groupProjectOptions, projectNameFor } from '../utils/projectNodeConfig';

/** Translation keys of the project list groups (the project list's filter names). */
const GROUP_LABEL_KEYS = {
  mine: ['projects.list.filters.mine', 'Mine'],
  shared: ['projects.list.filters.shared', 'Shared with me'],
  apps: ['projects.list.filters.apps', 'From apps']
};

/**
 * The run dialog's input for a start variable of type `project` (#1036,
 * slice 6): a select over the projects the running user may use
 * (`GET /api/projects`, through the projects store the project pages share),
 * grouped into their own projects, projects shared with them and admin
 * projects of their apps. The value is the project id.
 *
 * When projects are not available to the user (switched off, or signed out)
 * or the list cannot be loaded, a plain text input takes a project id, so a
 * run can still be started; the server checks the id either way.
 *
 * @param {Object} props
 * @param {string} props.name - The variable name (for the field id).
 * @param {string} props.label - The visible label, used as the input's accessible name.
 * @param {string} [props.value] - The picked project id.
 * @param {(projectId: string) => void} props.onChange
 * @param {boolean} [props.disabled=false]
 * @param {string} props.className - Input classes of the dialog (error border included).
 * @param {string} [props.placeholder] - The variable's own placeholder text.
 * @returns {JSX.Element}
 */
function ProjectInputField({
  name,
  label,
  value,
  onChange,
  disabled = false,
  className,
  placeholder
}) {
  const { t, i18n } = useTranslation();
  const language = i18n?.language || 'en';
  const { projects, loading, error, available, reload } = useUsableProjects();
  const groups = useMemo(() => groupProjectOptions(projects, language), [projects, language]);
  const current = typeof value === 'string' ? value : '';
  const listed = groups.some(group => group.options.some(option => option.id === current));
  const fieldId = `workflow-input-${name}`;

  if (!loading && (!available || error)) {
    return (
      <div className="space-y-1">
        <input
          id={fieldId}
          type="text"
          value={current}
          onChange={e => onChange(e.target.value.trim())}
          disabled={disabled}
          aria-label={label}
          placeholder={t('workflows.startModal.project.idPlaceholder', 'Project id')}
          className={`${className} font-mono`}
        />
        <p className="text-xs text-amber-700 dark:text-amber-400">
          {error
            ? t('workflows.startModal.project.loadError', 'Your projects could not be loaded.')
            : t(
                'workflows.startModal.project.unavailable',
                'Projects are not available to you here. Enter a project id.'
              )}
          {error && (
            <button type="button" onClick={() => reload()} className="ml-1 underline">
              {t('common.retry', 'Try again')}
            </button>
          )}
        </p>
      </div>
    );
  }

  const empty = !loading && groups.length === 0;

  return (
    <div className="space-y-1">
      <select
        id={fieldId}
        value={current}
        onChange={e => onChange(e.target.value)}
        disabled={disabled || loading || empty}
        aria-label={label}
        className={className}
      >
        <option value="">
          {loading
            ? t('workflows.startModal.project.loading', 'Loading projects...')
            : placeholder || t('workflows.startModal.project.choose', 'Select a project…')}
        </option>
        {current && !loading && !listed && (
          <option value={current}>
            {t('workflows.startModal.project.notListed', '{{id}} (not in your projects)', {
              id: current
            })}
          </option>
        )}
        {groups.map(group => (
          <optgroup key={group.group} label={t(...GROUP_LABEL_KEYS[group.group])}>
            {group.options.map(option => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      {empty && (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {t('workflows.startModal.project.empty', 'You have no projects to choose from yet.')}
        </p>
      )}
    </div>
  );
}

/**
 * A project input's value on the execution page: the project's name among
 * the viewer's projects, with the id below it; just the id when the project
 * is not in the viewer's list (or projects are not available to them).
 *
 * @param {Object} props
 * @param {string} props.projectId
 * @returns {JSX.Element}
 */
export function ProjectInputValue({ projectId }) {
  const { i18n } = useTranslation();
  const { projects } = useUsableProjects();
  const id = String(projectId ?? '');
  const name = projectNameFor(id, projects, i18n?.language || 'en');
  return (
    <span className="inline-flex flex-col">
      <span>{name}</span>
      {name !== id && (
        <span className="text-xs font-mono text-gray-500 dark:text-gray-400">{id}</span>
      )}
    </span>
  );
}

export default ProjectInputField;
