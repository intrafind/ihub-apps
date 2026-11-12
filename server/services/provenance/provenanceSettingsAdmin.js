// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Admin save of `platform.provenance`: validate, deep-merge over the stored
 * block (so keys the form does not own survive) and describe what changed for
 * the audit log.
 *
 * @module services/provenance/provenanceSettingsAdmin
 */
import { provenanceSettingsSaveSchema } from '../../validators/provenanceSettingsSchema.js';
import { watermarkSettings } from './watermark/watermarkSettings.js';
import { provenanceSettings } from './provenanceSettings.js';
import { ServiceError } from '../../utils/ServiceError.js';

const isObject = value => value && typeof value === 'object' && !Array.isArray(value);

/** `a` over `b`, one level deep per nested group; `null` removes a key. */
function mergeGroup(stored, incoming) {
  const merged = { ...(isObject(stored) ? stored : {}) };
  for (const [key, value] of Object.entries(incoming)) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  return merged;
}

/**
 * @param {unknown} incoming - `provenance` of the request body; undefined keeps `stored`
 * @param {Object} [stored] - `provenance` of platform.json
 * @returns {Object|undefined} The block to write
 * @throws {ServiceError} BAD_REQUEST with `errors` as `{field, message}` list
 */
export function mergeProvenanceForSave(incoming, stored) {
  if (incoming === undefined) return stored;
  // Other admin cards save the whole platform file and send the stored block back
  // unchanged; a legacy hand-edited value must not block them.
  if (stored !== undefined && JSON.stringify(incoming) === JSON.stringify(stored)) return stored;
  const parsed = provenanceSettingsSaveSchema.safeParse(incoming);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(issue => ({
      field: issue.path.join('.') || 'provenance',
      message: issue.message
    }));
    throw new ServiceError('BAD_REQUEST', `Invalid provenance settings: ${issues[0].field}`, {
      details: issues
    });
  }
  const base = isObject(stored) ? stored : {};
  const body = parsed.data;
  const merged = { ...base };
  for (const [key, value] of Object.entries(body)) {
    if (['verify', 'media', 'watermark'].includes(key)) {
      merged[key] = mergeGroup(base[key], value);
      if (key === 'watermark' && Object.keys(merged[key]).length === 0) delete merged[key];
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

/** Effective values (stored or default), flat, for comparing and auditing. */
function effective(block) {
  const platform = { provenance: block };
  const p = provenanceSettings(platform);
  const w = watermarkSettings(platform);
  return {
    retentionDays: p.retentionDays,
    storeRecords: p.storeRecords,
    recordUser: p.recordUser,
    'verify.access': p.verify.access,
    'media.maxVerifyBytes': p.media.maxVerifyBytes,
    'media.readC2pa': p.media.readC2pa,
    'watermark.alpha': w.alpha,
    'watermark.minScoredTokens': w.minScoredTokens,
    'watermark.detectorTimeoutMs': w.detectorTimeoutMs
  };
}

/**
 * @returns {{changed: Array<{key: string, from: unknown, to: unknown}>}|null} Null when nothing changed
 */
export function describeProvenanceChange(before, after) {
  const a = effective(before);
  const b = effective(after);
  const changed = Object.keys(a)
    .filter(key => a[key] !== b[key])
    .map(key => ({ key, from: a[key], to: b[key] }));
  return changed.length ? { changed } : null;
}
