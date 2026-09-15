/**
 * Route tests for `/api/admin/content-access/:type/:id` (issue #2365).
 *
 * A content admin may change which groups can use an app, prompt, skill, tool
 * or workflow, but only for the groups they belong to and the groups that
 * inherit from those. A full admin may change every group. These tests drive
 * the route with supertest against an in-memory groups.json and check what is
 * shown, what is written, and what is refused.
 *
 * Note: The repo's source is native ESM, so this file uses
 * `jest.unstable_mockModule` + dynamic imports. Run with
 * `NODE_OPTIONS=--experimental-vm-modules`.
 */

import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const state = {
  groupsData: null,
  writes: [],
  refreshed: [],
  snapshots: [],
  audits: []
};

function freshGroups() {
  return {
    groups: {
      anonymous: { id: 'anonymous', name: 'Anonymous', permissions: { apps: ['public'] } },
      authenticated: {
        id: 'authenticated',
        name: 'Authenticated',
        inherits: ['anonymous'],
        permissions: { apps: [] }
      },
      users: {
        id: 'users',
        name: 'Users',
        inherits: ['authenticated'],
        permissions: { apps: ['chat'] }
      },
      sales: { id: 'sales', name: 'Sales', inherits: ['users'], permissions: { apps: [] } },
      'emea-sales': {
        id: 'emea-sales',
        name: 'EMEA Sales',
        inherits: ['sales'],
        permissions: { apps: [] }
      },
      marketing: {
        id: 'marketing',
        name: 'Marketing',
        inherits: ['users'],
        permissions: { apps: ['sales-bot'] }
      },
      admins: { id: 'admins', name: 'Admins', permissions: { apps: ['*'], adminAccess: true } },
      'content-admins': {
        id: 'content-admins',
        name: 'Content Admins',
        inherits: ['authenticated'],
        permissions: { apps: [], contentAdmin: true }
      }
    },
    metadata: { lastModified: '2026-01-01T00:00:00.000Z' }
  };
}

const CONTENT_ADMIN = {
  id: 'carol',
  username: 'carol',
  groups: ['content-admins', 'sales', 'authenticated']
};
const FULL_ADMIN = { id: 'alice', username: 'alice', groups: ['admins', 'authenticated'] };

jest.unstable_mockModule('../services/config/ConfigStore.js', () => ({
  default: {
    readJsonStrict: async () => structuredClone(state.groupsData),
    writeJson: async (file, data) => {
      state.writes.push({ file, data: structuredClone(data) });
      state.groupsData = structuredClone(data);
    }
  }
}));

jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    getApps: () => ({ data: [{ id: 'chat' }, { id: 'Sales-Bot' }, { id: 'public' }] }),
    getPrompts: () => ({ data: [{ id: 'summary' }] }),
    getWorkflows: () => ({ data: [{ id: 'triage' }] }),
    getTools: () => ({ data: [{ id: 'iFinder' }] }),
    getSkills: () => ({ data: [{ name: 'pdf' }] }),
    getPlatform: () => ({ auth: {} }),
    refreshCacheEntry: async key => {
      state.refreshed.push(key);
    }
  }
}));

// Both middlewares are exercised elsewhere; here they only decide who the
// caller is. `contentAdminAuth` lets every test user through (each carries
// either contentAdmin or adminAccess), and `isAdminAuthRequired` answers the
// way the real one would for these groups.
jest.unstable_mockModule('../middleware/contentAdminAuth.js', () => ({
  contentAdminAuth: (req, res, next) => (req.user ? next() : res.status(401).end())
}));

jest.unstable_mockModule('../middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) => next(),
  isAdminAuthRequired: req => !(req.user?.groups || []).includes('admins')
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

const { default: registerAdminContentAccessRoutes } =
  await import('../routes/admin/contentAccess.js');

function createTestApp(user) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = user;
    next();
  });
  registerAdminContentAccessRoutes(app);
  return app;
}

beforeEach(() => {
  state.groupsData = freshGroups();
  state.writes = [];
  state.refreshed = [];
  state.snapshots = [];
  state.audits = [];
});

describe('GET /api/admin/content-access/:type/:id', () => {
  it('shows a content admin only the groups they belong to and their descendants', async () => {
    const res = await request(createTestApp(CONTENT_ADMIN)).get(
      '/api/admin/content-access/apps/chat'
    );

    expect(res.status).toBe(200);
    expect(res.body.type).toBe('apps');
    expect(res.body.id).toBe('chat');
    expect(res.body.scope).toBe('membership');
    // sales (member), emea-sales (inherits from sales), content-admins (member).
    // Not users or marketing, and not the implicit authenticated group.
    expect(res.body.groups.map(group => group.id)).toEqual([
      'sales',
      'emea-sales',
      'content-admins'
    ]);

    const sales = res.body.groups.find(group => group.id === 'sales');
    expect(sales).toMatchObject({
      name: 'Sales',
      granted: false,
      wildcard: false,
      inheritedFrom: ['users'],
      effective: true
    });
  });

  it('shows a full admin every group', async () => {
    const res = await request(createTestApp(FULL_ADMIN)).get('/api/admin/content-access/apps/chat');

    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('all');
    expect(res.body.groups.map(group => group.id)).toEqual(Object.keys(freshGroups().groups));
    expect(res.body.groups.find(group => group.id === 'admins')).toMatchObject({
      granted: false,
      wildcard: true,
      effective: true
    });
  });

  it('resolves the content id case-insensitively and answers with the configured spelling', async () => {
    const res = await request(createTestApp(FULL_ADMIN)).get(
      '/api/admin/content-access/apps/SALES-BOT'
    );

    expect(res.status).toBe(200);
    expect(res.body.id).toBe('Sales-Bot');
    expect(res.body.groups.find(group => group.id === 'marketing').granted).toBe(true);
  });

  it('identifies skills by name', async () => {
    const res = await request(createTestApp(FULL_ADMIN)).get(
      '/api/admin/content-access/skills/pdf'
    );
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('pdf');
  });

  it('rejects an unknown content type and an unknown id', async () => {
    const app = createTestApp(FULL_ADMIN);
    expect((await request(app).get('/api/admin/content-access/models/gpt')).status).toBe(400);
    expect((await request(app).get('/api/admin/content-access/__proto__/chat')).status).toBe(400);
    expect((await request(app).get('/api/admin/content-access/apps/nope')).status).toBe(404);
  });

  it('requires a signed-in caller', async () => {
    const res = await request(createTestApp(null)).get('/api/admin/content-access/apps/chat');
    expect(res.status).toBe(401);
  });
});

describe('PUT /api/admin/content-access/:type/:id', () => {
  it('lets a content admin grant one of their groups and records the change', async () => {
    const res = await request(createTestApp(CONTENT_ADMIN))
      .put('/api/admin/content-access/apps/chat')
      .send({ grant: ['sales'] });

    expect(res.status).toBe(200);
    expect(res.body.changed).toEqual(['sales']);
    expect(res.body.groups.find(group => group.id === 'sales').granted).toBe(true);

    expect(state.writes).toHaveLength(1);
    expect(state.writes[0].file).toBe('config/groups.json');
    const written = state.writes[0].data;
    expect(written.groups.sales.permissions.apps).toEqual(['chat']);
    // Nothing else in the file moves.
    expect(written.groups.marketing).toEqual(freshGroups().groups.marketing);
    expect(written.groups.users.permissions.apps).toEqual(['chat']);
    expect(written.metadata.lastModified).not.toBe('2026-01-01T00:00:00.000Z');

    expect(state.refreshed).toEqual(['config/groups.json']);
    expect(state.snapshots).toHaveLength(1);
    expect(state.snapshots[0]).toMatchObject({ resource: 'group', id: 'sales', admin: 'carol' });
    expect(state.snapshots[0].before.permissions.apps).toEqual([]);
    expect(state.snapshots[0].after.permissions.apps).toEqual(['chat']);
    expect(state.audits).toHaveLength(1);
    expect(state.audits[0]).toMatchObject({
      action: 'update',
      resource: 'group',
      resourceId: 'sales',
      summary: 'Granted app chat to group sales'
    });
  });

  it('refuses a content admin touching a group they are not part of, and writes nothing', async () => {
    const res = await request(createTestApp(CONTENT_ADMIN))
      .put('/api/admin/content-access/apps/chat')
      .send({ grant: ['sales', 'marketing'] });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/marketing/);
    expect(state.writes).toHaveLength(0);
    expect(state.refreshed).toHaveLength(0);
    expect(state.snapshots).toHaveLength(0);
  });

  it('refuses the implicit authenticated group for a content admin', async () => {
    const res = await request(createTestApp(CONTENT_ADMIN))
      .put('/api/admin/content-access/apps/chat')
      .send({ grant: ['authenticated'] });

    expect(res.status).toBe(403);
    expect(state.writes).toHaveLength(0);
  });

  it('lets a full admin grant and revoke across groups in one request', async () => {
    const res = await request(createTestApp(FULL_ADMIN))
      .put('/api/admin/content-access/apps/Sales-Bot')
      .send({ grant: ['sales'], revoke: ['marketing'] });

    expect(res.status).toBe(200);
    expect(res.body.changed).toEqual(['sales', 'marketing']);
    const written = state.writes[0].data.groups;
    expect(written.sales.permissions.apps).toEqual(['Sales-Bot']);
    // Stored as `sales-bot`, revoked by the configured `Sales-Bot`: casing does not matter.
    expect(written.marketing.permissions.apps).toEqual([]);
    expect(state.snapshots.map(snapshot => snapshot.id)).toEqual(['sales', 'marketing']);
    expect(state.audits[1].summary).toBe('Revoked app Sales-Bot from group marketing');
  });

  it('refuses to withdraw a single app from a wildcard group', async () => {
    const res = await request(createTestApp(FULL_ADMIN))
      .put('/api/admin/content-access/apps/chat')
      .send({ revoke: ['admins'] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/wildcard/);
    expect(state.writes).toHaveLength(0);
  });

  it('answers 404 for a group that does not exist', async () => {
    const res = await request(createTestApp(FULL_ADMIN))
      .put('/api/admin/content-access/apps/chat')
      .send({ grant: ['ghost'] });

    expect(res.status).toBe(404);
    expect(state.writes).toHaveLength(0);
  });

  it('does not write when nothing changes', async () => {
    const res = await request(createTestApp(FULL_ADMIN))
      .put('/api/admin/content-access/apps/chat')
      .send({ grant: ['users'] });

    expect(res.status).toBe(200);
    expect(res.body.changed).toEqual([]);
    expect(state.writes).toHaveLength(0);
    expect(state.refreshed).toHaveLength(0);
  });

  it('validates the body shape and the group ids', async () => {
    const app = createTestApp(FULL_ADMIN);
    expect(
      (await request(app).put('/api/admin/content-access/apps/chat').send({ grant: 'sales' }))
        .status
    ).toBe(400);
    expect(
      (
        await request(app)
          .put('/api/admin/content-access/apps/chat')
          .send({ grant: ['../etc'] })
      ).status
    ).toBe(400);
    expect(state.writes).toHaveLength(0);
  });

  it('only ever changes the requested content list of a group', async () => {
    await request(createTestApp(FULL_ADMIN))
      .put('/api/admin/content-access/prompts/summary')
      .send({ grant: ['content-admins'] });

    const written = state.writes[0].data.groups['content-admins'];
    expect(written.permissions).toEqual({ apps: [], contentAdmin: true, prompts: ['summary'] });
    expect(written.inherits).toEqual(['authenticated']);
  });
});
