// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The admin audit log routes answer errors through the global error
 * middleware: a bad filter (list and export) is a BAD_REQUEST with the reason
 * in `detail`, and an unexpected failure is a 500 that does not leak the cause.
 *
 * Native ESM, so `jest.unstable_mockModule` + dynamic imports. Run with
 * `NODE_OPTIONS=--experimental-vm-modules`.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const state = { queryError: null, lastOptions: null };

jest.unstable_mockModule('../middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) => next()
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}));
const realService = await import('../services/AuditLogService.js');
jest.unstable_mockModule('../services/AuditLogService.js', () => ({
  ...realService,
  queryAuditLog: async options => {
    state.lastOptions = options;
    if (state.queryError) throw state.queryError;
    return { entries: [], total: 0 };
  }
}));

const { default: registerAdminAuditLogRoutes } = await import('../routes/admin/auditLog.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');
const { MAX_FILTER_VALUES, MAX_QUERY_LENGTH } =
  await import('../routes/admin/auditLogQueryParams.js');

const app = express();
app.use(express.json());
registerAdminAuditLogRoutes(app);
app.use(errorHandler);

const tooMany = Array.from({ length: MAX_FILTER_VALUES + 1 }, (_, i) => `v${i}`).join(',');
const tooLongQuery = 'x'.repeat(MAX_QUERY_LENGTH + 1);

beforeEach(() => {
  state.queryError = null;
  state.lastOptions = null;
});

describe('admin audit log routes: errors', () => {
  it.each([
    ['/api/admin/audit-log', { action: tooMany }, 'Too many filter values'],
    ['/api/admin/audit-log', { q: tooLongQuery }, 'Search term is too long'],
    ['/api/admin/audit-log/export', { resultExclude: tooMany }, 'Too many filter values'],
    ['/api/admin/audit-log/export', { q: tooLongQuery }, 'Search term is too long']
  ])('answers a bad filter on %s with BAD_REQUEST', async (path, query, reason) => {
    const res = await request(app).get(path).query(query).expect(400);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.code).toBe('BAD_REQUEST');
    expect(res.body.status).toBe(400);
    expect(res.body.detail).toContain(reason);
    expect(state.lastOptions).toBeNull();
  });

  it('lists entries for a valid query', async () => {
    const res = await request(app)
      .get('/api/admin/audit-log')
      .query({ action: 'create,update', limit: '10' })
      .expect(200);
    expect(res.body).toEqual({ items: [], nextCursor: null, total: 0 });
    expect(state.lastOptions.action).toEqual(['create', 'update']);
    expect(state.lastOptions.limit).toBe(10);
  });

  it('pages by cursor and refuses a cursor it did not issue', async () => {
    const bad = await request(app)
      .get('/api/admin/audit-log')
      .query({ cursor: 'nope' })
      .expect(400);
    expect(bad.body.code).toBe('INVALID_CURSOR');
  });

  it.each(['/api/admin/audit-log', '/api/admin/audit-log/export'])(
    'answers an unexpected failure on %s with a 500 that does not leak the cause',
    async path => {
      state.queryError = new Error('boom at /srv/secret/path');
      const res = await request(app).get(path).expect(500);
      expect(res.body.status).toBe(500);
      expect(JSON.stringify(res.body)).not.toContain('/srv/secret');
    }
  );
});
