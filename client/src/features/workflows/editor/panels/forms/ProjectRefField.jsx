// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { localizedText } from '../../../../projects/utils/projectItems';
import { isProjectReference, referenceSuggestions } from '../../../utils/projectNodeConfig';
import { useAdminProjectOptions } from './useProjectNodeOptions';

const inputClass =
  'w-full text-sm border border-gray-300 dark:border-gray-600 rounded-sm px-2 py-1.5 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100';
const labelClass = 'block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1';

/**
 * The `project` field of the project steps (`project-items`, `project-read`,
 * `project-write`).
 *
 * Two ways to name the project, switched by a small toggle:
 *
 *  - **Choose a project**: a select over the admin projects the author can
 *    see (`GET /api/admin/projects`, the list the admin `ProjectPicker` uses);
 *  - **ID or variable**: free text for any project id (a user project too) or
 *    a `$.data.<name>` reference, with the visible variables suggested as
 *    references — typically a start input of type `project`.
 *
 * The field opens in the second mode when the value already is a reference,
 * and stays in it when the project list cannot be loaded.
 *
 * A value chosen from the list is reported with `{ picked: true }`, so the
 * form can save the step link the server needs to reach an admin project
 * (`withProjectValue`); a typed value is not.
 *
 * @param {Object} props
 * @param {string} [props.value] - Project id or `$.data…` reference.
 * @param {(value: string, options: {picked: boolean}) => void} props.onChange
 * @param {Array<{value: string, label: string}>} [props.variables] - Variables visible to the step.
 * @param {string} [props.helpText] - Extra help shown below the field.
 * @returns {JSX.Element}
 */
function ProjectRefField({ value, onChange, variables, helpText }) {
  const { t, i18n } = useTranslation();
  const language = i18n?.language || 'en';
  const inputId = useId();
  const datalistId = useId();
  const current = typeof value === 'string' ? value : '';
  const [mode, setMode] = useState(() => (isProjectReference(current) ? 'reference' : 'pick'));
  const { projects, loading, error, featureDisabled } = useAdminProjectOptions();

  const listUnavailable = error || featureDisabled;
  const effectiveMode = listUnavailable ? 'reference' : mode;
  const suggestions = useMemo(() => referenceSuggestions(variables), [variables]);

  // Disabled projects are not offered, but one that is already set stays visible.
  const options = useMemo(
    () =>
      projects
        .filter(project => project.enabled !== false || project.id === current)
        .map(project => ({
          id: project.id,
          name: localizedText(project.name, language) || project.id,
          enabled: project.enabled !== false
        })),
    [projects, current, language]
  );
  const currentIsListed = !current || options.some(option => option.id === current);

  const modeButton = (id, label) => (
    <button
      type="button"
      aria-pressed={effectiveMode === id}
      disabled={listUnavailable}
      onClick={() => setMode(id)}
      className={`px-2 py-0.5 text-xs rounded-sm border transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
        effectiveMode === id
          ? 'bg-blue-50 dark:bg-blue-900/30 border-blue-300 dark:border-blue-700 text-blue-700 dark:text-blue-300'
          : 'border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700'
      }`}
    >
      {label}
    </button>
  );

  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-1">
        <label htmlFor={inputId} className={`${labelClass} mb-0`}>
          {t('workflows.editor.projectNodes.project.label', 'Project')}
        </label>
        <div
          role="group"
          aria-label={t(
            'workflows.editor.projectNodes.project.modeLabel',
            'How to name the project'
          )}
          className="flex items-center gap-1"
        >
          {modeButton('pick', t('workflows.editor.projectNodes.project.modePick', 'Choose'))}
          {modeButton(
            'reference',
            t('workflows.editor.projectNodes.project.modeReference', 'ID or variable')
          )}
        </div>
      </div>

      {effectiveMode === 'pick' ? (
        <select
          id={inputId}
          value={current}
          onChange={e => onChange(e.target.value, { picked: true })}
          disabled={loading}
          className={inputClass}
        >
          <option value="">
            {loading
              ? t('admin.projects.picker.loading', 'Loading projects...')
              : t('workflows.editor.projectNodes.project.choose', 'Select a project…')}
          </option>
          {!currentIsListed && (
            <option value={current}>
              {t('workflows.editor.projectNodes.project.notListed', '{{id}} (not in the list)', {
                id: current
              })}
            </option>
          )}
          {options.map(option => (
            <option key={option.id} value={option.id}>
              {option.enabled
                ? option.name
                : t('workflows.editor.projectNodes.project.disabledOption', '{{name}} (disabled)', {
                    name: option.name
                  })}
            </option>
          ))}
        </select>
      ) : (
        <>
          <input
            id={inputId}
            type="text"
            value={current}
            onChange={e => onChange(e.target.value, { picked: false })}
            placeholder="$.data.project"
            list={suggestions.length > 0 ? datalistId : undefined}
            className={`${inputClass} font-mono`}
          />
          {suggestions.length > 0 && (
            <datalist id={datalistId}>
              {suggestions.map(suggestion => (
                <option key={suggestion.value} value={suggestion.value}>
                  {suggestion.label}
                </option>
              ))}
            </datalist>
          )}
        </>
      )}

      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
        {featureDisabled
          ? t(
              'workflows.editor.projectNodes.project.featureDisabled',
              'Projects are switched off on this server. Enter a project id or a $.data reference.'
            )
          : error
            ? t(
                'workflows.editor.projectNodes.project.loadError',
                'The projects could not be loaded. Enter a project id or a $.data reference.'
              )
            : effectiveMode === 'pick'
              ? t(
                  'workflows.editor.projectNodes.project.pickHelp',
                  'Admin projects you can see. For a user project, or the project the user picks when starting the run, switch to "ID or variable".'
                )
              : t(
                  'workflows.editor.projectNodes.project.referenceHelp',
                  'A project id, or a $.data reference such as a workflow input of type Project (e.g. $.data.project).'
                )}
      </p>
      {helpText && <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{helpText}</p>}
    </div>
  );
}

export default ProjectRefField;
