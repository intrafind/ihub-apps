/**
 * Scheduled tasks end to end on the server: the task service's
 * authorization and limits, a headless run producing a durable chat through
 * the real ChatService (scripted provider), the approval pause and its
 * continuation, runs that lose access, and the scheduling tools.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import configCache from '../configCache.js';
import ChatService from '../services/chat/ChatService.js';
import RequestBuilder from '../services/chat/RequestBuilder.js';
import { AgentLoop } from '../services/loop/AgentLoop.js';
import { bootstrapStorage, shutdownStorageBootstrap } from '../storage/bootstrap.js';
import { getChatRepository } from '../services/chat/ChatRepository.js';
import { enhanceUserWithPermissions } from '../utils/authorization.js';
import interactionService from '../services/loop/InteractionService.js';
import * as tasks from '../services/scheduler/tasks/taskService.js';
import { executeTaskRun } from '../services/scheduler/tasks/taskExecution.js';
import {
  findUserRecord,
  resolveOwnerPrincipal
} from '../services/scheduler/tasks/ownerPrincipal.js';
import { getScheduledTaskRepository } from '../services/scheduler/tasks/ScheduledTaskRepository.js';
import { filterSchedulingTools } from '../services/scheduler/tasks/toolGate.js';
import { chatToolSeam } from '../services/chat/chatSeams.js';
import {
  scheduleTask,
  updateScheduledTask,
  deleteScheduledTask
} from '../tools/scheduledTaskTools.js';
import { makeClient, sseResponse, openaiText, captureRunLog } from './loop/helpers/llmFixtures.js';

const MODELS = [
  {
    id: 'oa',
    provider: 'openai',
    modelId: 'gpt-4o',
    url: 'https://u/v1/chat/completions',
    autoDiscovery: false,
    supportsTools: true,
    default: true
  }
];

const APPS = [
  {
    id: 'digest',
    name: { en: 'Digest' },
    system: { en: 'You write digests.' },
    tools: [
      'lookup',
      'dangerous',
      'schedule_task',
      'list_scheduled_tasks',
      'update_scheduled_task'
    ],
    preferredModel: 'oa',
    enabled: true
  },
  {
    id: 'secret',
    name: { en: 'Secret' },
    system: { en: 'x' },
    preferredModel: 'oa',
    enabled: true
  }
];

const toolDef = async id =>
  JSON.parse(await fs.readFile(new URL(`../defaults/tools/${id}.json`, import.meta.url), 'utf8'));

const GROUPS = {
  groups: {
    users: {
      id: 'users',
      permissions: { apps: ['digest'], models: ['*'], prompts: [], scheduledTasks: true }
    },
    noTasks: { id: 'noTasks', permissions: { apps: ['digest'], models: ['*'], prompts: [] } },
    lostApp: {
      id: 'lostApp',
      permissions: { apps: ['secret'], models: ['*'], scheduledTasks: true }
    }
  }
};

const PLATFORM = {
  chats: { enabled: true },
  scheduledTasks: { staggerMinutes: 0, minIntervalMinutes: 15, maxTasksPerUser: 4 },
  auth: {}
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

before(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-scheduled-run-'));
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
  configCache.setCacheEntry('config/users.json', {
    users: {
      'user-lin': { id: 'user-lin', authMethods: ['local'], active: false },
      // Saved the task while in `users`, since moved to a group without the app.
      'user-kim': {
        id: 'user-kim',
        authMethods: ['local'],
        active: true,
        internalGroups: ['lostApp']
      }
    }
  });
  configCache.setCacheEntry('config/tools.json', [
    {
      id: 'lookup',
      name: 'lookup',
      description: 'Look up a record',
      script: 'lookup.js',
      parameters: { type: 'object', properties: { key: { type: 'string' } } }
    },
    {
      id: 'dangerous',
      name: 'dangerous',
      description: 'Does something with side effects',
      script: 'dangerous.js',
      requiresApproval: true,
      parameters: { type: 'object', properties: {} }
    },
    await toolDef('schedule_task'),
    await toolDef('list_scheduled_tasks'),
    await toolDef('update_scheduled_task')
  ]);
  await configCache.loadAndCacheLocale('en');
  ledger = await captureRunLog();
  interactionService.onAnswer(interaction => tasks.applyApprovalAnswer(interaction));
});

after(async () => {
  await shutdownStorageBootstrap();
  const rm = dir => fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  await rm(baseDir);
  await rm(ledger.baseDir);
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

/**
 * A ChatService over a scripted provider; records what was sent and which tools ran.
 * `onRequest` runs before each model call is answered.
 */
function scriptedChatService(script, { onRequest } = {}) {
  const queue = [...script];
  const requests = [];
  const ran = [];
  const { client } = makeClient({
    models: MODELS,
    runLog: ledger.runLog,
    transport: async req => {
      requests.push(req);
      await onRequest?.(req);
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
    runTool: async toolId => {
      ran.push(toolId);
      return { ok: true, toolId };
    },
    telemetry: { recordChatCallStart: async () => ({}), recordChatCallEnd: async () => {} }
  });
  return { service, requests, ran };
}

const DAILY = { type: 'daily', time: '08:00', timezone: 'Europe/Berlin' };

function taskInput(extra = {}) {
  return {
    name: 'Morning digest',
    instructions: 'Summarize what changed since {{last_successful_run_at}}. Run {{run_number}}.',
    appId: 'digest',
    schedule: DAILY,
    ...extra
  };
}

async function cleanup(user) {
  for (const task of await tasks.listTasks(user)) await tasks.deleteTask(user, task.id);
}

describe('task service authorization and limits', () => {
  const ada = () => principal({ id: 'user-ada', name: 'Ada' });

  it('creates a task and keeps it to its owner', async () => {
    const task = await tasks.createTask(ada(), taskInput());
    assert.equal(task.status, 'active');
    assert.ok(task.nextRunAt);
    assert.equal(task.owner.userId, 'user-ada');
    const listed = await tasks.listTasks(ada());
    assert.equal(listed.length, 1);
    assert.match(listed[0].scheduleDescription, /Every day at 08:00/);
    const grace = principal({ id: 'user-grace' });
    await assert.rejects(tasks.getTask(grace, task.id), { status: 404 });
    await assert.rejects(tasks.requestRun(grace, task.id), { status: 404 });
    await assert.rejects(tasks.deleteTask(grace, task.id), { status: 404 });
    await cleanup(ada());
  });

  it('refuses anonymous users, users without the permission and delegated tokens', async () => {
    await assert.rejects(tasks.createTask({ id: 'anonymous' }, taskInput()), { status: 401 });
    await assert.rejects(
      tasks.createTask(principal({ id: 'user-nt', groups: ['noTasks'] }), taskInput()),
      { status: 403, code: 'PERMISSION_DENIED' }
    );
    const keyUser = principal({ id: 'user-key', authMode: 'oauth_personal_key' });
    assert.equal(keyUser.permissions.scheduledTasks, false);
    await assert.rejects(tasks.createTask(keyUser, taskInput()), { status: 403 });
  });

  it('enforces the minimum interval on the server', async () => {
    await assert.rejects(
      tasks.createTask(
        ada(),
        taskInput({ schedule: { type: 'interval', every: 5, unit: 'minutes' } })
      ),
      error => error.status === 400 && error.details.some(d => d.code === 'BELOW_MIN_INTERVAL')
    );
  });

  it('refuses an app the user cannot use', async () => {
    await assert.rejects(tasks.createTask(ada(), taskInput({ appId: 'secret' })), error =>
      error.details.some(d => d.code === 'APP_NOT_ACCESSIBLE')
    );
  });

  it('caps tasks per user and refuses to save the same proposal twice', async () => {
    const user = ada();
    await tasks.createTask(user, taskInput(), { proposalId: 'proposal-0001' });
    await assert.rejects(tasks.createTask(user, taskInput(), { proposalId: 'proposal-0001' }), {
      code: 'PROPOSAL_ALREADY_SAVED'
    });
    for (let i = 0; i < 3; i++) await tasks.createTask(user, taskInput());
    await assert.rejects(tasks.createTask(user, taskInput()), {
      status: 409,
      code: 'TASK_LIMIT_REACHED'
    });
    await cleanup(user);
  });

  it('pauses and resumes, and refuses a second run while one is queued', async () => {
    const user = ada();
    const task = await tasks.createTask(user, taskInput());
    const paused = await tasks.setTaskStatus(user, task.id, 'paused');
    assert.equal(paused.status, 'paused');
    assert.equal(paused.nextRunAt, null);
    const resumed = await tasks.setTaskStatus(user, task.id, 'active');
    assert.equal(resumed.status, 'active');
    assert.ok(resumed.nextRunAt);
    await tasks.requestRun(user, task.id);
    await assert.rejects(tasks.requestRun(user, task.id), { code: 'RUN_IN_PROGRESS' });
    await cleanup(user);
  });
});

describe('a headless run', () => {
  const ada = () => principal({ id: 'user-ada', name: 'Ada' });

  it('runs as the owner and becomes an unread chat of its own', async () => {
    const user = ada();
    const task = await tasks.createTask(user, taskInput());
    const queued = await tasks.requestRun(user, task.id);
    const { service, requests } = scriptedChatService([openaiText(['All ', 'quiet.'])]);
    const run = await executeTaskRun(
      { taskId: task.id, runId: queued.id },
      { chatService: service }
    );

    assert.equal(run.status, 'succeeded');
    assert.equal(run.trigger, 'manual');
    assert.ok(run.startedAt && run.finishedAt);

    const system = requests[0].body.messages.find(m => m.role === 'system').content;
    assert.match(system, /Unattended run/);
    const userMessage = requests[0].body.messages.find(m => m.role === 'user').content;
    assert.match(userMessage, /since never\. Run 1\./);

    const repository = getChatRepository();
    const chat = await repository.getChat(run.chatId);
    assert.equal(chat.origin.createdVia, 'scheduled-task');
    assert.equal(chat.origin.taskId, task.id);
    assert.equal(chat.origin.runId, run.id);
    assert.equal(chat.appId, 'digest');
    assert.equal(chat.hasUnseenActivity, true);
    assert.match(chat.title, /^Morning digest · /);
    const { messages } = await repository.getMessages(run.chatId);
    assert.deepEqual(
      messages.map(m => [m.role, m.content]),
      [
        ['user', userMessage],
        ['assistant', 'All quiet.']
      ]
    );

    const stored = await getScheduledTaskRepository().getTask(task.id);
    assert.equal(stored.activeRun, null);
    assert.equal(stored.lastRun.status, 'succeeded');
    assert.ok(stored.lastSuccessfulRunAt);
    const notifications = await tasks.listNotifications(user);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].chatId, run.chatId);

    // Opening the chat is what "seen" means.
    await tasks.markRunChatSeen({ ...chat, ownerId: stored.ownerId });
    assert.equal((await tasks.listNotifications(user)).length, 0);

    // The second run sees the first one's time.
    const second = await tasks.requestRun(user, task.id);
    const next = scriptedChatService([openaiText(['Again.'])]);
    await executeTaskRun({ taskId: task.id, runId: second.id }, { chatService: next.service });
    const secondUser = next.requests[0].body.messages.find(m => m.role === 'user').content;
    assert.doesNotMatch(secondUser, /since never/);
    assert.match(secondUser, /Run 2\./);
    await cleanup(user);
  });

  it('pauses for approval, continues once approved, and remembers "always allow"', async () => {
    const user = ada();
    const task = await tasks.createTask(user, taskInput());
    const queued = await tasks.requestRun(user, task.id);
    const first = scriptedChatService([toolCall('dangerous')]);
    const paused = await executeTaskRun(
      { taskId: task.id, runId: queued.id },
      { chatService: first.service }
    );
    assert.equal(paused.status, 'awaiting_approval');
    assert.equal(paused.approval.toolId, 'dangerous');
    assert.deepEqual(first.ran, []);
    let stored = await getScheduledTaskRepository().getTask(task.id);
    assert.equal(stored.activeRun.status, 'awaiting_approval');
    const pending = await interactionService.get(paused.approval.interactionId);
    assert.equal(pending.status, 'pending');
    assert.equal(pending.kind, 'approval');

    const approved = await tasks.answerApproval(user, task.id, queued.id, {
      decision: 'approve',
      alwaysAllow: true
    });
    assert.equal(approved.status, 'queued');
    stored = await getScheduledTaskRepository().getTask(task.id);
    assert.deepEqual(
      stored.allowedTools.map(entry => entry.toolId),
      ['dangerous']
    );
    assert.equal(stored.activeRun.status, 'queued');

    const second = scriptedChatService([toolCall('dangerous'), openaiText(['Done.'])]);
    const done = await executeTaskRun(
      { taskId: task.id, runId: queued.id },
      { chatService: second.service }
    );
    assert.equal(done.status, 'succeeded');
    assert.deepEqual(second.ran, ['dangerous']);
    const { messages } = await getChatRepository().getMessages(done.chatId);
    assert.ok(messages.some(m => m.role === 'user' && /^Approved by/.test(m.content)));
    assert.equal(messages[messages.length - 1].content, 'Done.');

    // Revoked: the next run asks again.
    await tasks.revokeAllowedTool(user, task.id, 'dangerous');
    stored = await getScheduledTaskRepository().getTask(task.id);
    assert.deepEqual(stored.allowedTools, []);
    await cleanup(user);
  });

  it('a rejected approval cancels the run', async () => {
    const user = ada();
    const task = await tasks.createTask(user, taskInput());
    const queued = await tasks.requestRun(user, task.id);
    const { service } = scriptedChatService([toolCall('dangerous')]);
    await executeTaskRun({ taskId: task.id, runId: queued.id }, { chatService: service });
    const rejected = await tasks.answerApproval(user, task.id, queued.id, { decision: 'reject' });
    assert.equal(rejected.status, 'cancelled');
    assert.equal(rejected.reason.code, 'APPROVAL_REJECTED');
    const stored = await getScheduledTaskRepository().getTask(task.id);
    assert.equal(stored.activeRun, null);
    await cleanup(user);
  });

  it('skips the run and pauses the task when the owner lost the app', async () => {
    const user = ada();
    const task = await tasks.createTask(user, taskInput());
    const repository = getScheduledTaskRepository();
    await repository.mutateTask(task.id, stored => {
      stored.owner.groups = ['lostApp'];
      return stored;
    });
    const queued = await tasks.requestRun(user, task.id);
    const { service, requests } = scriptedChatService([]);
    const run = await executeTaskRun(
      { taskId: task.id, runId: queued.id },
      { chatService: service }
    );
    assert.equal(run.status, 'skipped');
    assert.equal(run.reason.code, 'APP_NOT_ACCESSIBLE');
    assert.equal(requests.length, 0);
    const stored = await repository.getTask(task.id);
    assert.equal(stored.status, 'paused');
    assert.equal(stored.statusReason.code, 'APP_NOT_ACCESSIBLE');
    await cleanup(user);
  });

  it('disables the task of a deactivated local account', async () => {
    const lin = principal({ id: 'user-lin', authMode: 'local' });
    const task = await tasks.createTask(lin, taskInput());
    const queued = await tasks.requestRun(lin, task.id);
    const run = await executeTaskRun(
      { taskId: task.id, runId: queued.id },
      { chatService: scriptedChatService([]).service }
    );
    assert.equal(run.reason.code, 'OWNER_DEACTIVATED');
    const stored = await getScheduledTaskRepository().getTask(task.id);
    assert.equal(stored.status, 'disabled');
    await cleanup(lin);
  });

  it('holds a lease while it runs, and does not overwrite a run another owner recovered', async () => {
    const user = ada();
    const task = await tasks.createTask(user, taskInput());
    const queued = await tasks.requestRun(user, task.id);
    const repository = getScheduledTaskRepository();
    let lease = null;
    const { service } = scriptedChatService([openaiText(['Too ', 'late.'])], {
      // While the model answers, this worker stalls and a new scheduler owner
      // takes the run over as interrupted.
      onRequest: async () => {
        const running = await repository.getRun(task.id, queued.id);
        lease = running.execution;
        await repository.mutateRun(task.id, queued.id, stored => ({
          ...stored,
          status: 'failed',
          reason: { code: 'INTERRUPTED', message: 'The server stopped' }
        }));
      }
    });
    await executeTaskRun({ taskId: task.id, runId: queued.id }, { chatService: service });

    assert.ok(lease?.token);
    assert.ok(Date.parse(lease.leaseUntil) > Date.now());
    const stored = await repository.getRun(task.id, queued.id);
    assert.equal(stored.status, 'failed');
    assert.equal(stored.reason.code, 'INTERRUPTED');
    await cleanup(user);
  });

  it('runs a local owner with the groups users.json gives them now, not the saved ones', async () => {
    const kim = principal({ id: 'user-kim', authMode: 'local', groups: ['users'] });
    const task = await tasks.createTask(kim, taskInput());
    const queued = await tasks.requestRun(kim, task.id);
    const { service, requests } = scriptedChatService([]);
    const run = await executeTaskRun(
      { taskId: task.id, runId: queued.id },
      { chatService: service }
    );
    assert.equal(run.status, 'skipped');
    assert.equal(run.reason.code, 'APP_NOT_ACCESSIBLE');
    assert.equal(requests.length, 0);
    await cleanup(kim);
  });

  it('retries, rather than disables, when users.json cannot be read', () => {
    const lookup = findUserRecord(
      'user-kim',
      {},
      { load: () => ({ users: {}, metadata: { error: 'Unexpected end of JSON input' } }) }
    );
    assert.equal(lookup.found, false);
    assert.ok(lookup.error);
    const result = resolveOwnerPrincipal(
      { owner: { userId: 'user-kim', authMode: 'local' } },
      { platform: PLATFORM, lookupUser: () => lookup }
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, 'OWNER_LOOKUP_FAILED');
    assert.equal(result.action, 'retry');
  });

  it('lets an owner whose permission was withdrawn pause a task, but not resume it', async () => {
    const user = ada();
    const task = await tasks.createTask(user, taskInput());
    const withdrawn = principal({ id: 'user-ada', name: 'Ada', groups: ['noTasks'] });
    const paused = await tasks.setTaskStatus(withdrawn, task.id, 'paused');
    assert.equal(paused.status, 'paused');
    await assert.rejects(tasks.setTaskStatus(withdrawn, task.id, 'active'), {
      code: 'PERMISSION_DENIED'
    });
    await cleanup(user);
  });

  it('saves a proposal once and keeps to the limit when saves race', async () => {
    const user = ada();
    const results = await Promise.allSettled(
      Array.from({ length: 3 }, () =>
        tasks.createTask(user, taskInput(), { proposalId: 'proposal-race-1' })
      )
    );
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.ok(
      results
        .filter(r => r.status === 'rejected')
        .every(r => r.reason.code === 'PROPOSAL_ALREADY_SAVED')
    );
    const limited = await Promise.allSettled(
      Array.from({ length: 6 }, () => tasks.createTask(user, taskInput()))
    );
    assert.equal((await tasks.listTasks(user)).length, PLATFORM.scheduledTasks.maxTasksPerUser);
    assert.ok(limited.some(r => r.status === 'rejected' && r.reason.code === 'TASK_LIMIT_REACHED'));
    await cleanup(user);
  });

  it('disables the task of an external owner whose account record was deleted', async () => {
    const eve = principal({ id: 'user-eve', authMode: 'oidc', groups: ['users'] });
    const users = configCache.get('config/users.json');
    configCache.setCacheEntry('config/users.json', {
      ...users.data,
      users: {
        ...users.data.users,
        'user-eve': { id: 'user-eve', authMethods: ['oidc'], active: true }
      }
    });
    const task = await tasks.createTask(eve, taskInput());
    assert.equal(task.owner.recorded, true);
    // An administrator removes the account.
    configCache.setCacheEntry('config/users.json', users.data);
    const queued = await tasks.requestRun(eve, task.id);
    const run = await executeTaskRun(
      { taskId: task.id, runId: queued.id },
      { chatService: scriptedChatService([]).service }
    );
    assert.equal(run.reason.code, 'OWNER_DELETED');
    assert.equal((await getScheduledTaskRepository().getTask(task.id)).status, 'disabled');
    await cleanup(eve);
  });

  it('an admin disabling a task releases its queued run, so re-enabling it works', async () => {
    const user = ada();
    const task = await tasks.createTask(user, taskInput());
    const queued = await tasks.requestRun(user, task.id);
    const disabled = await tasks.adminSetTaskStatus({ username: 'root' }, task.id, 'disabled');
    assert.equal(disabled.status, 'disabled');
    assert.equal(disabled.activeRun, null);
    const run = await getScheduledTaskRepository().getRun(task.id, queued.id);
    assert.equal(run.status, 'cancelled');
    assert.equal(run.reason.code, 'DISABLED_BY_ADMIN');
    await tasks.adminSetTaskStatus({ username: 'root' }, task.id, 'active');
    const again = await tasks.requestRun(user, task.id);
    assert.equal(again.status, 'queued');
    await cleanup(user);
  });
});

describe('scheduling tools', () => {
  const ada = () => principal({ id: 'user-ada', name: 'Ada' });
  const app = APPS[0];

  it('schedule_task proposes and saves nothing', async () => {
    const result = await scheduleTask({
      name: 'Standup notes',
      instructions: 'Collect standup notes',
      schedule: { type: 'weekdays', time: '09:00' },
      user: ada(),
      appConfig: app,
      chatId: 'chat-1',
      clientTimezone: 'Europe/Berlin',
      language: 'en'
    });
    assert.equal(result.status, 'proposed');
    assert.equal(result.saved, false);
    assert.equal(result.scheduledTaskProposal.action, 'create');
    assert.equal(result.scheduledTaskProposal.draft.appId, 'digest');
    assert.equal(result.scheduledTaskProposal.draft.schedule.timezone, 'Europe/Berlin');
    assert.equal(result.summary.nextRuns.length, 5);
    assert.equal((await tasks.listTasks(ada())).length, 0);
  });

  it('schedule_task reports what is wrong so the model can fix it', async () => {
    const result = await scheduleTask({
      name: 'Too often',
      instructions: 'x',
      schedule: { type: 'cron', cron: '*/5 * * * *' },
      user: ada(),
      appConfig: app
    });
    assert.equal(result.error, true);
    assert.equal(result.code, 'INVALID_TASK');
  });

  it('is refused inside a scheduled run, where a task may only reschedule or pause itself', async () => {
    const user = ada();
    const task = await tasks.createTask(user, taskInput());
    const inRun = Object.assign(ada(), { scheduledRun: { taskId: task.id, runId: 'r' } });
    assert.equal(
      (await scheduleTask({ name: 'x', instructions: 'y', schedule: DAILY, user: inRun })).code,
      'NOT_AVAILABLE'
    );
    assert.equal(
      (await deleteScheduledTask({ taskId: task.id, user: inRun })).code,
      'NOT_AVAILABLE'
    );
    const other = await tasks.createTask(user, taskInput({ name: 'Other' }));
    assert.equal(
      (await updateScheduledTask({ taskId: other.id, status: 'paused', user: inRun })).code,
      'NOT_AVAILABLE'
    );
    assert.equal(
      (await updateScheduledTask({ taskId: task.id, instructions: 'new', user: inRun })).code,
      'NOT_AVAILABLE'
    );
    const self = await updateScheduledTask({
      taskId: task.id,
      schedule: { type: 'weekly', time: '07:00', days: ['mon'], timezone: 'UTC' },
      user: inRun
    });
    assert.equal(self.status, 'updated');
    assert.match(self.schedule, /Monday/);
    const pausedSelf = await updateScheduledTask({
      taskId: task.id,
      status: 'paused',
      user: inRun
    });
    assert.equal(pausedSelf.taskStatus, 'paused');
    await cleanup(user);
  });

  it('update_scheduled_task proposes changes to what a task does', async () => {
    const user = ada();
    const task = await tasks.createTask(user, taskInput());
    const result = await updateScheduledTask({
      taskId: task.id,
      instructions: 'Something else',
      user
    });
    assert.equal(result.status, 'proposed');
    assert.equal(result.scheduledTaskProposal.action, 'update');
    const stored = await getScheduledTaskRepository().getTask(task.id);
    assert.equal(stored.instructions, task.instructions);
    await cleanup(user);
  });

  it('the tool gate withholds the tools without permission and inside a run', () => {
    const toolList = [{ id: 'schedule_task' }, { id: 'list_scheduled_tasks' }, { id: 'lookup' }];
    const ids = list => list.map(t => t.id);
    assert.deepEqual(ids(filterSchedulingTools(toolList, ada())), [
      'schedule_task',
      'list_scheduled_tasks',
      'lookup'
    ]);
    assert.deepEqual(
      ids(filterSchedulingTools(toolList, principal({ id: 'x', groups: ['noTasks'] }))),
      ['lookup']
    );
    const inRun = Object.assign(ada(), { scheduledRun: { taskId: 't', runId: 'r' } });
    assert.deepEqual(ids(filterSchedulingTools(toolList, inRun)), [
      'list_scheduled_tasks',
      'lookup'
    ]);
  });

  it('only the scheduling tools can put a confirmation card in the chat', async () => {
    const frames = [];
    const proposals = [];
    const seam = chatToolSeam({
      chatId: 'c',
      buildLogData: () => ({}),
      logInteraction: async () => {},
      scheduledTaskProposals: proposals
    });
    const ctx = { iteration: 1, meta: { stream: { emit: (type, data) => frames.push(data) } } };
    const proposal = { proposalId: 'p-12345678', action: 'create', draft: {}, summary: {} };
    const outcome = () => ({
      rawResult: { scheduledTaskProposal: proposal },
      message: { content: '' }
    });
    await seam.postTool(
      ctx,
      { toolId: 'evil', toolDef: { id: 'evil', script: 'evil.js' }, call: { id: '1' } },
      outcome()
    );
    await seam.postTool(
      ctx,
      {
        toolId: 'schedule_task',
        toolDef: { id: 'schedule_task', script: 'scheduledTaskTools.js' },
        call: { id: '2' }
      },
      outcome()
    );
    assert.equal(frames[0].scheduledTaskProposal, undefined);
    assert.equal(frames[1].scheduledTaskProposal.proposalId, 'p-12345678');
    assert.equal(proposals.length, 1);
  });
});
