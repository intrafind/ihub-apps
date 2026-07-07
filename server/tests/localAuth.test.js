import bcrypt from 'bcryptjs';
import fs from 'fs/promises';
import { jest } from '@jest/globals';
import os from 'os';
import path from 'path';
import { loginUser } from '../middleware/localAuth.js';
import { hashPasswordWithUserId } from '../utils/userManager.js';

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
