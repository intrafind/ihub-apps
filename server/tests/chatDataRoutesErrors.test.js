// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The chat data routes (styles, UI config, mimetypes, platform, translations)
 * answer a configuration that cannot be loaded through the global error
 * middleware: a 500 with the registry code INTERNAL_ERROR. The translations
 * route falls back to the default language before giving up.
 *
 * Native ESM, so `jest.unstable_mockModule` + dynamic imports. Run with
 * `NODE_OPTIONS=--experimental-vm-modules`.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const realAuthRequired = await import('../middleware/authRequired.js');
const realCache = (await import('../configCache.js')).default;

const state = {};
const locales = {};
const loadAttempts = [];

jest.unstable_mockModule('../middleware/authRequired.js', () => ({
  ...realAuthRequired,
  authRequired: (req, res, next) => next()
}));
jest.unstable_mockModule('../configCache.js', () => ({
  default: Object.assign(Object.create(realCache), {
    getStyles: () => state.styles,
    getUI: () => state.ui,
    getMimetypes: () => state.mimetypes,
    getPlatform: () => state.platform,
    getSupportedLanguages: () => ['en', 'de'],
    getLocalizations: lang => ({ data: locales[lang] ?? null }),
    loadAndCacheLocale: async lang => {
      loadAttempts.push(lang);
      if (state.loadError) throw state.loadError;
      if (state.loadable?.[lang]) locales[lang] = state.loadable[lang];
    }
  })
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}));

const { default: registerDataRoutes } = await import('../routes/chat/dataRoutes.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');

const app = express();
registerDataRoutes(app);
app.use(errorHandler);

const expectProblem500 = res => {
  expect(res.status).toBe(500);
  expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
  expect(res.body.code).toBe('INTERNAL_ERROR');
};

beforeEach(() => {
  state.styles = { data: [{ id: 'default' }] };
  state.ui = { data: { title: 'x' }, etag: 'ui-etag' };
  state.mimetypes = { data: { supportedTextFormats: [] }, etag: 'mt-etag' };
  state.platform = { defaultLanguage: 'en' };
  state.loadError = null;
  state.loadable = null;
  for (const k of Object.keys(locales)) delete locales[k];
  loadAttempts.length = 0;
});

describe('chat data routes: configuration errors', () => {
  it('answers null styles with INTERNAL_ERROR', async () => {
    state.styles = { data: null };
    expectProblem500(await request(app).get('/api/styles'));
  });

  it('answers the styles when they are loaded', async () => {
    const res = await request(app).get('/api/styles').expect(200);
    expect(res.body).toEqual([{ id: 'default' }]);
  });

  it('answers a null UI configuration with INTERNAL_ERROR', async () => {
    state.ui = { data: null, etag: 'e' };
    expectProblem500(await request(app).get('/api/configs/ui'));
  });

  it('answers a null mimetypes configuration with INTERNAL_ERROR', async () => {
    state.mimetypes = { data: null, etag: 'e' };
    expectProblem500(await request(app).get('/api/configs/mimetypes'));
  });

  it('answers a missing platform configuration with INTERNAL_ERROR', async () => {
    state.platform = null;
    expectProblem500(await request(app).get('/api/configs/platform'));
  });

  it('does not leak the failure of an unreadable configuration', async () => {
    state.ui = { data: null, etag: 'e' };
    const res = await request(app).get('/api/configs/ui');
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/stack|node_modules/);
  });
});

describe('chat data routes: translations errors', () => {
  it('answers 500 when no locale can be loaded', async () => {
    expectProblem500(await request(app).get('/api/translations/en'));
    expect(loadAttempts).toContain('en');
  });

  it('answers 500 when loading throws and there is no default to fall back to', async () => {
    state.loadError = new Error('locale file unreadable');
    const res = await request(app).get('/api/translations/de');
    expectProblem500(res);
    expect(JSON.stringify(res.body)).not.toContain('locale file unreadable');
    // requested, default fallback, then the emergency fallback of the catch block
    expect(loadAttempts).toEqual(['de', 'en', 'en']);
  });

  it('falls back to the default language when the requested one cannot be loaded', async () => {
    locales.en = { common: { save: 'Save' } };
    const res = await request(app).get('/api/translations/de').expect(200);
    expect(res.body).toEqual({ common: { save: 'Save' } });
  });

  it('loads and caches a locale that is not in the cache yet', async () => {
    state.loadable = { de: { common: { save: 'Speichern' } } };
    const res = await request(app).get('/api/translations/de').expect(200);
    expect(res.body).toEqual({ common: { save: 'Speichern' } });
  });

  it('loads the default language when it is the one missing from the cache', async () => {
    state.loadable = { en: { common: { save: 'Save' } } };
    const res = await request(app).get('/api/translations/fr').expect(200);
    expect(res.body).toEqual({ common: { save: 'Save' } });
    expect(loadAttempts).toEqual(['en']);
  });

  it('treats an invalid language code as the default language', async () => {
    locales.en = { common: { save: 'Save' } };
    locales.de = { common: { save: 'Speichern' } };
    const res = await request(app).get('/api/translations/bad%20lang!').expect(200);
    expect(res.body).toEqual({ common: { save: 'Save' } });
  });

  it('uses "en" as the default language when the platform names none', async () => {
    state.platform = null;
    locales.en = { common: { save: 'Save' } };
    const res = await request(app).get('/api/translations/fr').expect(200);
    expect(res.body).toEqual({ common: { save: 'Save' } });
  });
});
