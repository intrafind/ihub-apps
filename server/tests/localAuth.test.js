import bcrypt from 'bcryptjs';
import fs from 'fs/promises';
import { jest } from '@jest/globals';
import os from 'os';
import path from 'path';

// Successful logins also go through JWT signing and the first-user-admin-rescue
// check; neither is relevant to username matching, so keep them out of the way
// with lightweight, deterministic stand-ins.
jest.unstable_mockModule('../configCache.js', () => ({
  __esModule: true,
  default: {
    getPlatform: () => ({
      jwt: { algorithm: 'HS256' },
      auth: { jwtSecret: 'test-secret-key' },
      localAuth: { enabled: true }
    }),
    get: () => ({ data: null, etag: null }),
    setCacheEntry: () => {}
  }
}));
jest.unstable_mockModule('../utils/adminRescue.js', () => ({
  __esModule: true,
  ensureFirstUserIsAdmin: async user => user
}));

const { loginUser, createUser } = await import('../middleware/localAuth.js');
const { hashPasswordWithUserId } = await import('../utils/userManager.js');

describe('localAuth loginUser timing protections', () => {
  const expectedDummyHash = '$2a$12$n6wyln4ERyOHBD6UAx2fAOkt0F7nX0x6X2ZiYAbBVvK7i7diOaJjG';
  let testDir;
  let usersFilePath;
  let localAuthConfig;
  let storedPasswordHash;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-auth-test-'));
    usersFilePath = path.join(testDir, 'users.json');

    storedPasswordHash = await hashPasswordWithUserId('correct-password', 'user_1');
    const usersConfig = {
      users: {
        user_1: {
          id: 'user_1',
          username: 'testuser',
          email: 'test@example.com',
          name: 'Test User',
          active: true,
          passwordHash: storedPasswordHash,
          internalGroups: ['user']
        }
      }
    };

    await fs.writeFile(usersFilePath, JSON.stringify(usersConfig, null, 2), 'utf8');
    localAuthConfig = { usersFile: usersFilePath, sessionTimeoutMinutes: 480 };
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  test('prevents timing-based username enumeration for invalid logins', async () => {
    const compareSpy = jest.spyOn(bcrypt, 'compare');

    await expect(loginUser('missing-user', 'any-password', localAuthConfig)).rejects.toThrow(
      'Invalid credentials'
    );
    await expect(loginUser('testuser', 'wrong-password', localAuthConfig)).rejects.toThrow(
      'Invalid credentials'
    );

    expect(compareSpy).toHaveBeenCalledTimes(2);
    expect(compareSpy).toHaveBeenNthCalledWith(
      1,
      'nonexistent-user:any-password',
      expectedDummyHash
    );
    expect(compareSpy).toHaveBeenNthCalledWith(2, 'user_1:wrong-password', storedPasswordHash);
    compareSpy.mockRestore();
  });
});

describe('localAuth loginUser case-insensitive matching', () => {
  let testDir;
  let usersFilePath;
  let localAuthConfig;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-auth-test-'));
    usersFilePath = path.join(testDir, 'users.json');

    const storedPasswordHash = await hashPasswordWithUserId('correct-password', 'user_1');
    const usersConfig = {
      users: {
        user_1: {
          id: 'user_1',
          username: 'Daniel.Manzke',
          email: 'Daniel.Manzke@example.com',
          name: 'Daniel Manzke',
          active: true,
          passwordHash: storedPasswordHash,
          internalGroups: ['user']
        }
      }
    };

    await fs.writeFile(usersFilePath, JSON.stringify(usersConfig, null, 2), 'utf8');
    localAuthConfig = { usersFile: usersFilePath, sessionTimeoutMinutes: 480 };
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  test('logs in when the typed username differs in case from the stored username', async () => {
    const result = await loginUser('daniel.manzke', 'correct-password', localAuthConfig);
    expect(result.user.id).toBe('user_1');
    expect(result.user.username).toBe('Daniel.Manzke');
    expect(result.token).toBeDefined();
  });

  test('logs in when the typed email differs in case from the stored email', async () => {
    const result = await loginUser(
      'DANIEL.MANZKE@EXAMPLE.COM',
      'correct-password',
      localAuthConfig
    );
    expect(result.user.id).toBe('user_1');
  });

  test('still rejects an unrelated username regardless of case', async () => {
    await expect(loginUser('someone.else', 'correct-password', localAuthConfig)).rejects.toThrow(
      'Invalid credentials'
    );
  });
});

describe('localAuth createUser case-insensitive uniqueness', () => {
  let testDir;
  let usersFilePath;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-auth-create-test-'));
    usersFilePath = path.join(testDir, 'users.json');

    const usersConfig = {
      users: {
        user_1: {
          id: 'user_1',
          username: 'Daniel.Manzke',
          email: 'Daniel.Manzke@example.com',
          name: 'Daniel Manzke',
          active: true,
          passwordHash: 'irrelevant-for-this-test',
          internalGroups: ['user']
        }
      }
    };

    await fs.writeFile(usersFilePath, JSON.stringify(usersConfig, null, 2), 'utf8');
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  test('rejects a new username that differs only in case from an existing one', async () => {
    await expect(
      createUser(
        {
          username: 'daniel.manzke',
          email: 'other@example.com',
          password: 'password123',
          name: 'Someone Else'
        },
        usersFilePath
      )
    ).rejects.toThrow('User with this username or email already exists');
  });

  test('rejects a new email that differs only in case from an existing one', async () => {
    await expect(
      createUser(
        {
          username: 'someone-else',
          email: 'daniel.manzke@example.com',
          password: 'password123',
          name: 'Someone Else'
        },
        usersFilePath
      )
    ).rejects.toThrow('User with this username or email already exists');
  });
});
