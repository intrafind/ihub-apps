/**
 * Deleting a user from the admin API.
 *
 * Removing the record is what ends the user's access, so it is done before the
 * request answers. What the user owned is removed afterwards, in the
 * background: a user with a lot of chats must not make the admin wait, and the
 * outcome is written to the audit log, where a step that failed can be seen.
 *
 * Native-ESM jest; see the `test:auth-routes` npm script.
 */

import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import rateLimit from 'express-rate-limit';

const testRateLimiter = rateLimit({ windowMs: 60 * 1000, limit: 10000 });

const state = {
  users: null,
  written: null,
  lastAdmin: false,
  cleanup: null,
  audits: []
};

jest.unstable_mockModule('../services/config/ConfigStore.js', () => ({
  default: {
    readJson: () => Promise.resolve(structuredClone(state.users)),
    writeJson: (_path, data) => {
      state.written = structuredClone(data);
      return Promise.resolve();
    }
  }
}));

jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    getPlatform: () => ({ marker: 'platform' }),
    get: () => null,
    refreshCacheEntry: () => Promise.resolve(),
    setCacheEntry: () => undefined
  }
}));

jest.unstable_mockModule('../middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) => {
    req.user = { id: 'admin' };
    next();
  },
  isAdminAuthRequired: () => false
}));

jest.unstable_mockModule('../middleware/contentAdminAuth.js', () => ({
  isContentAdminAuthRequired: () => false
}));

jest.unstable_mockModule('../utils/adminRescue.js', () => ({
  isLastAdmin: () => state.lastAdmin,
  ensureFirstUserIsAdmin: user => Promise.resolve(user)
}));

jest.unstable_mockModule('../services/AuditLogService.js', () => ({
  logAudit: entry => state.audits.push(entry)
}));

jest.unstable_mockModule('../services/userDeletion.js', () => ({
  startUserCleanup: params => {
    state.cleanup = params;
  }
}));

const { default: registerAdminAuthRoutes } = await import('../routes/admin/auth.js');

function buildApp() {
  const app = express();
  app.use(testRateLimiter);
  app.use(express.json());
  registerAdminAuthRoutes(app);
  return app;
}

const del = userId => request(buildApp()).delete(`/api/admin/auth/users/${userId}`);

beforeEach(() => {
  state.users = {
    users: {
      user_alice: { id: 'user_alice', username: 'alice' },
      user_bob: { id: 'user_bob', username: 'bob' }
    },
    metadata: {}
  };
  state.written = null;
  state.lastAdmin = false;
  state.cleanup = null;
  state.audits = [];
});

describe('DELETE /api/admin/auth/users/:userId', () => {
  test('removes the record and answers without waiting for the cleanup', async () => {
    const res = await del('user_alice');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'User deleted successfully' });
    expect(Object.keys(state.written.users)).toEqual(['user_bob']);
  });

  test('starts the cleanup of what the user owned, for that user', async () => {
    await del('user_alice');

    expect(state.cleanup).toMatchObject({ userId: 'user_alice', platform: { marker: 'platform' } });
  });

  test('audits the cleanup when it is done, naming what it could not remove', async () => {
    await del('user_alice');

    state.cleanup.onDone({ results: {}, failed: [] });
    state.cleanup.onDone({ results: {}, failed: ['chats', 'shortLinks'] });

    const cleanups = state.audits.filter(entry => entry.action === 'cleanup');
    expect(cleanups).toHaveLength(2);
    expect(cleanups[0]).toMatchObject({ resourceId: 'user_alice', result: 'success' });
    expect(cleanups[1]).toMatchObject({ resourceId: 'user_alice', result: 'failure' });
    expect(cleanups[1].summary).toContain('chats, shortLinks');
  });

  test('cleans up nothing for a user that does not exist', async () => {
    const res = await del('user_nobody');

    expect(res.status).toBe(404);
    expect(state.cleanup).toBeNull();
    expect(state.written).toBeNull();
  });

  test('cleans up nothing, and deletes nothing, for the last admin', async () => {
    state.lastAdmin = true;

    const res = await del('user_alice');

    expect(res.status).toBe(403);
    expect(state.cleanup).toBeNull();
    expect(state.written).toBeNull();
  });
});
