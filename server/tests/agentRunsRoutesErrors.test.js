// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The agent run routes answer errors through the global error middleware: an
 * unsafe id, an unknown profile or run, a run of somebody else (403), an
 * authorization lookup that failed (403, the cause only in the log), a profile
 * that is at its concurrency limit (CONCURRENCY_LIMIT with the running count) and
 * a resume that fails for a reason the caller can act on.
 *
 * Native ESM, so `jest.unstable_mockModule` + dynamic imports. Run with
 * `NODE_OPTIONS=--experimental-vm-modules`.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const state = {
  profiles: [],
  runState: null,
  getStateError: null,
  resumeError: null,
  running: []
};

jest.unstable_mockModule('../middleware/authRequired.js', () => ({
  authRequired: (req, res, next) => next(),
  authenticatedOnly: (req, res, next) => next()
}));
jest.unstable_mockModule('../utils/sseChannel.js', () => ({
  createSseChannel: () => ({}),
  startInactiveClientSweep: () => {}
}));
jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    getAgentProfiles: () => ({ data: state.profiles }),
    // These tests are about the run routes' own errors: the AI-use acknowledgement is off.
    getPlatform: () => ({ aiAcknowledgement: { enabled: false } })
  }
}));
jest.unstable_mockModule('../services/workflow/index.js', () => ({
  getWorkflowEngine: () => ({
    getState: async () => {
      if (state.getStateError) throw state.getStateError;
      return state.runState;
    },
    stateManager: { get: async () => state.runState },
    resumeFromTerminated: async () => {
      throw state.resumeError;
    }
  }),
  getExecutionRegistry: () => ({
    getByUser: async () => state.running,
    get: async () => null
  })
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}));

const { default: registerAgentRunRoutes } = await import('../routes/agents/runs.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  req.user = { id: 'u1', groups: [] };
  next();
});
registerAgentRunRoutes(app);
app.use(errorHandler);

beforeEach(() => {
  state.profiles = [];
  state.runState = null;
  state.getStateError = null;
  state.resumeError = null;
  state.running = [];
});

describe('agent run routes: errors', () => {
  it('answers an unsafe id with BAD_REQUEST and an unknown profile with NOT_FOUND', async () => {
    const unsafe = await request(app)
      .post('/api/agents/profiles/bad%20id/runs')
      .send({})
      .expect(400);
    expect(unsafe.body.code).toBe('BAD_REQUEST');
    const missing = await request(app)
      .post('/api/agents/profiles/nobody/runs')
      .send({})
      .expect(404);
    expect(missing.body).toMatchObject({ code: 'NOT_FOUND', detail: 'Profile nobody not found' });
  });

  it('refuses a disabled profile with BAD_REQUEST', async () => {
    state.profiles = [{ id: 'a1', enabled: false }];
    const res = await request(app).post('/api/agents/profiles/a1/runs').send({}).expect(400);
    expect(res.body).toMatchObject({ code: 'BAD_REQUEST', detail: 'Profile a1 is disabled' });
  });

  it('answers a profile at its concurrency limit with CONCURRENCY_LIMIT and the running count', async () => {
    state.profiles = [{ id: 'a1', enabled: true }];
    state.running = [{ status: 'running' }];
    const res = await request(app).post('/api/agents/profiles/a1/runs').send({}).expect(409);
    expect(res.body).toMatchObject({ code: 'CONCURRENCY_LIMIT', details: { runningRuns: 1 } });
  });

  it('answers an unknown run with NOT_FOUND and the run of somebody else with FORBIDDEN', async () => {
    const missing = await request(app).get('/api/agents/runs/r1').expect(404);
    expect(missing.body).toMatchObject({ code: 'NOT_FOUND', detail: 'Run r1 not found' });

    state.runState = { data: { _agent: { triggeredBy: { userId: 'someone-else' } } } };
    const foreign = await request(app).get('/api/agents/runs/r1').expect(403);
    expect(foreign.body).toMatchObject({
      code: 'FORBIDDEN',
      detail: 'You are not allowed to access this run.'
    });
  });

  it('answers a failed authorization lookup with FORBIDDEN and keeps the cause out of the answer', async () => {
    state.getStateError = new Error('ENOENT: /srv/contents/runs/r1.json');
    const res = await request(app).get('/api/agents/runs/r1').expect(403);
    expect(res.body).toMatchObject({ code: 'FORBIDDEN', detail: 'Authorization check failed.' });
  });

  it('answers a resume that the run cannot take with BAD_REQUEST and keeps others hidden', async () => {
    state.runState = {
      data: { _agent: { profileId: 'a1', triggeredBy: { userId: 'u1' } } }
    };
    state.profiles = [{ id: 'a1', enabled: true }];
    state.resumeError = Object.assign(new Error('Run is not in a resumable state'), {
      code: 'INVALID_STATE_FOR_RESUME'
    });
    const refused = await request(app).post('/api/agents/runs/r1/_resume').send({}).expect(400);
    expect(refused.body).toMatchObject({
      code: 'BAD_REQUEST',
      detail: 'Run is not in a resumable state'
    });

    state.resumeError = new Error('socket hang up at /srv/engine.js');
    const hidden = await request(app).post('/api/agents/runs/r1/_resume').send({}).expect(500);
    expect(hidden.body.code).toBe('INTERNAL_ERROR');
    expect(hidden.body.detail).not.toMatch(/srv/);
  });
});
