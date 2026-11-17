// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Field errors of a failed API request, keyed by field.
 *
 * A validation failure answers RFC 9457 problem+json with one `errors[]`
 * entry per problem (docs/api-guidelines.md):
 *
 * ```json
 * { "code": "INVALID_VALUES",
 *   "errors": [{ "pointer": "/values/baseUrl", "code": "REQUIRED", "message": "required" }] }
 * ```
 *
 * Forms show each message at its field. The `pointer` is an RFC 6901 JSON
 * Pointer into the request body; it becomes a dotted field path
 * (`values.baseUrl`), or, with `prefix: '/values'`, the path below it
 * (`baseUrl`).
 *
 * @module utils/mapProblemErrorsToFields
 */

/**
 * The `errors[]` of a problem response, from an axios error or the body itself.
 *
 * @param {unknown} problemOrError - A rejected axios request, or a problem body
 * @returns {Array<{ pointer: string, code?: string, message?: string }>}
 */
export function problemErrorsOf(problemOrError) {
  const body = problemOrError?.response?.data ?? problemOrError;
  const errors = body?.errors;
  return Array.isArray(errors) ? errors.filter(e => e && typeof e.pointer === 'string') : [];
}

/**
 * The segments of an RFC 6901 JSON Pointer: `/a~1b/c~0d` → `['a/b', 'c~d']`.
 *
 * @param {string} pointer
 * @returns {string[]}
 */
export function pointerSegments(pointer) {
  if (!pointer) return [];
  return pointer
    .split('/')
    .slice(1)
    .map(segment => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
}

/**
 * The message shown for one entry: the localized text of its `code`
 * (`errors.fields.<CODE>`) when there is one, else the server's `message`.
 *
 * @param {{ code?: string, message?: string }} entry
 * @param {Function} [t] - i18next `t`
 * @returns {string}
 */
function messageOf(entry, t) {
  const fallback = entry.message || entry.code || '';
  if (!t || typeof entry.code !== 'string') return fallback;
  const key = `errors.fields.${entry.code}`;
  const text = t(key, { defaultValue: fallback });
  return text && text !== key ? text : fallback;
}

/**
 * Map the `errors[]` of a problem response onto form fields.
 *
 * @example
 * // POST …/_test answered { errors: [{ pointer: '/values/baseUrl', code: 'REQUIRED', … }] }
 * mapProblemErrorsToFields(err, { prefix: '/values', t });
 * // → { baseUrl: 'Required.' }
 *
 * @param {unknown} problemOrError - A rejected axios request, or a problem body
 * @param {Object} [options]
 * @param {string} [options.prefix] - Only pointers below this one (e.g. `/values`),
 *   keyed by the path below it; entries elsewhere are left out
 * @param {Function} [options.t] - i18next `t`, to localize messages by `code`
 * @returns {Object<string, string>} Dotted field path → message; the first
 *   message of a field wins
 */
export function mapProblemErrorsToFields(problemOrError, { prefix = '', t } = {}) {
  const prefixSegments = pointerSegments(prefix);
  const fields = {};
  for (const entry of problemErrorsOf(problemOrError)) {
    const segments = pointerSegments(entry.pointer);
    const below = prefixSegments.every((segment, i) => segments[i] === segment);
    if (!below || segments.length <= prefixSegments.length) continue;
    const field = segments.slice(prefixSegments.length).join('.');
    if (!Object.hasOwn(fields, field)) fields[field] = messageOf(entry, t);
  }
  return fields;
}
