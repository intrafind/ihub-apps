// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The user routes of personal apps (feature `userApps`, design section 9.1):
 * status, body, `Location`, `ETag` and the error table of every route except
 * the publish route.
 *
 * The real routes and services run over a populated config cache and a
 * filesystem store in a scratch directory. The only stubs are the model of
 * the draft route and the users database of share targets.
 *
 * Run: node --test server/tests/user-apps-routes.test.js
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import installedIntegrationService from '../services/integrations/InstalledIntegrationService.js';
import { sanitizeGeneratedApp, DRAFT_LIMITS } from '../services/appGenerator.js';
import { userAppSettings } from '../services/userApps/userAppSettings.js';
import {
  USER_APP_LIMITS,
  USER_APP_RUN_KEYS,
  USER_APP_SCHEMA_DEFAULTS,
  isUserAppId
} from '../../shared/userAppContent.js';
import {
  ADMIN_APP,
  FEATURES,
  SECRET,
  UNKNOWN_PERSONAL_ID,
  groupsWith,
  member,
  setConfig,
  shape
} from './helpers/userAppsHarness.js';
import { createBody, startUserAppRoutesApi } from './helpers/userAppRoutesApi.js';

let api;
let as;

before(async () => {
  api = await startUserAppRoutesApi();
  ({ as } = api);
});
after(() => api.stop());
beforeEach(() => api.reset());

/** An app of Anna, shared with Ben ("Can use") and Carol ("Can edit"). */
const sharedApp = (options = {}) =>
  api.createApp('anna', {
    members: [member('ben', 'user'), member('carol', 'editor')],
    ...options
  });

const switchedOff = record => ({
  ...record,
  disabled: { at: '2026-11-20T10:00:00.000Z', by: { id: 'root', name: 'Ada Admin' }, reason: 'x' }
});

const promoted = record => ({
  ...record,
  state: 'promoted',
  publishedAs: { appId: ADMIN_APP, at: '2026-11-20T10:00:00.000Z', by: record.owner }
});

/** An installation personal apps may bind, which the group `narrow` is not granted. */
const JIRA = { id: 'jira', definition: 'jira', enabled: true };
const withJira = (extra = {}) =>
  setConfig({
    userApps: { capabilities: { integrations: [{ id: 'jira', actions: ['search', 'read'] }] } },
    integrations: { installed: [JIRA], security: { blockPrivateIps: true, allowedHosts: [] } },
    ...extra
  });
const jiraBinding = {
  upload: false,
  webSearch: false,
  skills: false,
  integrations: [{ id: 'jira', actions: ['search'] }]
};

const problem = res => ({ status: res.status, code: res.body?.code, details: res.body?.details });

describe('the gate of every route', () => {
  /** One request per route, as Anna, against an app of hers. */
  const calls = id => [
    ['get', '/api/apps/_templates'],
    ['post', '/api/apps/_generate', { description: 'An app' }],
    ['get', '/api/apps/_share-targets'],
    ['post', '/api/apps', createBody()],
    ['patch', `/api/apps/${id}`, { name: { en: 'x' } }],
    ['delete', `/api/apps/${id}`],
    ['put', `/api/apps/${id}/members`, { members: [] }],
    ['post', `/api/apps/${id}/_leave`],
    ['put', `/api/apps/${id}/owner-offer`, { ownerId: 'dave' }],
    ['delete', `/api/apps/${id}/owner-offer`],
    ['post', `/api/apps/${id}/owner-offer/_accept`],
    ['post', `/api/apps/${id}/_duplicate`]
  ];
  const send = (who, [method, url, body]) => {
    const req = as(who)[method](url).set('If-Match', '"1"');
    return body ? req.send(body) : req;
  };

  it('answers 401 without a sign-in, on every route', async () => {
    const record = await api.createApp('anna');
    for (const call of [['get', '/api/apps/_config'], ...calls(record.id)]) {
      const res = await send('anonymous', call);
      assert.deepEqual(
        [res.status, res.body.code],
        [401, 'AUTH_REQUIRED'],
        `${call[0]} ${call[1]}`
      );
    }
  });

  it('answers 403 USER_APPS_DISABLED with the feature off, for the owner and for a full admin', async () => {
    const record = await api.createApp('anna');
    setConfig({ features: { ...FEATURES, userApps: false } });
    for (const who of ['anna', 'root']) {
      for (const call of calls(record.id)) {
        const res = await send(who, call);
        assert.deepEqual(
          [res.status, res.body.code],
          [403, 'USER_APPS_DISABLED'],
          `${who} ${call[0]} ${call[1]}`
        );
      }
    }
    assert.ok(await api.repo().get(record.id), 'the record stays in the store');
  });

  it('refuses a sign-in that cannot hold personal apps: 403, or on one app the 404 (14.2)', async () => {
    const record = await api.createApp('anna');
    for (const who of ['client', 'agent', 'benDelegated']) {
      for (const call of calls(record.id)) {
        const res = await send(who, call);
        const perApp = call[1].includes(record.id);
        assert.deepEqual(
          [res.status, res.body.code],
          perApp ? [404, 'NOT_FOUND'] : [403, 'PERMISSION_DENIED'],
          `${who} ${call[0]} ${call[1]}: ${res.text}`
        );
        if (perApp) {
          // The same answer as for an ID nobody has.
          const unknown = await send(who, [
            call[0],
            call[1].replace(record.id, UNKNOWN_PERSONAL_ID),
            call[2]
          ]);
          assert.deepEqual(shape(res, record.id), shape(unknown, UNKNOWN_PERSONAL_ID));
        }
      }
    }
  });

  it('answers a write on an ID the caller cannot see as it answers an unknown ID', async () => {
    const record = await sharedApp();
    for (const [method, suffix, body] of [
      ['patch', '', { name: { en: 'x' } }],
      ['delete', ''],
      ['put', '/members', { members: [] }],
      ['post', '/_leave'],
      ['put', '/owner-offer', { ownerId: 'dave' }],
      ['delete', '/owner-offer'],
      ['post', '/owner-offer/_accept'],
      ['post', '/_duplicate']
    ]) {
      const call = id => [method, `/api/apps/${id}${suffix}`, body];
      const hidden = await send('mallory', call(record.id));
      const unknown = await send('mallory', call(UNKNOWN_PERSONAL_ID));
      assert.equal(hidden.status, 404, `${method} ${suffix}: ${hidden.text}`);
      assert.equal(hidden.body.code, 'NOT_FOUND');
      assert.deepEqual(shape(hidden, record.id), shape(unknown, UNKNOWN_PERSONAL_ID));
      // A personal API key of a member reaches nothing either.
      assert.equal((await send('benKey', call(record.id))).status, 404);
      // An admin app is no personal app: 404 on a write route.
      const adminApp = await send('anna', call(ADMIN_APP));
      assert.deepEqual(
        [adminApp.status, adminApp.body.code],
        [404, 'NOT_FOUND'],
        `${method} ${suffix}`
      );
    }
  });
});

describe('GET /api/apps/_config', () => {
  it('tells an owner what they may do and what an app may use', async () => {
    await api.createApp('anna');
    const res = await as('anna').get('/api/apps/_config');
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(Object.keys(res.body), ['userApps']);
    assert.deepEqual(res.body.userApps, {
      enabled: true,
      canCreate: true,
      canShare: true,
      // She holds `userAppSharing`, and the harness has `sharing.allowPublish` on.
      canPublish: true,
      maxApps: 20,
      used: 1,
      generator: true,
      capabilities: {
        modelChoice: true,
        upload: true,
        // Allowed by the settings, but no search engine is installed.
        webSearch: false,
        skills: false,
        integrations: []
      }
    });
  });

  it('answers with the feature off, and says so', async () => {
    setConfig({ features: { ...FEATURES, userApps: false } });
    const res = await as('anna').get('/api/apps/_config');
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.userApps.enabled, false);
    assert.equal(res.body.userApps.canCreate, false);
    assert.equal(res.body.userApps.canShare, false);
    assert.deepEqual(res.body.userApps.capabilities.integrations, []);
    assert.equal(res.body.userApps.capabilities.upload, false);
  });

  it('says no to a user without the group permissions and to a blocked owner', async () => {
    api.addPerson('guest', {
      id: 'guest',
      name: 'Gus Guest',
      authMode: 'oidc',
      groups: ['guests']
    });
    const guest = (await as('guest').get('/api/apps/_config')).body.userApps;
    assert.deepEqual(
      [guest.enabled, guest.canCreate, guest.canShare, guest.generator],
      [true, false, false, false]
    );
    setConfig({ userApps: { blockedOwners: ['anna'] } });
    const blocked = (await as('anna').get('/api/apps/_config')).body.userApps;
    assert.deepEqual([blocked.canCreate, blocked.canShare], [false, true]);
  });

  it('reports the draft generator only with its feature', async () => {
    setConfig({ features: { ...FEATURES, appGenerator: false } });
    assert.equal((await as('anna').get('/api/apps/_config')).body.userApps.generator, false);
  });

  it('lists only installations an admin allowed and the caller may use, with the allowed actions', async t => {
    withJira();
    t.mock.method(installedIntegrationService, 'resolveAllEnabled', async () => [
      {
        instance: JIRA,
        label: 'Jira',
        definition: {
          name: { en: 'Jira' },
          actions: [
            { name: 'search', description: { en: 'Find issues' } },
            { name: 'read', description: 'Read an issue' },
            { name: 'delete', description: { en: 'Delete an issue' } }
          ]
        }
      },
      {
        instance: { id: 'wiki', definition: 'wiki' },
        label: 'Wiki',
        definition: { actions: [{ name: 'find' }] }
      }
    ]);
    const anna = (await as('anna').get('/api/apps/_config')).body.userApps.capabilities;
    assert.deepEqual(anna.integrations, [
      {
        id: 'jira',
        label: 'Jira',
        actions: [
          { name: 'search', description: 'Find issues' },
          { name: 'read', description: 'Read an issue' }
        ]
      }
    ]);
    // Nora's group grants no integration.
    const nora = (await as('nora').get('/api/apps/_config')).body.userApps.capabilities;
    assert.deepEqual(nora.integrations, []);
  });
});

describe('GET /api/apps/_templates', () => {
  it('lists the templates for a caller who may create', async () => {
    const res = await as('anna').get('/api/apps/_templates');
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.nextCursor, null);
    assert.ok(res.body.items.length > 0);
    for (const item of res.body.items) {
      assert.ok(item.id && item.name && item.app, JSON.stringify(Object.keys(item)));
    }
  });

  it('refuses a caller who may not create', async () => {
    api.addPerson('guest', {
      id: 'guest',
      name: 'Gus Guest',
      authMode: 'oidc',
      groups: ['guests']
    });
    const res = await as('guest').get('/api/apps/_templates');
    assert.deepEqual(problem(res), {
      status: 403,
      code: 'PERMISSION_DENIED',
      details: { required: 'userApps' }
    });
  });
});

describe('GET /api/apps/_share-targets', () => {
  it('finds users from two characters, never the caller, never a deactivated account', async () => {
    const short = await as('anna').get('/api/apps/_share-targets?q=b');
    assert.equal(short.status, 200, short.text);
    assert.deepEqual(Object.keys(short.body).sort(), ['allowed', 'everyone', 'groups', 'users']);
    assert.deepEqual(short.body.allowed, { user: true, group: true, everyone: true });
    assert.deepEqual(short.body.users, []);

    const found = await as('anna').get('/api/apps/_share-targets?q=example.org');
    const ids = found.body.users.map(user => user.id);
    assert.ok(ids.includes('ben'));
    assert.equal(ids.includes('anna'), false);
    assert.equal(ids.includes('gone'), false);
    assert.ok(found.body.users.length <= 10);
    assert.deepEqual(Object.keys(found.body.users[0]).sort(), ['email', 'id', 'name']);

    const none = await as('anna').get('/api/apps/_share-targets?q=Gina');
    assert.deepEqual(none.body.users, []);
  });

  it('offers groups without anonymous, and everyone only when the settings allow it', async () => {
    const res = await as('anna').get('/api/apps/_share-targets');
    assert.equal(res.body.everyone, true);
    const groups = res.body.groups.map(group => group.id);
    assert.ok(groups.includes('staff'));
    assert.equal(groups.includes('anonymous'), false);

    setConfig({
      userApps: { sharing: { allowEveryone: false, allowGroups: false, allowUsers: false } }
    });
    const off = await as('anna').get('/api/apps/_share-targets?q=ben');
    assert.deepEqual(off.body, {
      users: [],
      groups: [],
      everyone: false,
      allowed: { user: false, group: false, everyone: false }
    });
  });

  it('needs the permission to share, or an app to hand over', async () => {
    setConfig({ groups: groupsWith({ users: { userAppSharing: false } }) });
    const refused = await as('anna').get('/api/apps/_share-targets?q=ben');
    assert.deepEqual(problem(refused), {
      status: 403,
      code: 'PERMISSION_DENIED',
      details: { required: 'userAppSharing' }
    });
    // Without an app there is nothing to hand over.
    assert.equal(
      (await as('anna').get('/api/apps/_share-targets?purpose=offer&q=ben')).status,
      403
    );
    await api.createApp('anna');
    const offer = await as('anna').get('/api/apps/_share-targets?purpose=offer&q=ben');
    assert.equal(offer.status, 200, offer.text);
    assert.deepEqual(
      offer.body.users.map(user => user.id),
      ['ben']
    );
    assert.deepEqual([offer.body.groups, offer.body.everyone], [[], false]);
    const unknown = await as('anna').get('/api/apps/_share-targets?purpose=x');
    assert.deepEqual([unknown.status, unknown.body.code], [400, 'VALIDATION_FAILED']);
  });
});

describe('POST /api/apps', () => {
  it('creates an app of the caller: 201, Location, ETag, the app', async () => {
    const res = await as('anna')
      .post('/api/apps')
      .send(
        createBody({
          origin: 'template',
          capabilities: { upload: true, webSearch: false, skills: false, integrations: [] }
        })
      );
    assert.equal(res.status, 201, res.text);
    assert.ok(isUserAppId(res.body.id), res.body.id);
    assert.equal(res.headers.location, `/api/apps/${res.body.id}`);
    assert.equal(res.headers.etag, '"1"');
    assert.equal(res.body.ownership, 'user');
    assert.deepEqual(res.body.owner, { id: 'anna', name: 'Anna Schmidt', active: true });
    assert.equal(res.body.permissions.role, 'owner');
    assert.equal(res.body.revision, 1);
    assert.equal(res.body.state, 'active');
    assert.deepEqual(res.body.members, []);
    assert.deepEqual(res.body.name, { en: 'Job ad writer' });
    assert.equal(res.body.upload.enabled, true);

    const stored = await api.repo().get(res.body.id);
    assert.equal(stored.origin, 'template');
    assert.equal(stored.language, 'en');
    assert.equal(stored.ownerPrincipal.userId, 'anna');

    // The app is what GET answers, and nobody else sees it.
    const read = await as('anna').get(`/api/apps/${res.body.id}`);
    assert.equal(read.status, 200);
    assert.deepEqual(read.body, res.body);
    assert.equal((await as('ben').get(`/api/apps/${res.body.id}`)).status, 404);
  });

  it('answers 400 for an invalid body', async () => {
    const languages = Object.fromEntries(['en', 'de', 'fr', 'it', 'es', 'nl'].map(l => [l, 'x']));
    for (const [label, body] of [
      ['unknown key', createBody({ type: 'iframe' })],
      ['a never key', createBody({ projects: ['p'] })],
      ['no instructions', { ...createBody(), system: undefined }],
      ['six languages', createBody({ name: languages })],
      ['a name over its limit', createBody({ name: { en: 'x'.repeat(USER_APP_LIMITS.name + 1) } })],
      [
        'a binding without actions',
        createBody({ capabilities: { integrations: [{ id: 'jira' }] } })
      ],
      [
        'a binding of every action',
        createBody({ capabilities: { integrations: [{ id: 'jira', actions: ['*'] }] } })
      ],
      ['an unknown origin', createBody({ origin: 'chat' })]
    ]) {
      const res = await as('anna').post('/api/apps').send(body);
      assert.deepEqual(
        [res.status, res.body.code],
        [400, 'VALIDATION_FAILED'],
        `${label}: ${res.text}`
      );
    }
    assert.equal((await api.repo().listOwned('anna')).length, 0);
  });

  it('strips hidden characters from the instructions', async () => {
    const res = await as('anna')
      .post('/api/apps')
      .send(createBody({ system: { en: 'Be\u200B kind\u202E.' } }));
    assert.equal(res.status, 201, res.text);
    assert.equal(res.body.system.en, 'Be kind.');
  });

  it('refuses a capability the installation does not allow or the caller may not use', async () => {
    setConfig({ userApps: { capabilities: { webSearch: false, upload: false } } });
    const search = await as('anna')
      .post('/api/apps')
      .send(createBody({ capabilities: { webSearch: true } }));
    assert.deepEqual(problem(search), {
      status: 403,
      code: 'USER_APP_CAPABILITY_DENIED',
      details: { capability: 'webSearch', reason: 'offOnInstallation' }
    });
    const upload = await as('anna')
      .post('/api/apps')
      .send(createBody({ capabilities: { upload: true } }));
    assert.equal(upload.body.details.capability, 'upload');

    // A model the caller's groups do not grant.
    setConfig();
    const model = await as('nora')
      .post('/api/apps')
      .send(createBody({ preferredModel: 'oa' }));
    assert.deepEqual(problem(model), {
      status: 403,
      code: 'USER_APP_CAPABILITY_DENIED',
      details: { capability: 'model', reason: 'youMayNot' }
    });
    assert.equal(
      (
        await as('nora')
          .post('/api/apps')
          .send(createBody({ preferredModel: 'restricted' }))
      ).status,
      201
    );

    // An installation the admin allowed, which the caller's groups do not grant;
    // and an action the admin did not allow.
    withJira();
    const binding = await as('nora')
      .post('/api/apps')
      .send(createBody({ capabilities: jiraBinding }));
    assert.deepEqual(problem(binding), {
      status: 403,
      code: 'USER_APP_CAPABILITY_DENIED',
      details: { capability: 'integration:jira', reason: 'youMayNot' }
    });
    const action = await as('anna')
      .post('/api/apps')
      .send(createBody({ capabilities: { integrations: [{ id: 'jira', actions: ['delete'] }] } }));
    assert.equal(action.status, 403, action.text);
    assert.equal(action.body.details.capability, 'integration:jira');
    assert.equal(
      (
        await as('anna')
          .post('/api/apps')
          .send(createBody({ capabilities: jiraBinding }))
      ).status,
      201
    );
  });

  it('refuses a caller without the group permission, and a blocked owner', async () => {
    api.addPerson('guest', {
      id: 'guest',
      name: 'Gus Guest',
      authMode: 'oidc',
      groups: ['guests']
    });
    assert.deepEqual(problem(await as('guest').post('/api/apps').send(createBody())), {
      status: 403,
      code: 'PERMISSION_DENIED',
      details: { required: 'userApps' }
    });
    setConfig({ userApps: { blockedOwners: ['anna'] } });
    assert.deepEqual(problem(await as('anna').post('/api/apps').send(createBody())), {
      status: 403,
      code: 'PERMISSION_DENIED',
      details: { required: 'userApps', reason: 'ownerBlocked' }
    });
    // The right to create is checked before the body.
    assert.equal((await as('anna').post('/api/apps').send({ nonsense: true })).status, 403);
  });

  it('answers QUOTA_USER_APPS over the limit, and two parallel creates at the limit yield one app', async () => {
    setConfig({ userApps: { limits: { maxAppsPerUser: 2 } } });
    assert.equal((await as('anna').post('/api/apps').send(createBody())).status, 201);
    const both = await Promise.all([
      as('anna').post('/api/apps').send(createBody()),
      as('anna').post('/api/apps').send(createBody())
    ]);
    assert.deepEqual(both.map(res => res.status).sort(), [201, 409]);
    const refused = both.find(res => res.status === 409);
    assert.equal(refused.body.code, 'QUOTA_USER_APPS');
    assert.equal(typeof refused.body.details.max, 'number');
    assert.equal((await api.repo().listOwned('anna')).length, 2);
    // The limit is per person.
    assert.equal((await as('ben').post('/api/apps').send(createBody())).status, 201);
    // Zero means no limit.
    setConfig({ userApps: { limits: { maxAppsPerUser: 0 } } });
    assert.equal((await as('anna').post('/api/apps').send(createBody())).status, 201);
  });
});

describe('PATCH /api/apps/{appId}', () => {
  it('merges the patch, answers the app and a new ETag', async () => {
    const record = await sharedApp({ content: { prompt: { en: 'Notes: {{content}}' } } });
    const res = await as('anna')
      .patch(`/api/apps/${record.id}`)
      .set('If-Match', `"${record.revision}"`)
      .send({ name: { en: 'Renamed' }, prompt: null, capabilities: { upload: true } });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.headers.etag, `"${record.revision + 1}"`);
    assert.equal(res.body.revision, record.revision + 1);
    assert.deepEqual(res.body.name, { en: 'Renamed' });
    assert.equal('prompt' in res.body, false);
    assert.equal(res.body.upload.enabled, true);
    assert.deepEqual(res.body.updatedBy, { id: 'anna', name: 'Anna Schmidt' });
    // What the patch did not name is unchanged.
    assert.equal(res.body.system.en, record.content.system.en);
    assert.equal(res.body.members.length, 2);
  });

  it('answers 409 ETAG_MISMATCH for a stale If-Match, and works without the header', async () => {
    const record = await sharedApp();
    const stale = await as('anna')
      .patch(`/api/apps/${record.id}`)
      .set('If-Match', `"${record.revision - 1}"`)
      .send({ name: { en: 'Renamed' } });
    assert.deepEqual([stale.status, stale.body.code], [409, 'ETAG_MISMATCH']);
    assert.deepEqual((await api.repo().get(record.id)).content.name, record.content.name);
    const free = await as('anna')
      .patch(`/api/apps/${record.id}`)
      .send({ name: { en: 'Renamed' } });
    assert.equal(free.status, 200, free.text);
  });

  it('answers 400 for an unknown key, an empty patch and a merged app that breaks a rule', async () => {
    const record = await sharedApp();
    for (const body of [
      { category: 'x' },
      {},
      { name: null },
      { toolApproval: { default: 'never' } },
      { capabilities: { integrations: [{ id: 'jira' }] } }
    ]) {
      const res = await as('anna').patch(`/api/apps/${record.id}`).send(body);
      assert.deepEqual(
        [res.status, res.body.code],
        [400, 'VALIDATION_FAILED'],
        `${JSON.stringify(body)}: ${res.text}`
      );
    }
  });

  it('lets an editor save, and refuses a "Can use" member, the receiver of an offer and a full admin', async () => {
    const record = await sharedApp();
    await api
      .repo()
      .setOffer(record.id, { id: 'dave', name: 'Dave Lund' }, { actor: { id: 'anna' } });
    const editor = await as('carol')
      .patch(`/api/apps/${record.id}`)
      .send({ name: { en: 'By Carol' } });
    assert.equal(editor.status, 200, editor.text);
    assert.deepEqual(editor.body.updatedBy, { id: 'carol', name: 'Carol Shaw' });
    assert.equal(editor.body.permissions.role, 'editor');
    // The owner snapshot stays the owner's.
    assert.equal((await api.repo().get(record.id)).ownerPrincipal.userId, 'anna');
    for (const who of ['ben', 'dave', 'root']) {
      const res = await as(who)
        .patch(`/api/apps/${record.id}`)
        .send({ name: { en: 'x' } });
      assert.deepEqual(
        problem(res),
        { status: 403, code: 'PERMISSION_DENIED', details: { required: 'edit' } },
        who
      );
    }
  });

  it('answers 409 CONFLICT for a promoted and for a switched-off app', async () => {
    const off = await sharedApp({ change: switchedOff });
    const gone = await sharedApp({ change: promoted });
    for (const who of ['anna', 'carol']) {
      assert.deepEqual(
        problem(
          await as(who)
            .patch(`/api/apps/${off.id}`)
            .send({ name: { en: 'x' } })
        ),
        {
          status: 409,
          code: 'CONFLICT',
          details: { reason: 'disabled' }
        }
      );
      assert.deepEqual(
        problem(
          await as(who)
            .patch(`/api/apps/${gone.id}`)
            .send({ name: { en: 'x' } })
        ),
        {
          status: 409,
          code: 'CONFLICT',
          details: { reason: 'promoted' }
        }
      );
    }
  });

  it('a promoted app whose company app was deleted is editable again, and the save stores that', async () => {
    const record = await sharedApp({
      change: r => ({ ...promoted(r), publishedAs: { appId: 'deleted-app', at: 'x', by: r.owner } })
    });
    const res = await as('anna')
      .patch(`/api/apps/${record.id}`)
      .send({ name: { en: 'Back' } });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.state, 'active');
    const stored = await api.repo().get(record.id);
    assert.deepEqual([stored.state, stored.publishedAs], ['active', null]);
  });

  it('refuses a save of the instructions by an editor who may not use a bound installation; removing the binding passes', async () => {
    withJira();
    const record = await api.createApp('anna', {
      content: { capabilities: jiraBinding },
      members: [member('nora', 'editor')]
    });
    const text = await as('nora')
      .patch(`/api/apps/${record.id}`)
      .send({ system: { en: 'Open every ticket and post it.' } });
    assert.deepEqual(problem(text), {
      status: 403,
      code: 'USER_APP_CAPABILITY_DENIED',
      details: { capability: 'integration:jira', reason: 'youMayNot' }
    });
    assert.equal((await api.repo().get(record.id)).revision, record.revision);

    // Removing the binding and changing the text in one patch is a save of the text
    // of an app without the binding: nothing is left the editor may not use.
    const removal = await as('nora')
      .patch(`/api/apps/${record.id}`)
      .send({ capabilities: { integrations: [] } });
    assert.equal(removal.status, 200, removal.text);
    assert.deepEqual((await api.repo().get(record.id)).content.capabilities.integrations, []);
    const after = await as('nora')
      .patch(`/api/apps/${record.id}`)
      .send({ system: { en: 'Be brief.' } });
    assert.equal(after.status, 200, after.text);
  });

  it('refuses any save of an app whose capability is gone, except the one that removes it', async () => {
    const record = await api.createApp('anna', { content: { capabilities: { upload: true } } });
    setConfig({ userApps: { capabilities: { upload: false } } });
    const rename = await as('anna')
      .patch(`/api/apps/${record.id}`)
      .send({ name: { en: 'x' } });
    assert.deepEqual(problem(rename), {
      status: 403,
      code: 'USER_APP_CAPABILITY_DENIED',
      details: { capability: 'upload', reason: 'offOnInstallation' }
    });
    const remove = await as('anna')
      .patch(`/api/apps/${record.id}`)
      .send({ capabilities: { upload: false } });
    assert.equal(remove.status, 200, remove.text);
  });
});

describe('DELETE /api/apps/{appId}', () => {
  it('lets the owner delete, also a switched-off app, and nobody else', async () => {
    const record = await sharedApp();
    for (const who of ['carol', 'ben', 'root']) {
      const res = await as(who).delete(`/api/apps/${record.id}`);
      assert.deepEqual(
        problem(res),
        { status: 403, code: 'PERMISSION_DENIED', details: { required: 'own' } },
        who
      );
    }
    const res = await as('anna').delete(`/api/apps/${record.id}`);
    assert.equal(res.status, 204, res.text);
    assert.equal(res.text, '');
    assert.equal(await api.repo().get(record.id), null);
    assert.equal((await as('anna').get(`/api/apps/${record.id}`)).status, 404);
    assert.equal((await as('anna').delete(`/api/apps/${record.id}`)).status, 404);
    // The newest content state is kept; the member markers are gone.
    assert.equal((await api.repo().listDeletedStates('anna')).length, 1);
    assert.deepEqual(await api.repo().listSharedWith(['user:ben']), []);

    const off = await sharedApp({ change: switchedOff });
    assert.equal((await as('anna').delete(`/api/apps/${off.id}`)).status, 204);
  });
});

describe('PUT /api/apps/{appId}/members', () => {
  const put = (who, id, members) => as(who).put(`/api/apps/${id}/members`).send({ members });

  it('replaces the list, with roles, and answers the app with a new ETag', async () => {
    const record = await api.createApp('anna');
    const res = await put('anna', record.id, [
      { type: 'user', id: 'ben', role: 'user' },
      { type: 'user', id: 'carol', role: 'editor' },
      { type: 'group', id: 'staff' },
      { type: 'everyone', role: 'user' },
      // The owner needs no entry.
      { type: 'user', id: 'anna', role: 'editor' }
    ]);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.headers.etag, `"${record.revision + 1}"`);
    assert.deepEqual(res.body.members, [
      { type: 'user', id: 'ben', name: 'Ben Koch', role: 'user' },
      { type: 'user', id: 'carol', name: 'Carol Shaw', role: 'editor' },
      { type: 'group', id: 'staff', name: 'staff', role: 'user' },
      { type: 'everyone', id: null, name: '', role: 'user' }
    ]);
    assert.deepEqual(res.body.sharedWith, { users: 2, groups: 1, everyone: true });
    assert.equal((await as('mallory').get(`/api/apps/${record.id}`)).status, 200);

    const fewer = await put('anna', record.id, [{ type: 'user', id: 'carol', role: 'user' }]);
    assert.equal(fewer.status, 200, fewer.text);
    assert.equal((await as('mallory').get(`/api/apps/${record.id}`)).status, 404);
    assert.equal((await as('ben').get(`/api/apps/${record.id}`)).status, 404);
  });

  it('answers the error table', async () => {
    const record = await sharedApp();
    const many = Array.from({ length: USER_APP_LIMITS.members + 1 }, (_, index) => ({
      type: 'group',
      id: `g${index}`
    }));
    assert.deepEqual(
      [(await put('anna', record.id, many)).status, (await put('anna', record.id, many)).body.code],
      [400, 'VALIDATION_FAILED']
    );
    const unknownKey = await as('anna')
      .put(`/api/apps/${record.id}/members`)
      .send({ members: [], x: 1 });
    assert.equal(unknownKey.body.code, 'VALIDATION_FAILED');

    for (const target of [
      { type: 'user', id: 'nobody' },
      { type: 'user', id: 'gone' },
      { type: 'group', id: 'no-such-group' },
      { type: 'group', id: 'anonymous' }
    ]) {
      const res = await put('anna', record.id, [target]);
      assert.deepEqual([res.status, res.body.code], [400, 'SHARE_TARGET_INVALID'], res.text);
    }

    const stale = await as('anna')
      .put(`/api/apps/${record.id}/members`)
      .set('If-Match', '"1"')
      .send({ members: [] });
    assert.deepEqual([stale.status, stale.body.code], [409, 'ETAG_MISMATCH']);

    setConfig({ userApps: { sharing: { allowEveryone: false } } });
    const everyone = await put('anna', record.id, [{ type: 'everyone' }]);
    assert.deepEqual([everyone.status, everyone.body.code], [403, 'SHARE_TARGET_NOT_ALLOWED']);

    assert.deepEqual(problem(await put('ben', record.id, [])), {
      status: 403,
      code: 'PERMISSION_DENIED',
      details: { required: 'share' }
    });
  });

  it('lets an editor change members, and keeps a target the settings no longer allow', async () => {
    const record = await sharedApp({
      members: [member('carol', 'editor'), member(null, 'user', 'everyone')]
    });
    setConfig({ userApps: { sharing: { allowEveryone: false } } });
    const res = await put('carol', record.id, [
      { type: 'user', id: 'carol', role: 'editor' },
      { type: 'everyone' },
      { type: 'user', id: 'ben' }
    ]);
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.body.sharedWith, { users: 2, groups: 0, everyone: true });
  });

  it('does not raise a kept target the settings no longer allow from "Can use" to "Can edit"', async () => {
    const record = await sharedApp({
      members: [member('carol', 'editor'), member(null, 'user', 'everyone')]
    });
    setConfig({
      userApps: { sharing: { allowEveryone: false, allowUsers: false, allowGroups: false } }
    });
    const keep = [{ type: 'user', id: 'carol', role: 'editor' }];
    const raised = await put('anna', record.id, [...keep, { type: 'everyone', role: 'editor' }]);
    assert.deepEqual(problem(raised), {
      status: 403,
      code: 'SHARE_TARGET_NOT_ALLOWED',
      details: { type: 'everyone' }
    });
    const stored = await api.repo().get(record.id);
    assert.equal(stored.members.find(entry => entry.type === 'everyone').role, 'user');
    // Unchanged it is kept, and lowering is always possible.
    const same = await put('anna', record.id, [...keep, { type: 'everyone', role: 'user' }]);
    assert.equal(same.status, 200, same.text);
    const lowered = await put('anna', record.id, [{ type: 'user', id: 'carol', role: 'user' }]);
    assert.equal(lowered.status, 200, lowered.text);
  });

  it('needs the permission to share of the caller', async () => {
    // Sam's second group grants sharing; Anna's does not.
    setConfig({ groups: groupsWith({ users: { userAppSharing: false } }) });
    const own = await api.createApp('sam', { members: [member('carol', 'editor')] });
    assert.deepEqual(problem(await put('carol', own.id, [])), {
      status: 403,
      code: 'PERMISSION_DENIED',
      details: { required: 'userAppSharing' }
    });
    assert.equal((await put('sam', own.id, [])).status, 200);
  });

  it('refuses a member update by an editor when the owner lacks userAppSharing', async () => {
    setConfig({ groups: groupsWith({ users: { userAppSharing: false } }) });
    const record = await api.createApp('anna', { members: [member('sam', 'editor')] });
    const res = await put('sam', record.id, [{ type: 'user', id: 'ben' }]);
    assert.deepEqual(problem(res), {
      status: 403,
      code: 'PERMISSION_DENIED',
      details: { required: 'userAppSharing', reason: 'ownerMayNotShare' }
    });
    assert.equal((await api.repo().get(record.id)).members.length, 1);
    // The owner cannot share either.
    assert.deepEqual(problem(await put('anna', record.id, [])).details, {
      required: 'userAppSharing'
    });
  });

  it('answers 409 CONFLICT for a promoted and a switched-off app', async () => {
    const off = await sharedApp({ change: switchedOff });
    const gone = await sharedApp({ change: promoted });
    assert.deepEqual(problem(await put('anna', off.id, [])).details, { reason: 'disabled' });
    assert.deepEqual(problem(await put('anna', gone.id, [])), {
      status: 409,
      code: 'CONFLICT',
      details: { reason: 'promoted' }
    });
  });
});

describe('POST /api/apps/{appId}/_leave', () => {
  it('removes the caller’s own share', async () => {
    const record = await sharedApp();
    const res = await as('ben').post(`/api/apps/${record.id}/_leave`);
    assert.equal(res.status, 204, res.text);
    assert.equal((await as('ben').get(`/api/apps/${record.id}`)).status, 404);
    const stored = await api.repo().get(record.id);
    assert.deepEqual(
      stored.members.map(entry => entry.id),
      ['carol']
    );
    assert.equal(stored.revision, record.revision + 1);
  });

  it('answers 409 CONFLICT for the owner and for access that comes only through a group', async () => {
    const record = await api.createApp('anna', { members: [member('staff', 'user', 'group')] });
    assert.deepEqual(problem(await as('anna').post(`/api/apps/${record.id}/_leave`)), {
      status: 409,
      code: 'CONFLICT',
      details: { reason: 'owner' }
    });
    assert.deepEqual(problem(await as('sam').post(`/api/apps/${record.id}/_leave`)), {
      status: 409,
      code: 'CONFLICT',
      details: { reason: 'noDirectShare' }
    });
    assert.equal((await as('root').post(`/api/apps/${record.id}/_leave`)).status, 409);
    assert.equal((await api.repo().get(record.id)).members.length, 1);
  });
});

describe('POST /api/apps/{appId}/_duplicate', () => {
  it('gives the caller a new app of their own, without members', async () => {
    const record = await sharedApp({ content: { capabilities: { upload: true } } });
    const res = await as('ben').post(`/api/apps/${record.id}/_duplicate`);
    assert.equal(res.status, 201, res.text);
    assert.notEqual(res.body.id, record.id);
    assert.equal(res.headers.location, `/api/apps/${res.body.id}`);
    assert.equal(res.headers.etag, '"1"');
    assert.deepEqual(res.body.owner, { id: 'ben', name: 'Ben Koch', active: true });
    assert.deepEqual(res.body.members, []);
    assert.deepEqual(res.body.system, record.content.system);
    assert.equal(res.body.upload.enabled, true);
    const stored = await api.repo().get(res.body.id);
    assert.deepEqual([stored.origin, stored.state, stored.pendingOwner], ['copy', 'active', null]);
    // The original is untouched.
    assert.equal((await api.repo().get(record.id)).revision, record.revision);
  });

  it('leaves out what the caller may not use in an app of their own', async () => {
    withJira();
    const record = await api.createApp('anna', {
      content: { capabilities: jiraBinding, preferredModel: 'oa' },
      members: [member('nora', 'user')]
    });
    const res = await as('nora').post(`/api/apps/${record.id}/_duplicate`);
    assert.equal(res.status, 201, res.text);
    const stored = await api.repo().get(res.body.id);
    assert.deepEqual(stored.content.capabilities.integrations, []);
    assert.equal('preferredModel' in stored.content, false);
  });

  it('answers 409 for a switched-off app, for its owner too', async () => {
    const record = await sharedApp({ change: switchedOff });
    for (const who of ['anna', 'carol', 'root']) {
      assert.deepEqual(
        problem(await as(who).post(`/api/apps/${record.id}/_duplicate`)),
        { status: 409, code: 'CONFLICT', details: { reason: 'disabled' } },
        who
      );
    }
    assert.equal((await api.repo().listOwned('anna')).length, 1);
  });

  it('lets the owner duplicate a promoted app, and counts against the limit', async () => {
    const record = await sharedApp({
      change: r => ({ ...promoted(r), publishedAs: { appId: 'app-staff', at: 'x', by: r.owner } })
    });
    // Without the wildcard Anna cannot use the company app, so the personal one still works.
    setConfig({
      groups: groupsWith({ wildcard: false }),
      userApps: { limits: { maxAppsPerUser: 2 } }
    });
    assert.equal((await as('anna').post(`/api/apps/${record.id}/_duplicate`)).status, 201);
    const over = await as('anna').post(`/api/apps/${record.id}/_duplicate`);
    assert.deepEqual([over.status, over.body.code], [409, 'QUOTA_USER_APPS']);
  });

  it('needs the right to use the app and the right to create', async () => {
    api.addPerson('guest', {
      id: 'guest',
      name: 'Gus Guest',
      authMode: 'oidc',
      groups: ['guests']
    });
    const record = await sharedApp({ members: [member('guest', 'user')] });
    assert.deepEqual(problem(await as('guest').post(`/api/apps/${record.id}/_duplicate`)), {
      status: 403,
      code: 'PERMISSION_DENIED',
      details: { required: 'userApps' }
    });
    // Retired for a member: the company app is theirs to use.
    const gone = await sharedApp({ change: promoted });
    const retired = await as('ben').post(`/api/apps/${gone.id}/_duplicate`);
    assert.deepEqual([retired.status, retired.body.details.required], [403, 'use']);
  });

  it('lets the owner duplicate a published app that is retired for them (8.2)', async () => {
    const gone = await sharedApp({ change: promoted });
    assert.equal((await as('anna').get(`/api/apps/${gone.id}`)).body.state, 'retired');
    const res = await as('anna').post(`/api/apps/${gone.id}/_duplicate`);
    assert.equal(res.status, 201, res.text);
    const copy = await api.repo().get(res.body.id);
    assert.deepEqual(copy.content.system, gone.content.system);
    assert.equal(copy.state, 'active');
  });
});

describe('the view per role', () => {
  const COMMON = [
    'approval',
    'capabilities',
    'disabled',
    'id',
    'language',
    'owner',
    'ownership',
    'permissions',
    'revision',
    'sharedWith',
    'state',
    'updatedAt',
    'updatedBy'
  ];
  const EXPECTED = {
    // `publish`: what a publish would write, for an owner who may publish (9.1).
    anna: [...COMMON, 'members', 'pendingOwner', 'publish'],
    carol: [...COMMON, 'members'],
    dave: [...COMMON, 'members', 'pendingOwner'],
    root: [...COMMON, 'members', 'pendingOwner'],
    ben: COMMON
  };
  const APP_KEYS = new Set([...USER_APP_RUN_KEYS, ...Object.keys(USER_APP_SCHEMA_DEFAULTS)]);

  it('has exactly the fields of the role, on a read and on the answer of a write', async () => {
    const record = await sharedApp({ content: { capabilities: { upload: true } } });
    await api
      .repo()
      .setOffer(record.id, { id: 'dave', name: 'Dave Lund' }, { actor: { id: 'anna' } });

    const bodies = {};
    for (const who of Object.keys(EXPECTED)) {
      const res = await as(who).get(`/api/apps/${record.id}`);
      assert.equal(res.status, 200, `${who}: ${res.text}`);
      bodies[who] = res.body;
    }
    // The answer of a write is the same view.
    const write = await as('carol')
      .patch(`/api/apps/${record.id}`)
      .send({ description: { en: 'New' } });
    bodies.carol = write.body;

    for (const [who, body] of Object.entries(bodies)) {
      const beyondApp = Object.keys(body)
        .filter(key => !APP_KEYS.has(key) || key === 'id')
        .sort();
      assert.deepEqual(beyondApp, [...EXPECTED[who]].sort(), who);
      const text = JSON.stringify(body);
      for (const never of ['ownerPrincipal', 'contentHash', 'publishing', 'membersUpdatedBy']) {
        assert.equal(text.includes(never), false, `${who}: ${never}`);
      }
      assert.ok(text.includes(SECRET), `${who} reads the instructions`);
    }
    assert.deepEqual(
      Object.fromEntries(Object.entries(bodies).map(([who, body]) => [who, body.permissions.role])),
      { anna: 'owner', carol: 'editor', dave: 'offered', root: 'admin', ben: 'user' }
    );
    // "Can use" gets counts, no list, and no reason about the owner.
    assert.deepEqual(bodies.ben.sharedWith, { users: 2, groups: 0, everyone: false });
    for (const entry of bodies.ben.capabilities) {
      assert.equal('requested' in entry, false);
      assert.ok([undefined, 'youMayNot', 'unavailable'].includes(entry.reason), entry.reason);
    }
    assert.ok(bodies.anna.capabilities.every(entry => 'requested' in entry));
    assert.equal(bodies.anna.pendingOwner.id, 'dave');
  });

  it('GET answers the reduced body for a switched-off app, without instructions', async () => {
    const record = await sharedApp({ change: switchedOff });
    for (const who of ['anna', 'ben', 'carol']) {
      const res = await as(who).get(`/api/apps/${record.id}`);
      assert.equal(res.status, 200, res.text);
      assert.deepEqual(
        Object.keys(res.body).sort(),
        ['color', 'disabled', 'icon', 'id', 'name', 'owner', 'ownership', 'permissions', 'state'],
        who
      );
      assert.deepEqual(res.body.disabled, { at: '2026-11-20T10:00:00.000Z', reason: 'x' });
      assert.equal(res.text.includes(SECRET), false);
    }
  });
});

describe('POST /api/apps/_generate', () => {
  const generate = (who, body = { description: 'Summarize my mails', language: 'en' }) =>
    as(who).post('/api/apps/_generate').send(body);
  const on = (extra = {}) => setConfig({ features: { ...FEATURES, appGenerator: true }, ...extra });

  it('needs its feature and the right to create', async () => {
    setConfig({ features: { ...FEATURES, appGenerator: false } });
    assert.deepEqual(
      [(await generate('anna')).status, (await generate('anna')).body.code],
      [403, 'FEATURE_DISABLED']
    );
    on();
    api.addPerson('guest', {
      id: 'guest',
      name: 'Gus Guest',
      authMode: 'oidc',
      groups: ['guests']
    });
    assert.equal((await generate('guest')).body.code, 'PERMISSION_DENIED');
    assert.equal((await generate('anna', { description: '' })).body.code, 'VALIDATION_FAILED');
    assert.equal(api.drafts.length, 0);
  });

  it('answers the draft of the admin route, which fits into a personal app', async () => {
    on();
    const res = await generate('anna');
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(Object.keys(res.body).sort(), [
      'app',
      'brief',
      'model',
      'suggestions',
      'warnings'
    ]);
    assert.deepEqual(res.body.app.name, { en: 'Mail summary' });
    // Nothing of an admin app: the free admin ID would tell which app IDs exist.
    for (const key of ['id', 'category', 'order', 'enabled']) {
      assert.equal(key in res.body.app, false, key);
    }
    assert.deepEqual(res.body.suggestions, { websearch: false, integrations: [] });
    assert.equal(api.drafts.length, 1);
    // Nothing is stored.
    assert.equal((await api.repo().listOwned('anna')).length, 0);
  });

  it('never suggests a capability personal apps may not use on the installation', async t => {
    api.model.answer = {
      name: 'Tickets',
      system: 'You look up tickets.',
      description: 'Looks up tickets.',
      websearch: { enabled: true },
      integrations: [{ id: 'jira' }, { id: 'wiki', actions: ['find'] }]
    };
    t.after(() => {
      api.model.answer = { name: 'Mail summary', system: 'You summarize mails.', description: 'x' };
    });
    t.mock.method(installedIntegrationService, 'resolveAllEnabled', async () => [
      {
        instance: JIRA,
        label: 'Jira',
        definition: {
          name: { en: 'Jira' },
          actions: [{ name: 'search' }, { name: 'read' }, { name: 'delete' }]
        }
      },
      {
        instance: { id: 'wiki', definition: 'wiki', enabled: true },
        label: 'Wiki',
        definition: { name: { en: 'Wiki' }, actions: [{ name: 'find' }] }
      }
    ]);
    const installed = { installed: [JIRA, { id: 'wiki', definition: 'wiki', enabled: true }] };

    // Nothing is allowed for personal apps: nothing is suggested, and the brief lists nothing.
    on({ integrations: installed, userApps: { capabilities: { webSearch: false } } });
    const none = await generate('anna');
    assert.equal(none.status, 200, none.text);
    assert.deepEqual(none.body.suggestions, { websearch: false, integrations: [] });
    const brief = JSON.stringify(api.drafts.at(-1).messages);
    assert.equal(brief.includes('INSTALLED_SYSTEMS'), false);

    // Jira is allowed with two actions: it is suggested with exactly those, the wiki is not.
    on({
      integrations: installed,
      userApps: { capabilities: { integrations: [{ id: 'jira', actions: ['search', 'read'] }] } }
    });
    const some = await generate('anna');
    assert.deepEqual(some.body.suggestions.integrations, [
      { id: 'jira', label: 'Jira', actions: ['search', 'read'] }
    ]);
    // Web search is allowed by the settings, but no search engine is available to the caller.
    assert.equal(some.body.suggestions.websearch, false);
    const listed = JSON.stringify(api.drafts.at(-1).messages);
    assert.ok(listed.includes('- jira (Jira'));
    assert.equal(listed.includes('wiki'), false);
    assert.equal(listed.includes('delete'), false);

    // A caller whose groups do not grant the installation.
    assert.deepEqual((await generate('nora')).body.suggestions.integrations, []);
  });

  it('counts against the draft limit of the admin route, failed drafts included', async () => {
    on();
    api.addPerson('eve', { id: 'eve', name: 'Eve', authMode: 'oidc', groups: ['users'] });
    for (let index = 0; index < 30; index += 1) {
      assert.equal((await generate('eve')).status, 200);
    }
    const over = await generate('eve');
    assert.equal(over.status, 429, over.text);
    assert.equal(over.body.code, 'RATE_LIMITED');
    assert.equal(over.body.details.limiter, 'appGenerator');
    // Per user.
    assert.equal((await generate('carol')).status, 200);
  });

  it('shares one budget of drafts with the admin route, on a single worker too', async () => {
    on();
    // The admin route on an Express app of its own, registered after the user
    // routes of this file: it mounts the same limiter instance.
    const { default: express } = await import('express');
    const { default: request } = await import('supertest');
    const { default: registerAdminAppBuilderRoutes } =
      await import('../routes/admin/appBuilder.js');
    const { default: errorHandler } = await import('../middleware/errorHandler.js');
    const admin = express();
    admin.use(express.json());
    admin.use((req, _res, next) => {
      req.user = api.user('root');
      next();
    });
    registerAdminAppBuilderRoutes(admin, {
      llmClient: { complete: async () => ({ content: '{}', finishReason: 'stop', usage: null }) }
    });
    admin.use(errorHandler);

    for (let index = 0; index < 30; index += 1) {
      assert.equal((await generate('root')).status, 200);
    }
    const over = await request(admin)
      .post('/api/admin/apps/_generate')
      .send({ description: 'Summarize my mails', language: 'en' });
    assert.equal(over.status, 429, over.text);
    assert.equal(over.body.details.limiter, 'appGenerator');
  });
});

describe('the draft of a personal app', () => {
  const raw = {
    name: 'Tickets',
    system: 'You look up tickets.',
    description: 'x',
    websearch: true,
    integrations: [{ id: 'jira' }, { id: 'mcp' }, { id: 'wiki', actions: ['find', 'made-up'] }]
  };
  const installed = [
    { id: 'jira', label: 'Jira', actions: ['search', 'read'] },
    { id: 'mcp', label: 'MCP server', actions: [] },
    { id: 'wiki', label: 'Wiki', actions: ['find', 'edit'] }
  ];

  it('names the actions of every suggested binding, and drops one that has none', () => {
    const personal = sanitizeGeneratedApp(raw, { installed, personal: { webSearch: false } });
    assert.deepEqual(personal.suggestions, {
      websearch: false,
      integrations: [
        { id: 'jira', label: 'Jira', actions: ['search', 'read'] },
        { id: 'wiki', label: 'Wiki', actions: ['find'] }
      ]
    });
    assert.equal(
      sanitizeGeneratedApp(raw, { installed, personal: { webSearch: true } }).suggestions.websearch,
      true
    );
    // The admin draft is unchanged: "all functions" stays an empty list.
    const admin = sanitizeGeneratedApp(raw, { installed });
    assert.equal(admin.suggestions.websearch, true);
    assert.deepEqual(
      admin.suggestions.integrations.map(entry => [entry.id, entry.actions]),
      [
        ['jira', []],
        ['mcp', []],
        ['wiki', ['find']]
      ]
    );
  });

  it('has the limits of a personal app', () => {
    for (const [key, value] of Object.entries(DRAFT_LIMITS)) {
      assert.equal(value, USER_APP_LIMITS[key], key);
    }
    assert.equal(Object.keys(DRAFT_LIMITS).length, 14);
    assert.equal(userAppSettings({}).capabilities.webSearch, false);
  });
});
