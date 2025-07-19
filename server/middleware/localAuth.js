import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { enhanceUserWithPermissions } from '../utils/authorization.js';

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
 * Verify JWT token
 * @param {string} token - JWT token
 * @param {string} secret - JWT secret
 * @returns {Object|null} Decoded token payload or null
 */
function verifyToken(token, secret) {
  try {
    return jwt.verify(token, secret);
  } catch (error) {
    console.warn('JWT verification failed:', error.message);
    return null;
  }
}

/**
 * Hash password with user ID as salt for unique hashes
 * @param {string} password - Plain text password
 * @param {string} userId - User ID to use as salt
 * @returns {Promise<string>} Hashed password
 */
async function hashPasswordWithUserId(password, userId) {
  // Create a deterministic salt from user ID
  const saltInput = `${userId}_salt_${password}`;
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
 * Create JWT token for user
 * @param {Object} user - User object
 * @param {string} secret - JWT secret
 * @param {number} expiresIn - Token expiration in seconds
 * @returns {string} JWT token
 */
function createToken(user, secret, expiresIn = 28800) { // 8 hours default
  const payload = {
    id: user.id,
    name: user.name,
    email: user.email,
    groups: user.groups,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + expiresIn
  };
  
  return jwt.sign(payload, secret);
}

/**
 * Local authentication middleware
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
export default function localAuthMiddleware(req, res, next) {
  // Skip if local auth is not enabled
  const platform = req.app.get('platform') || {};
  const localAuthConfig = platform.localAuth || {};
  
  if (!localAuthConfig.enabled) {
    return next();
  }
  
  // Check for Authorization header
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next(); // No token, continue as anonymous
  }
  
  const token = authHeader.substring(7);
  const jwtSecret = localAuthConfig.jwtSecret;
  
  if (!jwtSecret || jwtSecret === '${JWT_SECRET}') {
    console.warn('Local auth enabled but JWT_SECRET not configured');
    return next();
  }
  
  // Verify token
  const decoded = verifyToken(token, jwtSecret);
  if (!decoded) {
    return next(); // Invalid token, continue as anonymous
  }
  
  // Check token expiration
  const now = Math.floor(Date.now() / 1000);
  if (decoded.exp && decoded.exp < now) {
    return next(); // Expired token, continue as anonymous
  }
  
  // Create user object from token
  req.user = {
    id: decoded.id,
    name: decoded.name,
    email: decoded.email,
    groups: decoded.groups || ['user'],
    authenticated: true,
    authMethod: 'local'
  };
  
  // Enhance user with permissions
  const authConfig = platform.authorization || {};
  req.user = enhanceUserWithPermissions(req.user, authConfig);
  
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
  const user = Object.values(users).find(u => 
    u.username === username || u.email === username
  );
  
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
  
  // Create JWT token
  const jwtSecret = localAuthConfig.jwtSecret;
  if (!jwtSecret || jwtSecret === '${JWT_SECRET}') {
    throw new Error('JWT secret not configured');
  }
  
  const sessionTimeoutSeconds = (localAuthConfig.sessionTimeoutMinutes || 480) * 60;
  const token = createToken(user, jwtSecret, sessionTimeoutSeconds);
  
  // Return user data (without sensitive information)
  const userResponse = {
    id: user.id,
    name: user.name,
    email: user.email,
    groups: user.groups || ['user'],
    authenticated: true,
    authMethod: 'local'
  };
  
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
  const existingUser = Object.values(users).find(u => 
    u.username === username || u.email === email
  );
  
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
  const { passwordHash: _, ...userResponse } = newUser;
  return userResponse;
}