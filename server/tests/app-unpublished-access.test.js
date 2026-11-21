// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Who can run an app that is not published (`enabled: false`).
 *
 * One method decides, `configCache.getAppForRequest(appId, user)`: a content
 * admin (or full admin) gets such an app, so that they can try it in the
 * interactive chat before they publish it. For every other principal, and for
 * every other way of running an app (scheduled task, app as a tool, workflow
 * chat, the request builder without `resolvedApp`), an unpublished app is the
 * same as an id that does not exist.
 *
 * The tests drive the real routes and services over a populated config cache
 * and a filesystem store in a temp directory. The only stubs are the model
 * (`runTurn`, `llmClient.complete`) and the API key check. Principals are built
 * by the real `enhanceUserWithPermissions`, so "an admin's personal API key is
 * no content admin" is tested where it is decided.
 *
 * The comparison rule of the matrix: for a principal who must not get the
 * unpublished app, status and body are the same as for an unknown id, with the
 * id itself blanked.
 *
 * Run: node --test server/tests/app-unpublished-access.test.js
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import request from 'supertest';

import configCache from '../configCache.js';
import { bootstrapStorage, shutdownStorageBootstrap } from '../storage/bootstrap.js';
import { enhanceUserWithPermissions } from '../utils/authorization.js';
import ApiKeyVerifier from '../utils/ApiKeyVerifier.js';
import ChatService from '../services/chat/ChatService.js';
import RequestBuilder from '../services/chat/RequestBuilder.js';
import { getChatRepository } from '../services/chat/ChatRepository.js';
import { resolveChatOwner } from '../services/chat/chatOwner.js';
import { beginTranscriptionTurn } from '../services/chat/transcriptionTurn.js';
import { getAppAsTools, invokeAppTool } from '../services/chat/appToolsGateway.js';
import * as tasks from '../services/scheduler/tasks/taskService.js';
import { executeTaskRun } from '../services/scheduler/tasks/taskExecution.js';
import { getScheduledTaskRepository } from '../services/scheduler/tasks/ScheduledTaskRepository.js';
import registerGeneralRoutes from '../routes/generalRoutes.js';
import registerSessionRoutes from '../routes/chat/sessionRoutes.js';
import registerMagicPromptRoutes from '../routes/magicPromptRoutes.js';
import registerConversationRoutes from '../routes/chat/conversationRoutes.js';
import registerChatRoutes from '../routes/chats.js';
import scopeRoutes from '../routes/integrations/scopes.js';
import userIntegrationRoutes from '../routes/integrations/userIntegrations.js';
import conversationApiService from '../services/integrations/ConversationApiService.js';
import { getExecutionRegistry } from '../services/workflow/ExecutionRegistry.js';
import errorHandler from '../middleware/errorHandler.js';
import { captureRunLog } from './loop/helpers/llmFixtures.js';

// The workflow routes start the sweep of their event streams when the module
// is imported, on an interval that would keep this test process alive. Let the
// intervals created during that import not hold the process.
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (...args) => realSetInterval(...args).unref();
const { default: registerWorkflowRoutes } = await import('../routes/workflow/workflowRoutes.js');
globalThis.setInterval = realSetInterval;

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

// --- Fixture --------------------------------------------------------------

const PUBLISHED = 'app-published';
const UNPUBLISHED = 'app-unpublished';
/** Not published, and the feature it requires is switched off. */
const GATED = 'app-unpublished-gated';
/** Published; lists the unpublished app as a tool. */
const CALLER = 'app-caller';
const UNKNOWN = 'app-does-not-exist';
/** The marker of the unpublished app's texts: never in an answer to someone who may not get it. */
const SECRET = 'UNPUBLISHED-SECRET-41c7';

const MODELS = [
  {
    id: 'oa',
    name: { en: 'Stub model' },
    provider: 'openai',
    modelId: 'gpt-4o',
    url: 'https://model.invalid/v1/chat/completions',
    autoDiscovery: false,
    supportsTools: 'auto',
    default: true,
    enabled: true
  }
];

const app = (id, extra = {}) => ({
  id,
  name: { en: id },
  description: { en: `${id} description` },
  system: { en: `You are ${id}.` },
  tokenLimit: 4096,
  preferredModel: 'oa',
  // Where the conversation route sends its delete (the call itself is stubbed).
  iassistant: { baseUrl: 'https://assistant.invalid' },
  enabled: true,
  ...extra
});

const APPS = [
  app(PUBLISHED),
  app(UNPUBLISHED, {
    enabled: false,
    name: { en: `${SECRET} name` },
    system: { en: `${SECRET} instructions` },
    // Settings a route reads from the app: what tells "got the app" from "got nothing".
    features: { userProjects: false, magicPrompt: { enabled: true, prompt: `${SECRET} magic` } },
    uploads: { storageMode: 'server_text_only' }
  }),
  app(GATED, { enabled: false, requiredFeatures: ['workflows'], system: { en: SECRET } }),
  // The narrow content admin's groups do not grant this one: the published app
  // for "a route that checks no group permission answers as before".
  app(CALLER, {
    apps: [UNPUBLISHED, PUBLISHED],
    features: { userProjects: false },
    uploads: { storageMode: 'server_text_only' }
  })
];

const perms = (extra = {}) => ({
  apps: ['*'],
  models: ['*'],
  prompts: [],
  integrations: ['*'],
  projects: true,
  scheduledTasks: true,
  ...extra
});

const GROUPS = {
  groups: {
    anonymous: { id: 'anonymous', permissions: perms({ scheduledTasks: false }) },
    users: { id: 'users', permissions: perms() },
    builders: { id: 'builders', permissions: perms({ contentAdmin: true }) },
    // A content admin whose groups grant the published app only.
    'builders-narrow': {
      id: 'builders-narrow',
      permissions: perms({ apps: [PUBLISHED], contentAdmin: true })
    },
    admins: { id: 'admins', permissions: perms({ adminAccess: true }) }
  }
};

const PLATFORM = {
  defaultLanguage: 'en',
  anonymousAuth: { enabled: true, defaultGroups: ['anonymous'] },
  aiAcknowledgement: { enabled: false },
  chats: { enabled: true },
  scheduledTasks: { staggerMinutes: 0, minIntervalMinutes: 15, maxTasksPerUser: 10 },
  auth: {}
};

const FEATURES = {
  chatPersistence: true,
  projects: true,
  userProjects: true,
  scheduledTasks: true,
  appAsTool: true,
  integrations: true,
  // `workflows` stays off: the gated app requires it.
  workflows: false
};

function setConfig({ apps = APPS, features = FEATURES } = {}) {
  configCache.setCacheEntry('config/platform.json', PLATFORM);
  configCache.setCacheEntry('config/features.json', features);
  configCache.setCacheEntry('config/groups.json', GROUPS);
  configCache.setCacheEntry('config/models.json', MODELS);
  configCache.setCacheEntry('config/apps.json', apps);
  configCache.setCacheEntry('config/integrations.json', { installed: [] });
  configCache.setCacheEntry('config/workflows.json', []);
  configCache.setCacheEntry('config/users.json', { users: {} });
}

/** A principal as the request pipeline builds it. */
const principal = fields =>
  fields === null
    ? enhanceUserWithPermissions(null, {}, configCache.getPlatform())
    : enhanceUserWithPermissions({ ...fields }, {}, configCache.getPlatform());

/**
 * The principals of the matrix. `gets` says who gets the unpublished app.
 * Every one of them has group (or client) permission for it, except the narrow
 * content admin: what refuses the others is the published rule alone.
 */
const PRINCIPALS = {
  anonymous: { build: () => principal(null), gets: false },
  user: {
    build: () => principal({ id: 'user-1', name: 'Uma', authMode: 'local', groups: ['users'] }),
    gets: false
  },
  contentAdmin: {
    build: () =>
      principal({ id: 'builder-1', name: 'Bea', authMode: 'local', groups: ['builders'] }),
    gets: true
  },
  contentAdminNoGrant: {
    build: () =>
      principal({ id: 'builder-2', name: 'Ben', authMode: 'local', groups: ['builders-narrow'] }),
    gets: false
  },
  admin: {
    build: () => principal({ id: 'admin-1', name: 'Ada', authMode: 'local', groups: ['admins'] }),
    gets: true
  },
  // A personal API key of that admin: it acts as its owner, never as an admin.
  adminApiKey: {
    build: () =>
      principal({
        id: 'admin-1',
        name: 'Ada',
        authMode: 'oauth_personal_key',
        groups: ['admins']
      }),
    gets: false
  },
  // A delegated token of a content admin (authorization code).
  contentAdminDelegated: {
    build: () =>
      principal({
        id: 'builder-1',
        name: 'Bea',
        authMode: 'oauth_authorization_code',
        groups: ['builders']
      }),
    gets: false
  },
  oauthClient: {
    build: () =>
      principal({
        id: 'client-1',
        name: 'Client',
        isOAuthClient: true,
        authMode: 'oauth_client_credentials',
        groups: ['admins'],
        allowedApps: ['*'],
        allowedModels: ['*']
      }),
    gets: false
  },
  agent: {
    build: () =>
      principal({ id: 'agent-1', name: 'Agent', isAgent: true, groups: ['admins', 'builders'] }),
    gets: false
  }
};
const NAMES = Object.keys(PRINCIPALS);
const user = name => PRINCIPALS[name].build();

// --- The server under test ------------------------------------------------

/** Every `runTurn` the chat route started. */
const turns = [];
/** Every model call of the magic prompt route. */
const magicCalls = [];
let baseDir;
let ledger;
let server;
const originals = {};

function buildServer() {
  const api = express();
  api.use(express.json());
  // The principal comes from a header the test sets, never from the body.
  api.use((req, _res, next) => {
    req.user = user(req.headers['x-test-principal'] || 'anonymous');
    next();
  });
  const getLocalizedError = async code => `localized:${code}`;
  registerGeneralRoutes(api, { getLocalizedError });
  registerSessionRoutes(api, { getLocalizedError, DEFAULT_TIMEOUT: 5000 });
  registerMagicPromptRoutes(api, {
    llmClient: {
      complete: async call => {
        magicCalls.push(call);
        return { content: 'improved' };
      }
    }
  });
  registerConversationRoutes(api);
  registerChatRoutes(api);
  registerWorkflowRoutes(api);
  api.use('/api/integrations', scopeRoutes);
  api.use('/api/integrations', userIntegrationRoutes);
  api.use(errorHandler);
  return api;
}

const as = (name, req) => req.set('x-test-principal', name);

/** Status and body of an answer, with the app id and what differs per request blanked. */
function shape(res, appId) {
  const blank = text =>
    text
      .split(appId)
      .join('<app>')
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
      .replace(/file_[0-9a-f]+/g, '<file>')
      .replace(/"instance":"[^"]*"/g, '"instance":"<path>"')
      .replace(/"(timestamp|createdAt|updatedAt|ts)":"[^"]*"/g, '"$1":"<time>"');
  return { status: res.status, body: blank(res.text ?? '') };
}

before(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-unpublished-'));
  await bootstrapStorage({
    storage: { provider: 'filesystem', filesystem: { baseDir, flushIntervalMs: 25 } }
  });
  setConfig();
  await configCache.loadAndCacheLocale('en');
  ledger = await captureRunLog();

  originals.verifyApiKey = ApiKeyVerifier.prototype.verifyApiKey;
  ApiKeyVerifier.prototype.verifyApiKey = async () => ({ success: true, apiKey: 'sk-test' });
  originals.runTurn = ChatService.prototype.runTurn;
  ChatService.prototype.runTurn = async function (params) {
    turns.push(params);
    return { status: 'success', content: 'stub answer', finishReason: 'stop' };
  };
  server = buildServer();
});

after(async () => {
  ApiKeyVerifier.prototype.verifyApiKey = originals.verifyApiKey;
  ChatService.prototype.runTurn = originals.runTurn;
  await shutdownStorageBootstrap();
  const rm = dir => fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  await rm(baseDir);
  if (ledger?.baseDir) await rm(ledger.baseDir);
});

beforeEach(() => {
  setConfig();
  turns.length = 0;
  magicCalls.length = 0;
});

// --- The decision ----------------------------------------------------------

describe('configCache.getAppForRequest', () => {
  it('gives a published app to every principal (group permission is the caller’s check)', () => {
    for (const name of NAMES) {
      assert.equal(configCache.getAppForRequest(PUBLISHED, user(name))?.id, PUBLISHED, name);
    }
    assert.equal(configCache.getAppForRequest(PUBLISHED, undefined)?.id, PUBLISHED);
  });

  it('gives an unpublished app to a content admin or admin, and to nobody else', () => {
    for (const name of NAMES) {
      const got = configCache.getAppForRequest(UNPUBLISHED, user(name));
      // The method checks no group permission: the narrow content admin gets
      // the app here and is refused by the caller's own check (the matrix).
      const expected = name === 'contentAdminNoGrant' ? true : PRINCIPALS[name].gets;
      assert.equal(got?.id ?? null, expected ? UNPUBLISHED : null, name);
    }
    assert.equal(configCache.getAppForRequest(UNPUBLISHED, undefined), null);
    assert.equal(configCache.getAppForRequest(UNPUBLISHED, null), null);
    assert.equal(configCache.getAppForRequest(UNPUBLISHED, {}), null);
  });

  it('reads the flag the request pipeline set, and nothing that only looks like it', () => {
    const lookalikes = [
      { id: 'x', isContentAdmin: 'true' },
      { id: 'x', isContentAdmin: 1 },
      { id: 'x', isAdmin: true },
      { id: 'x', groups: ['admins', 'builders'] },
      { id: 'x', permissions: { contentAdmin: true, adminAccess: true, apps: new Set(['*']) } }
    ];
    for (const candidate of lookalikes) {
      assert.equal(
        configCache.getAppForRequest(UNPUBLISHED, candidate),
        null,
        JSON.stringify(Object.keys(candidate))
      );
    }
  });

  it('gives an unpublished app whose required feature is off to nobody', () => {
    for (const name of NAMES) {
      assert.equal(configCache.getAppForRequest(GATED, user(name)), null, name);
    }
    // With the feature on, the content admin gets it and a user still does not.
    setConfig({ features: { ...FEATURES, workflows: true } });
    assert.equal(configCache.getAppForRequest(GATED, user('contentAdmin'))?.id, GATED);
    assert.equal(configCache.getAppForRequest(GATED, user('user')), null);
  });

  it('gives an unpublished app that binds a switched-off integration to nobody', () => {
    // iFinder is not installed in this fixture, so an app bound to it is off.
    const bound = { integrations: { ifinder: {} } };
    setConfig({
      apps: [...APPS, app('app-bound', { ...bound, enabled: false }), app('app-bound-live', bound)]
    });
    assert.equal(
      configCache.getAppForRequest('app-bound-live', user('admin')),
      null,
      'the fixture binding hides a published app too'
    );
    for (const name of NAMES) {
      assert.equal(configCache.getAppForRequest('app-bound', user(name)), null, name);
    }
  });

  it('matches ids regardless of case and answers null for an unknown or invalid id', () => {
    const admin = user('admin');
    assert.equal(configCache.getAppForRequest(UNPUBLISHED.toUpperCase(), admin)?.id, UNPUBLISHED);
    assert.equal(
      configCache.getAppForRequest(PUBLISHED.toUpperCase(), user('user'))?.id,
      PUBLISHED
    );
    assert.equal(configCache.getAppForRequest(UNPUBLISHED.toUpperCase(), user('user')), null);
    for (const id of [UNKNOWN, '', undefined, null, 42, {}, ['x']]) {
      assert.equal(configCache.getAppForRequest(id, admin), null, String(id));
    }
  });

  it('prefers the published app when an unpublished one has the same id in another case', () => {
    setConfig({
      apps: [app('Twin', { enabled: false, system: { en: SECRET } }), app('twin'), ...APPS]
    });
    for (const name of NAMES) {
      assert.equal(configCache.getAppForRequest('TWIN', user(name))?.id, 'twin', name);
    }
  });

  it('answers the same app object the published list holds', () => {
    const listed = configCache.getApps().data.find(entry => entry.id === PUBLISHED);
    assert.equal(configCache.getAppForRequest(PUBLISHED, user('user')), listed);
  });
});

describe('lists', () => {
  it('getApps() and getAppsForUser() never hold an unpublished app, for admins too', async () => {
    const ids = list => list.map(entry => entry.id).sort();
    assert.deepEqual(ids(configCache.getApps().data), [CALLER, PUBLISHED]);
    for (const name of NAMES) {
      const { data } = await configCache.getAppsForUser(user(name), configCache.getPlatform());
      assert.ok(!ids(data).includes(UNPUBLISHED), name);
      assert.ok(!ids(data).includes(GATED), name);
      assert.equal(
        await configCache.getAppForUserById(user(name), configCache.getPlatform(), UNPUBLISHED),
        null,
        name
      );
    }
  });

  it('GET /api/apps lists the unpublished app for no principal', async () => {
    for (const name of NAMES) {
      const res = await as(name, request(server).get('/api/apps'));
      assert.equal(res.status, 200, name);
      const ids = res.body.items.map(entry => entry.id);
      assert.ok(ids.includes(PUBLISHED), `${name} sees the published app`);
      assert.ok(!ids.includes(UNPUBLISHED), `${name} must not see the unpublished app`);
      assert.ok(!ids.includes(GATED), `${name} must not see the gated app`);
      assert.ok(!res.text.includes(SECRET), `${name} must not read its texts`);
    }
  });
});

// --- The matrix: every converted call site, every principal, every state ------

const chatBody = (extra = {}) => ({
  messages: [{ role: 'user', content: 'hello', messageId: 'm1' }],
  ...extra
});

/** A stored chat of `name` that belongs to `appId`; null for a principal that owns no chats. */
async function seedChat(name, appId) {
  const owner = await resolveChatOwner(user(name), {});
  if (!owner) return null;
  const chatId = randomUUID();
  await getChatRepository().ensureChat({
    chatId,
    ownerId: owner.id,
    identityMode: owner.mode,
    appId,
    origin: { createdVia: 'ui' },
    temporary: false
  });
  return chatId;
}

/** Every conversation the delete route forwarded. */
const deletedConversations = [];

/**
 * The call sites that look an app up with `getAppForRequest`. `send` asks as a
 * principal for an app id and answers `{ status, text }`; `got` says whether
 * that answer (next to the same principal's answer for an unknown id) shows
 * the caller reached the unpublished app's configuration.
 * `checksGroup: false` marks a site that has never checked the group
 * permission of a published app. For an unpublished app it does: the content
 * admin whose groups do not grant the app gets the unknown-id answer there too.
 */
const SITES = [
  {
    name: 'GET /api/apps/:appId',
    send: (who, appId) => as(who, request(server).get(`/api/apps/${appId}`)),
    got: res => res.status === 200 && res.text.includes(SECRET),
    published: res => res.status === 200 && res.body.id === PUBLISHED
  },
  {
    name: 'POST /api/apps/:appId/chat/:chatId',
    send: (who, appId) =>
      as(who, request(server).post(`/api/apps/${appId}/chat/${randomUUID()}`)).send(chatBody()),
    got: res =>
      res.status === 200 &&
      res.body.status === 'streaming' &&
      turns.at(-1)?.chatId === res.body.chatId &&
      turns.at(-1)?.prep.app.id === UNPUBLISHED,
    published: res => res.status === 200 && res.body.status === 'streaming'
  },
  {
    name: 'POST /api/magic-prompt',
    send: (who, appId) =>
      as(who, request(server).post('/api/magic-prompt')).send({ input: 'make it better', appId }),
    got: res => res.status === 200 && magicCalls.at(-1)?.messages[0].content === `${SECRET} magic`,
    published: res => res.status === 200 && res.body.prompt === 'improved'
  },
  {
    name: 'GET /api/integrations/scopes',
    send: (who, appId) => as(who, request(server).get('/api/integrations/scopes').query({ appId })),
    got: res => res.status === 200 && Array.isArray(res.body.items),
    published: res => res.status === 200
  },
  {
    name: 'GET /api/integrations/picker',
    send: (who, appId) =>
      as(who, request(server).get('/api/integrations/picker').query({ app: appId })),
    got: res => res.status === 200 && res.body.app === UNPUBLISHED,
    published: res => res.status === 200 && res.body.app === PUBLISHED
  },
  {
    name: 'GET /api/integrations/preferences',
    send: (who, appId) =>
      as(who, request(server).get('/api/integrations/preferences').query({ app: appId })),
    got: res => res.status === 200 && res.body.app === UNPUBLISHED,
    published: res => res.status === 200 && res.body.app === PUBLISHED
  },
  {
    name: 'DELETE /apps/:appId/conversations/:conversationId',
    checksGroup: false,
    send: (who, appId) => as(who, request(server).delete(`/apps/${appId}/conversations/conv-1`)),
    got: res =>
      res.status === 204 && deletedConversations.at(-1)?.baseUrl === 'https://assistant.invalid',
    published: res => res.status === 204
  },
  {
    // The app decides how a chat's uploads are stored (`uploads.storageMode`).
    name: 'POST /api/chats/:chatId/files',
    checksGroup: false,
    send: (who, appId) =>
      as(who, request(server).post(`/api/chats/${randomUUID()}/files`))
        .field('appId', appId)
        .attach('file', Buffer.from('some text'), 'note.txt'),
    got: res => res.status === 201 && res.body.storageMode === 'server_text_only'
  },
  {
    // The chat's app decides whether projects can be attached (`features.userProjects`).
    name: 'PATCH /api/chats/:chatId (attachedProjectIds)',
    checksGroup: false,
    send: async (who, appId) => {
      const chatId = await seedChat(who, appId);
      return as(who, request(server).patch(`/api/chats/${chatId ?? randomUUID()}`)).send({
        attachedProjectIds: ['no-such-project']
      });
    },
    got: res => res.body?.code === 'APP_PROJECTS_DISABLED'
  },
  {
    // The realtime transcription bridge: a function, not a route.
    name: 'beginTranscriptionTurn',
    send: async (who, appId) => {
      const result = await beginTranscriptionTurn({
        user: user(who),
        chatId: randomUUID(),
        appId,
        modelId: 'oa',
        clientMessageId: 'm1',
        attachment: { name: 'audio.wav' },
        projectId: 'no-such-project'
      });
      return {
        status: result.ok ? 200 : 409,
        text: JSON.stringify(result.ok ? { ok: true, stored: Boolean(result.turn) } : result),
        body: result
      };
    },
    // The unpublished app takes no user projects, so its project field is
    // ignored and the turn is stored; without the app the project is checked
    // and refused (for a principal that can hold projects at all).
    got: (res, unknown) => res.status === 200 && unknown.status !== 200
  }
];

describe('the matrix: principal x app state, per call site', () => {
  before(() => {
    originals.deleteConversation = conversationApiService.deleteConversation;
    conversationApiService.deleteConversation = async (conversationId, options) => {
      deletedConversations.push({ conversationId, baseUrl: options.baseUrl });
    };
  });
  after(() => {
    conversationApiService.deleteConversation = originals.deleteConversation;
  });

  for (const site of SITES) {
    describe(site.name, () => {
      for (const name of NAMES) {
        const mayGet = PRINCIPALS[name].gets;

        it(`${name}: ${mayGet ? 'gets' : 'does not get'} the unpublished app`, async () => {
          const unknown = await site.send(name, UNKNOWN);
          assert.ok(!site.got(unknown, unknown), 'an unknown id is not "got"');

          const turnsBefore = turns.length;
          const magicBefore = magicCalls.length;
          const deletesBefore = deletedConversations.length;
          const unpublished = await site.send(name, UNPUBLISHED);
          if (mayGet) {
            assert.ok(
              site.got(unpublished, unknown),
              `expected the app, got ${unpublished.status} ${unpublished.text.slice(0, 200)}`
            );
          } else {
            assert.deepEqual(shape(unpublished, UNPUBLISHED), shape(unknown, UNKNOWN));
            assert.ok(!unpublished.text.includes(SECRET));
            assert.equal(turns.length, turnsBefore, 'no turn ran');
            assert.equal(magicCalls.length, magicBefore, 'no model call was made');
            assert.equal(deletedConversations.length, deletesBefore, 'nothing was forwarded');
          }

          // Not published and a required feature off: an unknown id for everyone.
          const turnsBeforeGated = turns.length;
          const gated = await site.send(name, GATED);
          assert.deepEqual(shape(gated, GATED), shape(unknown, UNKNOWN));
          assert.ok(!gated.text.includes(SECRET));
          assert.equal(turns.length, turnsBeforeGated, 'no turn ran for the gated app');
        });
      }

      if (site.published) {
        it('still answers for a published app as before', async () => {
          for (const name of ['user', 'contentAdmin', 'contentAdminNoGrant', 'admin']) {
            const res = await site.send(name, PUBLISHED);
            assert.ok(site.published(res), `${name}: ${res.status} ${res.text.slice(0, 200)}`);
          }
        });
      }

      if (site.checksGroup === false) {
        it('still applies a published app the caller’s groups do not grant, as before', async () => {
          const narrow = user('contentAdminNoGrant');
          assert.equal(narrow.permissions.apps.has(CALLER), false);
          assert.equal(narrow.permissions.apps.has('*'), false);
          const unknown = await site.send('contentAdminNoGrant', UNKNOWN);
          const res = await site.send('contentAdminNoGrant', CALLER);
          assert.ok(site.got(res, unknown), `${res.status} ${res.text.slice(0, 200)}`);
        });
      }
    });
  }

  it('the chat a content admin tries runs the unpublished app itself', async () => {
    const res = await as(
      'contentAdmin',
      request(server).post(`/api/apps/${UNPUBLISHED.toUpperCase()}/chat/${randomUUID()}`)
    ).send(chatBody());
    assert.equal(res.body.status, 'streaming', res.text);
    const { prep } = turns.at(-1);
    assert.equal(prep.app.id, UNPUBLISHED);
    const system = prep.llmMessages.find(message => message.role === 'system')?.content ?? '';
    assert.match(system, new RegExp(`${SECRET} instructions`));
  });
});

// --- The request builder ----------------------------------------------------

describe('RequestBuilder.prepareChatRequest', () => {
  const prepare = (extra = {}) =>
    new RequestBuilder().prepareChatRequest({
      modelId: 'oa',
      messages: [{ role: 'user', content: 'hello' }],
      language: 'en',
      processMessageTemplates: async messages => messages,
      chatId: `chat-${randomUUID()}`,
      ...extra
    });
  const failure = (result, appId) => ({
    success: result.success,
    code: result.error?.code,
    message: String(result.error?.message ?? '')
      .split(appId)
      .join('<app>')
  });

  it('without resolvedApp an unpublished app is an unknown app, for an admin too', async () => {
    for (const name of NAMES) {
      const unknown = await prepare({ appId: UNKNOWN, user: user(name) });
      assert.equal(unknown.success, false, name);
      assert.equal(unknown.error.code, 'APP_NOT_FOUND', name);
      for (const appId of [UNPUBLISHED, GATED]) {
        const result = await prepare({ appId, user: user(name) });
        assert.deepEqual(failure(result, appId), failure(unknown, UNKNOWN), `${name} ${appId}`);
      }
    }
  });

  it('without resolvedApp a published app is prepared as before', async () => {
    const result = await prepare({ appId: PUBLISHED.toUpperCase(), user: user('user') });
    assert.equal(result.success, true, result.error?.message);
    assert.equal(result.data.app.id, PUBLISHED);
  });

  it('uses resolvedApp when the caller hands it in', async () => {
    const admin = user('admin');
    const result = await prepare({
      appId: UNPUBLISHED,
      user: admin,
      resolvedApp: configCache.getAppForRequest(UNPUBLISHED, admin)
    });
    assert.equal(result.success, true, result.error?.message);
    assert.equal(result.data.app.id, UNPUBLISHED);
  });

  it('ignores a resolvedApp of another id, and a null one', async () => {
    const admin = user('admin');
    const unpublished = configCache.getAppForRequest(UNPUBLISHED, admin);
    const other = await prepare({ appId: PUBLISHED, user: admin, resolvedApp: unpublished });
    assert.equal(other.data.app.id, PUBLISHED);
    const unknown = await prepare({ appId: UNKNOWN, user: admin, resolvedApp: unpublished });
    assert.equal(unknown.error.code, 'APP_NOT_FOUND');
    const none = await prepare({ appId: UNPUBLISHED, user: admin, resolvedApp: null });
    assert.equal(none.error.code, 'APP_NOT_FOUND');
  });

  it('is handed resolvedApp in one place, the interactive chat route', () => {
    const users = sourceFiles(path.join(repoRoot, 'server'))
      .filter(file => /\bresolvedApp\b/.test(fsSync.readFileSync(file, 'utf8')))
      .map(file => path.relative(repoRoot, file))
      .sort();
    assert.deepEqual(users, [
      'server/routes/chat/sessionRoutes.js',
      'server/services/chat/RequestBuilder.js'
    ]);
    const route = fsSync.readFileSync(
      path.join(repoRoot, 'server/routes/chat/sessionRoutes.js'),
      'utf8'
    );
    assert.deepEqual(
      route.match(/\bresolvedApp\b.*/g).filter(line => !line.includes('`')),
      ['resolvedApp: requestApp']
    );
    assert.equal(
      route.match(/const requestApp = (.*);/)?.[1],
      'configCache.getAppForRequest(appId, req.user)'
    );
  });
});

describe('nothing of the request reaches the decision', () => {
  const unpublishedApp = () => APPS.find(entry => entry.id === UNPUBLISHED);
  const post = (who, appId, body, { query = {}, headers = {} } = {}) =>
    as(who, request(server).post(`/api/apps/${appId}/chat/${randomUUID()}`))
      .query(query)
      .set(headers)
      .send(body);

  it('a body field resolvedApp does not run an unpublished app', async () => {
    const forged = chatBody({ resolvedApp: { ...unpublishedApp(), enabled: true } });
    for (const name of ['user', 'adminApiKey', 'oauthClient']) {
      const unknown = await post(name, UNKNOWN, forged);
      const res = await post(name, UNPUBLISHED, forged);
      assert.deepEqual(shape(res, UNPUBLISHED), shape(unknown, UNKNOWN), name);
      assert.ok(!res.text.includes(SECRET), name);
    }
    assert.equal(turns.length, 0);
  });

  it('a body field resolvedApp does not replace a published app', async () => {
    const forged = chatBody({ resolvedApp: { ...unpublishedApp(), id: PUBLISHED, enabled: true } });
    const res = await post('user', PUBLISHED, forged);
    assert.equal(res.body.status, 'streaming', res.text);
    const { prep } = turns.at(-1);
    assert.equal(prep.app.id, PUBLISHED);
    assert.ok(!JSON.stringify(prep.llmMessages).includes(SECRET));
    assert.match(JSON.stringify(prep.llmMessages), new RegExp(`You are ${PUBLISHED}\\.`));
  });

  it('no query parameter, header or body flag makes a user a content admin', async () => {
    const claims = {
      isContentAdmin: true,
      isAdmin: true,
      contentAdmin: true,
      includeDisabled: true,
      preview: true,
      test: true,
      user: { isContentAdmin: true, isAdmin: true, groups: ['admins'] }
    };
    const query = { isContentAdmin: 'true', includeDisabled: 'true', preview: '1', test: '1' };
    const headers = {
      'x-is-content-admin': 'true',
      'x-content-admin': 'true',
      'x-include-disabled': 'true',
      'x-preview': 'true'
    };
    const unknown = await post('user', UNKNOWN, chatBody(claims), { query, headers });
    const res = await post('user', UNPUBLISHED, chatBody(claims), { query, headers });
    assert.deepEqual(shape(res, UNPUBLISHED), shape(unknown, UNKNOWN));
    assert.equal(turns.length, 0);

    const read = await as('user', request(server).get(`/api/apps/${UNPUBLISHED}`))
      .query(query)
      .set(headers);
    assert.equal(read.status, 404);
    assert.ok(!read.text.includes(SECRET));
  });
});

// --- The other ways of running an app ----------------------------------------

describe('the other ways of running an app treat an unpublished app as unknown', () => {
  it('a content admin’s scheduled task on an app that got unpublished stays paused', async () => {
    const TASK_APP = 'app-task';
    const owner = principal({ id: 'builder-oidc', authMode: 'oidc', groups: ['builders'] });
    assert.equal(owner.isContentAdmin, true);
    setConfig({ apps: [...APPS, app(TASK_APP)] });
    const task = await tasks.createTask(owner, {
      name: 'Digest',
      instructions: 'Report.',
      appId: TASK_APP,
      schedule: { type: 'daily', time: '08:00', timezone: 'Europe/Berlin' }
    });

    // The app is unpublished after the task was created.
    setConfig({ apps: [...APPS, app(TASK_APP, { enabled: false })] });
    assert.equal(configCache.getAppForRequest(TASK_APP, owner)?.id, TASK_APP);

    const queued = await tasks.requestRun(owner, task.id);
    let prepared = 0;
    const chatService = {
      prepareChatRequest: async () => {
        prepared++;
        return { success: false, error: { code: 'TEST', message: 'must not be reached' } };
      },
      runTurn: async () => {
        prepared++;
        return { status: 'error' };
      }
    };
    const run = await executeTaskRun({ taskId: task.id, runId: queued.id }, { chatService });
    assert.equal(run.status, 'skipped');
    assert.equal(run.reason.code, 'APP_NOT_AVAILABLE');
    assert.equal(prepared, 0, 'the request was never prepared');
    const stored = await getScheduledTaskRepository().getTask(task.id);
    assert.equal(stored.status, 'paused');
    assert.equal(stored.statusReason.code, 'APP_NOT_AVAILABLE');
    await tasks.deleteTask(owner, task.id);
  });

  it('a scheduled task cannot be created on an unpublished app, by a content admin either', async () => {
    const owner = principal({ id: 'builder-oidc', authMode: 'oidc', groups: ['builders'] });
    const input = appId => ({
      name: 'Digest',
      instructions: 'Report.',
      appId,
      schedule: { type: 'daily', time: '08:00', timezone: 'Europe/Berlin' }
    });
    const issuesOf = async appId => {
      try {
        await tasks.createTask(owner, input(appId));
      } catch (error) {
        return (error.details?.issues || []).map(issue => `${issue.field}:${issue.code}`);
      }
      return ['created'];
    };
    const unknown = await issuesOf(UNKNOWN);
    assert.deepEqual(unknown, ['appId:APP_NOT_FOUND']);
    assert.deepEqual(await issuesOf(UNPUBLISHED), unknown);
  });

  it('an unpublished app listed under `apps` of a published app is not offered as a tool', async () => {
    const admin = user('admin');
    const offered = await getAppAsTools([UNPUBLISHED, PUBLISHED], 'en', { user: admin });
    assert.deepEqual(
      offered.map(tool => tool.id),
      [`app__${PUBLISHED}`]
    );

    // The same through the prepared request of the published app that lists it.
    const result = await new RequestBuilder().prepareChatRequest({
      appId: CALLER,
      modelId: 'oa',
      messages: [{ role: 'user', content: 'hello' }],
      language: 'en',
      processMessageTemplates: async messages => messages,
      user: admin,
      chatId: `chat-${randomUUID()}`
    });
    assert.equal(result.success, true, result.error?.message);
    const toolIds = result.data.tools.map(tool => tool.id);
    assert.ok(toolIds.includes(`app__${PUBLISHED}`), toolIds.join(','));
    assert.ok(!toolIds.includes(`app__${UNPUBLISHED}`), toolIds.join(','));
    assert.ok(!JSON.stringify(result.data).includes(SECRET));
  });

  it('a call to the tool of an unpublished app is refused, for an admin in a chat too', async () => {
    for (const name of ['admin', 'contentAdmin', 'user']) {
      const result = await invokeAppTool({
        toolId: `app__${UNPUBLISHED}`,
        args: { message: 'hello' },
        user: user(name),
        chatId: `chat-${randomUUID()}`
      });
      assert.equal(result.error, true, name);
      assert.ok(!JSON.stringify(result).includes(SECRET), name);
    }
    // And the service the tool would run through, asked directly.
    const direct = await new ChatService().invokeAppInternal({
      appId: UNPUBLISHED,
      user: user('admin'),
      messages: [{ role: 'user', content: 'hello' }]
    });
    assert.equal(direct.status, 'error');
    assert.equal(direct.error.code, 'APP_NOT_FOUND');
    assert.equal(turns.length, 0);
  });

  it('the workflow chat route answers for an unpublished app as for an unknown id', async () => {
    setConfig({ features: { ...FEATURES, workflows: true } });
    const admin = user('admin');
    const executionId = `wf-exec-${randomUUID()}`;
    getExecutionRegistry().register(executionId, {
      userId: admin.id,
      workflowId: 'some-workflow',
      workflowName: { en: 'Some workflow' },
      status: 'completed',
      startedAt: new Date().toISOString()
    });
    const ask = appId =>
      as(
        'admin',
        request(server).post(`/api/workflows/executions/${executionId}/chat/${appId}`)
      ).send({});

    const unknown = await ask(UNKNOWN);
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.detail, 'App not found');
    for (const appId of [UNPUBLISHED, GATED]) {
      assert.deepEqual(shape(await ask(appId), appId), shape(unknown, UNKNOWN), appId);
    }
    // A published app passes the lookup (and stops later: the run has no state).
    const published = await ask(PUBLISHED);
    assert.notDeepEqual(shape(published, PUBLISHED), shape(unknown, UNKNOWN));
    assert.equal(published.body.detail, 'Execution not found');
  });
});

// --- The ratchet --------------------------------------------------------------

/** Every `.js` file under `dir`, without tests and dependencies. */
function sourceFiles(dir) {
  const out = [];
  for (const entry of fsSync.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'tests') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) out.push(full);
  }
  return out;
}

describe('raw app lookups (ratchet)', () => {
  /**
   * `getApps(`, `getAppsForUser(` and `getAppForUserById(` outside the admin
   * routes are raw lookups: they do not decide for the one who asks whether an
   * unpublished app is there. The published lists cannot see such an app, so a
   * route that looks an app up in one behaves differently in a content admin's
   * test chat than for the published app; `getApps(true)` sees every
   * unpublished app and must do its own check. A route that needs "the app
   * this request may run" calls `configCache.getAppForRequest(appId, req.user)`
   * instead. The baseline lists what is left, with the reason; it may only
   * shrink.
   */
  const BASELINE_FILE = path.join(here, 'app-unpublished-access.baseline.json');
  const SCOPES = ['server/routes', 'server/services/chat'];
  const EXCLUDED = 'server/routes/admin/';
  const RAW_LOOKUP = /\b(?:getApps|getAppsForUser|getAppForUserById)\(/g;

  function count() {
    const found = {};
    for (const scope of SCOPES) {
      for (const file of sourceFiles(path.join(repoRoot, scope))) {
        const relative = path.relative(repoRoot, file).split(path.sep).join('/');
        if (relative.startsWith(EXCLUDED)) continue;
        const calls = fsSync.readFileSync(file, 'utf8').match(RAW_LOOKUP)?.length ?? 0;
        if (calls > 0) found[relative] = calls;
      }
    }
    return found;
  }

  it('lists every remaining raw lookup, and none was added', () => {
    const baseline = JSON.parse(fsSync.readFileSync(BASELINE_FILE, 'utf8')).lookups;
    const found = count();
    const problems = [];
    for (const [file, calls] of Object.entries(found)) {
      const allowed = baseline[file]?.calls ?? 0;
      if (calls > allowed) {
        problems.push(
          `${file}: ${calls} raw app lookups, the baseline allows ${allowed}. ` +
            'Use configCache.getAppForRequest(appId, req.user) for the app a request runs.'
        );
      }
    }
    for (const [file, entry] of Object.entries(baseline)) {
      const calls = found[file] ?? 0;
      if (calls < entry.calls) {
        problems.push(
          `${file}: ${calls} raw app lookups left, lower the baseline (${entry.calls}).`
        );
      }
      if (typeof entry.why !== 'string' || entry.why.trim().length < 10) {
        problems.push(`${file}: the baseline entry names no reason.`);
      }
    }
    assert.deepEqual(problems, []);
  });

  it('the converted call sites hold no raw lookup any more', () => {
    const found = count();
    for (const file of [
      'server/routes/chat/sessionRoutes.js',
      'server/routes/magicPromptRoutes.js',
      'server/routes/integrations/scopes.js',
      'server/routes/integrations/userIntegrations.js',
      'server/routes/chat/conversationRoutes.js',
      'server/routes/chats.js',
      'server/services/chat/transcriptionTurn.js'
    ]) {
      assert.equal(found[file] ?? 0, 0, file);
    }
  });
});
