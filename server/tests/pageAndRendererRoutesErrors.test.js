// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Public page and renderer routes answer errors through the global error
 * middleware (RFC 9457 problem+json with a registry `code`).
 *
 * Run with `NODE_OPTIONS=--experimental-vm-modules`.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const state = { ui: {}, text: 'content', renderers: [], loadFails: false };

jest.unstable_mockModule('../configLoader.js', () => ({ loadText: async () => state.text }));
jest.unstable_mockModule('../configCache.js', () => ({
  default: { getUI: () => ({ data: state.ui }) }
}));
jest.unstable_mockModule('../renderersLoader.js', () => ({
  loadAllRenderers: async () => {
    if (state.loadFails) throw new Error('disk exploded');
    return state.renderers;
  },
  getRendererById: async id => state.renderers.find(r => r.id === id)
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}));

const { default: registerPageRoutes } = await import('../routes/pageRoutes.js');
const { default: registerRendererRoutes } = await import('../routes/rendererRoutes.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');

let user = { id: 'u1', groups: ['users'] };
const app = express();
app.use((req, res, next) => {
  req.user = user;
  next();
});
registerPageRoutes(app);
registerRendererRoutes(app);
app.use(errorHandler);

const page = extra => ({
  title: { en: 'T' },
  filePath: { en: 'p/en.md' },
  ...extra
});

beforeEach(() => {
  user = { id: 'u1', groups: ['users'] };
  state.ui = { pages: { about: page() } };
  state.text = 'content';
  state.renderers = [
    { id: 'r1', enabled: true },
    { id: 'off', enabled: false }
  ];
  state.loadFails = false;
});

describe('GET /api/pages/:pageId errors', () => {
  it('returns the page', async () => {
    const res = await request(app).get('/api/pages/about');
    expect(res.status).toBe(200);
    expect(res.body.contentType).toBe('markdown');
  });

  it('answers an unknown page with NOT_FOUND', async () => {
    const res = await request(app).get('/api/pages/nope');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('answers a missing content file with NOT_FOUND', async () => {
    state.text = '';
    const res = await request(app).get('/api/pages/about');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('answers an anonymous caller of a protected page with AUTH_REQUIRED', async () => {
    state.ui.pages.about = page({ authRequired: true });
    user = { id: 'anonymous', groups: [] };
    const res = await request(app).get('/api/pages/about');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_REQUIRED');
  });

  it('answers a caller outside the allowed groups with FORBIDDEN', async () => {
    state.ui.pages.about = page({ allowedGroups: ['admins'] });
    const res = await request(app).get('/api/pages/about');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('answers an invalid page id with BAD_REQUEST', async () => {
    const res = await request(app).get('/api/pages/bad..id');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BAD_REQUEST');
  });
});

describe('renderer routes errors', () => {
  it('lists enabled renderers', async () => {
    const res = await request(app).get('/api/renderers');
    expect(res.status).toBe(200);
    expect(res.body.map(r => r.id)).toEqual(['r1']);
  });

  it('answers an unknown renderer with NOT_FOUND', async () => {
    const res = await request(app).get('/api/renderers/missing');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('answers a disabled renderer with FORBIDDEN', async () => {
    const res = await request(app).get('/api/renderers/off');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('answers a loader failure with INTERNAL_ERROR', async () => {
    state.loadFails = true;
    const res = await request(app).get('/api/renderers');
    expect(res.status).toBe(500);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.code).toBe('INTERNAL_ERROR');
  });
});
