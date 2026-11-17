// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import FormField from './FormField';
import LocalizedField from './LocalizedField';

const STYLE_OPTIONS = [
  { value: 'primary', label: 'Primary' },
  { value: 'secondary', label: 'Secondary' },
  { value: 'danger', label: 'Danger' }
];

/**
 * Settings of an "Ask a Person" (`human`) step: the message, the options the
 * person answers with, the timeout and the output variable.
 *
 * An option's label may be a plain string or a localized object
 * (`{ en, de }`); it is edited per language so the other languages are kept
 * (AX-B5). An empty options list is flagged: such a step cannot be answered,
 * and the server refuses to save it (AX-B4). Without an options list at all
 * the run offers a single "Continue".
 *
 * @param {object} props
 * @param {object} props.config - The step's `config`.
 * @param {(config: object) => void} props.onChange - Receives the new config.
 */
function HumanForm({ config, onChange }) {
  const { t } = useTranslation();
  const optionsHeadingId = useId();
  const options = Array.isArray(config.options) ? config.options : [];
  const hasEmptyOptionList = Array.isArray(config.options) && config.options.length === 0;

  // A stable React key per option row. An option has no id of its own and its
  // value may be empty or repeated; keyed by index, removing a row would hand
  // its per-row state (the language tab being edited) to the next row.
  const optionKeysRef = useRef([]);
  const nextOptionKeyRef = useRef(0);
  if (optionKeysRef.current.length !== options.length) {
    // The list changed from outside (another step selected, an undo): new rows
    // get new keys, surplus keys are dropped.
    while (optionKeysRef.current.length < options.length) {
      optionKeysRef.current.push(nextOptionKeyRef.current++);
    }
    optionKeysRef.current.length = options.length;
  }

  const updateOption = (index, field, value) => {
    const updated = options.map((opt, i) => (i === index ? { ...opt, [field]: value } : opt));
    onChange({ ...config, options: updated });
  };

  const addOption = () => {
    onChange({
      ...config,
      options: [...options, { value: '', label: '', style: 'primary' }]
    });
  };

  const removeOption = index => {
    optionKeysRef.current = optionKeysRef.current.filter((_, i) => i !== index);
    onChange({ ...config, options: options.filter((_, i) => i !== index) });
  };

  const inputClass =
    'w-full text-sm border border-gray-300 dark:border-gray-600 rounded-sm px-2 py-1.5 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100';
  const labelClass = 'block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1';

  return (
    <div className="space-y-3">
      <LocalizedField
        label="Message"
        rows={4}
        value={config.message}
        onChange={v => onChange({ ...config, message: v })}
        placeholder="What should the user be asked?"
      />
      <div>
        {/* Names the group of option rows; each field has its own name. */}
        <span id={optionsHeadingId} className={labelClass}>
          Options
        </span>
        <div role="group" aria-labelledby={optionsHeadingId} className="space-y-2">
          {options.map((opt, index) => (
            <div
              key={optionKeysRef.current[index]}
              className="border border-gray-200 dark:border-gray-700 rounded-sm p-2 space-y-1.5"
            >
              {/* Three fields plus a delete button do not fit one row in the
                  320px panel; stack them so each stays readable. */}
              <input
                type="text"
                value={opt.value || ''}
                onChange={e => updateOption(index, 'value', e.target.value)}
                placeholder="Value"
                aria-label={t('workflows.editor.human.optionValueN', 'Value of option {{n}}', {
                  n: index + 1
                })}
                className={`${inputClass} font-mono`}
              />
              <LocalizedField
                label={t('workflows.editor.human.optionLabel', 'Label')}
                singleLine
                ariaLabel={t('workflows.editor.human.optionLabelN', 'Label of option {{n}}', {
                  n: index + 1
                })}
                value={opt.label ?? ''}
                onChange={v => updateOption(index, 'label', v)}
                placeholder={t('workflows.editor.human.optionLabel', 'Label')}
              />
              <div className="flex items-center gap-1.5">
                <select
                  value={opt.style || 'primary'}
                  onChange={e => updateOption(index, 'style', e.target.value)}
                  aria-label={t('workflows.editor.human.optionStyleN', 'Style of option {{n}}', {
                    n: index + 1
                  })}
                  className={`flex-1 min-w-0 ${inputClass}`}
                >
                  {STYLE_OPTIONS.map(s => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => removeOption(index)}
                  className="text-red-500 hover:text-red-700 dark:hover:text-red-400 p-1 text-sm shrink-0"
                  aria-label={t('workflows.editor.human.removeOptionN', 'Remove option {{n}}', {
                    n: index + 1
                  })}
                >
                  &#x2715;
                </button>
              </div>
            </div>
          ))}
        </div>
        {hasEmptyOptionList && (
          <p role="alert" className="mt-1.5 text-xs text-red-600 dark:text-red-400">
            {t(
              'workflows.editor.human.noOptions',
              'Add at least one option. Without one, nobody can answer this step and the run waits until it is cancelled.'
            )}
          </p>
        )}
        <button
          type="button"
          onClick={addOption}
          className="mt-1.5 text-xs text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 flex items-center gap-1"
        >
          <span>+</span> Add option
        </button>
      </div>
      <FormField
        label="Timeout (ms)"
        type="number"
        value={config.timeout}
        onChange={v => onChange({ ...config, timeout: v })}
        min={1000}
        step={1000}
        placeholder="ms"
      />
      <FormField
        label="Output Variable"
        value={config.outputVariable}
        onChange={v => onChange({ ...config, outputVariable: v })}
        placeholder="e.g. userResponse"
      />
    </div>
  );
}

export default HumanForm;
