/**
 * Regression test for GET /api/apps/:appId honoring the platform's
 * configured defaultLanguage when no Accept-Language header is sent.
 *
 * Prior to the fix, the route destructured `configCache.getPlatform()` as
 * `{ data: platform }`, but `getPlatform()` already returns the unwrapped
 * platform object, so `platform` was always `undefined` and the localized
 * `appNotFound` error always fell back to English regardless of the
 * configured `defaultLanguage`. See issue #1800.
 */

import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    getPlatform: () => ({ defaultLanguage: 'de' }),
    getApps: () => ({ data: [] })
  }
}));

jest.unstable_mockModule('../middleware/authRequired.js', () => ({
  authRequired: (req, res, next) => next(),
  appAccessRequired: (req, res, next) => next()
}));

const { default: registerGeneralRoutes } = await import('../routes/generalRoutes.js');

function createTestApp({ getLocalizedError }) {
  const app = express();
  app.use(express.json());
  registerGeneralRoutes(app, { getLocalizedError });
  return app;
}

describe('GET /api/apps/:appId - platform defaultLanguage (regression for #1800)', () => {
  test('uses the configured defaultLanguage when no Accept-Language header is sent', async () => {
    const getLocalizedError = jest.fn().mockResolvedValue('App nicht gefunden');
    const app = createTestApp({ getLocalizedError });

    const response = await request(app).get('/api/apps/does-not-exist');

    expect(response.status).toBe(404);
    expect(getLocalizedError).toHaveBeenCalledWith('appNotFound', {}, 'de');
  });

  test('Accept-Language header still takes precedence over defaultLanguage', async () => {
    const getLocalizedError = jest.fn().mockResolvedValue('App not found');
    const app = createTestApp({ getLocalizedError });

    const response = await request(app)
      .get('/api/apps/does-not-exist')
      .set('Accept-Language', 'fr');

    expect(response.status).toBe(404);
    expect(getLocalizedError).toHaveBeenCalledWith('appNotFound', {}, 'fr');
  });
});
