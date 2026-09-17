/**
 * The `feedback` registry flag gates `POST /api/feedback` server-side, so
 * disabling it in the admin Features panel can't be bypassed by calling the
 * API directly (see concepts/2026-09-17 Feedback Visibility Toggle.md).
 *
 * Exercises the real route (request → response) with only its collaborators
 * mocked, following the shape used for other feature-gated integration tests
 * (server/tests/oauth-connections.test.js): `requireFeature` itself is real,
 * driven by a mocked `configCache.getFeatures()`.
 *
 * Native-ESM jest (`NODE_OPTIONS=--experimental-vm-modules`).
 */

import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const state = {
  platform: {},
  features: {},
  user: { id: 'alice', name: 'Alice', authMode: 'local' }
};

function resetState() {
  state.platform = { defaultLanguage: 'en' };
  state.features = { feedback: true };
  state.user = { id: 'alice', name: 'Alice', authMode: 'local' };
}

jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    getPlatform: () => state.platform,
    getFeatures: () => state.features,
    get: () => null,
    setCacheEntry: () => {}
  }
}));

jest.unstable_mockModule('../middleware/authRequired.js', () => ({
  authRequired: (req, res, next) => {
    req.user = state.user;
    next();
  }
}));

jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }
}));

jest.unstable_mockModule('../utils.js', () => ({
  logInteraction: jest.fn().mockResolvedValue()
}));

jest.unstable_mockModule('../usageTracker.js', () => ({
  recordFeedback: jest.fn().mockResolvedValue()
}));

jest.unstable_mockModule('../feedbackStorage.js', () => ({
  storeFeedback: jest.fn()
}));

jest.unstable_mockModule('../services/integrations/ConversationApiService.js', () => ({
  default: { sendFeedback: jest.fn().mockResolvedValue({}) }
}));

jest.unstable_mockModule('../services/integrations/ConversationStateManager.js', () => ({
  default: { loadState: jest.fn().mockResolvedValue(null) }
}));

jest.unstable_mockModule('../services/integrations/iAssistantService.js', () => ({
  default: { getConfig: jest.fn().mockReturnValue({}) }
}));

jest.unstable_mockModule('../services/loop/RunLog.js', () => ({
  default: { appendRecovered: jest.fn(), identityMode: () => 'default' },
  isValidRunId: () => false
}));

jest.unstable_mockModule('../services/loop/runIdentity.js', () => ({
  resolveActorId: jest.fn()
}));

jest.unstable_mockModule('../services/loop/runAccess.js', () => ({
  authorizeRun: jest.fn()
}));

// `requireFeature` itself is left real — that's what this test verifies.
const { default: registerFeedbackRoutes } = await import('../routes/chat/feedbackRoutes.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  registerFeedbackRoutes(app, {
    getLocalizedError: async () => 'Missing required fields'
  });
  return app;
}

function validFeedbackBody(overrides = {}) {
  return {
    messageId: 'msg-1',
    appId: 'app-1',
    chatId: 'chat-1',
    rating: 4.5,
    ...overrides
  };
}

beforeEach(resetState);

describe('POST /api/feedback — feedback visibility flag', () => {
  test('rejects with 403 FEATURE_DISABLED when the feedback flag is disabled', async () => {
    state.features.feedback = false;

    const response = await request(buildApp()).post('/api/feedback').send(validFeedbackBody());

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('FEATURE_DISABLED');
  });

  test('accepts the submission when the feedback flag is enabled', async () => {
    state.features.feedback = true;

    const response = await request(buildApp()).post('/api/feedback').send(validFeedbackBody());

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
  });

  test('defaults to enabled for installations with no explicit feedback flag set', async () => {
    state.features = {}; // no key at all — resolves to the registry default (true)

    const response = await request(buildApp()).post('/api/feedback').send(validFeedbackBody());

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
  });
});
