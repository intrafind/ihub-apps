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
 *   - one of its credential fields holds the credential id. A credential field
 *     is an install field with `type: "credential"` in the integration's
 *     definition (`GET /api/admin/integrations/catalog/{id}` → `install`). Only
 *     those keys count, so an ordinary value that happens to equal a short id
 *     such as `jira` is not mistaken for a reference.
 *
 * The installations list does not carry the definition's fields, so the
 * caller loads the definitions (see {@link credentialFieldsByDefinition}).
 * For an installation whose definition could not be loaded, the keys are
 * guessed by name: credential fields are named `…Ref` by convention
 * (`apiKeyRef`, `clientSecretRef`, `bindPasswordRef`). That fallback misses a
 * credential field named otherwise and is used only without the metadata.
 *
 * @module features/admin/utils/credentialUsage
 */

/** Key suffix of credential-reference fields, used when the definition is not known. */
const CREDENTIAL_FIELD_SUFFIX = 'Ref';

/**
 * The keys of the credential fields (`type: "credential"`) of a definition.
 *
 * @param {{ install?: Array<{ key?: string, type?: string }> }|null|undefined} definition
 *   A definition as `GET /api/admin/integrations/catalog/{id}` returns it.
 * @returns {Set<string>|null} null when the definition carries no field list.
 */
export function credentialFieldKeys(definition) {
  if (!definition || !Array.isArray(definition.install)) return null;
  return new Set(
    definition.install
      .filter(field => field?.type === 'credential' && typeof field.key === 'string')
      .map(field => field.key)
  );
}

/**
 * Loads the definitions of the given installations and returns, per
 * definition id, the keys of its credential fields. A definition that cannot
 * be loaded is left out; its installations fall back to the name convention.
 *
 * @param {Array<{ definition?: string }>} installations - Items of `GET /api/admin/integrations/installed`.
 * @param {(definitionId: string) => Promise<Object>} fetchDefinition - Loads one definition.
 * @returns {Promise<Map<string, Set<string>>>}
 *
 * @example
 * const fields = await credentialFieldsByDefinition(items, fetchIntegrationDefinition);
 * installationsUsingCredential(items, 'brave-key', fields);
 */
export async function credentialFieldsByDefinition(installations, fetchDefinition) {
  const ids = [
    ...new Set(
      (Array.isArray(installations) ? installations : [])
        .map(item => item?.definition)
        .filter(id => typeof id === 'string' && id)
    )
  ];
  const results = await Promise.allSettled(ids.map(id => fetchDefinition(id)));
  const byDefinition = new Map();
  results.forEach((result, index) => {
    if (result.status !== 'fulfilled') return;
    const keys = credentialFieldKeys(result.value);
    if (keys) byDefinition.set(ids[index], keys);
  });
  return byDefinition;
}

/**
 * Whether a credential field of `values` (an installation's stored values)
 * holds `credentialId`.
 *
 * @param {Object|undefined} values
 * @param {string} credentialId
 * @param {Set<string>|undefined} credentialKeys - The definition's credential
 *   field keys; when missing, keys ending in `Ref` count (name fallback).
 * @returns {boolean}
 */
function referencesCredential(values, credentialId, credentialKeys) {
  if (!values || typeof values !== 'object') return false;
  const isCredentialField = credentialKeys
    ? key => credentialKeys.has(key)
    : key => key.endsWith(CREDENTIAL_FIELD_SUFFIX);
  return Object.entries(values).some(
    ([key, value]) => isCredentialField(key) && value === credentialId
  );
}

/**
 * The installations that use a credential.
 *
 * @param {Array<{ id: string, label?: string, definition?: string, auth?: { credentialRef?: string }, values?: Object }>} installations
 *   Items of `GET /api/admin/integrations/installed`.
 * @param {string} credentialId - The credential profile id.
 * @param {Map<string, Set<string>>} [fieldsByDefinition] - Credential field keys
 *   per definition id ({@link credentialFieldsByDefinition}). Installations
 *   whose definition is not in it fall back to the `…Ref` name convention.
 * @returns {Array<{ id: string, label: string }>} In list order.
 *
 * @example
 * installationsUsingCredential(items, 'brave-key', fields) // [{ id: 'brave', label: 'Brave Search' }]
 */
export function installationsUsingCredential(installations, credentialId, fieldsByDefinition) {
  if (!Array.isArray(installations) || !credentialId) return [];
  return installations
    .filter(
      item =>
        item?.auth?.credentialRef === credentialId ||
        referencesCredential(item?.values, credentialId, fieldsByDefinition?.get(item?.definition))
    )
    .map(item => ({ id: item.id, label: item.label || item.id }));
}

export default installationsUsingCredential;
