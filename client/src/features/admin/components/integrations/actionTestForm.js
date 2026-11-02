// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Pure helpers of the action detail (#2974): the test form generated from an
 * action's JSON schema, and the per-language editing of override texts.
 * No React here, so they are unit-tested on their own.
 */

/**
 * The kind of input a schema property gets.
 *
 * - `enum`: a select of the listed values;
 * - `boolean`: a checkbox;
 * - `integer` / `number`: a number input;
 * - `string`: a text input (`multiline` for long or Markdown text);
 * - `json`: a textarea that takes JSON (arrays, objects, unions).
 *
 * @param {Object} property - a JSON-schema property
 * @returns {'enum'|'boolean'|'integer'|'number'|'string'|'json'}
 */
export function inputKindOf(property) {
  if (!property || typeof property !== 'object') return 'json';
  if (Array.isArray(property.enum) && property.enum.length > 0) return 'enum';
  const type = Array.isArray(property.type)
    ? property.type.filter(t => t !== 'null')
    : [property.type];
  if (type.length !== 1) return 'json';
  switch (type[0]) {
    case 'boolean':
      return 'boolean';
    case 'integer':
      return 'integer';
    case 'number':
      return 'number';
    case 'string':
      return 'string';
    default:
      return 'json';
  }
}

/**
 * The form fields of an action's parameter schema, required ones first.
 *
 * @param {Object} schema - the parameter schema as sent to the model
 * @returns {Array<{name: string, kind: string, required: boolean, description: string,
 *   options: Array, defaultValue: unknown, multiline: boolean}>}
 *
 * @example
 * formFieldsFromSchema({ type: 'object', properties: { q: { type: 'string' } }, required: ['q'] })
 * // [{ name: 'q', kind: 'string', required: true, … }]
 */
export function formFieldsFromSchema(schema) {
  const properties =
    schema?.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const required = new Set(Array.isArray(schema?.required) ? schema.required : []);
  const fields = Object.entries(properties).map(([name, property]) => {
    const kind = inputKindOf(property);
    return {
      name,
      kind,
      required: required.has(name),
      description: typeof property?.description === 'string' ? property.description : '',
      options: kind === 'enum' ? property.enum : [],
      defaultValue: property?.default,
      multiline:
        kind === 'string' &&
        (property?.format === 'markdown' ||
          (Number.isInteger(property?.maxLength) && property.maxLength > 200) ||
          /body|text|content|comment|markdown|description/i.test(name))
    };
  });
  return [...fields.filter(f => f.required), ...fields.filter(f => !f.required)];
}

/**
 * The starting values of the form: each field's schema default, as the input holds it.
 * @param {Array} fields - from {@link formFieldsFromSchema}
 * @returns {Object<string, string|boolean>}
 */
export function initialFormValues(fields) {
  const values = {};
  for (const field of fields) {
    const value = field.defaultValue;
    if (field.kind === 'boolean') values[field.name] = value === true;
    else if (value === undefined || value === null) values[field.name] = '';
    else if (field.kind === 'json') values[field.name] = JSON.stringify(value, null, 2);
    else values[field.name] = String(value);
  }
  return values;
}

/**
 * The arguments the form describes, as the model would send them. An empty
 * optional field is left out; a boolean is sent when checked or when it is
 * required.
 *
 * @param {Array} fields - from {@link formFieldsFromSchema}
 * @param {Object<string, string|boolean>} values - the form's values
 * @returns {{args: Object, errors: Object<string, 'required'|'number'|'integer'|'json'>}}
 */
export function argsFromFormValues(fields, values) {
  const args = {};
  const errors = {};
  for (const field of fields) {
    const raw = values?.[field.name];
    if (field.kind === 'boolean') {
      if (raw === true || field.required) args[field.name] = raw === true;
      continue;
    }
    const text = String(raw ?? '');
    if (text.trim() === '') {
      if (field.required) errors[field.name] = 'required';
      continue;
    }
    if (field.kind === 'integer' || field.kind === 'number') {
      const number = Number(text);
      if (!Number.isFinite(number)) errors[field.name] = 'number';
      else if (field.kind === 'integer' && !Number.isInteger(number))
        errors[field.name] = 'integer';
      else args[field.name] = number;
    } else if (field.kind === 'json') {
      try {
        args[field.name] = JSON.parse(text);
      } catch {
        errors[field.name] = 'json';
      }
    } else {
      args[field.name] = text;
    }
  }
  return { args, errors };
}

/** The base language of a UI language (`de-DE` → `de`). */
export function baseLanguage(language) {
  return String(language || 'en').split('-')[0] || 'en';
}

/**
 * The text of a stored override (`{ en, de }` or a plain string) in one
 * language, or '' when it has none for it.
 * @param {Object|string|null|undefined} stored
 * @param {string} language
 * @returns {string}
 */
export function textInLanguage(stored, language) {
  if (typeof stored === 'string') return stored;
  if (!stored || typeof stored !== 'object') return '';
  return typeof stored[language] === 'string' ? stored[language] : '';
}

/**
 * A stored override with one language replaced. A plain string (which
 * served every language) is kept for English when another language is set.
 * An empty text removes the language; null when nothing is left.
 *
 * @param {Object|string|null|undefined} stored
 * @param {string} language
 * @param {string} text
 * @returns {Object|null}
 */
export function withLanguageText(stored, language, text) {
  const base =
    typeof stored === 'string'
      ? language === 'en'
        ? {}
        : { en: stored }
      : stored && typeof stored === 'object'
        ? { ...stored }
        : {};
  if (text && text.trim()) base[language] = text;
  else delete base[language];
  return Object.keys(base).length ? base : null;
}

/**
 * The stored example prompts with one language replaced by `lines` (one
 * prompt per line). The prompts are matched by position; other languages of
 * a prompt are kept.
 *
 * @param {Array<Object|string>|null|undefined} stored
 * @param {string} language
 * @param {string} text - one prompt per line
 * @returns {Array<Object>}
 */
export function withLanguageExamples(stored, language, text) {
  const lines = String(text || '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
  const current = Array.isArray(stored) ? stored : [];
  return lines.map((line, index) => withLanguageText(current[index], language, line));
}
