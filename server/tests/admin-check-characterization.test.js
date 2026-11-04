// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Characterization tests for "is this user an admin?" (#3238).
 *
 * The admin check exists in about ten places that do NOT all agree. This file
 * pins what each one answers TODAY for the same set of principals, so the
 * consolidation onto `isAdmin(user)` / `isContentAdmin(user)` can be reviewed
 * against a fixed record: a difference between two columns below is a
 * behaviour the consolidation must either keep or change on purpose.
 *
 * Nothing here states what the rule SHOULD be. Where two call sites differ, the
 * test says so in a comment next to the expectation.
 *
 * Sites: adminAuth / isAdmin, contentAdminAuth /
 * isContentAdmin, GET /api/admin/auth/status, runIdentity.isAdminUser,
 * workflowAccess.isAdmin, the agent run + artifact routes, the short link routes,
 * projectAccess (isProjectAdmin / isProjectContentAdmin), userPromptAccess
 * (isPromptAdmin) and utils/adminRescue (first-user / last-admin rescue).
 * `routes/admin/projects.js` (3 sites) and `routes/admin/contentAccess.js` call
 * `isAdmin(req.user)` and are therefore pinned by that column.
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
const { isAdmin, isContentAdmin } = await import('../utils/authorization.js');
const { isAdminUser } = await import('../services/loop/runIdentity.js');
const { isAdmin: isWorkflowAdmin } = await import('../services/workflow/workflowAccess.js');
const { isProjectAdmin, isProjectContentAdmin } =
  await import('../services/projects/projectAccess.js');
const { isPromptAdmin } = await import('../services/prompts/userPromptAccess.js');
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

/**
 * The principals every site is asked about. `permissions` is what
 * `enhanceUserWithPermissions` would have attached to `req.user`.
 */
const PRINCIPALS = {
  anonymous: { id: 'anonymous', groups: ['anonymous'], permissions: {} },
  // CLAUDE.md: anonymous never passes adminAccess, even with admin default groups.
  anonymousWithAdminGroups: {
    id: 'anonymous',
    groups: ['admins'],
    permissions: { adminAccess: true }
  },
  admin: { id: 'admin', groups: ['admins'], permissions: { adminAccess: true } },
  // The group `admin` (singular) is not in groups.json: only the fallback lists know it.
  legacyAdminGroup: { id: 'legacy', groups: ['admin'], permissions: {} },
  // A user whose resolved permissions say adminAccess but whose groups do not.
  flagOnly: { id: 'flag', groups: ['users'], permissions: { adminAccess: true } },
  // `admins` group membership but no resolved permission flag on req.user.
  groupOnly: { id: 'grouponly', groups: ['admins'], permissions: {} },
  contentAdmin: { id: 'editor', groups: ['editors'], permissions: { contentAdmin: true } },
  user: { id: 'user', groups: ['users'], permissions: {} },
  // Delegated / machine principals never administer, whatever groups they carry.
  personalApiKeyOfAdmin: {
    id: 'key',
    groups: ['admins'],
    permissions: { adminAccess: true },
    authMode: 'oauth_personal_key'
  },
  agent: {
    id: 'agent:x',
    groups: ['admins'],
    permissions: { adminAccess: true },
    isAgent: true
  }
};
const NAMES = Object.keys(PRINCIPALS);

/** Expected answers, one row per principal. `true` = treated as admin. */
const EXPECTED = {
  //                          adminAuth  contentAdminAuth  isContentAdmin  runIdentity  workflow  project  projectContent  prompt
  anonymous: [false, false, false, false, false, false, false, false],
  anonymousWithAdminGroups: [false, false, false, false, false, false, false, false],
  admin: [true, true, true, true, true, true, true, true],
  legacyAdminGroup: [false, false, false, true, true, false, false, false],
  flagOnly: [false, false, false, true, true, true, true, true],
  groupOnly: [true, true, true, true, false, true, true, true],
  contentAdmin: [false, true, true, false, false, false, true, true],
  user: [false, false, false, false, false, false, false, false],
  personalApiKeyOfAdmin: [false, false, false, true, true, false, false, false],
  agent: [false, false, false, true, true, false, false, false]
};
const COLS = [
  'adminAuth',
  'contentAdminAuth',
  'isContentAdmin',
  'runIdentity',
  'workflowAccess',
  'projectAdmin',
  'projectContentAdmin',
  'promptAdmin'
];

function runMiddleware(mw, user) {
  const res = {
    statusCode: 200,
    status: jest.fn(c => ((res.statusCode = c), res)),
    json: jest.fn()
  };
  const next = jest.fn();
  mw({ user }, res, next);
  return { next: next.mock.calls.length > 0, status: res.statusCode };
}

const answers = name => {
  const user = PRINCIPALS[name];
  return [
    isAdmin(user),
    runMiddleware(contentAdminAuth, user).next,
    isContentAdmin(user),
    isAdminUser(user),
    Boolean(isWorkflowAdmin(user)),
    isProjectAdmin(user, GROUPS),
    isProjectContentAdmin(user, GROUPS),
    isPromptAdmin(user, GROUPS)
  ];
};

const saved = new Map();
const savedContentsDir = process.env.CONTENTS_DIR;
beforeAll(() => {
  for (const key of ['config/platform.json', 'config/groups.json']) {
    saved.set(key, configCache.cache.get(key));
  }
  configCache.cache.set('config/platform.json', {
    data: {
      anonymousAuth: { enabled: true, defaultGroups: ['anonymous'] },
      localAuth: { enabled: true },
      shortLinks: { allowedHosts: [] }
    }
  });
  configCache.cache.set('config/groups.json', { data: GROUPS });
});
afterAll(() => {
  for (const [key, value] of saved) {
    if (value === undefined) configCache.cache.delete(key);
    else configCache.cache.set(key, value);
  }
  if (savedContentsDir === undefined) delete process.env.CONTENTS_DIR;
  else process.env.CONTENTS_DIR = savedContentsDir;
});

describe('admin predicates, groups.json available', () => {
  test.each(NAMES)('%s', name => {
    const got = Object.fromEntries(COLS.map((c, i) => [c, answers(name)[i]]));
    const want = Object.fromEntries(COLS.map((c, i) => [c, EXPECTED[name][i]]));
    expect(got).toEqual(want);
  });

  test('adminAuth answers 403 (never 401) to everyone who is not an admin', () => {
    for (const name of NAMES) {
      const out = runMiddleware(adminAuth, PRINCIPALS[name]);
      expect(out.next).toBe(EXPECTED[name][0]);
      if (!out.next) expect(out.status).toBe(403);
    }
    expect(runMiddleware(adminAuth, undefined)).toEqual({ next: false, status: 403 });
  });

  test('contentAdminAuth answers 401 to anonymous and a missing user, 403 to the rest', () => {
    expect(runMiddleware(contentAdminAuth, undefined).status).toBe(401);
    expect(runMiddleware(contentAdminAuth, PRINCIPALS.anonymous).status).toBe(401);
    expect(runMiddleware(contentAdminAuth, PRINCIPALS.anonymousWithAdminGroups).status).toBe(401);
    expect(runMiddleware(contentAdminAuth, PRINCIPALS.user).status).toBe(403);
    expect(runMiddleware(contentAdminAuth, PRINCIPALS.agent).status).toBe(403);
  });

  test('anonymous never passes adminAuth, even with admin default groups', () => {
    expect(isAdmin(PRINCIPALS.anonymousWithAdminGroups)).toBe(false);
    expect(isAdmin(null)).toBe(false);
    expect(isAdmin()).toBe(false);
    expect(runMiddleware(adminAuth, PRINCIPALS.anonymousWithAdminGroups).next).toBe(false);
  });

  // `isContentAdmin` replaces `isContentAdminAuthRequired`, which checked `contentAdmin` only
  // (ignoring adminAccess, contrary to its doc) and whose only caller combined it with
  // `isAdminAuthRequired`. The combined answer (the status route below) is unchanged.
  test('isContentAdmin counts adminAccess as well as contentAdmin', () => {
    expect(isContentAdmin(PRINCIPALS.admin)).toBe(true);
    expect(isContentAdmin(PRINCIPALS.contentAdmin)).toBe(true);
    expect(isContentAdmin(PRINCIPALS.anonymousWithAdminGroups)).toBe(false);
    expect(isContentAdmin(null)).toBe(false);
  });

  // Where the sites disagree today (recorded, not endorsed):
  test('sites disagree about group-only vs flag-only vs the legacy `admin` group', () => {
    // groups only (permissions flag missing): adminAuth + runIdentity + project/prompt say admin, workflowAccess does not
    expect(answers('groupOnly')).toEqual([true, true, true, true, false, true, true, true]);
    // flag only: adminAuth and contentAdminAuth ignore it, every other site honours it
    expect(answers('flagOnly')).toEqual([false, false, false, true, true, true, true, true]);
    // `admin` (singular) group absent from groups.json: only runIdentity and workflowAccess honour the name
    expect(answers('legacyAdminGroup')).toEqual([
      false,
      false,
      false,
      true,
      true,
      false,
      false,
      false
    ]);
    // delegated / machine principals: only runIdentity and workflowAccess skip the eligibility rule
    expect(answers('personalApiKeyOfAdmin')).toEqual([
      false,
      false,
      false,
      true,
      true,
      false,
      false,
      false
    ]);
    expect(answers('agent')).toEqual([false, false, false, true, true, false, false, false]);
  });
});

describe('admin predicates when groups.json cannot be loaded', () => {
  let cached;
  beforeAll(() => {
    cached = configCache.cache.get('config/groups.json');
    configCache.cache.delete('config/groups.json');
    process.env.CONTENTS_DIR = path.join(os.tmpdir(), 'no-such-contents-dir-3238');
  });
  afterAll(() => {
    configCache.cache.set('config/groups.json', cached);
    if (savedContentsDir === undefined) delete process.env.CONTENTS_DIR;
    else process.env.CONTENTS_DIR = savedContentsDir;
  });

  // adminAuth and contentAdminAuth fall back to the names `admin` / `admins`.
  const fallback = {
    anonymous: false,
    anonymousWithAdminGroups: false, // hard anonymous veto
    admin: true,
    legacyAdminGroup: true,
    flagOnly: false,
    groupOnly: true,
    contentAdmin: false,
    user: false,
    personalApiKeyOfAdmin: false, // eligibility veto
    agent: false
  };
  test.each(NAMES)('adminAuth and contentAdminAuth fall back to admin/admins: %s', name => {
    expect(isAdmin(PRINCIPALS[name])).toBe(fallback[name]);
    expect(runMiddleware(contentAdminAuth, PRINCIPALS[name]).next).toBe(fallback[name]);
  });

  test.each(NAMES)('isContentAdmin falls back to admin/admins like contentAdminAuth: %s', name => {
    expect(isContentAdmin(PRINCIPALS[name])).toBe(fallback[name]);
  });

  test('hasAdminAccess-based sites: projectAdmin/promptAdmin fall back to runIdentity.isAdminUser', () => {
    expect(isProjectAdmin(PRINCIPALS.groupOnly)).toBe(true);
    expect(isProjectAdmin(PRINCIPALS.legacyAdminGroup)).toBe(true);
    expect(isProjectAdmin(PRINCIPALS.personalApiKeyOfAdmin)).toBe(false);
    expect(isProjectAdmin(PRINCIPALS.anonymousWithAdminGroups)).toBe(false);
    expect(isPromptAdmin(PRINCIPALS.groupOnly)).toBe(true);
    expect(isPromptAdmin(PRINCIPALS.legacyAdminGroup)).toBe(true);
    expect(isPromptAdmin(PRINCIPALS.personalApiKeyOfAdmin)).toBe(false);
    // ...but a resolved `permissions.contentAdmin` / `adminAccess` flag is honoured before
    // groups.json is consulted, so these keep answering without it.
    expect(isPromptAdmin(PRINCIPALS.contentAdmin)).toBe(true);
    expect(isProjectContentAdmin(PRINCIPALS.contentAdmin)).toBe(true);
    expect(isProjectAdmin(PRINCIPALS.flagOnly)).toBe(true);
  });
});

/** An express app whose caller is chosen by the `x-principal` header (none: anonymous). */
function buildApp(register) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const name = req.headers['x-principal'];
    req.user = PRINCIPALS[name] ? { ...PRINCIPALS[name] } : { ...PRINCIPALS.anonymous };
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

describe('GET /api/admin/auth/status (admin OR content admin enters the admin panel)', () => {
  const app = buildApp(registerAdminAuthRoutes);
  const ENTERS = {
    anonymous: false,
    anonymousWithAdminGroups: false,
    admin: true,
    legacyAdminGroup: false,
    flagOnly: false,
    groupOnly: true,
    contentAdmin: true,
    user: false,
    personalApiKeyOfAdmin: false,
    agent: false
  };
  test.each(NAMES)('%s', async name => {
    const res = await as(request(app).get('/api/admin/auth/status'), name);
    expect(res.status).toBe(200);
    expect(res.body.authRequired).toBe(!ENTERS[name]);
    // `authenticated` is true for an admin; otherwise the key is omitted from the JSON
    // (it is `undefined`, not `false`, unless the request carries a Bearer header).
    expect(res.body.authenticated).toBe(ENTERS[name] ? true : undefined);
  });
  test('a Bearer header alone makes `authenticated` true, `authRequired` is unchanged', async () => {
    const res = await request(app).get('/api/admin/auth/status').set('Authorization', 'Bearer x');
    expect(res.body).toEqual({ authRequired: true, authenticated: true });
  });
});

describe('short links: admin = `isAdmin(req.user)`', () => {
  const app = buildApp(registerShortLinkRoutes);
  const MAY_MANAGE_FOREIGN = {
    admin: true,
    groupOnly: true,
    legacyAdminGroup: false,
    flagOnly: false,
    contentAdmin: false,
    user: false,
    personalApiKeyOfAdmin: false,
    agent: false
  };
  test.each(Object.keys(MAY_MANAGE_FOREIGN))(
    '%s may delete another user’s link: %s',
    async name => {
      const created = await as(request(app).post('/api/shortlinks'), 'user').send({
        appId: 'chat'
      });
      expect(created.status).toBe(200);
      const link = created.body;
      // Another principal (never the owner `user`), except `user` itself, who is the owner.
      const res = await as(request(app).delete(`/api/shortlinks/${link.code}`), name);
      if (name === 'user') {
        expect(res.status).toBe(200);
      } else {
        expect(res.status === 200).toBe(MAY_MANAGE_FOREIGN[name]);
      }
    }
  );
  test('anonymous cannot use short links at all (401), whatever its groups', async () => {
    expect((await request(app).get('/api/shortlinks')).status).toBe(401);
    expect((await as(request(app).get('/api/shortlinks'), 'anonymousWithAdminGroups')).status).toBe(
      401
    );
  });
});

describe('agent run + artifact routes: admin = permissions.adminAccess OR group admin/admins', () => {
  const app = buildApp([registerAgentRunRoutes, registerAgentArtifactRoutes]);
  // The run belongs to `owner`; nobody in PRINCIPALS is `owner`, so only the admin rule can pass.
  const ALLOWED = {
    admin: true,
    legacyAdminGroup: true, // group `admin` counts here, but not in adminAuth
    flagOnly: true,
    groupOnly: true,
    contentAdmin: false,
    user: false,
    personalApiKeyOfAdmin: true, // eligibility is not applied here (adminAuth would refuse it)
    agent: true
  };
  for (const url of ['/api/agents/runs/run-1/artifacts']) {
    test.each(Object.keys(ALLOWED))(`${url}: %s`, async name => {
      const res = await as(request(app).get(url), name);
      expect(res.status === 403).toBe(!ALLOWED[name]);
    });
  }
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
