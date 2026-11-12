// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The Nextcloud embed administration routes answer errors through the global
 * error middleware: every invalid field of the display configuration is a
 * BAD_REQUEST with the reason in `detail`, and an unexpected failure is a 500
 * that does not leak the cause.
 *
 * Native ESM, so `jest.unstable_mockModule` + dynamic imports. Run with
 * `NODE_OPTIONS=--experimental-vm-modules`.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const realOauthClientManager = await import('../utils/oauthClientManager.js');

const state = { platform: {}, written: null, createClient: null, writeError: null };

jest.unstable_mockModule('../middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) => next()
}));
jest.unstable_mockModule('../services/config/ConfigStore.js', () => ({
  default: {
    // Same read-change-write the real store does for updateJson.
    updateJson: async (_path, mutate) => {
      const next = await mutate(structuredClone(state.platform));
      if (state.writeError) throw state.writeError;
      state.written = next;
      return { data: next, written: true };
    }
  }
}));
jest.unstable_mockModule('../configCache.js', () => ({
  default: { getPlatform: () => state.platform, refreshCacheEntry: async () => {} }
}));
jest.unstable_mockModule('../utils/oauthClientManager.js', () => ({
  ...realOauthClientManager,
  createOAuthClient: async (...args) => state.createClient(...args)
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}));

const { default: registerRoutes } = await import('../routes/admin/nextcloudEmbed.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');

const app = express();
app.use(express.json());
registerRoutes(app);
app.use(errorHandler);

const CONFIG_URL = '/api/admin/nextcloud-embed/config';
const long = n => 'x'.repeat(n);
const prompt = { title: { en: 'Hi' }, message: { en: 'Hello there' } };

beforeEach(() => {
  state.platform = {};
  state.written = null;
  state.writeError = null;
  state.createClient = async () => ({ clientId: 'client-1' });
});

describe('Nextcloud embed administration routes: errors', () => {
  it.each([
    ['displayName', 'x', 'displayName must be a localized object'],
    ['displayName', null, 'displayName must be a localized object'],
    ['displayName', ['en'], 'displayName must be a localized object'],
    ['displayName', { en: 1 }, 'displayName.en must be a string'],
    ['displayName', { en: long(251) }, 'displayName.en must not exceed 250 characters'],
    ['displayName', { en: '   ' }, 'displayName must have at least one non-empty locale value'],
    ['description', 'x', 'description must be a localized object'],
    ['description', { de: false }, 'description.de must be a string'],
    ['description', { en: long(251) }, 'description.en must not exceed 250 characters'],
    ['starterPrompts', 'x', 'starterPrompts must be an array'],
    [
      'starterPrompts',
      Array.from({ length: 21 }, () => prompt),
      'starterPrompts must not contain more than 20 entries'
    ],
    ['starterPrompts', ['x'], 'starterPrompts[0] must be an object'],
    ['starterPrompts', [null], 'starterPrompts[0] must be an object'],
    ['starterPrompts', [prompt, [1]], 'starterPrompts[1] must be an object'],
    [
      'starterPrompts',
      [{ message: { en: 'm' } }],
      'starterPrompts[0].title must be a localized object'
    ],
    [
      'starterPrompts',
      [{ title: { en: '' }, message: { en: 'm' } }],
      'starterPrompts[0].title must have at least one non-empty locale value'
    ],
    ['starterPrompts', [{ title: { en: 't' } }], 'starterPrompts[0].message must be a localized'],
    [
      'starterPrompts',
      [{ title: { en: 't' }, message: { en: long(4001) } }],
      'starterPrompts[0].message.en must not exceed 4000 characters'
    ],
    ['allowedHostOrigins', 'x', 'allowedHostOrigins must be an array'],
    [
      'allowedHostOrigins',
      Array.from({ length: 51 }, (_, i) => `https://h${i}.example`),
      'allowedHostOrigins must not contain more than 50 entries'
    ],
    ['allowedHostOrigins', ['not a url'], 'allowedHostOrigins[0] must be a valid http(s) origin'],
    ['allowedHostOrigins', [42], 'allowedHostOrigins[0] must be a valid http(s) origin'],
    ['allowedHostOrigins', ['ftp://cloud.example'], 'must be a valid http(s) origin'],
    ['allowedHostOrigins', ['https://u:p@cloud.example'], 'must be a valid http(s) origin'],
    ['allowedHostOrigins', ['https://cloud.example/path'], 'must be a valid http(s) origin'],
    ['allowedHostOrigins', ['https://cloud.example/?q=1'], 'must be a valid http(s) origin'],
    ['allowedHostOrigins', ['https://cloud.example/#frag'], 'must be a valid http(s) origin'],
    [
      'allowedHostOrigins',
      ['https://ok.example', 'javascript:alert(1)'],
      'allowedHostOrigins[1] must be a valid http(s) origin'
    ]
  ])('answers an invalid %s %j with BAD_REQUEST', async (field, value, reason) => {
    const res = await request(app)
      .put(CONFIG_URL)
      .send({ [field]: value })
      .expect(400);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.code).toBe('BAD_REQUEST');
    expect(res.body.detail).toContain(reason);
    expect(state.written).toBeNull();
  });

  it('saves a valid configuration, canonicalizing and de-duplicating origins', async () => {
    const res = await request(app)
      .put(CONFIG_URL)
      .send({
        displayName: { en: '  Name  ' },
        allowedHostOrigins: ['https://cloud.example/', 'https://cloud.example']
      })
      .expect(200);
    expect(state.written.nextcloudEmbed.displayName).toEqual({ en: 'Name' });
    expect(state.written.nextcloudEmbed.allowedHostOrigins).toEqual(['https://cloud.example']);
    expect(res.body.message).toBeDefined();
  });

  it('answers an unexpected failure when enabling with a 500 that does not leak the cause', async () => {
    state.createClient = async () => {
      throw new Error('secret-clients-file-path.json exploded');
    };
    const res = await request(app).post('/api/admin/nextcloud-embed/_enable').expect(500);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('secret-clients-file-path');
    expect(state.written).toBeNull();
  });

  it('answers a failing write when disabling with a 500', async () => {
    state.writeError = new Error('disk full at platform.json');
    const res = await request(app).post('/api/admin/nextcloud-embed/_disable').expect(500);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('disk full');
  });
});
