import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { hasAnyAdmin, assignAdminGroup, isLastAdmin } from '../utils/adminRescue.js';

describe('adminRescue', () => {
  let tempDir;
  let usersFilePath;
  let originalConfigCache;

  beforeEach(async () => {
    // Create a temporary directory for test files
    tempDir = join(tmpdir(), `admin-rescue-test-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });
    usersFilePath = join(tempDir, 'users.json');

    // Mock configCache.getPlatform()
    const configCache = await import('../configCache.js');
    originalConfigCache = configCache.default.getPlatform;
    configCache.default.getPlatform = () => ({
      localAuth: { enabled: true },
      ldapAuth: { enabled: false },
      ntlmAuth: { enabled: false }
    });
  });

  afterEach(async () => {
    // Restore original configCache
    if (originalConfigCache) {
      const configCache = await import('../configCache.js');
      configCache.default.getPlatform = originalConfigCache;
    }

    // Clean up temporary files
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('hasAnyAdmin', () => {
    it('should return false when no users exist', async () => {
      // Create empty users file
      await fs.writeFile(
        usersFilePath,
        JSON.stringify({
          users: {},
          metadata: { version: '2.0.0' }
        })
      );

      const result = hasAnyAdmin(usersFilePath);
      assert.strictEqual(result, false);
    });

    it('should return false when users exist but none are admins', async () => {
      await fs.writeFile(
        usersFilePath,
        JSON.stringify({
          users: {
            user_1: {
              id: 'user_1',
              username: 'john',
              active: true,
              internalGroups: ['users'],
              passwordHash: 'hash'
            }
          },
          metadata: { version: '2.0.0' }
        })
      );

      const result = hasAnyAdmin(usersFilePath);
      assert.strictEqual(result, false);
    });

    it('should return true when an admin user exists', async () => {
      await fs.writeFile(
        usersFilePath,
        JSON.stringify({
          users: {
            user_1: {
              id: 'user_1',
              username: 'admin',
              active: true,
              internalGroups: ['admins'],
              passwordHash: 'hash'
            }
          },
          metadata: { version: '2.0.0' }
        })
      );

      const result = hasAnyAdmin(usersFilePath);
      assert.strictEqual(result, true);
    });

    it('should ignore inactive admin users', async () => {
      await fs.writeFile(
        usersFilePath,
        JSON.stringify({
          users: {
            user_1: {
              id: 'user_1',
              username: 'admin',
              active: false,
              internalGroups: ['admins'],
              passwordHash: 'hash'
            }
          },
          metadata: { version: '2.0.0' }
        })
      );

      const result = hasAnyAdmin(usersFilePath);
      assert.strictEqual(result, false);
    });

    it('should ignore local admin when localAuth is disabled', async () => {
      // Mock configCache to disable local auth (and all other external auths to isolate the test)
      const configCache = await import('../configCache.js');
      const originalGetPlatform = configCache.default.getPlatform;
      configCache.default.getPlatform = () => ({
        localAuth: { enabled: false },
        ntlmAuth: { enabled: false },
        ldapAuth: { enabled: false },
        oidcAuth: { enabled: false },
        proxyAuth: { enabled: false }
      });

      try {
        await fs.writeFile(
          usersFilePath,
          JSON.stringify({
            users: {
              user_1: {
                id: 'user_1',
                username: 'admin',
                active: true,
                internalGroups: ['admins'],
                passwordHash: 'hash'
                // No authMethods means legacy local user
              }
            },
            metadata: { version: '2.0.0' }
          })
        );

        // Local admin exists but localAuth is disabled, so no admin can login
        const result = hasAnyAdmin(usersFilePath);
        assert.strictEqual(result, false);
      } finally {
        configCache.default.getPlatform = originalGetPlatform;
      }
    });

    it('should find NTLM admin when NTLM is enabled', async () => {
      // Mock configCache to enable NTLM
      const configCache = await import('../configCache.js');
      const originalGetPlatform = configCache.default.getPlatform;
      configCache.default.getPlatform = () => ({
        localAuth: { enabled: false },
        ntlmAuth: { enabled: true }
      });

      try {
        await fs.writeFile(
          usersFilePath,
          JSON.stringify({
            users: {
              user_1: {
                id: 'user_1',
                username: 'ntlm-admin',
                active: true,
                internalGroups: ['admins'],
                authMethods: ['ntlm']
              }
            },
            metadata: { version: '2.0.0' }
          })
        );

        // NTLM admin exists and NTLM is enabled
        const result = hasAnyAdmin(usersFilePath);
        assert.strictEqual(result, true);
      } finally {
        configCache.default.getPlatform = originalGetPlatform;
      }
    });

    it('should ignore NTLM admin when NTLM is disabled', async () => {
      // Mock configCache to disable NTLM
      const configCache = await import('../configCache.js');
      const originalGetPlatform = configCache.default.getPlatform;
      configCache.default.getPlatform = () => ({
        localAuth: { enabled: true },
        ntlmAuth: { enabled: false }
      });

      try {
        await fs.writeFile(
          usersFilePath,
          JSON.stringify({
            users: {
              user_1: {
                id: 'user_1',
                username: 'ntlm-admin',
                active: true,
                internalGroups: ['admins'],
                authMethods: ['ntlm']
              }
            },
            metadata: { version: '2.0.0' }
          })
        );

        // NTLM admin exists but NTLM is disabled
        const result = hasAnyAdmin(usersFilePath);
        assert.strictEqual(result, false);
      } finally {
        configCache.default.getPlatform = originalGetPlatform;
      }
    });
  });

  describe('assignAdminGroup', () => {
    it('should assign admin group to user', async () => {
      await fs.writeFile(
        usersFilePath,
        JSON.stringify({
          users: {
            user_1: {
              id: 'user_1',
              username: 'john',
              active: true,
              internalGroups: ['users'],
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            }
          },
          metadata: { version: '2.0.0' }
        })
      );

      const result = await assignAdminGroup('user_1', usersFilePath);
      assert.strictEqual(result, true);

      // Verify user now has admin group
      const usersData = JSON.parse(await fs.readFile(usersFilePath, 'utf8'));
      assert.ok(usersData.users['user_1'].internalGroups.includes('admins'));
    });

    it('should return false if user already has admin group', async () => {
      await fs.writeFile(
        usersFilePath,
        JSON.stringify({
          users: {
            user_1: {
              id: 'user_1',
              username: 'admin',
              active: true,
              internalGroups: ['admins'],
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            }
          },
          metadata: { version: '2.0.0' }
        })
      );

      const result = await assignAdminGroup('user_1', usersFilePath);
      assert.strictEqual(result, false);
    });

    it('should return false if user does not exist', async () => {
      await fs.writeFile(
        usersFilePath,
        JSON.stringify({
          users: {},
          metadata: { version: '2.0.0' }
        })
      );

      const result = await assignAdminGroup('nonexistent_user', usersFilePath);
      assert.strictEqual(result, false);
    });
  });

  describe('isLastAdmin', () => {
    it('should return true if user is the only admin', async () => {
      await fs.writeFile(
        usersFilePath,
        JSON.stringify({
          users: {
            user_1: {
              id: 'user_1',
              username: 'admin',
              active: true,
              internalGroups: ['admins']
            }
          },
          metadata: { version: '2.0.0' }
        })
      );

      const result = isLastAdmin('user_1', usersFilePath);
      assert.strictEqual(result, true);
    });

    it('should return false if user is not an admin', async () => {
      await fs.writeFile(
        usersFilePath,
        JSON.stringify({
          users: {
            user_1: {
              id: 'user_1',
              username: 'john',
              active: true,
              internalGroups: ['users']
            }
          },
          metadata: { version: '2.0.0' }
        })
      );

      const result = isLastAdmin('user_1', usersFilePath);
      assert.strictEqual(result, false);
    });

    it('should return false if there are multiple admins', async () => {
      await fs.writeFile(
        usersFilePath,
        JSON.stringify({
          users: {
            user_1: {
              id: 'user_1',
              username: 'admin1',
              active: true,
              internalGroups: ['admins']
            },
            user_2: {
              id: 'user_2',
              username: 'admin2',
              active: true,
              internalGroups: ['admins']
            }
          },
          metadata: { version: '2.0.0' }
        })
      );

      const result = isLastAdmin('user_1', usersFilePath);
      assert.strictEqual(result, false);
    });

    it('should ignore inactive admins when counting', async () => {
      await fs.writeFile(
        usersFilePath,
        JSON.stringify({
          users: {
            user_1: {
              id: 'user_1',
              username: 'admin1',
              active: true,
              internalGroups: ['admins']
            },
            user_2: {
              id: 'user_2',
              username: 'admin2',
              active: false,
              internalGroups: ['admins']
            }
          },
          metadata: { version: '2.0.0' }
        })
      );

      const result = isLastAdmin('user_1', usersFilePath);
      assert.strictEqual(result, true);
    });
  });
});
