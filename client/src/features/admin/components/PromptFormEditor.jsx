// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../../../utils/localizeContent';
import DynamicLanguageEditor from '../../../shared/components/DynamicLanguageEditor';
import SearchableAppsSelector from '../../apps/components/SearchableAppsSelector';
import Icon from '../../../shared/components/Icon';
import AdminFormErrorFrame from './AdminFormErrorFrame';
import RequiredMark from './RequiredMark';
import {
  FIELD_KEYS,
  fieldErrorAttributes,
  fieldErrorId,
  hasLocalizedText,
  isBlank,
  schemaFieldErrors
} from '../utils/fieldErrors';
import useAdminFormErrors from '../hooks/useAdminFormErrors';
import { usePlatformConfig } from '../../../shared/contexts/PlatformConfigContext';
import {
  CONTENT_VARIABLE,
  autoVariableNames,
  extractVariableNames,
  humanizeVariableName,
  isAutoVariable
} from '../../../../../shared/promptVariables.js';
import { CHECKBOX_CLASS, INPUT_CLASS } from './formStyles';

const NO_IDS = Object.freeze([]);

/** The prompt fields with texts of their own, by schema rule (`fieldErrors.js`). */
const PROMPT_FIELD_RULES = Object.freeze({
  id: { empty: FIELD_KEYS.idRequired, pattern: FIELD_KEYS.idFormat },
  name: { empty: FIELD_KEYS.nameRequired },
  description: { empty: FIELD_KEYS.descriptionRequired },
  prompt: { empty: FIELD_KEYS.promptRequired }
});

/**
 * Every problem of a prompt, in the admin's language, by field path.
 *
 * @param {Object} prompt - The prompt as the form holds it.
 * @param {Object|null} schema - The prompt JSON schema; without it only the ID
 *   and the name are checked.
 * @param {function} t - The translation function.
 * @param {Object} options
 * @param {boolean} options.isNewPrompt
 * @param {string[]} options.takenIds - IDs of the existing prompts.
 * @returns {Object<string, string>}
 */
export function promptFieldErrors(prompt, schema, t, { isNewPrompt, takenIds }) {
  const errors = schema
    ? schemaFieldErrors(prompt, schema, t, {
        rules: PROMPT_FIELD_RULES,
        localizedFields: ['name', 'description', 'prompt']
      })
    : {};
  if (!schema) {
    if (isBlank(prompt.id)) errors.id = t(FIELD_KEYS.idRequired);
    if (!hasLocalizedText(prompt.name)) errors.name = t(FIELD_KEYS.nameRequired);
  }
  if (isNewPrompt && !errors.id && takenIds.includes(prompt.id)) {
    errors.id = t(FIELD_KEYS.idTaken);
  }
  return errors;
}

/**
 * Form-based editor for prompt configuration
 * @param {Object} props
 * @param {Object} props.value - Prompt configuration data
 * @param {Function} props.onChange - Callback when data changes
 * @param {Function} [props.onValidationChange] - Receives `{ isValid, errors, displayed }`
 * @param {Object} [props.errors] - Messages by field from outside the form; always shown
 * @param {boolean} props.isNewPrompt - Whether this is a new prompt
 * @param {Array} props.apps - Available apps for linking
 * @param {Array} props.categories - Available categories
 * @param {boolean} [props.showAllErrors] - Show every problem, not only those of touched fields
 *   (after a save attempt)
 * @param {string[]} [props.takenIds] - IDs of the existing prompts; a new prompt must not reuse one
 * @param {number} [props.summaryFocusKey] - A new value moves the focus to the error summary
 */
function PromptFormEditor({
  value: data,
  onChange,
  onValidationChange,
  errors: serverErrors = {},
  isNewPrompt = false,
  apps = [],
  categories = [],
  jsonSchema,
  showAllErrors = false,
  takenIds = NO_IDS,
  summaryFocusKey = 0
}) {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;

  // Every problem of the prompt, in the admin's language. Shown only for the
  // fields the admin has touched, and all of them after a save attempt.
  const allErrors = useMemo(
    () => promptFieldErrors(data, jsonSchema, t, { isNewPrompt, takenIds }),
    [data, jsonSchema, t, isNewPrompt, takenIds]
  );
  const { errors, controlHandlers } = useAdminFormErrors(allErrors, {
    showAll: showAllErrors,
    extraErrors: serverErrors,
    onValidationChange
  });

  const handleChange = (field, value) => {
    onChange({ ...data, [field]: value });
  };

  const handleInputChange = e => {
    const { name, value, type, checked } = e.target;
    if (name === 'order') {
      handleChange(name, value ? Number.parseInt(value) : undefined);
    } else {
      handleChange(name, type === 'checkbox' ? checked : value);
    }
  };

  const handleVariableChange = (index, field, value) => {
    const newVariables = [...(data.variables || [])];
    newVariables[index] = { ...newVariables[index], [field]: value };
    handleChange('variables', newVariables);
  };

  const addVariable = () => {
    const newVariables = [
      ...(data.variables || []),
      {
        name: '',
        type: 'string',
        required: false,
        defaultValue: ''
      }
    ];
    handleChange('variables', newVariables);
  };

  // `{{name}}` placeholders in any language of the prompt text. Every one that
  // does not fill itself in is asked for when the prompt is used, described
  // here or not; describing it sets its label, type, default or options.
  const { platformConfig } = usePlatformConfig() || {};
  const detectedVariables = useMemo(() => {
    const autoNames = autoVariableNames(platformConfig?.globalPromptVariables?.variables || {});
    const names = new Set();
    for (const text of Object.values(data.prompt || {})) {
      for (const name of extractVariableNames(text)) names.add(name);
    }
    const declared = new Set((data.variables || []).map(variable => variable.name));
    return [...names]
      .filter(
        name =>
          declared.has(name) || (name !== CONTENT_VARIABLE && !isAutoVariable(name, autoNames))
      )
      .map(name => ({ name, declared: declared.has(name) }));
  }, [data.prompt, data.variables, platformConfig]);

  const describeVariable = name => {
    handleChange('variables', [
      ...(data.variables || []),
      { name, label: { en: humanizeVariableName(name) }, type: 'string', required: true }
    ]);
  };

  const removeVariable = index => {
    const newVariables = data.variables?.filter((_, i) => i !== index) || [];
    handleChange('variables', newVariables);
  };

  const variableTypes = [
    { value: 'string', label: t('admin.prompts.variableTypes.string', 'String') },
    { value: 'number', label: t('admin.prompts.variableTypes.number', 'Number') },
    { value: 'boolean', label: t('admin.prompts.variableTypes.boolean', 'Boolean') },
    { value: 'select', label: t('admin.prompts.variableTypes.select', 'Select') },
    { value: 'textarea', label: t('admin.prompts.variableTypes.textarea', 'Textarea') }
  ];

  const errorLabels = {
    id: t('admin.prompts.fields.id', 'Prompt ID'),
    name: t('admin.prompts.fields.name', 'Name'),
    description: t('admin.prompts.fields.description', 'Description'),
    icon: t('admin.prompts.fields.icon', 'Icon'),
    order: t('admin.prompts.fields.order', 'Order'),
    prompt: t('admin.prompts.fields.prompt', 'Prompt'),
    variables: t('admin.prompts.edit.variables', 'Variables')
  };
  // A field of a variable is named "Variable 2 — Name", not by its path.
  const variablePartLabels = {
    name: t('admin.prompts.edit.variableName', 'Name'),
    type: t('admin.prompts.edit.variableType', 'Type'),
    label: t('admin.prompts.edit.variableLabel', 'Label'),
    defaultValue: t('admin.prompts.edit.variableDefault', 'Default Value')
  };
  const summaryErrors = Object.entries(errors).map(([field, message]) => {
    const match = /^variables\.(\d+)(?:\.(\w+))?/.exec(field);
    if (!match) return { field, message };
    const variable = t('admin.prompts.edit.variable', 'Variable {{index}}', {
      index: Number(match[1]) + 1
    });
    const part = variablePartLabels[match[2]];
    return { field, message, label: part ? `${variable} — ${part}` : variable };
  });

  return (
    <AdminFormErrorFrame
      className="space-y-8"
      errors={errors}
      summaryErrors={summaryErrors}
      controlHandlers={controlHandlers}
      showSummary={showAllErrors}
      labels={errorLabels}
      title={t('admin.prompts.edit.fixErrors', 'Please fix the following errors')}
      focusKey={summaryFocusKey}
    >
      {/* Basic Information */}
      <div className="bg-white dark:bg-gray-800 shadow-sm px-4 py-5 sm:rounded-lg sm:p-6">
        <div className="md:grid md:grid-cols-3 md:gap-6">
          <div className="md:col-span-1">
            <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
              {t('admin.prompts.edit.basicInfo', 'Basic Information')}
            </h3>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              {t('admin.prompts.edit.basicInfoDesc', 'Basic prompt identification and metadata')}
            </p>
          </div>
          <div className="mt-5 md:col-span-2 md:mt-0">
            <div className="grid grid-cols-6 gap-6">
              {/* ID */}
              <div className="col-span-6 sm:col-span-3">
                <label
                  htmlFor="id"
                  className="block text-sm font-medium text-gray-700 dark:text-gray-300"
                >
                  {t('admin.prompts.edit.id', 'ID')}
                  <RequiredMark />
                </label>
                <input
                  type="text"
                  id="id"
                  value={data.id || ''}
                  onChange={e => handleChange('id', e.target.value)}
                  disabled={!isNewPrompt}
                  required
                  aria-invalid={errors.id ? true : undefined}
                  aria-describedby={errors.id ? 'id-error' : undefined}
                  className={`${INPUT_CLASS} mt-1 block ${
                    errors.id
                      ? 'border-red-500 dark:border-red-400 text-red-900 placeholder-red-300'
                      : ''
                  }`}
                  placeholder="unique-prompt-id"
                  autoComplete="off"
                />
                {errors.id && (
                  <p id="id-error" className="mt-2 text-sm text-red-600 dark:text-red-400">
                    {errors.id}
                  </p>
                )}
                <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                  {t(
                    'admin.prompts.edit.idDesc',
                    'Unique identifier using lowercase letters, numbers, and hyphens'
                  )}
                </p>
              </div>

              {/* Icon */}
              <div className="col-span-6 sm:col-span-3">
                <label
                  htmlFor="icon"
                  className="block text-sm font-medium text-gray-700 dark:text-gray-300"
                >
                  {t('admin.prompts.edit.icon', 'Icon')}
                </label>
                <input
                  type="text"
                  id="icon"
                  {...fieldErrorAttributes('icon', errors.icon)}
                  value={data.icon || ''}
                  onChange={e => handleChange('icon', e.target.value)}
                  className={`${INPUT_CLASS} mt-1 block ${
                    errors.icon ? 'border-red-500 dark:border-red-400 text-red-900' : ''
                  }`}
                  placeholder="clipboard"
                  autoComplete="off"
                />
                {errors.icon && (
                  <p
                    id={fieldErrorId('icon')}
                    className="mt-2 text-sm text-red-600 dark:text-red-400"
                  >
                    {errors.icon}
                  </p>
                )}
                <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                  {t('admin.prompts.edit.iconDesc', 'Heroicon name for the prompt')}
                </p>
              </div>

              {/* Order */}
              <div className="col-span-6 sm:col-span-3">
                <label
                  htmlFor="order"
                  className="block text-sm font-medium text-gray-700 dark:text-gray-300"
                >
                  {t('admin.prompts.edit.order', 'Order')}
                </label>
                <input
                  type="number"
                  id="order"
                  {...fieldErrorAttributes('order', errors.order)}
                  name="order"
                  value={data.order || ''}
                  onChange={handleInputChange}
                  className={`${INPUT_CLASS} mt-1 block ${
                    errors.order ? 'border-red-500 dark:border-red-400 text-red-900' : ''
                  }`}
                  placeholder="0"
                  autoComplete="off"
                />
                {errors.order && (
                  <p
                    id={fieldErrorId('order')}
                    className="mt-2 text-sm text-red-600 dark:text-red-400"
                  >
                    {errors.order}
                  </p>
                )}
                <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                  {t('admin.prompts.edit.orderDesc', 'Display order in the prompts list')}
                </p>
              </div>

              {/* Category */}
              <div className="col-span-6 sm:col-span-3">
                <label
                  htmlFor="category"
                  className="block text-sm font-medium text-gray-700 dark:text-gray-300"
                >
                  {t('admin.prompts.edit.category', 'Category')}
                </label>
                <select
                  id="category"
                  {...fieldErrorAttributes('category', errors.category)}
                  value={data.category || ''}
                  onChange={e => handleChange('category', e.target.value)}
                  className={`${INPUT_CLASS} mt-1 block ${
                    errors.category ? 'border-red-500 dark:border-red-400 text-red-900' : ''
                  }`}
                >
                  <option value="">
                    {t('admin.prompts.edit.selectCategory', 'Select category...')}
                  </option>
                  {categories
                    ?.filter(cat => cat.id !== 'all')
                    .map(category => (
                      <option key={category.id} value={category.id}>
                        {getLocalizedContent(category.name, currentLanguage)}
                      </option>
                    ))}
                </select>
                {errors.category && (
                  <p
                    id={fieldErrorId('category')}
                    className="mt-2 text-sm text-red-600 dark:text-red-400"
                  >
                    {errors.category}
                  </p>
                )}
                <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                  {t('admin.prompts.edit.categoryDesc', 'Category for organizing prompts')}
                </p>
              </div>

              {/* App ID */}
              <div className="col-span-6 sm:col-span-3">
                <label
                  htmlFor="appId"
                  className="block text-sm font-medium text-gray-700 dark:text-gray-300"
                >
                  {t('admin.prompts.edit.appId', 'Opens in app')}
                </label>
                <div className="mt-1">
                  <SearchableAppsSelector
                    apps={apps}
                    value={data.appId || ''}
                    onChange={value => handleChange('appId', value)}
                    placeholder={t('admin.prompts.edit.noApp', 'Default chat app')}
                    currentLanguage={currentLanguage}
                  />
                </div>
                {errors.appId && (
                  <p className="mt-2 text-sm text-red-600 dark:text-red-400">{errors.appId}</p>
                )}
                <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                  {t(
                    'admin.prompts.edit.appIdDesc',
                    'The prompt library opens this prompt in this app and lists it first there. It does not limit who sees the prompt.'
                  )}
                </p>
              </div>

              {/* Enabled */}
              <div className="col-span-6">
                <div className="flex items-center">
                  <input
                    id="enabled"
                    name="enabled"
                    type="checkbox"
                    checked={data.enabled !== false}
                    onChange={handleInputChange}
                    className={CHECKBOX_CLASS}
                  />
                  <label
                    htmlFor="enabled"
                    className="ml-2 block text-sm text-gray-900 dark:text-gray-100"
                  >
                    {t('admin.prompts.edit.enabled', 'Enabled')}
                  </label>
                </div>
                <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                  {t('admin.prompts.edit.enabledDesc', 'Whether this prompt is visible to users')}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Localized Content */}
      <div className="bg-white dark:bg-gray-800 shadow-sm px-4 py-5 sm:rounded-lg sm:p-6">
        <div className="md:grid md:grid-cols-3 md:gap-6">
          <div className="md:col-span-1">
            <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
              {t('admin.prompts.edit.content', 'Content')}
            </h3>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              {t('admin.prompts.edit.contentDesc', 'Localized content for different languages')}
            </p>
          </div>
          <div className="mt-5 md:col-span-2 md:mt-0">
            <div className="space-y-6">
              <DynamicLanguageEditor
                label={t('admin.prompts.edit.name', 'Name')}
                name="name"
                value={data.name || { en: '' }}
                onChange={value => handleChange('name', value)}
                required={true}
                placeholder={{
                  en: 'Prompt name',
                  de: 'Prompt-Name',
                  es: 'Nombre del prompt',
                  fr: 'Nom du prompt'
                }}
                error={errors.name}
              />

              <DynamicLanguageEditor
                label={t('admin.prompts.edit.description', 'Description')}
                name="description"
                value={data.description || { en: '' }}
                onChange={value => handleChange('description', value)}
                required={true}
                type="textarea"
                placeholder={{
                  en: 'Brief description of the prompt',
                  de: 'Kurze Beschreibung des Prompts',
                  es: 'Breve descripción del prompt',
                  fr: 'Brève description du prompt'
                }}
                error={errors.description}
              />

              <DynamicLanguageEditor
                label={t('admin.prompts.edit.prompt', 'Prompt')}
                name="prompt"
                value={data.prompt || { en: '' }}
                onChange={value => handleChange('prompt', value)}
                required={true}
                type="textarea"
                placeholder={{
                  en: 'The actual prompt text. Use {{variableName}} for variables.',
                  de: 'Der eigentliche Prompt-Text. Verwenden Sie {{variableName}} für Variablen.',
                  es: 'El texto del prompt real. Use {{variableName}} para variables.',
                  fr: 'Le texte du prompt réel. Utilisez {{variableName}} pour les variables.'
                }}
                error={errors.prompt}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Variables */}
      <div className="bg-white dark:bg-gray-800 shadow-sm px-4 py-5 sm:rounded-lg sm:p-6">
        <div className="md:grid md:grid-cols-3 md:gap-6">
          <div className="md:col-span-1">
            <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
              {t('admin.prompts.edit.variables', 'Variables')}
            </h3>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              {t('admin.prompts.edit.variablesDescPlaceholders', {
                defaultValue:
                  'Placeholders written as {{name}} in the prompt text are asked for when the prompt is used. Describe them here to set a label, type, default value or options. {{content}} marks where the user’s own text goes; global variables such as {{user_name}} fill in by themselves.',
                skipInterpolation: true
              })}
            </p>
            {detectedVariables.length > 0 && (
              <div className="mt-3">
                <div className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1">
                  {t('admin.prompts.edit.detectedVariables', 'Detected in the text')}
                </div>
                <ul className="space-y-1">
                  {detectedVariables.map(variable => (
                    <li key={variable.name} className="flex items-center justify-between gap-2">
                      <code className="text-sm text-indigo-600 dark:text-indigo-400">{`{{${variable.name}}}`}</code>
                      {variable.declared ? (
                        <span className="text-xs text-gray-500 dark:text-gray-400">
                          {t('admin.prompts.edit.variableDescribed', 'described')}
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => describeVariable(variable.name)}
                          className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline"
                        >
                          {t('admin.prompts.edit.describeVariable', 'Describe')}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          <div className="mt-5 md:col-span-2 md:mt-0">
            <div className="space-y-4">
              {data.variables?.map((variable, index) => (
                <div
                  key={index}
                  className="border border-gray-200 dark:border-gray-600 rounded-lg p-4"
                >
                  <div className="flex justify-between items-start mb-4">
                    <h4 className="text-sm font-medium text-gray-900 dark:text-gray-100">
                      {t('admin.prompts.edit.variable', 'Variable {{index}}', {
                        index: index + 1
                      })}
                    </h4>
                    <button
                      type="button"
                      onClick={() => removeVariable(index)}
                      className="text-red-600 dark:text-red-400 hover:text-red-900 dark:hover:text-red-300"
                    >
                      <Icon name="x" className="w-5 h-5" />
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                        {t('admin.prompts.edit.variableName', 'Name')}
                        <RequiredMark />
                      </label>
                      <input
                        type="text"
                        data-field={`variables.${index}.name`}
                        aria-required="true"
                        value={variable.name || ''}
                        onChange={e => handleVariableChange(index, 'name', e.target.value)}
                        className={`${INPUT_CLASS} mt-1 block ${
                          errors[`variables.${index}.name`]
                            ? 'border-red-500 dark:border-red-400 text-red-900'
                            : ''
                        }`}
                        {...fieldErrorAttributes(
                          `variables.${index}.name`,
                          errors[`variables.${index}.name`]
                        )}
                        placeholder="variable_name"
                        autoComplete="off"
                      />
                      {errors[`variables.${index}.name`] && (
                        <p
                          id={fieldErrorId(`variables.${index}.name`)}
                          className="mt-2 text-sm text-red-600 dark:text-red-400"
                        >
                          {errors[`variables.${index}.name`]}
                        </p>
                      )}
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                        {t('admin.prompts.edit.variableType', 'Type')}
                      </label>
                      <select
                        value={variable.type || 'string'}
                        onChange={e => handleVariableChange(index, 'type', e.target.value)}
                        className={`${INPUT_CLASS} mt-1 block`}
                      >
                        {variableTypes.map(type => (
                          <option key={type.value} value={type.value}>
                            {type.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="col-span-2">
                      <DynamicLanguageEditor
                        label={t('admin.prompts.edit.variableLabel', 'Label')}
                        value={variable.label || { en: '' }}
                        onChange={value => handleVariableChange(index, 'label', value)}
                        placeholder={{
                          en: 'Variable label',
                          de: 'Variablen-Label',
                          es: 'Etiqueta de variable',
                          fr: 'Libellé de variable'
                        }}
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                        {t('admin.prompts.edit.variableDefault', 'Default Value')}
                      </label>
                      <input
                        type="text"
                        value={variable.defaultValue || ''}
                        onChange={e => handleVariableChange(index, 'defaultValue', e.target.value)}
                        className={`${INPUT_CLASS} mt-1 block`}
                        placeholder={t(
                          'admin.prompts.edit.variableDefaultPlaceholder',
                          'Default value'
                        )}
                        autoComplete="off"
                      />
                    </div>
                  </div>
                  <div className="mt-4">
                    <div className="flex items-center">
                      <input
                        type="checkbox"
                        checked={variable.required || false}
                        onChange={e => handleVariableChange(index, 'required', e.target.checked)}
                        className={CHECKBOX_CLASS}
                      />
                      <label className="ml-2 block text-sm text-gray-900 dark:text-gray-100">
                        {t('admin.prompts.edit.variableRequired', 'Required')}
                      </label>
                    </div>
                  </div>
                </div>
              ))}
              <button
                type="button"
                onClick={addVariable}
                className="w-full flex justify-center py-2 px-4 border border-gray-300 dark:border-gray-600 rounded-md shadow-xs text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
              >
                <Icon name="plus" className="w-5 h-5 mr-2" />
                {t('admin.prompts.edit.addVariable', 'Add Variable')}
              </button>
            </div>
          </div>
        </div>
      </div>
    </AdminFormErrorFrame>
  );
}

export default PromptFormEditor;
