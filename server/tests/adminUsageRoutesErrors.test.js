// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The admin usage routes answer errors through the global error middleware: an
 * invalid date range (query endpoints and the streaming export) is a
 * BAD_REQUEST with the reason in `detail`, and an unexpected failure is a 500
 * that does not leak the cause.
 *
 * Native ESM, so `jest.unstable_mockModule` + dynamic imports. Run with
 * `NODE_OPTIONS=--experimental-vm-modules`.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const state = { summaryError: null, readError: null };

jest.unstable_mockModule('../middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) => next()
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}));
jest.unstable_mockModule('../configCache.js', () => ({
  default: { getPlatform: () => ({}), refreshCacheEntry: async () => {} }
}));
const realEventLog = await import('../services/UsageEventLog.js');
jest.unstable_mockModule('../services/UsageEventLog.js', () => ({
  ...realEventLog,
  flushQueue: async () => {},
  readDayEvents: async () => {
    if (state.readError) throw state.readError;
    return [];
  }
}));
const realQuery = await import('../services/usage/usageQuery.js');
jest.unstable_mockModule('../services/usage/usageQuery.js', () => ({
  ...realQuery,
  getUsageSummary: async params => {
    if (state.summaryError) throw state.summaryError;
    // Validate like the real one does
    realQuery.resolveRange(params);
    return { range: params.range, kpis: {} };
  },
  getDataStart: async () => '2026-01-01'
}));

const { default: registerAdminUsageRoutes } = await import('../routes/admin/usage.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');

const app = express();
app.use(express.json());
registerAdminUsageRoutes(app);
app.use(errorHandler);

beforeEach(() => {
  state.summaryError = null;
  state.readError = null;
});

const BAD_RANGES = [
  [{ range: 'forever' }, 'Unknown range: forever'],
  [{ range: 'custom', from: 'nope', to: '2026-01-02' }, 'YYYY-MM-DD'],
  [{ range: 'custom', from: '2026-02-02', to: '2026-01-02' }, 'from must not be after to']
];

describe('admin usage routes: errors', () => {
  it.each(BAD_RANGES)('answers an invalid range %j on summary with BAD_REQUEST', async (q, why) => {
    const res = await request(app).get('/api/admin/usage/summary').query(q).expect(400);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.code).toBe('BAD_REQUEST');
    expect(res.body.status).toBe(400);
    expect(res.body.detail).toContain(why);
  });

  it.each(BAD_RANGES)('answers an invalid range %j on export with BAD_REQUEST', async (q, why) => {
    const res = await request(app).get('/api/admin/usage/export').query(q).expect(400);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.code).toBe('BAD_REQUEST');
    expect(res.body.detail).toContain(why);
  });

  it('answers a valid summary query', async () => {
    const res = await request(app).get('/api/admin/usage/summary').query({ range: '30d' });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({ range: '30d', kpis: {}, dataStart: '2026-01-01' });
  });

  it('answers an unexpected failure with a 500 that does not leak the cause', async () => {
    state.summaryError = new Error('boom at /srv/secret/path');
    const res = await request(app).get('/api/admin/usage/summary').expect(500);
    expect(res.body.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('/srv/secret');
  });

  it('ends a half-written export when reading fails, without leaking the cause', async () => {
    state.readError = new Error('boom at /srv/secret/path');
    // Headers and the start of the body are already sent by then: the response
    // is just ended (cut-off JSON), never turned into an error body.
    const res = await request(app)
      .get('/api/admin/usage/export')
      .query({ range: '24h' })
      .buffer(true)
      .parse((r, cb) => {
        let data = '';
        r.setEncoding('utf8');
        r.on('data', c => (data += c));
        r.on('end', () => cb(null, data));
      });
    expect(res.status).toBe(200);
    expect(res.body).toMatch(/^\{"range":"24h"/);
    expect(res.body).not.toContain('/srv/secret');
    expect(res.body.endsWith(']}')).toBe(false);
  });
});
