// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The `audience` of the content-access view
 * (`GET` and `PUT /api/admin/content-access/:type/:id`).
 *
 * A content admin sees only the rows of the groups they manage. The group
 * every signed-in user carries is not one of them, and on the shipped
 * `groups.json` that group grants every app. A publish dialog built from the
 * rows alone would say "no group can use this app" while everyone who signs in
 * gets it. `audience` states that one fact, computed over all groups; rows of
 * such groups are marked `implicit`, so a client does not print "Authenticated"
 * as the name of a team.
 *
 * The route runs against the shipped `server/defaults/config/groups.json`.
 *
 * Native ESM: `jest.unstable_mockModule` + dynamic imports.
 */
import { jest } from '@jest/globals';
import fs from 'node:fs';
import request from 'supertest';
import express from 'express';

const SHIPPED_GROUPS = JSON.parse(
  fs.readFileSync(new URL('../defaults/config/groups.json', import.meta.url), 'utf8')
);

const state = { groupsData: null, platform: null };

jest.unstable_mockModule('../services/config/ConfigStore.js', () => ({
  default: {
    readJsonStrict: async () => structuredClone(state.groupsData),
    updateJson: async function (file, mutate) {
      const current = structuredClone(state.groupsData);
      const next = await mutate(current);
      if (next === undefined) return { data: current, written: false };
      state.groupsData = structuredClone(next);
      return { data: next, written: true };
    }
  }
}));

jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    getApps: () => ({ data: [{ id: 'chat' }, { id: 'translator' }] }),
    getPrompts: () => ({ data: [{ id: 'summary' }] }),
    getWorkflows: () => ({ data: [] }),
    getSkills: () => ({ data: [] }),
    getPlatform: () => state.platform,
    refreshCacheEntry: async () => {}
  }
}));

// Who may call is tested with the route's own suite; here the caller is given.
jest.unstable_mockModule('../middleware/contentAdminAuth.js', () => ({
  contentAdminAuth: (req, res, next) => next()
}));
jest.unstable_mockModule('../services/ChangeHistoryService.js', () => ({
  saveSnapshot: async () => {}
}));
jest.unstable_mockModule('../services/AuditLogService.js', () => ({
  logAudit: async () => {}
}));
jest.unstable_mockModule('../utils/adminGuards.js', () => ({
  assertGroupsResolvable: () => {}
}));

const { default: registerAdminContentAccessRoutes } =
  await import('../routes/admin/contentAccess.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');
const { describeAudience, describeContentAccess } = await import('../utils/contentAccess.js');

/** A content admin on the shipped groups: a member of `users`, like everyone who signs in. */
const CONTENT_ADMIN = {
  id: 'carol',
  username: 'carol',
  isContentAdmin: true,
  groups: ['users', 'authenticated']
};
const FULL_ADMIN = {
  id: 'alice',
  username: 'alice',
  isAdmin: true,
  isContentAdmin: true,
  groups: ['admins', 'users', 'authenticated']
};

function server(user) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = user;
    next();
  });
  registerAdminContentAccessRoutes(app);
  app.use(errorHandler);
  return app;
}

const view = async (user, path = '/api/admin/content-access/apps/chat') => {
  const res = await request(server(user)).get(path);
  expect(res.status).toBe(200);
  return res.body;
};

/** The shipped groups with one change. */
function setGroups(change = () => {}) {
  const data = structuredClone(SHIPPED_GROUPS);
  change(data.groups);
  state.groupsData = data;
}

beforeEach(() => {
  setGroups();
  state.platform = { auth: {}, anonymousAuth: { enabled: false, defaultGroups: ['anonymous'] } };
});

describe('audience.allSignedIn on the shipped groups', () => {
  it('is true for a content admin although no row for "authenticated" is returned', async () => {
    const body = await view(CONTENT_ADMIN);

    expect(body.scope).toBe('membership');
    expect(body.groups.map(group => group.id)).not.toContain('authenticated');
    expect(body.groups.map(group => group.id)).not.toContain('anonymous');
    expect(body.audience.allSignedIn).toBe(true);
  });

  it('is true for an app only the wildcard grants', async () => {
    const body = await view(CONTENT_ADMIN, '/api/admin/content-access/apps/translator');
    expect(body.audience).toEqual({ allSignedIn: true, anonymous: false });
  });

  it('is false with the wildcard removed from "authenticated"', async () => {
    setGroups(groups => {
      groups.authenticated.permissions.apps = [];
      // `chat` would still reach signed-in users through the anonymous group.
      groups.anonymous.permissions.apps = [];
    });
    const body = await view(CONTENT_ADMIN);
    expect(body.audience.allSignedIn).toBe(false);
    // The rows the content admin manages still grant it: that is a different fact.
    expect(body.groups.find(group => group.id === 'users').effective).toBe(true);
  });

  it('is true when "authenticated" names the app, and false for another app', async () => {
    setGroups(groups => {
      groups.authenticated.permissions.apps = ['Chat'];
      groups.anonymous.permissions.apps = [];
    });
    expect((await view(CONTENT_ADMIN)).audience.allSignedIn).toBe(true);
    expect(
      (await view(CONTENT_ADMIN, '/api/admin/content-access/apps/translator')).audience.allSignedIn
    ).toBe(false);
  });

  it('is true when "authenticated" gets the app from a group it inherits from', async () => {
    setGroups(groups => {
      groups.authenticated.permissions.apps = [];
      groups.anonymous.permissions.apps = ['chat'];
    });
    expect((await view(CONTENT_ADMIN)).audience.allSignedIn).toBe(true);
  });

  it('follows the configured group of signed-in users', async () => {
    setGroups(groups => {
      groups.authenticated.permissions.apps = [];
      groups.anonymous.permissions.apps = [];
      groups.staff = { id: 'staff', name: 'Staff', permissions: { apps: ['*'] } };
    });
    expect((await view(CONTENT_ADMIN)).audience.allSignedIn).toBe(false);
    state.platform.auth = { authenticatedGroup: 'staff' };
    expect((await view(CONTENT_ADMIN)).audience.allSignedIn).toBe(true);
  });

  it('is the same for a full admin', async () => {
    expect((await view(FULL_ADMIN)).audience.allSignedIn).toBe(true);
    setGroups(groups => {
      groups.authenticated.permissions.apps = [];
      groups.anonymous.permissions.apps = [];
    });
    expect((await view(FULL_ADMIN)).audience.allSignedIn).toBe(false);
  });

  it('is computed per content type', async () => {
    setGroups(groups => {
      groups.authenticated.permissions.prompts = [];
      groups.anonymous.permissions.prompts = [];
    });
    const body = await view(CONTENT_ADMIN, '/api/admin/content-access/prompts/summary');
    expect(body.audience.allSignedIn).toBe(false);
    expect((await view(CONTENT_ADMIN)).audience.allSignedIn).toBe(true);
  });
});

describe('audience.anonymous', () => {
  it('is false while anonymous access is off, whatever the anonymous group grants', async () => {
    const body = await view(CONTENT_ADMIN);
    expect(SHIPPED_GROUPS.groups.anonymous.permissions.apps).toContain('chat');
    expect(body.audience.anonymous).toBe(false);
  });

  it('is true with anonymous access on and the app granted to the anonymous group', async () => {
    state.platform.anonymousAuth.enabled = true;
    expect((await view(CONTENT_ADMIN)).audience).toEqual({ allSignedIn: true, anonymous: true });
    // The shipped anonymous group names `chat` only.
    expect(
      (await view(CONTENT_ADMIN, '/api/admin/content-access/apps/translator')).audience
    ).toEqual({ allSignedIn: true, anonymous: false });
  });

  it('reads the groups anonymous visitors are given', async () => {
    state.platform.anonymousAuth = { enabled: true, defaultGroups: ['guests'] };
    setGroups(groups => {
      groups.guests = { id: 'guests', name: 'Guests', permissions: { apps: ['translator'] } };
    });
    expect((await view(CONTENT_ADMIN)).audience.anonymous).toBe(false);
    expect(
      (await view(CONTENT_ADMIN, '/api/admin/content-access/apps/translator')).audience.anonymous
    ).toBe(true);
  });

  it('is false for a group that does not exist', async () => {
    state.platform.anonymousAuth = { enabled: true, defaultGroups: ['gone', '__proto__'] };
    expect((await view(CONTENT_ADMIN)).audience.anonymous).toBe(false);
  });
});

describe('implicit rows', () => {
  it('marks the rows of "authenticated" and "anonymous" for a full admin', async () => {
    const body = await view(FULL_ADMIN);

    expect(body.scope).toBe('all');
    expect(body.groups.map(group => group.id)).toEqual(Object.keys(SHIPPED_GROUPS.groups));
    const row = id => body.groups.find(group => group.id === id);
    expect(row('authenticated').implicit).toBe(true);
    expect(row('anonymous').implicit).toBe(true);
    // Rows of groups people are members of carry no such key.
    expect('implicit' in row('users')).toBe(false);
    expect('implicit' in row('admins')).toBe(false);
  });

  it('marks the configured group of signed-in users as well', async () => {
    setGroups(groups => {
      groups.staff = { id: 'staff', name: 'Staff', permissions: { apps: [] } };
    });
    state.platform.auth = { authenticatedGroup: 'staff' };
    const body = await view(FULL_ADMIN);
    expect(body.groups.find(group => group.id === 'staff').implicit).toBe(true);
  });

  it('never shows a content admin an implicit row', async () => {
    const body = await view(CONTENT_ADMIN);
    expect(body.groups.some(group => group.implicit)).toBe(false);
  });
});

describe('what stays as it was', () => {
  const ROW_KEYS = [
    'id',
    'name',
    'description',
    'granted',
    'wildcard',
    'inheritedFrom',
    'effective',
    'via'
  ];

  it('keeps scope and the row fields for a content admin', async () => {
    const body = await view(CONTENT_ADMIN);

    expect(Object.keys(body)).toEqual(['type', 'id', 'scope', 'groups', 'audience']);
    expect(body).toMatchObject({ type: 'apps', id: 'chat', scope: 'membership' });
    // `users` (member) and the groups that inherit from it, in the file's order.
    expect(body.groups.map(group => group.id)).toEqual([
      'admins',
      'users',
      'browser-extension',
      'nextcloud-embed'
    ]);
    expect(body.groups.filter(group => ['admins', 'users'].includes(group.id))).toEqual([
      {
        id: 'admins',
        name: SHIPPED_GROUPS.groups.admins.name,
        description: SHIPPED_GROUPS.groups.admins.description,
        granted: false,
        wildcard: true,
        inheritedFrom: ['users', 'authenticated', 'anonymous'],
        effective: true,
        via: [
          { groupId: 'admins', path: ['admins'], kind: 'wildcard' },
          { groupId: 'users', path: ['admins', 'users'], kind: 'wildcard' },
          {
            groupId: 'authenticated',
            path: ['admins', 'users', 'authenticated'],
            kind: 'wildcard'
          },
          {
            groupId: 'anonymous',
            path: ['admins', 'users', 'authenticated', 'anonymous'],
            kind: 'explicit'
          }
        ]
      },
      {
        id: 'users',
        name: SHIPPED_GROUPS.groups.users.name,
        description: SHIPPED_GROUPS.groups.users.description,
        granted: false,
        wildcard: true,
        inheritedFrom: ['authenticated', 'anonymous'],
        effective: true,
        via: [
          { groupId: 'users', path: ['users'], kind: 'wildcard' },
          { groupId: 'authenticated', path: ['users', 'authenticated'], kind: 'wildcard' },
          { groupId: 'anonymous', path: ['users', 'authenticated', 'anonymous'], kind: 'explicit' }
        ]
      }
    ]);
  });

  it('keeps the row fields for a full admin; implicit and via are the only new ones', async () => {
    const body = await view(FULL_ADMIN);
    for (const group of body.groups) {
      const keys = Object.keys(group);
      expect(keys.filter(key => key !== 'implicit')).toEqual(ROW_KEYS);
    }
    expect(body.groups.find(group => group.id === 'anonymous')).toEqual({
      id: 'anonymous',
      name: SHIPPED_GROUPS.groups.anonymous.name,
      description: SHIPPED_GROUPS.groups.anonymous.description,
      granted: true,
      wildcard: false,
      inheritedFrom: [],
      effective: true,
      via: [{ groupId: 'anonymous', path: ['anonymous'], kind: 'explicit' }],
      implicit: true
    });
  });

  it('answers the same view after a PUT, with the audience', async () => {
    const res = await request(server(FULL_ADMIN))
      .put('/api/admin/content-access/apps/translator')
      .send({ grant: ['anonymous'] });

    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['type', 'id', 'scope', 'groups', 'audience', 'changed']);
    expect(res.body.changed).toEqual(['anonymous']);
    expect(res.body.audience).toEqual({ allSignedIn: true, anonymous: false });
    expect(res.body.groups.find(group => group.id === 'anonymous')).toMatchObject({
      granted: true,
      implicit: true
    });
  });

  it('shows the new audience after a PUT that changes it', async () => {
    state.platform.anonymousAuth.enabled = true;
    const before = await view(FULL_ADMIN, '/api/admin/content-access/apps/translator');
    expect(before.audience.anonymous).toBe(false);

    const res = await request(server(FULL_ADMIN))
      .put('/api/admin/content-access/apps/translator')
      .send({ grant: ['anonymous'] });
    expect(res.body.audience).toEqual({ allSignedIn: true, anonymous: true });
  });

  it('still refuses a content admin who changes a group outside their scope', async () => {
    const res = await request(server(CONTENT_ADMIN))
      .put('/api/admin/content-access/apps/chat')
      .send({ grant: ['authenticated'] });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
  });
});

describe('describeAudience', () => {
  const groups = {
    anonymous: { permissions: { apps: ['public'] } },
    authenticated: { inherits: ['anonymous'], permissions: { apps: ['Chat'] } },
    guests: { permissions: { apps: ['*'] } }
  };
  const audience = extra => describeAudience({ groups, type: 'apps', contentId: 'chat', ...extra });

  it('answers both facts as booleans', () => {
    expect(audience()).toEqual({ allSignedIn: true, anonymous: false });
    expect(audience({ anonymousGroups: ['anonymous'] })).toEqual({
      allSignedIn: true,
      anonymous: false
    });
    expect(audience({ anonymousGroups: ['anonymous', 'guests'] })).toEqual({
      allSignedIn: true,
      anonymous: true
    });
  });

  it('matches ids as the permission check does, without regard to case', () => {
    expect(describeAudience({ groups, type: 'apps', contentId: 'CHAT' }).allSignedIn).toBe(true);
  });

  it('counts inheritance for the group of signed-in users', () => {
    expect(describeAudience({ groups, type: 'apps', contentId: 'public' }).allSignedIn).toBe(true);
    expect(describeAudience({ groups, type: 'apps', contentId: 'other' }).allSignedIn).toBe(false);
  });

  it('is false for missing groups and a missing configuration', () => {
    expect(audience({ authenticatedGroup: 'nope' }).allSignedIn).toBe(false);
    expect(describeAudience({ groups: undefined, type: 'apps', contentId: 'chat' })).toEqual({
      allSignedIn: false,
      anonymous: false
    });
    expect(audience({ anonymousGroups: 'anonymous' }).anonymous).toBe(false);
    expect(audience({ authenticatedGroup: '__proto__' }).allSignedIn).toBe(false);
  });
});

describe('describeContentAccess', () => {
  const groups = {
    authenticated: { name: 'Authenticated', permissions: { apps: ['*'] } },
    sales: { name: 'Sales', inherits: ['authenticated'], permissions: { apps: [] } }
  };

  it('adds implicit only where asked, and no key otherwise', () => {
    const rows = describeContentAccess({
      groups,
      type: 'apps',
      contentId: 'chat',
      groupIds: ['authenticated', 'sales'],
      implicitGroups: ['authenticated', 'anonymous']
    });
    expect(rows[0].implicit).toBe(true);
    expect(Object.hasOwn(rows[1], 'implicit')).toBe(false);
  });

  it('answers the rows it always did without the option, plus the grant routes', () => {
    const rows = describeContentAccess({
      groups,
      type: 'apps',
      contentId: 'chat',
      groupIds: ['authenticated', 'sales']
    });
    expect(rows).toEqual([
      {
        id: 'authenticated',
        name: 'Authenticated',
        description: '',
        granted: false,
        wildcard: true,
        inheritedFrom: [],
        effective: true,
        via: [{ groupId: 'authenticated', path: ['authenticated'], kind: 'wildcard' }]
      },
      {
        id: 'sales',
        name: 'Sales',
        description: '',
        granted: false,
        wildcard: false,
        inheritedFrom: ['authenticated'],
        effective: true,
        via: [{ groupId: 'authenticated', path: ['sales', 'authenticated'], kind: 'wildcard' }]
      }
    ]);
  });
});
