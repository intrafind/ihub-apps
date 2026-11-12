// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The feature flag administration routes answer errors through the global
 * error middleware: a malformed body, an unknown feature ID or a non-boolean
 * value is a BAD_REQUEST with the reason in `detail`, and an unexpected
 * failure is a 500 that does not leak the thrown message.
 *
 * Native ESM, so `jest.unstable_mockModule` + dynamic imports. Run with
 * `NODE_OPTIONS=--experimental-vm-modules`.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const state = { existing: {}, written: null, readError: null };

jest.unstable_mockModule('../middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) => next()
}));
jest.unstable_mockModule('../services/config/ConfigStore.js', () => ({
  default: {
    readJson: async () => {
      if (state.readError) throw state.readError;
      return state.existing;
    },
    updateJson: async (_path, mutate) => {
      if (state.readError) throw state.readError;
      const data = await mutate(structuredClone(state.existing));
      state.written = data;
      return { data, written: true };
    }
  }
}));
jest.unstable_mockModule('../configCache.js', () => ({
  default: { getFeatures: () => ({}), refreshCacheEntry: async () => {} }
}));
jest.unstable_mockModule('../services/AuditLogService.js', () => ({
  logAudit: async () => {}
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}));

const { featureRegistry } = await import('../featureRegistry.js');
const { default: registerAdminFeaturesRoutes } = await import('../routes/admin/features.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');

const app = express();
app.use(express.json());
registerAdminFeaturesRoutes(app);
app.use(errorHandler);

const KNOWN_ID = featureRegistry[0].id;

beforeEach(() => {
  state.existing = {};
  state.written = null;
  state.readError = null;
});

describe('feature administration routes: errors', () => {
  it.each([
    [[true], 'Request body must be an object of feature flags'],
    [{ noSuchFeature: true }, 'Unknown feature ID: noSuchFeature'],
    [{ [KNOWN_ID]: 'yes' }, `Feature "${KNOWN_ID}" must be a boolean value`]
  ])('answers invalid body %j with BAD_REQUEST', async (body, reason) => {
    const res = await request(app).put('/api/admin/features').send(body).expect(400);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.code).toBe('BAD_REQUEST');
    expect(res.body.detail).toContain(reason);
    expect(state.written).toBeNull();
  });

  it('saves a valid update merged into the existing overrides', async () => {
    state.existing = { other: false };
    await request(app)
      .put('/api/admin/features')
      .send({ [KNOWN_ID]: true })
      .expect(200);
    expect(state.written).toEqual({ other: false, [KNOWN_ID]: true });
  });

  it('answers an unexpected failure with a 500 that does not leak the cause', async () => {
    state.readError = new Error('boom at /srv/secret/path');
    const res = await request(app)
      .put('/api/admin/features')
      .send({ [KNOWN_ID]: true })
      .expect(500);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('/srv/secret');
  });
});
