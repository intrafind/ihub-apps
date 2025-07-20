import { promises as fs } from 'fs';
import { join } from 'path';
import { getRootDir } from '../../pathUtils.js';
import { atomicWriteJSON } from '../../utils/atomicWrite.js';
import configCache from '../../configCache.js';
import { adminAuth, isAdminAuthRequired, hashPassword } from '../../middleware/adminAuth.js';
import { hashPasswordWithUserId } from '../../middleware/localAuth.js';
import { v4 as uuidv4 } from 'uuid';

export default function registerAdminAuthRoutes(app) {
  app.get('/api/admin/auth/status', async (req, res) => {
    try {
      // Check if admin auth is required considering current user authentication
      // req.user is populated by the global auth middleware (proxyAuth, localAuth)
      const authRequired = isAdminAuthRequired(req);

      res.json({
        authRequired,
        authenticated: !authRequired || req.headers.authorization?.startsWith('Bearer ')
      });
    } catch (error) {
      console.error('Error checking admin auth status:', error);
      res.status(500).json({ error: 'Failed to check authentication status' });
    }
  });

  app.get('/api/admin/auth/test', adminAuth, async (req, res) => {
    try {
      res.json({ message: 'Admin authentication successful', authenticated: true });
    } catch (error) {
      console.error('Error testing admin auth:', error);
      res.status(500).json({ error: 'Failed to test authentication' });
    }
  });

  app.post('/api/admin/auth/change-password', adminAuth, async (req, res) => {
    try {
      const { newPassword } = req.body;
      if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 1) {
        return res.status(400).json({ error: 'New password is required' });
      }
      const rootDir = getRootDir();
      const platformConfigPath = join(rootDir, 'contents', 'config', 'platform.json');
      const platformConfigData = await fs.readFile(platformConfigPath, 'utf8');
      const platformConfig = JSON.parse(platformConfigData);
      if (!platformConfig.admin) {
        platformConfig.admin = {};
      }
      const hashedPassword = hashPassword(newPassword);
      platformConfig.admin.secret = hashedPassword;
      platformConfig.admin.encrypted = true;
      await atomicWriteJSON(platformConfigPath, platformConfig);
      await configCache.refreshCacheEntry('config/platform.json');
      console.log('🔐 Admin password changed and encrypted');
      res.json({ message: 'Admin password changed successfully', encrypted: true });
    } catch (error) {
      console.error('Error changing admin password:', error);
      res.status(500).json({ error: 'Failed to change admin password' });
    }
  });

  // User Management Routes

  /**
   * Get all users
   */
  app.get('/api/admin/auth/users', adminAuth, async (req, res) => {
    try {
      const rootDir = getRootDir();
      const usersFilePath = join(rootDir, 'contents', 'config', 'users.json');

      let usersData = { users: {}, metadata: {} };
      try {
        const usersFileData = await fs.readFile(usersFilePath, 'utf8');
        usersData = JSON.parse(usersFileData);
      } catch (error) {
        // File doesn't exist or is invalid, return empty users
        console.log('Users file not found or invalid, returning empty list');
      }

      res.json(usersData);
    } catch (error) {
      console.error('Error getting users:', error);
      res.status(500).json({ error: 'Failed to get users' });
    }
  });

  /**
   * Create a new user
   */
  app.post('/api/admin/auth/users', adminAuth, async (req, res) => {
    try {
      const { username, email, name, password, groups = [], active = true } = req.body;

      if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required' });
      }

      if (password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters long' });
      }

      const rootDir = getRootDir();
      const usersFilePath = join(rootDir, 'contents', 'config', 'users.json');

      // Load existing users
      let usersData = { users: {}, metadata: {} };
      try {
        const usersFileData = await fs.readFile(usersFilePath, 'utf8');
        usersData = JSON.parse(usersFileData);
      } catch (error) {
        // File doesn't exist, create new structure
        usersData = {
          users: {},
          metadata: {
            version: '2.0.0',
            description: 'Local user database for AI Hub Apps',
            passwordHashingMethod: 'bcrypt + userId salt'
          }
        };
      }

      // Check if username already exists
      const existingUser = Object.values(usersData.users).find(user => user.username === username);
      if (existingUser) {
        return res.status(400).json({ error: 'Username already exists' });
      }

      // Create new user
      const userId = `user_${uuidv4().replace(/-/g, '_')}`;
      const passwordHash = await hashPasswordWithUserId(password, userId);

      const newUser = {
        id: userId,
        username,
        email: email || '',
        name: name || '',
        groups: Array.isArray(groups) ? groups : [],
        active,
        passwordHash,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      usersData.users[userId] = newUser;
      usersData.metadata.lastUpdated = new Date().toISOString();

      // Save to file
      await atomicWriteJSON(usersFilePath, usersData);

      console.log(`👤 Created new user: ${username} (${userId})`);

      // Return user without password hash
      const { passwordHash: _, ...userResponse } = newUser;
      res.json({ user: userResponse });
    } catch (error) {
      console.error('Error creating user:', error);
      res.status(500).json({ error: 'Failed to create user' });
    }
  });

  /**
   * Update a user
   */
  app.put('/api/admin/auth/users/:userId', adminAuth, async (req, res) => {
    try {
      const { userId } = req.params;
      const { email, name, password, groups, active } = req.body;

      const rootDir = getRootDir();
      const usersFilePath = join(rootDir, 'contents', 'config', 'users.json');

      // Load existing users
      let usersData = { users: {}, metadata: {} };
      try {
        const usersFileData = await fs.readFile(usersFilePath, 'utf8');
        usersData = JSON.parse(usersFileData);
      } catch (error) {
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
      if (groups !== undefined) user.groups = Array.isArray(groups) ? groups : [];
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

      console.log(`👤 Updated user: ${user.username} (${userId})`);

      // Return user without password hash
      const { passwordHash: _, ...userResponse } = user;
      res.json({ user: userResponse });
    } catch (error) {
      console.error('Error updating user:', error);
      res.status(500).json({ error: 'Failed to update user' });
    }
  });

  /**
   * Delete a user
   */
  app.delete('/api/admin/auth/users/:userId', adminAuth, async (req, res) => {
    try {
      const { userId } = req.params;

      const rootDir = getRootDir();
      const usersFilePath = join(rootDir, 'contents', 'config', 'users.json');

      // Load existing users
      let usersData = { users: {}, metadata: {} };
      try {
        const usersFileData = await fs.readFile(usersFilePath, 'utf8');
        usersData = JSON.parse(usersFileData);
      } catch (error) {
        return res.status(404).json({ error: 'Users file not found' });
      }

      // Check if user exists
      if (!usersData.users[userId]) {
        return res.status(404).json({ error: 'User not found' });
      }

      const username = usersData.users[userId].username;

      // Remove user
      delete usersData.users[userId];
      usersData.metadata.lastUpdated = new Date().toISOString();

      // Save to file
      await atomicWriteJSON(usersFilePath, usersData);

      console.log(`👤 Deleted user: ${username} (${userId})`);

      res.json({ message: 'User deleted successfully' });
    } catch (error) {
      console.error('Error deleting user:', error);
      res.status(500).json({ error: 'Failed to delete user' });
    }
  });
}
