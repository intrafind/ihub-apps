/**
 * Which users.json record a session token stands for, and whether it is still
 * usable.
 *
 * A token is signed, so it stays valid after the user behind it is deleted or
 * disabled. Every place that accepts one has to ask the user store, and has to
 * ask it the same way: this is where the answer is worked out, so `jwtAuth`,
 * the MCP gateway, the WebSocket upgrade and the OAuth authorize routes cannot
 * drift apart.
 *
 * @module utils/tokenUser
 */
import { loadUsers, loadUsersFresh, isUserActive } from './userManager.js';
import { localUsersFile } from './contentsPath.js';

/**
 * Tokens that stand for a person with a record in users.json. Anything else
 * (client credentials, personal API keys, tokens of an unknown kind) has no
 * record to look up here.
 */
const USER_BOUND_MODES = new Set([
  'local',
  'oidc',
  'ldap',
  'teams',
  'ntlm',
  'oauth_authorization_code'
]);

/** The auth method whose provider subject a token of this mode may carry. */
const PROVIDER_MODES = new Set(['oidc', 'ldap', 'teams', 'ntlm']);

/**
 * Whether tokens of this auth mode stand for a user in users.json.
 *
 * @param {string|undefined} authMode - The token's `authMode` claim
 * @returns {boolean}
 */
export function isUserBoundMode(authMode) {
  return USER_BOUND_MODES.has(authMode);
}

/**
 * The subject a token of this mode carries, as the sign-in that minted it put it
 * there. The claim differs by provider, so it is chosen here once.
 *
 * @param {Object} claims - Decoded token payload
 * @returns {string|undefined}
 */
export function tokenSubject(claims) {
  switch (claims.authMode) {
    case 'teams':
    case 'ntlm':
      return claims.id || claims.sub;
    case 'oidc':
    case 'ldap':
      return claims.sub || claims.username;
    default:
      return claims.sub || claims.username || claims.id;
  }
}

/**
 * The record for a subject: by id (users.json is keyed by it), and for a
 * provider sign-in then by the identity provider's own subject for that user
 * (`oidcData.subject`, ...), which is what tokens minted before the persisted id
 * became the subject carry.
 *
 * Never by email or login name. They name a person, not an account: matching on
 * them lets the token of a deleted account ride on a later account for the same
 * address, and the request would still be authenticated as the deleted account,
 * because `req.user` is built from the token's claims, not from the record.
 *
 * @param {Object} usersConfig - Users configuration
 * @param {string|undefined} userId - The subject the token carries
 * @param {string[]} providerModes - Providers whose subject the id may be (none for a local id)
 * @returns {Object|undefined} The user record, if there is one
 */
function findRecord(usersConfig, userId, providerModes) {
  if (!userId) return undefined;
  const users = usersConfig.users || {};
  if (Object.hasOwn(users, userId)) return users[userId];
  return Object.values(users).find(u =>
    providerModes.some(
      mode => u.authMethods?.includes(mode) && u[`${mode}Data`]?.subject === userId
    )
  );
}

/**
 * Resolve the user a token stands for.
 *
 * The cached users are asked first; only a miss pays for a re-read from the
 * store, because another cluster worker may have persisted the user a moment
 * ago (see {@link loadUsersFresh}). A record that is still missing after that is
 * genuinely gone.
 *
 * `loadUsers()` never throws: an unreadable file comes back as an empty
 * structure carrying `metadata.error`. Read as "no users", that would sign out
 * every user of the instance, so it is raised here and callers answer 503.
 *
 * @param {Object} platform - Platform configuration
 * @param {Object} claims - Decoded token payload
 * @returns {Promise<{userId: string|undefined, record: Object|undefined}|null>}
 *   null for a token that does not stand for a user; otherwise the subject and
 *   its record (undefined when the user is gone)
 * @throws {Error} When the users configuration cannot be read
 */
export async function resolveTokenUser(platform, claims) {
  if (!isUserBoundMode(claims?.authMode)) return null;

  const userId = tokenSubject(claims);
  const providerModes = PROVIDER_MODES.has(claims.authMode) ? [claims.authMode] : [];
  return { userId, record: await lookupUserRecord(platform, userId, providerModes) };
}

/**
 * The record for a user id, cached users first and a fresh read on a miss.
 *
 * @param {Object} platform - Platform configuration
 * @param {string|undefined} userId - The subject or owner id
 * @param {string[]} providerModes - Providers whose subject the id may be
 * @returns {Promise<Object|undefined>} The record, undefined when the user is gone
 * @throws {Error} When the users configuration cannot be read
 */
async function lookupUserRecord(platform, userId, providerModes) {
  const usersFilePath = localUsersFile(platform?.localAuth);

  let usersConfig = loadUsers(usersFilePath);
  let record = findRecord(usersConfig, userId, providerModes);

  if (!record && !usersConfig.metadata?.error) {
    usersConfig = await loadUsersFresh(usersFilePath);
    record = findRecord(usersConfig, userId, providerModes);
  }

  if (!record && usersConfig.metadata?.error) {
    throw new Error(`Users configuration unavailable: ${usersConfig.metadata.error}`);
  }

  return record;
}

/**
 * What a resolved record means for the request.
 *
 * @param {Object|undefined} record - The record from {@link resolveTokenUser}
 * @returns {'active'|'missing'|'disabled'}
 */
export function userRecordState(record) {
  if (!record) return 'missing';
  return isUserActive(record) ? 'active' : 'disabled';
}

/**
 * Whether the user a session token stands for may still use it. A token that
 * does not stand for a user (see {@link isUserBoundMode}) is not this module's
 * to refuse and counts as usable.
 *
 * @param {Object} platform - Platform configuration
 * @param {Object} claims - Decoded token payload
 * @returns {Promise<'active'|'missing'|'disabled'>}
 * @throws {Error} When the users configuration cannot be read
 */
export async function tokenUserState(platform, claims) {
  const resolved = await resolveTokenUser(platform, claims);
  if (!resolved) return 'active';
  return userRecordState(resolved.record);
}

/**
 * Whether the user who owns a personal API key may still act through it.
 *
 * A personal key authenticates from its client record, not from a token that
 * names the user, so the owner is checked here from the id the record carries.
 * The key is the owner's credential: it ends with the owner, and is suspended
 * while the owner is.
 *
 * @param {Object} platform - Platform configuration
 * @param {string} ownerUserId - The owner id on the key's client record
 * @returns {Promise<'active'|'missing'|'disabled'>}
 * @throws {Error} When the users configuration cannot be read
 */
export async function ownerUserState(platform, ownerUserId) {
  const record = await lookupUserRecord(platform, ownerUserId, [...PROVIDER_MODES]);
  return userRecordState(record);
}
