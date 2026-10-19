// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import FormField from './FormField';
import {
  UNSAFE_OUTPUT_KEYS,
  isOutputObject
} from '../../../../../../../shared/workflowEndOutput.js';

const inputClass =
  'w-full text-sm border border-gray-300 dark:border-gray-600 rounded-sm px-2 py-1.5 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100';
const labelClass = 'block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1';
const helpClass = 'text-xs text-gray-500 dark:text-gray-400 mt-0.5';
const modeClass = active =>
  `text-xs px-2 py-0.5 rounded-sm border ${
    active
      ? 'bg-blue-600 border-blue-600 text-white'
      : 'border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300'
  }`;

/** A name that can stand for itself as a field of the answer. */
const IDENTIFIER = /^[A-Za-z_]\w*$/;

/** The object an output text becomes when it is split into fields. */
function fieldsFromText(text) {
  const name = typeof text === 'string' ? text.trim() : '';
  return IDENTIFIER.test(name) ? { [name]: name } : { '': '' };
}

/** The text an object output becomes when it is one value again: its first field. */
function textFromFields(fields) {
  const first = Object.values(fields).find(value => typeof value === 'string');
  return first ?? '';
}

/** `fields` with the entry `name` replaced by `[newName, value]`, in the same place. */
function withEntry(fields, name, newName, value) {
  return Object.fromEntries(
    Object.entries(fields).map(([key, current]) =>
      key === name ? [newName, value] : [key, current]
    )
  );
}

/**
 * The Output of an end step: one value (a variable, a path or a text with
 * variables), or several fields that make the answer a JSON object, each field
 * a variable, a path or a text with variables.
 *
 * @param {object} props
 * @param {string|object} [props.value] - The `output` of the end step
 * @param {(value: string|object) => void} props.onChange
 * @param {Array<{value: string, label: string}>} [props.variables] - Suggestions
 */
function EndOutputField({ value, onChange, variables }) {
  const { t } = useTranslation();
  const datalistId = useId();
  const asObject = isOutputObject(value);

  if (!asObject) {
    return (
      <div>
        <ModeSwitch
          asObject={false}
          onSelect={fields => fields && onChange(fieldsFromText(value))}
        />
        <FormField
          label={t('workflows.editor.endOutput', 'Output')}
          value={value}
          onChange={onChange}
          placeholder="finalReport"
          suggestions={variables}
          helpText={t(
            'workflows.editor.endOutputHelp',
            'The answer of the workflow, which the chat shows as it is: a variable (finalReport), a path into one (report.markdown) or a text with variables ({{summary}}). JSON stays JSON. Everything below is additional information.'
          )}
        />
      </div>
    );
  }

  const names = Object.keys(value);
  const hasBlankName = names.some(name => name.trim() === '');
  // A name another field has, or one that would reach into the prototype, is not taken
  const canTake = name => !Object.hasOwn(value, name) && !UNSAFE_OUTPUT_KEYS.includes(name);

  return (
    <div>
      <ModeSwitch asObject onSelect={fields => !fields && onChange(textFromFields(value))} />
      <span className={labelClass}>{t('workflows.editor.endOutput', 'Output')}</span>
      <div className="space-y-1.5">
        {names.map(name => (
          <FieldRow
            key={name}
            name={name}
            field={value[name]}
            listId={variables?.length > 0 ? datalistId : undefined}
            canTake={canTake}
            onRename={next => onChange(withEntry(value, name, next, value[name]))}
            onValueChange={next => onChange(withEntry(value, name, name, next))}
            onRemove={() =>
              onChange(Object.fromEntries(Object.entries(value).filter(([key]) => key !== name)))
            }
          />
        ))}
      </div>
      {variables?.length > 0 && (
        <datalist id={datalistId}>
          {variables.map(variable => (
            <option key={variable.value} value={variable.value}>
              {variable.label}
            </option>
          ))}
        </datalist>
      )}
      <button
        type="button"
        disabled={hasBlankName}
        onClick={() => onChange({ ...value, '': '' })}
        className="mt-1.5 text-xs text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 disabled:opacity-50"
      >
        + {t('workflows.editor.endOutputAddField', 'Add field')}
      </button>
      <p className={helpClass}>
        {t(
          'workflows.editor.endOutputFieldsHelp',
          'The answer is a JSON object with these fields. Each value is a variable (finalReport), a path into one (report.markdown) or a text with variables ({{summary}}). A field whose variable was never set is left out. Everything below is additional information.'
        )}
      </p>
    </div>
  );
}

/**
 * One field of an object output: its name and its value.
 *
 * The row is keyed by the name, so renaming it on every keystroke would replace
 * the row and the input would lose focus. The name is typed into a draft and
 * taken when the input is left or Enter is pressed.
 */
function FieldRow({ name, field, listId, canTake, onRename, onValueChange, onRemove }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(name);

  const commit = () => {
    if (draft === name) return;
    if (canTake(draft)) onRename(draft);
    else setDraft(name);
  };

  return (
    <div className="flex items-start gap-1.5">
      <input
        type="text"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => e.key === 'Enter' && commit()}
        placeholder={t('workflows.editor.endOutputFieldName', 'Field name')}
        aria-label={t('workflows.editor.endOutputFieldName', 'Field name')}
        className={`${inputClass} flex-1`}
      />
      {typeof field === 'string' ? (
        <input
          type="text"
          value={field}
          onChange={e => onValueChange(e.target.value)}
          placeholder={t('workflows.editor.endOutputFieldValue', 'Variable or text')}
          aria-label={t('workflows.editor.endOutputFieldValue', 'Variable or text')}
          list={listId}
          className={`${inputClass} flex-1`}
        />
      ) : (
        <pre className="flex-1 text-xs font-mono border border-amber-300 dark:border-amber-700 rounded-sm px-2 py-1.5 bg-amber-50 dark:bg-amber-900/20 text-amber-900 dark:text-amber-200 whitespace-pre-wrap wrap-break-word max-h-24 overflow-y-auto">
          {JSON.stringify(field, null, 2)}
        </pre>
      )}
      <button
        type="button"
        onClick={onRemove}
        className="text-red-500 hover:text-red-700 dark:hover:text-red-400 p-1 text-sm shrink-0"
        aria-label={t('workflows.editor.endOutputRemoveField', 'Remove field')}
      >
        &#x2715;
      </button>
    </div>
  );
}

/** The switch between one value and several fields; `onSelect(true)` asks for fields. */
function ModeSwitch({ asObject, onSelect }) {
  const { t } = useTranslation();
  return (
    <div className="flex gap-1 mb-1.5">
      <button
        type="button"
        aria-pressed={!asObject}
        onClick={() => onSelect(false)}
        className={modeClass(!asObject)}
      >
        {t('workflows.editor.endOutputOneValue', 'One value')}
      </button>
      <button
        type="button"
        aria-pressed={asObject}
        onClick={() => onSelect(true)}
        className={modeClass(asObject)}
      >
        {t('workflows.editor.endOutputSeveralFields', 'Several fields')}
      </button>
    </div>
  );
}

export default EndOutputField;
