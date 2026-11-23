// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `POST /api/apps/_revise`: one turn of the conversation that changes a
 * personal app (issue #3898).
 *
 * The gate of the personal routes (signed in, feature `userApps`, a sign-in
 * that can hold personal apps, the right to create them or to edit the app
 * `appId` names), the feature `appGenerator`, the personal content keys and
 * ceiling, and the revise limit shared with the admin route.
 *
 * The real user routes and services run over the harness of personal apps
 * (`helpers/userAppRoutesApi.js`). The only stub is the model client.
 *
 * Run: node --test server/tests/app-revise-route-personal.test.js
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import installedIntegrationService from '../services/integrations/InstalledIntegrationService.js';
import { resetAppReviseLimiter } from '../middleware/rateLimiting.js';
import { flushAuditLog, queryAuditLog } from '../services/AuditLogService.js';
import { FEATURES, UNKNOWN_PERSONAL_ID, member, setConfig } from './helpers/userAppsHarness.js';
import { USERS, startUserAppRoutesApi } from './helpers/userAppRoutesApi.js';

/** Every call of the stubbed model, and what it answers. */
const llm = { calls: [], answer: null };

let api;
let as;

before(async () => {
  // A limiter of its own for this file's routes: registered after this reset.
  resetAppReviseLimiter();
  api = await startUserAppRoutesApi({
    llmClient: {
      complete: async call => {
        llm.calls.push(call);
        return { content: JSON.stringify(llm.answer), finishReason: 'stop', usage: null };
      }
    }
  });
  ({ as } = api);
});
after(() => api.stop());
beforeEach(async () => {
  await api.reset();
  llm.calls = [];
  llm.answer = { reply: 'change', text: 'Done.', change: { system: 'You write short job ads.' } };
});

const DRAFT = {
  name: { en: 'Job ad writer' },
  description: { en: 'Drafts a job ad from notes' },
  system: { en: 'You write job ads.' },
  icon: 'document-text',
  color: '#4F46E5',
  variables: [],
  starterPrompts: [],
  preferredModel: 'oa',
  capabilities: { upload: false, webSearch: false, skills: false, integrations: [] }
};
const BODY = (extra = {}) => ({
  draft: DRAFT,
  conversation: [{ role: 'author', text: 'Make it shorter' }],
  ...extra
});
const revise = (who, body = BODY()) => as(who).post('/api/apps/_revise').send(body);
const problem = res => [res.status, res.body?.code];

describe('the gate of POST /api/apps/_revise', () => {
  it('answers 401 without a sign-in', async () => {
    assert.deepEqual(problem(await revise('anonymous')), [401, 'AUTH_REQUIRED']);
  });

  it('answers 403 USER_APPS_DISABLED with personal apps off', async () => {
    setConfig({ features: { ...FEATURES, userApps: false } });
    assert.deepEqual(problem(await revise('anna')), [403, 'USER_APPS_DISABLED']);
  });

  it('refuses a sign-in that cannot hold personal apps', async () => {
    for (const who of ['client', 'agent', 'benDelegated']) {
      assert.deepEqual(problem(await revise(who)), [403, 'PERMISSION_DENIED'], who);
    }
  });

  it('refuses a caller who may not create personal apps', async () => {
    api.addPerson('guest', { id: 'guest', name: 'Gus', authMode: 'oidc', groups: ['guests'] });
    assert.deepEqual(problem(await revise('guest')), [403, 'PERMISSION_DENIED']);
  });

  it('answers 403 FEATURE_DISABLED with appGenerator off', async () => {
    setConfig({ features: { ...FEATURES, appGenerator: false } });
    assert.deepEqual(problem(await revise('anna')), [403, 'FEATURE_DISABLED']);
  });

  it('calls the model for none of them', async () => {
    await revise('anonymous');
    await revise('client');
    assert.equal(llm.calls.length, 0);
  });
});

describe('a turn on a personal app', () => {
  it('answers the turn, with the personal content keys only', async () => {
    llm.answer = {
      reply: 'change',
      text: 'Done.',
      change: {
        system: 'You write short job ads.',
        category: 'writing',
        preferredModel: 'restricted',
        capabilities: { webSearch: true, integrations: [{ id: 'jira', actions: ['search'] }] },
        id: 'chat'
      }
    };
    const res = await revise('anna');
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.body.patch, { system: { en: 'You write short job ads.' } });
    assert.deepEqual(res.body.changed, ['system']);
    assert.deepEqual(
      res.body.warnings
        .filter(warning => warning.code === 'KEY_IGNORED')
        .map(warning => warning.field)
        .sort(),
      ['capabilities', 'category', 'id', 'preferredModel']
    );
    // The brief offers only the personal keys.
    const system = llm.calls[0].messages[0].content;
    assert.equal(system.includes('"category"'), false);
    assert.equal(llm.calls[0].telemetry.purpose, 'app-revise');
    // Nothing is stored.
    assert.equal((await api.repo().listOwned('anna')).length, 0);
  });

  it('refuses fields outside the personal content keys', async () => {
    const res = await revise('anna', BODY({ fields: ['category'] }));
    assert.equal(res.status, 400, res.text);
    assert.deepEqual(
      res.body.errors.map(entry => entry.pointer),
      ['/fields/0']
    );
    assert.equal(llm.calls.length, 0);
  });

  it('suggests only what personal apps may use and the caller may use', async t => {
    const JIRA = { id: 'jira', definition: 'jira', enabled: true };
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
    setConfig({
      integrations: { installed: [JIRA], security: { blockPrivateIps: true, allowedHosts: [] } },
      userApps: { capabilities: { integrations: [{ id: 'jira', actions: ['search', 'read'] }] } }
    });
    llm.answer = {
      reply: 'change',
      text: 'Done.',
      change: {
        system: 'You look up issues.',
        websearch: { enabled: true },
        integrations: [{ id: 'jira' }, { id: 'wiki', actions: ['find'] }]
      }
    };
    const res = await revise('anna');
    assert.equal(res.status, 200, res.text);
    // No search engine is installed; the wiki is not allowed for personal apps.
    assert.deepEqual(res.body.suggestions, {
      websearch: false,
      integrations: [{ id: 'jira', label: 'Jira', actions: ['search', 'read'] }]
    });
    assert.equal('integrations' in res.body.patch, false);
    // Nora's group grants no integration.
    assert.deepEqual((await revise('nora')).body.suggestions.integrations, []);
  });

  it('writes one audit entry without texts', async () => {
    const res = await revise(
      'anna',
      BODY({ conversation: [{ role: 'author', text: 'AUDIT-AUTHOR-mark shorter please' }] })
    );
    assert.equal(res.status, 200, res.text);
    const { entries } = await queryAuditLog({ resource: 'userApp', limit: 1000 });
    const entry = entries.find(candidate => candidate.details?.purpose === 'app-revise');
    assert.ok(entry);
    assert.deepEqual(entry.details, {
      purpose: 'app-revise',
      modelId: 'oa',
      reply: 'change',
      changed: ['system'],
      conversationLength: 1,
      lastMessageLength: 'AUDIT-AUTHOR-mark shorter please'.length
    });
    assert.equal(JSON.stringify(entry).includes('AUDIT-AUTHOR-mark'), false);
    assert.equal(JSON.stringify(entry).includes('job ads'), false);
  });
});

describe('a turn for an app the caller may edit (appId)', () => {
  /** A person of the group `guests`: they may neither create nor share personal apps. */
  const addGuest = id =>
    api.addPerson(id, { id, name: `Guest ${id}`, authMode: 'oidc', groups: ['guests'] });

  /** An app of Anna, shared with `editor` ("Can edit") and `reader` ("Can use"). */
  const sharedApp = ({ editor = 'gus', reader = 'ben' } = {}) =>
    api.createApp('anna', { members: [member(editor, 'editor'), member(reader, 'user')] });

  beforeEach(() => {
    addGuest('gus');
    addGuest('gwen');
  });

  it('answers an editor who may not create personal apps, with the appId', async () => {
    const record = await sharedApp();
    // Without the app Gus is refused: he may not create personal apps.
    assert.deepEqual(problem(await revise('gus')), [403, 'PERMISSION_DENIED']);

    const res = await revise('gus', BODY({ appId: record.id }));
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.body.patch, { system: { en: 'You write short job ads.' } });
    assert.equal(llm.calls.length, 1);

    // The audit entry names the app, never a text.
    const { entries } = await queryAuditLog({ resource: 'userApp', limit: 1000 });
    const entry = entries.find(
      candidate =>
        candidate.details?.purpose === 'app-revise' && candidate.details?.appId === record.id
    );
    assert.ok(entry);
    assert.equal(entry.result, 'success');
    assert.equal(JSON.stringify(entry).includes('Make it shorter'), false);
  });

  it('answers the owner with the appId, as without it', async () => {
    const record = await sharedApp();
    const res = await revise('anna', BODY({ appId: record.id }));
    assert.equal(res.status, 200, res.text);
  });

  it('refuses a reader of a shared app as PATCH does', async () => {
    const record = await sharedApp({ reader: 'gwen' });
    const res = await revise('gwen', BODY({ appId: record.id }));
    assert.deepEqual(problem(res), [403, 'PERMISSION_DENIED']);
    assert.deepEqual(res.body.details, { required: 'edit' });
    const patch = await as('gwen')
      .patch(`/api/apps/${record.id}`)
      .send({ name: { en: 'x' } });
    assert.deepEqual(problem(patch), problem(res));
    assert.equal(llm.calls.length, 0);
  });

  it('answers an unknown app and an app the caller cannot see alike: the 404 of an unknown ID', async () => {
    // Shared with Gus and Ben, not with Gwen.
    const hidden = await sharedApp();
    const unknown = await revise('gwen', BODY({ appId: UNKNOWN_PERSONAL_ID }));
    const notShared = await revise('gwen', BODY({ appId: hidden.id }));
    assert.deepEqual(problem(unknown), [404, 'NOT_FOUND']);
    assert.deepEqual(problem(notShared), problem(unknown));
    assert.deepEqual(notShared.body.detail, unknown.body.detail);
    // The same answer as PATCH gives for it.
    const patch = await as('gwen')
      .patch(`/api/apps/${hidden.id}`)
      .send({ name: { en: 'x' } });
    assert.deepEqual(problem(patch), problem(unknown));
    assert.equal(llm.calls.length, 0);
  });

  it('refuses a caller who may not create and sends no appId, with the code of today', async () => {
    const res = await revise('gwen');
    assert.deepEqual(problem(res), [403, 'PERMISSION_DENIED']);
    assert.deepEqual(res.body.details, { required: 'userApps' });
  });

  it('still answers a caller who may create personal apps without an appId', async () => {
    assert.equal((await revise('carol')).status, 200);
  });

  it('refuses a malformed appId with 400 and a pointer, before the access check', async () => {
    for (const appId of ['chat', 'uap_XYZ', 42, '', { id: 'x' }]) {
      const res = await revise('gwen', BODY({ appId }));
      assert.deepEqual(problem(res), [400, 'VALIDATION_FAILED'], JSON.stringify(appId));
      assert.deepEqual(
        res.body.errors.map(entry => entry.pointer),
        ['/appId']
      );
    }
    assert.equal(llm.calls.length, 0);
  });

  it('keeps the gate of the feature switches', async () => {
    const record = await sharedApp();
    setConfig({ features: { ...FEATURES, appGenerator: false } });
    assert.deepEqual(problem(await revise('gus', BODY({ appId: record.id }))), [
      403,
      'FEATURE_DISABLED'
    ]);
    setConfig({ features: { ...FEATURES, userApps: false } });
    assert.deepEqual(problem(await revise('gus', BODY({ appId: record.id }))), [
      403,
      'USER_APPS_DISABLED'
    ]);
  });

  it('suggests only what personal apps may use and the editor may use', async t => {
    const JIRA = { id: 'jira', definition: 'jira', enabled: true };
    t.mock.method(installedIntegrationService, 'resolveAllEnabled', async () => [
      {
        instance: JIRA,
        label: 'Jira',
        definition: { name: { en: 'Jira' }, actions: [{ name: 'search' }, { name: 'delete' }] }
      }
    ]);
    setConfig({
      integrations: { installed: [JIRA], security: { blockPrivateIps: true, allowedHosts: [] } },
      userApps: { capabilities: { integrations: [{ id: 'jira', actions: ['search'] }] } }
    });
    // Nora's group grants no integration; she edits Anna's app.
    const record = await sharedApp({ editor: 'nora' });
    llm.answer = {
      reply: 'change',
      text: 'Done.',
      change: { system: 'You look up issues.', integrations: [{ id: 'jira' }] }
    };
    const anna = await revise('anna', BODY({ appId: record.id }));
    assert.deepEqual(anna.body.suggestions.integrations, [
      { id: 'jira', label: 'Jira', actions: ['search'] }
    ]);
    const nora = await revise('nora', BODY({ appId: record.id }));
    assert.equal(nora.status, 200, nora.text);
    assert.deepEqual(nora.body.suggestions.integrations, []);
  });

  it('does not count refused requests against the revise limit', async () => {
    addGuest('gil');
    const editable = await sharedApp({ editor: 'gil' });
    const readable = await sharedApp({ editor: 'gus', reader: 'gil' });
    // More refusals than the limit allows turns: none of them is counted.
    for (let index = 0; index < 61; index += 1) {
      const refused = index % 2 === 0 ? BODY({ appId: readable.id }) : BODY();
      assert.equal((await revise('gil', refused)).status, 403);
    }
    assert.equal((await revise('gil', BODY({ appId: UNKNOWN_PERSONAL_ID }))).status, 404);
    const res = await revise('gil', BODY({ appId: editable.id }));
    assert.equal(res.status, 200, res.text);
    assert.equal(llm.calls.length, 1);
  });
});

describe('the audit entry of a refused turn', () => {
  // Unique per run: the audit log of the test contents outlives a run.
  const MARK = `REFUSED-DRAFT-${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;

  /** The personal routes behind the audit safety net, as the server mounts them. */
  async function auditedServer() {
    const { default: express } = await import('express');
    const { default: request } = await import('supertest');
    const { default: auditLogger } = await import('../middleware/auditLogger.js');
    const { default: registerUserAppRoutes } = await import('../routes/userAppRoutes.js');
    const { UserAppService } = await import('../services/userApps/UserAppService.js');
    const { default: errorHandler } = await import('../middleware/errorHandler.js');
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      req.user = api.user(req.headers['x-test-principal']);
      next();
    });
    server.use(auditLogger());
    registerUserAppRoutes(server, {
      service: new UserAppService({ users: () => ({ ...USERS }) }),
      llmClient: { complete: async () => ({ content: '{}', finishReason: 'stop', usage: null }) }
    });
    server.use(errorHandler);
    return body =>
      request(server).post('/api/apps/_revise').set('x-test-principal', 'anna').send(body);
  }

  const entriesWithMark = async () => {
    await flushAuditLog();
    const { entries } = await queryAuditLog({ limit: 1000 });
    return entries.filter(entry => JSON.stringify(entry).includes(MARK));
  };

  it('writes no text of the body at the verbosity `request`, whatever refused it', async () => {
    const draft = { ...DRAFT, description: { en: `Drafts ${MARK}` } };
    const failures = [
      // The validation of the body.
      [{ draft }, 400, 'VALIDATION_FAILED'],
      // A content key over its limit.
      [
        BODY({ draft: { ...draft, name: { en: `${MARK} ${'x'.repeat(200)}` } } }),
        400,
        'APP_REVISE_TOO_LONG'
      ]
    ];
    setConfig({ platform: { audit: { verbosity: 'request' } } });
    const send = await auditedServer();
    for (const [body, status, code] of failures) {
      const res = await send(body);
      assert.deepEqual([res.status, res.body.code], [status, code], res.text);
    }
    // A gate before the body is read: the feature is off.
    setConfig({
      features: { ...FEATURES, appGenerator: false },
      platform: { audit: { verbosity: 'request' } }
    });
    const off = await send(BODY({ draft }));
    assert.deepEqual([off.status, off.body.code], [403, 'FEATURE_DISABLED']);
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(await entriesWithMark(), []);
    const { entries } = await queryAuditLog({ resource: 'userApp', limit: 1000 });
    const codes = entries
      .filter(entry => entry.result === 'failure' && entry.details?.purpose === 'app-revise')
      .map(entry => entry.details.code);
    for (const code of ['VALIDATION_FAILED', 'APP_REVISE_TOO_LONG', 'FEATURE_DISABLED']) {
      assert.ok(codes.includes(code), `${code} in ${codes.join(',')}`);
    }
    assert.equal(llm.calls.length, 0);
  });
});

describe('the revise limit of the personal route', () => {
  it('is the limit of the admin route: 60 turns per user and hour, one budget for both', async () => {
    api.addPerson('eve', { id: 'eve', name: 'Eve', authMode: 'oidc', groups: ['users'] });
    for (let index = 0; index < 60; index += 1) {
      assert.equal((await revise('eve')).status, 200);
    }
    const over = await revise('eve');
    assert.deepEqual(problem(over), [429, 'RATE_LIMITED']);
    assert.deepEqual(over.body.details, { limiter: 'appRevise' });

    // The admin route mounts the same instance: Eve's budget is spent there too.
    const { default: express } = await import('express');
    const { default: request } = await import('supertest');
    const { default: registerAdminAppBuilderRoutes } =
      await import('../routes/admin/appBuilder.js');
    const { default: errorHandler } = await import('../middleware/errorHandler.js');
    api.addPerson('eveAdmin', { id: 'eve', name: 'Eve', authMode: 'oidc', groups: ['admins'] });
    const admin = express();
    admin.use(express.json());
    admin.use((req, _res, next) => {
      req.user = api.user('eveAdmin');
      next();
    });
    registerAdminAppBuilderRoutes(admin, {
      llmClient: { complete: async () => ({ content: '{}', finishReason: 'stop', usage: null }) }
    });
    admin.use(errorHandler);
    const adminTurn = await request(admin).post('/api/admin/apps/_revise').send(BODY());
    assert.equal(adminTurn.status, 429, adminTurn.text);
    assert.equal(adminTurn.body.details.limiter, 'appRevise');
  });
});
