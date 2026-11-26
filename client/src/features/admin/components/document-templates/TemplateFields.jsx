// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import DynamicLanguageEditor from '../../../../shared/components/DynamicLanguageEditor';
import Icon from '../../../../shared/components/Icon';
import { MAX_FIELDS, fieldNameFrom, fieldNameProblem } from '../../utils/documentTemplates';
import {
  CALLOUT_CLASS,
  CHECKBOX_CLASS,
  DANGER_BUTTON_CLASS,
  HELP_CLASS,
  INPUT_CLASS,
  LABEL_CLASS,
  SECONDARY_BUTTON_CLASS
} from '../formStyles';

function FieldCard({ name, field, inWord, error, onChange, onRemove }) {
  const { t } = useTranslation();
  const baseId = useId();
  const set = patch => onChange({ ...field, ...patch });
  const options = field.options || [];
  return (
    <fieldset className="rounded-md border border-gray-200 dark:border-gray-700 p-3 space-y-3">
      <legend className="px-1 text-sm font-semibold text-gray-900 dark:text-gray-100">
        <code>{`{{${name}}}`}</code>
      </legend>
      {inWord === false && (
        <p className={CALLOUT_CLASS.warning}>
          {t(
            'admin.documentTemplates.fields.notInWord',
            'The Word template has no {{placeholder}} placeholder any more. Remove the field, or add the placeholder to the Word template.',
            { placeholder: `{{${name}}}` }
          )}
        </p>
      )}
      <DynamicLanguageEditor
        label={t('admin.documentTemplates.fields.label', 'Label')}
        value={field.label || {}}
        onChange={value => set({ label: value })}
        translate={false}
        help={t(
          'admin.documentTemplates.fields.labelHelp',
          'What the user is asked for, for example "Classification".'
        )}
      />
      <DynamicLanguageEditor
        label={t('admin.documentTemplates.fields.description', 'Description')}
        value={field.description || {}}
        onChange={value => set({ description: value })}
        translate={false}
        help={t(
          'admin.documentTemplates.fields.descriptionHelp',
          'Told to the model, so it knows what belongs in the field.'
        )}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={`${baseId}-options`} className={LABEL_CLASS}>
            {t('admin.documentTemplates.fields.options', 'Allowed values')}
          </label>
          <textarea
            id={`${baseId}-options`}
            rows={3}
            className={INPUT_CLASS}
            value={options.join('\n')}
            onChange={event => set({ options: event.target.value.split('\n') })}
          />
          <p className={HELP_CLASS}>
            {t(
              'admin.documentTemplates.fields.optionsHelp',
              'One value per line. Empty: any text is allowed.'
            )}
          </p>
        </div>
        <div className="space-y-3">
          <div>
            <label htmlFor={`${baseId}-default`} className={LABEL_CLASS}>
              {t('admin.documentTemplates.fields.default', 'Default value')}
            </label>
            <input
              id={`${baseId}-default`}
              className={INPUT_CLASS}
              value={field.default || ''}
              onChange={event => set({ default: event.target.value })}
            />
          </div>
          <label className="inline-flex items-center gap-2 text-sm text-gray-800 dark:text-gray-200">
            <input
              type="checkbox"
              className={CHECKBOX_CLASS}
              checked={Boolean(field.required)}
              onChange={event => set({ required: event.target.checked })}
            />
            {t(
              'admin.documentTemplates.fields.required',
              'Required: the model asks the user when there is no value'
            )}
          </label>
        </div>
      </div>
      {error && (
        <p className="text-xs text-red-700 dark:text-red-300" role="alert">
          {error}
        </p>
      )}
      <button type="button" className={DANGER_BUTTON_CLASS} onClick={onRemove}>
        <Icon name="trash" size="sm" />
        {t('admin.documentTemplates.fields.remove', 'Remove field')}
      </button>
    </fieldset>
  );
}

/**
 * The custom fields of a document template: the `{{name}}` placeholders of
 * its Word template that the model or the user fills in. Uploading a Word
 * template declares the ones it has; this editor sets their label, their
 * allowed values and whether they are required, and adds or removes fields.
 *
 * @param {Object} props
 * @param {Object<string, Object>} props.fields - The template's fields, by name.
 * @param {string[]} [props.foundInWord] - The custom placeholders of the Word
 *   template; `undefined` without a Word template (nothing to compare with).
 * @param {Object<string, string>} [props.errors] - `field:<name>` messages.
 * @param {(fields: Object) => void} props.onChange
 */
export default function TemplateFields({ fields, foundInWord, errors = {}, onChange }) {
  const { t } = useTranslation();
  const [newName, setNewName] = useState('');
  const newId = useId();
  const names = Object.keys(fields || {});
  const name = fieldNameFrom(newName);
  const problem = newName.trim() ? fieldNameProblem(name, fields, t) : null;
  const add = () => {
    if (!name || problem) return;
    onChange({ ...fields, [name]: {} });
    setNewName('');
  };

  return (
    <div className="space-y-3">
      {names.length === 0 && (
        <p className="text-sm text-gray-600 dark:text-gray-400">
          {t(
            'admin.documentTemplates.fields.none',
            'No fields. A {{example}} in the Word template that is not a built-in placeholder becomes a field when the template is uploaded.',
            { example: '{{name}}' }
          )}
        </p>
      )}
      {names.map(fieldName => (
        <FieldCard
          key={fieldName}
          name={fieldName}
          field={fields[fieldName] || {}}
          inWord={foundInWord ? foundInWord.includes(fieldName) : undefined}
          error={errors[`field:${fieldName}`]}
          onChange={value => onChange({ ...fields, [fieldName]: value })}
          onRemove={() => {
            const rest = { ...fields };
            delete rest[fieldName];
            onChange(rest);
          }}
        />
      ))}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="sm:w-72">
          <label htmlFor={newId} className={LABEL_CLASS}>
            {t('admin.documentTemplates.fields.newName', 'New field')}
          </label>
          <input
            id={newId}
            className={`${INPUT_CLASS} font-mono`}
            value={newName}
            placeholder="classification"
            aria-invalid={problem ? true : undefined}
            onChange={event => setNewName(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                event.preventDefault();
                add();
              }
            }}
          />
        </div>
        <button
          type="button"
          className={SECONDARY_BUTTON_CLASS}
          disabled={!name || Boolean(problem) || names.length >= MAX_FIELDS}
          onClick={add}
        >
          <Icon name="plus" size="sm" />
          {t('admin.documentTemplates.fields.add', 'Add field')}
        </button>
      </div>
      {problem && (
        <p className="text-xs text-red-700 dark:text-red-300" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}
