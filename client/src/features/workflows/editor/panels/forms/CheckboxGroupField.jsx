// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A multi-select as a group of checkboxes, sized for the editor's side panel.
 *
 * The group only reports which box was toggled; what an empty selection
 * means (any value, a default, nothing) is the caller's rule.
 *
 * @param {Object} props
 * @param {string} props.label - Group label (rendered as the fieldset legend).
 * @param {Array<{value: string, label: string}>} props.options
 * @param {string[]} [props.value=[]] - The checked values.
 * @param {(value: string) => void} props.onToggle - Called with the toggled option's value.
 * @param {string} [props.helpText]
 * @param {boolean} [props.disabled=false]
 * @returns {JSX.Element}
 */
function CheckboxGroupField({ label, options, value = [], onToggle, helpText, disabled = false }) {
  const checked = new Set(Array.isArray(value) ? value : []);
  return (
    <fieldset>
      <legend className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
        {label}
      </legend>
      <div className="grid grid-cols-2 gap-x-2 gap-y-1">
        {options.map(option => (
          <label
            key={option.value}
            className="flex items-center gap-1.5 text-sm text-gray-700 dark:text-gray-300 min-w-0 cursor-pointer"
          >
            <input
              type="checkbox"
              checked={checked.has(option.value)}
              onChange={() => onToggle(option.value)}
              disabled={disabled}
              className="rounded-sm border-gray-300 dark:border-gray-600 shrink-0"
            />
            <span className="truncate" title={option.label}>
              {option.label}
            </span>
          </label>
        ))}
      </div>
      {helpText && <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{helpText}</p>}
    </fieldset>
  );
}

export default CheckboxGroupField;
