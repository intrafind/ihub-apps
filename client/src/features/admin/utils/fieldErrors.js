// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The words of an admin form's validation: what a violated rule of a JSON
 * schema says to the admin, in their language. Pure (no React); every
 * sentence is a translation key under `admin.formErrors`.
 *
 * `validateWithSchema` reports each rule by Ajv's keyword and parameters. Its
 * own sentences are English and built around the field's path ("id must be at
 * least 1 characters"); a form built on this module does not show them.
 *
 * Used by the model, prompt, group and user editors (`ModelFormEditor`,
 * `PromptFormEditor`, `GroupFormEditor`, `UserFormEditor`).
 *
 * @module features/admin/utils/fieldErrors
 */

import { validateWithSchema } from '../../../utils/schemaValidation';

/** What a violated rule says when the form has no text of its own for the field. */
export const RULE_KEYS = Object.freeze({
  required: 'admin.formErrors.rule.required',
  choose: 'admin.formErrors.rule.choose',
  minLength: 'admin.formErrors.rule.minLength',
  maxLength: 'admin.formErrors.rule.maxLength',
  minimum: 'admin.formErrors.rule.minimum',
  maximum: 'admin.formErrors.rule.maximum',
  exclusiveMinimum: 'admin.formErrors.rule.exclusiveMinimum',
  exclusiveMaximum: 'admin.formErrors.rule.exclusiveMaximum',
  number: 'admin.formErrors.rule.number',
  integer: 'admin.formErrors.rule.integer',
  pattern: 'admin.formErrors.rule.pattern',
  uri: 'admin.formErrors.rule.uri',
  email: 'admin.formErrors.rule.email',
  enum: 'admin.formErrors.rule.enum',
  uniqueItems: 'admin.formErrors.rule.uniqueItems',
  additionalProperties: 'admin.formErrors.rule.additionalProperties',
  languageText: 'admin.formErrors.rule.languageText',
  invalid: 'admin.formErrors.rule.invalid'
});

/** Texts a form can name for one of its fields (see `FieldRule`). */
export const FIELD_KEYS = Object.freeze({
  idRequired: 'admin.formErrors.field.idRequired',
  idFormat: 'admin.formErrors.field.idFormat',
  idTaken: 'admin.formErrors.field.idTaken',
  groupIdFormat: 'admin.formErrors.field.groupIdFormat',
  nameRequired: 'admin.formErrors.field.nameRequired',
  descriptionRequired: 'admin.formErrors.field.descriptionRequired',
  modelIdRequired: 'admin.formErrors.field.modelIdRequired',
  providerRequired: 'admin.formErrors.field.providerRequired',
  urlRequired: 'admin.formErrors.field.urlRequired',
  promptRequired: 'admin.formErrors.field.promptRequired'
});

/**
 * The texts of one field that replace the generic ones.
 *
 * @typedef {Object} FieldRule
 * @property {string} [empty] - Key for an empty or missing value ("Enter a name.").
 * @property {string} [pattern] - Key for a value of the wrong format.
 */

/** Keywords that, on an empty value, only mean "nothing was entered". */
const EMPTY_KEYWORDS = new Set(['required', 'minLength', 'enum', 'type', 'pattern', 'format']);

/**
 * Whether a value counts as not entered: missing, null or blank text.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isBlank(value) {
  return value === undefined || value === null || (typeof value === 'string' && !value.trim());
}

/**
 * Whether a localized text (`{ en: '…', de: '…' }`) has text in any language.
 * @param {unknown} value
 * @returns {boolean}
 */
export function hasLocalizedText(value) {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    Object.values(value).some(text => typeof text === 'string' && text.trim() !== '')
  );
}

/** The value at a dot path, or undefined. */
function valueAt(data, path) {
  return String(path || '')
    .split('.')
    .reduce((value, key) => (value === null || value === undefined ? undefined : value[key]), data);
}

/**
 * What a violated schema rule says to the admin: what to do, in a short sentence.
 *
 * @param {{keyword?: string, params?: object}} error - An entry of
 *   `validateWithSchema(...).errors`.
 * @param {function} t - The translation function.
 * @param {object} [options]
 * @param {unknown} [options.value] - The field's value; an empty one gets the
 *   "enter something" text whatever rule it broke.
 * @param {FieldRule} [options.rule] - The field's own texts.
 * @returns {string}
 *
 * @example
 * fieldErrorMessage({ keyword: 'maxLength', params: { limit: 50 } }, t);
 * // → 'At most 50 characters.'
 */
export function fieldErrorMessage(error, t, { value, rule = {} } = {}) {
  const keyword = error?.keyword;
  const params = error?.params || {};
  const limit = params.limit;

  if (isBlank(value) && EMPTY_KEYWORDS.has(keyword)) {
    if (rule.empty) return t(rule.empty);
    return t(keyword === 'enum' ? RULE_KEYS.choose : RULE_KEYS.required);
  }

  switch (keyword) {
    case 'required':
      return t(rule.empty || RULE_KEYS.required);
    case 'minLength':
      return limit > 1
        ? t(RULE_KEYS.minLength, { min: limit })
        : t(rule.empty || RULE_KEYS.required);
    case 'maxLength':
      return t(RULE_KEYS.maxLength, { max: limit });
    case 'minimum':
      return t(RULE_KEYS.minimum, { limit });
    case 'maximum':
      return t(RULE_KEYS.maximum, { limit });
    case 'exclusiveMinimum':
      return t(RULE_KEYS.exclusiveMinimum, { limit });
    case 'exclusiveMaximum':
      return t(RULE_KEYS.exclusiveMaximum, { limit });
    case 'type':
      if (params.type === 'integer') return t(RULE_KEYS.integer);
      if (params.type === 'number') return t(RULE_KEYS.number);
      return t(RULE_KEYS.invalid);
    case 'pattern':
      return t(rule.pattern || RULE_KEYS.pattern);
    case 'format':
      if (params.format === 'uri' || params.format === 'url') return t(RULE_KEYS.uri);
      if (params.format === 'email') return t(RULE_KEYS.email);
      return t(RULE_KEYS.invalid);
    case 'enum':
      return t(RULE_KEYS.enum);
    case 'uniqueItems':
      return t(RULE_KEYS.uniqueItems);
    case 'additionalProperties':
      return t(RULE_KEYS.additionalProperties);
    default:
      return t(RULE_KEYS.invalid);
  }
}

/**
 * Validates form data against a JSON schema and says every problem in the
 * admin's language, one message per field.
 *
 * A localized text (`name: { en, de }`) that the schema requires needs text in
 * at least one language: without any it has one message at the field itself
 * (`name`), not one per empty language. With text in some language, an empty
 * other language is reported at `name.<lang>`.
 *
 * @param {object} data - The form data.
 * @param {object|null} schema - The JSON schema; without one there are no errors.
 * @param {function} t - The translation function.
 * @param {object} [options]
 * @param {Object<string, FieldRule>} [options.rules] - Texts by top-level field.
 * @param {string[]} [options.localizedFields] - Top-level fields that hold a
 *   localized text.
 * @returns {Object<string, string>} Messages by field path.
 *
 * @example
 * schemaFieldErrors({ id: '', name: { en: '' } }, schema, t, {
 *   rules: { id: { empty: FIELD_KEYS.idRequired }, name: { empty: FIELD_KEYS.nameRequired } },
 *   localizedFields: ['name']
 * });
 * // → { id: 'Enter an ID.', name: 'Enter a name.' }
 */
export function schemaFieldErrors(data, schema, t, { rules = {}, localizedFields = [] } = {}) {
  const errors = {};
  if (!schema || !data) return errors;
  const localized = new Set(localizedFields);
  const required = new Set(schema.required || []);
  const { errors: problems } = validateWithSchema(data, schema);
  // A required localized text without any text: one message at the field itself.
  const textMissing = field =>
    localized.has(field) && required.has(field) && !hasLocalizedText(data[field]);
  const missingText = field => t(rules[field]?.empty || RULE_KEYS.required);

  // In the order of the schema, which is the order of the form.
  for (const problem of problems) {
    const field = problem.field;
    if (!field || errors[field]) continue;
    const [top] = field.split('.');
    if (textMissing(top)) {
      if (!errors[top]) errors[top] = missingText(top);
      continue;
    }
    const isLanguage = localized.has(top) && field !== top;
    errors[field] = fieldErrorMessage(problem, t, {
      value: valueAt(data, field),
      rule: isLanguage ? { empty: RULE_KEYS.languageText } : field === top ? rules[top] : undefined
    });
  }
  // An empty object (`{}`) breaks no rule of the schema, yet has no text.
  for (const field of localized) {
    if (textMissing(field) && !errors[field]) errors[field] = missingText(field);
  }
  return errors;
}

/**
 * The top-level field a dot path belongs to: `name.en` → `name`.
 * @param {string} field
 * @returns {string}
 */
export function topLevelField(field) {
  return String(field || '').split('.')[0];
}
