// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Small path and template helpers shared by the integration adapters.
 *
 * Paths are dotted keys with an optional `[]` suffix per segment that means
 * "every element of this array"; a leading `$` or `$.` is ignored, so
 * `$.result.results[].title`, `result.results[].title` and
 * `result.results.title` (when `results` is an object) all work.
 */

const TEMPLATE = /\{([A-Za-z_][A-Za-z0-9_.-]*)\}/g;

/**
 * Read a value at a path. Arrays marked with `[]` are mapped, so the result
 * is an array when any segment carries `[]`.
 *
 * @param {unknown} value
 * @param {string|undefined} path
 * @returns {unknown}
 */
export function valueAtPath(value, path) {
  if (path === undefined || path === null || path === '' || path === '$') return value;
  const normalized = String(path).replace(/^\$\.?/, '');
  if (!normalized) return value;
  const segments = normalized.split('.');
  return walk(value, segments);
}

function walk(node, segments) {
  if (segments.length === 0) return node;
  if (node === null || node === undefined) return undefined;
  const [segment, ...rest] = segments;
  const each = segment.endsWith('[]');
  const key = each ? segment.slice(0, -2) : segment;
  const target = key === '' ? node : typeof node === 'object' ? node[key] : undefined;
  if (each) {
    if (!Array.isArray(target)) return undefined;
    return target.map(item => walk(item, rest));
  }
  return walk(target, rest);
}

/**
 * Replace `{key}` placeholders. Missing keys become an empty string unless
 * `keepUnknown` is set, in which case the placeholder stays as it is.
 *
 * @param {string} template
 * @param {Record<string, unknown>} values
 * @param {{ keepUnknown?: boolean, encode?: boolean }} [options]
 * @returns {string}
 */
export function fillTemplate(template, values = {}, options = {}) {
  if (typeof template !== 'string') return template;
  return template.replace(TEMPLATE, (match, key) => {
    const value = values[key];
    if (value === undefined || value === null) return options.keepUnknown ? match : '';
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
    return options.encode ? encodeURIComponent(text) : text;
  });
}

/**
 * Whether a string is exactly one placeholder, e.g. `{maxRows}`. Such a value
 * keeps the type of the substituted value (a number stays a number).
 * @param {unknown} template
 * @returns {string|null} the key, or null
 */
export function singlePlaceholder(template) {
  if (typeof template !== 'string') return null;
  const match = /^\{([A-Za-z_][A-Za-z0-9_.-]*)\}$/.exec(template);
  return match ? match[1] : null;
}

/**
 * Substitute placeholders in a primitive, keeping the type when the whole
 * value is one placeholder.
 * @param {unknown} value
 * @param {Record<string, unknown>} values
 * @returns {unknown}
 */
export function fillValue(value, values) {
  const key = singlePlaceholder(value);
  if (key) {
    const substituted = values[key];
    return substituted === undefined ? null : substituted;
  }
  return typeof value === 'string' ? fillTemplate(value, values) : value;
}

/**
 * Collect every `{key}` referenced by a template.
 * @param {string} template
 * @returns {string[]}
 */
export function templateKeys(template) {
  if (typeof template !== 'string') return [];
  return [...template.matchAll(TEMPLATE)].map(m => m[1]);
}
