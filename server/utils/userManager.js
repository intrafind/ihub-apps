import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { fileURLToPath } from 'url';
import { atomicWriteJSON } from './atomicWrite.js';
import configCache from '../configCache.js';
import { mapExternalGroups, loadGroupsConfiguration } from './authorization.js';
import logger from './logger.js';
import { ensureFirstUserIsAdmin } from './adminRescue.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Load users from the local users file
 * @param {string} usersFilePath - Path to users.json file
 * @returns {Object} Users configuration
 */
export function loadUsers(usersFilePath) {
  try {
    // Convert file path to cache key format
    // The cache stores keys without 'contents/' prefix, so we need to strip it
    let cacheKey;
    if (usersFilePath.startsWith('contents/')) {
      // Remove 'contents/' prefix to match cache key format
      cacheKey = usersFilePath.substring('contents/'.length);
    } else {
      cacheKey = path.relative(
        path.join(__dirname, '../../'),
        path.isAbsolute(usersFilePath)
          ? usersFilePath
          : path.join(__dirname, '../../', usersFilePath)
      );
      // Also remove contents/ prefix if it exists after path.relative
      if (cacheKey.startsWith('contents/')) {
        cacheKey = cacheKey.substring('contents/'.length);
      }
    }

    // Try to get from cache first
    const cached = configCache.get(cacheKey);
    if (cached && cached.data && cached.data.users) {
      return cached.data;
    }

    // Fallback to file system if cache miss or invalid data
    logger.warn(
      `[WARN] Users configuration not found in cache for: ${cacheKey}, attempting file system fallback`,
      { component: 'Utils' }
    );

    const fullPath = path.isAbsolute(usersFilePath)
      ? usersFilePath
      : path.join(__dirname, '../../', usersFilePath);

    // Check if file exists
    if (!fs.existsSync(fullPath)) {
      logger.warn(`[WARN] Users file not found: ${fullPath}, creating empty structure`, {
        component: 'Utils'
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
    logger.error(`[ERROR] Could not load users configuration:`, {
      component: 'Utils',
      message: error.message
    });
    logger.error(`[ERROR] Stack trace:`, { component: 'Utils', stack: error.stack });

    // Return safe empty structure as last resort
    const safeConfig = {
      users: {},
      metadata: { version: '2.0.0', lastUpdated: new Date().toISOString(), error: error.message }
    };

    logger.warn(`[WARN] Returning safe empty users structure due to error`, { component: 'Utils' });
    return safeConfig;
  }
}

/**
 * Save users to the local users file
 * @param {Object} usersConfig - Users configuration object
 * @param {string} usersFilePath - Path to users.json file
 */
export async function saveUsers(usersConfig, usersFilePath) {
  try {
    const fullPath = path.isAbsolute(usersFilePath)
      ? usersFilePath
      : path.join(__dirname, '../../', usersFilePath);

    // Update metadata
    if (!usersConfig.metadata) {
      usersConfig.metadata = { version: '2.0.0' };
    }
    usersConfig.metadata.lastUpdated = new Date().toISOString();

    // Write to file atomically
    await atomicWriteJSON(fullPath, usersConfig);

    // Update cache with the new data
    // The cache stores keys without 'contents/' prefix, so we need to strip it
    let cacheKey;
    if (usersFilePath.startsWith('contents/')) {
      // Remove 'contents/' prefix to match cache key format
      cacheKey = usersFilePath.substring('contents/'.length);
    } else {
      cacheKey = path.relative(path.join(__dirname, '../../'), fullPath);
      // Also remove contents/ prefix if it exists after path.relative
      if (cacheKey.startsWith('contents/')) {
        cacheKey = cacheKey.substring('contents/'.length);
      }
    }

    configCache.setCacheEntry(cacheKey, usersConfig);
  } catch (error) {
    logger.error('Could not save users configuration:', {
      component: 'Utils',
      message: error.message
    });
    throw error;
  }
}

/**
 * Find user by various identifiers (username, email, oidcSubject)
 * @param {Object} usersConfig - Users configuration
 * @param {string} identifier - Username, email, or OIDC subject ID
 * @param {string} authMethod - Authentication method ('local', 'oidc', 'proxy')
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

    // Match by username, email, or auth-specific subject
    if (
      user.username === identifier ||
      (identifier && user.email === identifier) ||
      (user.oidcData && user.oidcData.subject === identifier) ||
      (user.proxyData && user.proxyData.subject === identifier) ||
      (user.teamsData && user.teamsData.subject === identifier) ||
      (user.ntlmData && user.ntlmData.subject === identifier)
    ) {
      return { ...user, id: userId };
    }
  }

  return null;
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
    externalUser.authMethod === 'ntlm' || externalUser.provider === 'ntlm'
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
    }

    // Update basic info from external provider
    user.name = externalUser.name || user.name;
    user.email = externalUser.email || user.email;

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
    const userId = `user_${uuidv4().replace(/-/g, '_')}`;

    const newUser = {
      id: userId,
      username: externalUser.email || externalUser.id, // Use email or fallback to external id
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
 * Validate and persist external user based on platform configuration
 * Consolidates the validation logic from proxyAuth.js, oidcAuth.js, and ntlmAuth.js
 * @param {Object} externalUser - External user data (OIDC/Proxy/Teams/NTLM)
 * @param {Object} platformConfig - Platform configuration
 * @returns {Object} Validated and persisted user object
 */
export async function validateAndPersistExternalUser(externalUser, platformConfig) {
  const authMethod =
    externalUser.authMethod === 'ntlm' || externalUser.provider === 'ntlm'
      ? 'ntlm'
      : externalUser.provider === 'proxy'
        ? 'proxy'
        : externalUser.provider === 'teams'
          ? 'teams'
          : 'oidc';

  // Get the appropriate auth config based on auth method
  let authConfig;
  if (authMethod === 'proxy') {
    authConfig = platformConfig.proxyAuth || {};
  } else if (authMethod === 'teams') {
    authConfig = platformConfig.teamsAuth || {};
  } else if (authMethod === 'ntlm') {
    authConfig = platformConfig.ntlmAuth || {};
  } else {
    authConfig = platformConfig.oidcAuth || {};
  }

  const usersFilePath = platformConfig.localAuth?.usersFile || 'contents/config/users.json';

  // Check if user exists in users.json
  const usersConfig = loadUsers(usersFilePath);
  const existingUser =
    findUserByIdentifier(usersConfig, externalUser.email, authMethod) ||
    findUserByIdentifier(usersConfig, externalUser.id, authMethod);

  // If user exists, check if they are active
  if (existingUser) {
    if (!isUserActive(existingUser)) {
      throw new Error(
        `User account is disabled. User ID: ${existingUser.id}, Email: ${existingUser.email}. Please contact your administrator.`
      );
    }

    // Update existing user and merge groups
    const persistedUser = await createOrUpdateExternalUser(externalUser, usersFilePath);

    // Update activity tracking
    await updateUserActivity(persistedUser.id, usersFilePath);

    // Merge groups: external groups (from auth provider) + internal groups (from users.json)
    // Use externalGroups (raw from token) if available, otherwise fall back to processed groups
    const externalGroupsToMap = externalUser.externalGroups || [];
    const mappedExternalGroups = mapExternalGroups(externalGroupsToMap);

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
      persistedUser: true
    };

    userWithAdminCheck = await ensureFirstUserIsAdmin(
      userWithAdminCheck,
      authMethod,
      usersFilePath
    );

    return userWithAdminCheck;
  }

  // User doesn't exist - check self-signup settings
  // For NTLM, default to allowing self-signup since users are already authenticated by domain controller
  const allowSelfSignup =
    authConfig.allowSelfSignup ?? (authMethod === 'ntlm' || authMethod === 'proxy');
  if (!allowSelfSignup) {
    throw new Error(
      `New user registration is not allowed. User ID: ${externalUser.id}, Email: ${externalUser.email}. Please contact your administrator.`
    );
  }

  // Create new user (self-signup allowed)
  const persistedUser = await createOrUpdateExternalUser(externalUser, usersFilePath);

  // Combine external groups from auth provider with internal groups from users.json
  // Use externalGroups (raw from token) if available, otherwise fall back to processed groups
  const externalGroupsToMap = externalUser.externalGroups || [];
  const mappedExternalGroups = mapExternalGroups(externalGroupsToMap);

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
    persistedUser: true
  };

  userWithAdminCheck = await ensureFirstUserIsAdmin(userWithAdminCheck, authMethod, usersFilePath);

  return userWithAdminCheck;
}
