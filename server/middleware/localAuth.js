import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { enhanceUserGroups } from '../utils/authorization.js';
import { generateJwt } from '../utils/tokenService.js';
import {
  equalsIgnoreCase,
  hashPasswordWithUserId,
  loadUsers,
  saveUsers
} from '../utils/userManager.js';
import configCache from '../configCache.js';
import { ensureFirstUserIsAdmin } from '../utils/adminRescue.js';
import { localUsersFile } from '../utils/contentsPath.js';
import {
  LoginLockedError,
  lockoutKey,
  reserveLoginAttempt,
  resolveLockoutConfig,
  settleLoginAttempt
} from '../utils/loginLockout.js';

const DUMMY_USER_ID = 'nonexistent-user';
const DUMMY_PASSWORD_HASH = '$2a$12$n6wyln4ERyOHBD6UAx2fAOkt0F7nX0x6X2ZiYAbBVvK7i7diOaJjG';

/**
 * Verify password against hash using user ID
 * @param {string} password - Plain text password
 * @param {string} userId - User ID used during hashing
 * @param {string} hash - Stored password hash
 * @returns {Promise<boolean>} True if password matches
 */
export async function verifyPasswordWithUserId(password, userId, hash) {
  // Combine password with user ID same way as during hashing
  const passwordWithUserId = `${userId}:${password}`;

  return await bcrypt.compare(passwordWithUserId, hash);
}

/**
 * Local authentication middleware
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
export default function localAuthMiddleware(req, res, next) {
  // Local auth middleware now only handles local authentication setup
  // JWT token validation is handled by the unified jwtAuthMiddleware

  // This middleware is now primarily a placeholder for any local auth specific logic
  // The actual JWT validation happens in jwtAuthMiddleware

  next();
}

/**
 * Login function for local authentication
 * @param {string} username - Username or email
 * @param {string} password - Password
 * @param {Object} localAuthConfig - Local auth configuration
 * @returns {Object} Login result with user and token
 * @throws {LoginLockedError} While the account is locked after repeated failures
 *   (`localAuthConfig.lockout`, see utils/loginLockout.js)
 */
export async function loginUser(username, password, localAuthConfig) {
  const usersConfig = loadUsers(localUsersFile(localAuthConfig));
  const users = usersConfig.users || {};

  // Find user by username or email (case-insensitive)
  const user = Object.values(users).find(
    u => equalsIgnoreCase(u.username, username) || equalsIgnoreCase(u.email, username)
  );

  // Reserve the attempt before any password is checked: a locked account is
  // refused here, and attempts sent in parallel cannot all slip past the check
  // while the comparison runs.
  const lockout = resolveLockoutConfig(localAuthConfig);
  const key = lockoutKey(user, username);
  let reservation = null;
  if (lockout.enabled) {
    reservation = await reserveLoginAttempt(key, lockout);
    if (reservation.waitMs > 0) throw new LoginLockedError(Math.ceil(reservation.waitMs / 1000));
  }

  // Only a sign-in that goes through settles as a success; a right password on
  // a disabled account does not clear the count.
  let signedIn = false;
  try {
    if (!user) {
      await verifyPasswordWithUserId(password, DUMMY_USER_ID, DUMMY_PASSWORD_HASH);
      throw new Error('Invalid credentials');
    }
    // Verify password using user ID
    const isValidPassword = await verifyPasswordWithUserId(password, user.id, user.passwordHash);
    if (!isValidPassword) {
      throw new Error('Invalid credentials');
    }

    // Check if user is active
    if (user.active === false) {
      throw new Error('Account is disabled');
    }
    signedIn = true;
  } finally {
    if (reservation) await settleLoginAttempt(key, lockout, signedIn, reservation.shared);
  }

  // Create user response object (without sensitive information)
  let userResponse = {
    id: user.id,
    username: user.username,
    name: user.name,
    email: user.email,
    groups: user.internalGroups || ['users'],
    authenticated: true,
    authMethod: 'local'
  };

  // Enhance user with authenticated group
  const platform = configCache.getPlatform() || {};
  const authConfig = platform.auth || {};

  userResponse = enhanceUserGroups(userResponse, authConfig);

  // Admin rescue: Ensure first user gets admin rights if no admin exists
  const usersFilePath = localUsersFile(localAuthConfig);
  userResponse = await ensureFirstUserIsAdmin(userResponse, 'local', usersFilePath);

  // Create JWT token using centralized token service
  const sessionTimeoutMinutes = localAuthConfig.sessionTimeoutMinutes || 480;
  const { token, expiresIn: sessionTimeoutSeconds } = generateJwt(userResponse, {
    authMode: 'local',
    expiresInMinutes: sessionTimeoutMinutes
  });

  return {
    user: userResponse,
    token: token,
    expiresIn: sessionTimeoutSeconds
  };
}

/**
 * Create a new user (for admin use)
 * @param {Object} userData - User data
 * @param {string} usersFilePath - Path to users.json file
 * @returns {Object} Created user (without password)
 */
export async function createUser(userData, usersFilePath) {
  const { username, email, password, name, internalGroups = ['users'], active = true } = userData;

  if (!username || !email || !password || !name) {
    throw new Error('Missing required fields: username, email, password, name');
  }

  const usersConfig = loadUsers(usersFilePath);
  const users = usersConfig.users || {};

  // Check if user already exists (case-insensitive)
  const existingUser = Object.values(users).find(
    u => equalsIgnoreCase(u.username, username) || equalsIgnoreCase(u.email, email)
  );

  if (existingUser) {
    throw new Error('User with this username or email already exists');
  }

  // Create user ID first (needed for password hashing)
  const userId = `user_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;

  // Hash password with user ID for unique hash
  const passwordHash = await hashPasswordWithUserId(password, userId);

  // Create user object
  const newUser = {
    id: userId,
    username,
    email,
    name,
    internalGroups,
    active,
    passwordHash,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  // Add user to config
  users[userId] = newUser;
  usersConfig.users = users;

  // `saveUsers` is the only writer of this file: it goes through the
  // `ConfigStore`, refreshes the cache entry and tells the other cluster
  // workers to re-read it. Writing the file here directly — as this did —
  // left every other worker authenticating against a users file it still
  // believed was current, and the next save from one of them rewrote the
  // whole file from that stale snapshot, dropping the new user.
  await saveUsers(usersConfig, usersFilePath);

  // Return user without sensitive data

  const { passwordHash: _pw, ...userResponse } = newUser;
  return userResponse;
}
