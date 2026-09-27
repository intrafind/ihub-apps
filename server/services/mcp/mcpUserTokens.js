/**
 * Per-user OAuth tokens for outbound MCP servers (`auth.type: "oauthUser"`).
 *
 * Tokens live in the encrypted per-user token files `TokenStorageService`
 * already keeps for Jira, Office 365 and the cloud providers:
 * `contents/integrations/mcp/<storageId>__<serverId>.json`, AES-256-GCM,
 * context-bound to the storage id. The payload is the MCP SDK's `OAuthTokens`
 * shape (`access_token`, `token_type`, `expires_in`, `scope`, `refresh_token`)
 * plus `expiresIn` (what drives the file's `expiresAt`), the real `userId` and
 * the `serverId`.
 *
 * The token store's file-name allowlist (`/^[A-Za-z0-9._@+-]+$/`) rejects some
 * OIDC subjects (`auth0|abc`, `urn:...`). Such ids are mapped to a stable
 * `u_<sha256 hex, 32 chars>` storage id; the real id stays inside the
 * encrypted payload so admin views can still show who is connected.
 *
 * @module services/mcp/mcpUserTokens
 */
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import tokenStorageService from '../TokenStorageService.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'McpUserTokens';

/** `serviceName` under `contents/integrations/` that holds every MCP token file. */
export const MCP_TOKEN_SERVICE = 'mcp';

/** The token store's file-name allowlist (kept in sync with TokenStorageService). */
const SAFE_STORAGE_ID = /^[A-Za-z0-9._@+-]+$/;
const MAX_STORAGE_ID_LENGTH = 256;

/**
 * The id a user's tokens are filed under. Ids the token store accepts are
 * used as they are; every other id (OIDC subjects with `|`, `/`, `:`, …) is
 * hashed so the file name stays inside the allowlist.
 *
 * @param {string} userId - The real user id
 * @returns {string} Storage id
 * @throws {Error} When `userId` is not a non-empty string
 */
export function tokenStorageIdFor(userId) {
  if (typeof userId !== 'string' || !userId) {
    throw new Error('A user id is required to store MCP tokens');
  }
  if (SAFE_STORAGE_ID.test(userId) && userId.length <= MAX_STORAGE_ID_LENGTH) return userId;
  return `u_${crypto.createHash('sha256').update(userId, 'utf8').digest('hex').slice(0, 32)}`;
}

/**
 * The stored token payload of one user for one server, or null when the user
 * is not connected (no file, or a file this installation's key cannot read).
 *
 * @param {string} userId
 * @param {string} serverId
 * @returns {Promise<Object|null>}
 */
export async function readUserTokens(userId, serverId) {
  const storageId = tokenStorageIdFor(userId);
  try {
    const payload = await tokenStorageService.getUserTokens(storageId, MCP_TOKEN_SERVICE, serverId);
    return payload && typeof payload === 'object' ? payload : null;
  } catch (error) {
    // `getUserTokens` folds ENOENT into "User not authenticated"; anything
    // else (an unreadable file after a key change) is logged once and treated
    // as "not connected" so the user can simply connect again.
    if (!/not authenticated/i.test(error?.message || '')) {
      logger.warn('MCP user token file could not be read; treating as not connected', {
        component: COMPONENT,
        serverId,
        userId,
        error: error.message
      });
    }
    return null;
  }
}

/**
 * Store the tokens the authorization server issued (or refreshed).
 *
 * @param {string} userId
 * @param {string} serverId
 * @param {Object} tokens - SDK `OAuthTokens`
 * @returns {Promise<void>}
 */
export async function writeUserTokens(userId, serverId, tokens) {
  const storageId = tokenStorageIdFor(userId);
  const expiresIn = Number.isFinite(tokens?.expires_in) ? tokens.expires_in : undefined;
  const payload = {
    ...tokens,
    ...(expiresIn !== undefined ? { expiresIn } : {}),
    ...(typeof tokens?.scope === 'string' ? { scope: tokens.scope } : {}),
    userId,
    serverId,
    obtainedAt: new Date().toISOString()
  };
  await tokenStorageService.storeUserTokens(storageId, MCP_TOKEN_SERVICE, payload, serverId);
}

/**
 * Remove a user's tokens for a server.
 *
 * @param {string} userId
 * @param {string} serverId
 * @returns {Promise<boolean>} True when a file was removed
 */
export async function deleteUserTokens(userId, serverId) {
  const storageId = tokenStorageIdFor(userId);
  return tokenStorageService.deleteUserTokens(storageId, MCP_TOKEN_SERVICE, serverId);
}

/**
 * Connection state of one user on one server, without decrypting more than
 * needed for the Settings page.
 *
 * @param {string} userId
 * @param {string} serverId
 * @returns {Promise<{connected: boolean, expiresAt: (string|null), expired: boolean, scope: (string|null)}>}
 */
export async function userTokenStatus(userId, serverId) {
  const storageId = tokenStorageIdFor(userId);
  let metadata;
  try {
    metadata = await tokenStorageService.getTokenMetadata(storageId, MCP_TOKEN_SERVICE, serverId);
  } catch {
    return { connected: false, expiresAt: null, expired: false, scope: null };
  }
  const payload = await readUserTokens(userId, serverId);
  if (!payload) return { connected: false, expiresAt: null, expired: false, scope: null };
  return {
    connected: true,
    expiresAt: metadata.expiresAt || null,
    // An expired access token with a refresh token is still a connection: the
    // next call refreshes it.
    expired: Boolean(metadata.expired) && !payload.refresh_token,
    scope: typeof payload.scope === 'string' ? payload.scope : null
  };
}

/**
 * Every user connected to a server, from the token files on disk. Used by the
 * admin view; the real user id is taken from the encrypted payload when the
 * file is readable, else the storage id is reported.
 *
 * @param {string} serverId
 * @returns {Promise<Array<{userId: string, storageId: string, createdAt: (string|null), expiresAt: (string|null), expired: boolean}>>}
 */
export async function listServerConnections(serverId) {
  if (typeof serverId !== 'string' || !SAFE_STORAGE_ID.test(serverId)) return [];
  const dir = path.join(tokenStorageService.storageBasePath, MCP_TOKEN_SERVICE);
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const suffix = `__${serverId}.json`;
  const out = [];
  for (const file of entries) {
    if (!file.endsWith(suffix)) continue;
    const storageId = file.slice(0, -suffix.length);
    if (!storageId || !SAFE_STORAGE_ID.test(storageId)) continue;
    let raw;
    try {
      raw = JSON.parse(await fs.readFile(path.join(dir, file), 'utf8'));
    } catch {
      continue;
    }
    let userId = storageId;
    try {
      const payload = tokenStorageService.decryptTokens(raw, storageId, MCP_TOKEN_SERVICE);
      if (typeof payload?.userId === 'string' && payload.userId) userId = payload.userId;
    } catch {
      /* unreadable payload — the storage id is the best we can report */
    }
    out.push({
      userId,
      storageId,
      createdAt: raw.createdAt || null,
      expiresAt: raw.expiresAt || null,
      expired: raw.expiresAt ? new Date(raw.expiresAt) <= new Date() : false
    });
  }
  return out.sort((a, b) => a.userId.localeCompare(b.userId));
}
