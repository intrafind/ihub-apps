/**
 * Ledger identity resolution (concept §10.3, decision 3 + 4).
 *
 *  - `full`          principal incl. PII (name, email, groups)
 *  - `default`       stable user id only — no PII
 *  - `pseudonymized` salted hash of the user id (same pepper as UserFingerprint)
 *
 * Anonymous users never get a stable id on the ledger: each run gets a random
 * server-side id, so the run is stored and answerable by id possession but can
 * never be listed or reloaded as history.
 *
 * @module services/loop/runIdentity
 */
import crypto from 'crypto';
import { fingerprint } from '../UserFingerprint.js';
import { LEDGER_IDENTITY_MODES } from '../../../shared/runEvents.js';

export const ANONYMOUS_USER_ID = 'anonymous';

/** Whether `user` has admin access (permission flag or admin group membership). */
export function isAdminUser(user) {
  if (!user) return false;
  if (user.permissions?.adminAccess === true) return true;
  const groups = Array.isArray(user.groups) ? user.groups : [];
  return groups.includes('admin') || groups.includes('admins');
}

export function isAnonymousUser(user) {
  if (!user) return true;
  if (user.anonymous === true) return true;
  return !user.id || user.id === ANONYMOUS_USER_ID;
}

export function normalizeIdentityMode(mode) {
  return LEDGER_IDENTITY_MODES.includes(mode) ? mode : 'default';
}

/** Random, unguessable id for anonymous runs. */
export function randomAnonymousId() {
  return `anon-${crypto.randomBytes(16).toString('hex')}`;
}

/**
 * Resolve the principal recorded on a run.
 *
 * @param {Object|null} user - req.user-like object ({id, name, email, groups, isAgent, profileId})
 * @param {Object} [opts]
 * @param {string} [opts.mode='default'] - identity mode
 * @returns {Promise<{id:string, mode:string, anonymous:boolean, isAgent?:boolean, name?:string, email?:string, groups?:string[], profileId?:string}>}
 */
export async function resolvePrincipal(user, { mode = 'default' } = {}) {
  const identityMode = normalizeIdentityMode(mode);
  if (isAnonymousUser(user)) {
    return { id: randomAnonymousId(), mode: identityMode, anonymous: true };
  }
  const base = {
    mode: identityMode,
    anonymous: false,
    ...(user.isAgent ? { isAgent: true } : {}),
    ...(user.profileId ? { profileId: String(user.profileId) } : {})
  };
  switch (identityMode) {
    case 'full':
      return {
        id: String(user.id),
        ...base,
        ...(user.name ? { name: String(user.name) } : {}),
        ...(user.email ? { email: String(user.email) } : {}),
        ...(Array.isArray(user.groups) ? { groups: [...user.groups] } : {})
      };
    case 'pseudonymized': {
      const hashed = await fingerprint(String(user.id));
      return { id: hashed, ...base };
    }
    case 'default':
    default:
      return { id: String(user.id), ...base };
  }
}

/**
 * The id recorded for a human acting on a run (answering an interaction,
 * sending a human event): the literal `anonymous` for anonymous users, else
 * the principal id in the run's identity mode — so a pseudonymized ledger
 * never carries a raw user id.
 *
 * @param {Object|null} user
 * @param {Object} [opts]
 * @param {string} [opts.mode='default'] - the run's identity mode
 * @returns {Promise<string>}
 */
export async function resolveActorId(user, { mode = 'default' } = {}) {
  if (isAnonymousUser(user)) return ANONYMOUS_USER_ID;
  return (await resolvePrincipal(user, { mode })).id;
}
