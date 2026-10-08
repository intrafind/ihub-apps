/**
 * A scheduled-task test harness: real filesystem storage in a temp directory,
 * a populated config cache, and a real ChatService over a scripted provider.
 *
 * Nothing in the scheduler is mocked. The only fake is the model: a script of
 * streamed responses that the test hands in, and a record of every request the
 * model was sent.
 *
 * Each test file runs in its own process, so the module state here (the temp
 * directory, the ledger) belongs to one file.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import configCache from '../../configCache.js';
import ChatService from '../../services/chat/ChatService.js';
import RequestBuilder from '../../services/chat/RequestBuilder.js';
import { AgentLoop } from '../../services/loop/AgentLoop.js';
import { bootstrapStorage, shutdownStorageBootstrap } from '../../storage/bootstrap.js';
import { enhanceUserWithPermissions } from '../../utils/authorization.js';
import interactionService from '../../services/loop/InteractionService.js';
import * as tasks from '../../services/scheduler/tasks/taskService.js';
import { makeClient, sseResponse, openaiText, captureRunLog } from '../loop/helpers/llmFixtures.js';

export const MODELS = [
  {
    id: 'oa',
    provider: 'openai',
    modelId: 'gpt-4o',
    url: 'https://u/v1/chat/completions',
    autoDiscovery: false,
    supportsTools: true,
    default: true
  },
  {
    id: 'nt',
    provider: 'openai',
    modelId: 'local-model',
    url: 'https://u/v1/chat/completions',
    autoDiscovery: false,
    supportsTools: false
  }
];

export const APPS = [
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
    id: 'plain',
    name: { en: 'Plain' },
    system: { en: 'You answer.' },
    preferredModel: 'oa',
    enabled: true
  },
  {
    id: 'notools',
    name: { en: 'No tools' },
    system: { en: 'You answer without tools.' },
    preferredModel: 'nt',
    enabled: true
  }
];

export const GROUPS = {
  groups: {
    users: {
      id: 'users',
      permissions: {
        apps: ['digest', 'plain', 'notools'],
        models: ['*'],
        prompts: [],
        scheduledTasks: true
      }
    },
    noTasks: { id: 'noTasks', permissions: { apps: ['digest'], models: ['*'], prompts: [] } }
  }
};

export const BASE_PLATFORM = {
  chats: { enabled: true },
  scheduledTasks: { staggerMinutes: 0, minIntervalMinutes: 15, maxTasksPerUser: 10 },
  auth: {}
};

export const DAILY = { type: 'daily', time: '08:00', timezone: 'Europe/Berlin' };

export const silent = { debug() {}, info() {}, warn() {}, error() {} };

let baseDir = null;
let ledger = null;

/** A default tool definition, as shipped. */
export async function toolDef(id) {
  return JSON.parse(
    await fs.readFile(new URL(`../../defaults/tools/${id}.json`, import.meta.url), 'utf8')
  );
}

/** The tools every harness registers, plus the defaults a test asks for by id. */
export async function harnessTools(defaultToolIds = []) {
  return [
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
    await toolDef('update_scheduled_task'),
    ...(await Promise.all(defaultToolIds.map(toolDef)))
  ];
}

/**
 * Bring storage and the config cache up.
 *
 * @param {Object} [options]
 * @param {Object} [options.platform] - Merged over {@link BASE_PLATFORM}; `scheduledTasks` is merged one level deep.
 * @param {Object[]} [options.models]
 * @param {Object[]} [options.apps]
 * @param {Object} [options.users]
 * @param {string[]} [options.defaultTools] - Ids of shipped tool files to register (`read_memory`, …).
 * @returns {Promise<{baseDir: string, ledger: Object}>}
 */
export async function setupHarness({
  platform = {},
  models = MODELS,
  apps = APPS,
  users = {},
  defaultTools = []
} = {}) {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-scheduled-memory-'));
  await bootstrapStorage({
    storage: { provider: 'filesystem', filesystem: { baseDir, flushIntervalMs: 25 } }
  });
  configCache.setCacheEntry('config/features.json', {
    chatPersistence: true,
    scheduledTasks: true
  });
  setPlatform(platform);
  configCache.setCacheEntry('config/apps.json', apps);
  configCache.setCacheEntry('config/models.json', models);
  configCache.setCacheEntry('config/groups.json', GROUPS);
  configCache.setCacheEntry('config/users.json', { users });
  configCache.setCacheEntry('config/tools.json', await harnessTools(defaultTools));
  await configCache.loadAndCacheLocale('en');
  ledger = await captureRunLog();
  interactionService.onAnswer(interaction => tasks.applyApprovalAnswer(interaction));
  return { baseDir, ledger };
}

/** Replace the platform config (the settings the test is about). */
export function setPlatform(platform = {}) {
  configCache.setCacheEntry('config/platform.json', {
    ...BASE_PLATFORM,
    ...platform,
    scheduledTasks: { ...BASE_PLATFORM.scheduledTasks, ...(platform.scheduledTasks || {}) }
  });
}

export async function teardownHarness() {
  await shutdownStorageBootstrap();
  const rm = dir => fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  if (baseDir) await rm(baseDir);
  if (ledger) await rm(ledger.baseDir);
}

export function getLedger() {
  return ledger;
}

/** An expanded principal, as a signed-in user. */
export function principal(fields) {
  return enhanceUserWithPermissions(
    { authMode: 'oidc', groups: ['users'], ...fields },
    {},
    configCache.getPlatform()
  );
}

/** A streamed tool-call response. */
export function toolCall(name, args = {}, id = 'call_1') {
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

/** What the memory composer's system prompt starts with: how its calls are told from a turn's. */
const COMPOSER_PROMPT_START = 'You maintain the notes of a scheduled task';

/**
 * A composer that leaves the notes as they are and says something changed:
 * it hands back the notes it was shown. Most tests are about something else
 * and only need the composer out of the way.
 *
 * @param {string} userMessage - The message the composer was given.
 * @returns {string}
 */
export function echoComposer(userMessage) {
  const section = name => {
    const match = userMessage.match(new RegExp(`## ${name}[^\\n]*\\n([\\s\\S]*?)(?=\\n\\n## |$)`));
    return match ? match[1].trim() : null;
  };
  const shown = section('Current notes') ?? section('Notes before this run') ?? '';
  const notes = shown === '(none)' || shown === '(empty)' ? '' : shown;
  return `<changed>yes</changed>\n<notes>\n${notes}\n</notes>`;
}

/** The reply a composer gives: whether something changed, and the notes. */
export function composerReply(notes, changed = true) {
  return `<changed>${changed ? 'yes' : 'no'}</changed>\n<notes>\n${notes}\n</notes>`;
}

/**
 * A ChatService over a scripted provider. Records what was sent and which
 * tools ran.
 *
 * The memory composer's calls go through the same client but are answered by
 * `composer` (a function of the message it was given, or a fixed list of
 * replies), not by the script, and are recorded in `composerRequests`, not in
 * `requests`. Pass `deps` to `executeTaskRun`: it carries the client, so a
 * composer call can never reach a real provider.
 *
 * @param {Array} script - One streamed response per model call.
 * @param {Object} [options]
 * @param {(req: Object) => Promise<void>|void} [options.onRequest] - Runs before each call is answered.
 * @param {Object[]} [options.models]
 * @param {(toolId: string, params: Object) => Promise<Object>} [options.runTool] - Replaces the stub
 *   (pass the real `runTool` to run the real handlers).
 * @param {((message: string, request: Object) => string|Object|Promise<string|Object>)|Array<string|Object>} [options.composer]
 *   How the composer is answered; defaults to {@link echoComposer}. An array is used in order and
 *   then fails, like an exhausted script.
 */
export function scriptedChatService(
  script,
  { onRequest, models = MODELS, runTool, composer = echoComposer } = {}
) {
  const queue = [...script];
  const requests = [];
  const composerRequests = [];
  const ran = [];
  const composerQueue = Array.isArray(composer) ? [...composer] : null;
  const { client } = makeClient({
    models,
    runLog: ledger.runLog,
    transport: async req => {
      const messages = req.body?.messages || [];
      if (String(messages[0]?.content || '').startsWith(COMPOSER_PROMPT_START)) {
        composerRequests.push(req);
        const message = messages[messages.length - 1].content;
        let reply;
        if (composerQueue) {
          reply = composerQueue.shift();
          if (reply === undefined) throw new Error('composer script exhausted');
        } else {
          reply = await composer(message, req);
        }
        // A reply is text, or `{ text, usage }` to report token usage as well.
        const { text, usage } = typeof reply === 'string' ? { text: reply } : reply;
        return sseResponse(openaiText([text], usage ? { usage } : {}));
      }
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
    runTool:
      runTool ||
      (async toolId => {
        ran.push(toolId);
        return { ok: true, toolId };
      }),
    telemetry: { recordChatCallStart: async () => ({}), recordChatCallEnd: async () => {} }
  });
  return {
    service,
    requests,
    composerRequests,
    ran,
    client,
    deps: { chatService: service, llmClient: client }
  };
}

export function taskInput(extra = {}) {
  return {
    name: 'Release watch',
    instructions: 'Report the latest releases. Run {{run_number}}.',
    appId: 'digest',
    schedule: DAILY,
    ...extra
  };
}

/** Delete every task a user has. */
export async function cleanup(user) {
  for (const task of await tasks.listTasks(user)) await tasks.deleteTask(user, task.id);
}
