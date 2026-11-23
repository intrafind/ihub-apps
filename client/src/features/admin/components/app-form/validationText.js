// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The words of the app form's validation: what a violated rule of the app
 * schema says to the author, and what a field deep in the form is called in
 * the error summary. Pure (no React); every sentence is a translation key.
 *
 * `validateWithSchema` reports a rule by Ajv's keyword and parameters. Its own
 * sentences are English and built around the field's path
 * ("variables.0.name format is invalid"); the form does not show them.
 *
 * @module features/admin/components/app-form/validationText
 */

/** What a violated rule says, by the name used below. */
const MESSAGE = Object.freeze({
  empty: 'admin.apps.edit.validation.empty',
  required: 'admin.apps.edit.validation.required',
  minLength: 'admin.apps.edit.validation.minLength',
  maxLength: 'admin.apps.edit.validation.maxLength',
  minimum: 'admin.apps.edit.validation.minimum',
  maximum: 'admin.apps.edit.validation.maximum',
  exclusiveMinimum: 'admin.apps.edit.validation.exclusiveMinimum',
  exclusiveMaximum: 'admin.apps.edit.validation.exclusiveMaximum',
  pattern: 'admin.apps.edit.validation.pattern',
  variableName: 'admin.apps.edit.validation.variableName',
  uri: 'admin.apps.edit.validation.uri',
  email: 'admin.apps.edit.validation.email',
  enum: 'admin.apps.edit.validation.enum',
  uniqueItems: 'admin.apps.edit.validation.uniqueItems',
  type: 'admin.apps.edit.validation.type',
  invalid: 'admin.apps.edit.validation.invalid'
});

/** How the summary names a field inside a list of the form. */
const LABEL = Object.freeze({
  variable: 'admin.apps.edit.errorLabel.variable',
  starterPrompt: 'admin.apps.edit.errorLabel.starterPrompt',
  option: 'admin.apps.edit.errorLabel.option',
  part: 'admin.apps.edit.errorLabel.part',
  language: 'admin.apps.edit.errorLabel.language'
});

const isIndex = token => /^\d+$/.test(token);
/** The placeholder of an input field; its rule is the one the author meets. */
const VARIABLE_NAME = /^variables\.\d+\.name$/;

/** The value at a dot path of the app, or undefined. */
function valueAt(app, path) {
  return String(path)
    .split('.')
    .reduce((value, key) => (value === null || value === undefined ? undefined : value[key]), app);
}

/**
 * What a violated schema rule says to the author: what is wrong and what to do.
 *
 * @param {{field: string, keyword?: string, params?: object}} error - An entry of
 *   `validateWithSchema(...).errors`.
 * @param {function} t - The translation function.
 * @param {object} [app] - The validated app; an empty text then gets "enter a
 *   text" whatever rule it broke.
 * @returns {string}
 *
 * @example
 * schemaErrorMessage({ field: 'order', keyword: 'minimum', params: { limit: 0 } }, t);
 * // → 'Enter a number that is at least 0.'
 */
export function schemaErrorMessage(error, t, app) {
  const params = error?.params || {};
  const limit = params.limit;
  const value = app ? valueAt(app, error?.field) : undefined;
  if (typeof value === 'string' && value.trim() === '') return t(MESSAGE.empty);

  switch (error?.keyword) {
    case 'required':
      return t(MESSAGE.required);
    case 'minLength':
      return limit > 1 ? t(MESSAGE.minLength, { count: limit }) : t(MESSAGE.empty);
    case 'maxLength':
      return t(MESSAGE.maxLength, { count: limit });
    case 'minimum':
      return t(MESSAGE.minimum, { limit });
    case 'maximum':
      return t(MESSAGE.maximum, { limit });
    case 'exclusiveMinimum':
      return t(MESSAGE.exclusiveMinimum, { limit });
    case 'exclusiveMaximum':
      return t(MESSAGE.exclusiveMaximum, { limit });
    case 'pattern':
      return VARIABLE_NAME.test(error.field) ? t(MESSAGE.variableName) : t(MESSAGE.pattern);
    case 'format':
      if (params.format === 'uri' || params.format === 'url') return t(MESSAGE.uri);
      if (params.format === 'email') return t(MESSAGE.email);
      return t(MESSAGE.invalid);
    case 'enum':
      return Array.isArray(params.allowedValues)
        ? t(MESSAGE.enum, { values: params.allowedValues.join(', ') })
        : t(MESSAGE.invalid);
    case 'uniqueItems':
      return t(MESSAGE.uniqueItems);
    case 'type':
      return t(MESSAGE.type);
    default:
      return t(MESSAGE.invalid);
  }
}

/** The parts of an input field (`variables.N.<part>`) and of one of its options. */
const VARIABLE_PARTS = Object.freeze({
  name: 'admin.apps.edit.variableName',
  label: 'admin.apps.edit.variableLabel',
  type: 'admin.apps.edit.variableType',
  defaultValue: 'admin.apps.edit.defaultValue',
  predefinedValues: 'admin.apps.edit.predefinedValues',
  required: 'admin.apps.edit.required'
});
const OPTION_PARTS = Object.freeze({ value: 'admin.apps.edit.value' });

/** The parts of a conversation starter (`starterPrompts.N.<part>`). */
const STARTER_PARTS = Object.freeze({
  title: 'admin.apps.edit.title',
  message: 'admin.apps.edit.message'
});

const LISTS = Object.freeze({
  variables: { item: LABEL.variable, parts: VARIABLE_PARTS },
  starterPrompts: { item: LABEL.starterPrompt, parts: STARTER_PARTS }
});

/**
 * What the error summary calls a field inside an input field or a conversation
 * starter, in the editor's words and counted from 1: `variables.0.name` is
 * "Input field 1, Placeholder", `starterPrompts.1.title.de` is "Conversation
 * starter 2, Text on the button — German".
 *
 * @param {string} field - The dot path of the field.
 * @param {function} t - The translation function.
 * @param {function(string): string} [languageName] - The name of a language code;
 *   without it the code stands.
 * @returns {string|undefined} `undefined` for every other field: the summary
 *   then names it from its label map.
 */
export function listFieldLabel(field, t, languageName = code => code) {
  const [head, index, ...rest] = String(field ?? '').split('.');
  const list = LISTS[head];
  if (!list || !isIndex(index ?? '')) return undefined;

  let label = t(list.item, { number: Number(index) + 1 });
  let parts = list.parts;
  rest.forEach((token, position) => {
    let part;
    if (isIndex(token)) {
      // The only list inside an entry is an input field's options.
      part = t(LABEL.option, { number: Number(token) + 1 });
      parts = OPTION_PARTS;
    } else if (parts[token]) {
      part = t(parts[token]);
    } else if (position === rest.length - 1 && position > 0) {
      // A text in several languages ends with its language code.
      label = t(LABEL.language, { field: label, language: languageName(token) });
      return;
    } else {
      return;
    }
    label = t(LABEL.part, { parent: label, field: part });
  });
  return label;
}
