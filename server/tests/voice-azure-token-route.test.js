/**
 * Route tests for `GET /api/voice/azure/token`.
 *
 * With a subscription key the route brokers a short-lived Azure token. Without
 * one it answers `{ token: null }` so the browser can connect keyless to an
 * on-prem Azure Speech container (which has no key to configure).
 *
 * Note: The repo's source is native ESM, so this file uses
 * `jest.unstable_mockModule` + dynamic imports. Run with
 * `NODE_OPTIONS=--experimental-vm-modules`.
 */

import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const state = { azure: {}, tokenCalls: [] };

jest.unstable_mockModule('../middleware/authRequired.js', () => ({
  authRequired: (req, res, next) => next()
}));

jest.unstable_mockModule('../configCache.js', () => ({
  default: { getPlatform: () => ({ speech: { azure: state.azure } }) }
}));

jest.unstable_mockModule('../services/azureSpeechToken.js', () => ({
  getAzureSpeechToken: async cfg => {
    state.tokenCalls.push(cfg);
    return { ok: true, token: 'the-token', region: cfg.region };
  }
}));

const { default: registerVoiceRoutes } = await import('../routes/voiceRoutes.js');

const app = express();
registerVoiceRoutes(app);

beforeEach(() => {
  state.tokenCalls = [];
});

describe('GET /api/voice/azure/token', () => {
  test('503 when Azure Speech is disabled', async () => {
    state.azure = { enabled: false, subscriptionKey: 'sk', region: 'westeurope' };
    const res = await request(app).get('/api/voice/azure/token');
    expect(res.status).toBe(503);
  });

  test('brokers a token when a subscription key is configured', async () => {
    state.azure = { enabled: true, subscriptionKey: 'sk', region: 'westeurope' };
    const res = await request(app).get('/api/voice/azure/token');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ token: 'the-token', region: 'westeurope' });
    expect(state.tokenCalls).toHaveLength(1);
  });

  test('returns a null token without a key (on-prem container)', async () => {
    state.azure = { enabled: true, host: 'ws://speech.internal:5000', subscriptionKey: '' };
    const res = await request(app).get('/api/voice/azure/token');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ token: null, region: '' });
    expect(state.tokenCalls).toHaveLength(0);
  });
});
