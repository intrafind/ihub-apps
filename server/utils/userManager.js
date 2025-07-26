import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { fileURLToPath } from 'url';
import { atomicWriteJSON } from './atomicWrite.js';
import configCache from '../configCache.js';

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
    const cacheKey = usersFilePath.startsWith('contents/')
      ? usersFilePath
      : path.relative(
          path.join(__dirname, '../../'),
          path.isAbsolute(usersFilePath)
            ? usersFilePath
            : path.join(__dirname, '../../', usersFilePath)
        );

    // Get from cache only - no fallback
    const cached = configCache.get(cacheKey);
    if (cached && cached.data) {
      return cached.data;
    }

    // Return empty structure if not in cache
    console.warn(`Users configuration not found in cache for: ${cacheKey}`);
    return { users: {}, metadata: { version: '2.0.0', lastUpdated: new Date().toISOString() } };
  } catch (error) {
    console.warn('Could not load users configuration:', error.message);
    return { users: {}, metadata: { version: '2.0.0', lastUpdated: new Date().toISOString() } };
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
    const cacheKey = usersFilePath.startsWith('contents/')
      ? usersFilePath
      : path.relative(path.join(__dirname, '../../'), fullPath);

    configCache.setCacheEntry(cacheKey, usersConfig);
  } catch (error) {
    console.error('Could not save users configuration:', error.message);
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

    // Match by username, email, or OIDC subject
    if (
      user.username === identifier ||
      user.email === identifier ||
      (user.oidcData && user.oidcData.subject === identifier)
    ) {
      return { ...user, id: userId };
    }
  }

  return null;
}

/**
 * Create or update OIDC/Proxy user in users.json
 * @param {Object} externalUser - OIDC/Proxy user data
 * @param {string} usersFilePath - Path to users.json file
 * @returns {Object} Created/updated user object
 */
export async function createOrUpdateOidcUser(externalUser, usersFilePath) {
  const usersConfig = loadUsers(usersFilePath);
  const authMethod = externalUser.provider === 'proxy' ? 'proxy' : 'oidc';

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

    // Update external auth data
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
    }

    // Update basic info from external provider
    user.name = externalUser.name || user.name;
    user.email = externalUser.email || user.email;

    // Merge groups: keep existing groups and add external groups
    const existingGroups = new Set(user.groups || []);
    const externalGroups = externalUser.groups || [];
    externalGroups.forEach(group => existingGroups.add(group));
    user.groups = Array.from(existingGroups);

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
      username: externalUser.email, // Use email as username for external users
      email: externalUser.email,
      name: externalUser.name,
      groups: externalUser.groups || [],
      active: true,
      authMethods: [authMethod],
      lastActiveDate: today,
      createdAt: now,
      updatedAt: now
    };

    // Add auth-specific data
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
 * @param {Array} jwtGroups - Groups from JWT/OIDC token
 * @param {Array} configGroups - Additional groups from user config
 * @returns {Array} Merged and deduplicated groups
 */
export function mergeUserGroups(jwtGroups = [], configGroups = []) {
  const allGroups = new Set();

  // Add JWT groups
  jwtGroups.forEach(group => allGroups.add(group));

  // Add config groups
  configGroups.forEach(group => allGroups.add(group));

  return Array.from(allGroups);
}
