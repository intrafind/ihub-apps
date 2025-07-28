import bcrypt from 'bcrypt';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { enhanceUserGroups } from '../utils/authorization.js';
import { generateJwt } from '../utils/tokenService.js';
import configCache from '../configCache.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Load users from the local users file
 * @param {string} usersFilePath - Path to users.json file
 * @returns {Object} Users configuration
 */
function loadUsers(usersFilePath) {
  try {
    const fullPath = path.isAbsolute(usersFilePath)
      ? usersFilePath
      : path.join(__dirname, '../../', usersFilePath);

    if (!fs.existsSync(fullPath)) {
      console.warn(`Users file not found: ${fullPath}`);
      return { users: {} };
    }

    const config = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    return config;
  } catch (error) {
    console.warn('Could not load users configuration:', error.message);
    return { users: {} };
  }
}


/**
 * Hash password with user ID as salt for unique hashes
 * @param {string} password - Plain text password
 * @param {string} userId - User ID to use as salt
 * @returns {Promise<string>} Hashed password
 */
export async function hashPasswordWithUserId(password, userId) {
  // Create a deterministic salt from user ID
  const salt = await bcrypt.genSalt(12);

  // Combine password with user ID for unique hash
  const passwordWithUserId = `${userId}:${password}`;

  return await bcrypt.hash(passwordWithUserId, salt);
}

/**
 * Verify password against hash using user ID
 * @param {string} password - Plain text password
 * @param {string} userId - User ID used during hashing
 * @param {string} hash - Stored password hash
 * @returns {Promise<boolean>} True if password matches
 */
async function verifyPasswordWithUserId(password, userId, hash) {
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
 */
export async function loginUser(username, password, localAuthConfig) {
  const usersConfig = loadUsers(localAuthConfig.usersFile || 'contents/config/users.json');
  const users = usersConfig.users || {};

  // Find user by username or email
  const user = Object.values(users).find(u => u.username === username || u.email === username);

  if (!user) {
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

  // Create user response object (without sensitive information)
  let userResponse = {
    id: user.id,
    name: user.name,
    email: user.email,
    groups: user.groups || ['user'],
    authenticated: true,
    authMethod: 'local'
  };

  // Enhance user with authenticated group
  const platform = configCache.getPlatform() || {};
  const authConfig = platform.auth || {};

  userResponse = enhanceUserGroups(userResponse, authConfig);

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
  const { username, email, password, name, groups = ['user'], active = true } = userData;

  if (!username || !email || !password || !name) {
    throw new Error('Missing required fields: username, email, password, name');
  }

  const usersConfig = loadUsers(usersFilePath);
  const users = usersConfig.users || {};

  // Check if user already exists
  const existingUser = Object.values(users).find(u => u.username === username || u.email === email);

  if (existingUser) {
    throw new Error('User with this username or email already exists');
  }

  // Create user ID first (needed for password hashing)
  const userId = `user_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;

  // Hash password with user ID for unique hash
  const passwordHash = await hashPasswordWithUserId(password, userId);

  // Create user object
  const newUser = {
    id: userId,
    username,
    email,
    name,
    groups,
    active,
    passwordHash,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  // Add user to config
  users[userId] = newUser;
  usersConfig.users = users;

  // Save to file
  const fullPath = path.isAbsolute(usersFilePath)
    ? usersFilePath
    : path.join(__dirname, '../../', usersFilePath);

  // Ensure directory exists
  const dir = path.dirname(fullPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(fullPath, JSON.stringify(usersConfig, null, 2));

  // Return user without sensitive data
  // eslint-disable-next-line no-unused-vars
  const { passwordHash: _pw, ...userResponse } = newUser;
  return userResponse;
}
