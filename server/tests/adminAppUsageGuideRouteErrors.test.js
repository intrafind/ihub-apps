// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The admin app usage guide route answers errors through the global error
 * middleware: a missing app or invalid language is a BAD_REQUEST, a missing
 * chat model (service status 503) is SERVICE_UNAVAILABLE with the reason in
 * `detail`, a failing model call answers with its LLM code and an unexpected
 * failure is a 500 that does not leak the cause.
 *
 * Native ESM, so `jest.unstable_mockModule` + dynamic imports. Run with
 * `NODE_OPTIONS=--experimental-vm-modules`.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const state = { error: null, calls: [] };

jest.unstable_mockModule('../middleware/contentAdminAuth.js', () => ({
  contentAdminAuth: (req, res, next) => {
    req.user = { id: 'admin' };
    next();
  }
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}));
const realGuide = await import('../services/appUsageGuide.js');
jest.unstable_mockModule('../services/appUsageGuide.js', () => ({
  ...realGuide,
  generateUsageGuide: async args => {
    state.calls.push(args);
    if (state.error) throw state.error;
    return '# Guide';
  }
}));

const { default: registerAdminAppUsageGuideRoute } =
  await import('../routes/admin/appUsageGuide.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');
const { LLMError } = await import('../services/loop/contracts/errors.js');

const app = express();
app.use(express.json());
registerAdminAppUsageGuideRoute(app);
app.use(errorHandler);

const URL = '/api/admin/apps/_usage-guide';

beforeEach(() => {
  state.error = null;
  state.calls = [];
});

describe('admin app usage guide route: errors', () => {
  it.each([[{}], [{ app: 'x' }], [{ app: [] }], [{ app: null }]])(
    'answers a missing or invalid app %j with BAD_REQUEST',
    async body => {
      const res = await request(app).post(URL).send(body).expect(400);
      expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
      expect(res.body.code).toBe('BAD_REQUEST');
      expect(state.calls).toHaveLength(0);
    }
  );

  it.each([[123], ['not a language!'], ['../etc']])(
    'answers an invalid language %j with BAD_REQUEST',
    async language => {
      const res = await request(app)
        .post(URL)
        .send({ app: { id: 'a' }, language })
        .expect(400);
      expect(res.body).toMatchObject({ code: 'BAD_REQUEST', detail: 'Invalid language code' });
      expect(state.calls).toHaveLength(0);
    }
  );

  it('generates a guide with the default language', async () => {
    const res = await request(app)
      .post(URL)
      .send({ app: { id: 'a' } })
      .expect(200);
    expect(res.body).toEqual({ content: '# Guide' });
    expect(state.calls[0]).toMatchObject({ app: { id: 'a' }, language: 'en' });
  });

  it('answers a missing chat model with SERVICE_UNAVAILABLE and the reason', async () => {
    state.error = Object.assign(new Error('No chat model available'), { status: 503 });
    const res = await request(app)
      .post(URL)
      .send({ app: { id: 'a' } })
      .expect(503);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body).toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      status: 503,
      detail: 'No chat model available'
    });
  });

  it('answers a failing model call with its LLM code', async () => {
    state.error = new LLMError('Invalid API key', { code: 'AUTH_FAILED', status: 401 });
    const res = await request(app)
      .post(URL)
      .send({ app: { id: 'a' } })
      .expect(502);
    expect(res.body.code).toBe('AUTH_FAILED');
  });

  it('hides the reason of an unexpected failure', async () => {
    state.error = new Error('boom at /srv/secret/path');
    const res = await request(app)
      .post(URL)
      .send({ app: { id: 'a' } })
      .expect(500);
    expect(res.body.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('/srv/secret');
  });
});
