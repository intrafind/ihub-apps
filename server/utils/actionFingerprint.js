// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Action fingerprints (intrafind/ihub-apps#2916, closes the fingerprint gap
 * of #2913).
 *
 * Every action of an installed integration is fingerprinted over what decides
 * whether a call is safe to run without asking:
 *
 * - its **name** (the action's own name, an MCP tool's name),
 * - its **declared side effect** (`read | write | destructive | unknown`, as
 *   the vendor declares it: the definition, the OpenAPI method or the MCP
 *   annotations — never the admin's override, which is the admin's own call),
 * - its **input schema**, canonicalised.
 *
 * The installation stores the fingerprints an admin accepted
 * (`actions.fingerprints`). An action whose name is not in that map is
 * **new**; one whose fingerprint differs is **changed**. Either resolves to at
 * least `approval.newOrChanged` (default `always`) until an admin reviews it
 * (`utils/toolApproval.js`).
 *
 * ## Canonical schema
 *
 * Two schemas that validate the same arguments must give the same
 * fingerprint, whatever the language they were localised into and whatever
 * order their keys come in:
 *
 * - object keys are sorted;
 * - documentation-only keywords are dropped: `description`, `title`,
 *   `examples`, `example`, `$comment`, `$schema`, `$id` (iHub localises
 *   `description` and `title` per request language);
 * - `required` is sorted and dropped when empty;
 * - property names (under `properties`, `patternProperties`, `$defs`,
 *   `definitions`, `dependentSchemas`) are kept as they are, even when a
 *   property is called `description` or `title`;
 * - literal values (`enum`, `const`, `default`) are kept verbatim, only their
 *   object keys sorted.
 *
 * Pure functions only: the writes live in
 * `services/integrations/actionReview.js`.
 *
 * @module utils/actionFingerprint
 */
import { createHash } from 'node:crypto';

/** Prefix of every fingerprint (`sha256:<64 hex>`), as the architecture concept shows it. */
export const FINGERPRINT_PREFIX = 'sha256:';

/** A stored fingerprint: `sha256:` and 64 lowercase hex digits. */
export const FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/;

/** Review states of an action, compared with the fingerprints an admin accepted. */
export const ACTION_REVIEW_STATES = Object.freeze(['new', 'changed']);

/** Keywords that only document a schema; they never change which arguments validate. */
const DOCUMENTATION_KEYWORDS = new Set([
  'description',
  'title',
  'examples',
  'example',
  '$comment',
  '$schema',
  '$id'
]);

/** Keywords whose object keys are property (or definition) names, not keywords. */
const NAMED_SCHEMA_MAPS = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas'
]);

/** Keywords whose values are data, kept verbatim (only their keys sorted). */
const LITERAL_KEYWORDS = new Set(['enum', 'const', 'default']);

const SIDE_EFFECT_VALUES = new Set(['read', 'write', 'destructive', 'unknown']);

/**
 * Order two strings by UTF-16 code units. Explicit on purpose: a fingerprint
 * must not depend on the server's locale (`localeCompare` would), so the same
 * schema hashes the same on every server.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} negative, zero or positive
 */
export function compareCodeUnits(a, b) {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/**
 * A plain value with every object's keys sorted (arrays keep their order).
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function sortedValue(value) {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort(compareCodeUnits)) out[key] = sortedValue(value[key]);
  return out;
}

/**
 * The canonical form of a JSON schema (see the module docs).
 *
 * @param {unknown} schema - a JSON schema node (or anything else, returned as is)
 * @returns {unknown} the canonical node
 *
 * @example
 * canonicalSchema({ type: 'object', title: 'Search', required: ['q', 'a'],
 *   properties: { q: { type: 'string', description: 'Query' }, a: { type: 'number' } } })
 * // { properties: { a: { type: 'number' }, q: { type: 'string' } }, required: ['a', 'q'], type: 'object' }
 */
export function canonicalSchema(schema) {
  if (Array.isArray(schema)) return schema.map(canonicalSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const key of Object.keys(schema).sort(compareCodeUnits)) {
    if (DOCUMENTATION_KEYWORDS.has(key)) continue;
    const value = schema[key];
    if (value === undefined) continue;
    if (NAMED_SCHEMA_MAPS.has(key) && value && typeof value === 'object' && !Array.isArray(value)) {
      const named = {};
      for (const name of Object.keys(value).sort(compareCodeUnits))
        named[name] = canonicalSchema(value[name]);
      out[key] = named;
    } else if (key === 'required' && Array.isArray(value)) {
      if (value.length === 0) continue;
      out[key] = [...new Set(value.map(String))].sort(compareCodeUnits);
    } else if (LITERAL_KEYWORDS.has(key)) {
      out[key] = sortedValue(value);
    } else {
      out[key] = canonicalSchema(value);
    }
  }
  return out;
}

/** The schema an action without parameters is offered with. */
const EMPTY_SCHEMA = Object.freeze({ type: 'object', properties: {} });

/**
 * The fingerprint of one action.
 *
 * @param {Object} action
 * @param {string} action.name - the action's own name
 * @param {string} [action.sideEffect] - the declared side effect (`unknown` when absent)
 * @param {Object} [action.parameters] - the input schema the model is offered
 * @returns {string} `sha256:<64 hex>`
 *
 * @example
 * actionFingerprint({ name: 'search', sideEffect: 'read', parameters: { type: 'object' } })
 * // 'sha256:…'
 */
export function actionFingerprint({ name, sideEffect, parameters } = {}) {
  const payload = JSON.stringify({
    name: String(name || ''),
    sideEffect: SIDE_EFFECT_VALUES.has(sideEffect) ? sideEffect : 'unknown',
    schema: canonicalSchema(
      parameters && typeof parameters === 'object' ? parameters : EMPTY_SCHEMA
    )
  });
  return `${FINGERPRINT_PREFIX}${createHash('sha256').update(payload).digest('hex')}`;
}

/**
 * Whether a value is a well-formed fingerprint.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isFingerprint(value) {
  return typeof value === 'string' && FINGERPRINT_PATTERN.test(value);
}

/**
 * The fingerprints an admin accepted for an installation, or null when none
 * were ever taken (no baseline: nothing can be new or changed yet).
 *
 * @param {Object|null|undefined} installation
 * @returns {Object<string,string>|null}
 */
export function reviewedFingerprintsOf(installation) {
  const map = installation?.actions?.fingerprints;
  return map && typeof map === 'object' && !Array.isArray(map) ? map : null;
}

/**
 * Whether an action is new or changed since the fingerprints an admin
 * accepted.
 *
 * - `null` when the installation has no baseline, the action has no current
 *   fingerprint (it could not be read) or it matches;
 * - `'new'` when the action's name is not in the accepted map;
 * - `'changed'` when its fingerprint differs.
 *
 * @param {Object|null|undefined} installation
 * @param {string|null|undefined} actionName - the action's own name
 * @param {string|null|undefined} fingerprint - its current fingerprint
 * @returns {'new'|'changed'|null}
 */
export function actionReviewState(installation, actionName, fingerprint) {
  if (!actionName || !isFingerprint(fingerprint)) return null;
  const reviewed = reviewedFingerprintsOf(installation);
  if (!reviewed) return null;
  if (!Object.hasOwn(reviewed, actionName)) return 'new';
  return reviewed[actionName] === fingerprint ? null : 'changed';
}
