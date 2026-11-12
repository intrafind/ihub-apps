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
 *   `POST /api/eu-ai-act/provenance/_verify` without signing in.
 * - `recordUser` (default `none`): who a stored record names; see
 *   `provenanceUser.js` (`none`, `anonymous`, `pseudonymous`, `identified`).
 * - `media` (#3328): `maxVerifyBytes` (default 50 MiB) caps an uploaded image or
 *   audio file, `readC2pa` (default true) reads the C2PA manifest of generated
 *   images and uploads.
 *
 * @module services/provenance/provenanceSettings
 */
import configCache from '../../configCache.js';
import { RECORD_USER_VALUES } from '../../../shared/provenanceSettings.js';

export const DEFAULT_RETENTION_DAYS = 365;

/** Default cap of an uploaded verify file: 50 MiB. */
export const DEFAULT_MAX_VERIFY_BYTES = 50 * 1024 * 1024;

/**
 * @param {Object} [platform] - Platform config; default the cached one.
 * @returns {{storeRecords: boolean, retentionDays: number, recordUser: string, verify: {access: 'authenticated'|'public'}, media: {maxVerifyBytes: number, readC2pa: boolean}}}
 */
export function provenanceSettings(platform = configCache.getPlatform() || {}) {
  const raw = platform?.provenance || {};
  const days = Number(raw.retentionDays);
  const maxVerifyBytes = Number(raw.media?.maxVerifyBytes);
  return {
    storeRecords: raw.storeRecords !== false,
    retentionDays: Number.isFinite(days) ? days : DEFAULT_RETENTION_DAYS,
    recordUser: RECORD_USER_VALUES.includes(raw.recordUser) ? raw.recordUser : 'none',
    verify: { access: raw.verify?.access === 'public' ? 'public' : 'authenticated' },
    media: {
      maxVerifyBytes:
        Number.isFinite(maxVerifyBytes) && maxVerifyBytes > 0
          ? Math.floor(maxVerifyBytes)
          : DEFAULT_MAX_VERIFY_BYTES,
      readC2pa: raw.media?.readC2pa !== false
    }
  };
}
