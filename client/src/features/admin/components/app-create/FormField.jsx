// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { INPUT_CLASS, LABEL_CLASS, HELP_CLASS } from '../formStyles';
import { fieldDomId } from './createKeys';
import { FIELD_ERROR_CLASS, INVALID_INPUT_CLASS } from './createStyles';

/**
 * One labelled field of the Essentials screen: the label with the asterisk
 * of a required field, the control, the message when the field needs
 * attention, hints that do not block, and the help text. The control is
 * described by all three.
 *
 * The control is rendered by the caller, from the attributes this component
 * hands over: `id`, `aria-required`, `aria-invalid`, `aria-describedby` and
 * `className`.
 *
 * @param {object} props
 * @param {string} props.field - The field's name; its DOM id follows from it.
 * @param {string} props.label
 * @param {boolean} [props.required=false]
 * @param {string} [props.help]
 * @param {string|true|null} [props.error] - The message, or `true` for a
 *   field that is marked and explained by `describedBy`.
 * @param {string[]} [props.notes] - Hints under the field that do not block.
 * @param {string} [props.describedBy] - The element that explains a marked field.
 * @param {React.ReactNode} [props.aside] - Shown at the end of the label's line.
 * @param {(control: object) => React.ReactNode} props.children
 * @returns {JSX.Element}
 */
function FormField({
  field,
  label,
  required = false,
  help,
  error = null,
  notes = [],
  describedBy,
  aside,
  children
}) {
  const id = fieldDomId(field);
  const message = typeof error === 'string' ? error : null;
  const described = [
    help ? `${id}-help` : null,
    message ? `${id}-error` : null,
    error === true ? describedBy : null,
    notes.length > 0 ? `${id}-notes` : null
  ].filter(Boolean);
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4">
        <label htmlFor={id} className={LABEL_CLASS}>
          {label}
          {required && <span aria-hidden="true"> *</span>}
        </label>
        {aside}
      </div>
      {children({
        id,
        'aria-required': required ? 'true' : undefined,
        'aria-invalid': error ? 'true' : undefined,
        'aria-describedby': described.length > 0 ? described.join(' ') : undefined,
        className: `${INPUT_CLASS} ${error ? INVALID_INPUT_CLASS : ''}`
      })}
      {message && (
        <p id={`${id}-error`} className={FIELD_ERROR_CLASS}>
          {message}
        </p>
      )}
      {notes.length > 0 && (
        <div
          id={`${id}-notes`}
          role="status"
          className="mt-1 space-y-1 text-sm text-amber-800 dark:text-amber-300"
        >
          {notes.map(note => (
            <p key={note}>{note}</p>
          ))}
        </div>
      )}
      {help && (
        <p id={`${id}-help`} className={HELP_CLASS}>
          {help}
        </p>
      )}
    </div>
  );
}

export default FormField;
