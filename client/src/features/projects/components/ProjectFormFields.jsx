// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import {
  MAX_PROJECT_DESCRIPTION_LENGTH,
  MAX_PROJECT_INSTRUCTIONS_LENGTH,
  MAX_PROJECT_NAME_LENGTH
} from '../utils/projectView';
import { HINT_CLASS, INPUT_CLASS, LABEL_CLASS } from './item-dialog/dialogStyles';

/**
 * The translated message of a form validation code.
 *
 * @param {Function} t
 * @param {string} field
 * @param {string|undefined} code
 * @returns {string|null}
 */
function fieldError(t, field, code) {
  if (!code) return null;
  if (code === 'required') return t('projects.form.nameRequired', 'A name is required.');
  const max = {
    name: MAX_PROJECT_NAME_LENGTH,
    description: MAX_PROJECT_DESCRIPTION_LENGTH,
    instructions: MAX_PROJECT_INSTRUCTIONS_LENGTH
  }[field];
  return t('projects.form.tooLong', 'At most {{max}} characters.', { max: max.toLocaleString() });
}

/**
 * Name, description and instructions of a project — the create dialog and
 * the settings card use the same fields.
 *
 * @param {Object} props
 * @param {{name: string, description: string, instructions: string}} props.form
 * @param {(field: string, value: string) => void} props.onChange
 * @param {Object<string, string>} [props.errors] - Field → validation code.
 * @param {string} [props.idPrefix='project'] - Prefix of the input ids.
 * @param {boolean} [props.disabled=false]
 * @returns {JSX.Element}
 */
function ProjectFormFields({
  form,
  onChange,
  errors = {},
  idPrefix = 'project',
  disabled = false
}) {
  const { t } = useTranslation();
  const fields = [
    { field: 'name', label: t('projects.form.name', 'Name'), rows: 0 },
    { field: 'description', label: t('projects.form.description', 'Description'), rows: 2 },
    {
      field: 'instructions',
      label: t('projects.form.instructions', 'Instructions'),
      rows: 6,
      hint: t(
        'projects.form.instructionsHint',
        'Added to the system prompt of every chat in this project, after the app’s own prompt.'
      )
    }
  ];
  return (
    <div className="space-y-4">
      {fields.map(({ field, label, rows, hint }) => {
        const id = `${idPrefix}-${field}`;
        const error = fieldError(t, field, errors[field]);
        const common = {
          id,
          value: form[field] || '',
          disabled,
          onChange: e => onChange(field, e.target.value),
          'aria-invalid': error ? true : undefined,
          className: `${INPUT_CLASS} ${field === 'instructions' ? 'font-mono text-sm' : ''}`
        };
        return (
          <div key={field}>
            <label htmlFor={id} className={LABEL_CLASS}>
              {label}
            </label>
            {rows > 0 ? <textarea rows={rows} {...common} /> : <input type="text" {...common} />}
            {hint && <p className={HINT_CLASS}>{hint}</p>}
            {error && (
              <p role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">
                {error}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default ProjectFormFields;
