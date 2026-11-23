// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What the cases of the seven surfaces run on: one model, a handful of apps,
 * one group and a few fixture tools. A surface takes `surfaceConfig()` and
 * changes what its cases are about.
 *
 * Everything here is made anew for every recording (`config` of a case is a
 * function), so a tool that counts its calls starts at zero each time.
 *
 * @module tests/golden/surfaces/fixtures
 */
import { fixtureInstallation, fixtureTool } from '../../helpers/integrationToolFixture.js';
import integrationRegistry from '../../../services/integrations/definitions/IntegrationRegistry.js';
import { getChatRepository } from '../../../services/chat/ChatRepository.js';
import { getChatEvidenceRepository } from '../../../services/chat/ChatEvidenceRepository.js';

/** The model every case runs on. Tools are offered as the model declares. */
export const MODEL = Object.freeze({
  id: 'golden-model',
  provider: 'openai',
  modelId: 'gpt-golden',
  url: 'https://model.invalid/v1/chat/completions',
  autoDiscovery: false,
  supportsTools: 'auto',
  default: true
});

/** Token usage as an OpenAI provider reports it. */
export const usage = (prompt, completion) => ({
  prompt_tokens: prompt,
  completion_tokens: completion,
  total_tokens: prompt + completion
});

/** An app with the fields every app needs. */
export const app = (id, extra = {}) => ({
  id,
  name: { en: id },
  description: { en: `The ${id} app` },
  system: { en: `You are the ${id}.` },
  preferredModel: MODEL.id,
  enabled: true,
  ...extra
});

/** A long, repetitive text of a fixed length: what a tool with a large result returns. */
export const longText = (label, paragraphs) =>
  Array.from(
    { length: paragraphs },
    (_, index) =>
      `${label}, paragraph ${index + 1}: the archive lists the record, its owner, the day it was ` +
      'opened and every change made to it since, in the order the changes were made.'
  ).join('\n');

/**
 * The fixture tools.
 *
 * - `lookup`: reads a record.
 * - `archive`: reads a long text (what a compaction condenses).
 * - `dangerous`: needs a person's approval; counts how often it ran.
 * - `tracker`: needs a connection the user has not made on the first call.
 *
 * @returns {{tools: Object[], state: {dangerousRan: number, trackerCalls: number}}}
 */
export function fixtureTools() {
  const state = { dangerousRan: 0, trackerCalls: 0 };
  const tools = [
    fixtureTool('lookup', {
      description: 'Look up a record',
      parameters: {
        type: 'object',
        properties: { key: { type: 'string', description: 'The key of the record' } },
        required: ['key']
      },
      run: args => ({ key: args.key, value: `record ${args.key}` })
    }),
    fixtureTool('archive', {
      description: 'Read a volume of the archive',
      parameters: {
        type: 'object',
        properties: { volume: { type: 'string', description: 'The volume to read' } },
        required: ['volume']
      },
      run: args => ({ volume: args.volume, text: longText(`Volume ${args.volume}`, 150) })
    }),
    fixtureTool('dangerous', {
      description: 'Close a record for good',
      requiresApproval: true,
      sideEffect: 'write',
      parameters: {
        type: 'object',
        properties: { key: { type: 'string', description: 'The key of the record' } },
        required: ['key']
      },
      run: args => {
        state.dangerousRan++;
        return { closed: args.key, times: state.dangerousRan };
      }
    }),
    fixtureTool('tracker', {
      description: 'Search the issue tracker',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'What to search for' } },
        required: ['query']
      },
      run: args => {
        state.trackerCalls++;
        if (state.trackerCalls === 1) {
          return {
            error: 'INTEGRATION_AUTH_REQUIRED',
            integration: 'tracker',
            reason: 'not_connected',
            message: 'Connect the tracker to use this tool.',
            connectUrl: '/api/integrations/tracker/_connect'
          };
        }
        return { query: args.query, issues: [{ key: 'TRK-7', title: 'Printer on fire' }] };
      }
    })
  ];
  return { tools, state };
}

const TOOL_IDS = ['lookup', 'archive', 'dangerous', 'tracker'];

/**
 * Ids the server mints in the surfaces, beside the ones the normaliser knows. They run after the
 * default patterns, so a UUID inside them is already `<id:N>`.
 */
export const SURFACE_ID_PATTERNS = Object.freeze([
  // A question to the user: `clarify-<chat>-<number>-<epoch ms>`.
  /\bclarify-<id:\d+>-\d+-(\d{10,})\b/g,
  // A stored call that waits for a connection, and the key segment of an evidence record.
  /\b([0-9a-f]{32})\b/g,
  // A compaction.
  /\bcmp-([0-9a-f]{8})\b/g
]);

/** Keys whose value names the process: the worker in the cause of an abort is `<host>:<pid>`. */
export const SURFACE_VOLATILE_KEYS = Object.freeze(['worker']);

/** The installations of the fixture tools, and the real `ihub` integration (`ask_user`). */
export const fixtureIntegrations = () => ({
  installed: [
    ...TOOL_IDS.filter(id => id !== 'tracker').map(id => fixtureInstallation(id)),
    // A shared credential: "is the user connected?" is answered with yes, which is what the
    // route asks before it runs a stored call again. The tool itself refuses its first call.
    fixtureInstallation('tracker', {
      auth: { mode: 'service-account', credentialRef: 'golden-tracker' }
    }),
    fixtureInstallation('ihub', {
      definition: 'com.intrafind/ihub',
      definitionVersion: integrationRegistry.get('com.intrafind/ihub').definition.version
    })
  ],
  security: { blockPrivateIps: true, allowedHosts: [] }
});

/** The group of the signed-in user of the cases. */
export const usersGroup = (apps, extra = {}) => ({
  id: 'users',
  permissions: {
    apps,
    models: ['*'],
    prompts: [],
    integrations: [...TOOL_IDS, 'ihub'],
    ...extra
  }
});

/**
 * The config of a surface: the model, the fixture tools, and what the surface names.
 *
 * @param {Object} options
 * @param {Object[]} options.apps
 * @param {Object} [options.features]
 * @param {Object} [options.platform]
 * @param {Object} [options.groups] - Group id to group; default: `users` with every app of `apps`.
 * @param {Object[]} [options.models]
 * @param {Object} [options.extra] - Further keys of a case's config (`idPatterns`, `volatileKeys`, `env`).
 * @returns {Object} The config of a case, with `toolState` for the case to read.
 */
export function surfaceConfig({
  apps,
  features = {},
  platform = {},
  groups,
  models = [MODEL],
  extra = {}
}) {
  const { tools, state } = fixtureTools();
  return {
    features: { chatPersistence: true, ...features },
    platform: {
      chats: { enabled: true },
      auth: {},
      // No date in the system prompt: the evidence of an answer holds a hash of every message
      // sent to the model, and with the date in it that hash would differ every day. The date
      // rule of the normaliser has its own cases (`harnessCases.js`).
      globalPromptVariables: { context: '' },
      // The notice a person confirms before the first message is a feature of its own.
      aiAcknowledgement: { enabled: false },
      ...platform
    },
    apps,
    models,
    groups: { groups: groups ?? { users: usersGroup(apps.map(a => a.id)) } },
    tools,
    integrations: fixtureIntegrations,
    toolState: state,
    ...extra,
    idPatterns: [...SURFACE_ID_PATTERNS, ...(extra.idPatterns ?? [])],
    volatileKeys: [...SURFACE_VOLATILE_KEYS, ...(extra.volatileKeys ?? [])]
  };
}

const CONTENT_HASH = /^(?:sha256:)?[0-9a-f]{64}$/;

/**
 * An evidence record without its content hashes: which calls were made, with which roles and how
 * many tools, but not a hash over what was sent.
 *
 * For a surface whose prompt holds the time of the run (a scheduled task), every hash over a
 * message differs from run to run. What was sent is pinned by `modelRequests`.
 *
 * @param {any} value
 * @returns {any}
 */
export function withoutContentHashes(value) {
  if (typeof value === 'string') return CONTENT_HASH.test(value) ? '<sha256>' : value;
  if (Array.isArray(value)) return value.map(withoutContentHashes);
  if (value && typeof value === 'object') {
    const out = {};
    let hashed = 0;
    for (const [key, item] of Object.entries(value)) {
      if (CONTENT_HASH.test(key)) hashed++;
      else out[key] = withoutContentHashes(item);
    }
    if (hashed > 0) out['<sha256>'] = hashed;
    return out;
  }
  return value;
}

/**
 * Evidence records without the hash over the options of each model call.
 *
 * The options hold the id of the chat the call belongs to. Where the server mints that id (a turn
 * of the inference API), the hash differs from run to run; the hashes over the messages do not and
 * stay.
 *
 * @param {Array<{record: Object|null}>} evidence
 * @returns {Array}
 */
export function withoutConfigHashes(evidence) {
  return evidence.map(entry => {
    const record = entry.record;
    if (!record || !Array.isArray(record.calls)) return entry;
    const hashes = new Set(
      record.calls.map(call => String(call.config ?? '').replace('sha256:', ''))
    );
    const content = { ...record.content };
    let configs = 0;
    for (const hash of hashes) {
      if (hash in content) {
        delete content[hash];
        configs++;
      }
    }
    return {
      ...entry,
      record: {
        ...record,
        calls: record.calls.map(call => (call.config ? { ...call, config: '<sha256>' } : call)),
        ...(record.content ? { content: { ...content, '<config>': configs } } : {})
      }
    };
  });
}

/**
 * `wanted`, unless `over` settles first: then the wait fails and says so, where it would
 * otherwise never end.
 *
 * A case waits for something its run is expected to do (a model call arrives, a question is
 * raised). When the run takes another path and ends, nothing would wake that wait: the case
 * would hang its job in the place of failing. If `over` rejects, the wait fails with that
 * failure, which is the reason the run took the other path.
 *
 * @template T
 * @param {Promise<T>} wanted - What the case waits for.
 * @param {Promise<any>} over - The end of the run that should have done it.
 * @param {string} what - What had not happened when the run ended.
 * @returns {Promise<T>}
 */
export function unlessOver(wanted, over, what) {
  return Promise.race([
    wanted,
    Promise.resolve(over).then(value => {
      let ending = '';
      try {
        ending = `: ${JSON.stringify(value)?.slice(0, 400)}`;
      } catch {
        // Not something JSON can hold: the message says what was awaited, which is enough.
      }
      throw new Error(`${what}${ending}`);
    })
  ]);
}

/** The signed-in user of the cases. */
export const goldenUser = (env, fields = {}) =>
  env.principal({ id: 'golden-user', name: 'Golden User', groups: ['users'], ...fields });

/**
 * What a chat holds after its turns: the chat document, its messages, and the
 * evidence record of every answer.
 *
 * @param {string} chatId
 * @returns {Promise<{storedMessage: Object, evidence: Object[]}>}
 */
export async function readStoredChat(chatId) {
  const repository = getChatRepository();
  const chat = await repository.getChat(chatId);
  const { messages } = await repository.getMessages(chatId);
  const evidenceRepository = getChatEvidenceRepository();
  const evidence = [];
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    // The data of the record; its storage key and etag say nothing about the run.
    const stored = await evidenceRepository.getRecord('chat', chatId, message.id);
    evidence.push({ messageId: message.id, record: stored?.data ?? null });
  }
  return { storedMessage: { chat, messages }, evidence };
}
