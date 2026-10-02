/**
 * Local sign-in locks an account after repeated failed attempts
 * (`platform.localAuth.lockout`, utils/loginLockout.js). While it is locked,
 * sign-in is refused without checking the password; a successful sign-in or a
 * new password clears the count. A name without an account is counted the
 * same way, so a lock says nothing about whether the account exists.
 */
import bcrypt from 'bcryptjs';
import fs from 'fs/promises';
import { jest } from '@jest/globals';
import os from 'os';
import path from 'path';

// Successful logins also go through JWT signing and the first-user admin
// rescue; neither matters here. The route test points `localAuth` at its own
// users file.
const platform = {
  jwt: { algorithm: 'HS256' },
  auth: { jwtSecret: 'test-secret-key' },
  localAuth: { enabled: true }
};
jest.unstable_mockModule('../configCache.js', () => ({
  __esModule: true,
  default: {
    getPlatform: () => platform,
    get: () => ({ data: null, etag: null }),
    setCacheEntry: () => {}
  }
}));
// The cluster bus is replaced by a recorder: what this worker publishes is
// captured, and messages "from another worker" are delivered by hand.
const published = [];
const busHandlers = new Map();
jest.unstable_mockModule('../clusterBus.js', () => ({
  __esModule: true,
  publish: (type, payload) => published.push({ type, payload }),
  subscribe: (type, handler) => busHandlers.set(type, handler)
}));
jest.unstable_mockModule('../utils/adminRescue.js', () => ({
  __esModule: true,
  ensureFirstUserIsAdmin: async user => user
}));

const { default: express } = await import('express');
const { default: request } = await import('supertest');
const { loginUser } = await import('../middleware/localAuth.js');
const { default: registerAuthRoutes } = await import('../routes/auth.js');
const {
  LoginLockedError,
  clearFailedLogins,
  lockedForMs,
  lockoutKey,
  recordFailedLogin,
  resetLoginLockouts,
  resolveLockoutConfig
} = await import('../utils/loginLockout.js');

const MINUTE = 60 * 1000;

beforeEach(() => {
  resetLoginLockouts();
  published.length = 0;
});

describe('resolveLockoutConfig', () => {
  test('defaults to 5 attempts and 15 minutes, enabled', () => {
    expect(resolveLockoutConfig({})).toEqual({
      enabled: true,
      maxAttempts: 5,
      durationMs: 15 * MINUTE
    });
  });

  test('uses configured values and ignores invalid ones', () => {
    expect(
      resolveLockoutConfig({ lockout: { enabled: false, maxAttempts: 3, durationMinutes: 2 } })
    ).toEqual({ enabled: false, maxAttempts: 3, durationMs: 2 * MINUTE });
    expect(resolveLockoutConfig({ lockout: { maxAttempts: 0, durationMinutes: 'x' } })).toEqual({
      enabled: true,
      maxAttempts: 5,
      durationMs: 15 * MINUTE
    });
  });
});

describe('failed sign-in counting', () => {
  const config = { maxAttempts: 3, durationMs: 15 * MINUTE };

  test('locks after the configured number of failures, for the configured time', () => {
    const now = 1_000_000;
    expect(recordFailedLogin('user:a', config, now)).toBe(false);
    expect(recordFailedLogin('user:a', config, now + 1)).toBe(false);
    expect(lockedForMs('user:a', now + 2)).toBe(0);
    expect(recordFailedLogin('user:a', config, now + 2)).toBe(true);
    expect(lockedForMs('user:a', now + 2)).toBe(15 * MINUTE);
    expect(lockedForMs('user:a', now + 2 + 15 * MINUTE)).toBe(0);
  });

  test('failures older than the window start a new count', () => {
    const now = 1_000_000;
    recordFailedLogin('user:a', config, now);
    recordFailedLogin('user:a', config, now + 1);
    expect(recordFailedLogin('user:a', config, now + 16 * MINUTE)).toBe(false);
    expect(lockedForMs('user:a', now + 16 * MINUTE)).toBe(0);
  });

  test('clearing ends a lock', () => {
    const now = Date.now();
    for (let i = 0; i < 3; i++) recordFailedLogin('user:a', config, now);
    expect(lockedForMs('user:a', now)).toBeGreaterThan(0);
    clearFailedLogins('user:a');
    expect(lockedForMs('user:a', now)).toBe(0);
  });

  test('counts per account, or per typed name when there is no account', () => {
    expect(lockoutKey({ id: 'user_1' }, 'TestUser')).toBe('user:user_1');
    expect(lockoutKey(undefined, 'Nobody')).toBe('name:nobody');
  });
});

describe('lockout across cluster workers', () => {
  const config = { maxAttempts: 3, durationMs: 15 * MINUTE };

  test('a failure here is published to the other workers', () => {
    recordFailedLogin('user:a', config, 1_000);
    clearFailedLogins('user:a');
    expect(published).toEqual([
      {
        type: 'loginLockout:failure',
        payload: { key: 'user:a', now: 1_000, maxAttempts: 3, durationMs: 15 * MINUTE }
      },
      { type: 'loginLockout:clear', payload: { key: 'user:a' } }
    ]);
  });

  test('failures on other workers count here too', () => {
    const now = Date.now();
    const remoteFailure = busHandlers.get('loginLockout:failure');
    remoteFailure({ key: 'user:a', now, maxAttempts: 3, durationMs: 15 * MINUTE });
    remoteFailure({ key: 'user:a', now, maxAttempts: 3, durationMs: 15 * MINUTE });
    expect(recordFailedLogin('user:a', config, now)).toBe(true);
    expect(lockedForMs('user:a', now)).toBe(15 * MINUTE);

    busHandlers.get('loginLockout:clear')({ key: 'user:a' });
    expect(lockedForMs('user:a', now)).toBe(0);
  });
});

describe('loginUser with lockout', () => {
  let testDir;
  let localAuthConfig;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'login-lockout-test-'));
    const usersFile = path.join(testDir, 'users.json');
    // A cheap hash keeps the test fast; the format is the one hashPasswordWithUserId writes.
    const passwordHash = await bcrypt.hash('user_1:correct-password', 4);
    await fs.writeFile(
      usersFile,
      JSON.stringify({
        users: {
          user_1: {
            id: 'user_1',
            username: 'testuser',
            email: 'test@example.com',
            active: true,
            passwordHash,
            internalGroups: ['users']
          }
        }
      }),
      'utf8'
    );
    localAuthConfig = { usersFile, lockout: { maxAttempts: 3, durationMinutes: 15 } };
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  const failTimes = async (name, times) => {
    for (let i = 0; i < times; i++) {
      await expect(loginUser(name, 'wrong-password', localAuthConfig)).rejects.toThrow(
        'Invalid credentials'
      );
    }
  };

  test('refuses the right password while the account is locked, without checking it', async () => {
    await failTimes('testuser', 3);
    const compareSpy = jest.spyOn(bcrypt, 'compare');
    try {
      const attempt = loginUser('testuser', 'correct-password', localAuthConfig);
      await expect(attempt).rejects.toBeInstanceOf(LoginLockedError);
      await expect(attempt).rejects.toMatchObject({ retryAfterSeconds: 15 * 60 });
      expect(compareSpy).not.toHaveBeenCalled();
    } finally {
      compareSpy.mockRestore();
    }
  });

  test('username and email share one count', async () => {
    await failTimes('testuser', 2);
    await failTimes('TEST@example.com', 1);
    await expect(loginUser('testuser', 'correct-password', localAuthConfig)).rejects.toBeInstanceOf(
      LoginLockedError
    );
  });

  test('a name without an account is locked the same way', async () => {
    await failTimes('nobody', 3);
    await expect(loginUser('nobody', 'any-password', localAuthConfig)).rejects.toBeInstanceOf(
      LoginLockedError
    );
  });

  test('a successful sign-in resets the count', async () => {
    await failTimes('testuser', 2);
    const result = await loginUser('testuser', 'correct-password', localAuthConfig);
    expect(result.user.id).toBe('user_1');
    await failTimes('testuser', 2);
    await expect(loginUser('testuser', 'correct-password', localAuthConfig)).resolves.toMatchObject(
      { user: { id: 'user_1' } }
    );
  });

  test('never locks when lockout is disabled', async () => {
    localAuthConfig.lockout = { enabled: false, maxAttempts: 3 };
    await failTimes('testuser', 5);
    await expect(loginUser('testuser', 'correct-password', localAuthConfig)).resolves.toMatchObject(
      { user: { id: 'user_1' } }
    );
  });
});

describe('POST /api/auth/local/login while an account is locked', () => {
  let testDir;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'login-lockout-route-'));
    const usersFile = path.join(testDir, 'users.json');
    const passwordHash = await bcrypt.hash('user_1:correct-password', 4);
    await fs.writeFile(
      usersFile,
      JSON.stringify({
        users: { user_1: { id: 'user_1', username: 'testuser', active: true, passwordHash } }
      }),
      'utf8'
    );
    platform.localAuth = {
      enabled: true,
      usersFile,
      lockout: { maxAttempts: 2, durationMinutes: 10 }
    };
  });

  afterEach(async () => {
    platform.localAuth = { enabled: true };
    await fs.rm(testDir, { recursive: true, force: true });
  });

  test('answers 429 with Retry-After once the limit is reached', async () => {
    const app = express();
    app.use(express.json());
    registerAuthRoutes(app);
    const attempt = password =>
      request(app).post('/api/auth/local/login').send({ username: 'testuser', password });

    expect((await attempt('wrong-password')).status).toBe(401);
    expect((await attempt('wrong-password')).status).toBe(401);
    const locked = await attempt('correct-password');
    expect(locked.status).toBe(429);
    expect(locked.headers['retry-after']).toBe(String(10 * 60));
    expect(locked.body.error).toBe('Too many failed sign-in attempts. Try again in 10 minutes.');
  });
});
