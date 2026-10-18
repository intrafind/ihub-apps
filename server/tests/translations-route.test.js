/**
 * GET /api/translations/:lang is the client's only source of UI strings (they
 * are no longer bundled into the startup JavaScript), so it has to answer with
 * the translations themselves. The config cache stores `{ data, etag }`
 * entries; returning such an entry put every string under a `data.` prefix
 * where i18next never found it.
 *
 * Note: The repo's source is native ESM, so this file uses
 * `jest.unstable_mockModule` + dynamic imports. Run with
 * `NODE_OPTIONS=--experimental-vm-modules`.
 */

import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const mockLocales = {
  en: { common: { save: 'Save' } },
  de: { common: { save: 'Speichern' } }
};

jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    getPlatform: () => ({ defaultLanguage: 'en' }),
    getSupportedLanguages: () => ['en', 'de'],
    getLocalizations: lang =>
      mockLocales[lang] ? { data: mockLocales[lang], etag: `etag-${lang}` } : { data: null },
    loadAndCacheLocale: async () => null
  }
}));

jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}));

const { default: registerDataRoutes } = await import('../routes/chat/dataRoutes.js');

const app = express();
registerDataRoutes(app);

describe('GET /api/translations/:lang', () => {
  test('answers with the translations, not the cache entry', async () => {
    const res = await request(app).get('/api/translations/de');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ common: { save: 'Speichern' } });
  });

  test('falls back to the base language for a regional code', async () => {
    const res = await request(app).get('/api/translations/de-AT');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ common: { save: 'Speichern' } });
  });

  test('falls back to the default language for an unsupported one', async () => {
    const res = await request(app).get('/api/translations/fr');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ common: { save: 'Save' } });
  });
});
