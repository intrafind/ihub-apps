// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * "Is this user an admin?" (#3238).
 *
 * One rule, decided once per request in `enhanceUserWithPermissions` and read
 * through `isAdmin(user)` / `isContentAdmin(user)` everywhere (`adminAuth`,
 * `contentAdminAuth`, `/api/admin/auth/status`, short links, the agent run and
 * artifact routes, ...). The principals below are built the way a request builds
 * them, and every site must agree about each of them. The rule: a signed-in,
 * interactive principal in a group with `adminAccess` (content admin: or
 * `contentAdmin`). The anonymous principal, OAuth clients, delegated tokens
 * (including personal API keys) and agents never administer, whatever groups
 * they carry. The only admin group is `admins`.
 */

import { jest } from '@jest/globals';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Agent run routes talk to the workflow engine; one scripted run is enough.
const getState = jest.fn(async () => ({
  status: 'completed',
  data: { _agent: { triggeredBy: { userId: 'owner' } } }
}));
jest.unstable_mockModule('../services/workflow/index.js', () => ({
  getWorkflowEngine: () => ({ getState }),
  getExecutionRegistry: () => ({ getByUser: async () => [] })
}));

// The short link store lives in memory.
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

const { default: express } = await import('express');
const { default: request } = await import('supertest');
const { default: configCache } = await import('../configCache.js');
const { adminAuth } = await import('../middleware/adminAuth.js');
const { contentAdminAuth } = await import('../middleware/contentAdminAuth.js');
const { isAdmin, isContentAdmin, enhanceUserWithPermissions } =
  await import('../utils/authorization.js');
const { hasAnyAdmin, isLastAdmin, assignAdminGroup, ensureFirstUserIsAdmin } =
  await import('../utils/adminRescue.js');
const { default: registerShortLinkRoutes } = await import('../routes/shortLinkRoutes.js');
const { default: registerAdminAuthRoutes } = await import('../routes/admin/auth.js');
const { default: registerAgentRunRoutes } = await import('../routes/agents/runs.js');
const { default: registerAgentArtifactRoutes } = await import('../routes/agents/artifacts.js');

const GROUPS = {
  groups: {
    admins: { id: 'admins', permissions: { adminAccess: true, apps: ['*'], models: ['*'] } },
    editors: { id: 'editors', permissions: { contentAdmin: true, apps: ['*'], models: ['*'] } },
    users: { id: 'users', permissions: { apps: ['*'], models: ['*'] } },
    anonymous: { id: 'anonymous', permissions: { apps: [], models: [] } }
  }
};

/** Raw principals; `buildPrincipals` runs them through the request pipeline. */
const RAW = {
  anonymous: null,
  // Anonymous access with admin default groups: still never an admin.
  anonymousWithAdminGroups: null,
  admin: { id: 'admin', groups: ['admins'] },
  // There is no group `admin` (singular): it grants nothing.
  singularAdminGroup: { id: 'legacy', groups: ['admin'] },
  contentAdmin: { id: 'editor', groups: ['editors'] },
  user: { id: 'user', groups: ['users'] },
  // Delegated and machine principals carry their owner's / their own groups but never administer.
  personalApiKeyOfAdmin: { id: 'key', groups: ['admins'], authMode: 'oauth_personal_key' },
  authCodeTokenOfAdmin: { id: 'code', groups: ['admins'], authMode: 'oauth_authorization_code' },
  oauthClientCredentials: {
    id: 'client',
    groups: ['admins'],
    isOAuthClient: true,
    authMode: 'oauth_client_credentials'
  },
  agent: { id: 'agent:x', groups: ['admins'], isAgent: true }
};
const NAMES = Object.keys(RAW);
const PRINCIPALS = {};

/** [admin, contentAdmin] every site must agree on. */
const EXPECTED = {
  anonymous: [false, false],
  anonymousWithAdminGroups: [false, false],
  admin: [true, true],
  singularAdminGroup: [false, false],
  contentAdmin: [false, true],
  user: [false, false],
  personalApiKeyOfAdmin: [false, false],
  authCodeTokenOfAdmin: [false, false],
  oauthClientCredentials: [false, false],
  agent: [false, false]
};

function runMiddleware(mw, user) {
  const res = {
    statusCode: 200,
    setHeader: jest.fn(),
    status: jest.fn(c => ((res.statusCode = c), res)),
    json: jest.fn()
  };
  const next = jest.fn();
  mw({ user }, res, next);
  return { next: next.mock.calls.length > 0, status: res.statusCode };
}

const saved = new Map();
beforeAll(() => {
  for (const key of ['config/platform.json', 'config/groups.json']) {
    saved.set(key, configCache.cache.get(key));
  }
  const platform = {
    anonymousAuth: { enabled: true, defaultGroups: ['anonymous'] },
    localAuth: { enabled: true },
    shortLinks: { allowedHosts: [] }
  };
  configCache.cache.set('config/platform.json', { data: platform });
  configCache.cache.set('config/groups.json', { data: GROUPS });
  for (const name of NAMES) {
    PRINCIPALS[name] =
      name === 'anonymousWithAdminGroups'
        ? enhanceUserWithPermissions(
            null,
            {},
            {
              anonymousAuth: { enabled: true, defaultGroups: ['admins'] }
            }
          )
        : enhanceUserWithPermissions(RAW[name] ? { ...RAW[name] } : null, {}, platform);
  }
});
afterAll(() => {
  for (const [key, value] of saved) {
    if (value === undefined) configCache.cache.delete(key);
    else configCache.cache.set(key, value);
  }
});

describe('the admin rule, for every kind of principal', () => {
  test.each(NAMES)('%s', name => {
    const [admin, contentAdmin] = EXPECTED[name];
    expect([isAdmin(PRINCIPALS[name]), isContentAdmin(PRINCIPALS[name])]).toEqual([
      admin,
      contentAdmin
    ]);
  });

  test('adminAuth lets exactly the admins through and answers 403 to everyone else', () => {
    for (const name of NAMES) {
      const out = runMiddleware(adminAuth, PRINCIPALS[name]);
      expect(out.next).toBe(EXPECTED[name][0]);
      if (!out.next) expect(out.status).toBe(403);
    }
    expect(runMiddleware(adminAuth, undefined)).toEqual({ next: false, status: 403 });
  });

  test('contentAdminAuth lets admins and content admins through; anonymous gets 401, others 403', () => {
    for (const name of NAMES) {
      const out = runMiddleware(contentAdminAuth, PRINCIPALS[name]);
      expect(out.next).toBe(EXPECTED[name][1]);
    }
    expect(runMiddleware(contentAdminAuth, undefined).status).toBe(401);
    expect(runMiddleware(contentAdminAuth, PRINCIPALS.anonymous).status).toBe(401);
    expect(runMiddleware(contentAdminAuth, PRINCIPALS.anonymousWithAdminGroups).status).toBe(401);
    expect(runMiddleware(contentAdminAuth, PRINCIPALS.user).status).toBe(403);
    expect(runMiddleware(contentAdminAuth, PRINCIPALS.personalApiKeyOfAdmin).status).toBe(403);
  });

  test('anonymous never passes, even with admin default groups; a user without the flag is no admin', () => {
    expect(PRINCIPALS.anonymousWithAdminGroups.groups).toContain('admins');
    expect(isAdmin(PRINCIPALS.anonymousWithAdminGroups)).toBe(false);
    expect(isAdmin(null)).toBe(false);
    expect(isAdmin()).toBe(false);
    expect(isAdmin({ id: 'u', groups: ['admins'] })).toBe(false);
    expect(isContentAdmin({ id: 'u', groups: ['editors'] })).toBe(false);
  });

  test('without groups.json the request fails closed instead of guessing from group names', () => {
    const cached = configCache.cache.get('config/groups.json');
    const contents = process.env.CONTENTS_DIR;
    configCache.cache.delete('config/groups.json');
    process.env.CONTENTS_DIR = path.join(os.tmpdir(), 'no-such-contents-dir-3238');
    try {
      expect(() => enhanceUserWithPermissions({ id: 'u', groups: ['admins'] }, {}, {})).toThrow();
    } finally {
      configCache.cache.set('config/groups.json', cached);
      if (contents === undefined) delete process.env.CONTENTS_DIR;
      else process.env.CONTENTS_DIR = contents;
    }
  });
});

/** An express app whose caller is chosen by the `x-principal` header (none: anonymous). */
function buildApp(register) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const name = req.headers['x-principal'];
    req.user = { ...(PRINCIPALS[name] || PRINCIPALS.anonymous) };
    next();
  });
  // registerAgentRunRoutes starts a sweep interval that is meant to live as long as the
  // server; unref it here so the test process can exit.
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = (...args) => realSetInterval(...args).unref();
  try {
    for (const r of [].concat(register)) r(app);
  } finally {
    globalThis.setInterval = realSetInterval;
  }
  return app;
}
const as = (req, name) => (name ? req.set('x-principal', name) : req);

describe('GET /api/admin/auth/status (admin or content admin enters the admin panel)', () => {
  const app = buildApp(registerAdminAuthRoutes);
  test.each(NAMES)('%s', async name => {
    const res = await as(request(app).get('/api/admin/auth/status'), name);
    expect(res.status).toBe(200);
    const enters = EXPECTED[name][1];
    expect(res.body.authRequired).toBe(!enters);
    // `authenticated` is true for those who enter; otherwise the key is omitted from the JSON.
    expect(res.body.authenticated).toBe(enters ? true : undefined);
  });
  test('a Bearer header alone makes `authenticated` true, `authRequired` is unchanged', async () => {
    const res = await request(app).get('/api/admin/auth/status').set('Authorization', 'Bearer x');
    expect(res.body).toEqual({ authRequired: true, authenticated: true });
  });
});

describe('short links: an admin may manage another user’s link', () => {
  const app = buildApp(registerShortLinkRoutes);
  const others = NAMES.filter(n => !n.startsWith('anonymous') && n !== 'user');
  test.each(others)('%s', async name => {
    const created = await as(request(app).post('/api/shortlinks'), 'user').send({ appId: 'chat' });
    expect(created.status).toBe(200);
    const res = await as(request(app).delete(`/api/shortlinks/${created.body.code}`), name);
    expect(res.status === 200).toBe(EXPECTED[name][0]);
  });
  test('anonymous cannot use short links at all (401), whatever its groups', async () => {
    expect((await request(app).get('/api/shortlinks')).status).toBe(401);
    expect((await as(request(app).get('/api/shortlinks'), 'anonymousWithAdminGroups')).status).toBe(
      401
    );
  });
});

describe('agent run and artifact routes: only an admin reads a run that is not theirs', () => {
  const app = buildApp([registerAgentRunRoutes, registerAgentArtifactRoutes]);
  // The run belongs to `owner`; nobody in PRINCIPALS is `owner`, so only the admin rule can pass.
  const callers = NAMES.filter(n => !n.startsWith('anonymous'));
  test.each(callers)('%s', async name => {
    const res = await as(request(app).get('/api/agents/runs/run-1/artifacts'), name);
    expect(res.status === 403).toBe(!EXPECTED[name][0]);
  });
  test('an admin’s personal API key and an agent with admin groups are refused (403)', async () => {
    for (const name of ['personalApiKeyOfAdmin', 'authCodeTokenOfAdmin', 'agent']) {
      const res = await as(request(app).get('/api/agents/runs/run-1/artifacts'), name);
      expect(res.status).toBe(403);
    }
  });
  test('anonymous is stopped by authenticatedOnly before the admin rule is reached', async () => {
    expect((await request(app).get('/api/agents/runs/run-1/artifacts')).status).toBe(401);
    expect(
      (await as(request(app).get('/api/agents/runs/run-1/artifacts'), 'anonymousWithAdminGroups'))
        .status
    ).toBe(401);
  });
});

describe('admin rescue (first user becomes admin; last admin cannot be removed)', () => {
  let dir;
  let file;
  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rescue-3238-'));
    n = 0;
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });
  // `loadUsers` caches by path, so every scenario writes a fresh file.
  let n = 0;
  const write = async users => {
    file = path.join(dir, `users-${n++}.json`);
    await fsp.writeFile(file, JSON.stringify({ users, metadata: { version: '2.0.0' } }));
  };
  const local = (id, internalGroups, extra = {}) => ({
    id,
    username: id,
    active: true,
    internalGroups,
    passwordHash: 'h',
    ...extra
  });

  test('hasAnyAdmin reads adminAccess from groups.json via internalGroups only', async () => {
    await write({ u1: local('u1', ['users']) });
    expect(hasAnyAdmin(file)).toBe(false);
    await write({ u1: local('u1', ['admins']) });
    expect(hasAnyAdmin(file)).toBe(true);
    // The singular `admin` name is NOT recognised here (not in groups.json).
    await write({ u1: local('u1', ['admin']) });
    expect(hasAnyAdmin(file)).toBe(false);
    // contentAdmin is not admin for rescue purposes.
    await write({ u1: local('u1', ['editors']) });
    expect(hasAnyAdmin(file)).toBe(false);
  });

  test('inactive admins and admins whose login method is disabled do not count', async () => {
    await write({ u1: local('u1', ['admins'], { active: false }) });
    expect(hasAnyAdmin(file)).toBe(false);
    await write({ u1: local('u1', ['admins'], { authMethods: ['oidc'] }) });
    expect(hasAnyAdmin(file)).toBe(false);
  });

  test('isLastAdmin: only the single remaining active admin', async () => {
    await write({ a: local('a', ['admins']), u: local('u', ['users']) });
    expect(isLastAdmin('a', file)).toBe(true);
    expect(isLastAdmin('u', file)).toBe(false);
    await write({ a: local('a', ['admins']), b: local('b', ['admins']) });
    expect(isLastAdmin('a', file)).toBe(false);
    // An inactive second admin does not save the first.
    await write({ a: local('a', ['admins']), b: local('b', ['admins'], { active: false }) });
    expect(isLastAdmin('a', file)).toBe(true);
  });

  test('assignAdminGroup prefers the `admins` group and is idempotent', async () => {
    await write({ u1: local('u1', ['users']) });
    expect(await assignAdminGroup('u1', file)).toBe(true);
    expect(hasAnyAdmin(file)).toBe(true);
    expect(await assignAdminGroup('missing', file)).toBe(false);
  });

  test('ensureFirstUserIsAdmin: promotes the first user only when no admin exists', async () => {
    await write({ u1: local('u1', ['users']) });
    const user = { id: 'u1', groups: ['users'] };
    const promoted = await ensureFirstUserIsAdmin(user, 'local', file);
    expect(promoted.groups).toContain('admins');

    await write({ a: local('a', ['admins']), u1: local('u1', ['users']) });
    const other = await ensureFirstUserIsAdmin({ id: 'u1', groups: ['users'] }, 'local', file);
    expect(other.groups).toEqual(['users']);
  });

  test('ensureFirstUserIsAdmin never promotes anonymous, anonymous mode or LDAP users', async () => {
    await write({ u1: local('u1', ['users']) });
    const anon = { id: 'anonymous', groups: ['anonymous'] };
    expect((await ensureFirstUserIsAdmin(anon, 'local', file)).groups).toEqual(['anonymous']);
    const u = { id: 'u1', groups: ['users'] };
    expect((await ensureFirstUserIsAdmin(u, 'anonymous', file)).groups).toEqual(['users']);
    expect((await ensureFirstUserIsAdmin(u, 'ldap', file)).groups).toEqual(['users']);
    expect(hasAnyAdmin(file)).toBe(false);
  });
});
