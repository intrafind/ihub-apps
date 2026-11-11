// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `platform.provenance` with code defaults, so a platform.json written before
 * the block existed behaves like one written after.
 *
 * - `storeRecords` (default true): false attaches the provenance object but
 *   keeps no store.
 * - `retentionDays` (default 365): records older than this are swept daily;
 *   0 or less keeps them forever (as `chats` and `projects`).
 * - `verify.access` (default `authenticated`): `public` lets third parties call
 *   `POST /api/provenance/_verify` without signing in.
 *
 * @module services/provenance/provenanceSettings
 */
import configCache from '../../configCache.js';

export const DEFAULT_RETENTION_DAYS = 365;

/**
 * @param {Object} [platform] - Platform config; default the cached one.
 * @returns {{storeRecords: boolean, retentionDays: number, verify: {access: 'authenticated'|'public'}}}
 */
export function provenanceSettings(platform = configCache.getPlatform() || {}) {
  const raw = platform?.provenance || {};
  const days = Number(raw.retentionDays);
  return {
    storeRecords: raw.storeRecords !== false,
    retentionDays: Number.isFinite(days) ? days : DEFAULT_RETENTION_DAYS,
    verify: { access: raw.verify?.access === 'public' ? 'public' : 'authenticated' }
  };
}
