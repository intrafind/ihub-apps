// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Route tests for `/api/admin/access/:type/:id` and its verdict and restrict
 * actions: who can use an app or a model and why, the access check
 * ("why can't users see this?"), and replacing a wildcard with an explicit
 * list. Driven with supertest against an in-memory groups.json shaped like
 * the shipped one (admins → users → authenticated → anonymous, `*` in the
 * first three).
 *
 * Native ESM: `jest.unstable_mockModule` + dynamic imports, run with
 * `NODE_OPTIONS=--experimental-vm-modules` (scripts/run-server-tests.js does).
 */

import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const state = {
  groupsData: null,
  apps: [],
  models: [],
  features: {},
  platform: {},
  users: {},
  writes: [],
  refreshed: [],
  snapshots: [],
  audits: []
};

function freshGroups() {
  return {
    groups: {
      admins: {
        id: 'admins',
        name: 'Admins',
        inherits: ['users'],
        permissions: { apps: ['*'], models: ['*'], prompts: ['*'], adminAccess: true }
      },
      users: {
        id: 'users',
        name: 'Users',
        inherits: ['authenticated'],
        permissions: { apps: ['*'], models: ['*'], prompts: ['*'] }
      },
      authenticated: {
        id: 'authenticated',
        name: 'Authenticated',
        inherits: ['anonymous'],
        permissions: { apps: ['*'], models: ['*'], prompts: ['*'] }
      },
      anonymous: {
        id: 'anonymous',
        name: 'Anonymous',
        permissions: { apps: ['chat'], models: ['gpt'], prompts: [] }
      },
      hr: { id: 'hr', name: 'HR', inherits: ['users'], permissions: { apps: [], models: [] } },
      kiosk: { id: 'kiosk', name: 'Kiosk', permissions: { apps: [], models: [] } }
    },
    metadata: { lastModified: '2026-01-01T00:00:00.000Z' }
  };
}

const freshApps = () => [
  { id: 'chat', enabled: true, type: 'chat' },
  { id: 'hr-helper', enabled: true, type: 'chat', allowedModels: ['gpt'] },
  { id: 'old', enabled: false, type: 'chat' },
  { id: 'needs-flag', enabled: true, type: 'chat', requiredFeatures: ['experimentalX'] },
  {
    id: 'claude-only',
    enabled: true,
    type: 'chat',
    allowedModels: ['claude'],
    preferredModel: 'claude'
  },
  { id: 'portal', enabled: true, type: 'iframe' }
];

const freshModels = () => [
  { id: 'gpt', enabled: true },
  { id: 'claude', enabled: false },
  { id: 'mistral', enabled: true }
];

const ADMIN = { id: 'alice', username: 'alice', isAdmin: true, groups: ['admins'] };
const CONTENT_ADMIN = { id: 'carol', username: 'carol', isContentAdmin: true, groups: ['users'] };

jest.unstable_mockModule('../services/config/ConfigStore.js', () => ({
  default: {
    readJsonStrict: async () => structuredClone(state.groupsData),
    updateJson: async function (file, mutate) {
      const current = structuredClone(state.groupsData);
      const next = await mutate(current);
      if (next === undefined) return { data: current, written: false };
      state.writes.push({ file, data: structuredClone(next) });
      state.groupsData = structuredClone(next);
      return { data: next, written: true };
    }
  }
}));

jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    getApps: () => ({ data: state.apps }),
    getModels: () => ({ data: state.models }),
    getPrompts: () => ({ data: [{ id: 'summary' }] }),
    getWorkflows: () => ({ data: [] }),
    getSkills: () => ({ data: [] }),
    getFeatures: () => state.features,
    getIntegrationContext: () => ({ platform: {}, installedIntegrations: [] }),
    getPlatform: () => state.platform,
    refreshCacheEntry: async key => {
      state.refreshed.push(key);
    }
  }
}));

// The real filter pulls in the whole chat pipeline; the part the check
// depends on is "chat models the app allows".
jest.unstable_mockModule('../services/chat/RequestBuilder.js', () => ({
  filterModelsForApp: (models, app) =>
    models.filter(
      model =>
        !Array.isArray(app?.allowedModels) ||
        app.allowedModels.length === 0 ||
        app.allowedModels.includes(model.id)
    )
}));

jest.unstable_mockModule('../utils/userManager.js', () => ({
  loadUsers: () => ({ users: state.users }),
  findUserByIdentifier: (config, identifier) => {
    for (const [id, user] of Object.entries(config.users || {})) {
      if (user.username === identifier || user.email === identifier) return { ...user, id };
    }
    return null;
  }
}));

jest.unstable_mockModule('../services/ChangeHistoryService.js', () => ({
  saveSnapshot: async snapshot => {
    state.snapshots.push(snapshot);
  }
}));

jest.unstable_mockModule('../services/AuditLogService.js', () => ({
  logAudit: async entry => {
    state.audits.push(entry);
  }
}));

const { default: registerAdminItemAccessRoutes } = await import('../routes/admin/itemAccess.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');

function createTestApp(user) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = user;
    next();
  });
  registerAdminItemAccessRoutes(app);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  state.groupsData = freshGroups();
  state.apps = freshApps();
  state.models = freshModels();
  state.features = {};
  state.platform = { auth: {}, anonymousAuth: { enabled: false } };
  state.users = {
    user_bob: {
      username: 'bob',
      name: 'Bob',
      email: 'bob@example.com',
      active: true,
      internalGroups: ['kiosk']
    },
    user_eve: { username: 'eve', active: false, internalGroups: ['users'] },
    user_olga: { username: 'olga', internalGroups: ['hr'], authMethods: ['oidc'] }
  };
  state.writes = [];
  state.refreshed = [];
  state.snapshots = [];
  state.audits = [];
});

const reason = (body, code) => body.reasons.find(entry => entry.code === code);

describe('admin only', () => {
  it.each([
    ['get', '/api/admin/access/apps/chat'],
    ['get', '/api/admin/access/apps/chat/verdict?groupId=users'],
    ['post', '/api/admin/access/apps/chat/_preview-restrict'],
    ['post', '/api/admin/access/apps/chat/_restrict']
  ])('refuses a content admin: %s %s', async (method, url) => {
    const res = await request(createTestApp(CONTENT_ADMIN))[method](url).send({});
    expect(res.status).toBe(403);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.code).toBe('FORBIDDEN');
    expect(state.writes).toHaveLength(0);
  });

  it('refuses a request without a user', async () => {
    const res = await request(createTestApp(undefined)).get('/api/admin/access/models/gpt');
    expect(res.status).toBe(403);
  });
});

describe('GET /api/admin/access/:type/:id', () => {
  it('describes a model with the inheritance chain of each wildcard', async () => {
    const res = await request(createTestApp(ADMIN)).get('/api/admin/access/models/mistral');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: 'models',
      id: 'mistral',
      audience: { allSignedIn: true, anonymous: false },
      wildcardGroups: ['admins', 'users', 'authenticated'],
      restrictable: true
    });
    const hr = res.body.groups.find(group => group.id === 'hr');
    expect(hr.effective).toBe(true);
    expect(hr.via).toEqual([
      { groupId: 'users', path: ['hr', 'users'], kind: 'wildcard' },
      { groupId: 'authenticated', path: ['hr', 'users', 'authenticated'], kind: 'wildcard' }
    ]);
    const kiosk = res.body.groups.find(group => group.id === 'kiosk');
    expect(kiosk).toMatchObject({ effective: false, via: [] });
    expect(res.body.groups.find(group => group.id === 'authenticated').implicit).toBe(true);
  });

  it('marks an explicit grant as explicit', async () => {
    const res = await request(createTestApp(ADMIN)).get('/api/admin/access/models/GPT');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('gpt');
    expect(res.body.groups.find(group => group.id === 'anonymous').via).toEqual([
      { groupId: 'anonymous', path: ['anonymous'], kind: 'explicit' }
    ]);
  });

  it('answers 400 for an unknown type and 404 for an unknown item', async () => {
    const badType = await request(createTestApp(ADMIN)).get('/api/admin/access/tools/x');
    expect(badType.status).toBe(400);
    expect(badType.body.code).toBe('BAD_REQUEST');

    const missing = await request(createTestApp(ADMIN)).get('/api/admin/access/models/nope');
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('NOT_FOUND');
  });
});

describe('GET /api/admin/access/:type/:id/verdict', () => {
  const verdict = url => request(createTestApp(ADMIN)).get(url);

  it('says a group sees an app through an inherited wildcard', async () => {
    const res = await verdict('/api/admin/access/apps/chat/verdict?groupId=hr');

    expect(res.status).toBe(200);
    expect(res.body.verdict).toBe('available');
    expect(res.body.subject).toMatchObject({
      kind: 'group',
      id: 'hr',
      name: 'HR',
      groups: ['hr', 'authenticated']
    });
    expect(reason(res.body, 'granted').routes[0]).toEqual({
      groupId: 'authenticated',
      path: ['authenticated'],
      kind: 'wildcard'
    });
    expect(reason(res.body, 'modelsAvailable').modelIds).toEqual(['gpt', 'mistral']);
  });

  it('blocks a disabled app', async () => {
    const res = await verdict('/api/admin/access/apps/old/verdict?groupId=users');
    expect(res.body.verdict).toBe('unavailable');
    expect(reason(res.body, 'itemDisabled').status).toBe('blocked');
  });

  it('blocks an app whose required feature is off', async () => {
    const res = await verdict('/api/admin/access/apps/needs-flag/verdict?groupId=users');
    expect(res.body.verdict).toBe('unavailable');
    expect(reason(res.body, 'featureOff')).toMatchObject({
      status: 'blocked',
      featureId: 'experimentalX'
    });
  });

  it('blocks a chat app without a usable model and names why each model drops out', async () => {
    const res = await verdict('/api/admin/access/apps/claude-only/verdict?groupId=users');
    expect(res.body.verdict).toBe('unavailable');
    expect(reason(res.body, 'noUsableModel').models).toEqual([{ id: 'claude', cause: 'disabled' }]);
    expect(reason(res.body, 'preferredModelUnavailable')).toMatchObject({
      status: 'warning',
      modelId: 'claude',
      cause: 'disabled'
    });
  });

  it('lists every chat model with its cause when the app names none and none is usable', async () => {
    state.models = [
      { id: 'gpt', enabled: false },
      { id: 'whisper', enabled: false, modelType: 'transcription' },
      { id: 'mistral', enabled: false }
    ];
    const res = await verdict('/api/admin/access/apps/chat/verdict?groupId=users');
    expect(res.body.verdict).toBe('unavailable');
    expect(reason(res.body, 'noUsableModel').models).toEqual([
      { id: 'gpt', cause: 'disabled' },
      { id: 'mistral', cause: 'disabled' }
    ]);
  });

  it('does not ask an iframe app for a model', async () => {
    const res = await verdict('/api/admin/access/apps/portal/verdict?groupId=users');
    expect(res.body.verdict).toBe('available');
    expect(reason(res.body, 'noUsableModel')).toBeUndefined();
    expect(reason(res.body, 'modelsAvailable')).toBeUndefined();
  });

  it('says a model is not granted once no group of the subject grants it', async () => {
    state.groupsData.groups.authenticated.permissions.models = ['gpt'];
    state.groupsData.groups.users.permissions.models = ['gpt'];
    const res = await verdict('/api/admin/access/models/mistral/verdict?groupId=hr');
    expect(res.body.verdict).toBe('unavailable');
    expect(reason(res.body, 'notGranted').status).toBe('blocked');
  });

  it('checks a user with the groups recorded for them', async () => {
    state.groupsData.groups.authenticated.permissions.apps = ['chat'];
    const res = await verdict('/api/admin/access/apps/hr-helper/verdict?userId=bob');
    expect(res.status).toBe(200);
    expect(res.body.subject).toMatchObject({
      kind: 'user',
      id: 'user_bob',
      name: 'Bob',
      groups: ['kiosk', 'authenticated'],
      notes: []
    });
    expect(res.body.verdict).toBe('unavailable');
    expect(reason(res.body, 'notGranted')).toBeDefined();
  });

  it('blocks a deactivated user and notes groups an identity provider sends', async () => {
    const inactive = await verdict('/api/admin/access/apps/chat/verdict?userId=user_eve');
    expect(reason(inactive.body, 'userInactive').status).toBe('blocked');

    const external = await verdict('/api/admin/access/apps/chat/verdict?userId=olga');
    expect(external.body.subject.notes).toEqual(['identityProviderGroupsUnknown']);
  });

  it('says anonymous access is off when asked about the anonymous group', async () => {
    const res = await verdict('/api/admin/access/apps/chat/verdict?groupId=anonymous');
    expect(res.body.subject.kind).toBe('anonymous');
    expect(res.body.verdict).toBe('unavailable');
    expect(reason(res.body, 'anonymousAccessOff')).toBeDefined();
  });

  it('answers 400 without exactly one subject, 404 for an unknown group or user', async () => {
    const none = await verdict('/api/admin/access/apps/chat/verdict');
    expect(none.status).toBe(400);
    expect(none.body.code).toBe('VALIDATION_FAILED');

    const both = await verdict('/api/admin/access/apps/chat/verdict?groupId=hr&userId=bob');
    expect(both.status).toBe(400);

    const group = await verdict('/api/admin/access/apps/chat/verdict?groupId=ghosts');
    expect(group.status).toBe(404);

    const user = await verdict('/api/admin/access/apps/chat/verdict?userId=nobody');
    expect(user.status).toBe(404);

    const prompts = await verdict('/api/admin/access/prompts/summary/verdict?groupId=hr');
    expect(prompts.status).toBe(400);
  });
});

describe('POST /api/admin/access/:type/:id/_preview-restrict', () => {
  it('previews converting every wildcard group without writing', async () => {
    const res = await request(createTestApp(ADMIN))
      .post('/api/admin/access/apps/hr-helper/_preview-restrict')
      .send({ grantGroupIds: ['hr'] });

    expect(res.status).toBe(200);
    expect(state.writes).toHaveLength(0);
    expect(res.body.selected).toEqual(['admins', 'users', 'authenticated']);
    expect(res.body.candidates.find(candidate => candidate.id === 'users')).toMatchObject({
      itemCount: 5,
      currentCount: 6,
      passesTo: ['admins', 'hr'],
      selected: true
    });
    const after = Object.fromEntries(res.body.groupsAfter.map(row => [row.id, row]));
    expect(after.hr).toMatchObject({ before: true, after: true });
    expect(after.users).toMatchObject({ before: true, after: false });
    expect(after.admins).toMatchObject({ before: true, after: false });
    expect(res.body.audienceAfter).toEqual({ allSignedIn: false, anonymous: false });
    expect(res.body.updatedGroups).toBeUndefined();
  });

  it('keeps the item visible below a wildcard group that is kept', async () => {
    const res = await request(createTestApp(ADMIN))
      .post('/api/admin/access/apps/hr-helper/_preview-restrict')
      .send({ groupIds: ['admins', 'users'] });

    expect(res.status).toBe(200);
    const after = Object.fromEntries(res.body.groupsAfter.map(row => [row.id, row]));
    // authenticated keeps `*`, and users / admins / hr inherit it.
    expect(after.users.after).toBe(true);
    expect(after.users.via).toEqual([
      { groupId: 'authenticated', path: ['users', 'authenticated'], kind: 'wildcard' }
    ]);
    expect(res.body.audienceAfter.allSignedIn).toBe(true);
  });

  it('refuses a group that holds no wildcard', async () => {
    const res = await request(createTestApp(ADMIN))
      .post('/api/admin/access/apps/hr-helper/_preview-restrict')
      .send({ groupIds: ['hr'] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BAD_REQUEST');
  });
});

describe('POST /api/admin/access/:type/:id/_restrict', () => {
  it('rewrites the wildcard groups, grants the item, and records history and audit', async () => {
    const res = await request(createTestApp(ADMIN))
      .post('/api/admin/access/apps/hr-helper/_restrict')
      .send({ grantGroupIds: ['hr'] });

    expect(res.status).toBe(200);
    expect(res.body.changed).toEqual(['admins', 'users', 'authenticated', 'hr']);
    expect(state.writes).toHaveLength(1);

    const written = state.groupsData.groups;
    const expected = ['chat', 'old', 'needs-flag', 'claude-only', 'portal'];
    expect(written.admins.permissions.apps).toEqual(expected);
    expect(written.users.permissions.apps).toEqual(expected);
    expect(written.authenticated.permissions.apps).toEqual(expected);
    expect(written.hr.permissions.apps).toEqual(['hr-helper']);
    // Only the apps list changes.
    expect(written.users.permissions.models).toEqual(['*']);
    expect(written.admins.permissions.adminAccess).toBe(true);
    expect(written.anonymous).toEqual(freshGroups().groups.anonymous);
    expect(state.groupsData.metadata.lastModified).not.toBe('2026-01-01T00:00:00.000Z');

    expect(state.refreshed).toEqual(['config/groups.json']);
    expect(state.snapshots.map(snapshot => snapshot.id)).toEqual([
      'admins',
      'users',
      'authenticated',
      'hr'
    ]);
    expect(state.snapshots[1].before.permissions.apps).toEqual(['*']);
    expect(state.snapshots[1].after.permissions.apps).toEqual(expected);
    expect(state.audits.map(audit => audit.resourceId)).toEqual([
      'admins',
      'users',
      'authenticated',
      'hr'
    ]);
    expect(state.audits[0]).toMatchObject({ action: 'update', resource: 'group' });
    expect(state.audits[3].summary).toBe('Granted app hr-helper to group hr');

    const view = Object.fromEntries(res.body.groups.map(row => [row.id, row]));
    expect(view.hr.effective).toBe(true);
    expect(view.users.effective).toBe(false);
    expect(view.kiosk.effective).toBe(false);
    expect(res.body.restrictable).toBe(false);
  });

  it('keeps explicit entries a wildcard list held and leaves other groups alone', async () => {
    state.groupsData.groups.users.permissions.apps = ['*', 'future-app'];
    const res = await request(createTestApp(ADMIN))
      .post('/api/admin/access/apps/chat/_restrict')
      .send({ groupIds: ['users'] });

    expect(res.status).toBe(200);
    expect(res.body.changed).toEqual(['users']);
    expect(state.groupsData.groups.users.permissions.apps).toEqual([
      'hr-helper',
      'old',
      'needs-flag',
      'claude-only',
      'portal',
      'future-app'
    ]);
    expect(state.groupsData.groups.authenticated.permissions.apps).toEqual(['*']);
  });

  it('restricts a model the same way', async () => {
    const res = await request(createTestApp(ADMIN))
      .post('/api/admin/access/models/mistral/_restrict')
      .send({ groupIds: ['users', 'authenticated'] });

    expect(res.status).toBe(200);
    expect(state.groupsData.groups.users.permissions.models).toEqual(['gpt', 'claude']);
    expect(state.groupsData.groups.admins.permissions.models).toEqual(['*']);
    const view = Object.fromEntries(res.body.groups.map(row => [row.id, row]));
    expect(view.hr.effective).toBe(false);
    expect(view.admins.effective).toBe(true);
  });

  it('writes nothing when nothing changes', async () => {
    const res = await request(createTestApp(ADMIN))
      .post('/api/admin/access/apps/chat/_restrict')
      .send({ groupIds: [] });
    expect(res.status).toBe(200);
    expect(res.body.changed).toEqual([]);
    expect(state.writes).toHaveLength(0);
    expect(state.audits).toHaveLength(0);
  });

  it('refuses an unknown group, a malformed body and a skill', async () => {
    const unknown = await request(createTestApp(ADMIN))
      .post('/api/admin/access/apps/chat/_restrict')
      .send({ grantGroupIds: ['ghosts'] });
    expect(unknown.status).toBe(404);

    const malformed = await request(createTestApp(ADMIN))
      .post('/api/admin/access/apps/chat/_restrict')
      .send({ groupIds: 'users' });
    expect(malformed.status).toBe(400);
    expect(malformed.body.code).toBe('VALIDATION_FAILED');

    const skill = await request(createTestApp(ADMIN))
      .post('/api/admin/access/skills/pdf/_restrict')
      .send({});
    expect(skill.status).toBe(400);
    expect(state.writes).toHaveLength(0);
  });
});
