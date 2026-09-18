/**
 * The two switches that decide whether response feedback is accepted at all:
 * the platform-wide `feedback` feature flag and an app's own
 * `features.feedback`.
 *
 * Hiding the star rating in the client is a UI decision; this is the one that
 * holds when someone posts to `/api/feedback` directly, so both switches are
 * checked here against the middleware chain the route is actually registered
 * with — not against a hand-built one.
 */
import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import configCache from '../configCache.js';
import registerFeedbackRoutes, {
  requireAppFeedbackEnabled
} from '../routes/chat/feedbackRoutes.js';

/**
 * The handler chain `/api/feedback` is registered with.
 *
 * @returns {Function[]}
 */
function feedbackChain() {
  let chain = null;
  registerFeedbackRoutes(
    {
      post: (routePath, ...handlers) => {
        if (routePath.endsWith('/api/feedback')) chain = handlers;
      },
      get: () => {},
      put: () => {},
      delete: () => {},
      use: () => {}
    },
    { getLocalizedError: async () => 'missing fields' }
  );
  assert.ok(chain, 'POST /api/feedback was not registered');
  return chain;
}

/** A response double that records what the chain answered with. */
function responseDouble() {
  const res = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };
  return res;
}

/**
 * Run one middleware and report whether it passed the request on.
 *
 * @param {Function} middleware
 * @param {Object} req
 * @returns {Promise<{passed: boolean, res: Object}>}
 */
async function run(middleware, req) {
  const res = responseDouble();
  let passed = false;
  await middleware(req, res, () => {
    passed = true;
  });
  return { passed, res };
}

describe('feedback feature gate', () => {
  beforeEach(() => {
    mock.restoreAll();
  });

  it('registers the platform guard and the per-app guard in the chain', () => {
    const chain = feedbackChain();
    assert.ok(
      chain.includes(requireAppFeedbackEnabled),
      'the per-app guard runs as part of the route chain'
    );
    // authRequired, requireFeature, validate, requireAppFeedbackEnabled, handler
    assert.equal(chain.length, 5);
    assert.ok(
      chain.indexOf(requireAppFeedbackEnabled) < chain.length - 1,
      'the per-app guard runs before the handler'
    );
  });

  it('answers 403 FEATURE_DISABLED when the platform flag is off', async () => {
    mock.method(configCache, 'getFeatures', () => ({ feedback: false }));
    const chain = feedbackChain();
    const platformGuard = chain[1];

    const { passed, res } = await run(platformGuard, { body: { appId: 'chat' } });

    assert.equal(passed, false);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, 'FEATURE_DISABLED');
  });

  it('lets the request through when the platform flag is on', async () => {
    mock.method(configCache, 'getFeatures', () => ({ feedback: true }));
    const chain = feedbackChain();

    const { passed, res } = await run(chain[1], { body: { appId: 'chat' } });

    assert.equal(passed, true);
    assert.equal(res.statusCode, null);
  });

  it('defaults to enabled when no feature config was saved', async () => {
    mock.method(configCache, 'getFeatures', () => ({}));
    const chain = feedbackChain();

    const { passed } = await run(chain[1], { body: { appId: 'chat' } });

    assert.equal(passed, true);
  });

  it('answers 403 FEATURE_DISABLED for an app that opted out', async () => {
    mock.method(configCache, 'getApps', () => ({
      data: [{ id: 'quiet-app', features: { feedback: false } }]
    }));

    const { passed, res } = await run(requireAppFeedbackEnabled, {
      body: { appId: 'quiet-app' }
    });

    assert.equal(passed, false);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, 'FEATURE_DISABLED');
  });

  it('leaves other apps alone', async () => {
    mock.method(configCache, 'getApps', () => ({
      data: [
        { id: 'quiet-app', features: { feedback: false } },
        { id: 'chat', features: { compareMode: { enabled: true } } },
        { id: 'plain' }
      ]
    }));

    for (const appId of ['chat', 'plain']) {
      const { passed } = await run(requireAppFeedbackEnabled, { body: { appId } });
      assert.equal(passed, true, `${appId} keeps feedback`);
    }
  });

  it('matches the app id case-insensitively, like every other app lookup', async () => {
    mock.method(configCache, 'getApps', () => ({
      data: [{ id: 'Quiet-App', features: { feedback: false } }]
    }));

    const { passed, res } = await run(requireAppFeedbackEnabled, {
      body: { appId: 'quiet-app' }
    });

    assert.equal(passed, false);
    assert.equal(res.statusCode, 403);
  });

  it('does not drop feedback for an app it cannot find', async () => {
    mock.method(configCache, 'getApps', () => ({ data: [] }));

    const { passed } = await run(requireAppFeedbackEnabled, { body: { appId: 'gone' } });

    assert.equal(passed, true);
  });
});
