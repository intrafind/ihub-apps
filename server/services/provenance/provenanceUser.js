// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Who a stored provenance record names (`provenance.recordUser`).
 *
 * - `none` (default): the record names nobody.
 * - `anonymous`: a secured hash of the user id, keyed with a secret only the
 *   server holds (the installation pepper, `contents/.usage-pepper`, never
 *   shown in any UI or API): `usr_<16 hex>`. Records of one person share the
 *   value, but the user cannot be determined from it.
 * - `pseudonymous`: a plain SHA-256 of the user id (64 hex). Whoever knows a
 *   user id can compute it and so attribute the record; nobody can read the id
 *   from it.
 * - `identified`: the user id (never the name or email).
 *
 * Every anonymous visitor is the id `anonymous`. The value lives only in the
 * stored record: it is never part of the provenance object a client or API
 * caller receives, and the verify endpoint shows it to admins only. It is kept
 * when the user is deleted, like the rest of the record.
 *
 * Resolved here with the fingerprint helper only, not through the usage
 * recorder, which pulls the quota and cluster modules into every caller.
 *
 * @module services/provenance/provenanceUser
 */
import { createHash } from 'node:crypto';
import logger from '../../utils/logger.js';
import { fingerprint } from '../UserFingerprint.js';
import { isAnonymousUser } from '../loop/runIdentity.js';
import { provenanceSettings } from './provenanceSettings.js';

/** The plain SHA-256 of `pseudonymous` mode: reproducible by anyone who knows the id. */
export function pseudonymOf(userId) {
  return createHash('sha256').update(String(userId), 'utf8').digest('hex');
}

/**
 * The `user` member of a stored record, or null when nothing is recorded.
 *
 * @param {Object} input
 * @param {Object|null} [input.user] - The acting user (`req.user`-like)
 * @param {string} [mode] - Default: the platform setting
 * @returns {Promise<{mode: string, id: string}|null>}
 */
export async function recordedUser({ user } = {}, mode = provenanceSettings().recordUser) {
  if (!mode || mode === 'none' || !user) return null;
  try {
    const key = isAnonymousUser(user) ? 'anonymous' : String(user.id);
    if (mode === 'identified') return { mode, id: key };
    if (mode === 'pseudonymous') return { mode, id: pseudonymOf(key) };
    if (mode === 'anonymous') {
      const id = await fingerprint(key);
      return id ? { mode, id } : null;
    }
    return null;
  } catch (error) {
    // Naming the user is never worth losing the record.
    logger.warn('Could not resolve the user of a provenance record', {
      component: 'ProvenanceUser',
      error: error.message
    });
    return null;
  }
}

/**
 * A record as a verify caller may see it: the `user` member only for admins.
 *
 * @param {Object} record
 * @param {boolean} isAdmin
 * @returns {Object}
 */
export function recordForCaller(record, isAdmin) {
  if (isAdmin || !record || record.user === undefined) return record;
  const { user: _user, ...rest } = record;
  return rest;
}
