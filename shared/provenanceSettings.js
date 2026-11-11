// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Defaults and bounds of the platform `provenance.*` settings (EU AI Act
 * Art. 50(2)), shared by the admin form and the server so both reject the same
 * values. Plain JavaScript, no dependencies.
 *
 * Fields are addressed by a flat key: `retentionDays`, `maxVerifyBytes`,
 * `alpha`, `minScoredTokens`, `detectorTimeoutMs`, `verifyAccess`.
 *
 * @module shared/provenanceSettings
 */

export const MIB = 1024 * 1024;

export const VERIFY_ACCESS_VALUES = ['authenticated', 'public'];

/** What the server uses when a setting is absent (see the settings readers). */
export const PROVENANCE_DEFAULTS = Object.freeze({
  retentionDays: 365,
  storeRecords: true,
  verifyAccess: 'authenticated',
  maxVerifyBytes: 50 * MIB,
  readC2pa: true,
  alpha: 1e-4,
  minScoredTokens: 200,
  detectorTimeoutMs: 15000
});

/**
 * Inclusive bounds. `alpha` is exclusive on both ends (a probability).
 * `retentionDays` 0 keeps records forever.
 */
export const PROVENANCE_BOUNDS = Object.freeze({
  retentionDays: { min: 0, max: 36500 },
  maxVerifyBytes: { min: 1024, max: 1024 * MIB },
  alpha: { min: 0, max: 1, exclusive: true },
  minScoredTokens: { min: 1, max: 100000 },
  detectorTimeoutMs: { min: 1000, max: 120000 }
});

const INTEGER_FIELDS = new Set([
  'retentionDays',
  'maxVerifyBytes',
  'minScoredTokens',
  'detectorTimeoutMs'
]);

/**
 * Check one numeric value.
 *
 * @param {string} field - A key of {@link PROVENANCE_BOUNDS}
 * @param {unknown} value
 * @returns {null|'required'|'number'|'integer'|'min'|'max'} The problem, or null when valid
 */
export function numericProblem(field, value) {
  const bounds = PROVENANCE_BOUNDS[field];
  if (value === '' || value === null || value === undefined) return 'required';
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'number';
  if (INTEGER_FIELDS.has(field) && !Number.isInteger(value)) return 'integer';
  if (bounds.exclusive) {
    if (value <= bounds.min) return 'min';
    if (value >= bounds.max) return 'max';
    return null;
  }
  if (value < bounds.min) return 'min';
  if (value > bounds.max) return 'max';
  return null;
}

/**
 * Validate the admin-owned values. A watermark field that is `null` or
 * `undefined` means "use the default" and is valid.
 *
 * @param {Object} values - `{retentionDays, maxVerifyBytes, verifyAccess, alpha?, minScoredTokens?, detectorTimeoutMs?}`
 * @returns {Object<string, string>} Problem per field; empty when valid
 */
export function validateProvenanceValues(values) {
  const problems = {};
  for (const field of ['retentionDays', 'maxVerifyBytes']) {
    const problem = numericProblem(field, values[field]);
    if (problem) problems[field] = problem;
  }
  for (const field of ['alpha', 'minScoredTokens', 'detectorTimeoutMs']) {
    const value = values[field];
    if (value === null || value === undefined) continue;
    const problem = numericProblem(field, value);
    if (problem) problems[field] = problem;
  }
  if (!VERIFY_ACCESS_VALUES.includes(values.verifyAccess)) problems.verifyAccess = 'invalid';
  return problems;
}
