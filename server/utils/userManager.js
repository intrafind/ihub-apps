// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import fs from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
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

/**
 * Per cache key: the file token (inode, mtime, size) the cached copy was read
 * at or written as, that cached object, and when. A fresh read is skipped while
 * both still match: the file did not change, and nothing else (a config-sync
 * reload, a TTL refresh) replaced the cached copy since.
 */
const knownUsersFiles = new Map();

/**
 * How long a matching token is trusted. On a shared volume the token can stay
 * the same after another host's write: NFS caches attributes for up to a
 * minute, CIFS and FUSE mounts keep a coarse mtime, and a same-size rewrite
 * within that granularity looks unchanged. Past this age the file is read
 * again whatever the token says.
 */
const TOKEN_TRUST_MS = 3_000;

/**
 * The change token of a users file, or null when it cannot be told (then the
 * caller reads). See ConfigStore.probeJson.
 */
async function probeUsersFile({ fullPath, relPath }) {
  try {
    if (relPath) return await configStore.probeJson(relPath);
    const stat = await fs.promises.stat(fullPath);
    return `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}

/** Remember which file token the cached copy of `cacheKey` belongs to. */
function rememberUsersFile(cacheKey, token) {
  const data = configCache.get(cacheKey)?.data;
  if (token && data) knownUsersFiles.set(cacheKey, { token, data, at: Date.now() });
  else knownUsersFiles.delete(cacheKey);
}

/**
 * After this worker wrote a users file: the token of what is on disk now.
 *
 * ponytail: stat'ed after the write, outside the store's lock. Another worker
 * writing in the same instant would get its token paired with this worker's
 * body; the config-sync reload of that write replaces the cached copy within
 * milliseconds and ends the mismatch. Exact would need the stat taken under
 * the lock, returned by the store's write.
 */
async function rememberOwnUsersWrite(location) {
  rememberUsersFile(location.cacheKey, await probeUsersFile(location));
}

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
 * copy. The file is stat'ed first and not read again while it is unchanged
 * since this worker's last read or write of it, for at most TOKEN_TRUST_MS.
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
    pending = (async () => {
      // Stat'ed before the read: a write in between pairs an older token with the
      // newer body, which only costs one more read next time.
      const token = await probeUsersFile(location);
      const known = knownUsersFiles.get(cacheKey);
      if (
        token &&
        known?.token === token &&
        Date.now() - known.at < TOKEN_TRUST_MS &&
        configCache.get(cacheKey)?.data === known.data
      ) {
        return;
      }
      const data = await readUsersFileFresh(location);
      if (isUsersConfig(data)) {
        configCache.setCacheEntry(cacheKey, data);
        rememberUsersFile(cacheKey, token);
      }
    })().finally(() => freshReads.delete(cacheKey));
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
    await rememberOwnUsersWrite({ fullPath, cacheKey, relPath });

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
export async function updateUsersFile(usersFilePath, change) {
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

  const { data, written, etag } = await configStore.updateJson(relPath, apply);
  if (data && typeof data === 'object' && data.users && typeof data.users === 'object') {
    // With the storage etag, the change event of this very write does not make this
    // worker reload what it just stored (the other workers still reload on the announcement).
    configCache.setCacheEntry(cacheKey, data, { storageEtag: written ? etag : null });
    // Only a write pins the cached copy to the file's token: with nothing written,
    // `data` is what updateJson read, and the token must come from a read.
    if (written) await rememberOwnUsersWrite({ fullPath, cacheKey, relPath });
  }
  if (written) announceConfigChange(cacheKey);
  return written;
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
  // Proxy auth and NTLM without a JWT land here on every request, and nearly all of
  // them change nothing: judged on the cached copy, they cost no read and no write.
  const unchanged = unchangedExternalUser(loadUsers(usersFilePath), externalUser);
  if (unchanged) return unchanged;

  // Read, change and write under the store's lock: two first logins at once, or a
  // login next to an admin edit, must not overwrite each other. The change runs
  // again on a newer body when another worker wrote first, so it keeps no state
  // from an earlier run.
  let result = null;
  await updateUsersFile(usersFilePath, usersConfig => {
    const { user, changed } = provisionExternalUser(usersConfig, externalUser);
    result = user;
    return changed;
  });
  return result;
}

/** Today as `YYYY-MM-DD` (UTC), the granularity of `lastActiveDate`. */
function today() {
  return new Date().toISOString().split('T')[0];
}

/** A record as JSON would store it: no `undefined` members, so comparisons see what a write would. */
function asStored(user) {
  return JSON.parse(JSON.stringify(user));
}

/** The auth method an external login is persisted under. */
function externalAuthMethod(externalUser) {
  return externalUser.authMethod === 'ldap'
    ? 'ldap'
    : externalUser.authMethod === 'ntlm' || externalUser.provider === 'ntlm'
      ? 'ntlm'
      : externalUser.provider === 'proxy'
        ? 'proxy'
        : externalUser.provider === 'teams'
          ? 'teams'
          : 'oidc';
}

/** The record an external login belongs to, by email or external subject. */
function findExternalUser(usersConfig, externalUser, authMethod) {
  return (
    findUserByIdentifier(usersConfig, externalUser.email, authMethod) ||
    findUserByIdentifier(usersConfig, externalUser.id, authMethod)
  );
}

/**
 * The cached record of an external login when the login would not change it:
 * same data, and already active today. Null when it has to be written (or the
 * user is new).
 *
 * @param {Object} usersConfig - Cached users configuration (not changed)
 * @param {Object} externalUser - External user data
 * @returns {Object|null} The user with its id, or null
 */
function unchangedExternalUser(usersConfig, externalUser) {
  const authMethod = externalAuthMethod(externalUser);
  const existing = findExternalUser(usersConfig, externalUser, authMethod);
  if (!existing) return null;
  const record = usersConfig.users[existing.id];
  if (!record || record.lastActiveDate !== today()) return null;
  if (applyExternalLogin(asStored(record), externalUser, authMethod)) return null;
  return { ...record, id: existing.id };
}

/**
 * Apply what an external login says about a user to their record, in place:
 * the auth method, the provider data, name, email and login name. Not the
 * activity fields.
 *
 * @param {Object} user - users.json record to change
 * @param {Object} externalUser - External user data
 * @param {string} authMethod - See externalAuthMethod
 * @returns {boolean} Whether the record changed
 */
function applyExternalLogin(user, externalUser, authMethod) {
  const before = asStored(user);

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

  return !isDeepStrictEqual(before, asStored(user));
}

/**
 * Apply an external login to a users configuration, in place.
 *
 * `updatedAt` moves only when the record's data changed; `lastActiveDate` once
 * a day.
 *
 * @param {Object} usersConfig - Users configuration to change
 * @param {Object} externalUser - External user data
 * @returns {{user: Object, changed: boolean}} Created/updated user object, and
 *   whether `usersConfig` changed (false: nothing to write)
 */
function provisionExternalUser(usersConfig, externalUser) {
  const authMethod = externalAuthMethod(externalUser);
  const existingUser = findExternalUser(usersConfig, externalUser, authMethod);

  const now = new Date().toISOString();
  const day = today();

  if (existingUser) {
    // Update existing user
    const userId = existingUser.id;
    const user = usersConfig.users[userId];
    const changed = applyExternalLogin(user, externalUser, authMethod);
    if (changed) user.updatedAt = now;
    const activeToday = user.lastActiveDate === day;
    user.lastActiveDate = day;
    return { user: { ...user, id: userId }, changed: changed || !activeToday };
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
      lastActiveDate: day,
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
    return { user: newUser, changed: true };
  }
}

/**
 * Update user's last active date if it's a new day
 * @param {string} userId - User ID
 * @param {string} usersFilePath - Path to users.json file
 */
export async function updateUserActivity(userId, usersFilePath) {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format

  // Only write if the user is known and it is a different day. Checked against
  // the cached file first: this runs on requests, and most of them change nothing.
  const cached = loadUsers(usersFilePath).users?.[userId];
  if (!cached || cached.lastActiveDate === today) return;

  await updateUsersFile(usersFilePath, usersConfig => {
    const user = Object.hasOwn(usersConfig.users, userId) ? usersConfig.users[userId] : null;
    if (!user || user.lastActiveDate === today) return false;
    user.lastActiveDate = today;
    user.updatedAt = new Date().toISOString();
    return true;
  });
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

    // Update existing user (and its lastActiveDate) and merge groups
    const persistedUser = await createOrUpdateExternalUser(externalUser, usersFilePath);

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
