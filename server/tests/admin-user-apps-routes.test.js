// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The admin API of personal apps, `/api/admin/user-apps` (slice P5 of
 * concepts/app-builder-rework-2026-11/02-personal-apps.md, sections 8.4, 9.2
 * and 10).
 *
 * The routes run on the Express app of the personal app harness, next to the
 * real chat routes, so "switched off" and "blocked" are checked where a
 * person would notice them. The audit log goes into a scratch contents
 * directory.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

// The contents directory is read when `server/config.js` is first imported,
// so it is set before anything of the server is loaded.
const contentsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-admin-user-apps-'));
process.env.CONTENTS_DIR = contentsDir;

const {
  ADMIN_APP,
  APPS,
  FEATURES,
  PLATFORM,
  SECRET,
  UNKNOWN_PERSONAL_ID,
  USER_APP_SETTINGS,
  chatBody,
  member,
  plainContent,
  setConfig,
  stampCompanyApp,
  shape,
  startUserAppsHarness
} = await import('./helpers/userAppsHarness.js');
const { default: configCache } = await import('../configCache.js');
const { default: configStore } = await import('../services/config/ConfigStore.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');
const { queryAuditLog } = await import('../services/AuditLogService.js');
const { mayCreateUserApps } = await import('../services/userApps/userAppAccess.js');
const { currentUserAppSettings } = await import('../services/userApps/userAppSettings.js');
const { default: registerAdminUserAppRoutes, registerAdminUserAppViewExtension } =
  await import('../routes/admin/userApps.js');

const BASE = '/api/admin/user-apps';
/** An app file that is not switched on: the company app of a published personal app. */
const COMPANY_OFF = 'company-off';

/** `record`, after making `appId` its company app (`sourceUserAppId`). */
const stampedFor = (appId, record) => {
  stampCompanyApp(appId, record.id);
  return record;
};

let harness;
let as;

// The storage provider of the harness serves the configuration, so the stored
// platform.json is read and written through the configuration store.
const PLATFORM_FILE = 'config/platform.json';
const storedPlatform = () => configStore.readJsonStrict(PLATFORM_FILE);
const storePlatform = platform => configStore.writeJson(PLATFORM_FILE, platform);

before(async () => {
  harness = await startUserAppsHarness();
  ({ as } = harness);
  registerAdminUserAppRoutes(harness.api);
  // Registered after the routes of this slice, as a module of another slice
  // may be: an action segment this slice does not have must still reach it.
  harness.api.get(`${BASE}/_waiting`, (req, res) => res.json({ items: [], nextCursor: null }));
  harness.api.use(errorHandler);
  // An owner whose address must never leave through the admin routes.
  harness.addPerson('erin', {
    id: 'erin',
    name: 'Erin Vogel',
    email: 'erin.vogel@example.com',
    authMode: 'oidc',
    groups: ['users']
  });
  // A local owner without an account in users.json: inactive.
  harness.addPerson('lola', {
    id: 'lola',
    name: 'Lola Gone',
    authMode: 'local',
    groups: ['users']
  });
});

after(async () => {
  await harness.stop();
  delete process.env.CONTENTS_DIR;
  await fs.rm(contentsDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

beforeEach(async () => {
  await harness.reset();
  registerAdminUserAppViewExtension(null);
  await storePlatform({ ...PLATFORM, userApps: USER_APP_SETTINGS, marker: 'kept' });
});

/** An app of Anna, shared with Ben ("Can use") and Carol ("Can edit"). */
const sharedApp = (options = {}) =>
  harness.createApp('anna', {
    members: [member('ben', 'user'), member('carol', 'editor')],
    ...options
  });

const postChat = (name, appId) =>
  as(name).post(`/api/apps/${appId}/chat/${randomUUID()}`).send(chatBody());

const featureOff = () => setConfig({ features: { ...FEATURES, userApps: false } });

/** The audit entries about one personal app, or about the settings. */
async function auditEntries(filter) {
  const { entries } = await queryAuditLog({ ...filter, limit: 500 });
  return entries;
}

/** Every route of this slice as one request per caller. */
const ROUTES = [
  ['GET', () => BASE, 200],
  ['GET', () => `${BASE}/_settings`, 200],
  ['PUT', () => `${BASE}/_settings`, 200, { limits: { maxAppsPerUser: 7 } }],
  ['GET', id => `${BASE}/${id}`, 200],
  ['GET', id => `${BASE}/${id}/revisions`, 200],
  ['POST', id => `${BASE}/${id}/_disable`, 200, { reason: 'Under review' }],
  ['POST', id => `${BASE}/${id}/_enable`, 200],
  ['DELETE', id => `${BASE}/${id}`, 204]
];

const call = (name, [method, url, , body], appId) => {
  const req = as(name)[method.toLowerCase()](url(appId));
  return body ? req.send(body) : req;
};

describe('who reaches the admin routes of personal apps', () => {
  const REFUSED = [
    ['a normal user', 'ben'],
    ['the owner of the app', 'anna'],
    ['a content admin', 'builder'],
    ["a full admin's personal API key", 'rootKey'],
    ['an OAuth client in the admin group', 'client'],
    ['nobody signed in', 'anonymous']
  ];

  for (const [label, name] of REFUSED) {
    it(`${label} gets 403 on every route, and nothing changes`, async () => {
      const record = await sharedApp();
      for (const entry of ROUTES) {
        const res = await call(name, entry, record.id);
        assert.equal(res.status, 403, `${entry[0]} ${entry[1](record.id)}: ${res.text}`);
        assert.equal(res.body.code, 'FORBIDDEN');
        assert.equal(res.text.includes(SECRET), false);
      }
      const after = await harness.repo().get(record.id);
      assert.equal(after.disabled, null);
      assert.equal((await storedPlatform()).userApps.limits.maxAppsPerUser, 20);
    });
  }

  for (const [label, prepare] of [
    ['with the feature on', () => {}],
    ['with the feature off', featureOff]
  ]) {
    it(`a full admin gets every route ${label}`, async () => {
      prepare();
      const record = await sharedApp();
      for (const entry of ROUTES) {
        // The settings route reloads the platform configuration from the
        // file, which holds no feature flags: the flags stay as set.
        const res = await call('root', entry, record.id);
        assert.equal(res.status, entry[2], `${entry[0]} ${entry[1](record.id)}: ${res.text}`);
      }
      assert.equal(await harness.repo().get(record.id), null);
    });
  }

  it('an ID that is not of the personal shape answers 404, as an unknown one does', async () => {
    for (const id of [ADMIN_APP, 'uap_helper', UNKNOWN_PERSONAL_ID]) {
      for (const entry of ROUTES.filter(route => route[1]('x') !== route[1]('y'))) {
        const res = await call('root', entry, id);
        assert.equal(res.status, 404, `${entry[0]} ${entry[1](id)}: ${res.text}`);
        assert.equal(res.body.code, 'NOT_FOUND');
      }
    }
  });

  it('leaves an action segment it does not have to the module that owns it', async () => {
    const res = await as('root').get(`${BASE}/_waiting`);
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.body, { items: [], nextCursor: null });
    const unknown = await as('root').get(`${BASE}/_nothing`);
    assert.equal(unknown.status, 404);
  });

  it('answers 503 while the store cannot hold personal apps; the settings still answer', async () => {
    const record = await sharedApp();
    const repo = harness.repo();
    repo.isAvailable = () => false;
    try {
      for (const entry of ROUTES) {
        const res = await call('root', entry, record.id);
        if (entry[1]('x').endsWith('/_settings')) {
          assert.equal(res.status, 200, res.text);
        } else {
          assert.equal(res.status, 503, `${entry[0]} ${entry[1](record.id)}: ${res.text}`);
          assert.equal(res.body.code, 'USER_APPS_UNAVAILABLE');
        }
      }
    } finally {
      delete repo.isAvailable;
    }
  });
});

describe('the list of personal apps', () => {
  const ITEM_KEYS = [
    'capabilities',
    'clash',
    'color',
    'disabled',
    'icon',
    'id',
    'lastUsedAt',
    'name',
    'owner',
    'pendingOwner',
    'publishedAs',
    'revision',
    'sharedWith',
    'state',
    'updatedAt'
  ];

  const list = async (query = '') => {
    const res = await as('root').get(`${BASE}${query}`);
    assert.equal(res.status, 200, res.text);
    return res.body;
  };
  const ids = body => body.items.map(item => item.id).sort();

  it('answers { items, nextCursor } with the item of section 9.2 and no instructions', async () => {
    const record = await harness.createApp('erin', {
      content: { capabilities: { upload: true, webSearch: true, skills: false, integrations: [] } },
      members: [member('ben', 'user'), member('users', 'user', 'group')]
    });
    const res = await as('root').get(BASE);
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(Object.keys(res.body).sort(), ['items', 'nextCursor']);
    assert.equal(res.body.nextCursor, null);
    assert.equal(res.body.items.length, 1);
    const [item] = res.body.items;
    assert.deepEqual(Object.keys(item).sort(), ITEM_KEYS);
    assert.equal(item.id, record.id);
    assert.equal(item.name, 'Job ad writer');
    assert.deepEqual(Object.keys(item.owner).sort(), [
      'active',
      'id',
      'name',
      'rightsCheckedAt',
      'stale'
    ]);
    assert.equal(item.owner.id, 'erin');
    assert.equal(item.owner.active, true);
    assert.equal(item.owner.stale, false);
    assert.deepEqual(item.sharedWith, { users: 1, groups: 1, everyone: false });
    assert.deepEqual(item.capabilities, ['upload', 'webSearch']);
    assert.equal(item.state, 'active');
    assert.equal(item.clash, false);
    assert.equal(res.text.includes(SECRET), false);
    assert.equal(res.text.includes('ownerPrincipal'), false);
    assert.equal(res.text.includes('erin.vogel@example.com'), false);
  });

  it('filters by owner, by text and by "shared with everyone"', async () => {
    const annas = await harness.createApp('anna');
    const bens = await harness.createApp('ben', {
      content: { name: { en: 'Meeting recap' } },
      members: [member(null, 'user', 'everyone')]
    });
    assert.deepEqual(ids(await list('?ownerId=ben')), [bens.id]);
    assert.deepEqual(ids(await list('?ownerId=nobody')), []);
    assert.deepEqual(ids(await list('?q=meeting')), [bens.id]);
    assert.deepEqual(ids(await list('?q=Schmidt')), [annas.id]);
    assert.deepEqual(ids(await list(`?q=${annas.id}`)), [annas.id]);
    assert.deepEqual(ids(await list('?everyone=true')), [bens.id]);
    assert.deepEqual(ids(await list('?everyone=false')), [annas.id]);
    assert.deepEqual(ids(await list('?everyone=true&ownerId=anna')), []);
  });

  it('filters by state and by "published and not switched on"', async () => {
    setConfig({
      apps: [...APPS, { ...APPS[0], id: COMPANY_OFF, enabled: false }]
    });
    const active = await harness.createApp('anna');
    const by = { id: 'anna', name: 'Anna Schmidt' };
    const waiting = await harness.createApp('anna', {
      change: r => ({
        ...stampedFor(COMPANY_OFF, r),
        state: 'promoted',
        publishedAs: { appId: COMPANY_OFF, at: '2026-11-19T08:00:00.000Z', by }
      })
    });
    const live = await harness.createApp('ben', {
      change: r => ({
        ...stampedFor(ADMIN_APP, r),
        state: 'promoted',
        publishedAs: { appId: ADMIN_APP, at: '2026-11-19T08:00:00.000Z', by }
      })
    });
    // Its company app was deleted: the personal app counts as active again.
    const orphan = await harness.createApp('ben', {
      change: r => ({
        ...r,
        state: 'promoted',
        publishedAs: { appId: 'gone', at: '2026-11-19T08:00:00.000Z', by }
      })
    });
    assert.deepEqual(ids(await list('?state=promoted')), [waiting.id, live.id].sort());
    // A published app says how many named members cannot use the company app; another app
    // does not carry the field.
    const { items } = await list('?limit=200');
    const itemOf = id => items.find(entry => entry.id === id);
    assert.equal(typeof itemOf(waiting.id).membersWithoutCompanyApp, 'number');
    assert.equal(typeof itemOf(live.id).membersWithoutCompanyApp, 'number');
    assert.equal('membersWithoutCompanyApp' in itemOf(active.id), false);
    assert.equal('membersWithoutCompanyApp' in itemOf(orphan.id), false);
    assert.deepEqual(ids(await list('?state=active')), [active.id, orphan.id].sort());
    assert.deepEqual(ids(await list('?waiting=true')), [waiting.id]);
    assert.equal((await list('?waiting=false')).items.length, 3);

    const item = (await list('?waiting=true')).items[0];
    assert.deepEqual(item.publishedAs, {
      appId: COMPANY_OFF,
      at: '2026-11-19T08:00:00.000Z',
      by,
      enabled: false
    });
    const liveItem = (await list(`?q=${live.id}`)).items[0];
    assert.equal(liveItem.publishedAs.enabled, true);
    const orphanItem = (await list(`?q=${orphan.id}`)).items[0];
    assert.equal(orphanItem.publishedAs, null);
  });

  it('filters by an inactive owner, by stale owner rights and by an ID clash', async () => {
    const fine = await harness.createApp('anna');
    const left = await harness.createApp('lola');
    const stale = await harness.createApp('ben', {
      change: r => ({
        ...r,
        ownerPrincipalAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString()
      })
    });
    assert.deepEqual(ids(await list('?ownerActive=false')), [left.id]);
    assert.deepEqual(ids(await list('?ownerActive=true')), [fine.id, stale.id].sort());
    assert.deepEqual(ids(await list('?ownerStale=true')), [stale.id]);
    assert.deepEqual(ids(await list('?clash=true')), []);

    // A hand-placed app file with the ID of a personal app.
    setConfig({ apps: [...APPS, { ...APPS[0], id: fine.id }] });
    const clash = await list('?clash=true');
    assert.deepEqual(ids(clash), [fine.id]);
    assert.equal(clash.items[0].clash, true);
    assert.deepEqual(ids(await list('?clash=false')), [left.id, stale.id].sort());
  });

  it('walks the store with a cursor, without a gap or a repeat', async () => {
    const created = [];
    for (let index = 0; index < 5; index += 1) created.push((await harness.createApp('anna')).id);
    const seen = [];
    let cursor = null;
    let pages = 0;
    do {
      const body = await list(`?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      assert.ok(body.items.length <= 2);
      seen.push(...body.items.map(item => item.id));
      cursor = body.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    assert.deepEqual([...seen].sort(), [...created].sort());
    assert.ok(pages >= 3, `expected at least three pages, got ${pages}`);
  });

  it('refuses an unknown parameter, a bad value and the pagination names of other APIs', async () => {
    for (const query of [
      '?owner=anna',
      '?state=retired',
      '?waiting=yes',
      '?limit=0',
      '?limit=201',
      '?page=2',
      '?offset=10'
    ]) {
      const res = await as('root').get(`${BASE}${query}`);
      assert.equal(res.status, 400, `${query}: ${res.text}`);
      assert.equal(res.body.code, 'VALIDATION_FAILED', query);
    }
  });
});

describe('reading one personal app as an admin', () => {
  const VIEW_KEYS = [
    'capabilities',
    'clash',
    'color',
    'content',
    'createdAt',
    'createdBy',
    'disabled',
    'icon',
    'id',
    'language',
    'lastUsedAt',
    'members',
    'name',
    'origin',
    'owner',
    'pendingOwner',
    'publishedAs',
    'revision',
    'sharedWith',
    'state',
    'updatedAt',
    'updatedBy'
  ];

  it('answers the admin view with an ETag, and never the owner snapshot', async () => {
    const record = await harness.createApp('erin', { members: [member('ben', 'user')] });
    const stored = await harness.repo().get(record.id);
    assert.equal(stored.ownerPrincipal.email, 'erin.vogel@example.com');

    const res = await as('root').get(`${BASE}/${record.id}`);
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(Object.keys(res.body).sort(), VIEW_KEYS);
    assert.equal(res.headers.etag, `"${stored.revision}"`);
    assert.equal(res.body.revision, stored.revision);
    assert.equal(res.body.language, 'en');
    assert.equal(res.body.origin, 'blank');
    assert.equal(res.body.content.system.en.includes(SECRET), true);
    assert.deepEqual(res.body.members, [{ type: 'user', id: 'ben', name: 'ben', role: 'user' }]);
    for (const text of [res.text, (await as('root').get(`${BASE}/${record.id}/revisions`)).text]) {
      assert.equal(text.includes('ownerPrincipal'), false);
      assert.equal(text.includes('erin.vogel@example.com'), false);
    }
  });

  it('carries what the publish module adds, and stays readable when that fails', async () => {
    const record = await sharedApp();
    registerAdminUserAppViewExtension(async ({ record: seen, user }) => ({
      takeOverPreview: { appId: seen.id, by: user.id },
      membersWithoutCompanyApp: 2,
      anythingElse: 'dropped'
    }));
    const res = await as('root').get(`${BASE}/${record.id}`);
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.body.takeOverPreview, { appId: record.id, by: 'root' });
    // The count belongs to a promoted app; this one is active.
    assert.equal('membersWithoutCompanyApp' in res.body, false);
    assert.equal('anythingElse' in res.body, false);

    registerAdminUserAppViewExtension(() => {
      throw new Error('preview failed');
    });
    const plain = await as('root').get(`${BASE}/${record.id}`);
    assert.equal(plain.status, 200, plain.text);
    assert.deepEqual(Object.keys(plain.body).sort(), VIEW_KEYS);
  });

  it('lists the earlier content states, newest first, with who saved them', async () => {
    const record = await sharedApp();
    const carol = { id: 'carol', name: 'Carol Shaw' };
    await harness
      .repo()
      .update(record.id, { ...record.content, system: { en: 'Second text.' } }, { actor: carol });
    const res = await as('root').get(`${BASE}/${record.id}/revisions`);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.nextCursor, null);
    assert.equal(res.body.items.length, 2);
    const [newest, oldest] = res.body.items;
    assert.ok(newest.revision > oldest.revision);
    assert.deepEqual(Object.keys(newest).sort(), [
      'content',
      'contentHash',
      'revision',
      'savedAt',
      'savedBy'
    ]);
    assert.equal(newest.content.system.en, 'Second text.');
    assert.deepEqual(newest.savedBy, carol);
    assert.equal(oldest.content.system.en.includes(SECRET), true);
    assert.equal(oldest.savedBy.id, 'anna');
  });

  it('audits a read by an admin who is no member, and no text of the app', async () => {
    const record = await sharedApp();
    await as('root').get(`${BASE}/${record.id}`);
    await as('root').get(`${BASE}/${record.id}/revisions`);
    const entries = (await auditEntries({ resource: 'userApp', action: 'read' })).filter(
      entry => entry.resourceId === record.id
    );
    assert.equal(entries.length, 2);
    for (const entry of entries) {
      assert.equal(entry.actor.id, 'root');
      assert.equal(entry.details.revision, record.revision);
      assert.equal(entry.details.contentHash, record.contentHash);
      assert.equal(entry.details.ownerId, 'anna');
      assert.match(entry.summary, /Job ad writer/);
      assert.match(entry.summary, /Anna Schmidt/);
      assert.equal(JSON.stringify(entry).includes(SECRET), false);
    }
    assert.deepEqual(entries.map(entry => entry.details.what).sort(), [
      'the content',
      'the earlier versions'
    ]);
    // The list holds no instructions and is not a read of an app.
    await as('root').get(BASE);
    const afterList = (await auditEntries({ resource: 'userApp', action: 'read' })).filter(
      entry => entry.resourceId === record.id
    );
    assert.equal(afterList.length, 2);
  });

  it('writes no read entry for an admin who owns the app or is a member of it', async () => {
    const own = await harness.createApp('root');
    const shared = await harness.createApp('anna', { members: [member('root', 'user')] });
    for (const record of [own, shared]) {
      assert.equal((await as('root').get(`${BASE}/${record.id}`)).status, 200);
      assert.equal((await as('root').get(`${BASE}/${record.id}/revisions`)).status, 200);
    }
    const entries = (await auditEntries({ resource: 'userApp', action: 'read' })).filter(entry =>
      [own.id, shared.id].includes(entry.resourceId)
    );
    assert.deepEqual(entries, []);
  });
});

describe('switching a personal app off and on', () => {
  it('switched off: nobody but a full admin chats, and owner and members read the reason', async () => {
    const record = await sharedApp();
    const res = await as('root')
      .post(`${BASE}/${record.id}/_disable`)
      .send({ reason: 'Under​ review' });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.id, record.id);
    assert.equal(res.body.disabled.reason, 'Under review');
    assert.deepEqual(res.body.disabled.by, { id: 'root', name: 'Ada Admin' });
    assert.ok(Date.parse(res.body.disabled.at) > 0);
    assert.equal(res.headers.etag, `"${res.body.revision}"`);
    assert.ok(res.body.revision > record.revision);

    const unknown = await postChat('anna', UNKNOWN_PERSONAL_ID);
    for (const name of ['anna', 'ben', 'carol']) {
      const chat = await postChat(name, record.id);
      assert.deepEqual(shape(chat, record.id), shape(unknown, UNKNOWN_PERSONAL_ID), name);
    }
    assert.equal(harness.turns.length, 0);
    assert.equal((await postChat('root', record.id)).status, 200);
    assert.equal(harness.turns.length, 1);

    for (const name of ['anna', 'ben']) {
      const view = await as(name).get(`/api/apps/${record.id}`);
      assert.equal(view.status, 200, view.text);
      assert.equal(view.body.disabled.reason, 'Under review');
      // Who switched it off is for admins.
      assert.equal('by' in view.body.disabled, false);
      assert.equal(view.text.includes(SECRET), false);
      assert.equal(view.body.permissions.canUse, false);
      assert.equal(view.body.permissions.canEdit, false);
      assert.equal(view.body.permissions.readOnly, true);
    }
  });

  it('switched on again: the app works as before', async () => {
    const record = await sharedApp();
    await as('root').post(`${BASE}/${record.id}/_disable`).send({});
    const res = await as('root').post(`${BASE}/${record.id}/_enable`);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.disabled, null);
    for (const name of ['anna', 'ben']) {
      assert.equal((await postChat(name, record.id)).status, 200, name);
    }
    const view = await as('anna').get(`/api/apps/${record.id}`);
    assert.equal(view.body.permissions.canEdit, true);
    assert.equal(view.body.disabled, null);
  });

  it('a second switch-off replaces the reason and keeps the moment', async () => {
    const record = await sharedApp();
    const first = await as('root').post(`${BASE}/${record.id}/_disable`).send({ reason: 'One' });
    const second = await as('root').post(`${BASE}/${record.id}/_disable`).send({ reason: 'Two' });
    assert.equal(second.status, 200, second.text);
    assert.equal(second.body.disabled.reason, 'Two');
    assert.equal(second.body.disabled.at, first.body.disabled.at);
  });

  it('switching on an app that is not switched off changes nothing', async () => {
    const record = await sharedApp();
    const res = await as('root').post(`${BASE}/${record.id}/_enable`);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.revision, record.revision);
    const entries = (await auditEntries({ resource: 'userApp', action: 'toggle' })).filter(
      entry => entry.resourceId === record.id
    );
    assert.deepEqual(entries, []);
  });

  it('refuses a body with an unknown key or a reason that is too long', async () => {
    const record = await sharedApp();
    for (const body of [{ note: 'x' }, { reason: 'x'.repeat(501) }, { reason: 7 }]) {
      const res = await as('root').post(`${BASE}/${record.id}/_disable`).send(body);
      assert.equal(res.status, 400, res.text);
      assert.equal(res.body.code, 'VALIDATION_FAILED');
    }
    assert.equal((await harness.repo().get(record.id)).disabled, null);
  });

  it('audits both switches with the reason, the revision and the content hash', async () => {
    const record = await sharedApp();
    await as('root').post(`${BASE}/${record.id}/_disable`).send({ reason: 'Under review' });
    await as('root').post(`${BASE}/${record.id}/_enable`);
    const entries = (await auditEntries({ resource: 'userApp', action: 'toggle' })).filter(
      entry => entry.resourceId === record.id
    );
    assert.equal(entries.length, 2);
    const off = entries.find(entry => entry.details.disabled === true);
    const on = entries.find(entry => entry.details.disabled === false);
    assert.match(off.summary, /Switched off personal app "Job ad writer".*Under review/);
    assert.equal(off.details.reason, 'Under review');
    assert.match(on.summary, /Switched on personal app "Job ad writer"/);
    for (const entry of [off, on]) {
      assert.equal(entry.actor.id, 'root');
      assert.equal(entry.details.contentHash, record.contentHash);
      assert.equal(typeof entry.details.revision, 'number');
      assert.equal(JSON.stringify(entry).includes(SECRET), false);
    }
    assert.ok(on.details.revision > off.details.revision);
  });
});

describe('deleting a personal app as an admin', () => {
  it('removes the record and its markers and keeps the newest content state', async () => {
    const record = await sharedApp();
    assert.equal((await harness.repo().listSharedWith(['user:ben'])).length, 1);
    const res = await as('root').delete(`${BASE}/${record.id}`);
    assert.equal(res.status, 204, res.text);
    assert.equal(res.text, '');
    assert.equal(await harness.repo().get(record.id), null);
    assert.deepEqual(await harness.repo().listSharedWith(['user:ben']), []);
    const kept = (await harness.repo().listDeletedStates('anna')).filter(
      state => state.appId === record.id
    );
    assert.equal(kept.length, 1);
    assert.ok(kept[0].deletedAt);
    assert.equal((await as('root').get(`${BASE}/${record.id}`)).status, 404);
    assert.equal((await as('root').delete(`${BASE}/${record.id}`)).status, 404);

    const unknown = await postChat('anna', UNKNOWN_PERSONAL_ID);
    assert.deepEqual(
      shape(await postChat('anna', record.id), record.id),
      shape(unknown, UNKNOWN_PERSONAL_ID)
    );

    const [entry] = (await auditEntries({ resource: 'userApp', action: 'delete' })).filter(
      candidate => candidate.resourceId === record.id
    );
    assert.ok(entry, 'a delete entry');
    assert.match(entry.summary, /Job ad writer/);
    assert.match(entry.summary, /Anna Schmidt/);
    assert.equal(entry.details.ownerId, 'anna');
    assert.equal(entry.details.contentHash, record.contentHash);
    assert.equal(entry.details.revision, record.revision);
    assert.equal(JSON.stringify(entry).includes(SECRET), false);
  });
});

describe('the settings of personal apps', () => {
  it('reads the effective block, every key present', async () => {
    const res = await as('root').get(`${BASE}/_settings`);
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.body, USER_APP_SETTINGS);
  });

  it('reads the defaults when the block is not stored', async () => {
    setConfig();
    configCache.setCacheEntry('config/platform.json', { ...PLATFORM, userApps: undefined });
    const res = await as('root').get(`${BASE}/_settings`);
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.body, {
      limits: { maxAppsPerUser: 20, maxOpenOffersPerUser: 5, ownerSnapshotMaxAgeDays: 30 },
      sharing: { allowUsers: true, allowGroups: true, allowEveryone: false, allowPublish: false },
      capabilities: {
        modelChoice: true,
        upload: true,
        webSearch: false,
        skills: false,
        integrations: []
      },
      publishing: { adminEnables: 'withTools' },
      blockedOwners: []
    });
  });

  it('writes only the keys sent, keeps the rest of the file and applies at once', async () => {
    const res = await as('root')
      .put(`${BASE}/_settings`)
      .send({ sharing: { allowPublish: false }, limits: { maxAppsPerUser: 3 } });
    assert.equal(res.status, 200, res.text);
    const expected = {
      ...USER_APP_SETTINGS,
      sharing: { ...USER_APP_SETTINGS.sharing, allowPublish: false },
      limits: { ...USER_APP_SETTINGS.limits, maxAppsPerUser: 3 }
    };
    assert.deepEqual(res.body, expected);
    const stored = await storedPlatform();
    assert.deepEqual(stored.userApps, expected);
    assert.equal(stored.marker, 'kept');
    assert.equal(stored.defaultLanguage, 'en');
    // Without a restart: the next request reads the new values.
    assert.deepEqual(currentUserAppSettings(), expected);
    assert.deepEqual((await as('root').get(`${BASE}/_settings`)).body, expected);
  });

  it('writes a block that was not stored before with the sent keys only', async () => {
    const { userApps: _block, ...withoutBlock } = PLATFORM;
    await storePlatform(withoutBlock);
    const res = await as('root')
      .put(`${BASE}/_settings`)
      .send({ capabilities: { webSearch: true } });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual((await storedPlatform()).userApps, { capabilities: { webSearch: true } });
    assert.equal(res.body.capabilities.webSearch, true);
    assert.equal(res.body.capabilities.upload, true);
    assert.equal(res.body.sharing.allowPublish, false);
  });

  it('replaces the list of installations as a whole', async () => {
    const jira = { id: 'jira-main', actions: ['searchIssues', 'getIssue'] };
    const res = await as('root')
      .put(`${BASE}/_settings`)
      .send({ capabilities: { integrations: [jira] } });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.body.capabilities.integrations, [jira]);
    assert.equal(res.body.capabilities.upload, true);
    const cleared = await as('root')
      .put(`${BASE}/_settings`)
      .send({ capabilities: { integrations: [] } });
    assert.deepEqual(cleared.body.capabilities.integrations, []);
  });

  it('refuses the installation ihub, an installation without actions and an unknown key', async () => {
    const before = await storedPlatform();
    for (const body of [
      { capabilities: { integrations: [{ id: 'ihub', actions: ['ask_user'] }] } },
      { capabilities: { integrations: [{ id: 'jira-main' }] } },
      { capabilities: { integrations: [{ id: 'jira-main', actions: [] }] } },
      { capabilities: { tools: true } },
      { sharing: { allowCatalog: true } },
      { limits: { maxAppsPerUser: -1 } },
      { publishing: { adminEnables: 'never' } },
      { retentionDays: 30 },
      { blockedOwners: 'anna' }
    ]) {
      const res = await as('root').put(`${BASE}/_settings`).send(body);
      assert.equal(res.status, 400, `${JSON.stringify(body)}: ${res.text}`);
      assert.equal(res.body.code, 'VALIDATION_FAILED');
    }
    assert.deepEqual(await storedPlatform(), before);
  });

  it('audits a change on platform with the resource ID user-apps and the changed keys', async () => {
    const marker = `owner-${randomUUID().slice(0, 8)}`;
    await as('root')
      .put(`${BASE}/_settings`)
      .send({ sharing: { allowEveryone: false }, blockedOwners: [marker, 'anna'] });
    await as('root')
      .put(`${BASE}/_settings`)
      .send({ blockedOwners: ['anna'] });
    const entries = (await auditEntries({ resource: 'platform', action: 'update' })).filter(
      entry =>
        entry.resourceId === 'user-apps' &&
        [...entry.details.blockedOwners.added, ...entry.details.blockedOwners.removed].includes(
          marker
        )
    );
    assert.equal(entries.length, 2);
    const blocked = entries.find(entry => entry.details.blockedOwners.added.includes(marker));
    const unblocked = entries.find(entry => entry.details.blockedOwners.removed.includes(marker));
    assert.equal(blocked.actor.id, 'root');
    assert.deepEqual(blocked.details.keys, ['sharing.allowEveryone', 'blockedOwners']);
    assert.deepEqual(blocked.details.blockedOwners, { added: [marker, 'anna'], removed: [] });
    assert.match(blocked.summary, /sharing\.allowEveryone, blockedOwners/);
    assert.match(blocked.summary, new RegExp(`switched off the apps of ${marker}, anna`));
    assert.deepEqual(unblocked.details.keys, ['blockedOwners']);
    assert.deepEqual(unblocked.details.blockedOwners, { added: [], removed: [marker] });
  });
});

describe('switching off all apps of one person', () => {
  const block = ids => as('root').put(`${BASE}/_settings`).send({ blockedOwners: ids });

  it('the person cannot create, and their apps answer 404 on the chat route for everyone', async () => {
    const record = await sharedApp();
    const other = await harness.createApp('ben', { members: [member('anna', 'user')] });
    assert.equal(mayCreateUserApps(harness.user('anna'), currentUserAppSettings()), true);

    const res = await block(['anna']);
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.body.blockedOwners, ['anna']);
    assert.equal(mayCreateUserApps(harness.user('anna'), currentUserAppSettings()), false);
    assert.equal(mayCreateUserApps(harness.user('ben'), currentUserAppSettings()), true);

    const unknown = await postChat('anna', UNKNOWN_PERSONAL_ID);
    for (const name of ['anna', 'ben', 'carol', 'root']) {
      const chat = await postChat(name, record.id);
      assert.deepEqual(shape(chat, record.id), shape(unknown, UNKNOWN_PERSONAL_ID), name);
    }
    assert.equal(harness.turns.length, 0);
    // An app of someone else that is shared with the person still works for them.
    assert.equal((await postChat('anna', other.id)).status, 200);

    // The admin list still shows the apps, so the admin can act on them.
    const list = await as('root').get(`${BASE}?ownerId=anna`);
    assert.deepEqual(
      list.body.items.map(item => item.id),
      [record.id]
    );
  });

  it('a full admin still reads and deletes an app of a blocked owner', async () => {
    const record = await sharedApp();
    await block(['anna']);
    const view = await as('root').get(`${BASE}/${record.id}`);
    assert.equal(view.status, 200, view.text);
    const removed = await as('root').delete(`${BASE}/${record.id}`);
    assert.equal(removed.status, 204, removed.text);
    assert.equal(await harness.repo().get(record.id), null);
  });

  it('is reversible', async () => {
    const record = await sharedApp();
    await block(['anna']);
    assert.equal((await block([])).status, 200);
    assert.equal(mayCreateUserApps(harness.user('anna'), currentUserAppSettings()), true);
    for (const name of ['anna', 'ben']) {
      assert.equal((await postChat(name, record.id)).status, 200, name);
    }
  });
});

describe('what the content of a personal app looks like to an admin', () => {
  it('is the stored content, not a copy the response could change', async () => {
    const record = await harness.createApp('anna', {
      content: plainContent({ description: { en: 'Short' } })
    });
    const res = await as('root').get(`${BASE}/${record.id}`);
    assert.deepEqual(res.body.content, record.content);
  });
});
