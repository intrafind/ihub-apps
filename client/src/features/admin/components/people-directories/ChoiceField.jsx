// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { CHECKBOX_CLASS, RADIO_CLASS } from './formStyles';

/**
 * A radio button or checkbox with a visible label and an optional help line.
 * The label names the control (`htmlFor`), and the help line is its
 * description (`aria-describedby`), so a screen reader reads both.
 *
 * @param {Object} props
 * @param {string} props.id - Element id of the input
 * @param {'radio'|'checkbox'} [props.type='radio']
 * @param {string} [props.name] - Radio group name
 * @param {string} [props.value] - Radio value
 * @param {boolean} props.checked
 * @param {(checked: boolean) => void} props.onChange - Called with the new checked state
 * @param {React.ReactNode} props.label
 * @param {React.ReactNode} [props.help]
 * @param {string} [props.describedBy] - Further ids describing the control
 */
function ChoiceField({
  id,
  type = 'radio',
  name,
  value,
  checked,
  onChange,
  label,
  help,
  describedBy
}) {
  const helpId = help ? `${id}-help` : undefined;
  const describedByIds = [helpId, describedBy].filter(Boolean).join(' ') || undefined;
  return (
    <div className="flex items-start gap-3">
      <input
        id={id}
        type={type}
        name={name}
        value={value}
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        aria-describedby={describedByIds}
        className={`${type === 'radio' ? RADIO_CLASS : CHECKBOX_CLASS} mt-0.5 shrink-0`}
      />
      <div>
        <label htmlFor={id} className="block text-sm font-medium text-gray-900 dark:text-gray-100">
          {label}
        </label>
        {help && (
          <p id={helpId} className="text-xs text-gray-600 dark:text-gray-400">
            {help}
          </p>
        )}
      </div>
    </div>
  );
}

export default ChoiceField;
