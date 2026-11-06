// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The run routes answer errors through the global error middleware
 * (`{ error, code, details? }`): an unsafe id, a run the caller may not see, a
 * malformed answer, a missing interaction, and the `InteractionError`s of the
 * interaction service with their own status and code.
 *
 * Native ESM, so `jest.unstable_mockModule` + dynamic imports. Run with
 * `NODE_OPTIONS=--experimental-vm-modules`.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const state = {
  auth: { ok: true, meta: {} },
  interaction: null,
  answerError: null,
  interactionAllowed: true
};

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
  authorizeRun: async () => state.auth,
  authorizeInteraction: async () => state.interactionAllowed
}));
const realInteraction = await import('../services/loop/InteractionService.js');
jest.unstable_mockModule('../services/loop/InteractionService.js', () => ({
  ...realInteraction,
  default: {
    get: async () => state.interaction,
    answer: async () => {
      throw state.answerError;
    },
    listPending: async () => []
  }
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}));

const { default: registerRunRoutes } = await import('../routes/runs.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');
const { InteractionError } = await import('../services/loop/InteractionService.js');

const app = express();
app.use(express.json());
registerRunRoutes(app);
app.use(errorHandler);

const answerUrl = '/api/runs/run1/interactions/i1/answer';

beforeEach(() => {
  state.auth = { ok: true, meta: {} };
  state.interaction = { id: 'i1', runId: 'run1', policy: {} };
  state.answerError = null;
  state.interactionAllowed = true;
});

describe('run routes: errors', () => {
  it('answers an unsafe run id with BAD_REQUEST', async () => {
    const res = await request(app).get('/api/runs/bad%20id').expect(400);
    expect(res.body.code).toBe('BAD_REQUEST');
  });

  it('answers an unknown run with NOT_FOUND and a foreign run with FORBIDDEN', async () => {
    state.auth = { ok: false, status: 404 };
    const missing = await request(app).get('/api/runs/run1').expect(404);
    expect(missing.body).toEqual({ error: 'Run not found', code: 'NOT_FOUND' });

    state.auth = { ok: false, status: 403 };
    const foreign = await request(app).delete('/api/runs/run1').expect(403);
    expect(foreign.body).toEqual({
      error: 'Insufficient permissions: delete run required',
      code: 'FORBIDDEN'
    });
  });

  it('answers a malformed answer with VALIDATION_FAILED and the fields in details.issues', async () => {
    const res = await request(app).post(answerUrl).send({ decision: 'maybe' }).expect(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(Array.isArray(res.body.details.issues)).toBe(true);
  });

  it('answers an interaction of another run with NOT_FOUND', async () => {
    state.interaction = { id: 'i1', runId: 'other', policy: {} };
    const res = await request(app).post(answerUrl).send({ decision: 'approve' }).expect(404);
    expect(res.body).toEqual({ error: 'Interaction not found', code: 'NOT_FOUND' });
  });

  it('answers a malformed human event with VALIDATION_FAILED and the fields in details.issues', async () => {
    const res = await request(app)
      .post('/api/runs/run1/human-events')
      .send({ kind: 'not-a-kind' })
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(Array.isArray(res.body.details.issues)).toBe(true);
  });

  it('refuses to answer a chat tool approval here with ANSWER_IN_CHAT', async () => {
    state.interaction = {
      id: 'i1',
      runId: 'run1',
      kind: 'approval',
      origin: 'tool',
      policy: {},
      source: { chatId: 'chat1' }
    };
    const res = await request(app).post(answerUrl).send({ decision: 'approve' }).expect(409);
    expect(res.body).toEqual({ error: 'Answer this approval in its chat', code: 'ANSWER_IN_CHAT' });
  });

  it('answers a caller who may not answer the interaction with FORBIDDEN', async () => {
    state.interactionAllowed = false;
    const res = await request(app).post(answerUrl).send({ decision: 'approve' }).expect(403);
    expect(res.body).toEqual({
      error: 'Insufficient permissions: answer interaction required',
      code: 'FORBIDDEN'
    });
  });

  it('keeps the status and code of an InteractionError', async () => {
    state.answerError = new InteractionError('Interaction expired', 'EXPIRED', 410);
    const expired = await request(app).post(answerUrl).send({ decision: 'approve' }).expect(410);
    expect(expired.body).toEqual({ error: 'Interaction expired', code: 'EXPIRED' });

    state.answerError = new InteractionError('A reason is required to reject', 'REASON_REQUIRED');
    const reason = await request(app).post(answerUrl).send({ decision: 'reject' }).expect(400);
    expect(reason.body.code).toBe('REASON_REQUIRED');
  });

  it('hides the reason of an unexpected failure', async () => {
    state.answerError = new Error('db down at /srv/secret/path');
    const res = await request(app).post(answerUrl).send({ decision: 'approve' }).expect(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('/srv/secret');
  });
});
