/**
 * Route tests for `POST /api/admin/voice/azure/test` (Admin → Voice Input →
 * Azure Speech → Test connection).
 *
 * The route exchanges the subscription key for a token, the same exchange a
 * user session performs. A redacted / ${ENV} key means "the saved key", so the
 * secret never has to reach the browser; an empty key means keyless mode.
 *
 * Note: The repo's source is native ESM, so this file uses
 * `jest.unstable_mockModule` + dynamic imports. Run with
 * `NODE_OPTIONS=--experimental-vm-modules`.
 */

import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const state = { azure: {}, tokenCalls: [], tokenResult: null };

jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    refreshCacheEntry: async () => {},
    getPlatform: () => ({ speech: { azure: state.azure } })
  }
}));

jest.unstable_mockModule('../middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) => next()
}));

jest.unstable_mockModule('../middleware/oidcAuth.js', () => ({
  reconfigureOidcProviders: () => {}
}));

jest.unstable_mockModule('../websocket/realtimeTranscription.js', () => ({
  testRealtimeConnection: async () => ({ ok: true })
}));

jest.unstable_mockModule('../services/azureSpeechToken.js', () => ({
  issueAzureSpeechToken: async cfg => {
    state.tokenCalls.push(cfg);
    return state.tokenResult;
  }
}));

const { default: registerAdminConfigRoutes } = await import('../routes/admin/configs.js');

const app = express();
app.use(express.json());
registerAdminConfigRoutes(app);

const post = body => request(app).post('/api/admin/voice/azure/test').send(body);

beforeEach(() => {
  state.azure = {};
  state.tokenCalls = [];
  state.tokenResult = { ok: true, token: 't', region: 'westeurope' };
});

describe('POST /api/admin/voice/azure/test', () => {
  test('tests unsaved form values', async () => {
    const res = await post({ region: 'westeurope', subscriptionKey: 'new-key' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.message).toMatch(/westeurope/);
    expect(state.tokenCalls).toEqual([{ subscriptionKey: 'new-key', region: 'westeurope' }]);
  });

  test('a redacted key means the saved (decrypted) key', async () => {
    state.azure = { subscriptionKey: 'saved-key', region: 'westeurope' };
    await post({ region: 'westeurope', subscriptionKey: '***REDACTED***' });
    expect(state.tokenCalls[0].subscriptionKey).toBe('saved-key');
  });

  test('an ${ENV} placeholder means the saved (resolved) key', async () => {
    state.azure = { subscriptionKey: 'resolved-key', region: 'westeurope' };
    await post({ region: 'westeurope', subscriptionKey: '${AZURE_SPEECH_KEY}' });
    expect(state.tokenCalls[0].subscriptionKey).toBe('resolved-key');
  });

  test('falls back to the saved values when the body is empty', async () => {
    state.azure = { subscriptionKey: 'saved-key', region: 'northeurope' };
    await post({});
    expect(state.tokenCalls).toEqual([{ subscriptionKey: 'saved-key', region: 'northeurope' }]);
  });

  test('keyless with a host: ok, points at the browser test, contacts nobody', async () => {
    state.azure = { subscriptionKey: 'saved-key' };
    const res = await post({ host: 'ws://speech.internal:5000', subscriptionKey: '' });
    expect(res.body.ok).toBe(true);
    expect(res.body.message).toMatch(/keyless/i);
    expect(state.tokenCalls).toHaveLength(0);
  });

  test('neither key nor host: not ok', async () => {
    const res = await post({ host: '', subscriptionKey: '' });
    expect(res.body.ok).toBe(false);
    expect(state.tokenCalls).toHaveLength(0);
  });

  test('a rejected key explains HTTP 401', async () => {
    state.tokenResult = { ok: false, error: 'Azure token request failed (HTTP 401)' };
    const res = await post({ region: 'westeurope', subscriptionKey: 'bad' });
    expect(res.body.ok).toBe(false);
    expect(res.body.message).toMatch(/HTTP 401.*invalid or belongs to a different region/);
  });

  test('passes other token errors through', async () => {
    state.tokenResult = { ok: false, error: 'Invalid Azure region "not a region"' };
    const res = await post({ region: 'not a region', subscriptionKey: 'k' });
    expect(res.body).toEqual({ ok: false, message: 'Invalid Azure region "not a region"' });
  });
});
