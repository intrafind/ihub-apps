// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The page administration routes answer errors through the global error
 * middleware: an unsafe id, an unknown page, a missing or existing id on
 * create, a language key that is not a language code and an unexpected failure.
 *
 * Native ESM, so `jest.unstable_mockModule` + dynamic imports. Run with
 * `NODE_OPTIONS=--experimental-vm-modules`.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const state = { pages: {}, uiConfig: { pages: {} }, readError: null };

jest.unstable_mockModule('../middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) => next()
}));
jest.unstable_mockModule('../services/config/ConfigStore.js', () => ({
  default: {
    readJson: async () => {
      if (state.readError) throw state.readError;
      return state.uiConfig;
    },
    writeJson: async () => {},
    remove: async () => {}
  }
}));
jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    getUI: () => ({ data: { pages: state.pages } }),
    refreshCacheEntry: async () => {}
  }
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}));

const { default: registerAdminPagesRoutes } = await import('../routes/admin/pages.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');

const app = express();
app.use(express.json());
registerAdminPagesRoutes(app);
app.use(errorHandler);

beforeEach(() => {
  state.pages = {};
  state.uiConfig = { pages: {} };
  state.readError = null;
});

describe('page administration routes: errors', () => {
  it('answers an unsafe id with BAD_REQUEST and an unknown page with NOT_FOUND', async () => {
    const unsafe = await request(app).get('/api/admin/pages/bad%20id').expect(400);
    expect(unsafe.body.code).toBe('BAD_REQUEST');
    const missing = await request(app).get('/api/admin/pages/nobody').expect(404);
    expect(missing.body).toMatchObject({ code: 'NOT_FOUND', detail: 'Page not found' });
    await request(app).delete('/api/admin/pages/nobody').expect(404);
    const mismatch = await request(app)
      .put('/api/admin/pages/nobody')
      .send({ id: 'other' })
      .expect(400);
    expect(mismatch.body).toMatchObject({ code: 'BAD_REQUEST', detail: 'Invalid page ID' });
    await request(app).put('/api/admin/pages/nobody').send({ id: 'nobody' }).expect(404);
  });

  it('answers a new page without an id with BAD_REQUEST and an existing id with CONFLICT', async () => {
    const none = await request(app).post('/api/admin/pages').send({}).expect(400);
    expect(none.body).toMatchObject({ code: 'BAD_REQUEST', detail: 'Missing page ID' });

    state.uiConfig = { pages: { about: { title: {} } } };
    const exists = await request(app).post('/api/admin/pages').send({ id: 'about' }).expect(409);
    expect(exists.body).toMatchObject({
      code: 'CONFLICT',
      detail: 'Page with this ID already exists'
    });
  });

  it('answers a content key that is not a language code with BAD_REQUEST', async () => {
    const res = await request(app)
      .post('/api/admin/pages')
      .send({ id: 'news', content: { '../etc': 'x' } })
      .expect(400);
    expect(res.body).toMatchObject({
      code: 'BAD_REQUEST',
      detail: 'Invalid language code in content keys'
    });
  });

  it('keeps an unexpected failure hidden behind the fixed text', async () => {
    state.readError = new Error('ENOENT: no such file /srv/contents/config/ui.json');
    const res = await request(app).post('/api/admin/pages').send({ id: 'news' }).expect(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
    expect(res.body.detail).not.toMatch(/srv|contents/);
  });
});
