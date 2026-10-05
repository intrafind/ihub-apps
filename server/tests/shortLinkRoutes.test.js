import { jest } from '@jest/globals';

/**
 * Route tests for /api/shortlinks and /s/:code: links belong to the signed-in
 * user who creates them, only they and admins can see, change or delete them,
 * and a link only ever redirects to a path on this server or an allowed host.
 * The link store is replaced by an in-memory one.
 */

// The link store keeps its data in memory here; nothing touches the disk.
jest.unstable_mockModule('../utils/sharedJsonFile.js', () => ({
  createSharedJsonFile: ({ createDefault }) => {
    let data = createDefault();
    return {
      read: async () => data,
      update: async mutate => {
        // Like the file: a change that throws leaves the stored data as it was.
        const draft = structuredClone(data);
        const result = await mutate(draft);
        data = draft;
        return result;
      }
    };
  }
}));

const { default: express } = await import('express');
const { default: request } = await import('supertest');
const { default: configCache } = await import('../configCache.js');
const { default: registerShortLinkRoutes } = await import('../routes/shortLinkRoutes.js');
const { setupMiddleware } = await import('../middleware/setup.js');

const GROUPS = {
  groups: {
    admins: { id: 'admins', permissions: { adminAccess: true, apps: ['*'], models: ['*'] } },
    users: { id: 'users', permissions: { adminAccess: false, apps: ['*'], models: ['*'] } },
    anonymous: { id: 'anonymous', permissions: { adminAccess: false, apps: [], models: [] } }
  }
};

const USERS = {
  alice: { id: 'alice', groups: ['users'], authMode: 'local' },
  bob: { id: 'bob', groups: ['users'], authMode: 'local' },
  admin: { id: 'admin', groups: ['admins'], authMode: 'local' }
};

const saved = new Map();
beforeAll(() => {
  for (const key of ['config/platform.json', 'config/groups.json']) {
    saved.set(key, configCache.cache.get(key));
  }
  configCache.cache.set('config/platform.json', {
    data: {
      anonymousAuth: { enabled: true, defaultGroups: ['anonymous'] },
      shortLinks: { allowedHosts: ['docs.example.com'] }
    }
  });
  configCache.cache.set('config/groups.json', { data: GROUPS });
});

afterAll(() => {
  for (const [key, value] of saved) {
    if (value === undefined) configCache.cache.delete(key);
    else configCache.cache.set(key, value);
  }
});

/** An app whose caller is chosen by the `x-test-user` header (none: anonymous). */
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const user = USERS[req.headers['x-test-user']];
    req.user = user
      ? { ...user, permissions: { adminAccess: user.groups.includes('admins') } }
      : { id: 'anonymous', groups: ['anonymous'], permissions: {} };
    next();
  });
  registerShortLinkRoutes(app);
  return app;
}

const as = (req, who) => (who ? req.set('x-test-user', who) : req);

async function create(app, who, body) {
  return as(request(app).post('/api/shortlinks'), who).send(body);
}

describe('short links without a signed-in user', () => {
  test('cannot be created, listed, changed or deleted', async () => {
    const app = buildApp();
    const { body: link } = await create(app, 'alice', { appId: 'chat' });

    expect((await create(app, null, { appId: 'chat' })).status).toBe(401);
    expect((await request(app).get('/api/shortlinks')).status).toBe(401);
    expect((await request(app).get(`/api/shortlinks/${link.code}`)).status).toBe(401);
    expect(
      (await request(app).put(`/api/shortlinks/${link.code}`).send({ appId: 'x' })).status
    ).toBe(401);
    expect((await request(app).delete(`/api/shortlinks/${link.code}`)).status).toBe(401);
  });
});

describe('short link ownership', () => {
  test('the creator is the owner, whatever the request body says', async () => {
    const app = buildApp();
    const res = await create(app, 'alice', { appId: 'chat', userId: 'bob', ownerId: 'bob' });
    expect(res.status).toBe(200);
    expect(res.body.ownerId).toBe('alice');
    expect(res.body).not.toHaveProperty('userId');
  });

  test('a user lists only their own links; an admin lists all of them', async () => {
    const app = buildApp();
    const { body: mine } = await create(app, 'alice', { appId: 'list-app' });
    const { body: theirs } = await create(app, 'bob', { appId: 'list-app' });

    const alice = await as(request(app).get('/api/shortlinks?appId=list-app'), 'alice');
    expect(alice.body.map(l => l.code)).toEqual([mine.code]);

    // A user cannot widen the list to someone else's links.
    const widened = await as(request(app).get('/api/shortlinks?ownerId=bob'), 'alice');
    expect(widened.body.every(l => l.ownerId === 'alice')).toBe(true);

    const admin = await as(request(app).get('/api/shortlinks?appId=list-app'), 'admin');
    expect(admin.body.map(l => l.code).sort()).toEqual([mine.code, theirs.code].sort());

    const byOwner = await as(
      request(app).get('/api/shortlinks?appId=list-app&ownerId=bob'),
      'admin'
    );
    expect(byOwner.body.map(l => l.code)).toEqual([theirs.code]);
  });

  test('another user sees only that a code is taken', async () => {
    const app = buildApp();
    const { body: link } = await create(app, 'alice', { appId: 'chat' });
    const res = await as(request(app).get(`/api/shortlinks/${link.code}`), 'bob');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ code: link.code });
  });

  test('only the owner or an admin can change or delete a link', async () => {
    const app = buildApp();
    const { body: link } = await create(app, 'alice', { appId: 'chat' });

    const put = await as(request(app).put(`/api/shortlinks/${link.code}`), 'bob').send({
      url: '/apps/other'
    });
    expect(put.status).toBe(403);
    expect((await as(request(app).delete(`/api/shortlinks/${link.code}`), 'bob')).status).toBe(403);

    const own = await as(request(app).put(`/api/shortlinks/${link.code}`), 'alice').send({
      url: '/apps/other',
      ownerId: 'bob',
      usage: 42
    });
    expect(own.status).toBe(200);
    expect(own.body).toMatchObject({ url: '/apps/other', ownerId: 'alice', usage: 0 });

    const adminPut = await as(request(app).put(`/api/shortlinks/${link.code}`), 'admin').send({
      expiresAt: null
    });
    expect(adminPut.status).toBe(200);
    expect(adminPut.body.ownerId).toBe('alice');

    expect((await as(request(app).delete(`/api/shortlinks/${link.code}`), 'admin')).status).toBe(
      200
    );
  });

  test('a link stored without an owner is managed by admins only', async () => {
    const app = buildApp();
    const { body: link } = await create(app, 'admin', { appId: 'chat' });
    // Simulate a link saved before links had owners.
    const { getLink } = await import('../shortLinkManager.js');
    const legacy = await getLink(link.code);
    delete legacy.ownerId;
    legacy.userId = 'alice';

    const res = await as(request(app).put(`/api/shortlinks/${link.code}`), 'alice').send({
      url: '/apps/x'
    });
    expect(res.status).toBe(403);
    const adminRes = await as(request(app).put(`/api/shortlinks/${link.code}`), 'admin').send({
      url: '/apps/x'
    });
    expect(adminRes.status).toBe(200);
  });
});

describe('short link targets', () => {
  test('a path on this server or a URL on an allowed host is accepted', async () => {
    const app = buildApp();
    expect((await create(app, 'alice', { url: '/apps/chat?model=a' })).status).toBe(200);
    expect((await create(app, 'alice', { url: 'https://docs.example.com/guide' })).status).toBe(
      200
    );
  });

  test('other targets are refused when a link is saved', async () => {
    const app = buildApp();
    for (const url of [
      'https://elsewhere.example/',
      '//elsewhere.example/',
      '/\\elsewhere.example/',
      'ftp://docs.example.com/',
      'data:text/plain,hello'
    ]) {
      const res = await create(app, 'alice', { url });
      expect([url, res.status]).toEqual([url, 400]);
    }
    expect((await create(app, 'alice', { path: '//elsewhere.example' })).status).toBe(400);

    const { body: link } = await create(app, 'alice', { appId: 'chat' });
    const put = await as(request(app).put(`/api/shortlinks/${link.code}`), 'alice').send({
      url: 'https://elsewhere.example/'
    });
    expect(put.status).toBe(400);
  });

  test('/s/:code redirects to an allowed target', async () => {
    const app = buildApp();
    const { body: link } = await create(app, 'alice', { url: '/apps/chat' });
    const res = await request(app).get(`/s/${link.code}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/apps/chat');
  });

  test('/s/:code does not redirect to a stored target that is not allowed', async () => {
    const app = buildApp();
    const { body: link } = await create(app, 'alice', { url: '/apps/chat' });
    // A link stored before targets were checked.
    const { getLink } = await import('../shortLinkManager.js');
    (await getLink(link.code)).url = 'https://elsewhere.example/';

    const res = await request(app).get(`/s/${link.code}`);
    expect(res.status).toBe(404);
    expect(res.headers.location).toBeUndefined();
  });

  test('wildcard and regex entries in the allowlist apply on save and on redirect', async () => {
    const app = buildApp();
    const platform = configCache.cache.get('config/platform.json');
    configCache.cache.set('config/platform.json', {
      data: {
        ...platform.data,
        shortLinks: { allowedHosts: ['*.intrafind.io', '/[a-z]+\\.example\\.org/'] }
      }
    });
    try {
      for (const url of ['https://docs.intrafind.io/x', 'https://wiki.example.org/']) {
        const { status, body: link } = await create(app, 'alice', { url });
        expect([url, status]).toEqual([url, 200]);
        const res = await request(app).get(`/s/${link.code}`);
        expect(res.status).toBe(302);
        expect(res.headers.location).toBe(url);
      }
      for (const url of ['https://intrafind.io/', 'https://wiki.example.org.example.net/']) {
        const res = await create(app, 'alice', { url });
        expect([url, res.status]).toEqual([url, 400]);
      }
    } finally {
      configCache.cache.set('config/platform.json', platform);
    }
  });

  test('/s/:code stops redirecting once a host leaves the allowlist', async () => {
    const app = buildApp();
    const { body: link } = await create(app, 'alice', { url: 'https://docs.example.com/x' });
    expect((await request(app).get(`/s/${link.code}`)).status).toBe(302);

    const platform = configCache.cache.get('config/platform.json');
    configCache.cache.set('config/platform.json', {
      data: { ...platform.data, shortLinks: { allowedHosts: [] } }
    });
    try {
      expect((await request(app).get(`/s/${link.code}`)).status).toBe(404);
    } finally {
      configCache.cache.set('config/platform.json', platform);
    }
  });
});

describe('rate limiting', () => {
  test('the general API limiter covers /api/shortlinks', async () => {
    const app = express();
    setupMiddleware(app, { rateLimit: { publicApi: { limit: 2, windowMs: 60_000 } } });
    app.get('/api/shortlinks', (_req, res) => res.json([]));
    expect((await request(app).get('/api/shortlinks')).status).toBe(200);
    expect((await request(app).get('/api/shortlinks')).status).toBe(200);
    expect((await request(app).get('/api/shortlinks')).status).toBe(429);
  });
});
