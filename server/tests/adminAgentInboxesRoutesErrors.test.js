// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The agent inbox administration routes answer errors through the global error
 * middleware: an unsafe inbox id, an unknown inbox, a missing field, a stale
 * version and an unexpected failure.
 *
 * Native ESM, so `jest.unstable_mockModule` + dynamic imports. Run with
 * `NODE_OPTIONS=--experimental-vm-modules`.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const state = { readError: null, writeError: null, listError: null };

jest.unstable_mockModule('../middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) => next()
}));
jest.unstable_mockModule('../agents/inbox/inboxStore.js', () => ({
  default: {
    listInboxes: async () => {
      if (state.listError) throw state.listError;
      return [];
    },
    readInbox: async () => {
      if (state.readError) throw state.readError;
      return { inboxId: 'main', items: [] };
    },
    writeInbox: async () => {
      if (state.writeError) throw state.writeError;
      return { version: 2 };
    },
    addInboxItem: async () => ({ version: 3 })
  }
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}));

const { default: registerAdminAgentInboxesRoutes } =
  await import('../routes/admin/agentInboxes.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');
const { ServiceError } = await import('../utils/ServiceError.js');

const app = express();
app.use(express.json());
registerAdminAgentInboxesRoutes(app);
app.use(errorHandler);

beforeEach(() => {
  state.readError = null;
  state.writeError = null;
  state.listError = null;
});

describe('agent inbox administration routes: errors', () => {
  it('answers an unsafe inbox id with BAD_REQUEST', async () => {
    const res = await request(app).get('/api/admin/agents/inboxes/bad%20id').expect(400);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body).toMatchObject({ code: 'BAD_REQUEST', detail: 'Invalid inbox id' });
    await request(app).put('/api/admin/agents/inboxes/bad%20id').send({ body: 'x' }).expect(400);
    await request(app)
      .post('/api/admin/agents/inboxes/bad%20id/items')
      .send({ text: 'x' })
      .expect(400);
    await request(app).post('/api/admin/agents/inboxes/bad%20id').send({}).expect(400);
  });

  it('answers an unknown inbox with NOT_FOUND', async () => {
    state.readError = Object.assign(new Error('missing'), { code: 'ENOENT' });
    const res = await request(app).get('/api/admin/agents/inboxes/main').expect(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND', detail: 'Inbox main not found' });
  });

  it('answers a missing body or text with BAD_REQUEST', async () => {
    const put = await request(app).put('/api/admin/agents/inboxes/main').send({}).expect(400);
    expect(put.body.detail).toBe('body is required');
    const item = await request(app)
      .post('/api/admin/agents/inboxes/main/items')
      .send({})
      .expect(400);
    expect(item.body.detail).toBe('text is required');
  });

  it('answers a stale version with VERSION_CONFLICT and the current version', async () => {
    state.writeError = new ServiceError('VERSION_CONFLICT', 'Inbox version mismatch', {
      details: { currentVersion: 5 }
    });
    const res = await request(app)
      .put('/api/admin/agents/inboxes/main')
      .send({ body: 'x', expectedVersion: 1 })
      .expect(409);
    expect(res.body.code).toBe('VERSION_CONFLICT');
    expect(res.body.details).toEqual({ currentVersion: 5 });
  });

  it('answers an unexpected failure with a 500 that does not leak the cause', async () => {
    state.listError = new Error('/srv/contents/inbox is unreadable');
    const res = await request(app).get('/api/admin/agents/inboxes').expect(500);
    expect(res.body.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('/srv/contents');
  });
});
