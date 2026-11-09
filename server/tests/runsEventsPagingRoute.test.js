// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `GET /api/runs/:runId/events` pages by `limit` and an opaque `cursor` and answers
 * `{ runId, items, nextCursor }`; a page that read nothing has no `nextCursor`.
 *
 * Native ESM: run with `NODE_OPTIONS=--experimental-vm-modules`.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const ledger = Array.from({ length: 5 }, (_, i) => ({ seq: i + 1, type: 'x' }));
const readCalls = [];

const realAuth = await import('../middleware/authRequired.js');
jest.unstable_mockModule('../middleware/authRequired.js', () => ({
  ...realAuth,
  authRequired: (req, res, next) => {
    req.user = { id: 'ada', groups: [] };
    next();
  }
}));
jest.unstable_mockModule('../middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) => next()
}));
jest.unstable_mockModule('../services/loop/runAccess.js', () => ({
  authorizeRun: async () => ({ ok: true, meta: {} }),
  authorizeInteraction: async () => true
}));
const { default: runLog } = await import('../services/loop/RunLog.js');
jest.spyOn(runLog, 'readEvents').mockImplementation(async (runId, { afterSeq, limit }) => {
  readCalls.push({ afterSeq, limit });
  return ledger.filter(e => e.seq > afterSeq).slice(0, limit);
});
jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}));

const { default: registerRunRoutes } = await import('../routes/runs.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');

const app = express();
registerRunRoutes(app);
app.use(errorHandler);

describe('run ledger events: cursor paging', () => {
  it('walks the ledger by the cursor it hands out and ends on a page that read nothing', async () => {
    const first = await request(app).get('/api/runs/run1/events?limit=2').expect(200);
    expect(first.body.items.map(e => e.seq)).toEqual([1, 2]);
    expect(first.body.after).toBeUndefined();

    const second = await request(app)
      .get('/api/runs/run1/events')
      .query({ limit: 2, cursor: first.body.nextCursor })
      .expect(200);
    expect(second.body.items.map(e => e.seq)).toEqual([3, 4]);

    const third = await request(app)
      .get('/api/runs/run1/events')
      .query({ limit: 2, cursor: second.body.nextCursor })
      .expect(200);
    expect(third.body.items.map(e => e.seq)).toEqual([5]);

    const end = await request(app)
      .get('/api/runs/run1/events')
      .query({ limit: 2, cursor: third.body.nextCursor })
      .expect(200);
    expect(end.body).toEqual({ runId: 'run1', items: [], nextCursor: null });
    expect(readCalls.map(c => c.afterSeq)).toEqual([0, 2, 4, 5]);
  });

  it('caps a limit above the maximum instead of refusing it', async () => {
    readCalls.length = 0;
    await request(app).get('/api/runs/run1/events?limit=99999').expect(200);
    expect(readCalls[0].limit).toBe(5000);
  });

  it('refuses a cursor it did not issue with INVALID_CURSOR', async () => {
    const res = await request(app).get('/api/runs/run1/events?cursor=bogus').expect(400);
    expect(res.body.code).toBe('INVALID_CURSOR');
  });
});
