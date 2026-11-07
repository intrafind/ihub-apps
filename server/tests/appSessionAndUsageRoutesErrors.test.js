// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The session start and own-usage routes answer errors through the global error
 * middleware (RFC 9457 problem+json with a registry `code`).
 *
 * Run with `NODE_OPTIONS=--experimental-vm-modules`.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const state = {
  logFails: false,
  logged: null,
  quotaFails: false,
  repoAvailable: true,
  repoFails: false
};

jest.unstable_mockModule('../utils.js', () => ({
  logNewSession: async (...args) => {
    if (state.logFails) throw new Error('disk exploded');
    state.logged = args;
  }
}));
jest.unstable_mockModule('../middleware/authRequired.js', () => ({
  authOptional: (req, res, next) => next(),
  authRequired: (req, res, next) => {
    req.user = { id: 'u1', groups: ['users'], permissions: {} };
    next();
  }
}));
jest.unstable_mockModule('../configCache.js', () => ({
  default: { getPlatform: () => ({ defaultLanguage: 'en' }) }
}));
jest.unstable_mockModule('../services/quota/quotaService.js', () => ({
  getQuotaStatus: async () => {
    if (state.quotaFails) throw new Error('ledger exploded');
    return { buckets: [], files: { limitBytes: null } };
  }
}));
jest.unstable_mockModule('../services/chatFiles/ChatFileRepository.js', () => ({
  getChatFileRepository: () => ({
    isAvailable: () => state.repoAvailable,
    getOwnerUsage: async () => {
      if (state.repoFails) throw new Error('repo exploded');
      return { usedBytes: 42, fileCount: 2 };
    }
  })
}));
jest.unstable_mockModule('../services/chat/chatOwner.js', () => ({
  resolveChatOwner: async () => ({ id: 'owner1' })
}));
jest.unstable_mockModule('../services/loop/RunLog.js', () => ({
  default: { identityMode: () => 'user' }
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}));

const { default: registerSessionRoute } = await import('../routes/appSessionRoutes.js');
const { default: registerUsageRoutes } = await import('../routes/usageRoutes.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');

const app = express();
app.use(express.json());
registerSessionRoute(app);
registerUsageRoutes(app);
app.use(errorHandler);

beforeEach(() => {
  state.logFails = false;
  state.logged = null;
  state.quotaFails = false;
  state.repoAvailable = true;
  state.repoFails = false;
});

describe('session start route: errors', () => {
  it('answers a missing session id with a 400 problem response', async () => {
    const res = await request(app).post('/api/session/start').send({}).expect(400);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    // The body schema rejects it before the handler runs.
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(state.logged).toBeNull();
  });

  it('answers an empty session id with a 400 problem response', async () => {
    const res = await request(app).post('/api/session/start').send({ sessionId: '' }).expect(400);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.code).toBeDefined();
  });

  it('answers a storage failure with INTERNAL_ERROR', async () => {
    state.logFails = true;
    const res = await request(app).post('/api/session/start').send({ sessionId: 's1' }).expect(500);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.code).toBe('INTERNAL_ERROR');
    expect(res.body.status).toBe(500);
  });

  it('logs a valid session', async () => {
    await request(app).post('/api/session/start').send({ sessionId: 's1' }).expect(200);
    expect(state.logged[0]).toBe('s1');
    expect(state.logged[1]).toBe('app_loaded');
  });
});

describe('usage route: errors', () => {
  it('answers a quota failure with INTERNAL_ERROR', async () => {
    state.quotaFails = true;
    const res = await request(app).get('/api/usage/me').expect(500);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.code).toBe('INTERNAL_ERROR');
    expect(res.body.status).toBe(500);
  });

  it('reports file usage when the repository is available', async () => {
    const res = await request(app).get('/api/usage/me').expect(200);
    expect(res.body.files).toMatchObject({ usedBytes: 42, fileCount: 2 });
  });

  it('answers null file usage when the repository is unavailable', async () => {
    state.repoAvailable = false;
    const res = await request(app).get('/api/usage/me').expect(200);
    expect(res.body.files).toMatchObject({ usedBytes: null, fileCount: null });
  });

  it('answers null file usage when the repository fails', async () => {
    state.repoFails = true;
    const res = await request(app).get('/api/usage/me').expect(200);
    expect(res.body.files).toMatchObject({ usedBytes: null, fileCount: null });
  });
});
