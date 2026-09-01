import {
  createOAuthClient,
  deleteOAuthClient,
  findClientById,
  listPersonalClientsByOwner,
  loadOAuthClients,
  rotateClientSecret,
  saveOAuthClients,
  updatePersonalClientOwner
} from './oauthClientManager.js';
import { generatePersonalApiKey, personalKeyGeneration } from './oauthTokenService.js';
import { buildPublicBaseUrl } from './publicBaseUrl.js';
import { MCP_SCOPES } from '../services/mcp/scopes.js';
import logger from './logger.js';

/**
 * Personal API keys let a user mint credentials for themselves from the
 * integrations page instead of asking an administrator for a service account.
 *
 * A personal key is backed by an ordinary entry in `oauth-clients.json` marked
 * `personal: true` and carrying an owner snapshot. Tokens minted for it act as
 * the owner, so an API call made with the key sees exactly the apps, models and
 * prompts that user sees in the web UI - never more.
 *
 * Whether the feature is offered at all, to whom, and with what limits is
 * decided by the administrator through `platform.oauth.personalKeys`.
 */

const DEFAULT_CONFIG = {
  maxKeysPerUser: 5,
  defaultExpirationDays: 90,
  maxExpirationDays: 365,
  allowedGroups: []
};

const ABSOLUTE_MAX_EXPIRATION_DAYS = 3650;
const MAX_KEY_NAME_LENGTH = 60;

/**
 * Credentials that act on behalf of somebody rather than being an interactive
 * session of their own. None of them may mint a personal key: a credential that
 * can create further credentials outlives every limit placed on it, and an
 * authorization-code token would be able to trade its narrow, short-lived
 * delegation for a long-lived key carrying the owner's full permissions.
 *
 * `authorization.js` states the same rule for the admin gate; both lists deny
 * the same principals for the same reason.
 */
const DELEGATED_AUTH_MODES = [
  'oauth_client_credentials',
  'oauth_static_api_key',
  'oauth_authorization_code',
  'oauth_personal_key'
];

/**
 * Resolve the effective personal-key configuration, applying defaults for
 * anything the administrator has not set.
 *
 * @param {Object} platform - Platform configuration
 * @returns {Object} Effective configuration
 */
export function getPersonalKeyConfig(platform = {}) {
  const configured = platform.oauth?.personalKeys || {};

  const maxExpirationDays = clampNumber(
    configured.maxExpirationDays,
    DEFAULT_CONFIG.maxExpirationDays,
    1,
    ABSOLUTE_MAX_EXPIRATION_DAYS
  );

  // Fall back to the gateway's default scopes so a key generated with a single
  // click can talk to the MCP endpoint without further configuration.
  const scopes =
    toStringArray(configured.scopes) ??
    toStringArray(platform.mcpServer?.defaultScopes) ??
    Object.values(MCP_SCOPES);

  return {
    enabled: configured.enabled === true,
    allowedGroups: toStringArray(configured.allowedGroups) ?? DEFAULT_CONFIG.allowedGroups,
    maxKeysPerUser: clampNumber(configured.maxKeysPerUser, DEFAULT_CONFIG.maxKeysPerUser, 1, 100),
    defaultExpirationDays: clampNumber(
      configured.defaultExpirationDays,
      DEFAULT_CONFIG.defaultExpirationDays,
      1,
      maxExpirationDays
    ),
    maxExpirationDays,
    scopes,
    allowClientCredentials: configured.allowClientCredentials !== false
  };
}

/**
 * Whether the key behind a credential has passed the lifetime it was issued
 * with. The API key JWT carries its own `exp`, but a token minted from the
 * client credentials does not, so both authentication paths and the token
 * endpoint check the key's own expiry to keep `maxExpirationDays` meaningful.
 *
 * @param {Object} client - Stored OAuth client
 * @returns {boolean} True when the backing key has expired
 */
export function isPersonalKeyExpired(client) {
  const expiresAt = client?.metadata?.apiKeyExpiresAt;
  if (!expiresAt) return false;

  const expiry = new Date(expiresAt).getTime();
  return Number.isFinite(expiry) && expiry <= Date.now();
}

/**
 * Personal keys require the OAuth client store, since that is where they live.
 *
 * @param {Object} platform - Platform configuration
 * @returns {boolean} True when the feature is usable on this server
 */
export function isPersonalKeysEnabled(platform = {}) {
  return getPersonalKeyConfig(platform).enabled && platform.oauth?.enabled?.clients === true;
}

/**
 * Check whether a user may manage personal keys. An empty `allowedGroups` list
 * means every signed-in user may; anonymous users never may, because a key that
 * acts as "anonymous" would outlive the session that created it.
 *
 * @param {Object} user - Authenticated user
 * @param {Object} platform - Platform configuration
 * @returns {boolean} True when the user is eligible
 */
export function canUserManagePersonalKeys(user, platform = {}) {
  if (!isPersonalKeysEnabled(platform)) return false;
  if (!user?.id || user.id === 'anonymous') return false;

  // Only an interactive session may manage credentials - see DELEGATED_AUTH_MODES.
  if (user.isOAuthClient || user.isAgent === true) return false;
  if (DELEGATED_AUTH_MODES.includes(user.authMode)) return false;

  const { allowedGroups } = getPersonalKeyConfig(platform);
  if (allowedGroups.length === 0) return true;

  const groups = Array.isArray(user.groups) ? user.groups : [];
  return groups.some(group => allowedGroups.includes(group));
}

/**
 * Build the list of endpoints a personal key can be used against, so the user
 * can copy a working base URL instead of guessing one.
 *
 * @param {import('express').Request} req - Express request object
 * @param {Object} platform - Platform configuration
 * @returns {Object} Endpoint URLs keyed by purpose
 */
export function buildPersonalKeyEndpoints(req, platform = {}) {
  const baseUrl = buildPublicBaseUrl(req);
  const endpoints = {
    baseUrl,
    openaiCompatible: `${baseUrl}/api/inference/v1`,
    models: `${baseUrl}/api/inference/v1/models`,
    chatCompletions: `${baseUrl}/api/inference/v1/chat/completions`
  };

  if (platform.mcpServer?.enabled) {
    const mcpBase = platform.mcpServer.publicUrl
      ? stripTrailingSlash(platform.mcpServer.publicUrl)
      : baseUrl;
    endpoints.mcp = `${mcpBase}/mcp`;
    if (platform.mcpServer.transports?.sse?.enabled !== false) {
      endpoints.mcpSse = `${mcpBase}/mcp/sse`;
    }
  }

  if (getPersonalKeyConfig(platform).allowClientCredentials && platform.oauth?.enabled?.authz) {
    endpoints.token = `${baseUrl}/api/oauth/token`;
  }

  return endpoints;
}

/**
 * Project a stored client onto the shape the integrations page renders. Secrets
 * are never part of it - they exist only in the response that created them.
 *
 * @param {Object} client - Stored OAuth client
 * @returns {Object} Safe representation of a personal key
 */
export function toPublicPersonalKey(client) {
  return {
    id: client.clientId,
    name: client.name,
    description: client.description || '',
    scopes: client.scopes || [],
    active: client.active !== false,
    createdAt: client.createdAt || null,
    lastUsed: client.lastUsed || null,
    lastRotated: client.lastRotated || null,
    expiresAt: client.metadata?.apiKeyExpiresAt || null
  };
}

/**
 * List the personal keys owned by a user.
 *
 * @param {Object} user - Authenticated user
 * @param {Object} platform - Platform configuration
 * @returns {Array<Object>} The user's keys, newest first
 */
export function listPersonalKeys(user, platform = {}) {
  return listPersonalClientsByOwner(resolveClientsFilePath(platform), user.id).map(
    toPublicPersonalKey
  );
}

/**
 * Create a personal key for a user.
 *
 * @param {Object} params - Creation parameters
 * @param {Object} params.user - Authenticated owner
 * @param {Object} params.platform - Platform configuration
 * @param {string} [params.name] - User-supplied label
 * @param {number} [params.expirationDays] - Requested lifetime in days
 * @returns {Promise<Object>} The new key plus its one-time secrets
 * @throws {PersonalKeyError} When the request violates the administrator's policy
 */
export async function createPersonalKey({ user, platform = {}, name, expirationDays }) {
  return withOwnerLock(user.id, () =>
    createPersonalKeyExclusively({ user, platform, name, expirationDays })
  );
}

async function createPersonalKeyExclusively({ user, platform, name, expirationDays }) {
  const config = getPersonalKeyConfig(platform);
  const clientsFilePath = resolveClientsFilePath(platform);

  const existing = listPersonalClientsByOwner(clientsFilePath, user.id);
  if (existing.length >= config.maxKeysPerUser) {
    throw new PersonalKeyError(
      `You already have the maximum of ${config.maxKeysPerUser} API keys. Revoke one to create another.`,
      409
    );
  }

  const keyName = sanitizeKeyName(name) || defaultKeyName(user, existing.length);
  const lifetimeDays = resolveExpirationDays(expirationDays, config);

  const client = await createOAuthClient(
    {
      name: keyName,
      description: `Personal API key for ${user.name || user.username || user.id}`,
      scopes: config.scopes,
      // No app/model/prompt allow-list: a personal key is bounded by its
      // owner's group permissions, which are applied on every request.
      allowedApps: [],
      allowedModels: [],
      allowedPrompts: [],
      tokenExpirationMinutes: platform.oauth?.defaultTokenExpirationMinutes || 60,
      clientType: 'confidential',
      grantTypes: config.allowClientCredentials ? ['client_credentials'] : [],
      redirectUris: [],
      consentRequired: false,
      personal: true,
      ownerUserId: user.id,
      ownerUsername: user.username || user.id,
      ownerName: user.name || user.username || user.id,
      ownerEmail: user.email || '',
      ownerGroups: Array.isArray(user.groups) ? user.groups : [],
      metadata: { source: 'personal-api-key' }
    },
    clientsFilePath,
    user.id
  );

  const apiKey = await issueApiKey(client, lifetimeDays, clientsFilePath, config);

  logger.info('Personal API key created', {
    component: 'PersonalApiKeyManager',
    clientId: client.clientId,
    ownerUserId: user.id,
    expirationDays: lifetimeDays
  });

  return {
    key: { ...toPublicPersonalKey(client), expiresAt: apiKey.expires_at },
    secrets: buildSecrets(client, apiKey, config)
  };
}

/**
 * Rotate a personal key: a fresh API key and, when client credentials are
 * offered, a fresh client secret. Any credential issued earlier stops working.
 *
 * @param {Object} params - Rotation parameters
 * @param {Object} params.user - Authenticated owner
 * @param {Object} params.platform - Platform configuration
 * @param {string} params.keyId - Client ID of the key to rotate
 * @param {number} [params.expirationDays] - Requested lifetime in days
 * @returns {Promise<Object>} The rotated key plus its one-time secrets
 * @throws {PersonalKeyError} When the key does not exist or is not the user's
 */
export async function rotatePersonalKey({ user, platform = {}, keyId, expirationDays }) {
  const config = getPersonalKeyConfig(platform);
  const clientsFilePath = resolveClientsFilePath(platform);
  requireOwnedKey(clientsFilePath, keyId, user);

  const lifetimeDays = resolveExpirationDays(expirationDays, config);

  // Refresh the owner snapshot first so the rotated credentials pick up the
  // group membership the user has right now, not the one they had at creation.
  await updatePersonalClientOwner(keyId, user, clientsFilePath);

  const { clientSecret } = await rotateClientSecret(keyId, clientsFilePath, user.id);
  const apiKey = await issueApiKey({ clientId: keyId }, lifetimeDays, clientsFilePath, config);
  const rotated = findClientById(loadOAuthClients(clientsFilePath), keyId);

  logger.info('Personal API key rotated', {
    component: 'PersonalApiKeyManager',
    clientId: keyId,
    ownerUserId: user.id,
    expirationDays: lifetimeDays
  });

  return {
    key: { ...toPublicPersonalKey(rotated), expiresAt: apiKey.expires_at },
    secrets: buildSecrets({ ...rotated, clientSecret }, apiKey, config)
  };
}

/**
 * Revoke a personal key. Deleting the backing client invalidates every token
 * ever issued for it, because jwtAuth looks the client up on each request.
 *
 * @param {Object} params - Revocation parameters
 * @param {Object} params.user - Authenticated owner
 * @param {Object} params.platform - Platform configuration
 * @param {string} params.keyId - Client ID of the key to revoke
 * @returns {Promise<void>}
 * @throws {PersonalKeyError} When the key does not exist or is not the user's
 */
export async function revokePersonalKey({ user, platform = {}, keyId }) {
  const clientsFilePath = resolveClientsFilePath(platform);
  requireOwnedKey(clientsFilePath, keyId, user);

  await deleteOAuthClient(keyId, clientsFilePath, user.id);

  logger.info('Personal API key revoked', {
    component: 'PersonalApiKeyManager',
    clientId: keyId,
    ownerUserId: user.id
  });
}

/**
 * Error carrying the HTTP status the route should answer with.
 */
export class PersonalKeyError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'PersonalKeyError';
    this.status = status;
  }
}

function resolveClientsFilePath(platform) {
  return platform.oauth?.clientsFile || 'contents/config/oauth-clients.json';
}

/**
 * Look up a key and assert it belongs to the caller. A key owned by someone
 * else is reported as missing so the endpoint never confirms its existence.
 */
function requireOwnedKey(clientsFilePath, keyId, user) {
  const client = findClientById(loadOAuthClients(clientsFilePath), keyId);

  if (!client || client.personal !== true || client.ownerUserId !== user.id) {
    throw new PersonalKeyError('API key not found', 404);
  }

  return client;
}

/**
 * Mint the key and record its generation and expiry alongside the client. The
 * store is updated before the token is signed, so the credential handed out and
 * the record that validates it can never disagree. The token stays the only
 * copy of the key itself.
 */
async function issueApiKey(client, expirationDays, clientsFilePath, config) {
  const clientsConfig = loadOAuthClients(clientsFilePath);

  // The key id reaches here from the request path, so look it up as an own
  // property: a plain index would resolve `__proto__` to Object.prototype and
  // the writes below would pollute it. Same guard the rest of the client store
  // uses.
  const stored = Object.hasOwn(clientsConfig.clients || {}, client.clientId)
    ? clientsConfig.clients[client.clientId]
    : undefined;

  if (!stored) {
    throw new PersonalKeyError('API key not found', 404);
  }

  // Every issue is a new generation, which is what invalidates the credentials
  // issued for the previous one.
  const keyGeneration = personalKeyGeneration(stored) + 1;

  // Reconcile the grant list with the policy in force now. Without this, a key
  // created while client credentials were disallowed would keep an empty grant
  // list, and rotating it would show a client secret the token endpoint always
  // rejects.
  stored.grantTypes = config.allowClientCredentials ? ['client_credentials'] : [];
  stored.metadata = { ...(stored.metadata || {}), keyGeneration };

  const apiKey = generatePersonalApiKey(stored, expirationDays);

  stored.metadata.apiKeyExpiresAt = apiKey.expires_at;
  await saveOAuthClients(clientsConfig, clientsFilePath);

  return apiKey;
}

/**
 * Serialize work per owner.
 *
 * Counting a user's keys and inserting a new one are two separate store
 * operations, so two requests arriving together could both find room under
 * `maxKeysPerUser`. Chaining per owner keeps the check and the insert from
 * interleaving. Across cluster workers the client store remains last-write-wins,
 * as it is for every other write to it.
 */
const ownerLocks = new Map();

function withOwnerLock(ownerUserId, task) {
  const previous = ownerLocks.get(ownerUserId) || Promise.resolve();

  // Run regardless of how the previous task settled, but keep its rejection out
  // of the chain so one failure does not reject every request queued behind it.
  const result = previous.then(task, task);
  const settled = result.then(
    () => {},
    () => {}
  );

  ownerLocks.set(ownerUserId, settled);
  settled.then(() => {
    if (ownerLocks.get(ownerUserId) === settled) {
      ownerLocks.delete(ownerUserId);
    }
  });

  return result;
}

function buildSecrets(client, apiKey, config) {
  const secrets = {
    apiKey: apiKey.api_key,
    expiresAt: apiKey.expires_at,
    scope: apiKey.scope
  };

  if (config.allowClientCredentials) {
    secrets.clientId = client.clientId;
    secrets.clientSecret = client.clientSecret;
  }

  return secrets;
}

function resolveExpirationDays(requested, config) {
  if (requested === undefined || requested === null || requested === '') {
    return config.defaultExpirationDays;
  }

  const days = Number(requested);
  if (!Number.isInteger(days) || days < 1) {
    throw new PersonalKeyError('Expiration must be a whole number of days', 400);
  }

  if (days > config.maxExpirationDays) {
    throw new PersonalKeyError(`Expiration must not exceed ${config.maxExpirationDays} days`, 400);
  }

  return days;
}

/**
 * Control characters would corrupt log lines and make the generated client ID
 * unreadable, so strip them rather than rejecting the whole request.
 */
function sanitizeKeyName(name) {
  if (typeof name !== 'string') return null;

  const cleaned = name.replace(/[\u0000-\u001F\u007F]/g, '').trim();
  return cleaned ? cleaned.slice(0, MAX_KEY_NAME_LENGTH) : null;
}

function defaultKeyName(user, existingCount) {
  const suffix = existingCount > 0 ? ` API key ${existingCount + 1}` : ' API key';

  // The client ID is derived from the name and has to stay a valid path segment,
  // so a long user name is trimmed rather than the suffix that makes the name
  // readable.
  const owner = String(user.username || user.name || user.id).slice(
    0,
    Math.max(1, MAX_KEY_NAME_LENGTH - suffix.length)
  );

  return `${owner}${suffix}`;
}

function clampNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.round(parsed), min), max);
}

function toStringArray(value) {
  if (!Array.isArray(value)) return null;
  const filtered = value.filter(entry => typeof entry === 'string' && entry.trim());
  return filtered.length > 0 ? filtered : null;
}

function stripTrailingSlash(value) {
  return String(value).replace(/\/+$/, '');
}
