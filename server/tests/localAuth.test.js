import bcrypt from 'bcryptjs';
import fs from 'fs/promises';
import { jest } from '@jest/globals';
import os from 'os';
import path from 'path';
import { hashPasswordWithUserId, loginUser } from '../middleware/localAuth.js';

describe('localAuth loginUser timing protections', () => {
  let testDir;
  let usersFilePath;
  let localAuthConfig;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-auth-test-'));
    usersFilePath = path.join(testDir, 'users.json');

    const passwordHash = await hashPasswordWithUserId('correct-password', 'user_1');
    const usersConfig = {
      users: {
        user_1: {
          id: 'user_1',
          username: 'testuser',
          email: 'test@example.com',
          name: 'Test User',
          active: true,
          passwordHash,
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

  test('runs bcrypt.compare for missing and existing usernames', async () => {
    const compareSpy = jest.spyOn(bcrypt, 'compare');

    await expect(loginUser('missing-user', 'any-password', localAuthConfig)).rejects.toThrow(
      'Invalid credentials'
    );
    await expect(loginUser('testuser', 'wrong-password', localAuthConfig)).rejects.toThrow(
      'Invalid credentials'
    );

    expect(compareSpy).toHaveBeenCalledTimes(2);
    compareSpy.mockRestore();
  });
});
