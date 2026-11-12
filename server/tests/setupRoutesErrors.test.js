// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The onboarding routes (`/api/setup/*`) answer errors through the global error middleware as
 * problem+json, behind the real `adminAuth` guard, which refuses a non-admin before any handler
 * runs. `createOidcAuthHandler` refuses an unknown provider with NOT_FOUND.
 *
 * Run with `NODE_OPTIONS=--experimental-vm-modules`.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import rateLimit from 'express-rate-limit';

const state = { platform: { setup: {} }, providers: [], user: null, written: [], fetches: 0 };

const realConfigCache = (await import('../configCache.js')).default;
const realConfigStore = (await import('../services/config/ConfigStore.js')).default;
const realTokenStorage = (await import('../services/TokenStorageService.js')).default;

jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    ...realConfigCache,
    getPlatform: () => state.platform,
    getProviders: () => ({ data: state.providers }),
    refreshCacheEntry: async () => {},
    refreshProvidersCache: async () => {}
  }
}));
jest.unstable_mockModule('../services/config/ConfigStore.js', () => ({
  default: {
    // Same read-change-write the real store does for updateJson.
    updateJson: async (_path, mutate) => {
      const current = state.platform;
      const next = await mutate(current === null ? null : structuredClone(current));
      if (next === undefined) return { data: current, written: false };
      state.written.push([_path, next]);
      return { data: next, written: true };
    },
    ...realConfigStore,
    readJson: async () => state.platform,
    writeJson: async (file, data) => {
      state.written.push([file, data]);
    }
  }
}));
jest.unstable_mockModule('../services/TokenStorageService.js', () => ({
  default: { ...realTokenStorage, encryptString: s => `enc:${s}` }
}));
jest.unstable_mockModule('../utils/httpConfig.js', () => ({
  httpFetch: async () => {
    state.fetches += 1;
    return { ok: true, status: 200 };
  }
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}));

const { default: registerSetupRoutes } = await import('../routes/setup.js');
const { createOidcAuthHandler } = await import('../middleware/oidcAuth.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');

const app = express();
// Harness-only limiter: the production app rate-limits at the server level.
app.use(rateLimit({ windowMs: 60000, limit: 1000 }));
app.use(express.json());
app.use((req, res, next) => {
  if (state.user) req.user = state.user;
  next();
});
registerSetupRoutes(app);
app.get('/api/auth/oidc/:provider', (req, res, next) =>
  createOidcAuthHandler(req.params.provider)(req, res, next)
);
app.use(errorHandler);

const ADMIN = { id: 'admin', isAdmin: true };

function expectProblem(res, status, code, detail) {
  expect(res.status).toBe(status);
  expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
  expect(res.body.code).toBe(code);
  if (detail !== undefined) expect(res.body.detail).toContain(detail);
}

beforeEach(() => {
  state.platform = { setup: {} };
  state.providers = [{ id: 'openai', enabled: false }];
  state.user = ADMIN;
  state.written = [];
  state.fetches = 0;
});

describe('setup routes: admin guard', () => {
  it.each([
    ['post', '/api/setup/_test'],
    ['post', '/api/setup/configure'],
    ['post', '/api/setup/_disable']
  ])('refuses a non-admin on %s %s with 403 FORBIDDEN before anything happens', async (m, url) => {
    for (const user of [null, { id: 'anonymous' }, { id: 'bob', isAdmin: false }]) {
      state.user = user;
      const res = await request(app)[m](url).send({ providerId: 'local' });
      expectProblem(res, 403, 'FORBIDDEN');
    }
    expect(state.written).toEqual([]);
    expect(state.fetches).toBe(0);
  });
});

describe('POST /api/setup/_test: errors', () => {
  it.each([[{}], [{ providerId: 'nope', apiKey: 'k' }]])(
    'answers an invalid provider id %j with 400 BAD_REQUEST',
    async body => {
      const res = await request(app).post('/api/setup/_test').send(body);
      expectProblem(res, 400, 'BAD_REQUEST', 'Invalid provider ID');
      expect(state.fetches).toBe(0);
    }
  );

  it.each([[undefined], [''], ['   '], [42]])(
    'answers a missing api key (%j) with 400 BAD_REQUEST',
    async apiKey => {
      const res = await request(app)
        .post('/api/setup/_test')
        .send({ providerId: 'openai', apiKey });
      expectProblem(res, 400, 'BAD_REQUEST', 'API key is required');
      expect(state.fetches).toBe(0);
    }
  );
});

describe('POST /api/setup/configure: errors', () => {
  it('answers an already configured system with 403 FORBIDDEN and writes nothing', async () => {
    state.platform = { setup: { configured: true } };
    const res = await request(app).post('/api/setup/configure').send({ providerId: 'local' });
    expectProblem(res, 403, 'FORBIDDEN', 'already configured');
    expect(state.written).toEqual([]);
  });

  it('answers a missing providerId with 400 BAD_REQUEST', async () => {
    const res = await request(app).post('/api/setup/configure').send({});
    expectProblem(res, 400, 'BAD_REQUEST', 'providerId is required');
    expect(state.written).toEqual([]);
  });

  it('answers an invalid provider with 400 BAD_REQUEST', async () => {
    const res = await request(app)
      .post('/api/setup/configure')
      .send({ providerId: 'nope', apiKey: 'k' });
    expectProblem(res, 400, 'BAD_REQUEST', 'Invalid provider ID');
    expect(state.written).toEqual([]);
  });

  it('answers an empty api key with 400 BAD_REQUEST', async () => {
    const res = await request(app)
      .post('/api/setup/configure')
      .send({ providerId: 'openai', apiKey: '  ' });
    expectProblem(res, 400, 'BAD_REQUEST', 'API key must be a non-empty string');
    expect(state.written).toEqual([]);
  });

  it('answers a provider missing from providers.json with 404 NOT_FOUND', async () => {
    state.providers = [{ id: 'anthropic' }];
    const res = await request(app)
      .post('/api/setup/configure')
      .send({ providerId: 'openai', apiKey: 'sk-1' });
    expectProblem(res, 404, 'NOT_FOUND', 'Provider not found');
    expect(state.written).toEqual([]);
  });

  it('answers an unreadable platform.json after the key is stored with 500 INTERNAL_ERROR', async () => {
    state.platform = null;
    const res = await request(app).post('/api/setup/configure').send({ providerId: 'local' });
    expect(res.status).toBe(500);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('platform.json');
  });
});

describe('POST /api/setup/_disable: errors', () => {
  it('answers an unreadable platform.json with 500 INTERNAL_ERROR that does not leak the cause', async () => {
    state.platform = null;
    const res = await request(app).post('/api/setup/_disable').send({});
    expect(res.status).toBe(500);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('platform.json');
    expect(state.written).toEqual([]);
  });

  it('records the choice for an admin', async () => {
    await request(app).post('/api/setup/_disable').send({}).expect(204);
    expect(state.written[0][1].setup.disabled).toBe(true);
  });
});

describe('createOidcAuthHandler', () => {
  it('answers an unknown provider with 404 NOT_FOUND and starts no redirect', async () => {
    const res = await request(app).get('/api/auth/oidc/nope').redirects(0);
    expectProblem(res, 404, 'NOT_FOUND', "OIDC provider 'nope' not found");
    expect(res.headers.location).toBeUndefined();
    expect(res.headers['set-cookie'] ?? []).toEqual([]);
  });
});
