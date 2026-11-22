// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * How an app is resolved for the interactive chat when it may be a personal
 * app (feature `userApps`, design section 7), and what `GET /api/apps` and
 * `GET /api/apps/{appId}` answer about personal apps (design 9.1).
 *
 * The real resolver, repository, access rules and ceiling run over a
 * populated config cache and a filesystem store in a scratch directory.
 * Principals are built by the real `enhanceUserWithPermissions`.
 *
 * Run: node --test server/tests/user-apps-resolve.test.js
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import configCache from '../configCache.js';
import logger from '../utils/logger.js';
import {
  USER_APP_SCOPES,
  isUnresolvedUserAppId,
  listUserAppsFor,
  resolveAppForChat
} from '../services/userApps/resolveApp.js';
import {
  inspectUserApp,
  isConfigAppId,
  registerUserAppViewExtension,
  userAppCatalog,
  userAppResponse
} from '../services/userApps/userAppResolution.js';
import { MAX_SHARED_LISTED } from '../services/userApps/UserAppRepository.js';
import { USER_APP_RUN_KEYS } from '../../shared/userAppContent.js';
import {
  ADMIN_APP,
  APPS,
  FEATURES,
  SECRET,
  STAFF_APP,
  UNKNOWN_PERSONAL_ID,
  groupsWith,
  member,
  plainContent,
  setConfig,
  shape,
  startUserAppsHarness
} from './helpers/userAppsHarness.js';

const DAY = 24 * 60 * 60 * 1000;

let harness;
let user;
let as;

before(async () => {
  harness = await startUserAppsHarness();
  ({ user, as } = harness);
});
after(() => harness.stop());
beforeEach(() => harness.reset());

/** An app of Anna, shared with Ben ("Can use") and Carol ("Can edit"). */
const sharedApp = (options = {}) =>
  harness.createApp('anna', {
    members: [member('ben', 'user'), member('carol', 'editor')],
    ...options
  });

/** Mark a stored app as published as `appId`. */
const promote = (record, appId) =>
  harness.repo().mutate(
    record.id,
    current => ({
      ...current,
      state: 'promoted',
      publishedAs: { appId, at: new Date().toISOString(), by: { id: 'anna', name: 'Anna' } }
    }),
    { bumpRevision: false }
  );

describe('resolveAppForChat: an ID that is no personal app', () => {
  it('answers what getAppForRequest answers, and leaves the group check to the caller', async () => {
    const resolved = await resolveAppForChat(ADMIN_APP, user('ben'));
    assert.equal(resolved.app, configCache.getAppForRequest(ADMIN_APP, user('ben')));
    assert.equal(resolved.userApp, null);
    assert.equal(await resolveAppForChat('no-such-app', user('ben')), null);
    // An ID that only starts like a personal one is an ordinary ID.
    setConfig({ apps: [...APPS, { ...APPS[0], id: 'uap_helper' }] });
    assert.equal((await resolveAppForChat('uap_helper', user('ben'))).app.id, 'uap_helper');
  });

  it('an unpublished admin app still goes to a content admin only', async () => {
    setConfig({ apps: [...APPS, { ...APPS[0], id: 'draft', enabled: false }] });
    assert.equal((await resolveAppForChat('draft', user('builder'))).app.id, 'draft');
    assert.equal(await resolveAppForChat('draft', user('ben')), null);
  });
});

describe('resolveAppForChat: who gets a personal app', () => {
  it('the owner, each kind of member and a full admin get it; nobody else does', async () => {
    const record = await sharedApp();
    for (const [name, role] of [
      ['anna', 'owner'],
      ['ben', 'user'],
      ['carol', 'editor'],
      ['root', 'admin']
    ]) {
      const resolved = await resolveAppForChat(record.id, user(name));
      assert.equal(resolved?.app.id, record.id, name);
      assert.equal(resolved.userApp.permissions.role, role, name);
      assert.equal(resolved.userApp.record.id, record.id, name);
      assert.ok(Array.isArray(resolved.userApp.capabilities), name);
    }
    for (const name of ['mallory', 'builder', 'anonymous']) {
      assert.equal(await resolveAppForChat(record.id, user(name)), null, name);
    }
  });

  it('each principal that cannot hold personal apps gets null, whatever its groups', async () => {
    const record = await harness.createApp('anna', {
      members: [member('ben', 'user'), member(null, 'user', 'everyone')]
    });
    for (const name of ['anonymous', 'client', 'agent', 'benDelegated']) {
      assert.equal(await resolveAppForChat(record.id, user(name)), null, name);
    }
  });

  it('a personal API key runs its user’s own app and gets null for a shared one', async () => {
    const own = await harness.createApp('anna');
    const shared = await harness.createApp('anna', { members: [member('ben', 'user')] });
    const viaKey = await resolveAppForChat(own.id, user('annaKey'));
    assert.equal(viaKey.app.id, own.id);
    assert.equal(viaKey.userApp.permissions.role, 'owner');
    assert.equal((await resolveAppForChat(shared.id, user('ben'))).app.id, shared.id);
    assert.equal(await resolveAppForChat(shared.id, user('benKey')), null);
    // A key of an admin is no admin.
    assert.equal(await resolveAppForChat(own.id, user('rootKey')), null);
  });

  it('the group permission `apps` is not consulted', async () => {
    const record = await sharedApp();
    setConfig({ groups: groupsWith({ wildcard: false }) });
    assert.equal(user('ben').permissions.apps.has('*'), false);
    assert.equal((await resolveAppForChat(record.id, user('ben'))).app.id, record.id);
    assert.equal(await resolveAppForChat(record.id, user('mallory')), null);
  });

  it('an unknown ID of the personal shape is null', async () => {
    assert.equal(await resolveAppForChat(UNKNOWN_PERSONAL_ID, user('anna')), null);
    assert.equal(await resolveAppForChat(UNKNOWN_PERSONAL_ID, user('root')), null);
    assert.equal(isUnresolvedUserAppId(UNKNOWN_PERSONAL_ID, null), true);
    assert.equal(isUnresolvedUserAppId('no-such-app', null), false);
  });

  it('the feature off: null for everyone, the owner and a full admin included', async () => {
    const record = await sharedApp();
    setConfig({ features: { ...FEATURES, userApps: false } });
    for (const name of ['anna', 'ben', 'carol', 'root']) {
      assert.equal(await resolveAppForChat(record.id, user(name)), null, name);
    }
  });

  it('the store unavailable: null', async () => {
    const record = await sharedApp();
    const repository = { isAvailable: () => false };
    assert.equal(await resolveAppForChat(record.id, user('anna'), { repository }), null);
    const failing = {
      isAvailable: () => true,
      get: async () => {
        throw new Error('disk gone');
      }
    };
    assert.equal(await resolveAppForChat(record.id, user('anna'), { repository: failing }), null);
  });

  it('the app object is the run object of the ceiling, never the record', async () => {
    const record = await sharedApp();
    const { app } = await resolveAppForChat(record.id, user('ben'));
    for (const key of Object.keys(app)) assert.ok(USER_APP_RUN_KEYS.includes(key), key);
    assert.equal(app.type, 'chat');
    assert.deepEqual(app.features, { projects: false, userProjects: false });
    assert.deepEqual(app.toolApproval, { default: 'always' });
    assert.equal(JSON.stringify(app).includes('ownerPrincipal'), false);
  });

  it('is memoised on the request: one read of the store per request and ID', async () => {
    const record = await sharedApp();
    const real = harness.repo();
    let reads = 0;
    const repository = {
      isAvailable: () => true,
      get: async id => {
        reads += 1;
        return real.get(id);
      },
      refreshOwnerPrincipal: async () => 0
    };
    const req = {};
    const first = await resolveAppForChat(record.id, user('ben'), { req, repository });
    const second = await resolveAppForChat(record.id, user('ben'), { req, repository });
    assert.equal(reads, 1);
    assert.equal(first.app, second.app);
    await resolveAppForChat(record.id, user('ben'), { req: {}, repository });
    assert.equal(reads, 2);
  });
});

describe('resolveAppForChat: an app the caller may see but not use', () => {
  it('switched off: only a full admin chats', async () => {
    const record = await sharedApp({
      change: current => ({
        ...current,
        disabled: { at: new Date().toISOString(), by: { id: 'root' }, reason: 'Check first' }
      })
    });
    for (const name of ['anna', 'ben', 'carol']) {
      assert.equal(await resolveAppForChat(record.id, user(name)), null, name);
      assert.equal((await inspectUserApp(record.id, user(name))).status, 'ok', name);
    }
    assert.equal((await resolveAppForChat(record.id, user('root'))).app.id, record.id);
  });

  it('a blocked owner: nobody chats, the owner and a full admin included', async () => {
    const record = await sharedApp();
    setConfig({ userApps: { blockedOwners: ['anna'] } });
    for (const name of ['anna', 'ben', 'carol', 'root']) {
      assert.equal(await resolveAppForChat(record.id, user(name)), null, name);
    }
  });

  it('an owner who lost `userAppSharing`: members cannot chat, the owner can', async () => {
    const record = await sharedApp();
    harness.addPerson('anna', {
      id: 'anna',
      name: 'Anna Schmidt',
      authMode: 'oidc',
      groups: ['guests']
    });
    try {
      // The owner's next request rewrites the snapshot with the new groups.
      assert.equal((await resolveAppForChat(record.id, user('anna'))).app.id, record.id);
      const stored = await harness.repo().get(record.id);
      assert.deepEqual(stored.ownerPrincipal.groups, user('anna').groups);
      for (const name of ['ben', 'carol']) {
        assert.equal(await resolveAppForChat(record.id, user(name)), null, name);
        const state = await inspectUserApp(record.id, user(name));
        assert.equal(state.permissions.suspended, 'ownerMayNotShare', name);
      }
    } finally {
      harness.addPerson('anna', {
        id: 'anna',
        name: 'Anna Schmidt',
        authMode: 'oidc',
        groups: ['users']
      });
    }
  });
});

describe('resolveAppForChat: retired is decided per caller', () => {
  const noWildcard = () => setConfig({ groups: groupsWith({ wildcard: false }) });

  it('a member whose groups grant the company app gets null, one whose groups do not gets the app', async () => {
    const record = await harness.createApp('anna', {
      members: [member('ben', 'user'), member('sam', 'user')]
    });
    await promote(record, STAFF_APP);
    noWildcard();
    assert.equal(await resolveAppForChat(record.id, user('sam')), null, 'granted: retired');
    const forBen = await resolveAppForChat(record.id, user('ben'));
    assert.equal(forBen.app.id, record.id, 'not granted: the personal app keeps working');
    assert.equal(forBen.userApp.permissions.readOnly, true);
    // The owner's groups do not grant the company app either.
    assert.equal((await resolveAppForChat(record.id, user('anna'))).app.id, record.id);
  });

  it('with the wildcard everyone who may use the company app is sent there', async () => {
    const record = await sharedApp();
    await promote(record, STAFF_APP);
    for (const name of ['anna', 'ben', 'carol']) {
      assert.equal(await resolveAppForChat(record.id, user(name)), null, name);
      assert.equal((await inspectUserApp(record.id, user(name))).retired, true, name);
    }
  });

  it('while the company app is not switched on, the personal app works for everyone', async () => {
    const record = await sharedApp();
    await promote(record, STAFF_APP);
    setConfig({ apps: [APPS[0], { ...APPS[1], enabled: false }] });
    for (const name of ['anna', 'ben', 'carol']) {
      const resolved = await resolveAppForChat(record.id, user(name));
      assert.equal(resolved?.app.id, record.id, name);
      assert.equal(resolved.userApp.permissions.canEdit, false, name);
    }
  });

  it('a promoted app whose company app was deleted resolves as active', async () => {
    const record = await sharedApp();
    await promote(record, 'app-that-was-deleted');
    const resolved = await resolveAppForChat(record.id, user('anna'));
    assert.equal(resolved.app.id, record.id);
    assert.equal(resolved.userApp.permissions.canEdit, true);
    assert.equal(resolved.userApp.permissions.readOnly, false);
  });
});

describe('a config app with an ID of the personal shape', () => {
  it('without a personal record of that ID it is an ordinary admin app', async () => {
    setConfig({ apps: [...APPS, { ...APPS[0], id: UNKNOWN_PERSONAL_ID }] });
    assert.equal(isConfigAppId(UNKNOWN_PERSONAL_ID), true);
    const resolved = await resolveAppForChat(UNKNOWN_PERSONAL_ID, user('mallory'));
    assert.equal(resolved.app.id, UNKNOWN_PERSONAL_ID);
    assert.equal(resolved.userApp, null);
    const res = await as('mallory').get(`/api/apps/${UNKNOWN_PERSONAL_ID}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.ownership, undefined);
  });

  it('with a personal record of the same ID both answer null, and an error is logged', async t => {
    const record = await sharedApp();
    setConfig({ apps: [...APPS, { ...APPS[0], id: record.id }] });
    const errors = [];
    const original = logger.error;
    logger.error = (message, meta) => errors.push({ message, meta });
    t.after(() => {
      logger.error = original;
    });
    for (const name of ['anna', 'ben', 'mallory', 'root']) {
      assert.equal(await resolveAppForChat(record.id, user(name)), null, name);
    }
    assert.ok(errors.some(entry => entry.meta?.appId === record.id));

    const unknown = await as('anna').get(`/api/apps/${UNKNOWN_PERSONAL_ID}`);
    for (const name of ['anna', 'ben', 'root']) {
      const read = await as(name).get(`/api/apps/${record.id}`);
      assert.equal(read.status, 404, name);
      assert.deepEqual(shape(read, record.id), shape(unknown, UNKNOWN_PERSONAL_ID), name);
      const chat = await as(name)
        .post(`/api/apps/${record.id}/chat/${crypto.randomUUID()}`)
        .send({
          messages: [{ role: 'user', content: 'hello', messageId: 'm1' }]
        });
      assert.equal(chat.status, 404, name);
    }
    assert.equal(harness.turns.length, 0);
  });
});

describe('the owner snapshot (6.2)', () => {
  it('a request of the owner with changed groups rewrites the snapshot of all their apps', async () => {
    const first = await harness.createApp('anna');
    const second = await harness.createApp('anna');
    harness.addPerson('anna', {
      id: 'anna',
      name: 'Anna Schmidt',
      authMode: 'oidc',
      groups: ['users', 'staff']
    });
    try {
      const before = await harness.repo().get(second.id);
      assert.deepEqual(before.ownerPrincipal.groups.includes('staff'), false);
      await resolveAppForChat(first.id, user('anna'));
      for (const id of [first.id, second.id]) {
        const stored = await harness.repo().get(id);
        assert.ok(stored.ownerPrincipal.groups.includes('staff'), id);
        assert.equal(stored.revision, 1, 'the revision does not change');
      }
    } finally {
      harness.addPerson('anna', {
        id: 'anna',
        name: 'Anna Schmidt',
        authMode: 'oidc',
        groups: ['users']
      });
    }
  });

  it('a request of a member rewrites nothing', async () => {
    const record = await sharedApp();
    const before = await harness.repo().get(record.id);
    await resolveAppForChat(record.id, user('ben'));
    const after = await harness.repo().get(record.id);
    assert.equal(after.ownerPrincipalAt, before.ownerPrincipalAt);
  });

  it('an identity-provider owner with a snapshot older than 30 days: plain chat for members', async () => {
    const record = await sharedApp({
      content: {
        preferredModel: 'oa',
        capabilities: { upload: true, webSearch: false, skills: false, integrations: [] }
      },
      change: current => ({
        ...current,
        ownerPrincipalAt: new Date(Date.now() - 31 * DAY).toISOString()
      })
    });
    const forBen = await resolveAppForChat(record.id, user('ben'));
    assert.equal(forBen.app.id, record.id, 'the shares still open the app');
    assert.equal(forBen.app.upload.enabled, false);
    assert.equal(forBen.app.preferredModel, undefined);
    assert.deepEqual(
      forBen.userApp.capabilities.filter(entry => entry.requested).map(entry => entry.reason),
      ['ownerStale', 'ownerStale']
    );

    // The owner's own request is never stale, and it cures the app.
    const forAnna = await resolveAppForChat(record.id, user('anna'));
    assert.equal(forAnna.app.upload.enabled, true);
    assert.equal(forAnna.app.preferredModel, 'oa');
    const cured = await resolveAppForChat(record.id, user('ben'));
    assert.equal(cured.app.upload.enabled, true);
    assert.equal(cured.app.preferredModel, 'oa');
  });

  it('an owner whose snapshot grants less: the ceiling follows the owner for members', async () => {
    const record = await sharedApp({ content: { preferredModel: 'oa' } });
    // The stored snapshot now says: a group that may use only another model.
    await harness.repo().mutate(
      record.id,
      current => ({
        ...current,
        ownerPrincipal: { ...current.ownerPrincipal, groups: ['narrow'] }
      }),
      { bumpRevision: false }
    );
    const forBen = await resolveAppForChat(record.id, user('ben'));
    assert.equal(forBen.app.preferredModel, undefined);
    assert.equal(
      forBen.userApp.capabilities.find(entry => entry.id === 'model').reason,
      'ownerMayNot'
    );
  });
});

describe('the ceiling on a request', () => {
  it('a member who may not use the model gets the app without it', async () => {
    const record = await harness.createApp('anna', {
      content: { preferredModel: 'oa' },
      members: [member('nora', 'user'), member('ben', 'user')]
    });
    assert.equal((await resolveAppForChat(record.id, user('ben'))).app.preferredModel, 'oa');
    const forNora = await resolveAppForChat(record.id, user('nora'));
    assert.equal(forNora.app.preferredModel, undefined);
    assert.equal(
      forNora.userApp.capabilities.find(entry => entry.id === 'model').reason,
      'youMayNot'
    );
  });

  it('a capability the admin switched off after the save is withheld on the next request', async () => {
    const record = await sharedApp({
      content: { capabilities: { upload: true, webSearch: false, skills: false, integrations: [] } }
    });
    assert.equal((await resolveAppForChat(record.id, user('anna'))).app.upload.enabled, true);
    setConfig({ userApps: { capabilities: { upload: false } } });
    assert.equal((await resolveAppForChat(record.id, user('anna'))).app.upload.enabled, false);
  });

  it('approval: the owner may allow a tool for the chat, nobody else', async () => {
    const record = await sharedApp();
    assert.deepEqual((await resolveAppForChat(record.id, user('anna'))).userApp.approval, {
      mode: 'writes',
      chatGrants: true
    });
    for (const name of ['ben', 'carol', 'root']) {
      assert.deepEqual(
        (await resolveAppForChat(record.id, user(name))).userApp.approval,
        { mode: 'always', chatGrants: false },
        name
      );
    }
  });

  it('userAppCatalog reads models, installations and features from the configuration', async () => {
    const catalog = await userAppCatalog({ owner: user('anna'), runner: user('ben') });
    assert.deepEqual(catalog.models.map(model => model.id).sort(), ['oa', 'restricted']);
    assert.deepEqual(catalog.installations, []);
    assert.equal(catalog.features.integrations, true);
    assert.deepEqual(catalog.webSearch, { owner: false, runner: false });
  });
});

describe('GET /api/apps/{appId} for a personal app', () => {
  it('answers the app with who owns it and what the caller may do, and an ETag', async () => {
    const record = await sharedApp();
    const res = await as('ben').get(`/api/apps/${record.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.etag, '"2"');
    assert.equal(res.body.id, record.id);
    assert.equal(res.body.ownership, 'user');
    assert.deepEqual(res.body.owner, { id: 'anna', name: 'Anna Schmidt', active: true });
    assert.equal(res.body.permissions.role, 'user');
    assert.equal(res.body.permissions.canUse, true);
    assert.ok(res.body.system.en.includes(SECRET), 'a member can read the instructions');
    assert.deepEqual(res.body.approval, { mode: 'always', chatGrants: false });
    assert.deepEqual(res.body.sharedWith, { users: 2, groups: 0, everyone: false });
    // What a person with "Can use" is not told.
    assert.equal(res.body.members, undefined);
    assert.equal(res.body.pendingOwner, undefined);
    assert.equal(res.text.includes('ownerPrincipal'), false);
    assert.equal(res.text.includes('contentHash'), false);

    const owner = await as('anna').get(`/api/apps/${record.id}`);
    assert.equal(owner.body.permissions.role, 'owner');
    assert.equal(owner.body.members.length, 2);
    assert.deepEqual(owner.body.approval, { mode: 'writes', chatGrants: true });
  });

  it('unknown and forbidden are one 404, with and without the wildcard', async () => {
    const record = await sharedApp();
    for (const wildcard of [true, false]) {
      setConfig({ groups: groupsWith({ wildcard }) });
      const unknown = await as('mallory').get(`/api/apps/${UNKNOWN_PERSONAL_ID}`);
      assert.equal(unknown.status, 404);
      for (const name of ['mallory', 'builder', 'benKey', 'client', 'agent', 'anonymous']) {
        const res = await as(name).get(`/api/apps/${record.id}`);
        assert.deepEqual(shape(res, record.id), shape(unknown, UNKNOWN_PERSONAL_ID), name);
        assert.equal(res.text.includes(SECRET), false, name);
      }
      // The same 404 an unknown admin app gets.
      const unknownAdmin = await as('mallory').get('/api/apps/no-such-app');
      assert.deepEqual(shape(unknown, UNKNOWN_PERSONAL_ID), shape(unknownAdmin, 'no-such-app'));
    }
  });

  it('with the feature off it answers the 404 of an unknown ID, for the owner too', async () => {
    const record = await sharedApp();
    setConfig({ features: { ...FEATURES, userApps: false } });
    const unknown = await as('anna').get(`/api/apps/${UNKNOWN_PERSONAL_ID}`);
    for (const name of ['anna', 'ben', 'root']) {
      const res = await as(name).get(`/api/apps/${record.id}`);
      assert.deepEqual(shape(res, record.id), shape(unknown, UNKNOWN_PERSONAL_ID), name);
    }
  });

  it('a switched-off app: the reduced body, without instructions and capabilities', async () => {
    const record = await sharedApp({
      change: current => ({
        ...current,
        disabled: { at: '2026-11-20T10:00:00.000Z', by: { id: 'root' }, reason: 'Check first' }
      })
    });
    for (const name of ['anna', 'ben']) {
      const res = await as(name).get(`/api/apps/${record.id}`);
      assert.equal(res.status, 200, name);
      assert.deepEqual(
        Object.keys(res.body).sort(),
        ['color', 'disabled', 'icon', 'id', 'name', 'owner', 'ownership', 'permissions', 'state'],
        name
      );
      assert.equal(res.body.permissions.canUse, false, name);
      assert.deepEqual(res.body.disabled, {
        at: '2026-11-20T10:00:00.000Z',
        reason: 'Check first'
      });
      assert.equal(res.text.includes(SECRET), false, name);
    }
  });

  it('shares of a blocked owner: the reduced body with the reason', async () => {
    const record = await sharedApp();
    setConfig({ userApps: { blockedOwners: ['anna'] } });
    const res = await as('ben').get(`/api/apps/${record.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.permissions.suspended, 'ownerBlocked');
    assert.equal(res.body.system, undefined);
  });

  it('retired for the caller: the pointer to the company app, and nothing of the personal app', async () => {
    const record = await sharedApp();
    await harness.repo().mutate(
      record.id,
      current => ({
        ...current,
        state: 'promoted',
        publishedAs: { appId: ADMIN_APP, at: new Date().toISOString(), by: { id: 'anna' } }
      }),
      { bumpRevision: false }
    );
    const res = await as('ben').get(`/api/apps/${record.id}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      id: record.id,
      ownership: 'user',
      state: 'retired',
      publishedAs: { appId: ADMIN_APP, name: { en: ADMIN_APP }, enabled: true }
    });
  });

  it('the view extension adds `publish` for the owner only', async t => {
    const record = await sharedApp();
    registerUserAppViewExtension(({ permissions }) =>
      permissions.isOwner ? { publish: { startsEnabled: true } } : { publish: { leaked: true } }
    );
    t.after(() => registerUserAppViewExtension(null));
    assert.deepEqual((await as('anna').get(`/api/apps/${record.id}`)).body.publish, {
      startsEnabled: true
    });
    assert.equal((await as('ben').get(`/api/apps/${record.id}`)).body.publish, undefined);
  });
});

describe('GET /api/apps and its `scope`', () => {
  it('without `scope`: the same bytes and ETag with and without personal apps in the store', async () => {
    const before = await as('ben').get('/api/apps');
    await sharedApp();
    await harness.createApp('ben');
    const after = await as('ben').get('/api/apps');
    assert.equal(after.status, 200);
    assert.equal(after.text, before.text);
    assert.equal(after.headers.etag, before.headers.etag);
    assert.ok(after.headers.etag);
    assert.equal(after.text.includes('uap_'), false);
    assert.equal(Object.hasOwn(after.body, 'nextCursor'), false);

    // And with the feature off.
    setConfig({ features: { ...FEATURES, userApps: false } });
    const off = await as('ben').get('/api/apps');
    assert.equal(off.text, before.text);
    assert.equal(off.headers.etag, before.headers.etag);
  });

  it('`mine`, `shared` and `personal` return the right apps', async () => {
    const annas = await sharedApp();
    const bens = await harness.createApp('ben');
    const offered = await harness.createApp('anna');
    await harness
      .repo()
      .setOffer(
        offered.id,
        { id: 'ben', name: 'Ben Koch' },
        { actor: { id: 'anna', name: 'Anna Schmidt' } }
      );

    const list = async (name, scope) => {
      const res = await as(name).get('/api/apps').query({ scope });
      assert.equal(res.status, 200, `${name} ${scope}`);
      assert.equal(res.body.nextCursor, null);
      return res.body.items;
    };

    const mine = await list('ben', 'mine');
    assert.deepEqual(mine.map(item => item.id).sort(), [bens.id, offered.id].sort());
    assert.equal(mine.find(item => item.id === offered.id).permissions.role, 'offered');
    assert.equal(mine.find(item => item.id === bens.id).permissions.role, 'owner');

    const shared = await list('ben', 'shared');
    assert.deepEqual(
      shared.map(item => item.id),
      [annas.id]
    );
    assert.equal(shared[0].permissions.role, 'user');
    assert.equal(shared[0].owner.name, 'Anna Schmidt');
    assert.equal(shared[0].members, undefined);

    const personal = await list('ben', 'personal');
    assert.deepEqual(personal.map(item => item.id).sort(), [annas.id, bens.id, offered.id].sort());

    // Anna owns two; nothing is shared with her.
    assert.deepEqual(
      (await list('anna', 'mine')).map(item => item.id).sort(),
      [annas.id, offered.id].sort()
    );
    assert.deepEqual(await list('anna', 'shared'), []);
    // Mallory sees nothing of it.
    assert.deepEqual(await list('mallory', 'personal'), []);
    // A full admin's list holds their own apps, not everybody's.
    assert.deepEqual(await list('root', 'personal'), []);
  });

  it('an unknown value answers 400', async () => {
    for (const scope of ['all', '', 'MINE', 'mine,shared']) {
      const res = await as('ben').get('/api/apps').query({ scope });
      assert.equal(res.status, 400, JSON.stringify(scope));
      assert.equal(res.body.code, 'VALIDATION_FAILED');
    }
    const twice = await as('ben').get('/api/apps?scope=mine&scope=shared');
    assert.equal(twice.status, 400);
    assert.deepEqual([...USER_APP_SCOPES], ['mine', 'shared', 'personal']);
  });

  it('is empty with the feature off and for a principal that cannot hold personal apps', async () => {
    await sharedApp();
    for (const name of ['anonymous', 'client', 'agent', 'benDelegated']) {
      const res = await as(name).get('/api/apps').query({ scope: 'personal' });
      assert.equal(res.status, 200, name);
      assert.deepEqual(res.body, { items: [], nextCursor: null }, name);
    }
    // A personal API key: its user's own apps, and nothing shared.
    const viaKey = await as('benKey').get('/api/apps').query({ scope: 'shared' });
    assert.deepEqual(viaKey.body, { items: [], nextCursor: null });

    setConfig({ features: { ...FEATURES, userApps: false } });
    const off = await as('anna').get('/api/apps').query({ scope: 'personal' });
    assert.equal(off.status, 200);
    assert.deepEqual(off.body, { items: [], nextCursor: null });
  });

  it('a switched-off app is listed with the reduced body', async () => {
    const record = await sharedApp({
      change: current => ({
        ...current,
        disabled: { at: '2026-11-20T10:00:00.000Z', by: { id: 'root' }, reason: 'Check first' }
      })
    });
    const res = await as('ben').get('/api/apps').query({ scope: 'shared' });
    assert.equal(res.body.items.length, 1);
    assert.equal(res.body.items[0].id, record.id);
    assert.equal(res.body.items[0].system, undefined);
    assert.equal(res.body.items[0].disabled.reason, 'Check first');
  });

  it('a request of the owner refreshes the owner’s snapshots', async () => {
    const record = await harness.createApp('anna', {
      change: current => ({
        ...current,
        ownerPrincipalAt: new Date(Date.now() - 2 * DAY).toISOString()
      })
    });
    const stale = await harness.repo().get(record.id);
    await as('anna').get('/api/apps').query({ scope: 'mine' });
    const fresh = await harness.repo().get(record.id);
    assert.ok(Date.parse(fresh.ownerPrincipalAt) > Date.parse(stale.ownerPrincipalAt));
  });

  it('returns at most 200 shared apps, newest first', async () => {
    const template = await sharedApp();
    const total = MAX_SHARED_LISTED + 5;
    const records = Array.from({ length: total }, (_, index) => ({
      ...template,
      id: `uap_${String(index).padStart(32, '0')}`,
      updatedAt: new Date(Date.parse('2026-01-01T00:00:00Z') + (total - index) * 1000).toISOString()
    }));
    const repository = {
      isAvailable: () => true,
      listOwned: async () => [],
      refreshOwnerPrincipal: async () => 0,
      listSharedWith: async () => records
    };
    const items = await listUserAppsFor(user('ben'), 'shared', { repository });
    assert.equal(MAX_SHARED_LISTED, 200);
    assert.equal(items.length, 200);
    assert.equal(items[0].id, records[0].id);
    assert.equal(items.at(-1).id, records[199].id);
    // `personal` holds the caller's own apps on top of that.
    const own = { ...template, id: `uap_${'f'.repeat(32)}`, owner: { id: 'ben', name: 'Ben' } };
    const both = await listUserAppsFor(user('ben'), 'personal', {
      repository: { ...repository, listOwned: async () => [own] }
    });
    assert.equal(both.length, 201);
    assert.equal(both[0].id, own.id);
  });

  it('userAppResponse builds the same body from a stored record, for the routes that write', async () => {
    const record = await sharedApp();
    for (const name of ['anna', 'ben', 'carol']) {
      const single = await as(name).get(`/api/apps/${record.id}`);
      const { body, etag, permissions } = await userAppResponse(
        await harness.repo().get(record.id),
        user(name)
      );
      assert.deepEqual(JSON.parse(JSON.stringify(body)), single.body, name);
      assert.equal(etag, single.headers.etag, name);
      assert.equal(permissions.role, single.body.permissions.role, name);
    }
  });

  it('a list item of a personal app is what the single read answers', async () => {
    const record = await sharedApp({ content: plainContent({ preferredModel: 'oa' }) });
    const single = await as('ben').get(`/api/apps/${record.id}`);
    const list = await as('ben').get('/api/apps').query({ scope: 'shared' });
    assert.deepEqual(list.body.items[0], single.body);
  });
});
