// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import configStore from '../../services/config/ConfigStore.js';
import configCache from '../../configCache.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { isContentAdmin } from '../../utils/authorization.js';
import { equalsIgnoreCase, hashPasswordWithUserId } from '../../utils/userManager.js';
import { v4 as uuidv4 } from 'uuid';
import { buildServerPath } from '../../utils/basePath.js';
import { ServiceError } from '../../utils/ServiceError.js';
import { assertValidId } from '../../utils/pathSecurity.js';
import logger from '../../utils/logger.js';
import { isLastAdmin } from '../../utils/adminRescue.js';
import { logAudit } from '../../services/AuditLogService.js';
import { startUserCleanup } from '../../services/userDeletion.js';
import { deleteLoginTokens } from '../../services/integrations/iFinderTokenProvider.js';
import { clearFailedLogins, lockoutKey } from '../../utils/loginLockout.js';
import { getDemoAccountStatus } from '../../utils/demoAccounts.js';
import { parseUsageLimitsInput } from '../../validators/common.js';

/** The local user database, as a path relative to `contents/`. */
const USERS_FILE = 'config/users.json';

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
    // Check if admin auth is required considering current user authentication
    // req.user is populated by the global auth middleware (proxyAuth, localAuth)
    // Accept both full admins and content admins for admin panel entry
    const authRequired = !isContentAdmin(req.user);

    res.json({
      authRequired,
      authenticated: !authRequired || req.headers.authorization?.startsWith('Bearer ')
    });
  });

  /**
   * @swagger
   * /api/admin/auth/demo-accounts:
   *   get:
   *     summary: Demo accounts that still have their shipped password
   *     description: |
   *       Reports whether the login page lists the demo accounts
   *       (`localAuth.showDemoAccounts`) and which of the shipped demo accounts
   *       still have the shipped password. The admin UI shows a warning while
   *       both are the case (`warn`).
   *     tags:
   *       - Admin
   *       - Authentication
   *     security:
   *       - adminAuth: []
   *     responses:
   *       200:
   *         description: Demo account status
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 showDemoAccounts:
   *                   type: boolean
   *                 accounts:
   *                   type: array
   *                   items:
   *                     type: string
   *                 warn:
   *                   type: boolean
   *             example:
   *               showDemoAccounts: true
   *               accounts: ["admin", "user"]
   *               warn: true
   *       401:
   *         description: Authentication failed
   *       500:
   *         description: Failed to read the demo account status
   */
  app.get(buildServerPath('/api/admin/auth/demo-accounts'), adminAuth, async (req, res) => {
    const localAuth = configCache.getPlatform()?.localAuth || {};
    res.json(await getDemoAccountStatus(localAuth));
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
    let usersData = await configStore.readJson(USERS_FILE);
    if (!usersData) {
      // File doesn't exist or is invalid, return empty users
      logger.info('Users file not found or invalid, returning empty list', {
        component: 'AdminAuth'
      });
      usersData = { users: {}, metadata: {} };
    }

    const sanitizedUsers = Object.fromEntries(
      Object.entries(usersData.users || {}).map(([id, user]) => {
        const { passwordHash, ...userWithoutPasswordHash } = user;
        return [id, userWithoutPasswordHash];
      })
    );

    res.json({ ...usersData, users: sanitizedUsers });
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
      throw new ServiceError('BAD_REQUEST', 'Username is required');
    }

    // Only require password for local auth users
    if (isLocalAuth && !password) {
      throw new ServiceError('BAD_REQUEST', 'Password is required for local authentication users');
    }

    if (password && password.length < 6) {
      throw new ServiceError('BAD_REQUEST', 'Password must be at least 6 characters long');
    }

    // Create new user
    const userId = `user_${uuidv4().replaceAll('-', '_')}`;
    const now = new Date().toISOString();

    const newUser = {
      id: userId,
      username,
      email: email || null,
      name: name || '',
      internalGroups: Array.isArray(internalGroups) ? internalGroups : [],
      authMethods: Array.isArray(authMethods) ? authMethods : ['local'],
      active,
      createdAt: now,
      updatedAt: now
    };

    // Only add password hash for local auth users. Hashed before the lock: the
    // hash is slow and must not hold up every other writer of users.json.
    if (isLocalAuth && password) {
      newUser.passwordHash = await hashPasswordWithUserId(password, userId);
    }

    // The existence check, the insert and the write run under the file lock, so
    // a user another request or a first login just added is not overwritten.
    // `apply` may run again on a newer body; it keeps no effect of an earlier run.
    await configStore.updateJson(USERS_FILE, current => {
      // No user database yet is the first-run case: start the structure here.
      const usersData = current || {
        users: {},
        metadata: {
          version: '2.0.0',
          description: 'Local user database for iHub Apps'
        }
      };
      if (!usersData.users || typeof usersData.users !== 'object') usersData.users = {};
      if (!usersData.metadata) usersData.metadata = { version: '2.0.0' };

      // Check if username already exists (case-insensitive)
      const existingUser = Object.values(usersData.users).find(user =>
        equalsIgnoreCase(user.username, username)
      );
      if (existingUser) {
        throw new ServiceError('CONFLICT', 'Username already exists');
      }

      usersData.users[userId] = newUser;
      usersData.metadata.lastUpdated = new Date().toISOString();
      return usersData;
    });

    // Refresh cache to ensure new user is available in cache
    await configCache.refreshCacheEntry('config/users.json');

    logger.info('Created new user', {
      component: 'AdminAuth',
      username,
      userId,
      authMethods: authMethods.join(', ')
    });

    logAudit({
      req,
      action: 'create',
      resource: 'user',
      resourceId: userId,
      summary: `Created user "${username}"`
    });

    // Return user without password hash
    const { passwordHash: _passwordHash, ...userResponse } = newUser;
    res.json(userResponse);
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
    const { userId } = req.params;

    // Validate userId for security (prevents prototype pollution)
    assertValidId(userId, 'user');

    // Additional hardening: explicitly block prototype-polluting keys
    if (userId === '__proto__' || userId === 'constructor' || userId === 'prototype') {
      throw new ServiceError('BAD_REQUEST', 'Invalid user ID');
    }

    const { email, name, password, internalGroups, active, usageLimits } = req.body;
    const limits = usageLimits === undefined ? null : parseUsageLimitsInput(usageLimits);
    if (limits && !limits.ok) throw new ServiceError('BAD_REQUEST', limits.error);

    if (password && password.length < 6) {
      throw new ServiceError('BAD_REQUEST', 'Password must be at least 6 characters long');
    }
    // Hashed before the lock (slow); the salt is the user id, so it needs no file data.
    const newPasswordHash = password ? await hashPasswordWithUserId(password, userId) : null;

    // Read, change and write run under the file lock; see the create route.
    let user;
    let deactivated = false;
    await configStore.updateJson(USERS_FILE, usersData => {
      if (!usersData) {
        throw new ServiceError('NOT_FOUND', 'Users file not found');
      }

      // Check if user exists
      if (!Object.hasOwn(usersData.users || {}, userId)) {
        throw new ServiceError('NOT_FOUND', 'User not found');
      }

      const target = usersData.users[userId];
      deactivated = active === false && target.active !== false;

      // Update fields
      if (email !== undefined) target.email = email;
      if (name !== undefined) target.name = name;
      if (internalGroups !== undefined)
        target.internalGroups = Array.isArray(internalGroups) ? internalGroups : [];
      if (active !== undefined) target.active = active;
      if (limits) {
        if (limits.value) target.usageLimits = limits.value;
        else delete target.usageLimits;
      }
      if (newPasswordHash) target.passwordHash = newPasswordHash;

      target.updatedAt = new Date().toISOString();
      if (!usersData.metadata) usersData.metadata = { version: '2.0.0' };
      usersData.metadata.lastUpdated = new Date().toISOString();
      user = target;
      return usersData;
    });

    // A new password ends a lockout from failed sign-ins.
    if (newPasswordHash) await clearFailedLogins(lockoutKey(user));

    // Refresh cache to ensure updated user data is available in cache
    await configCache.refreshCacheEntry('config/users.json');

    // A deactivated user's stored sign-in must not keep iFinder background
    // runs going (iFinder token exchange). Reactivating needs a new sign-in.
    if (deactivated) {
      try {
        await deleteLoginTokens(userId);
      } catch (error) {
        logger.warn('Could not delete stored sign-in tokens of a deactivated user', {
          component: 'AdminAuth',
          userId,
          error
        });
      }
    }

    logger.info('Updated user', { component: 'AdminAuth', username: user.username, userId });

    logAudit({
      req,
      action: 'update',
      resource: 'user',
      resourceId: userId,
      summary: `Updated user "${user.username}"`
    });

    // Return user without password hash

    const { passwordHash, ...userResponse } = user;
    res.json(userResponse);
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
    const { userId } = req.params;

    // Validate userId for security (prevents prototype pollution)
    assertValidId(userId, 'user');

    // Read, change and write run under the file lock; see the create route.
    let username;
    await configStore.updateJson(USERS_FILE, usersData => {
      if (!usersData) {
        throw new ServiceError('NOT_FOUND', 'Users file not found');
      }

      // Check if user exists
      if (!Object.hasOwn(usersData.users || {}, userId)) {
        throw new ServiceError('NOT_FOUND', 'User not found');
      }

      // Check if user is the last admin - prevent deletion
      if (isLastAdmin(userId)) {
        throw new ServiceError(
          'FORBIDDEN',
          'Cannot delete the last admin user. At least one admin user must exist in the system. Please assign admin rights to another user before deleting this account.'
        );
      }

      username = usersData.users[userId].username;

      // Remove user
      delete usersData.users[userId];
      if (!usersData.metadata) usersData.metadata = { version: '2.0.0' };
      usersData.metadata.lastUpdated = new Date().toISOString();
      return usersData;
    });

    // Refresh cache to ensure deleted user is removed from cache
    await configCache.refreshCacheEntry('config/users.json');

    logger.info('Deleted user', { component: 'AdminAuth', username, userId });

    logAudit({
      req,
      action: 'delete',
      resource: 'user',
      resourceId: userId,
      summary: `Deleted user "${username}"`
    });

    // The record is gone, which is what ended the user's access. What they
    // owned (connections, API keys, stored credentials, scheduled tasks, chats,
    // prompts, skills, short links) is removed in the background: a user with a
    // lot of chats should not make the admin wait. The outcome is audited, so a
    // step that failed is visible somewhere other than the server log.
    startUserCleanup({
      userId,
      platform: configCache.getPlatform() || {},
      onDone: ({ failed }) =>
        logAudit({
          req,
          action: 'cleanup',
          resource: 'user',
          resourceId: userId,
          result: failed.length > 0 ? 'failure' : 'success',
          summary:
            failed.length > 0
              ? `Removed what user "${username}" owned, except: ${failed.join(', ')}`
              : `Removed what user "${username}" owned`
        })
    });

    res.status(204).end();
  });
}
