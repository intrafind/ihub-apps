// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import fs from 'node:fs';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { atomicWriteJSON } from './atomicWrite.js';
import { withFileLock } from './fileLock.js';
import configStore from '../services/config/ConfigStore.js';
import configCache from '../configCache.js';
import { announceConfigChange } from '../configSync.js';
import { mapExternalGroups } from './authorization.js';
import logger from './logger.js';
import { ensureFirstUserIsAdmin } from './adminRescue.js';
import { locateConfigFile } from './configFileLocation.js';
import { localUsersFile } from './contentsPath.js';
import { AccountDisabledError } from './accountDisabledError.js';

/**
 * Where the users file lives — see {@link locateConfigFile}, which both this
 * module and `oauthClientManager` share so the read path and the write path
 * cannot drift apart.
 *
 * @param {string} usersFilePath - Path to users.json as configured
 * @returns {{fullPath: string, cacheKey: string, relPath: string|null}}
 */
function locateUsersFile(usersFilePath) {
  return locateConfigFile(usersFilePath);
}

/**
 * Hash password with user ID as salt for unique hashes
 * @param {string} password - Plain text password
 * @param {string} userId - User ID to use as salt
 * @returns {Promise<string>} Hashed password
 */
export async function hashPasswordWithUserId(password, userId) {
  const salt = await bcrypt.genSalt(12);
  const passwordWithUserId = `${userId}:${password}`;
  return await bcrypt.hash(passwordWithUserId, salt);
}

/**
 * Load users from the local users file
 * @param {string} usersFilePath - Path to users.json file
 * @returns {Object} Users configuration
 */
export function loadUsers(usersFilePath) {
  try {
    // Through `locateUsersFile` so the read and the write derive the same cache
    // key from the same path. They agreed when this was written twice; two
    // copies of a rule with four branches is a coin toss on whether they still
    // will, and a disagreement here is a permanent cache miss that only shows
    // up as a warning nobody reads.
    const { fullPath, cacheKey } = locateUsersFile(usersFilePath);

    // Try to get from cache first
    const cached = configCache.get(cacheKey);
    if (cached && cached.data && cached.data.users) {
      return cached.data;
    }

    // Fallback to file system if cache miss or invalid data
    logger.warn('Users configuration not found in cache, attempting file system fallback', {
      component: 'Utils',
      cacheKey
    });

    // Check if file exists
    if (!fs.existsSync(fullPath)) {
      logger.warn('Users file not found, creating empty structure', {
        component: 'Utils',
        fullPath
      });
      const emptyConfig = {
        users: {},
        metadata: { version: '2.0.0', lastUpdated: new Date().toISOString() }
      };

      // Cache the empty structure to prevent repeated file system access
      configCache.setCacheEntry(cacheKey, emptyConfig);
      return emptyConfig;
    }

    // Read from file system
    const fileData = fs.readFileSync(fullPath, 'utf8');
    const usersConfig = JSON.parse(fileData);

    // Validate the loaded data
    if (!usersConfig || typeof usersConfig !== 'object') {
      throw new Error('Invalid users configuration format');
    }

    // Ensure users object exists
    if (!usersConfig.users || typeof usersConfig.users !== 'object') {
      usersConfig.users = {};
    }

    // Ensure metadata exists
    if (!usersConfig.metadata) {
      usersConfig.metadata = { version: '2.0.0', lastUpdated: new Date().toISOString() };
    }

    // Update cache with file data
    configCache.setCacheEntry(cacheKey, usersConfig);

    return usersConfig;
  } catch (error) {
    logger.error('Could not load users configuration', { component: 'Utils', error });

    // Return safe empty structure as last resort
    const safeConfig = {
      users: {},
      metadata: { version: '2.0.0', lastUpdated: new Date().toISOString(), error: error.message }
    };

    logger.warn('Returning safe empty users structure due to error', { component: 'Utils' });
    return safeConfig;
  }
}

/** In-flight re-reads of a users file, by cache key, so a burst shares one. */
const freshReads = new Map();

/** Whether a parsed users.json body has the shape `loadUsers` accepts. */
function isUsersConfig(data) {
  return (
    typeof data === 'object' &&
    data !== null &&
    typeof data.users === 'object' &&
    data.users !== null
  );
}

/**
 * Read a users file from where it lives: the configuration store for a file
 * under contents/, the file system for one outside it (see locateConfigFile).
 * Throws when the file exists but cannot be read or parsed.
 */
async function readUsersFileFresh({ fullPath, relPath }) {
  if (relPath) return await configStore.readJsonStrict(relPath);
  if (!fs.existsSync(fullPath)) return null;
  return JSON.parse(fs.readFileSync(fullPath, 'utf8'));
}

/**
 * Load users straight from the store, bypassing (and refreshing) the cached
 * copy.
 *
 * Cluster workers each cache this file and hear about another worker's write
 * over the config sync bus, which takes a few milliseconds. An external user
 * is persisted by the worker that completes their sign-in, and their very next
 * request — the redirect back into the app — is routinely served by another
 * worker inside that window. A lookup that is about to conclude "this user
 * does not exist" calls this once first.
 *
 * Unlike {@link loadUsers} this throws when the store cannot be read, rather
 * than handing back an empty structure: a caller that is about to treat a miss
 * as a deleted account has to be able to tell "no such user" from "could not
 * look".
 *
 * @param {string} usersFilePath - Path to users.json file
 * @returns {Promise<Object>} Users configuration
 * @throws {Error} When the users file exists but cannot be read or parsed
 */
export async function loadUsersFresh(usersFilePath) {
  const location = locateUsersFile(usersFilePath);
  const { cacheKey } = location;
  let pending = freshReads.get(cacheKey);
  if (!pending) {
    pending = readUsersFileFresh(location)
      .then(data => {
        if (isUsersConfig(data)) configCache.setCacheEntry(cacheKey, data);
      })
      .finally(() => freshReads.delete(cacheKey));
    freshReads.set(cacheKey, pending);
  }
  await pending;
  return loadUsers(usersFilePath);
}

/**
 * Save users to the local users file
 * @param {Object} usersConfig - Users configuration object
 * @param {string} usersFilePath - Path to users.json file
 */
export async function saveUsers(usersConfig, usersFilePath) {
  try {
    const { fullPath, cacheKey, relPath } = locateUsersFile(usersFilePath);

    // Update metadata
    if (!usersConfig.metadata) {
      usersConfig.metadata = { version: '2.0.0' };
    }
    usersConfig.metadata.lastUpdated = new Date().toISOString();

    // Write to file atomically. The store writes what it is handed, so the
    // password hashes in here are stored exactly as this module produced them.
    if (relPath) {
      await configStore.writeJson(relPath, usersConfig);
    } else {
      await atomicWriteJSON(fullPath, usersConfig);
    }

    configCache.setCacheEntry(cacheKey, usersConfig);

    // Tell the other workers to re-read the file. Without this a user created or
    // updated on one worker stays invisible to the rest until their TTL fires,
    // and since every save rewrites the whole file from that worker's snapshot,
    // a stale worker's next write would silently drop the change. This fires on
    // each external login (`createOrUpdateExternalUser` always touches
    // lastActiveDate), which is a login-rate broadcast of a small file — worth
    // it for a config that decides authorization.
    announceConfigChange(cacheKey);
  } catch (error) {
    logger.error('Could not save users configuration', {
      component: 'Utils',
      error
    });
    throw error;
  }
}

/**
 * Change users.json under the store's compare-and-set, so many people
 * acknowledging at once (a rollout) do not overwrite each other the way a
 * `loadUsers` + `saveUsers` rewrite of the whole file would. A users file
 * outside `contents/` is rewritten from a fresh read instead.
 *
 * `change` runs again on the newer body when another worker wrote first, so it
 * must derive everything from the body it is handed. Returning `false` writes
 * nothing.
 *
 * @param {string} usersFilePath - Path to users.json as configured
 * @param {(usersConfig: Object) => (boolean|void)} change
 * @returns {Promise<boolean>} Whether the file was written
 */
async function updateUsersFile(usersFilePath, change) {
  const { fullPath, cacheKey, relPath } = locateUsersFile(usersFilePath);
  const apply = current => {
    const usersConfig = current && typeof current === 'object' ? current : {};
    if (!usersConfig.users || typeof usersConfig.users !== 'object') usersConfig.users = {};
    if (!usersConfig.metadata) usersConfig.metadata = { version: '2.0.0' };
    if (change(usersConfig) === false) return undefined;
    usersConfig.metadata.lastUpdated = new Date().toISOString();
    return usersConfig;
  };

  if (!relPath) {
    // A file outside contents/ has no compare-and-set: the read, the change and the
    // write run under a lock file, so two confirmations at once both land.
    return await withFileLock(
      `${fullPath}.lock`,
      async () => {
        const usersConfig = await loadUsersFresh(usersFilePath);
        if (change(usersConfig) === false) return false;
        await saveUsers(usersConfig, usersFilePath);
        return true;
      },
      { component: 'UserManager' }
    );
  }

  const { data, written } = await configStore.updateJson(relPath, apply);
  if (data && typeof data === 'object' && data.users && typeof data.users === 'object') {
    configCache.setCacheEntry(cacheKey, data);
  }
  if (written) announceConfigChange(cacheKey);
  return written;
}

/**
 * Record an AI-use acknowledgement on a user (#3326). One entry per version: a
 * repeat at a version the user already confirmed changes nothing.
 *
 * @param {string} userId - Key in users.json
 * @param {{version: number, textHash: string, acknowledgedAt: string, language?: string}} entry
 * @param {string} usersFilePath - Path to users.json
 * @returns {Promise<{recorded: boolean, entry: Object|null}>} `recorded` is
 *   false when the version was already there; `entry` is null for an unknown user
 */
export async function recordAiAcknowledgement(userId, entry, usersFilePath) {
  let result = { recorded: false, entry: null };
  await updateUsersFile(usersFilePath, usersConfig => {
    result = { recorded: false, entry: null };
    if (!Object.hasOwn(usersConfig.users, userId)) return false;
    const user = usersConfig.users[userId];
    const existing = Array.isArray(user.aiAcknowledgements) ? user.aiAcknowledgements : [];
    const same = existing.find(item => item?.version === entry.version);
    if (same) {
      result = { recorded: false, entry: same };
      return false;
    }
    user.aiAcknowledgements = [...existing, entry];
    result = { recorded: true, entry };
    return true;
  });
  return result;
}

/**
 * Remove the AI-use acknowledgements of one user, or of every user.
 *
 * @param {string|null} userId - Key in users.json, or null for every user
 * @param {string} usersFilePath - Path to users.json
 * @returns {Promise<{users: number, entries: number, found: boolean}>} How many
 *   users lost entries and how many entries went; `found` is false for an
 *   unknown `userId`
 */
export async function clearAiAcknowledgements(userId, usersFilePath) {
  let result = { users: 0, entries: 0, found: true };
  await updateUsersFile(usersFilePath, usersConfig => {
    result = { users: 0, entries: 0, found: true };
    const ids = userId === null ? Object.keys(usersConfig.users) : [userId];
    if (userId !== null && !Object.hasOwn(usersConfig.users, userId)) {
      result.found = false;
      return false;
    }
    for (const id of ids) {
      const user = usersConfig.users[id];
      if (!user || !Array.isArray(user.aiAcknowledgements)) continue;
      if (user.aiAcknowledgements.length > 0) {
        result.users += 1;
        result.entries += user.aiAcknowledgements.length;
      }
      delete user.aiAcknowledgements;
    }
    return result.entries > 0 ? true : false;
  });
  return result;
}

/**
 * Case-insensitively compare two identifier strings (username/email).
 * Login-facing identifiers must not be treated as distinct just because
 * they differ in case (e.g. "Daniel.Manzke" vs "daniel.manzke").
 * @param {string} a
 * @param {string} b
 * @returns {boolean} True if both are strings and equal ignoring case
 */
export function equalsIgnoreCase(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

/**
 * Find user by various identifiers (username, email, oidcSubject)
 * @param {Object} usersConfig - Users configuration
 * @param {string} identifier - Username, email, or OIDC subject ID
 * @param {string} authMethod - Authentication method ('local', 'oidc', 'proxy', 'ldap', 'ntlm')
 * @returns {Object|null} User object or null if not found
 */
export function findUserByIdentifier(usersConfig, identifier, authMethod = null) {
  const users = usersConfig.users || {};

  for (const userId in users) {
    const user = users[userId];

    // Check if user has the specified auth method (if provided)
    if (authMethod && user.authMethods && !user.authMethods.includes(authMethod)) {
      continue;
    }

    // Match by username, email (both case-insensitive), or auth-specific subject
    // (provider subject IDs are opaque and compared exactly)
    if (
      equalsIgnoreCase(user.username, identifier) ||
      (identifier && equalsIgnoreCase(user.email, identifier)) ||
      (user.oidcData && user.oidcData.subject === identifier) ||
      (user.proxyData && user.proxyData.subject === identifier) ||
      (user.teamsData && user.teamsData.subject === identifier) ||
      (user.ntlmData && user.ntlmData.subject === identifier) ||
      (user.ldapData && user.ldapData.subject === identifier)
    ) {
      return { ...user, id: userId };
    }
  }

  return null;
}

/**
 * Look up a **local** user by the subject a JWT carries.
 *
 * `sub` is the user's key in `users.json`, so this is a direct lookup rather
 * than the identifier scan {@link findUserByIdentifier} performs. It returns
 * null for a user who is not local, which is the point: group membership for
 * an OIDC or proxy user lives in the identity provider and arrives at sign-in,
 * so there is nothing authoritative here to re-read for them.
 *
 * @param {string} userId - The `sub` claim / user key
 * @param {string} usersFilePath - Path to users.json
 * @returns {Object|null} The local user, or null
 */
export function findLocalUserById(userId, usersFilePath) {
  if (!userId || userId === '__proto__' || userId === 'constructor' || userId === 'prototype') {
    return null;
  }

  const usersConfig = loadUsers(usersFilePath);
  const users = usersConfig.users || {};
  if (!Object.hasOwn(users, userId)) return null;

  const user = users[userId];
  const methods = Array.isArray(user?.authMethods) ? user.authMethods : [];
  if (!methods.includes('local')) return null;

  return { ...user, id: userId };
}

/**
 * Create or update external user (OIDC/Proxy) in users.json
 * @param {Object} externalUser - External user data
 * @param {string} usersFilePath - Path to users.json file
 * @returns {Object} Created/updated user object
 */
export async function createOrUpdateExternalUser(externalUser, usersFilePath) {
  const usersConfig = loadUsers(usersFilePath);

  // Determine auth method based on provider
  const authMethod =
    externalUser.authMethod === 'ldap'
      ? 'ldap'
      : externalUser.authMethod === 'ntlm' || externalUser.provider === 'ntlm'
        ? 'ntlm'
        : externalUser.provider === 'proxy'
          ? 'proxy'
          : externalUser.provider === 'teams'
            ? 'teams'
            : 'oidc';

  // Try to find existing user by email or external subject
  let existingUser =
    findUserByIdentifier(usersConfig, externalUser.email, authMethod) ||
    findUserByIdentifier(usersConfig, externalUser.id, authMethod);

  const now = new Date().toISOString();
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format

  if (existingUser) {
    // Update existing user
    const userId = existingUser.id;
    const user = usersConfig.users[userId];

    // Ensure authMethods includes the current auth method
    if (!user.authMethods) {
      user.authMethods = [authMethod];
    } else if (!user.authMethods.includes(authMethod)) {
      user.authMethods.push(authMethod);
    }

    // Update external auth data based on auth method
    if (authMethod === 'oidc') {
      user.oidcData = {
        subject: externalUser.id,
        provider: externalUser.provider,
        lastProvider: externalUser.provider,
        ...user.oidcData
      };
    } else if (authMethod === 'proxy') {
      user.proxyData = {
        subject: externalUser.id,
        provider: externalUser.provider,
        lastProvider: externalUser.provider,
        ...user.proxyData
      };
    } else if (authMethod === 'teams') {
      user.teamsData = {
        subject: externalUser.id,
        provider: externalUser.provider,
        lastProvider: externalUser.provider,
        tenantId: externalUser.teamsData?.tenantId,
        upn: externalUser.teamsData?.upn,
        ...user.teamsData
      };
    } else if (authMethod === 'ntlm') {
      user.ntlmData = {
        subject: externalUser.id,
        provider: externalUser.provider,
        lastProvider: externalUser.provider,
        domain: externalUser.domain,
        workstation: externalUser.workstation,
        ...user.ntlmData
      };
    } else if (authMethod === 'ldap') {
      user.ldapData = {
        subject: externalUser.id,
        provider: externalUser.provider,
        lastProvider: externalUser.provider,
        username: externalUser.ldapData?.username,
        ...user.ldapData
      };
    }

    // Update basic info from external provider
    user.name = externalUser.name || user.name;
    user.email = externalUser.email || user.email;
    // Heal the login name. Records created before the directory login name was
    // persisted carry the email here (see the create branch below), and nothing
    // used to write it again, so the wrong value survived every later login.
    // The directory owns this field for an external user, so take its value
    // whenever the provider supplies one.
    user.username = externalUser.username || user.username;

    // Store internal groups - groups manually assigned to users in the admin interface
    // External groups from auth providers are handled at runtime, not persisted
    if (!user.internalGroups) {
      user.internalGroups = [];
    }

    // Update activity tracking
    user.lastActiveDate = today;
    user.updatedAt = now;

    await saveUsers(usersConfig, usersFilePath);
    return { ...user, id: userId };
  } else {
    // Create new user
    const userId = `user_${uuidv4().replaceAll('-', '_')}`;

    const newUser = {
      id: userId,
      // The directory login name first (sAMAccountName for LDAP/AD, the Windows
      // account for NTLM). Email is not a login name — it is only the next-best
      // identifier for providers that supply no username at all (proxy, Teams),
      // which is why it stays in the chain rather than being dropped.
      username: externalUser.username || externalUser.email || externalUser.id,
      email: externalUser.email || null,
      name: externalUser.name || externalUser.id,
      internalGroups: [], // Only store internal/manual groups, not external groups
      active: true,
      authMethods: [authMethod],
      lastActiveDate: today,
      createdAt: now,
      updatedAt: now
    };

    // Add auth-specific data based on auth method
    if (authMethod === 'oidc') {
      newUser.oidcData = {
        subject: externalUser.id,
        provider: externalUser.provider,
        lastProvider: externalUser.provider
      };
    } else if (authMethod === 'proxy') {
      newUser.proxyData = {
        subject: externalUser.id,
        provider: externalUser.provider,
        lastProvider: externalUser.provider
      };
    } else if (authMethod === 'teams') {
      newUser.teamsData = {
        subject: externalUser.id,
        provider: externalUser.provider,
        lastProvider: externalUser.provider,
        tenantId: externalUser.teamsData?.tenantId,
        upn: externalUser.teamsData?.upn
      };
    } else if (authMethod === 'ntlm') {
      newUser.ntlmData = {
        subject: externalUser.id,
        provider: externalUser.provider,
        lastProvider: externalUser.provider,
        domain: externalUser.domain,
        workstation: externalUser.workstation
      };
    } else if (authMethod === 'ldap') {
      newUser.ldapData = {
        subject: externalUser.id,
        provider: externalUser.provider,
        lastProvider: externalUser.provider,
        username: externalUser.ldapData?.username
      };
    }

    usersConfig.users[userId] = newUser;
    await saveUsers(usersConfig, usersFilePath);
    return newUser;
  }
}

/**
 * Update user's last active date if it's a new day
 * @param {string} userId - User ID
 * @param {string} usersFilePath - Path to users.json file
 */
export async function updateUserActivity(userId, usersFilePath) {
  const usersConfig = loadUsers(usersFilePath);
  const user = usersConfig.users[userId];

  if (!user) {
    return;
  }

  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format

  // Only update if it's a different day
  if (user.lastActiveDate !== today) {
    user.lastActiveDate = today;
    user.updatedAt = new Date().toISOString();
    await saveUsers(usersConfig, usersFilePath);
  }
}

/**
 * Check if user is active and enabled
 * @param {Object} user - User object
 * @returns {boolean} True if user is active
 */
export function isUserActive(user) {
  return user && user.active !== false;
}

/**
 * Merge user groups from different sources
 * @param {Array} externalGroups - Groups from external auth provider (OIDC/proxy)
 * @param {Array} internalGroups - Internal groups from user config (manually assigned)
 * @returns {Array} Merged and deduplicated groups
 */
export function mergeUserGroups(externalGroups = [], internalGroups = []) {
  const allGroups = new Set();

  // Add external groups (from current auth session)
  externalGroups.forEach(group => allGroups.add(group));

  // Add internal groups (from users.json)
  internalGroups.forEach(group => allGroups.add(group));

  return Array.from(allGroups);
}

/**
 * The raw sources of an external user's groups at login, recorded on the login
 * audit entry (see utils/loginGroupDetails.js) so an admin can see which
 * groups the identity provider sent and which were assigned by hand. Never
 * persisted to users.json and never used for authorization.
 *
 * LDAP maps its groups before this point and passes the directory groups as
 * `ldapData.ldapGroups` instead of `externalGroups`.
 *
 * @param {Object} externalUser - External user data
 * @param {string[]} manualGroups - The user's `internalGroups` from users.json
 * @returns {{external: string[], manual: string[]}}
 */
function describeLoginGroupSources(externalUser, manualGroups) {
  const external = Array.isArray(externalUser.externalGroups)
    ? externalUser.externalGroups
    : Array.isArray(externalUser.ldapData?.ldapGroups)
      ? externalUser.ldapData.ldapGroups
      : [];
  return { external: [...external], manual: Array.isArray(manualGroups) ? [...manualGroups] : [] };
}

/**
 * The admin rescue may just have granted the first user an admin group in
 * `internalGroups`; keep the login's manual groups in step with it.
 *
 * @param {Object} user - The user returned by ensureFirstUserIsAdmin()
 * @returns {Object} the same user
 */
function withRescuedManualGroups(user) {
  if (user?.loginGroups && Array.isArray(user.internalGroups)) {
    user.loginGroups.manual = [...user.internalGroups];
  }
  return user;
}

/**
 * Validate and persist external user based on platform configuration
 * Consolidates the validation logic from proxyAuth.js, oidcAuth.js, ntlmAuth.js, and ldapAuth.js
 * @param {Object} externalUser - External user data (OIDC/Proxy/Teams/NTLM/LDAP)
 * @param {Object} platformConfig - Platform configuration
 * @returns {Object} Validated and persisted user object
 */
export async function validateAndPersistExternalUser(externalUser, platformConfig) {
  const authMethod =
    externalUser.authMethod === 'ldap'
      ? 'ldap'
      : externalUser.authMethod === 'ntlm' || externalUser.provider === 'ntlm'
        ? 'ntlm'
        : externalUser.authMethod === 'proxy' || externalUser.provider === 'proxy'
          ? 'proxy'
          : externalUser.provider === 'teams'
            ? 'teams'
            : 'oidc';

  // Get the appropriate auth config based on auth method
  let authConfig;
  if (authMethod === 'ldap') {
    authConfig = platformConfig.ldapAuth || {};
  } else if (authMethod === 'proxy') {
    authConfig = platformConfig.proxyAuth || {};
  } else if (authMethod === 'teams') {
    authConfig = platformConfig.teamsAuth || {};
  } else if (authMethod === 'ntlm') {
    authConfig = platformConfig.ntlmAuth || {};
  } else {
    authConfig = platformConfig.oidcAuth || {};
  }

  const usersFilePath = localUsersFile(platformConfig.localAuth);

  // Check if user exists in users.json
  const usersConfig = loadUsers(usersFilePath);
  const existingUser =
    findUserByIdentifier(usersConfig, externalUser.email, authMethod) ||
    findUserByIdentifier(usersConfig, externalUser.id, authMethod);

  // If user exists, check if they are active
  if (existingUser) {
    if (!isUserActive(existingUser)) {
      throw new AccountDisabledError(existingUser);
    }

    // Update existing user and merge groups
    const persistedUser = await createOrUpdateExternalUser(externalUser, usersFilePath);

    // Update activity tracking
    await updateUserActivity(persistedUser.id, usersFilePath);

    // Merge groups: external groups (from auth provider) + internal groups (from users.json)
    // Only call mapExternalGroups when raw external groups were actually supplied. Some
    // auth providers (e.g. LDAP) pre-map their groups before reaching this point and
    // intentionally omit externalGroups; calling mapExternalGroups([]) would otherwise
    // taint the result with the anonymous fallback.
    const mappedExternalGroups =
      Array.isArray(externalUser.externalGroups) && externalUser.externalGroups.length > 0
        ? mapExternalGroups(externalUser.externalGroups)
        : [];

    // Include automatic internal groups (authenticated, provider defaults) + manual internal groups
    const automaticInternalGroups = externalUser.groups || []; // These include authenticated, provider defaults
    const manualInternalGroups = persistedUser.internalGroups || []; // Manual groups from users.json

    // Merge all three: mapped external + automatic internal + manual internal
    const allGroups = new Set();
    mappedExternalGroups.forEach(group => allGroups.add(group));
    automaticInternalGroups.forEach(group => allGroups.add(group));
    manualInternalGroups.forEach(group => allGroups.add(group));

    const mergedGroups = Array.from(allGroups);

    // Admin rescue: Ensure first user gets admin rights if no admin exists
    let userWithAdminCheck = {
      ...externalUser,
      id: persistedUser.id,
      groups: mergedGroups,
      active: persistedUser.active,
      authMethods: persistedUser.authMethods || [authMethod],
      lastActiveDate: persistedUser.lastActiveDate,
      persistedUser: true,
      loginGroups: describeLoginGroupSources(externalUser, manualInternalGroups)
    };

    userWithAdminCheck = await ensureFirstUserIsAdmin(
      userWithAdminCheck,
      authMethod,
      usersFilePath
    );

    return withRescuedManualGroups(userWithAdminCheck);
  }

  // User doesn't exist - check self-signup settings
  // For NTLM and LDAP, default to allowing self-signup since users are already authenticated by domain controller/LDAP server
  const allowSelfSignup =
    authConfig.allowSelfSignup ??
    (authMethod === 'ntlm' || authMethod === 'proxy' || authMethod === 'ldap');
  if (!allowSelfSignup) {
    throw new Error(
      `New user registration is not allowed. User ID: ${externalUser.id}, Email: ${externalUser.email}. Please contact your administrator.`
    );
  }

  // Create new user (self-signup allowed)
  const persistedUser = await createOrUpdateExternalUser(externalUser, usersFilePath);

  // Combine external groups from auth provider with internal groups from users.json
  // Only call mapExternalGroups when raw external groups were actually supplied. Some
  // auth providers (e.g. LDAP) pre-map their groups before reaching this point and
  // intentionally omit externalGroups; calling mapExternalGroups([]) would otherwise
  // taint the result with the anonymous fallback.
  const mappedExternalGroups =
    Array.isArray(externalUser.externalGroups) && externalUser.externalGroups.length > 0
      ? mapExternalGroups(externalUser.externalGroups)
      : [];

  // Include automatic internal groups (authenticated, provider defaults) + manual internal groups
  const automaticInternalGroups = externalUser.groups || []; // These include authenticated, provider defaults
  const manualInternalGroups = persistedUser.internalGroups || []; // Manual groups from users.json

  // Merge all three: mapped external + automatic internal + manual internal
  const allGroups = new Set();
  mappedExternalGroups.forEach(group => allGroups.add(group));
  automaticInternalGroups.forEach(group => allGroups.add(group));
  manualInternalGroups.forEach(group => allGroups.add(group));

  const combinedGroups = Array.from(allGroups);

  // Admin rescue: Ensure first user gets admin rights if no admin exists
  let userWithAdminCheck = {
    ...externalUser,
    id: persistedUser.id,
    groups: combinedGroups,
    active: true,
    authMethods: [authMethod],
    lastActiveDate: persistedUser.lastActiveDate,
    persistedUser: true,
    loginGroups: describeLoginGroupSources(externalUser, manualInternalGroups)
  };

  userWithAdminCheck = await ensureFirstUserIsAdmin(userWithAdminCheck, authMethod, usersFilePath);

  return withRescuedManualGroups(userWithAdminCheck);
}
