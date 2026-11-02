// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Where a connection's secret lives, and how its `secretRef` is written.
 *
 * Per-user OAuth tokens stay exactly where `TokenStorageService` has always
 * kept them, encrypted per (storage id, service):
 *
 *   contents/integrations/jira/<storageId>.json
 *   contents/integrations/<office365|googledrive|nextcloud>/<storageId>__<installationId>.json
 *   contents/integrations/<office365|googledrive|nextcloud>/<storageId>.json   (legacy, unscoped)
 *   contents/integrations/mcp/<storageId>__<serverId>.json
 *
 * The connection index never copies a token; its `secretRef` names the file:
 * `tokenstore:<service>/<file stem>`. A shared service account names a
 * credential store profile instead: `credential:<credentialRef>`.
 *
 * @module services/integrations/auth/tokenSecrets
 */
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import tokenStorage from '../../TokenStorageService.js';

/** The token store's file-name allowlist (kept in sync with TokenStorageService). */
export const SAFE_STORAGE_ID = /^[A-Za-z0-9._@+-]+$/;
const MAX_STORAGE_ID_LENGTH = 256;

/**
 * The id a user's tokens are filed under. Ids the token store accepts are
 * used as they are (so every existing file keeps its name); every other id
 * (OIDC subjects with `|`, `/`, `:`, …) is mapped to a stable
 * `u_<sha256 hex, 32 chars>` so the file name stays inside the allowlist. The
 * real id stays inside the encrypted payload and in the connection record.
 *
 * @param {string} userId - The real user id
 * @returns {string} Storage id
 * @throws {Error} When `userId` is not a non-empty string
 */
export function tokenStorageIdFor(userId) {
  if (typeof userId !== 'string' || !userId) {
    throw new Error('A user id is required to store integration tokens');
  }
  if (SAFE_STORAGE_ID.test(userId) && userId.length <= MAX_STORAGE_ID_LENGTH) return userId;
  return `u_${crypto.createHash('sha256').update(userId, 'utf8').digest('hex').slice(0, 32)}`;
}

/**
 * The `secretRef` of a token store file.
 *
 * @param {Object} params
 * @param {string} params.service - Token store service (`jira`, `office365`, `mcp`, …)
 * @param {string} params.storageId
 * @param {string|null} [params.providerId] - Installation id for scoped files
 * @returns {string} `tokenstore:<service>/<stem>`
 *
 * @example
 *   tokenSecretRef({ service: 'office365', storageId: 'alice', providerId: 'o365-hq' });
 *   // → 'tokenstore:office365/alice__o365-hq'
 */
export function tokenSecretRef({ service, storageId, providerId = null }) {
  return `tokenstore:${service}/${providerId ? `${storageId}__${providerId}` : storageId}`;
}

/**
 * Parse a `secretRef`.
 *
 * @param {string} ref
 * @returns {{type: 'tokenstore', service: string, storageId: string, providerId: (string|null)}
 *   | {type: 'credential', credentialRef: string} | null}
 */
export function parseSecretRef(ref) {
  if (typeof ref !== 'string') return null;
  if (ref.startsWith('credential:')) {
    const credentialRef = ref.slice('credential:'.length);
    return credentialRef ? { type: 'credential', credentialRef } : null;
  }
  const match = ref.match(/^tokenstore:([A-Za-z0-9._@+-]+)\/([A-Za-z0-9._@+-]+)$/);
  if (!match) return null;
  const [, service, stem] = match;
  const at = stem.indexOf('__');
  return {
    type: 'tokenstore',
    service,
    storageId: at > 0 ? stem.slice(0, at) : stem,
    providerId: at > 0 ? stem.slice(at + 2) : null
  };
}

/**
 * Delete exactly the token file a `secretRef` names — never the legacy
 * unscoped fallback the token store would read for a missing scoped file,
 * which may belong to another installation.
 *
 * @param {string} secretRef
 * @returns {Promise<boolean>} Whether a file was removed
 */
export async function deleteSecretFile(secretRef) {
  const parsed = parseSecretRef(secretRef);
  if (parsed?.type !== 'tokenstore') return false;
  const file = tokenStorage._tokenFilePath(parsed.storageId, parsed.service, parsed.providerId);
  try {
    await fs.unlink(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * A stable hash of the installation settings a credential was issued under.
 *
 * @param {Object} material - Plain JSON (endpoint, tenant, client id, …)
 * @returns {string} sha256 hex
 */
export function settingsFingerprint(material) {
  return crypto.createHash('sha256').update(JSON.stringify(material)).digest('hex');
}
