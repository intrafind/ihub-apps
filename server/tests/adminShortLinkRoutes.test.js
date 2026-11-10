// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Admin → Short Links → Allowed external hosts (`/api/admin/shortlinks/config`):
 * an administrator reads and replaces `platform.shortLinks.allowedHosts`, sees
 * which hosts stored links lead to that the list refuses, and a saved host
 * lets those links redirect at once.
 *
 * The link store and the platform file are kept in memory.
 */
import { jest } from '@jest/globals';

jest.unstable_mockModule('../utils/sharedJsonFile.js', () => ({
  createSharedJsonFile: ({ createDefault }) => {
    let data = createDefault();
    return {
      read: async () => data,
      update: async mutate => {
        const draft = structuredClone(data);
        const result = await mutate(draft);
        data = draft;
        return result;
      }
    };
  }
}));

const stored = { platform: null, writes: 0 };
jest.unstable_mockModule('../services/config/ConfigStore.js', () => ({
  default: {
    readJsonStrict: async () => structuredClone(stored.platform),
    writeJson: async (_path, data) => {
      stored.platform = structuredClone(data);
      stored.writes += 1;
    }
  }
}));

const { default: express } = await import('express');
const { default: request } = await import('supertest');
const { default: configCache } = await import('../configCache.js');
const { default: registerAdminShortLinkRoutes } = await import('../routes/admin/shortLinks.js');
const { default: registerShortLinkRoutes } = await import('../routes/shortLinkRoutes.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');
const { createLink } = await import('../shortLinkManager.js');

const PLATFORM = 'config/platform.json';
const saved = configCache.cache.get(PLATFORM);
const savedRefresh = configCache.refreshCacheEntry;

/** Puts `platform` in the cache, as a server restart or a refresh would. */
function usePlatform(platform) {
  stored.platform = structuredClone(platform);
  configCache.cache.set(PLATFORM, { data: structuredClone(platform) });
}

beforeAll(() => {
  // Saving refreshes the cache from the (in-memory) platform file.
  configCache.refreshCacheEntry = async key => {
    if (key === PLATFORM)
      configCache.cache.set(PLATFORM, { data: structuredClone(stored.platform) });
  };
});

afterAll(() => {
  configCache.refreshCacheEntry = savedRefresh;
  if (saved === undefined) configCache.cache.delete(PLATFORM);
  else configCache.cache.set(PLATFORM, saved);
});

beforeEach(() => {
  stored.writes = 0;
  usePlatform({
    features: { shortLinks: true },
    ssrf: { allowedHosts: ['www.qwant.com'] },
    shortLinks: { allowedHosts: [] }
  });
});

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const admin = req.headers['x-test-user'] === 'admin';
    req.user = { id: admin ? 'admin' : 'alice', groups: [], isAdmin: admin, authMode: 'local' };
    next();
  });
  registerAdminShortLinkRoutes(app);
  registerShortLinkRoutes(app);
  app.use(errorHandler);
  return app;
}

const asAdmin = req => req.set('x-test-user', 'admin');

describe('GET /api/admin/shortlinks/config', () => {
  test('answers the allowlist and the hosts of stored links it refuses', async () => {
    // Links stored before the allowlist existed (or before a host was removed).
    usePlatform({
      ...stored.platform,
      shortLinks: { allowedHosts: ['www.qwant.com', 'x.example'] }
    });
    const allowed = { allowedHosts: ['www.qwant.com', 'x.example'] };
    await createLink({ url: 'https://www.qwant.com/', ownerId: 'admin' }, allowed);
    await createLink({ url: 'https://www.qwant.com/?q=1', ownerId: 'admin' }, allowed);
    await createLink({ url: 'https://x.example/', ownerId: 'admin' }, allowed);
    await createLink({ url: '/apps/chat', ownerId: 'admin' });
    usePlatform({ ...stored.platform, shortLinks: { allowedHosts: ['x.example'] } });

    const res = await asAdmin(request(buildApp()).get('/api/admin/shortlinks/config')).expect(200);
    expect(res.body.allowedHosts).toEqual(['x.example']);
    expect(res.body.blockedHosts).toContainEqual({ host: 'www.qwant.com', links: 2 });
    expect(res.body.blockedHosts.map(b => b.host)).not.toContain('x.example');
  });

  test('is for administrators only', async () => {
    const res = await request(buildApp()).get('/api/admin/shortlinks/config').expect(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });
});

describe('PUT /api/admin/shortlinks/config', () => {
  test('saves the normalized list, keeps the rest of platform.json and answers like GET', async () => {
    const res = await asAdmin(request(buildApp()).put('/api/admin/shortlinks/config'))
      .send({ allowedHosts: [' WWW.Qwant.com ', '*.Example.org', 'bücher.de', 'www.qwant.com'] })
      .expect(200);
    const expected = ['www.qwant.com', '*.example.org', 'xn--bcher-kva.de'];
    expect(res.body.allowedHosts).toEqual(expected);
    expect(Array.isArray(res.body.blockedHosts)).toBe(true);
    expect(stored.platform.shortLinks.allowedHosts).toEqual(expected);
    expect(stored.platform.ssrf).toEqual({ allowedHosts: ['www.qwant.com'] });
    expect(stored.platform.features).toEqual({ shortLinks: true });
  });

  test('a saved host lets a stored link redirect at once, and new links to it be created', async () => {
    const app = buildApp();
    const { body: link } = await asAdmin(request(app).post('/api/shortlinks'))
      .send({ url: '/apps/chat' })
      .expect(200);
    // The link as it was stored before the allowlist existed.
    const { getLink } = await import('../shortLinkManager.js');
    (await getLink(link.code)).url = 'https://www.qwant.com/';

    expect((await request(app).get(`/s/${link.code}`)).status).toBe(404);
    const refused = await asAdmin(request(app).post('/api/shortlinks')).send({
      url: 'https://www.qwant.com/'
    });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('SHORT_LINK_HOST_NOT_ALLOWED');

    await asAdmin(request(app).put('/api/admin/shortlinks/config'))
      .send({ allowedHosts: ['www.qwant.com'] })
      .expect(200);

    const redirect = await request(app).get(`/s/${link.code}`);
    expect(redirect.status).toBe(302);
    expect(redirect.headers.location).toBe('https://www.qwant.com/');
    await asAdmin(request(app).post('/api/shortlinks'))
      .send({ url: 'https://www.qwant.com/' })
      .expect(200);
  });

  test('refuses unusable entries all at once and saves nothing', async () => {
    const res = await asAdmin(request(buildApp()).put('/api/admin/shortlinks/config'))
      .send({ allowedHosts: ['ok.example', 'https://www.qwant.com/', '', '/(.*)+/', 7] })
      .expect(400);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(res.body.errors.map(e => e.pointer)).toEqual([
      '/allowedHosts/1',
      '/allowedHosts/2',
      '/allowedHosts/3',
      '/allowedHosts/4'
    ]);
    expect(res.body.detail).toContain('enter its host www.qwant.com instead');
    expect(stored.writes).toBe(0);
  });

  test('refuses a body without a list', async () => {
    const res = await asAdmin(request(buildApp()).put('/api/admin/shortlinks/config'))
      .send({ allowedHosts: 'www.qwant.com' })
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(stored.writes).toBe(0);
  });

  test('is for administrators only', async () => {
    const res = await request(buildApp())
      .put('/api/admin/shortlinks/config')
      .send({ allowedHosts: ['www.qwant.com'] })
      .expect(403);
    expect(res.body.code).toBe('FORBIDDEN');
    expect(stored.writes).toBe(0);
  });
});
