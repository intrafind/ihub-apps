/**
 * Local sign-in locks an account after repeated failed attempts
 * (`platform.localAuth.lockout`, utils/loginLockout.js). While it is locked,
 * sign-in is refused without checking the password; a successful sign-in or a
 * new password clears the count. A name without an account is counted the
 * same way, so a lock says nothing about whether the account exists. Each
 * attempt reserves a slot before its password is checked, so attempts sent in
 * parallel are held to the same limit, and in cluster mode the primary holds
 * the one table all workers use.
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

// The cluster bus is replaced by a stand-in. The handlers the module registers
// for the primary are captured; `cluster.worker` decides whether calls go to
// "the primary" (those handlers, reached through `request`) or to this
// process's own table.
const cluster = { worker: false, primaryAnswers: true };
const primaryHandlers = new Map();
const busRequests = [];
const realBus = await import('../clusterBus.js');
jest.unstable_mockModule('../clusterBus.js', () => ({
  __esModule: true,
  ...realBus,
  isClusterBusActive: () => cluster.worker,
  respondInPrimary: (type, handler) => primaryHandlers.set(type, handler),
  request: async (type, payload) => {
    busRequests.push({ type, payload });
    return cluster.primaryAnswers ? primaryHandlers.get(type)(payload) : null;
  }
}));
const realCluster = (await import('node:cluster')).default;
jest.unstable_mockModule('node:cluster', () => ({
  __esModule: true,
  default: new Proxy(realCluster, {
    get: (target, prop) => (prop === 'isPrimary' ? !cluster.worker : Reflect.get(target, prop))
  })
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
  lockoutKey,
  reserveLoginAttempt,
  resetLoginLockouts,
  resolveLockoutConfig,
  settleLoginAttempt
} = await import('../utils/loginLockout.js');

const MINUTE = 60 * 1000;

beforeEach(() => {
  resetLoginLockouts();
  cluster.worker = false;
  cluster.primaryAnswers = true;
  busRequests.length = 0;
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

describe('reserving and settling attempts', () => {
  const config = { maxAttempts: 3, durationMs: 15 * MINUTE };
  const fail = async (key, now) => {
    const { waitMs, shared } = await reserveLoginAttempt(key, config, now);
    if (waitMs === 0) await settleLoginAttempt(key, config, false, shared, now);
    return waitMs;
  };

  test('locks after the configured number of failures, for the configured time', async () => {
    const now = 1_000_000;
    expect(await fail('user:a', now)).toBe(0);
    expect(await fail('user:a', now + 1)).toBe(0);
    expect(await fail('user:a', now + 2)).toBe(0);
    expect((await reserveLoginAttempt('user:a', config, now + 2)).waitMs).toBe(15 * MINUTE);
    expect((await reserveLoginAttempt('user:a', config, now + 2 + 15 * MINUTE)).waitMs).toBe(0);
  });

  test('failures older than the window start a new count', async () => {
    const now = 1_000_000;
    await fail('user:a', now);
    await fail('user:a', now + 1);
    expect(await fail('user:a', now + 16 * MINUTE)).toBe(0);
    expect((await reserveLoginAttempt('user:a', config, now + 16 * MINUTE)).waitMs).toBe(0);
  });

  test('attempts still in flight count against the limit', async () => {
    const now = 1_000_000;
    for (let i = 0; i < 3; i++) {
      expect((await reserveLoginAttempt('user:a', config, now)).waitMs).toBe(0);
    }
    expect((await reserveLoginAttempt('user:a', config, now)).waitMs).toBeGreaterThan(0);
    // One of them succeeds: its slot is released and counting starts afresh,
    // while the two others are still in flight.
    await settleLoginAttempt('user:a', config, true, false, now);
    expect((await reserveLoginAttempt('user:a', config, now)).waitMs).toBe(0);
    expect((await reserveLoginAttempt('user:a', config, now)).waitMs).toBeGreaterThan(0);
  });

  test('clearing ends a lock', async () => {
    const now = Date.now();
    for (let i = 0; i < 3; i++) await fail('user:a', now);
    expect((await reserveLoginAttempt('user:a', config, now)).waitMs).toBeGreaterThan(0);
    await clearFailedLogins('user:a');
    expect((await reserveLoginAttempt('user:a', config, now)).waitMs).toBe(0);
  });

  test('counts per account, or per typed name when there is no account', () => {
    expect(lockoutKey({ id: 'user_1' }, 'TestUser')).toBe('user:user_1');
    expect(lockoutKey(undefined, 'Nobody')).toBe('name:nobody');
  });
});

describe('lockout in cluster mode', () => {
  const config = { maxAttempts: 3, durationMs: 15 * MINUTE };

  test('a worker reserves and settles through the primary', async () => {
    cluster.worker = true;
    const reservation = await reserveLoginAttempt('user:a', config);
    expect(reservation).toEqual({ waitMs: 0, shared: true });
    await settleLoginAttempt('user:a', config, false, true);
    await clearFailedLogins('user:a');
    expect(busRequests).toEqual([
      {
        type: 'loginLockout:reserve',
        payload: { key: 'user:a', maxAttempts: 3, durationMs: 15 * MINUTE }
      },
      {
        type: 'loginLockout:settle',
        payload: { key: 'user:a', maxAttempts: 3, durationMs: 15 * MINUTE, succeeded: false }
      },
      { type: 'loginLockout:clear', payload: { key: 'user:a' } }
    ]);
  });

  test("the primary's table holds the limit for every worker", async () => {
    cluster.worker = true;
    for (let i = 0; i < 3; i++) {
      const { shared } = await reserveLoginAttempt('user:a', config);
      await settleLoginAttempt('user:a', config, false, shared);
    }
    const locked = await reserveLoginAttempt('user:a', config);
    expect(locked.shared).toBe(true);
    expect(locked.waitMs).toBeGreaterThan(14 * MINUTE);
  });

  test('without an answer from the primary a worker uses its own table', async () => {
    cluster.worker = true;
    cluster.primaryAnswers = false;
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      const { waitMs, shared } = await reserveLoginAttempt('user:a', config, now);
      expect({ waitMs, shared }).toEqual({ waitMs: 0, shared: false });
      await settleLoginAttempt('user:a', config, false, shared, now);
    }
    expect((await reserveLoginAttempt('user:a', config, now)).waitMs).toBe(15 * MINUTE);
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

  test('attempts sent in parallel are held to the limit', async () => {
    const compareSpy = jest.spyOn(bcrypt, 'compare');
    try {
      const results = await Promise.allSettled(
        Array.from({ length: 10 }, () => loginUser('testuser', 'wrong-password', localAuthConfig))
      );
      expect(compareSpy).toHaveBeenCalledTimes(3);
      expect(results.filter(r => r.reason instanceof LoginLockedError)).toHaveLength(7);
    } finally {
      compareSpy.mockRestore();
    }
    await expect(loginUser('testuser', 'correct-password', localAuthConfig)).rejects.toBeInstanceOf(
      LoginLockedError
    );
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

  test('a right password on a disabled account does not clear the count', async () => {
    await failTimes('testuser', 2);
    const setActive = async active => {
      const data = JSON.parse(await fs.readFile(localAuthConfig.usersFile, 'utf8'));
      data.users.user_1.active = active;
      await fs.writeFile(localAuthConfig.usersFile, JSON.stringify(data), 'utf8');
    };
    await setActive(false);
    await expect(loginUser('testuser', 'correct-password', localAuthConfig)).rejects.toThrow(
      'Account is disabled'
    );
    await setActive(true);
    await expect(loginUser('testuser', 'correct-password', localAuthConfig)).rejects.toBeInstanceOf(
      LoginLockedError
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
