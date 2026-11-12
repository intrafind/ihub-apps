// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The logging administration routes let errors propagate to the global error
 * middleware: an unreadable platform file or a failing dependency is a 500
 * that does not leak the cause. The routes have no validation branch (the body
 * is merged as is), so there is no BAD_REQUEST or NOT_FOUND case to cover.
 *
 * Native ESM, so `jest.unstable_mockModule` + dynamic imports. Run with
 * `NODE_OPTIONS=--experimental-vm-modules`.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const state = { platform: {}, written: null, refreshError: null };

jest.unstable_mockModule('../middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) => next()
}));
jest.unstable_mockModule('../services/config/ConfigStore.js', () => ({
  default: {
    // Same read-change-write the real store does for updateJson.
    updateJson: async (_path, mutate) => {
      const current = state.platform;
      const next = await mutate(current === null ? null : structuredClone(current));
      if (next === undefined) return { data: current, written: false };
      state.written = next;
      return { data: next, written: true };
    },
    readJson: async () => state.platform,
    writeJson: async (_path, data) => {
      state.written = data;
    }
  }
}));
jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    getPlatform: () => ({}),
    refreshCacheEntry: async () => {
      if (state.refreshError) throw state.refreshError;
    }
  }
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  default: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    reconfigureLogger: () => {}
  }
}));

const { default: registerAdminLoggingRoutes } = await import('../routes/admin/logging.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');

const app = express();
app.use(express.json());
registerAdminLoggingRoutes(app);
app.use(errorHandler);

beforeEach(() => {
  state.platform = { logging: { level: 'info' } };
  state.written = null;
  state.refreshError = null;
});

describe('logging administration routes: errors', () => {
  it('returns the default logging configuration', async () => {
    const res = await request(app).get('/api/admin/logging/config').expect(200);
    expect(res.body.level).toBe('info');
    expect(res.body.file.enabled).toBe(false);
  });

  it('merges and saves a logging configuration', async () => {
    const res = await request(app)
      .put('/api/admin/logging/config')
      .send({ level: 'debug' })
      .expect(200);
    expect(res.body.level).toBe('debug');
    expect(state.written.logging.level).toBe('debug');
  });

  it('answers an unreadable platform file with a 500 problem document', async () => {
    state.platform = null;
    const res = await request(app)
      .put('/api/admin/logging/config')
      .send({ level: 'debug' })
      .expect(500);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('platform.json');
    expect(state.written).toBeNull();
  });

  it('answers an unexpected failure with a 500 that does not leak the cause', async () => {
    state.refreshError = new Error('boom at /srv/secret/path');
    const res = await request(app)
      .put('/api/admin/logging/config')
      .send({ level: 'debug' })
      .expect(500);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('/srv/secret');
  });
});
