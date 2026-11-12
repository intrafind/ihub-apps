// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The admin user routes change users.json under the store's lock (#3638).
 *
 * They used to read the file, change it and write it back as separate steps, so
 * two requests that overlapped both started from the same old body and the
 * second write erased the first, with both requests answering success. The
 * in-memory store below applies `updateJson` one change at a time against the
 * latest body, like the real store; a plain `readJson` + `writeJson` pair on it
 * would lose updates exactly as the file did.
 *
 * Native-ESM jest; see the `test:auth-routes` npm script.
 */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import rateLimit from 'express-rate-limit';

const testRateLimiter = rateLimit({ windowMs: 60 * 1000, limit: 10000 });

const state = { users: null };

jest.unstable_mockModule('../services/config/ConfigStore.js', () => {
  let queue = Promise.resolve();
  // A tick between the read and the write is what lets an unlocked
  // read-modify-write interleave with another one.
  const tick = () => new Promise(resolve => setImmediate(resolve));
  return {
    default: {
      readJson: async () => {
        await tick();
        return structuredClone(state.users);
      },
      writeJson: async (_path, data) => {
        await tick();
        state.users = structuredClone(data);
      },
      updateJson: (_path, mutate) => {
        const run = queue.then(async () => {
          await tick();
          const current = structuredClone(state.users);
          const next = await mutate(current);
          if (next === undefined) return { data: current, written: false };
          state.users = structuredClone(next);
          return { data: next, written: true };
        });
        queue = run.catch(() => {});
        return run;
      }
    }
  };
});

jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    getPlatform: () => ({}),
    get: () => null,
    refreshCacheEntry: () => Promise.resolve(),
    setCacheEntry: () => undefined
  }
}));

jest.unstable_mockModule('../middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) => {
    req.user = { id: 'admin' };
    next();
  }
}));

jest.unstable_mockModule('../utils/adminRescue.js', () => ({
  isLastAdmin: () => false,
  ensureFirstUserIsAdmin: user => Promise.resolve(user)
}));

jest.unstable_mockModule('../services/AuditLogService.js', () => ({ logAudit: () => undefined }));
jest.unstable_mockModule('../services/userDeletion.js', () => ({ startUserCleanup: () => {} }));

const { default: registerAdminAuthRoutes } = await import('../routes/admin/auth.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');

const app = express();
app.use(testRateLimiter);
app.use(express.json());
registerAdminAuthRoutes(app);
app.use(errorHandler);

const create = (username, extra = {}) =>
  request(app)
    .post('/api/admin/auth/users')
    .send({ username, password: 'secret123', ...extra });

beforeEach(() => {
  state.users = { users: {}, metadata: { version: '2.0.0' } };
});

describe('admin user routes under concurrency (#3638)', () => {
  test('N parallel creates leave N users', async () => {
    const names = Array.from({ length: 12 }, (_, i) => `user${i}`);

    const responses = await Promise.all(names.map(name => create(name)));

    expect(responses.map(r => r.status)).toEqual(names.map(() => 200));
    const stored = Object.values(state.users.users).map(user => user.username);
    expect(stored.sort()).toEqual([...names].sort());
  });

  test('parallel creates of the same name, in different case, create one', async () => {
    const responses = await Promise.all([create('Dana'), create('dana'), create('DANA')]);

    expect(responses.map(r => r.status).sort()).toEqual([200, 409, 409]);
    expect(Object.keys(state.users.users)).toHaveLength(1);
  });

  test('creates the structure when there is no users file yet', async () => {
    state.users = null;

    const res = await create('first');

    expect(res.status).toBe(200);
    expect(Object.values(state.users.users).map(u => u.username)).toEqual(['first']);
    expect(state.users.metadata.version).toBe('2.0.0');
  });

  test('parallel updates of different users all land', async () => {
    const ids = Array.from({ length: 8 }, (_, i) => `user_${i}`);
    state.users.users = Object.fromEntries(
      ids.map(id => [id, { id, username: id, name: '', active: true }])
    );

    const responses = await Promise.all(
      ids.map(id =>
        request(app)
          .put(`/api/admin/auth/users/${id}`)
          .send({ name: `name-${id}` })
      )
    );

    expect(responses.map(r => r.status)).toEqual(ids.map(() => 200));
    for (const id of ids) expect(state.users.users[id].name).toBe(`name-${id}`);
  });

  test('an update stores a new password hash and never returns it', async () => {
    state.users.users.user_a = { id: 'user_a', username: 'a', passwordHash: 'old' };

    const res = await request(app)
      .put('/api/admin/auth/users/user_a')
      .send({ password: 'newsecret' });

    expect(res.status).toBe(200);
    expect(res.body.passwordHash).toBeUndefined();
    expect(state.users.users.user_a.passwordHash).not.toBe('old');
  });

  test('an update of an unknown user is a 404 and writes nothing', async () => {
    const before = structuredClone(state.users);

    const res = await request(app).put('/api/admin/auth/users/user_nobody').send({ name: 'x' });

    expect(res.status).toBe(404);
    expect(state.users).toEqual(before);
  });

  test('parallel deletes of different users all land', async () => {
    const ids = Array.from({ length: 8 }, (_, i) => `user_${i}`);
    state.users.users = Object.fromEntries(ids.map(id => [id, { id, username: id }]));

    const responses = await Promise.all(
      ids.slice(0, 6).map(id => request(app).delete(`/api/admin/auth/users/${id}`))
    );

    expect(responses.map(r => r.status)).toEqual(ids.slice(0, 6).map(() => 204));
    expect(Object.keys(state.users.users).sort()).toEqual(['user_6', 'user_7']);
  });

  test('a create and a delete at once both land', async () => {
    state.users.users = { user_old: { id: 'user_old', username: 'old' } };

    const [created, deleted] = await Promise.all([
      create('newcomer'),
      request(app).delete('/api/admin/auth/users/user_old')
    ]);

    expect(created.status).toBe(200);
    expect(deleted.status).toBe(204);
    expect(Object.values(state.users.users).map(u => u.username)).toEqual(['newcomer']);
  });
});
