// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The workflow execution routes answer errors through the global error
 * middleware (`application/problem+json`: `{ type, title, status, detail, code, details? }`): a missing or foreign execution, an
 * unsafe id, a delete of a running execution, and a cancel the engine refuses.
 *
 * Native ESM, so `jest.unstable_mockModule` + dynamic imports. Run with
 * `NODE_OPTIONS=--experimental-vm-modules`.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const executions = new Map();
const registry = {
  get: async id => executions.get(id) || null,
  remove: async id => executions.delete(id)
};

jest.unstable_mockModule('../services/workflow/ExecutionRegistry.js', () => ({
  getExecutionRegistry: () => registry,
  default: class {}
}));
const webhooks = { ref: null };
jest.unstable_mockModule('../services/workflow/triggers/TriggerManager.js', () => ({
  getTriggerManager: () => ({
    getWebhookTrigger: () => webhooks.ref,
    fireTrigger: async () => {}
  })
}));
const realSse = await import('../utils/sseChannel.js');
// The module starts an interval at import; the test must not keep the process alive.
jest.unstable_mockModule('../utils/sseChannel.js', () => ({
  ...realSse,
  startInactiveClientSweep: () => {}
}));
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
jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}));

const { default: configCache } = await import('../configCache.js');
const { default: registerWorkflowRoutes } = await import('../routes/workflow/workflowRoutes.js');
const { default: registerTriggerRoutes } = await import('../routes/workflow/triggerRoutes.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');

configCache.getFeatures = () => ({ workflows: true });

const engine = {
  cancelAnywhere: jest.fn(),
  deleteExecution: jest.fn()
};

const app = express();
app.use(express.json());
registerWorkflowRoutes(app, { workflowEngine: engine });
registerTriggerRoutes(app);
app.use(errorHandler);

beforeEach(() => {
  executions.clear();
  engine.cancelAnywhere.mockReset();
  engine.deleteExecution.mockReset();
});

describe('workflow execution routes', () => {
  it('answers an unsafe execution id with BAD_REQUEST', async () => {
    const res = await request(app).delete('/api/workflows/executions/bad%20id').expect(400);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.body).toEqual({
      type: 'urn:ihub:problem:BAD_REQUEST',
      title: 'The request is not valid.',
      status: 400,
      detail: 'Invalid executionId',
      code: 'BAD_REQUEST'
    });
  });

  it('answers an unknown execution with NOT_FOUND', async () => {
    const res = await request(app).post('/api/workflows/executions/nope/cancel').expect(404);
    expect(res.body).toEqual({
      type: 'urn:ihub:problem:NOT_FOUND',
      title: 'The requested resource was not found.',
      status: 404,
      detail: 'Execution not found',
      code: 'NOT_FOUND'
    });
  });

  it('refuses someone else’s execution with FORBIDDEN', async () => {
    executions.set('run1', { executionId: 'run1', userId: 'grace', status: 'completed' });
    const res = await request(app).delete('/api/workflows/executions/run1').expect(403);
    expect(res.body.code).toBe('FORBIDDEN');
    expect(engine.deleteExecution).not.toHaveBeenCalled();
  });

  it('refuses to delete a running execution with EXECUTION_ACTIVE', async () => {
    executions.set('run1', { executionId: 'run1', userId: 'ada', status: 'running' });
    const res = await request(app).delete('/api/workflows/executions/run1').expect(409);
    expect(res.body.code).toBe('EXECUTION_ACTIVE');
    expect(executions.has('run1')).toBe(true);
  });

  it('maps an engine that finds the execution active while deleting to EXECUTION_ACTIVE', async () => {
    executions.set('run1', { executionId: 'run1', userId: 'ada', status: 'completed' });
    engine.deleteExecution.mockRejectedValue(
      Object.assign(new Error('active'), { code: 'EXECUTION_ACTIVE' })
    );
    const res = await request(app).delete('/api/workflows/executions/run1').expect(409);
    expect(res.body.code).toBe('EXECUTION_ACTIVE');
  });

  it('deletes a finished execution', async () => {
    executions.set('run1', { executionId: 'run1', userId: 'ada', status: 'completed' });
    engine.deleteExecution.mockResolvedValue();
    await request(app).delete('/api/workflows/executions/run1').expect(200);
    expect(executions.has('run1')).toBe(false);
  });

  it('answers a cancel the engine cannot find with NOT_FOUND and hides other failures', async () => {
    executions.set('run1', { executionId: 'run1', userId: 'ada', status: 'running' });
    engine.cancelAnywhere.mockRejectedValueOnce(
      Object.assign(new Error('gone'), { code: 'EXECUTION_NOT_FOUND' })
    );
    const missing = await request(app).post('/api/workflows/executions/run1/cancel').expect(404);
    expect(missing.body.code).toBe('NOT_FOUND');

    engine.cancelAnywhere.mockRejectedValueOnce(new Error('/srv/secret/path exploded'));
    const failed = await request(app).post('/api/workflows/executions/run1/cancel').expect(500);
    expect(failed.body.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(failed.body)).not.toContain('/srv/secret');
  });

  it('answers an archive request without a boolean with BAD_REQUEST', async () => {
    const res = await request(app)
      .patch('/api/workflows/executions/run1')
      .send({ archived: 'yes' })
      .expect(400);
    expect(res.body.code).toBe('BAD_REQUEST');
    expect(res.body.detail).toBe('archived must be a boolean');
  });
});

describe('workflow webhook route', () => {
  const hook = () => request(app).post('/api/workflows/wf1/webhooks/t1');

  it('answers an unknown trigger with NOT_FOUND', async () => {
    webhooks.ref = null;
    const res = await hook().send('{}').expect(404);
    expect(res.body).toEqual({
      type: 'urn:ihub:problem:NOT_FOUND',
      title: 'The requested resource was not found.',
      status: 404,
      detail: 'Webhook trigger not found',
      code: 'NOT_FOUND'
    });
  });

  it('refuses a trigger without a secret and a wrong signature with AUTH_REQUIRED', async () => {
    webhooks.ref = { trigger: { config: {}, verifyRawSignature: () => false } };
    const noSecret = await hook().send('{}').expect(401);
    expect(noSecret.body.code).toBe('AUTH_REQUIRED');

    webhooks.ref = { trigger: { config: { secret: 's' }, verifyRawSignature: () => false } };
    const badSignature = await hook().send('{}').expect(401);
    expect(badSignature.body).toEqual({
      type: 'urn:ihub:problem:AUTH_REQUIRED',
      title: 'Authentication required. Please sign in.',
      status: 401,
      detail: 'Invalid signature',
      code: 'AUTH_REQUIRED'
    });
  });

  it('refuses a body that is not JSON with BAD_REQUEST', async () => {
    webhooks.ref = { trigger: { config: { secret: 's' }, verifyRawSignature: () => true } };
    const res = await hook().set('content-type', 'text/plain').send('not json').expect(400);
    expect(res.body).toEqual({
      type: 'urn:ihub:problem:BAD_REQUEST',
      title: 'The request is not valid.',
      status: 400,
      detail: 'Invalid JSON body',
      code: 'BAD_REQUEST'
    });
  });
});
