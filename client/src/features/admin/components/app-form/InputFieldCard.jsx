// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import Icon from '../../../../shared/components/Icon';
import {
  CALLOUT_CLASS,
  CHECKBOX_CLASS,
  HELP_CLASS,
  INPUT_CLASS,
  LABEL_CLASS,
  SECONDARY_BUTTON_CLASS
} from '../formStyles';
import AppLanguageField from './AppLanguageField';

const REMOVE_BUTTON_CLASS =
  'rounded-sm p-1 text-red-600 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-red-500';

/** The mark of a required field; the input itself carries `required`. */
function RequiredMark() {
  return (
    <span className="text-red-500 ml-1" aria-hidden="true">
      *
    </span>
  );
}

/**
 * InputFieldCard - one input field of an app (an entry of `app.variables`):
 * field name, placeholder, kind of field, whether users must fill it in, the
 * prefilled value and the options.
 *
 * @param {object} props
 * @param {object} props.variable - The entry of `app.variables`.
 * @param {number} props.index - Its position in the list.
 * @param {boolean} props.unused - True when no text uses the placeholder, so
 *   the AI does not receive what users enter.
 * @param {string} props.newTextLanguage - The language a new option is written in.
 * @param {function(object): void} props.onChange - Receives the changed keys of the entry.
 * @param {function(object): void} props.onLabelChange - Receives the field name in its languages.
 * @param {function(string): void} props.onNameChange - Receives the placeholder the author typed.
 * @param {function(): void} props.onRemove
 * @param {function(): void} props.onAddToTemplate - Adds the field's line to the message template.
 * @returns {JSX.Element}
 */
function InputFieldCard({
  variable,
  index,
  unused,
  newTextLanguage,
  onChange,
  onLabelChange,
  onNameChange,
  onRemove,
  onAddToTemplate
}) {
  const { t } = useTranslation();
  const heading = `${t('admin.apps.edit.variable')} ${index + 1}`;
  const fieldId = `variables.${index}`;
  const options = variable.predefinedValues || [];

  const updateOption = (optionIndex, patch) =>
    onChange({
      predefinedValues: options.map((option, i) =>
        i === optionIndex ? { ...option, ...patch } : option
      )
    });

  const addOption = () =>
    onChange({
      predefinedValues: [...options, { label: { [newTextLanguage]: '' }, value: '' }]
    });

  const removeOption = optionIndex =>
    onChange({ predefinedValues: options.filter((_, i) => i !== optionIndex) });

  return (
    <div className="border border-gray-200 dark:border-gray-600 rounded-lg p-4">
      <div className="flex justify-between items-start mb-4">
        <h4 className="text-sm font-medium text-gray-900 dark:text-gray-100">{heading}</h4>
        <button
          type="button"
          onClick={onRemove}
          aria-label={`${t('common.delete')}: ${heading}`}
          className={REMOVE_BUTTON_CLASS}
        >
          <Icon name="trash" className="h-4 w-4" />
        </button>
      </div>

      <div className="grid grid-cols-6 gap-4">
        <div className="col-span-6">
          <AppLanguageField
            label={t('admin.apps.edit.variableLabel')}
            help={t('admin.apps.edit.variableLabelHelp')}
            value={variable.label || {}}
            onChange={onLabelChange}
            required={true}
            name={`${fieldId}.label`}
          />
        </div>

        <div className="col-span-6 sm:col-span-3">
          <label htmlFor={`${fieldId}.name`} className={LABEL_CLASS}>
            {t('admin.apps.edit.variableName')}
            <RequiredMark />
          </label>
          <input
            id={`${fieldId}.name`}
            type="text"
            required
            value={variable.name || ''}
            onChange={e => onNameChange(e.target.value)}
            aria-describedby={`${fieldId}.name-help`}
            className={`${INPUT_CLASS} font-mono`}
          />
          <p id={`${fieldId}.name-help`} className={HELP_CLASS}>
            {/* The braces are text for the reader, not a value to fill in. */}
            {t('admin.apps.edit.variableNameHelp', {
              placeholder: `{{${variable.name || 'placeholder'}}}`
            })}
          </p>
        </div>

        <div className="col-span-6 sm:col-span-3">
          <label htmlFor={`${fieldId}.type`} className={LABEL_CLASS}>
            {t('admin.apps.edit.variableType')}
          </label>
          <select
            id={`${fieldId}.type`}
            value={variable.type || 'string'}
            onChange={e => onChange({ type: e.target.value })}
            className={INPUT_CLASS}
          >
            <option value="string">{t('admin.apps.edit.typeString')}</option>
            <option value="text">{t('admin.apps.edit.typeText')}</option>
            <option value="select">{t('admin.apps.edit.typeSelect')}</option>
            <option value="date">{t('admin.apps.edit.typeDate')}</option>
            <option value="number">{t('admin.apps.edit.typeNumber')}</option>
          </select>
        </div>

        {unused && (
          <div
            className={`col-span-6 ${CALLOUT_CLASS.warning}`}
            data-testid={`variable-unused-${index}`}
          >
            <p>{t('admin.apps.edit.variableUnused')}</p>
            <button
              type="button"
              onClick={onAddToTemplate}
              className={`${SECONDARY_BUTTON_CLASS} mt-2`}
            >
              {t('admin.apps.edit.variableAddToTemplate')}
            </button>
          </div>
        )}

        <div className="col-span-6 flex items-center">
          <input
            id={`${fieldId}.required`}
            type="checkbox"
            checked={variable.required || false}
            onChange={e => onChange({ required: e.target.checked })}
            className={CHECKBOX_CLASS}
          />
          <label
            htmlFor={`${fieldId}.required`}
            className="ml-2 block text-sm text-gray-900 dark:text-gray-100"
          >
            {t('admin.apps.edit.required')}
          </label>
        </div>

        <div className="col-span-6">
          <AppLanguageField
            label={t('admin.apps.edit.defaultValue')}
            value={variable.defaultValue || {}}
            onChange={value => onChange({ defaultValue: value })}
            name={`${fieldId}.defaultValue`}
          />
        </div>

        <fieldset className="col-span-6">
          <legend className={LABEL_CLASS}>{t('admin.apps.edit.predefinedValues')}</legend>
          <p className={`${HELP_CLASS} mb-2`}>
            {variable.type === 'select'
              ? t('admin.apps.edit.predefinedValuesHintSelect')
              : t('admin.apps.edit.predefinedValuesHint')}
          </p>
          <div className="space-y-2">
            {options.map((option, optionIndex) => {
              const optionLabel = `${t('admin.apps.edit.option')} ${optionIndex + 1}`;
              const optionId = `${fieldId}.predefinedValues.${optionIndex}`;
              return (
                <div key={optionIndex} className="flex flex-wrap items-end gap-2">
                  <div className="min-w-0 flex-1 basis-64">
                    <AppLanguageField
                      label={optionLabel}
                      value={option.label || {}}
                      onChange={value => updateOption(optionIndex, { label: value })}
                      required={true}
                      name={`${optionId}.label`}
                    />
                  </div>
                  <div className="w-48">
                    <label htmlFor={`${optionId}.value`} className={LABEL_CLASS}>
                      {t('admin.apps.edit.value')}
                      <RequiredMark />
                    </label>
                    <input
                      id={`${optionId}.value`}
                      type="text"
                      required
                      value={option.value || ''}
                      onChange={e => updateOption(optionIndex, { value: e.target.value })}
                      className={INPUT_CLASS}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => removeOption(optionIndex)}
                    aria-label={`${t('common.delete')}: ${optionLabel}`}
                    className={`${REMOVE_BUTTON_CLASS} mb-2`}
                  >
                    <Icon name="trash" className="h-4 w-4" />
                  </button>
                </div>
              );
            })}
            <button type="button" onClick={addOption} className={SECONDARY_BUTTON_CLASS}>
              <Icon name="plus" className="h-4 w-4" />
              {t('admin.apps.edit.addOption')}
            </button>
          </div>
        </fieldset>
      </div>
    </div>
  );
}

export default InputFieldCard;
