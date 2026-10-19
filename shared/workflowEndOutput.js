// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What an end step's `output` setting can be, shared by the server (the schema
 * that refuses a workflow without one, the end step that resolves it) and the
 * editor (the form and the card that show it).
 *
 * The Output of an end step is the answer of the workflow. It is one of:
 *   - a text: a variable (`finalReport`), a path into one (`report.markdown`), a
 *     state path (`$.data.finalReport`) or a text with variables (`Done: {{n}}`)
 *   - an object of such values, `{ "topic": "topic", "report": "finalReport" }`:
 *     the answer is then a JSON object with those fields, each of them resolved
 *     like a text, a field whose variable was never set left out
 *
 * @module shared/workflowEndOutput
 */

/** An object of objects deeper than this is not an output, whatever it holds. */
const MAX_DEPTH = 8;

/** Keys that are never a field of an output object. */
export const UNSAFE_OUTPUT_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);

/**
 * @param {unknown} value
 * @returns {boolean} True for an object that is neither null nor an array
 */
export function isOutputObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Whether `spec` is an output an end step can give: a text that is not blank, or
 * an object with at least one field whose name is not blank and whose value is
 * itself such an output.
 *
 * @param {unknown} spec - The `output` of an end step
 * @param {number} [depth] - How deep the object is nested (internal)
 * @returns {boolean}
 */
export function hasEndOutput(spec, depth = 0) {
  if (typeof spec === 'string') return spec.trim() !== '';
  if (!isOutputObject(spec) || depth >= MAX_DEPTH) return false;
  const entries = Object.entries(spec);
  return (
    entries.length > 0 &&
    entries.every(
      ([key, value]) =>
        key.trim() !== '' && !UNSAFE_OUTPUT_KEYS.includes(key) && hasEndOutput(value, depth + 1)
    )
  );
}

/**
 * A short label for an output, for a card or a list: the text itself, or the
 * names of the fields of an object (`{ topic, report }`).
 *
 * @param {unknown} spec - The `output` of an end step
 * @param {number} [maxFields] - How many field names to list before shortening
 * @returns {string} '' when there is no output
 */
export function endOutputLabel(spec, maxFields = 3) {
  if (typeof spec === 'string') return spec.trim();
  if (!isOutputObject(spec)) return '';
  const names = Object.keys(spec).filter(name => name.trim() !== '');
  if (names.length === 0) return '';
  const shown = names.slice(0, maxFields).join(', ');
  return `{ ${shown}${names.length > maxFields ? ', …' : ''} }`;
}
