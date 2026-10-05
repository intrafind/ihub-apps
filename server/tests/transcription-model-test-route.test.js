/**
 * Route test for the "Test" action on a transcription model (Admin → Models):
 * `POST /api/admin/models/:modelId/test` starts a session upstream instead of
 * asking for a chat completion, and reports the outcome in the shape every
 * model test uses. The upstream check itself (`testTranscriptionModel`) is a
 * fake here; realtimeTranscription.test.js covers it.
 *
 * Native ESM: uses `jest.unstable_mockModule` + dynamic imports. Run with
 * `NODE_OPTIONS=--experimental-vm-modules`.
 */

import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const transcriptionModel = {
  id: 'voxtral-mini-realtime',
  modelId: 'mistralai/Voxtral-Mini-4B-Realtime-2602',
  url: 'ws://gpu-box:8000/v1/realtime',
  provider: 'vllm-realtime',
  modelType: 'transcription',
  apiKey: 'secret',
  enabled: false
};

const state = { result: { ok: true, message: 'Connected — the endpoint started a session' } };
const tested = [];

jest.unstable_mockModule('../middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) => {
    req.user = { id: 'admin' };
    next();
  }
}));

jest.unstable_mockModule('../websocket/realtimeTranscription.js', () => ({
  testTranscriptionModel: async model => {
    tested.push(model.id);
    return state.result;
  }
}));

const { default: registerAdminModelsRoutes } = await import('../routes/admin/models.js');
const { default: configCache } = await import('../configCache.js');

beforeAll(() => {
  configCache.setCacheEntry('config/models.json', [transcriptionModel]);
});

afterAll(() => {
  const timer = configCache.refreshTimers?.get('config/models.json');
  if (timer) clearTimeout(timer);
  configCache.refreshTimers?.delete('config/models.json');
});

const app = express();
app.use(express.json());
registerAdminModelsRoutes(app);

const url = '/api/admin/models/voxtral-mini-realtime/test';

test('a working endpoint passes, and the key is not echoed', async () => {
  const res = await request(app).post(url);
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({
    success: true,
    messageKey: 'testSuccessful',
    response: 'Connected — the endpoint started a session'
  });
  expect(res.body.model.apiKey).toBeUndefined();
  // Disabled models are tested too: that is how an admin checks one first.
  expect(tested).toContain('voxtral-mini-realtime');
});

test('a failing endpoint is a 502 carrying the reason', async () => {
  state.result = { ok: false, message: 'Connection failed: connect ECONNREFUSED' };
  const res = await request(app).post(url);
  expect(res.status).toBe(502);
  expect(res.body).toEqual({
    error: 'Connection failed: connect ECONNREFUSED',
    details: 'Connection failed: connect ECONNREFUSED',
    code: 'upstream-error'
  });
});
