// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Scheduled tasks snapshot their integration scopes (#3057): a task stores
 * `integrationScopes` when it is saved (from the chat it was scheduled from,
 * or picked in the editor), every run binds its tools to that snapshot and
 * never reads chat state, and a scope the owner lost fails the run with an
 * error naming it instead of searching elsewhere.
 *
 * A stand-in integration (`fakeStore`) registers its scopes with the scope
 * registry, so the tests do not depend on iFinder.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import configCache from '../configCache.js';
import ChatService from '../services/chat/ChatService.js';
import RequestBuilder from '../services/chat/RequestBuilder.js';
import { AgentLoop } from '../services/loop/AgentLoop.js';
import { bootstrapStorage, shutdownStorageBootstrap } from '../storage/bootstrap.js';
import { getChatRepository } from '../services/chat/ChatRepository.js';
import { enhanceUserWithPermissions } from '../utils/authorization.js';
import * as tasks from '../services/scheduler/tasks/taskService.js';
import { executeTaskRun } from '../services/scheduler/tasks/taskExecution.js';
import { getScheduledTaskRepository } from '../services/scheduler/tasks/ScheduledTaskRepository.js';
import { registerScopeProvider } from '../services/integrations/scopes/index.js';
import { scheduleTask } from '../tools/scheduledTaskTools.js';
import { makeClient, sseResponse, openaiText, captureRunLog } from './loop/helpers/llmFixtures.js';
import { harnessIntegrations, harnessTools } from './helpers/scheduledTaskHarness.js';

const MODELS = [
  {
    id: 'oa',
    provider: 'openai',
    modelId: 'gpt-4o',
    url: 'https://u/v1/chat/completions',
    autoDiscovery: false,
    supportsTools: 'auto',
    default: true
  }
];

const APPS = [
  {
    id: 'digest',
    name: { en: 'Digest' },
    system: { en: 'You write digests.' },
    integrations: {
      lookup: {},
      ihub: { actions: ['schedule_task'] }
    },
    preferredModel: 'oa',
    enabled: true
  },
  {
    id: 'plain',
    name: { en: 'Plain' },
    system: { en: 'x' },
    integrations: { lookup: {} },
    preferredModel: 'oa',
    enabled: true
  }
];

const GROUPS = {
  groups: {
    users: {
      id: 'users',
      permissions: {
        apps: ['digest', 'plain'],
        models: ['*'],
        prompts: [],
        integrations: ['*'],
        scheduledTasks: true
      }
    }
  }
};

const PLATFORM = {
  chats: { enabled: true },
  scheduledTasks: { staggerMinutes: 0, minIntervalMinutes: 15, maxTasksPerUser: 20 },
  auth: {}
};

/** What the stand-in integration offers the user right now. */
let offered;

/** A scope provider like iFinder's: the user's own list, checked on every turn. */
const fakeStore = {
  id: 'fakeStore',
  name: { en: 'Fake store' },
  action: 'search',
  // Only the `digest` app uses the integration.
  appliesTo: ({ app }) => app?.id === 'digest',
  async listScopes() {
    const scopes = [...offered].map(id => ({ id, name: id.toUpperCase() }));
    return { scopes, defaultScope: scopes[0]?.id, fixed: false, verified: true, source: 'test' };
  },
  async validateScope({ scopeId }) {
    if (!scopeId || offered.has(scopeId)) return { ok: true, scopeId: scopeId || null };
    return {
      ok: false,
      code: 'INTEGRATION_SCOPE_NOT_ALLOWED',
      message: `The scope "${scopeId}" is not available to you`
    };
  }
};

let baseDir;
let ledger;

function principal(fields) {
  return enhanceUserWithPermissions(
    { authMode: 'oidc', groups: ['users'], ...fields },
    {},
    configCache.getPlatform()
  );
}

const ada = () => principal({ id: 'user-ada', name: 'Ada' });

before(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-scheduled-scopes-'));
  await bootstrapStorage({
    storage: { provider: 'filesystem', filesystem: { baseDir, flushIntervalMs: 25 } }
  });
  configCache.setCacheEntry('config/features.json', {
    chatPersistence: true,
    scheduledTasks: true
  });
  configCache.setCacheEntry('config/platform.json', PLATFORM);
  configCache.setCacheEntry('config/apps.json', APPS);
  configCache.setCacheEntry('config/models.json', MODELS);
  configCache.setCacheEntry('config/groups.json', GROUPS);
  configCache.setCacheEntry('config/users.json', { users: {} });
  configCache.setCacheEntry('config/tools.json', await harnessTools());
  configCache.setCacheEntry('config/integrations.json', harnessIntegrations());
  await configCache.loadAndCacheLocale('en');
  ledger = await captureRunLog();
  registerScopeProvider(fakeStore);
});

after(async () => {
  await shutdownStorageBootstrap();
  const rm = dir => fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  await rm(baseDir);
  await rm(ledger.baseDir);
});

beforeEach(() => {
  offered = new Set(['contracts', 'hr']);
});

const silent = { debug() {}, info() {}, warn() {}, error() {} };

function toolCall(name, args = {}, id = 'call_1') {
  return [
    {
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id,
                type: 'function',
                function: { name, arguments: JSON.stringify(args) }
              }
            ]
          },
          finish_reason: null
        }
      ]
    },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    '[DONE]'
  ];
}

/** A ChatService over a scripted provider; records the params every tool call got. */
function scriptedChatService(script) {
  const queue = [...script];
  const requests = [];
  const calls = [];
  const { client } = makeClient({
    models: MODELS,
    runLog: ledger.runLog,
    transport: async req => {
      requests.push(req);
      const next = queue.shift();
      if (!next) throw new Error(`script exhausted after ${requests.length} calls`);
      return sseResponse(next);
    }
  });
  const requestBuilder = new RequestBuilder();
  requestBuilder.apiKeyVerifier = {
    verifyApiKey: async () => ({ success: true, apiKey: 'sk-test' })
  };
  const service = new ChatService({
    requestBuilder,
    agentLoop: new AgentLoop({ llmClient: client, logger: silent, runLog: ledger.runLog }),
    runLog: ledger.runLog,
    logInteraction: async () => {},
    runTool: async (toolId, params) => {
      calls.push({ toolId, integrationScopes: params.integrationScopes });
      return { ok: true };
    },
    telemetry: { recordChatCallStart: async () => ({}), recordChatCallEnd: async () => {} }
  });
  return { service, requests, calls };
}

function taskInput(extra = {}) {
  return {
    name: 'Contract digest',
    instructions: 'Look up new contracts.',
    appId: 'digest',
    schedule: { type: 'daily', time: '08:00', timezone: 'Europe/Berlin' },
    ...extra
  };
}

async function cleanup(user) {
  for (const task of await tasks.listTasks(user)) await tasks.deleteTask(user, task.id);
}

const fieldErrorOf = error =>
  error.details?.issues?.find(detail => detail.field === 'integrationScopes');

describe('saving a task with integration scopes', () => {
  it('stores the scopes the owner may use, and returns them', async () => {
    const user = ada();
    const task = await tasks.createTask(
      user,
      taskInput({ integrationScopes: { fakeStore: 'contracts' } })
    );
    assert.deepEqual(task.integrationScopes, { fakeStore: 'contracts' });
    const [listed] = await tasks.listTasks(user);
    assert.deepEqual(listed.integrationScopes, { fakeStore: 'contracts' });
    await cleanup(user);
  });

  it('refuses a scope the owner may not use, naming it', async () => {
    await assert.rejects(
      tasks.createTask(ada(), taskInput({ integrationScopes: { fakeStore: 'board' } })),
      error => {
        const detail = fieldErrorOf(error);
        return (
          error.status === 400 &&
          detail?.code === 'INTEGRATION_SCOPE_NOT_ALLOWED' &&
          /"board"/.test(detail.message)
        );
      }
    );
  });

  it('refuses scopes that are not an id map', async () => {
    for (const integrationScopes of ['contracts', ['contracts'], { fakeStore: 42 }]) {
      await assert.rejects(
        tasks.createTask(ada(), taskInput({ integrationScopes })),
        error => fieldErrorOf(error)?.code === 'INVALID'
      );
    }
  });

  it('stores nothing for no scopes, or scopes of integrations the app does not use', async () => {
    const user = ada();
    const none = await tasks.createTask(user, taskInput({ integrationScopes: {} }));
    assert.equal(none.integrationScopes, null);
    const absent = await tasks.createTask(user, taskInput());
    assert.equal(absent.integrationScopes, null);
    const otherApp = await tasks.createTask(
      user,
      taskInput({ appId: 'plain', integrationScopes: { fakeStore: 'contracts' } })
    );
    assert.equal(otherApp.integrationScopes, null);
    await cleanup(user);
  });

  it('keeps the scopes on an edit that does not name them, and on a copy', async () => {
    const user = ada();
    const task = await tasks.createTask(
      user,
      taskInput({ integrationScopes: { fakeStore: 'hr' } })
    );
    const renamed = await tasks.updateTask(user, task.id, { name: 'HR digest' });
    assert.deepEqual(renamed.integrationScopes, { fakeStore: 'hr' });
    const changed = await tasks.updateTask(user, task.id, {
      integrationScopes: { fakeStore: 'contracts' }
    });
    assert.deepEqual(changed.integrationScopes, { fakeStore: 'contracts' });
    const copy = await tasks.duplicateTask(user, task.id);
    assert.deepEqual(copy.integrationScopes, { fakeStore: 'contracts' });
    // A scope the owner lost is reported on the next edit.
    offered = new Set(['hr']);
    await assert.rejects(
      tasks.updateTask(user, task.id, { name: 'x' }),
      error => fieldErrorOf(error)?.code === 'INTEGRATION_SCOPE_NOT_ALLOWED'
    );
    await cleanup(user);
  });
});

describe('a run of a task with integration scopes', () => {
  it('binds every tool call to the snapshot, whatever the source chat does later', async () => {
    const user = ada();
    const task = await tasks.createTask(
      user,
      taskInput({ integrationScopes: { fakeStore: 'contracts' } }),
      { sourceChatId: 'chat-source-1' }
    );
    // The chat it was scheduled from is never read: only the snapshot counts.
    const chats = getChatRepository();
    const queued = await tasks.requestRun(user, task.id);
    const { service, calls } = scriptedChatService([
      toolCall('lookup', { key: 'q' }),
      openaiText(['Nothing new.'])
    ]);
    const run = await executeTaskRun(
      { taskId: task.id, runId: queued.id },
      { chatService: service }
    );
    assert.equal(run.status, 'succeeded');
    assert.deepEqual(calls, [{ toolId: 'lookup', integrationScopes: { fakeStore: 'contracts' } }]);
    // The run's chat continues in the task's scope when the owner opens it.
    const chat = await chats.getChat(run.chatId);
    assert.deepEqual(chat.settings.integrationScopes, { fakeStore: 'contracts' });
    await cleanup(user);
  });

  it('fails, naming the scope, once the owner lost it, without asking the model', async () => {
    const user = ada();
    const task = await tasks.createTask(
      user,
      taskInput({ integrationScopes: { fakeStore: 'contracts' } })
    );
    offered = new Set(['hr']);
    const queued = await tasks.requestRun(user, task.id);
    const { service, requests, calls } = scriptedChatService([openaiText(['unused'])]);
    const run = await executeTaskRun(
      { taskId: task.id, runId: queued.id },
      { chatService: service }
    );
    assert.equal(run.status, 'failed');
    assert.equal(run.reason.code, 'INTEGRATION_SCOPE_NOT_ALLOWED');
    assert.match(run.reason.message, /"contracts"/);
    assert.equal(run.reason.integrationId, 'fakeStore');
    assert.equal(requests.length, 0);
    assert.deepEqual(calls, []);
    const stored = await getScheduledTaskRepository().getTask(task.id);
    assert.equal(stored.lastRun.status, 'failed');
    await cleanup(user);
  });

  it('runs a task without a snapshot unscoped, as before', async () => {
    const user = ada();
    const task = await tasks.createTask(user, taskInput());
    const queued = await tasks.requestRun(user, task.id);
    const { service, calls } = scriptedChatService([
      toolCall('lookup', { key: 'q' }),
      openaiText(['Done.'])
    ]);
    const run = await executeTaskRun(
      { taskId: task.id, runId: queued.id },
      { chatService: service }
    );
    assert.equal(run.status, 'succeeded');
    assert.deepEqual(calls, [{ toolId: 'lookup', integrationScopes: {} }]);
    await cleanup(user);
  });
});

describe('schedule_task from a chat', () => {
  const app = APPS[0];

  it('snapshots the chat’s scopes for a task of the chat’s own app', async () => {
    const result = await scheduleTask({
      name: 'Contracts weekly',
      instructions: 'Find new contracts',
      schedule: { type: 'weekdays', time: '09:00' },
      user: ada(),
      appConfig: app,
      chatId: 'chat-1',
      integrationScopes: { fakeStore: 'contracts' },
      clientTimezone: 'Europe/Berlin',
      language: 'en'
    });
    assert.equal(result.status, 'proposed');
    assert.deepEqual(result.scheduledTaskProposal.draft.integrationScopes, {
      fakeStore: 'contracts'
    });
  });

  it('does not carry the chat’s scopes to another app', async () => {
    const result = await scheduleTask({
      name: 'Plain weekly',
      instructions: 'x',
      appId: 'plain',
      schedule: { type: 'weekdays', time: '09:00' },
      user: ada(),
      appConfig: app,
      integrationScopes: { fakeStore: 'contracts' }
    });
    assert.equal(result.status, 'proposed');
    assert.equal(result.scheduledTaskProposal.draft.integrationScopes, null);
  });
});
