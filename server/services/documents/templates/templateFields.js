// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { getLocalizedString } from '../../../utils/localize.js';
import {
  BUILT_IN_PLACEHOLDERS,
  FIELD_NAME_PATTERN,
  MAX_TEMPLATE_FIELDS
} from '../../../validators/documentTemplateSchema.js';

/**
 * The custom fields of a document template: a `{{name}}` in its Word file
 * that the model or the user fills in (`template.fields`).
 *
 * `resolveFieldValues` turns what was given into the values for the file,
 * applying defaults, and reports what is missing or not allowed, so that the
 * tools can ask the user instead of leaving a placeholder empty.
 *
 * See `concepts/2026-11-24 Document Templates Rework.md`.
 */

function textOf(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/**
 * The field values of a tool call, as plain data: at most
 * `MAX_TEMPLATE_FIELDS` entries of a name and a text of at most 500
 * characters. Anything else is dropped.
 *
 * @param {unknown} value - The tool's `fields` argument.
 * @returns {Object<string, string>}
 */
export function givenFieldsOf(value) {
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [key, entry] of Object.entries(value).slice(0, MAX_TEMPLATE_FIELDS)) {
    const name = String(key).toLowerCase();
    const text = textOf(entry);
    if (FIELD_NAME_PATTERN.test(name) && text) out[name] = text.slice(0, 500);
  }
  return out;
}

/**
 * What the model or the user needs to know about a field.
 *
 * @param {string} name
 * @param {Object} definition - The field's entry in `template.fields`.
 * @param {string} [language]
 * @returns {{ name: string, label: string, description: string, required: boolean,
 *   options?: string[], default?: string }}
 */
export function describeField(name, definition = {}, language = 'en') {
  return {
    name,
    label: getLocalizedString(definition.label, language, undefined, name),
    description: getLocalizedString(definition.description, language),
    required: definition.required === true,
    ...(definition.options ? { options: definition.options } : {}),
    ...(definition.default !== undefined ? { default: definition.default } : {})
  };
}

/**
 * Every field of a template, described.
 *
 * @param {Object<string, Object>} [definitions] - `template.fields`.
 * @param {string} [language]
 * @returns {ReturnType<typeof describeField>[]}
 */
export function describeFields(definitions = {}, language = 'en') {
  return Object.entries(definitions).map(([name, definition]) =>
    describeField(name, definition, language)
  );
}

/**
 * The values of a template's custom fields.
 *
 * A value that was given counts; otherwise the field's default; otherwise the
 * field stays empty. A value is matched against the allowed options without
 * regard to case and takes the option's own spelling.
 *
 * @param {Object<string, Object>} [definitions] - `template.fields`.
 * @param {Object<string, unknown>} [given] - Values by field name.
 * @param {string} [language] - For the labels of missing and invalid fields.
 * @returns {{
 *   values: Object<string, string>,
 *   missing: ReturnType<typeof describeField>[],
 *   invalid: Array<ReturnType<typeof describeField> & { value: string }>,
 *   unknown: string[]
 * }} `missing` are required fields without a value; `invalid` are values that
 *   are not one of the field's options; `unknown` are names the template does
 *   not declare (the built-in placeholders are not reported).
 */
export function resolveFieldValues(definitions = {}, given = {}, language = 'en') {
  const provided = new Map();
  for (const [key, value] of Object.entries(given && typeof given === 'object' ? given : {})) {
    const name = String(key).toLowerCase();
    const text = textOf(value);
    if (text) provided.set(name, text);
    else if (!provided.has(name)) provided.set(name, '');
  }
  const values = {};
  const missing = [];
  const invalid = [];
  for (const [name, definition] of Object.entries(definitions)) {
    let value = provided.get(name) || textOf(definition.default);
    if (value && definition.options) {
      const option = definition.options.find(o => o.toLowerCase() === value.toLowerCase());
      if (option === undefined) {
        invalid.push({ ...describeField(name, definition, language), value });
        value = '';
      } else value = option;
    }
    if (!value && definition.required === true && !invalid.some(f => f.name === name)) {
      missing.push(describeField(name, definition, language));
    }
    values[name] = value;
  }
  const unknown = [...provided.keys()].filter(
    name => !Object.hasOwn(definitions, name) && !BUILT_IN_PLACEHOLDERS.includes(name)
  );
  return { values, missing, invalid, unknown };
}
