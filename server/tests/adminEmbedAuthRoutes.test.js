// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Administration of the sign-in for iHub in a frame of another site
 * (`GET`/`PUT /api/admin/embed-auth/config`, `routes/admin/embedAuth.js`).
 *
 * Locked in here:
 * - the settings are read as the page shows them, `active` included,
 * - a save needs the whole state, validates every origin, and keeps what else is in the block,
 * - an invalid field is a `BAD_REQUEST` that names it, a failing write does not leak its cause,
 * - every change is audited.
 *
 * Native ESM: `jest.unstable_mockModule` + dynamic imports.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const state = { platform: {}, written: null, writeError: null, audits: [] };

jest.unstable_mockModule('../middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) => next()
}));
jest.unstable_mockModule('../services/config/ConfigStore.js', () => ({
  default: {
    // The same read-change-write the real store does for updateJson; a saved file is also what
    // the cache then holds.
    updateJson: async (_path, mutate) => {
      const next = await mutate(structuredClone(state.platform));
      if (state.writeError) throw state.writeError;
      state.written = next;
      state.platform = next;
      return { data: next, written: true };
    }
  }
}));
jest.unstable_mockModule('../configCache.js', () => ({
  default: { getPlatform: () => state.platform, refreshCacheEntry: async () => {} }
}));
jest.unstable_mockModule('../services/AuditLogService.js', () => ({
  logAudit: entry => state.audits.push(entry)
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}));

const { default: registerRoutes } = await import('../routes/admin/embedAuth.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');

const app = express();
app.use(express.json());
registerRoutes(app);
app.use(errorHandler);

const URL_PATH = '/api/admin/embed-auth/config';
const HOST = 'https://ifinder.example.com';

beforeEach(() => {
  state.platform = { auth: { mode: 'oidc' }, embedAuth: undefined };
  delete state.platform.embedAuth;
  state.written = null;
  state.writeError = null;
  state.audits = [];
});

describe(`GET ${URL_PATH}`, () => {
  it('answers off with no origins for an installation that never set it up', async () => {
    const res = await request(app).get(URL_PATH);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: false, allowedHostOrigins: [], active: false });
  });

  it('is active while it is on and an origin is allowed', async () => {
    state.platform.embedAuth = { enabled: true, allowedHostOrigins: [HOST] };

    const res = await request(app).get(URL_PATH);

    expect(res.body).toEqual({ enabled: true, allowedHostOrigins: [HOST], active: true });
  });

  it('is not active when it is on without an origin, and says so', async () => {
    state.platform.embedAuth = { enabled: true, allowedHostOrigins: [] };

    const res = await request(app).get(URL_PATH);

    expect(res.body).toEqual({ enabled: true, allowedHostOrigins: [], active: false });
  });

  it('keeps the list but is not active while the switch is off', async () => {
    state.platform.embedAuth = { enabled: false, allowedHostOrigins: [HOST] };

    const res = await request(app).get(URL_PATH);

    expect(res.body).toEqual({ enabled: false, allowedHostOrigins: [HOST], active: false });
  });

  it('leaves out an entry that is not a string', async () => {
    state.platform.embedAuth = { enabled: true, allowedHostOrigins: [HOST, 42, null] };

    const res = await request(app).get(URL_PATH);

    expect(res.body.allowedHostOrigins).toEqual([HOST]);
  });
});

describe(`PUT ${URL_PATH}`, () => {
  const put = body => request(app).put(URL_PATH).send(body);

  it('stores the state and answers with it', async () => {
    const res = await put({ enabled: true, allowedHostOrigins: [HOST] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: true, allowedHostOrigins: [HOST], active: true });
    expect(state.written.embedAuth).toEqual({ enabled: true, allowedHostOrigins: [HOST] });
  });

  it('canonicalises the origins and drops duplicates, keeping the order', async () => {
    const res = await put({
      enabled: true,
      allowedHostOrigins: [
        'https://IFinder.example.com/',
        'http://localhost:3000',
        HOST,
        '  https://portal.example.com  '
      ]
    });

    expect(res.status).toBe(200);
    expect(res.body.allowedHostOrigins).toEqual([
      HOST,
      'http://localhost:3000',
      'https://portal.example.com'
    ]);
  });

  it('keeps what else is in the block and in the platform configuration', async () => {
    state.platform.embedAuth = {
      enabled: false,
      note: 'kept',
      allowedHostOrigins: ['https://old.example.com']
    };

    await put({ enabled: true, allowedHostOrigins: [HOST] });

    expect(state.written.embedAuth).toEqual({
      enabled: true,
      note: 'kept',
      allowedHostOrigins: [HOST]
    });
    expect(state.written.auth).toEqual({ mode: 'oidc' });
  });

  it('accepts switching off with the list kept, and an empty list', async () => {
    expect((await put({ enabled: false, allowedHostOrigins: [HOST] })).body.active).toBe(false);
    expect((await put({ enabled: true, allowedHostOrigins: [] })).status).toBe(200);
  });

  it('audits the change, naming the hosts', async () => {
    await put({ enabled: true, allowedHostOrigins: [HOST] });
    await put({ enabled: false, allowedHostOrigins: [HOST] });

    expect(state.audits).toHaveLength(2);
    expect(state.audits[0]).toMatchObject({
      action: 'update',
      resource: 'platform',
      resourceId: 'embedAuth'
    });
    expect(state.audits[0].summary).toContain(HOST);
    expect(state.audits[1].summary).toMatch(/off/);
  });

  describe('refuses', () => {
    const expectBadRequest = (res, detail) => {
      expect(res.status).toBe(400);
      expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
      expect(res.body.code).toBe('BAD_REQUEST');
      if (detail) expect(res.body.detail).toMatch(detail);
      expect(state.written).toBeNull();
    };

    it('a switch that is not a boolean', async () => {
      for (const enabled of [undefined, 'true', 1, null]) {
        expectBadRequest(
          await put({ enabled, allowedHostOrigins: [HOST] }),
          /enabled must be a boolean/
        );
      }
    });

    it('a request without the list, or with something else than a list', async () => {
      expectBadRequest(await put({ enabled: true }), /allowedHostOrigins is required/);
      expectBadRequest(
        await put({ enabled: true, allowedHostOrigins: HOST }),
        /allowedHostOrigins must be an array/
      );
    });

    it('a body that is not an object', async () => {
      expectBadRequest(await request(app).put(URL_PATH), /enabled must be a boolean/);
    });

    it.each([
      ['a path', 'https://ifinder.example.com/app'],
      ['a query', 'https://ifinder.example.com/?x=1'],
      ['a fragment', 'https://ifinder.example.com/#top'],
      ['credentials', 'https://user:pass@ifinder.example.com'],
      ['another scheme', 'ftp://ifinder.example.com'],
      ['a script scheme', 'javascript:alert(1)'],
      ['something that is not a URL', 'ifinder'],
      ['an empty entry', '  '],
      ['an entry that is not a string', 42]
    ])('an origin with %s, naming the entry', async (_label, bad) => {
      const res = await put({ enabled: true, allowedHostOrigins: [HOST, bad] });

      expectBadRequest(res, /allowedHostOrigins\[1\] must be a valid http\(s\) origin/);
    });

    it('more than 50 origins', async () => {
      const many = Array.from({ length: 51 }, (_, i) => `https://host${i}.example.com`);

      expectBadRequest(
        await put({ enabled: true, allowedHostOrigins: many }),
        /must not contain more than 50 entries/
      );
      expect((await put({ enabled: true, allowedHostOrigins: many.slice(0, 50) })).status).toBe(
        200
      );
    });
  });

  it('answers a failing write with a 500 that does not leak the cause', async () => {
    state.writeError = new Error('EACCES: /secret/path/platform.json');

    const res = await put({ enabled: true, allowedHostOrigins: [HOST] });

    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('secret');
    expect(state.audits).toHaveLength(0);
  });
});
