// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The UI administration routes answer errors through the global error
 * middleware: a missing upload, an invalid or unknown asset id and invalid
 * configuration data are client errors with the reason in `detail`, and an
 * unexpected failure is a 500 that does not leak the cause.
 *
 * Native ESM, so `jest.unstable_mockModule` + dynamic imports. Run with
 * `NODE_OPTIONS=--experimental-vm-modules`.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ihub-ui-routes-'));
const state = { written: null, writeError: null };

const realContentsPath = await import('../utils/contentsPath.js');

jest.unstable_mockModule('../utils/contentsPath.js', () => ({
  ...realContentsPath,
  getContentsPath: (...segments) => path.join(tmpRoot, ...segments)
}));
jest.unstable_mockModule('../middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) => next()
}));
jest.unstable_mockModule('../middleware/authRequired.js', () => ({
  authRequired: (req, res, next) => next()
}));
jest.unstable_mockModule('../services/config/ConfigStore.js', () => ({
  default: {
    writeJson: async (_path, data) => {
      if (state.writeError) throw state.writeError;
      state.written = data;
    }
  }
}));
jest.unstable_mockModule('../configCache.js', () => ({
  default: { getUI: () => ({ data: {} }), refreshCacheEntry: async () => {} }
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}));

const { default: registerAdminUIRoutes } = await import('../routes/admin/ui.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');

const app = express();
app.use(express.json());
registerAdminUIRoutes(app);
app.use(errorHandler);

const VALID_CONFIG = { title: { en: 'iHub' }, header: {}, footer: {} };

beforeEach(() => {
  state.written = null;
  state.writeError = null;
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('UI administration routes: errors', () => {
  it('answers an upload without a file with BAD_REQUEST', async () => {
    const res = await request(app).post('/api/admin/ui/upload-asset').send({}).expect(400);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.code).toBe('BAD_REQUEST');
    expect(res.body.detail).toBe('No file uploaded');
  });

  it('answers an asset id outside the assets directory with BAD_REQUEST', async () => {
    fs.mkdirSync(path.join(tmpRoot, 'uploads', 'assets'), { recursive: true });
    const res = await request(app)
      .delete(`/api/admin/ui/assets/${encodeURIComponent('../secret.txt')}`)
      .expect(400);
    expect(res.body.code).toBe('BAD_REQUEST');
    expect(res.body.detail).toBe('Invalid asset id');
  });

  it('answers an unknown asset with NOT_FOUND', async () => {
    fs.mkdirSync(path.join(tmpRoot, 'uploads', 'assets'), { recursive: true });
    const res = await request(app).delete('/api/admin/ui/assets/missing.png').expect(404);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.code).toBe('NOT_FOUND');
    expect(res.body.detail).toBe('Asset not found');
  });

  it('deletes an existing asset', async () => {
    const dir = path.join(tmpRoot, 'uploads', 'assets');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'logo.png'), 'x');
    await request(app).delete('/api/admin/ui/assets/logo.png').expect(204);
    expect(fs.existsSync(path.join(dir, 'logo.png'))).toBe(false);
  });

  it.each([[{}], [{ config: 'text' }], [{ config: null }]])(
    'answers configuration data %j with BAD_REQUEST',
    async body => {
      const res = await request(app).post('/api/admin/ui/config').send(body).expect(400);
      expect(res.body.code).toBe('BAD_REQUEST');
      expect(res.body.detail).toBe('Invalid configuration data');
      expect(state.written).toBeNull();
    }
  );

  it('answers a configuration with a missing section or a malformed pwa block with BAD_REQUEST', async () => {
    const missing = { ...VALID_CONFIG };
    delete missing.footer;
    const noFooter = await request(app)
      .post('/api/admin/ui/config')
      .send({ config: missing })
      .expect(400);
    expect(noFooter.body).toMatchObject({
      code: 'BAD_REQUEST',
      detail: 'Missing required section: footer'
    });
    const badPwa = await request(app)
      .post('/api/admin/ui/config')
      .send({ config: { ...VALID_CONFIG, pwa: { themeColor: 'red' } } })
      .expect(400);
    expect(badPwa.body.code).toBe('BAD_REQUEST');
    expect(state.written).toBeNull();
  });

  it('saves a valid configuration', async () => {
    await request(app).post('/api/admin/ui/config').send({ config: VALID_CONFIG }).expect(204);
    expect(state.written).toEqual(VALID_CONFIG);
  });

  it('answers a failing write with a 500 that does not leak the cause', async () => {
    state.writeError = new Error('boom at /srv/secret/path');
    const res = await request(app)
      .post('/api/admin/ui/config')
      .send({ config: VALID_CONFIG })
      .expect(500);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('/srv/secret');
    expect(JSON.stringify(res.body)).not.toContain('boom');
  });
});
