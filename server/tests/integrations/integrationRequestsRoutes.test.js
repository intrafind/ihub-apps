// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Users request catalog integrations, admins work the queue (#2926):
 *
 *   GET  /api/integrations/requests, POST /api/integrations/requests
 *   GET  /api/admin/integrations/requests
 *   POST /api/admin/integrations/requests/:id/_approve | _decline
 *   DELETE /api/admin/integrations/requests/hidden/:definitionId
 *
 * - one open request per user and definition, also on the document store;
 * - anonymous and delegated callers cannot request; inputs are validated;
 * - non-admins are refused on the admin routes;
 * - approve, decline, decline and hide (hidden for every user, the other
 *   open requests declined), show again;
 * - a request closes when an enabled installation its requester's groups
 *   allow exists: on install, and when the queue is read after a group change;
 * - `integration.request` and `integration.requestDecision` audit entries.
 *
 * Run: node --test server/tests/integrations/integrationRequestsRoutes.test.js
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scratchDocuments } from '../helpers/testStorage.js';

const scratch = await scratchDocuments();

// The audit log lands in a contents directory of its own; config reads it on import.
const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'integration-requests-'));
process.env.CONTENTS_DIR = path.join(tmpDir, 'contents');

const { default: configCache } = await import('../../configCache.js');
const { default: integrationRegistry } =
  await import('../../services/integrations/definitions/IntegrationRegistry.js');
const { default: integrationRequestRoutes } =
  await import('../../routes/integrations/integrationRequests.js');
const { default: registerAdminIntegrationRequestRoutes, closeRequestsFor } =
  await import('../../routes/admin/integrationRequests.js');
const {
  IntegrationRequestService,
  MAX_REASON_LENGTH,
  requestIdFor,
  setIntegrationRequestServiceForTests
} = await import('../../services/integrations/IntegrationRequestService.js');
const { flushAuditLog, queryAuditLog } = await import('../../services/AuditLogService.js');
const { FilesystemStorageProvider } = await import('../../storage/providers/filesystem/index.js');

const definition = (id, extra = {}) => ({
  id,
  version: '1.0.0',
  name: { en: id.split('/')[1].toUpperCase(), de: id.split('/')[1].toUpperCase() },
  description: { en: `About ${id}` },
  publisher: { name: 'Example' },
  categories: ['knowledge'],
  capabilities: ['tools'],
  protocol: { type: 'openapi' },
  auth: { modes: ['none'] },
  install: [{ key: 'baseUrl', type: 'url' }],
  actions: [
    { name: 'search', sideEffect: 'read' },
    { name: 'file', sideEffect: 'write' }
  ],
  ...extra
});
const ENTRIES = [
  { definition: definition('com.example/docs'), status: 'ok', source: 'shipped' },
  { definition: definition('com.example/crm'), status: 'ok', source: 'shipped' },
  { definition: definition('com.intrafind/jira'), status: 'ok', source: 'shipped' },
  {
    definition: definition('com.intrafind/ihub', { alwaysInstalled: true }),
    status: 'ok',
    source: 'shipped'
  },
  { definition: definition('com.example/old'), status: 'incompatible', source: 'shipped' },
  // Built by an admin in iHub: never offered to users outside its groups.
  { definition: definition('custom/crm-tools'), status: 'ok', source: 'custom' }
];

const state = { installed: [], groups: null, platform: null };
const integrationsConfig = () => ({ installed: state.installed });
const baseGroups = () => ({
  admins: { id: 'admins', permissions: { adminAccess: true, integrations: ['*'] } },
  users: { id: 'users', permissions: { integrations: ['jira-main'] } },
  legal: { id: 'legal', permissions: { integrations: ['com.example/docs'] } },
  anonymous: { id: 'anonymous', permissions: { integrations: [] } }
});

const saved = {};
before(() => {
  for (const key of ['getIntegrations', 'get', 'getPlatform', 'getFeatures', 'getGroups']) {
    saved[key] = configCache[key];
  }
  for (const key of ['ensureLoaded', 'list', 'get'])
    saved[`registry.${key}`] = integrationRegistry[key];
  configCache.getIntegrations = () => ({ data: integrationsConfig() });
  configCache.get = key =>
    key === 'config/integrations.json'
      ? { data: integrationsConfig() }
      : saved.get.call(configCache, key);
  configCache.getPlatform = () => state.platform;
  configCache.getFeatures = () => ({ integrations: true });
  configCache.getGroups = () => ({ data: { groups: state.groups } });
  integrationRegistry.ensureLoaded = async () => {};
  integrationRegistry.list = () => ENTRIES;
  integrationRegistry.get = id => ENTRIES.find(entry => entry.definition.id === id) || null;
});
after(async () => {
  for (const key of ['getIntegrations', 'get', 'getPlatform', 'getFeatures', 'getGroups']) {
    configCache[key] = saved[key];
  }
  for (const key of ['ensureLoaded', 'list', 'get'])
    integrationRegistry[key] = saved[`registry.${key}`];
  await flushAuditLog();
  rmSync(tmpDir, { recursive: true, force: true });
});

const USERS = {
  alice: { id: 'alice', name: 'Alice', groups: ['users'] },
  bob: { id: 'bob', name: 'Bob', groups: ['users'] },
  carol: { id: 'carol', name: 'Carol', groups: ['users', 'legal'] },
  admin: { id: 'admin', name: 'Admin', isAdmin: true, isContentAdmin: true, groups: ['admins'] },
  client: { id: 'alice', name: 'Alice', groups: ['users'], isOAuthClient: true },
  aliceKey: { id: 'alice', name: 'Alice', groups: ['users'], authMode: 'oauth_personal_key' }
};

const { default: errorHandler } = await import('../../middleware/errorHandler.js');
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.user = USERS[req.headers['x-test-user']] || { id: 'anonymous', groups: ['anonymous'] };
  next();
});
app.use('/api/integrations/requests', integrationRequestRoutes);
registerAdminIntegrationRequestRoutes(app);
app.use(errorHandler);

const asUser = (user, method, url) => {
  const r = request(app)[method](url);
  return user ? r.set('x-test-user', user) : r;
};
const ask = (user, body) => asUser(user, 'post', '/api/integrations/requests').send(body ?? {});
const catalog = async user => {
  const res = await asUser(user, 'get', '/api/integrations/requests');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.items;
};
const queue = async () => {
  const res = await asUser('admin', 'get', '/api/admin/integrations/requests');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
};
const decide = (id, action, body = {}, user = 'admin') =>
  asUser(user, 'post', `/api/admin/integrations/requests/${id}/${action}`).send(body);

beforeEach(async () => {
  await scratch.reset();
  state.installed = [
    { id: 'jira-main', definition: 'com.intrafind/jira', enabled: true, values: {} }
  ];
  state.groups = baseGroups();
  state.platform = { anonymousAuth: { enabled: false } };
  setIntegrationRequestServiceForTests(
    new IntegrationRequestService({ documents: scratch.documents })
  );
});

describe('the user side', () => {
  it('lists what the user cannot use yet: not installed, not granted, not hidden', async () => {
    const items = await catalog('alice');
    assert.deepEqual(
      items.map(item => item.definition),
      ['com.example/crm', 'com.example/docs']
    );
    const docs = items.find(item => item.definition === 'com.example/docs');
    assert.deepEqual(docs, {
      definition: 'com.example/docs',
      name: 'DOCS',
      description: 'About com.example/docs',
      icon: null,
      publisher: 'Example',
      categories: ['knowledge'],
      capabilities: ['tools'],
      actionCount: 2,
      effects: ['read', 'write'],
      request: null
    });
    // jira-main is available to alice; ihub is always installed; old is
    // incompatible; custom/crm-tools is an admin's own build.
  });

  it('records a request, shows it as requested and refuses a second one', async () => {
    const first = await ask('alice', {
      definition: 'com.example/docs',
      reason: '  For contracts '
    });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.request.status, 'open');
    assert.equal(first.body.request.reason, 'For contracts');
    assert.equal(first.body.request.id, requestIdFor('alice', 'com.example/docs'));

    const second = await ask('alice', { definition: 'com.example/docs' });
    assert.equal(second.status, 409);
    assert.equal(second.body.code, 'REQUEST_EXISTS');

    const docs = (await catalog('alice')).find(item => item.definition === 'com.example/docs');
    assert.equal(docs.request.status, 'open');
    // Another user's request is their own.
    assert.equal((await ask('bob', { definition: 'com.example/docs' })).status, 201);
    const forBob = (await catalog('bob')).find(item => item.definition === 'com.example/docs');
    assert.equal(forBob.request.reason, null);
  });

  it('refuses anonymous callers, also when anonymous access is on', async () => {
    assert.equal((await ask(null, { definition: 'com.example/docs' })).status, 401);
    assert.equal((await asUser(null, 'get', '/api/integrations/requests')).status, 401);
    state.platform = { anonymousAuth: { enabled: true, defaultGroups: ['anonymous'] } };
    assert.equal((await ask(null, { definition: 'com.example/docs' })).status, 401);
    assert.equal((await asUser(null, 'get', '/api/integrations/requests')).status, 401);
  });

  it('refuses delegated callers and bodies that are not JSON', async () => {
    const delegated = await ask('client', { definition: 'com.example/docs' });
    assert.equal(delegated.status, 403);
    assert.equal(delegated.body.code, 'INTERACTIVE_SESSION_REQUIRED');
    // A personal API key is a bearer token too, even with the user's own groups.
    const personalKey = await ask('aliceKey', { definition: 'com.example/docs' });
    assert.equal(personalKey.status, 403);
    assert.equal(personalKey.body.code, 'INTERACTIVE_SESSION_REQUIRED');
    const form = await asUser('alice', 'post', '/api/integrations/requests')
      .type('form')
      .send('definition=com.example/docs');
    assert.equal(form.status, 415);
  });

  it('validates the definition id and the reason', async () => {
    for (const bad of [undefined, '', '../etc', 'A/B', 'a/b/c', `x/${'a'.repeat(200)}`, 42]) {
      const res = await ask('alice', { definition: bad });
      assert.equal(res.status, 400, `definition ${String(bad)}`);
      assert.equal(res.body.code, 'INVALID_DEFINITION');
    }
    const long = await ask('alice', {
      definition: 'com.example/docs',
      reason: 'x'.repeat(MAX_REASON_LENGTH + 1)
    });
    assert.equal(long.status, 400);
    assert.equal(long.body.code, 'REASON_TOO_LONG');
    const notText = await ask('alice', { definition: 'com.example/docs', reason: { a: 1 } });
    assert.equal(notText.body.code, 'INVALID_REASON');
    assert.equal(
      (await ask('alice', { definition: 'com.example/docs', reason: 'x'.repeat(500) })).status,
      201
    );
  });

  it('answers 404 for definitions the user cannot request', async () => {
    for (const id of [
      'com.example/nope', // unknown
      'com.intrafind/jira', // already available to alice
      'com.intrafind/ihub', // always installed
      'com.example/old', // incompatible
      'custom/crm-tools' // built by an admin in iHub
    ]) {
      const res = await ask('alice', { definition: id });
      assert.equal(res.status, 404, id);
      assert.equal(res.body.code, 'INTEGRATION_NOT_FOUND');
    }
  });
});

describe('the admin queue', () => {
  it('refuses non-admins and anonymous callers', async () => {
    const id = requestIdFor('alice', 'com.example/docs');
    for (const user of ['alice', 'client', null]) {
      assert.equal(
        (await asUser(user, 'get', '/api/admin/integrations/requests')).status,
        403,
        String(user)
      );
      assert.equal((await decide(id, '_approve', {}, user)).status, 403);
      assert.equal((await decide(id, '_decline', { hide: true }, user)).status, 403);
      assert.equal(
        (await asUser(user, 'delete', '/api/admin/integrations/requests/hidden/com.example%2Fdocs'))
          .status,
        403
      );
    }
  });

  it('lists the requests with names, an open count and the hidden list', async () => {
    await ask('alice', { definition: 'com.example/docs', reason: 'Contracts' });
    await ask('bob', { definition: 'com.example/crm' });
    const body = await queue();
    assert.equal(body.openCount, 2);
    assert.deepEqual(body.hidden, []);
    const docs = body.requests.find(r => r.definition === 'com.example/docs');
    assert.equal(docs.definitionName, 'DOCS');
    assert.equal(docs.definitionAvailable, true);
    assert.deepEqual(docs.installedInstances, []);
    assert.deepEqual(docs.requester, { id: 'alice', name: 'Alice', groups: ['users'] });
    assert.equal(docs.reason, 'Contracts');
  });

  it('approves: the request waits for the install and still counts as open for the user', async () => {
    await ask('alice', { definition: 'com.example/docs' });
    const id = requestIdFor('alice', 'com.example/docs');
    const res = await decide(id, '_approve', { note: 'Installing it this week' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.request.status, 'approved');
    assert.deepEqual(res.body.request.decidedBy, { id: 'admin', name: 'Admin' });
    assert.equal((await queue()).openCount, 0);
    // Still one standing request: a second is refused.
    assert.equal((await ask('alice', { definition: 'com.example/docs' })).status, 409);
    const docs = (await catalog('alice')).find(item => item.definition === 'com.example/docs');
    assert.equal(docs.request.status, 'approved');
    assert.equal(docs.request.note, 'Installing it this week');
  });

  it('declines with a note; the user sees it and may ask again', async () => {
    await ask('bob', { definition: 'com.example/docs' });
    const id = requestIdFor('bob', 'com.example/docs');
    const res = await decide(id, '_decline', { note: 'Not licensed' });
    assert.equal(res.status, 200);
    assert.equal(res.body.request.status, 'declined');
    assert.equal(res.body.request.hidden, false);
    const docs = (await catalog('bob')).find(item => item.definition === 'com.example/docs');
    assert.equal(docs.request.status, 'declined');
    assert.equal(docs.request.note, 'Not licensed');
    // A closed request cannot be decided again.
    assert.equal((await decide(id, '_approve')).body.code, 'REQUEST_CLOSED');
    assert.equal((await decide(id, '_decline')).status, 409);
    // Asking again opens a new request.
    const again = await ask('bob', { definition: 'com.example/docs' });
    assert.equal(again.status, 201);
    assert.equal(again.body.request.status, 'open');
  });

  it('declines and hides: gone from every user, the other open requests declined, shown again', async () => {
    await ask('carol', { definition: 'com.example/crm' });
    await ask('alice', { definition: 'com.example/crm' });
    const res = await decide(requestIdFor('carol', 'com.example/crm'), '_decline', {
      hide: true
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.request.hidden, true);
    assert.equal(res.body.alsoDeclined, 1);

    for (const user of ['alice', 'bob', 'carol']) {
      assert.ok(
        !(await catalog(user)).some(item => item.definition === 'com.example/crm'),
        `${user} still sees crm`
      );
    }
    assert.equal((await ask('bob', { definition: 'com.example/crm' })).status, 404);
    const body = await queue();
    assert.equal(body.openCount, 0);
    assert.deepEqual(
      body.hidden.map(entry => [entry.definition, entry.name, entry.hiddenBy.id]),
      [['com.example/crm', 'CRM', 'admin']]
    );
    assert.equal(body.requests.find(r => r.requester.id === 'alice').status, 'declined');

    const shown = await asUser(
      'admin',
      'delete',
      '/api/admin/integrations/requests/hidden/com.example%2Fcrm'
    );
    assert.equal(shown.status, 204);
    assert.ok((await catalog('bob')).some(item => item.definition === 'com.example/crm'));
    const twice = await asUser(
      'admin',
      'delete',
      '/api/admin/integrations/requests/hidden/com.example%2Fcrm'
    );
    assert.equal(twice.status, 404);
    const bad = await asUser('admin', 'delete', '/api/admin/integrations/requests/hidden/..%2F..');
    assert.equal(bad.status, 400);
  });

  it('validates ids, the note and hide', async () => {
    await ask('alice', { definition: 'com.example/docs' });
    const id = requestIdFor('alice', 'com.example/docs');
    assert.equal((await decide('nope', '_approve')).status, 404);
    assert.equal((await decide(`ireq_${'0'.repeat(32)}`, '_approve')).status, 404);
    assert.equal(
      (await decide(id, '_decline', { note: 'x'.repeat(501) })).body.code,
      'NOTE_TOO_LONG'
    );
    assert.equal((await decide(id, '_decline', { note: 5 })).body.code, 'INVALID_NOTE');
    assert.equal((await decide(id, '_decline', { hide: 'yes' })).body.code, 'INVALID_HIDE');
  });
});

describe('closing on install', () => {
  it('closes a request when the definition is installed for the requester groups', async () => {
    await ask('carol', { definition: 'com.example/docs' });
    await ask('alice', { definition: 'com.example/docs' });
    await decide(requestIdFor('carol', 'com.example/docs'), '_approve');

    // Installed; `legal` (carol) grants the definition, `users` (alice) does not.
    state.installed.push({
      id: 'docs-main',
      definition: 'com.example/docs',
      enabled: true,
      values: {}
    });
    const closed = await closeRequestsFor({ user: USERS.admin, headers: {} }, 'com.example/docs');
    assert.deepEqual(
      closed.map(r => [r.requester.id, r.status, r.fulfilledBy]),
      [['carol', 'fulfilled', 'docs-main']]
    );
    let body = await queue();
    assert.equal(body.requests.find(r => r.requester.id === 'alice').status, 'open');
    assert.deepEqual(body.requests.find(r => r.requester.id === 'alice').installedInstances, [
      'docs-main'
    ]);

    // The admin grants it to `users` later: reading the queue closes alice's too.
    state.groups.users.permissions.integrations.push('docs-main');
    body = await queue();
    assert.equal(body.requests.find(r => r.requester.id === 'alice').status, 'fulfilled');
    assert.equal(body.openCount, 0);
    assert.ok(!(await catalog('alice')).some(item => item.definition === 'com.example/docs'));
  });

  it('does not close on a disabled installation', async () => {
    await ask('carol', { definition: 'com.example/docs' });
    state.installed.push({
      id: 'docs-main',
      definition: 'com.example/docs',
      enabled: false,
      values: {}
    });
    assert.deepEqual(await closeRequestsFor({ user: USERS.admin, headers: {} }), []);
    assert.equal((await queue()).openCount, 1);
  });
});

describe('the audit log', () => {
  it('records integration.request and integration.requestDecision', async () => {
    await ask('alice', { definition: 'com.example/crm' });
    await decide(requestIdFor('alice', 'com.example/crm'), '_decline', { hide: true });
    await flushAuditLog();
    const { entries } = await queryAuditLog({
      resource: 'integration',
      action: ['request', 'requestDecision'],
      limit: 500
    });
    const mine = entries.filter(entry => entry.resourceId === 'com.example/crm');
    assert.ok(mine.some(entry => entry.action === 'request' && entry.actor.id === 'alice'));
    assert.ok(
      mine.some(
        entry =>
          entry.action === 'requestDecision' &&
          entry.actor.id === 'admin' &&
          /hid it from the catalog/.test(entry.summary)
      )
    );
  });
});

describe('on the document store', () => {
  it('keeps one open request per user and definition, owned by the user', async () => {
    const dir = mkdtempSync(path.join(tmpDir, 'store-'));
    const provider = new FilesystemStorageProvider({ baseDir: dir, flushIntervalMs: 25 });
    await provider.initialize();
    try {
      const service = new IntegrationRequestService({ documents: provider.documents });
      const user = USERS.alice;
      const created = await service.create({ user, definition: 'com.example/docs' });
      // Two workers at once: exactly one wins.
      const racing = await Promise.allSettled([
        service.create({ user: USERS.bob, definition: 'com.example/docs' }),
        service.create({ user: USERS.bob, definition: 'com.example/docs' })
      ]);
      assert.equal(racing.filter(r => r.status === 'fulfilled').length, 1);
      assert.equal(racing.find(r => r.status === 'rejected').reason.code, 'REQUEST_EXISTS');
      await assert.rejects(service.create({ user, definition: 'com.example/docs' }), {
        code: 'REQUEST_EXISTS'
      });
      assert.deepEqual(
        (await service.listForUser('alice')).map(r => r.id),
        [created.id]
      );
      await service.decide(created.id, { decision: 'declined', admin: USERS.admin, hide: true });
      assert.deepEqual([...(await service.hiddenDefinitions())], ['com.example/docs']);
      // Bob's open request for the hidden definition was declined with it.
      assert.equal((await service.listForUser('bob'))[0].status, 'declined');
      const again = await service.create({ user, definition: 'com.example/docs' });
      assert.equal(again.status, 'open');
      assert.equal(await service.forgetUser('alice'), 1);
      assert.deepEqual(await service.listForUser('alice'), []);
      assert.equal(await service.unhide('com.example/docs'), true);
    } finally {
      await provider.shutdown();
    }
  });
});
