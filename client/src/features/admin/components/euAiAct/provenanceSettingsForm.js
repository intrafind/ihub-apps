// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import {
  MIB,
  PROVENANCE_DEFAULTS,
  RECORD_USER_VALUES,
  validateProvenanceValues
} from '../../../../../../shared/provenanceSettings.js';

/**
 * Pure helpers of the forms that edit `platform.provenance`: stored block <-> form
 * strings, validation (the bounds are the server's: `shared/provenanceSettings.js`),
 * the body to save and the consequences worth a confirmation.
 *
 * The block is edited in three places, each saving only its own fields (the server
 * merges a partial block into the stored one):
 * - `provenance`: records and checking outputs (card "Provenance settings");
 * - `gateway`: the iFinder Model Gateway (card "Text watermark", detectors);
 * - `thresholds`: how iHub decides on a watermark (card "Text watermark").
 */

/** The form fields each section owns. */
export const SECTION_FIELDS = Object.freeze({
  provenance: [
    'retentionDays',
    'storeRecords',
    'recordUser',
    'verifyAccess',
    'maxVerifyBytes',
    'readC2pa'
  ],
  gateway: ['gatewayUrl', 'gatewayCredentialRef'],
  thresholds: ['alpha', 'minScoredTokens', 'detectorTimeoutMs']
});

/** Flat form field of a server error path (`media.maxVerifyBytes` -> `maxVerifyBytes`). */
export const SERVER_FIELD = {
  retentionDays: 'retentionDays',
  storeRecords: 'storeRecords',
  recordUser: 'recordUser',
  'verify.access': 'verifyAccess',
  'media.maxVerifyBytes': 'maxVerifyBytes',
  'media.readC2pa': 'readC2pa',
  'watermark.alpha': 'alpha',
  'watermark.minScoredTokens': 'minScoredTokens',
  'watermark.detectorTimeoutMs': 'detectorTimeoutMs',
  'watermark.gatewayUrl': 'gatewayUrl',
  'watermark.gatewayCredentialRef': 'gatewayCredentialRef'
};

const text = value => (value === undefined || value === null ? '' : String(value));

/** MiB as the admin sees it: exact for the common cases, never rounded for odd byte counts. */
export function bytesToMib(bytes) {
  return text(bytes / MIB);
}

/**
 * @param {Object} [block] - `platform.provenance` of the admin GET (may be absent)
 * @returns {Object} Form state; every number a string, watermark tunables empty for "default"
 */
export function toForm(block = {}) {
  const d = PROVENANCE_DEFAULTS;
  const bytes = Number.isFinite(block.media?.maxVerifyBytes)
    ? block.media.maxVerifyBytes
    : d.maxVerifyBytes;
  return {
    retentionDays: text(
      Number.isFinite(block.retentionDays) ? block.retentionDays : d.retentionDays
    ),
    storeRecords: block.storeRecords !== false,
    recordUser: RECORD_USER_VALUES.includes(block.recordUser) ? block.recordUser : d.recordUser,
    verifyAccess: block.verify?.access === 'public' ? 'public' : 'authenticated',
    maxVerifyMib: bytesToMib(bytes),
    readC2pa: block.media?.readC2pa !== false,
    alpha: text(block.watermark?.alpha),
    minScoredTokens: text(block.watermark?.minScoredTokens),
    detectorTimeoutMs: text(block.watermark?.detectorTimeoutMs),
    gatewayUrl: text(block.watermark?.gatewayUrl),
    gatewayCredentialRef: text(block.watermark?.gatewayCredentialRef),
    // Kept so an untouched size is saved byte-exact.
    originalBytes: bytes,
    originalMib: bytesToMib(bytes)
  };
}

const num = value => (String(value).trim() === '' ? '' : Number(String(value).trim()));
const optionalNum = value => (String(value).trim() === '' ? null : Number(String(value).trim()));

/** @returns {Object} The numbers and choices of the form, parsed (NaN stays NaN so it is rejected). */
export function toValues(form) {
  const mib = String(form.maxVerifyMib).trim();
  return {
    retentionDays: num(form.retentionDays),
    verifyAccess: form.verifyAccess,
    maxVerifyBytes:
      mib === ''
        ? ''
        : mib === form.originalMib
          ? form.originalBytes
          : Math.round(Number(mib) * MIB),
    alpha: optionalNum(form.alpha),
    minScoredTokens: optionalNum(form.minScoredTokens),
    detectorTimeoutMs: optionalNum(form.detectorTimeoutMs)
  };
}

/**
 * @param {Object} form
 * @param {string} section - Only problems of this section's fields count
 * @returns {Object<string, string>} Problem code per form field (see `numericProblem`); empty when valid
 */
export function validateForm(form, section) {
  const values = toValues(form);
  const problems = validateProvenanceValues(values);
  const url = String(form.gatewayUrl || '').trim();
  if (url && !isHttpUrl(url)) problems.gatewayUrl = 'url';
  const owned = SECTION_FIELDS[section];
  return Object.fromEntries(Object.entries(problems).filter(([field]) => owned.includes(field)));
}

function isHttpUrl(value) {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

const optionalText = value => String(value || '').trim() || null;

/**
 * The `provenance` body to save: only what the section owns, as a partial block
 * the server merges into the stored one. `null` on a watermark field means
 * "default" (a tunable) or "none" (the gateway).
 *
 * @param {Object} form
 * @param {string} section - A key of {@link SECTION_FIELDS}
 */
export function buildBody(form, section) {
  const v = toValues(form);
  if (section === 'gateway') {
    return {
      watermark: {
        gatewayUrl: optionalText(form.gatewayUrl),
        // A credential without a gateway means nothing.
        gatewayCredentialRef: optionalText(form.gatewayUrl)
          ? optionalText(form.gatewayCredentialRef)
          : null
      }
    };
  }
  if (section === 'thresholds') {
    return {
      watermark: {
        alpha: v.alpha,
        minScoredTokens: v.minScoredTokens,
        detectorTimeoutMs: v.detectorTimeoutMs
      }
    };
  }
  return {
    retentionDays: v.retentionDays,
    storeRecords: form.storeRecords,
    recordUser: form.recordUser,
    verify: { access: v.verifyAccess },
    media: { maxVerifyBytes: v.maxVerifyBytes, readC2pa: form.readC2pa }
  };
}

export function isDirty(form, saved, section) {
  return JSON.stringify(buildBody(form, section)) !== JSON.stringify(buildBody(saved, section));
}

/**
 * What the admin should confirm before saving.
 *
 * @returns {{retentionLowered: boolean, accessPublic: boolean, accessRestricted: boolean,
 *   retentionDays: number}}
 */
export function consequences(form, saved) {
  const before = Number(saved.retentionDays);
  const after = Number(form.retentionDays);
  const retentionLowered =
    Number.isFinite(after) && after > 0 && (before === 0 || after < before || before < 0);
  return {
    retentionLowered,
    retentionDays: after,
    accessPublic: form.verifyAccess === 'public' && saved.verifyAccess !== 'public',
    accessRestricted: form.verifyAccess !== 'public' && saved.verifyAccess === 'public'
  };
}

export function needsConfirmation(c) {
  return c.retentionLowered || c.accessPublic || c.accessRestricted;
}
