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
 *   - one of its credential fields holds the credential id. Credential fields
 *     (`type: "credential"` in the definition) are named `…Ref` by convention
 *     (`apiKeyRef`, `clientSecretRef`, `bindPasswordRef`); only those keys
 *     count, so an ordinary value that happens to equal a short id such as
 *     `jira` is not mistaken for a reference.
 *
 * @module features/admin/utils/credentialUsage
 */

/** Key suffix of credential-reference fields in installation values. */
const CREDENTIAL_FIELD_SUFFIX = 'Ref';

/**
 * Whether a credential-reference field of `values` (an installation's stored
 * values) holds `credentialId`.
 *
 * @param {Object|undefined} values
 * @param {string} credentialId
 * @returns {boolean}
 */
function referencesCredential(values, credentialId) {
  if (!values || typeof values !== 'object') return false;
  return Object.entries(values).some(
    ([key, value]) => key.endsWith(CREDENTIAL_FIELD_SUFFIX) && value === credentialId
  );
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
        referencesCredential(item?.values, credentialId)
    )
    .map(item => ({ id: item.id, label: item.label || item.id }));
}

export default installationsUsingCredential;
