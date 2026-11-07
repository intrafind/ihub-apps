// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The chat's integrations picker on the server (#2923):
 *
 *   GET /api/integrations/picker?app=        one row per integration, never per action
 *   GET /api/integrations/preferences?app=   what a new chat of the app starts with
 *   PUT /api/integrations/preferences?app=   save it (and the one-time import)
 *
 * - the default is stored per (user, app) on the server, so it follows the
 *   user to another browser and is never another user's;
 * - a chat keeps its own copy: switching an integration on in one chat does
 *   not switch it on in another chat, in the default, or in a scheduled task;
 * - a reference the app added after the default was saved is on.
 *
 * Run: node --test server/tests/integrations/integrationPreferences.test.js
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';

import configCache from '../../configCache.js';
import { bootstrapStorage, shutdownStorageBootstrap } from '../../storage/bootstrap.js';
import { FilesystemStorageProvider } from '../../storage/providers/filesystem/index.js';
import userIntegrationRoutes from '../../routes/integrations/userIntegrations.js';
import {
  IntegrationPreferencesRepository,
  effectivePreferences,
  getIntegrationPreferencesRepository,
  normalizePreferences,
  preferencesKey
} from '../../services/integrations/IntegrationPreferencesRepository.js';
import {
  appCandidateRefs,
  appDefaultEnabledTools,
  appIntegrationDefaults,
  ownerOfTool,
  pickerRowsForApp
} from '../../services/integrations/integrationPicker.js';
import { ChatRepository } from '../../services/chat/ChatRepository.js';
import { materializeUserTurn } from '../../services/chat/chatMaterializer.js';
import { newTaskDocument } from '../../services/scheduler/tasks/taskModel.js';
import { appConfigSchema } from '../../validators/appConfigSchema.js';

const APPS = [
  {
    id: 'research',
    enabled: true,
    integrations: {
      drawio: {},
      ihub: { actions: ['ask_user'] },
      ifinder: {},
      jira: {},
      'type:storage': {},
      iassistant: {}
    },
    websearch: { enabled: true, enabledByDefault: true }
  },
  { id: 'plain', enabled: true },
  { id: 'secret', enabled: true, integrations: { drawio: {} } },
  { id: 'off', enabled: false, integrations: { drawio: {} } }
];

const permissions = apps => ({ apps: new Set(apps), integrations: new Set(['*']) });
const USERS = {
  ada: { id: 'ada', groups: ['users'], permissions: permissions(['research', 'plain', 'off']) },
  grace: { id: 'grace', groups: ['users'], permissions: permissions(['research', 'plain']) },
  client: {
    id: 'ada',
    groups: ['users'],
    isOAuthClient: true,
    permissions: permissions(['research'])
  },
  anonymous: { id: 'anonymous', groups: ['anonymous'], permissions: permissions(['research']) }
};

let baseDir;
const saved = {};
before(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-integration-prefs-'));
  await bootstrapStorage({
    storage: { provider: 'filesystem', filesystem: { baseDir, flushIntervalMs: 25 } }
  });
  saved.getApps = configCache.getApps;
  saved.getPlatform = configCache.getPlatform;
  configCache.getApps = () => ({ data: APPS });
  configCache.getPlatform = () => ({ anonymousAuth: { enabled: true }, defaultLanguage: 'en' });
});
after(async () => {
  configCache.getApps = saved.getApps;
  configCache.getPlatform = saved.getPlatform;
  await shutdownStorageBootstrap();
  await fs.rm(baseDir, { recursive: true, force: true });
});

const server = express();
server.use(express.json());
server.use((req, _res, next) => {
  req.user = USERS[req.headers['x-test-user'] || 'anonymous'];
  next();
});
server.use('/api/integrations', userIntegrationRoutes);

const getPrefs = (user, app = 'research') =>
  request(server).get(`/api/integrations/preferences?app=${app}`).set('x-test-user', user);
const putPrefs = (user, body, app = 'research') =>
  request(server)
    .put(`/api/integrations/preferences?app=${app}`)
    .set('x-test-user', user)
    .send(body);

describe('the scope picker placement', () => {
  it('accepts inline, menu and hidden, and nothing else', () => {
    const app = scopePicker => ({
      id: 'scoped',
      name: { en: 'Scoped' },
      description: { en: 'Scoped' },
      color: '#4F46E5',
      icon: 'chat',
      integrations: { ifinder: { scopePicker } }
    });
    for (const placement of ['inline', 'menu', 'hidden']) {
      assert.equal(appConfigSchema.safeParse(app(placement)).success, true, placement);
    }
    assert.equal(appConfigSchema.safeParse(app('sidebar')).success, false);
  });
});

describe('the app defaults', () => {
  it('offers every integration the app binds for tools', () => {
    assert.deepEqual(appCandidateRefs(APPS[0]), [
      'drawio',
      'ihub',
      'ifinder',
      'jira',
      'type:storage'
    ]);
    assert.deepEqual(
      appCandidateRefs({ integrations: { ifinder: { actions: [] }, jira: { actions: ['x'] } } }),
      ['jira']
    );
    assert.deepEqual(appIntegrationDefaults(APPS[0]).websearchEnabled, true);
    assert.deepEqual(appIntegrationDefaults({ websearch: { enabledByDefault: true } }), {
      enabledTools: [],
      websearchEnabled: false
    });
  });

  it('starts without the bindings that are only available', () => {
    const app = {
      integrations: {
        drawio: {},
        ifinder: {},
        jira: { enabledByDefault: false },
        'type:storage': { enabledByDefault: true }
      }
    };
    // Still offered (the picker lists it, the user's saved default may name it) ...
    assert.deepEqual(appCandidateRefs(app), ['drawio', 'ifinder', 'jira', 'type:storage']);
    // ... but not on in a new chat.
    assert.deepEqual(appIntegrationDefaults(app).enabledTools, [
      'drawio',
      'ifinder',
      'type:storage'
    ]);
    // A chat request that names no tools starts from the same defaults.
    assert.deepEqual(appDefaultEnabledTools(app), ['drawio', 'ifinder', 'type:storage']);
    // No such binding: the request is not narrowed at all, as before.
    assert.equal(appDefaultEnabledTools(APPS[0]), undefined);
  });

  it('keeps a ticked iAssistant action in the defaults of a request without tools', () => {
    const integrations = (iassistant, jira = { enabledByDefault: false }) => ({
      integrations: { drawio: {}, iassistant, jira }
    });
    // `ask` ticked: the model's `iassistant__ask` must survive the narrowing.
    assert.deepEqual(appDefaultEnabledTools(integrations({ actions: ['ask'] })), [
      'drawio',
      'iassistant'
    ]);
    // Scope settings only, or itself available-only: not offered as a tool.
    assert.deepEqual(appDefaultEnabledTools(integrations({ actions: [] })), ['drawio']);
    assert.deepEqual(appDefaultEnabledTools(integrations({})), ['drawio']);
    assert.deepEqual(
      appDefaultEnabledTools(integrations({ actions: ['ask'], enabledByDefault: false })),
      ['drawio']
    );
  });

  it('keeps an available-only integration off for a user who saved a default earlier', () => {
    const offered = ['drawio', 'ifinder'];
    // `jira` was added as available only: not switched on for existing users.
    assert.deepEqual(
      effectivePreferences(
        { enabledTools: ['drawio'], knownRefs: ['drawio'], integrationScopes: {} },
        { enabledTools: offered, websearchEnabled: false }
      ).enabledTools,
      ['drawio', 'ifinder']
    );
  });

  it('accepts and validates enabledByDefault on a binding', () => {
    const app = value => ({
      id: 'x',
      name: { en: 'X' },
      description: { en: 'X' },
      color: '#4F46E5',
      icon: 'chat',
      integrations: { jira: { enabledByDefault: value } }
    });
    assert.equal(appConfigSchema.safeParse(app(false)).success, true);
    assert.equal(appConfigSchema.safeParse(app(true)).success, true);
    assert.equal(appConfigSchema.safeParse(app('no')).success, false);
  });

  it('turns on what the app added after the default was saved', () => {
    const stored = {
      enabledTools: ['jira'],
      knownRefs: ['jira', 'drawio'],
      websearchEnabled: false,
      integrationScopes: { ifinder: 'contracts' }
    };
    assert.deepEqual(
      effectivePreferences(stored, {
        enabledTools: ['jira', 'drawio', 'nc'],
        websearchEnabled: true
      }),
      {
        enabledTools: ['jira', 'nc'],
        websearchEnabled: false,
        integrationScopes: { ifinder: 'contracts' }
      }
    );
  });

  it('stores only what a chat stores, at the chat bounds', () => {
    assert.deepEqual(
      normalizePreferences({
        enabledTools: ['jira', 7, ''],
        websearchEnabled: 'yes',
        integrationScopes: { ifinder: 'contracts', '../x': 'y' },
        style: 'concise'
      }),
      { enabledTools: ['jira'], integrationScopes: { ifinder: 'contracts' } }
    );
    assert.deepEqual(normalizePreferences({ enabledTools: [] }), { enabledTools: [] });
  });
});

describe('GET/PUT /api/integrations/preferences', () => {
  it('answers the app defaults before anything is stored', async () => {
    const res = await getPrefs('ada');
    assert.equal(res.status, 200);
    assert.equal(res.body.stored, false);
    assert.equal(res.body.available, true);
    assert.deepEqual(res.body.preferences, {
      enabledTools: ['drawio', 'ihub', 'ifinder', 'jira', 'type:storage'],
      websearchEnabled: true,
      integrationScopes: {}
    });
  });

  it('keeps the default on the server, for this user only (a second browser sees it)', async () => {
    const put = await putPrefs('ada', {
      enabledTools: ['ifinder'],
      websearchEnabled: false,
      integrationScopes: { ifinder: 'contracts' }
    });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.equal(put.body.stored, true);

    // Another request, no client state at all: what another browser sees.
    const again = await getPrefs('ada');
    assert.deepEqual(again.body.preferences, {
      enabledTools: ['ifinder'],
      websearchEnabled: false,
      integrationScopes: { ifinder: 'contracts' }
    });
    const other = await getPrefs('grace');
    assert.equal(other.body.stored, false);
    assert.equal(other.body.preferences.websearchEnabled, true);
  });

  it('imports what the browser kept only once', async () => {
    const first = await putPrefs('grace', { enabledTools: ['jira'], import: true });
    assert.deepEqual(first.body.preferences.enabledTools, ['jira']);
    const second = await putPrefs('grace', { enabledTools: ['drawio'], import: true });
    assert.deepEqual(second.body.preferences.enabledTools, ['jira']);
    // A plain save replaces it.
    const save = await putPrefs('grace', { enabledTools: ['drawio'] });
    assert.deepEqual(save.body.preferences.enabledTools, ['drawio']);
  });

  it('refuses an app the user may not open as if it did not exist', async () => {
    assert.equal((await getPrefs('ada', 'secret')).status, 404);
    assert.equal((await getPrefs('ada', 'off')).status, 404);
    assert.equal((await getPrefs('ada', 'nope')).status, 404);
    assert.equal((await putPrefs('ada', {}, 'secret')).status, 404);
    assert.equal((await getPrefs('ada', '..%2Fx')).status, 400);
  });

  it('gives a guest the app defaults and stores nothing for them', async () => {
    const res = await getPrefs('anonymous');
    assert.equal(res.status, 200);
    assert.equal(res.body.available, false);
    assert.equal(res.body.preferences.websearchEnabled, true);
    assert.equal((await putPrefs('anonymous', { enabledTools: [] })).status, 401);
  });

  it('lets only an interactive session change it, with a JSON body', async () => {
    assert.equal((await putPrefs('client', { enabledTools: [] })).status, 403);
    const form = await request(server)
      .put('/api/integrations/preferences?app=research')
      .set('x-test-user', 'ada')
      .type('form')
      .send('enabledTools=jira');
    assert.equal(form.status, 415);
  });

  it('keys a document by user and app and checks both on read', async () => {
    const repository = getIntegrationPreferencesRepository();
    await repository.set('ada', 'plain', { websearchEnabled: true });
    // A document under ada's key that names someone else is not ada's.
    await repository.documents.put(
      'integration-preferences',
      preferencesKey('ada', 'plain'),
      { userId: 'mallory', appId: 'plain', websearchEnabled: false },
      { ownerId: 'ada' }
    );
    assert.equal(await repository.get('ada', 'plain'), null);
    assert.equal(await repository.deleteAllOfUser('ada'), 2);
    assert.equal(await repository.get('ada', 'research'), null);
  });
});

describe('one chat, one default, one task: no leaks', () => {
  it('switching an integration on in one chat leaves the other chat, the default and a task alone', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-picker-chats-'));
    const provider = new FilesystemStorageProvider({ baseDir: dir, flushIntervalMs: 25 });
    await provider.initialize();
    const quiet = { info() {}, warn() {}, error() {}, debug() {} };
    const chats = new ChatRepository({
      documents: provider.documents,
      locks: provider.locks,
      logger: quiet
    });
    const preferences = new IntegrationPreferencesRepository({
      documents: provider.documents,
      locks: provider.locks,
      logger: quiet
    });
    try {
      await preferences.set('ada', 'research', { enabledTools: ['ifinder'] });
      // A task snapshots its own set when it is created.
      const task = newTaskDocument(
        {
          name: 'Daily',
          instructions: 'x',
          appId: 'research',
          schedule: { type: 'manual' },
          enabledTools: ['iFinder_search']
        },
        { id: 'task-1', ownerId: 'ada', owner: { id: 'ada' }, now: Date.now() }
      );
      const turn = (chatId, settings, runId) =>
        materializeUserTurn({
          repository: chats,
          chatId,
          ownerId: 'ada',
          identityMode: 'default',
          appId: 'research',
          modelId: 'gpt-4o',
          settings,
          runId,
          content: 'hello'
        });
      await turn(
        'chat-a',
        { enabledTools: ['ifinder'], integrationScopes: { ifinder: 'a' } },
        'r1'
      );
      await turn(
        'chat-b',
        { enabledTools: ['ifinder'], integrationScopes: { ifinder: 'b' } },
        'r2'
      );
      // Jira on in chat A only, and A's scope changed.
      await turn(
        'chat-a',
        { enabledTools: ['ifinder', 'jira'], integrationScopes: { ifinder: 'c' } },
        'r3'
      );

      assert.deepEqual((await chats.getChat('chat-a')).settings.enabledTools, ['ifinder', 'jira']);
      assert.deepEqual((await chats.getChat('chat-b')).settings.enabledTools, ['ifinder']);
      assert.deepEqual((await chats.getChat('chat-b')).settings.integrationScopes, {
        ifinder: 'b'
      });
      assert.deepEqual((await preferences.get('ada', 'research')).enabledTools, ['ifinder']);
      assert.deepEqual(task.enabledTools, ['iFinder_search']);
    } finally {
      await provider.shutdown();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('the picker rows', () => {
  const tool = (id, extra = {}) => ({ id, name: id, description: `${id} tool`, ...extra });
  const integrationTool = (instanceId, action, sideEffect) =>
    tool(`${instanceId}__${action}`, {
      sideEffect,
      _integration: { instanceId, action, instanceLabel: instanceId }
    });
  // A stand-in for the app's tools, already filtered for the user.
  const tools = [
    integrationTool('ifinder', 'search', 'read'),
    integrationTool('ifinder', 'getContent', 'read'),
    integrationTool('jira', 'search', 'read'),
    integrationTool('jira', 'comment', 'write'),
    integrationTool('nc-main', 'list', 'read'),
    integrationTool('nc-legal', 'list', 'read'),
    tool('drawio_create', { _mcp: { serverId: 'drawio', serverName: 'draw.io' } }),
    tool('drawio_shapes', { _mcp: { serverId: 'drawio', serverName: 'draw.io' } }),
    tool('ask_user'),
    tool('workflow_report')
  ];
  const binds = {
    ifinder: 'ifinder',
    jira: 'jira',
    'nc-main': 'type:storage',
    'nc-legal': 'type:storage'
  };
  const deps = {
    getToolsForApp: async () => tools,
    // The server's real rule, reduced to this fixture: a reference selects an
    // MCP server's tools by the server id, an installation's by its id or its
    // app binding key.
    isBoundToolEnabled: (_app, t, refs) =>
      refs.includes(t.id) ||
      (t._mcp && refs.includes(t._mcp.serverId)) ||
      (t._integration &&
        (refs.includes(t._integration.instanceId) ||
          refs.includes(binds[t._integration.instanceId]))),
    listUserIntegrations: async () => [
      {
        id: 'jira',
        name: 'Atlassian Jira',
        description: 'Issues',
        icon: null,
        capabilities: ['tools'],
        connection: { mode: 'personal', status: 'not_connected', connectable: true }
      },
      {
        id: 'ifinder',
        name: 'iFinder',
        capabilities: ['tools'],
        connection: { mode: 'sso', status: 'sso', connectable: false }
      }
    ]
  };

  it('shows one row per integration, never the sum of its actions', async () => {
    const rows = await pickerRowsForApp({ app: APPS[0], user: USERS.ada, deps });
    assert.deepEqual(
      rows.map(row => row.id),
      [
        'mcp:drawio',
        'integration:ifinder',
        'integration:jira',
        'integration:nc-main',
        'integration:nc-legal'
      ]
    );
    const jira = rows.find(row => row.integration === 'jira');
    assert.deepEqual(jira.refs, ['jira']);
    assert.deepEqual(jira.effects, ['read', 'write']);
    assert.equal(jira.name, 'Atlassian Jira');
    assert.deepEqual(jira.connection, {
      mode: 'personal',
      status: 'not_connected',
      reason: null,
      account: null,
      connectable: true
    });
    assert.deepEqual(rows.find(row => row.id === 'mcp:drawio').effects, []);
  });

  it('switches each installation of a shared binding on its own', async () => {
    const rows = await pickerRowsForApp({ app: APPS[0], user: USERS.ada, deps });
    const main = rows.find(row => row.integration === 'nc-main');
    assert.deepEqual(main.refs, ['nc-main']);
    assert.deepEqual(main.coveredBy, ['type:storage']);
  });

  it('leaves out the ask-the-user channel and tools the app did not list', async () => {
    const rows = await pickerRowsForApp({ app: APPS[0], user: USERS.ada, deps });
    assert.ok(!rows.some(row => row.refs.includes('ask_user')));
    assert.ok(!rows.some(row => row.id.includes('workflow')));
  });

  it('cannot be connected by a guest', async () => {
    const rows = await pickerRowsForApp({ app: APPS[0], user: USERS.anonymous, deps });
    assert.equal(rows.find(row => row.integration === 'jira').connection.connectable, false);
  });

  it('names a plain tool by its own reference', () => {
    assert.deepEqual(ownerOfTool(tool('calc'), 'calc'), {
      key: 'tool:calc',
      ref: 'calc',
      kind: 'tool',
      integration: null,
      name: 'calc'
    });
    assert.equal(
      ownerOfTool(
        tool('a2a__x__s', {
          _integration: { instanceId: 'x' },
          _a2a: { agentId: 'x', idConflict: true }
        }),
        'a2a__x'
      ).ref,
      'a2a__x'
    );
  });

  it('answers no rows for an app without tools, through the route', async () => {
    const res = await request(server)
      .get('/api/integrations/picker?app=plain')
      .set('x-test-user', 'ada');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { app: 'plain', rows: [] });
    const hidden = await request(server)
      .get('/api/integrations/picker?app=secret')
      .set('x-test-user', 'ada');
    assert.equal(hidden.status, 404);
  });
});
