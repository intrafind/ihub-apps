// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The people directory editor route returns the editor context without
 * secrets; an unexpected failure of the platform cache is a 500 that does not
 * leak the cause.
 *
 * Native ESM, so `jest.unstable_mockModule` + dynamic imports. Run with
 * `NODE_OPTIONS=--experimental-vm-modules`.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const state = { platform: {}, error: null };

jest.unstable_mockModule('../middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) => next()
}));
jest.unstable_mockModule('../middleware/authRequired.js', () => ({
  authRequired: (req, res, next) => next()
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}));
jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    getPlatform: () => {
      if (state.error) throw state.error;
      return state.platform;
    }
  }
}));

const { default: registerRoutes } = await import('../routes/admin/peopleDirectoryEditor.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');

const app = express();
app.use(express.json());
registerRoutes(app);
app.use(errorHandler);

const URL_PATH = '/api/admin/integrations/people-directories/editor-context';

beforeEach(() => {
  state.platform = {};
  state.error = null;
});

describe('People directory editor route: errors', () => {
  it('returns the editor context without bind secrets', async () => {
    state.platform = {
      ldapAuth: {
        providers: [
          {
            name: 'corp',
            url: 'ldaps://ldap.example:636',
            adminDn: 'cn=bind',
            adminPassword: 'topsecret'
          }
        ]
      }
    };
    const res = await request(app).get(URL_PATH).expect(200);
    expect(res.body.presets.length).toBeGreaterThan(0);
    expect(res.body.ldapProviders).toHaveLength(1);
    expect(res.body.ldapProviders[0]).toMatchObject({
      name: 'corp',
      host: 'ldap.example',
      hasBindAccount: true
    });
    expect(JSON.stringify(res.body)).not.toContain('topsecret');
  });

  it('answers an unexpected failure with a 500 that does not leak the cause', async () => {
    state.error = new Error('boom at /srv/secret/path');
    const res = await request(app).get(URL_PATH).expect(500);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('/srv/secret');
    expect(JSON.stringify(res.body)).not.toContain('boom');
  });
});
