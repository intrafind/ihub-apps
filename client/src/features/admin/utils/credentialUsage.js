// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Which installed integrations use a credential profile, as far as the
 * client can tell from the installations list (IN-B3, client part). The
 * server does not check references when a credential is deleted; this list is
 * what the delete dialog shows so the admin knows what will break.
 *
 * An installation uses a credential when
 *   - its sign-in keeps it as the managed secret (`auth.credentialRef`), or
 *   - one of its stored values (at any depth) is exactly the credential id —
 *     how `credential` fields reference a profile.
 *
 * @module features/admin/utils/credentialUsage
 */

/**
 * Whether `value` (a stored installation value) contains `credentialId`
 * as a whole string, at any depth.
 *
 * @param {unknown} value
 * @param {string} credentialId
 * @returns {boolean}
 */
function containsCredentialId(value, credentialId) {
  if (typeof value === 'string') return value === credentialId;
  if (Array.isArray(value)) return value.some(entry => containsCredentialId(entry, credentialId));
  if (value && typeof value === 'object') {
    return Object.values(value).some(entry => containsCredentialId(entry, credentialId));
  }
  return false;
}

/**
 * The installations that use a credential.
 *
 * @param {Array<{ id: string, label?: string, auth?: { credentialRef?: string }, values?: Object }>} installations
 *   Items of `GET /api/admin/integrations/installed`.
 * @param {string} credentialId - The credential profile id.
 * @returns {Array<{ id: string, label: string }>} In list order.
 *
 * @example
 * installationsUsingCredential(items, 'brave-key') // [{ id: 'brave', label: 'Brave Search' }]
 */
export function installationsUsingCredential(installations, credentialId) {
  if (!Array.isArray(installations) || !credentialId) return [];
  return installations
    .filter(
      item =>
        item?.auth?.credentialRef === credentialId ||
        containsCredentialId(item?.values, credentialId)
    )
    .map(item => ({ id: item.id, label: item.label || item.id }));
}

export default installationsUsingCredential;
