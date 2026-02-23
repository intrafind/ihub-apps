import { promises as fs } from 'fs';
import { join } from 'path';
import { getRootDir } from '../../pathUtils.js';
import { atomicWriteJSON } from '../../utils/atomicWrite.js';
import configCache from '../../configCache.js';
import { adminAuth, isAdminAuthRequired } from '../../middleware/adminAuth.js';
import { hashPasswordWithUserId } from '../../middleware/localAuth.js';
import { v4 as uuidv4 } from 'uuid';
import { buildServerPath } from '../../utils/basePath.js';
import { validateIdForPath } from '../../utils/pathSecurity.js';
import logger from '../../utils/logger.js';
import { isLastAdmin } from '../../utils/adminRescue.js';

/**
 * @swagger
 * components:
 *   schemas:
 *     AuthStatus:
 *       type: object
 *       description: Authentication status information
 *       properties:
 *         authRequired:
 *           type: boolean
 *           description: Whether admin authentication is required
 *           example: true
 *         authenticated:
 *           type: boolean
 *           description: Whether the current request is authenticated
 *           example: false
 *
 *     User:
 *       type: object
 *       description: User account information
 *       required:
 *         - id
 *         - username
 *       properties:
 *         id:
 *           type: string
 *           description: Unique user identifier
 *           example: "user_a1b2c3d4_e5f6_7890_abcd_ef1234567890"
 *         username:
 *           type: string
 *           description: User's login username
 *           example: "john.doe"
 *         email:
 *           type: string
 *           description: User's email address
 *           example: "john.doe@company.com"
 *         name:
 *           type: string
 *           description: User's display name
 *           example: "John Doe"
 *         internalGroups:
 *           type: array
 *           description: List of internal groups the user belongs to
 *           items:
 *             type: string
 *           example: ["developers", "users"]
 *         active:
 *           type: boolean
 *           description: Whether the user account is active
 *           example: true
 *         createdAt:
 *           type: string
 *           format: date-time
 *           description: Account creation timestamp
 *           example: "2024-01-15T10:30:00Z"
 *         updatedAt:
 *           type: string
 *           format: date-time
 *           description: Last update timestamp
 *           example: "2024-01-15T15:45:00Z"
 *
 *     UsersData:
 *       type: object
 *       description: Complete users database structure
 *       properties:
 *         users:
 *           type: object
 *           description: Map of user ID to user data
 *           additionalProperties:
 *             $ref: '#/components/schemas/User'
 *         metadata:
 *           type: object
 *           description: Database metadata
 *           properties:
 *             version:
 *               type: string
 *               example: "2.0.0"
 *             description:
 *               type: string
 *               example: "Local user database for iHub Apps"
 *             lastUpdated:
 *               type: string
 *               format: date-time
 *
 *     UserOperation:
 *       type: object
 *       description: Result of a user operation
 *       properties:
 *         message:
 *           type: string
 *           description: Operation result message
 *         user:
 *           $ref: '#/components/schemas/User'
 *           description: The affected user (excludes password hash)
 *
 *     AuthError:
 *       type: object
 *       properties:
 *         error:
 *           type: string
 *           description: Error message
 */

export default function registerAdminAuthRoutes(app) {
  /**
   * @swagger
   * /api/admin/auth/status:
   *   get:
   *     summary: Check admin authentication status
   *     description: |
   *       Determines whether admin authentication is required and if the current
   *       request is properly authenticated. This endpoint is used by admin UI
   *       to determine authentication state.
   *
   *       **Authentication Logic:**
   *       - Checks if admin auth is required based on current user context
   *       - Verifies Bearer token presence for authentication status
   *       - No admin authentication required for this status check endpoint
   *     tags:
   *       - Admin
   *       - Authentication
   *     responses:
   *       200:
   *         description: Authentication status successfully retrieved
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AuthStatus'
   *             examples:
   *               authRequired:
   *                 summary: Authentication required, not authenticated
   *                 value:
   *                   authRequired: true
   *                   authenticated: false
   *               authenticated:
   *                 summary: Authentication required and authenticated
   *                 value:
   *                   authRequired: true
   *                   authenticated: true
   *               noAuthRequired:
   *                 summary: No authentication required
   *                 value:
   *                   authRequired: false
   *                   authenticated: true
   *       500:
   *         description: Failed to check authentication status
   */
  app.get(buildServerPath('/api/admin/auth/status'), async (req, res) => {
    try {
      // Check if admin auth is required considering current user authentication
      // req.user is populated by the global auth middleware (proxyAuth, localAuth)
      const authRequired = isAdminAuthRequired(req);

      res.json({
        authRequired,
        authenticated: !authRequired || req.headers.authorization?.startsWith('Bearer ')
      });
    } catch (error) {
      logger.error('Error checking admin auth status:', error);
      res.status(500).json({ error: 'Failed to check authentication status' });
    }
  });

  /**
   * @swagger
   * /api/admin/auth/test:
   *   get:
   *     summary: Test admin authentication
   *     description: |
   *       Tests if admin authentication is working correctly.
   *       This endpoint requires valid admin authentication and returns
   *       a success message if authentication passes.
   *     tags:
   *       - Admin
   *       - Authentication
   *     security:
   *       - adminAuth: []
   *     responses:
   *       200:
   *         description: Authentication test successful
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 message:
   *                   type: string
   *                 authenticated:
   *                   type: boolean
   *             example:
   *               message: "Admin authentication successful"
   *               authenticated: true
   *       401:
   *         description: Authentication failed
   *       500:
   *         description: Failed to test authentication
   */
  app.get(buildServerPath('/api/admin/auth/test'), adminAuth, async (req, res) => {
    try {
      res.json({ message: 'Admin authentication successful', authenticated: true });
    } catch (error) {
      logger.error('Error testing admin auth:', error);
      res.status(500).json({ error: 'Failed to test authentication' });
    }
  });

  // User Management Routes

  /**
   * @swagger
   * /api/admin/auth/users:
   *   get:
   *     summary: Get all user accounts
   *     description: |
   *       Retrieves all user accounts in the local user database.
   *       Returns complete user data including metadata but excludes password hashes
   *       for security reasons.
   *     tags:
   *       - Admin
   *       - User Management
   *     security:
   *       - adminAuth: []
   *     responses:
   *       200:
   *         description: Users successfully retrieved
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/UsersData'
   *       500:
   *         description: Failed to get users
   */
  app.get(buildServerPath('/api/admin/auth/users'), adminAuth, async (req, res) => {
    try {
      const rootDir = getRootDir();
      const usersFilePath = join(rootDir, 'contents', 'config', 'users.json');

      let usersData = { users: {}, metadata: {} };
      try {
        const usersFileData = await fs.readFile(usersFilePath, 'utf8');
        usersData = JSON.parse(usersFileData);
      } catch {
        // File doesn't exist or is invalid, return empty users
        logger.info('Users file not found or invalid, returning empty list');
      }

      res.json(usersData);
    } catch (error) {
      logger.error('Error getting users:', error);
      res.status(500).json({ error: 'Failed to get users' });
    }
  });

  /**
   * @swagger
   * /api/admin/auth/users:
   *   post:
   *     summary: Create a new user account
   *     description: |
   *       Creates a new user account with username, password, and optional details.
   *       Validates username uniqueness and password strength requirements.
   *
   *       **Validation Rules:**
   *       - Username must be unique
   *       - Password must be at least 6 characters
   *       - User ID is automatically generated
   *       - Password is hashed with user-specific salt
   *     tags:
   *       - Admin
   *       - User Management
   *     security:
   *       - adminAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - username
   *               - password
   *             properties:
   *               username:
   *                 type: string
   *                 description: Unique username for login
   *                 example: "john.doe"
   *               password:
   *                 type: string
   *                 description: User password (minimum 6 characters)
   *                 minLength: 6
   *                 example: "securePassword123"
   *               email:
   *                 type: string
   *                 description: User email address
   *                 example: "john.doe@company.com"
   *               name:
   *                 type: string
   *                 description: Display name
   *                 example: "John Doe"
   *               internalGroups:
   *                 type: array
   *                 description: Internal groups to assign
   *                 items:
   *                   type: string
   *                 example: ["users", "developers"]
   *               active:
   *                 type: boolean
   *                 description: Whether account is active
   *                 default: true
   *     responses:
   *       200:
   *         description: User successfully created
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/UserOperation'
   *       400:
   *         description: Validation error
   *       409:
   *         description: Username already exists
   *       500:
   *         description: Failed to create user
   */
  app.post(buildServerPath('/api/admin/auth/users'), adminAuth, async (req, res) => {
    try {
      const {
        username,
        email,
        name,
        password,
        internalGroups = [],
        active = true,
        authMethods = ['local']
      } = req.body;

      // Check if this is a local auth user (needs password)
      const isLocalAuth = authMethods.includes('local');

      if (!username) {
        return res.status(400).json({ error: 'Username is required' });
      }

      // Only require password for local auth users
      if (isLocalAuth && !password) {
        return res
          .status(400)
          .json({ error: 'Password is required for local authentication users' });
      }

      if (password && password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters long' });
      }

      const rootDir = getRootDir();
      const usersFilePath = join(rootDir, 'contents', 'config', 'users.json');

      // Load existing users
      let usersData = { users: {}, metadata: {} };
      try {
        const usersFileData = await fs.readFile(usersFilePath, 'utf8');
        usersData = JSON.parse(usersFileData);
      } catch {
        // File doesn't exist, create new structure
        usersData = {
          users: {},
          metadata: {
            version: '2.0.0',
            description: 'Local user database for iHub Apps'
          }
        };
      }

      // Check if username already exists
      const existingUser = Object.values(usersData.users).find(user => user.username === username);
      if (existingUser) {
        return res.status(409).json({ error: 'Username already exists' });
      }

      // Create new user
      const userId = `user_${uuidv4().replace(/-/g, '_')}`;

      const newUser = {
        id: userId,
        username,
        email: email || null,
        name: name || '',
        internalGroups: Array.isArray(internalGroups) ? internalGroups : [],
        authMethods: Array.isArray(authMethods) ? authMethods : ['local'],
        active,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      // Only add password hash for local auth users
      if (isLocalAuth && password) {
        newUser.passwordHash = await hashPasswordWithUserId(password, userId);
      }

      usersData.users[userId] = newUser;
      usersData.metadata.lastUpdated = new Date().toISOString();

      // Save to file
      await atomicWriteJSON(usersFilePath, usersData);

      // Refresh cache to ensure new user is available in cache
      await configCache.refreshCacheEntry('config/users.json');

      logger.info(
        `👤 Created new user: ${username} (${userId}) with auth methods: ${authMethods.join(', ')}`
      );

      // Return user without password hash
      const { passwordHash: _passwordHash, ...userResponse } = newUser;
      res.json({ user: userResponse });
    } catch (error) {
      logger.error('Error creating user:', error);
      res.status(500).json({ error: 'Failed to create user' });
    }
  });

  /**
   * @swagger
   * /api/admin/auth/users/{userId}:
   *   put:
   *     summary: Update an existing user account
   *     description: |
   *       Updates an existing user account with new information.
   *       Only provided fields are updated, others remain unchanged.
   *       Password updates include strength validation and proper hashing.
   *     tags:
   *       - Admin
   *       - User Management
   *     security:
   *       - adminAuth: []
   *     parameters:
   *       - in: path
   *         name: userId
   *         required: true
   *         description: Unique user identifier
   *         schema:
   *           type: string
   *           example: "user_a1b2c3d4_e5f6_7890_abcd_ef1234567890"
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               email:
   *                 type: string
   *               name:
   *                 type: string
   *               password:
   *                 type: string
   *                 minLength: 6
   *                 description: New password (minimum 6 characters)
   *               internalGroups:
   *                 type: array
   *                 items:
   *                   type: string
   *               active:
   *                 type: boolean
   *           example:
   *             email: "john.doe.updated@company.com"
   *             name: "John Doe Jr."
   *             internalGroups: ["users", "managers"]
   *             active: true
   *     responses:
   *       200:
   *         description: User successfully updated
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/UserOperation'
   *       400:
   *         description: Validation error (e.g., password too short)
   *       404:
   *         description: User not found
   *       500:
   *         description: Failed to update user
   */
  app.put(buildServerPath('/api/admin/auth/users/:userId'), adminAuth, async (req, res) => {
    try {
      const { userId } = req.params;

      // Validate userId for security (prevents prototype pollution)
      if (!validateIdForPath(userId, 'user', res)) {
        return;
      }

      // Additional hardening: explicitly block prototype-polluting keys
      if (userId === '__proto__' || userId === 'constructor' || userId === 'prototype') {
        return res.status(400).json({ error: 'Invalid user ID' });
      }

      const { email, name, password, internalGroups, active } = req.body;

      const rootDir = getRootDir();
      const usersFilePath = join(rootDir, 'contents', 'config', 'users.json');

      // Load existing users
      let usersData = { users: {}, metadata: {} };
      try {
        const usersFileData = await fs.readFile(usersFilePath, 'utf8');
        usersData = JSON.parse(usersFileData);
      } catch {
        return res.status(404).json({ error: 'Users file not found' });
      }

      // Check if user exists
      if (!usersData.users[userId]) {
        return res.status(404).json({ error: 'User not found' });
      }

      const user = usersData.users[userId];

      // Update fields
      if (email !== undefined) user.email = email;
      if (name !== undefined) user.name = name;
      if (internalGroups !== undefined)
        user.internalGroups = Array.isArray(internalGroups) ? internalGroups : [];
      if (active !== undefined) user.active = active;

      // Update password if provided
      if (password) {
        if (password.length < 6) {
          return res.status(400).json({ error: 'Password must be at least 6 characters long' });
        }
        user.passwordHash = await hashPasswordWithUserId(password, userId);
      }

      user.updatedAt = new Date().toISOString();
      usersData.metadata.lastUpdated = new Date().toISOString();

      // Save to file
      await atomicWriteJSON(usersFilePath, usersData);

      // Refresh cache to ensure updated user data is available in cache
      await configCache.refreshCacheEntry('config/users.json');

      logger.info(`👤 Updated user: ${user.username} (${userId})`);

      // Return user without password hash
      // eslint-disable-next-line no-unused-vars
      const { passwordHash, ...userResponse } = user;
      res.json({ user: userResponse });
    } catch (error) {
      logger.error('Error updating user:', error);
      res.status(500).json({ error: 'Failed to update user' });
    }
  });

  /**
   * @swagger
   * /api/admin/auth/users/{userId}:
   *   delete:
   *     summary: Delete a user account
   *     description: |
   *       Permanently deletes a user account from the system.
   *       This operation cannot be undone. The user will be immediately
   *       removed from the database and cache.
   *
   *       **Warning:** This is a destructive operation that cannot be reversed.
   *       Consider deactivating the user instead if the account might be needed later.
   *     tags:
   *       - Admin
   *       - User Management
   *     security:
   *       - adminAuth: []
   *     parameters:
   *       - in: path
   *         name: userId
   *         required: true
   *         description: Unique user identifier
   *         schema:
   *           type: string
   *           example: "user_a1b2c3d4_e5f6_7890_abcd_ef1234567890"
   *     responses:
   *       200:
   *         description: User successfully deleted
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 message:
   *                   type: string
   *             example:
   *               message: "User deleted successfully"
   *       404:
   *         description: User not found
   *       500:
   *         description: Failed to delete user
   */
  app.delete(buildServerPath('/api/admin/auth/users/:userId'), adminAuth, async (req, res) => {
    try {
      const { userId } = req.params;

      // Validate userId for security (prevents prototype pollution)
      if (!validateIdForPath(userId, 'user', res)) {
        return;
      }

      const rootDir = getRootDir();
      const usersFilePath = join(rootDir, 'contents', 'config', 'users.json');

      // Load existing users
      let usersData = { users: {}, metadata: {} };
      try {
        const usersFileData = await fs.readFile(usersFilePath, 'utf8');
        usersData = JSON.parse(usersFileData);
      } catch {
        return res.status(404).json({ error: 'Users file not found' });
      }

      // Check if user exists
      if (!usersData.users[userId]) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Check if user is the last admin - prevent deletion
      if (isLastAdmin(userId, usersFilePath)) {
        return res.status(403).json({
          error: 'Cannot delete the last admin user',
          message:
            'At least one admin user must exist in the system. Please assign admin rights to another user before deleting this account.'
        });
      }

      const username = usersData.users[userId].username;

      // Remove user
      delete usersData.users[userId];
      usersData.metadata.lastUpdated = new Date().toISOString();

      // Save to file
      await atomicWriteJSON(usersFilePath, usersData);

      // Refresh cache to ensure deleted user is removed from cache
      await configCache.refreshCacheEntry('config/users.json');

      logger.info(`👤 Deleted user: ${username} (${userId})`);

      res.json({ message: 'User deleted successfully' });
    } catch (error) {
      logger.error('Error deleting user:', error);
      res.status(500).json({ error: 'Failed to delete user' });
    }
  });
}
