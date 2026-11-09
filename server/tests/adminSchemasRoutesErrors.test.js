// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The schema routes answer errors through the global error middleware: an
 * unknown schema type, a type without a schema and an unexpected failure.
 *
 * Native ESM, so `jest.unstable_mockModule` + dynamic imports. Run with
 * `NODE_OPTIONS=--experimental-vm-modules`.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const state = { schema: { type: 'object' }, failAll: false };

jest.unstable_mockModule('../middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) => next()
}));
jest.unstable_mockModule('../utils/schemaExport.js', () => ({
  getJsonSchemaByType: () => state.schema,
  getAllJsonSchemas: () => {
    if (state.failAll) throw new Error('/srv/secret/schemas failed');
    return { app: { type: 'object' } };
  }
}));

const { default: registerAdminSchemasRoutes } = await import('../routes/admin/schemas.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');

const app = express();
registerAdminSchemasRoutes(app);
app.use(errorHandler);

beforeEach(() => {
  state.schema = { type: 'object' };
  state.failAll = false;
});

describe('schema routes: errors', () => {
  it('answers an unknown schema type with BAD_REQUEST that lists the allowed types', async () => {
    const res = await request(app).get('/api/admin/schemas/bogus').expect(400);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.code).toBe('BAD_REQUEST');
    expect(res.body.detail).toContain('app, model, prompt, group, platform, user');
  });

  it('answers a type without a schema with NOT_FOUND', async () => {
    state.schema = null;
    const res = await request(app).get('/api/admin/schemas/app').expect(404);
    expect(res.body).toMatchObject({
      code: 'NOT_FOUND',
      detail: 'Schema for type: app not found'
    });
  });

  it('serves a known schema', async () => {
    const res = await request(app).get('/api/admin/schemas/app').expect(200);
    expect(res.body).toEqual({ type: 'object' });
  });

  it('answers an unexpected failure with a 500 that does not leak the cause', async () => {
    state.failAll = true;
    const res = await request(app).get('/api/admin/schemas').expect(500);
    expect(res.body.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('/srv/secret');
  });
});
