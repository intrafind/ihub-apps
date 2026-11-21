// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../../shared/components/Icon';
import {
  addVariableToTemplate,
  placeholderFromLabel,
  unusedVariables
} from '../../../../../../shared/appPlaceholders.js';
import { CHECKBOX_CLASS, HELP_CLASS, SECONDARY_BUTTON_CLASS } from '../formStyles';
import AppLanguageField, { useAppFormLanguage } from './AppLanguageField';
import InputFieldCard from './InputFieldCard';

/** The text of a localized value in a language, else in any language it has. */
function textIn(value, language) {
  if (!value || typeof value !== 'object') return '';
  const texts = [value[language], ...Object.values(value)];
  return texts.find(text => typeof text === 'string' && text.trim()) || '';
}

/**
 * VariablesSection - the input fields of an app (`app.variables`), the form
 * they can be asked in when a chat starts (`app.startForm`, issue #2581) and
 * the panel they sit in beside the chat otherwise (`app.variablesPanel`,
 * issue #3053).
 *
 * A field reaches the AI only where its placeholder stands in the
 * instructions or in the message template. A field that no text uses says so
 * and offers to add its line to the message template. A field added here gets
 * its placeholder from its field name until the author edits the placeholder
 * or a text uses it.
 *
 * @param {object} props
 * @param {object} props.app - The app as the editor holds it.
 * @param {function(object): void} props.onChange - Receives the changed app.
 * @returns {JSX.Element}
 */
function VariablesSection({ app, onChange }) {
  const { t } = useTranslation();
  const formLanguage = useAppFormLanguage();
  const newTextLanguage = formLanguage || 'en';
  const variables = app.variables || [];
  const unused = unusedVariables(app);
  // Fields added here whose placeholder still follows the field name:
  // index → the placeholder derived last. An entry counts only while the
  // field still carries that placeholder, so it never applies to a field
  // that was loaded, renamed or replaced.
  const derivedNamesRef = useRef(new Map());

  const setVariables = next => onChange({ ...app, variables: next });

  const updateVariable = (index, patch) =>
    setVariables(
      variables.map((variable, i) => (i === index ? { ...variable, ...patch } : variable))
    );

  const followsFieldName = (variable, index) =>
    derivedNamesRef.current.has(index) &&
    derivedNamesRef.current.get(index) === (variable.name || '') &&
    // A placeholder that a text uses stays: renaming it would break the text.
    (!variable.name || unused.includes(variable));

  const handleLabelChange = (index, label) => {
    const variable = variables[index];
    if (!followsFieldName(variable, index)) {
      updateVariable(index, { label });
      return;
    }
    const text = textIn(label, newTextLanguage);
    const taken = variables.filter((_, i) => i !== index).map(other => other.name);
    const name = text ? placeholderFromLabel(text, taken) : '';
    derivedNamesRef.current.set(index, name);
    updateVariable(index, { label, name });
  };

  const handleNameChange = (index, name) => {
    derivedNamesRef.current.delete(index);
    updateVariable(index, { name });
  };

  const addVariable = () => {
    derivedNamesRef.current.set(variables.length, '');
    setVariables([
      ...variables,
      {
        name: '',
        label: { [newTextLanguage]: '' },
        type: 'string',
        required: false
        // No defaultValue and no predefinedValues: they are added when needed.
      }
    ]);
  };

  const removeVariable = index => {
    derivedNamesRef.current = new Map(
      [...derivedNamesRef.current]
        .filter(([i]) => i !== index)
        .map(([i, name]) => [i > index ? i - 1 : i, name])
    );
    setVariables(variables.filter((_, i) => i !== index));
  };

  /** The line `<Field name>: {{placeholder}}` at the end of the message template. */
  const addToTemplate = variable => {
    const templateLanguages =
      app.prompt && typeof app.prompt === 'object' ? Object.keys(app.prompt) : [];
    // A template the app has is extended in each of its languages. A new one
    // is written in the language of the field name.
    const labelLanguages =
      variable.label && typeof variable.label === 'object' ? Object.keys(variable.label) : [];
    const language =
      templateLanguages.length > 0
        ? undefined
        : labelLanguages.includes(newTextLanguage) || labelLanguages.length === 0
          ? newTextLanguage
          : labelLanguages[0];
    onChange(addVariableToTemplate(app, variable, language));
  };

  const handleStartFormChange = (field, value) =>
    onChange({ ...app, startForm: { ...app.startForm, [field]: value } });

  return (
    <div className="bg-white dark:bg-gray-800 shadow-sm px-4 py-5 sm:rounded-lg sm:p-6">
      <div className="md:grid md:grid-cols-3 md:gap-6">
        <div className="md:col-span-1">
          <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
            {t('admin.apps.edit.variables')}
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t('admin.apps.edit.variablesDesc')}
          </p>
        </div>
        <div className="mt-5 md:col-span-2 md:mt-0">
          <div className="space-y-4">
            {variables.length === 0 && (
              <p className="text-sm text-gray-600 dark:text-gray-400">
                {t('admin.apps.edit.variablesEmpty')}
              </p>
            )}

            {variables.map((variable, index) => (
              <InputFieldCard
                key={index}
                variable={variable}
                index={index}
                unused={unused.includes(variable)}
                newTextLanguage={newTextLanguage}
                onChange={patch => updateVariable(index, patch)}
                onLabelChange={label => handleLabelChange(index, label)}
                onNameChange={name => handleNameChange(index, name)}
                onRemove={() => removeVariable(index)}
                onAddToTemplate={() => addToTemplate(variable)}
              />
            ))}

            <button type="button" onClick={addVariable} className={SECONDARY_BUTTON_CLASS}>
              <Icon name="plus" className="h-4 w-4" />
              {t('admin.apps.edit.addVariable')}
            </button>

            <div className="border-t border-gray-200 dark:border-gray-600 pt-4">
              <div className="flex items-center">
                <input
                  id="app-start-form-enabled"
                  type="checkbox"
                  checked={app.startForm?.enabled === true}
                  onChange={e => handleStartFormChange('enabled', e.target.checked)}
                  aria-describedby="app-start-form-help"
                  className={CHECKBOX_CLASS}
                />
                <label
                  htmlFor="app-start-form-enabled"
                  className="ml-2 block text-sm text-gray-900 dark:text-gray-100"
                >
                  {t('admin.apps.edit.startForm')}
                </label>
              </div>
              <p id="app-start-form-help" className={`${HELP_CLASS} ml-6`}>
                {t('admin.apps.edit.startFormHelp')}
              </p>
              {app.startForm?.enabled === true && (
                <div className="mt-3 ml-6">
                  <AppLanguageField
                    label={t('admin.apps.edit.startFormSubmitLabel')}
                    value={app.startForm?.submitLabel || {}}
                    onChange={value => handleStartFormChange('submitLabel', value)}
                    placeholder={{ en: 'Start', de: 'Starten' }}
                    name="startForm.submitLabel"
                  />
                </div>
              )}
            </div>

            {app.startForm?.enabled !== true && (
              <div className="border-t border-gray-200 dark:border-gray-600 pt-4">
                <div className="flex items-center">
                  <input
                    id="app-variables-panel-pinned"
                    type="checkbox"
                    checked={app.variablesPanel?.pinned !== false}
                    onChange={e =>
                      onChange({
                        ...app,
                        variablesPanel: { ...app.variablesPanel, pinned: e.target.checked }
                      })
                    }
                    aria-describedby="app-variables-panel-help"
                    className={CHECKBOX_CLASS}
                  />
                  <label
                    htmlFor="app-variables-panel-pinned"
                    className="ml-2 block text-sm text-gray-900 dark:text-gray-100"
                  >
                    {t('admin.apps.edit.variablesPanelPinned')}
                  </label>
                </div>
                <p id="app-variables-panel-help" className={`${HELP_CLASS} ml-6`}>
                  {t('admin.apps.edit.variablesPanelPinnedHelp')}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default VariablesSection;
