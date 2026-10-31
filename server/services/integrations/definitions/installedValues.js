// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { getLocalizedString } from '../../../utils/localize.js';

/**
 * The effective non-sensitive values of an installation: the definition's
 * field defaults, overridden by what the admin entered. Sensitive fields are
 * never part of it; their secret lives in the credential store.
 *
 * @param {object} definition - validated definition
 * @param {object} [instance] - installed integration (`values` is read)
 * @returns {Record<string, unknown>}
 */
export function effectiveValues(definition, instance) {
  const values = {};
  for (const field of definition.install || []) {
    if (field.sensitive || field.scope !== 'admin') continue;
    if (field.default !== undefined) values[field.key] = normalizeValue(field, field.default);
  }
  for (const [key, value] of Object.entries(instance?.values || {})) {
    if (value === undefined || value === null || value === '') continue;
    const field = (definition.install || []).find(f => f.key === key);
    if (field?.sensitive) continue;
    values[key] = normalizeValue(field, value);
  }
  return values;
}

/**
 * A URL is joined with paths in templates (`{baseUrl}{apiPath}`,
 * `{baseUrl}/dataset/{name}`), so a trailing slash an admin typed would give
 * an interior `//`. It goes here, once, for every use of the value.
 */
function normalizeValue(field, value) {
  if (field?.type === 'url' && typeof value === 'string') return value.replace(/\/+$/, '');
  return value;
}

/**
 * A localized string from a definition field (`{ en, de }` or plain text).
 * @param {unknown} value
 * @param {string} language
 * @param {string} [fallback]
 */
export function localized(value, language, fallback = '') {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'string') return value;
  return getLocalizedString(value, language || 'en', undefined, fallback) || fallback;
}

/**
 * The label an admin gave an installation, else the definition's name.
 * @param {object} definition
 * @param {object} instance
 * @param {string} language
 */
export function instanceLabel(definition, instance, language) {
  return localized(instance?.label, language) || localized(definition.name, language, instance?.id);
}
