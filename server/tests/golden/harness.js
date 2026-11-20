// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The golden harness: run one input through a surface on a scripted model and
 * return a normalised record of what the server did.
 *
 * Nothing of the server is replaced by a fake. The harness brings up real
 * storage in a temporary directory and a populated config cache, and then
 * changes exactly one thing: the transport of the process-wide `LLMClient`
 * answers from the case's script instead of calling a provider. Everything
 * else (`ChatService`, `AgentLoop`, the run ledger, the tool runner, the usage
 * recorder) is the instance the product uses, so a surface can be driven
 * through its real entry point: a route, a service call, a tool call.
 *
 * A record holds what "behaves as before" means for a run:
 *
 * | Part | From |
 * |---|---|
 * | `envelopes` | every SSE v2 envelope the run sent, with the stream it went to |
 * | `offeredToolIds` | the iHub tool ids offered to each model call (run ledger) |
 * | `modelRequests`, `toolSchemas` | the asserted projection of each model request |
 * | `toolCalls` | each tool call with arguments and outcome (run ledger) |
 * | `approvals` | interactions raised and answered (run ledger) |
 * | `ledger` | every run ledger event |
 * | `usageRecords` | the usage records written |
 * | `storedMessage`, `evidence`, `httpResponse`, `result` | what the surface read back |
 *
 * The full request bodies travel in `report`, which is written beside the
 * golden for people to read and is never compared.
 *
 * See docs/run-testing.md.
 *
 * @module tests/golden/harness
 */
// First, before any module of the server: it sets CONTENTS_DIR for this process.
import { GOLDEN_CONTENTS_DIR } from './isolateContents.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import configCache from '../../configCache.js';
import ChatService from '../../services/chat/ChatService.js';
import llmClient from '../../services/loop/LLMClient.js';
import runLog from '../../services/loop/RunLog.js';
import { setEnvelopeDelivery, stampSeq } from '../../services/loop/RunStream.js';
import { routeEnvelope } from '../../sse.js';
import { evidenceWritesSettled } from '../../services/chat/ChatEvidenceRepository.js';
import { queryCalls } from '../../services/usage/callLog.js';
import { flushQueue as flushUsageEvents } from '../../services/UsageEventLog.js';
import { getContentsPath } from '../../utils/contentsPath.js';
import { enhanceUserWithPermissions } from '../../utils/authorization.js';
import { getAppVersion } from '../../utils/versionHelper.js';
import { RUN_LOG_EVENTS } from '../../../shared/runEvents.js';
import { startTestStorage } from '../helpers/testStorage.js';
import { registerFixtureTools, unregisterFixtureTools } from '../helpers/integrationToolFixture.js';
import integrationRegistry from '../../services/integrations/definitions/IntegrationRegistry.js';
import { scriptedModel } from '../helpers/scriptedModel.js';
import {
  createNormaliser,
  normaliseEnvelopes,
  normaliseLedger,
  projectModelRequest
} from './normalise.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Where the goldens are stored: `__goldens__/<surface>/<case>.json`. */
export const GOLDEN_DIR = path.join(here, '__goldens__');

const NAME = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Describe one golden case.
 *
 * @param {Object} definition
 * @param {string} definition.surface - Lower-case name of the surface (`chat`, `app-as-tool`, ...).
 * @param {string} definition.name - Lower-case name of the case, unique within the surface.
 * @param {string} definition.title - One sentence: what the case pins.
 * @param {Object|(() => Object)} definition.config - What the config cache holds, see
 *   {@link startGoldenEnv}; also `idPatterns`, `volatileKeys` and `textRules` for the normaliser.
 * @param {(env: Object) => Array} definition.script - The model's answers, one turn per model call
 *   (`helpers/scriptedModel.js`).
 * @param {(env: Object) => Promise<Object|void>} definition.run - Drives the surface. What it returns is
 *   added to the record: `result`, `httpResponse`, `storedMessage`, `evidence`.
 * @returns {Object} The case, for a list of cases (`cases.js`).
 */
export function defineCase(definition) {
  const { surface, name, title, config, script, run } = definition;
  if (!NAME.test(surface || ''))
    throw new TypeError(`golden surface "${surface}" must match ${NAME}`);
  if (!NAME.test(name || '')) throw new TypeError(`golden case "${name}" must match ${NAME}`);
  if (typeof title !== 'string' || !title)
    throw new TypeError(`golden case ${surface}/${name} needs a title`);
  if (typeof script !== 'function' || typeof run !== 'function') {
    throw new TypeError(`golden case ${surface}/${name} needs script(env) and run(env)`);
  }
  return Object.freeze({
    surface,
    name,
    title,
    config: config ?? {},
    script,
    run,
    id: `${surface}/${name}`
  });
}

/**
 * Bring up what a recording needs and capture what a run produces.
 *
 * @param {Object} [config]
 * @param {Object} [config.features] - `config/features.json`. The run ledger and usage tracking are on
 *   unless the case turns them off.
 * @param {Object} [config.platform] - `config/platform.json`.
 * @param {Object[]} [config.apps]
 * @param {Object[]} [config.models]
 * @param {Object[]} [config.workflows] - `config/workflows.json`.
 * @param {Object} [config.groups] - `config/groups.json` (`{ groups: {...} }`).
 * @param {Object} [config.users] - The `users` of `config/users.json`.
 * @param {Object} [config.credentials] - The `credentials` of `config/credentials.json`, by id and
 *   decrypted, as the config cache holds them.
 * @param {Object|(() => Object)} [config.integrations] - `config/integrations.json`; a function is called
 *   after the fixture tools are registered.
 * @param {Object[]} [config.tools] - Fixture tools (`fixtureTool` of `helpers/integrationToolFixture.js`).
 * @param {Object} [config.env] - Environment variables for the time of the recording.
 * @returns {Promise<Object>} The environment handed to a case's `script` and `run`. When the set-up
 *   fails, what was already set up is undone before the error is thrown.
 */
export async function startGoldenEnv(config = {}) {
  const restores = [];
  /** Undo everything that was set up, last first. A second call does nothing. */
  const stop = async () => {
    for (const fn of restores.splice(0).reverse()) await fn();
  };
  try {
    return await setUp(config, fn => restores.push(fn), stop);
  } catch (error) {
    // Nobody gets an environment to stop, so this is the only place that can undo what was
    // already set up. A recording that follows in the same process must not start on it.
    await stop().catch(() => {});
    throw error;
  }
}

/**
 * The set-up of {@link startGoldenEnv}. Every step registers its undo with `restore` right after
 * it took effect.
 */
async function setUp(config, restore, stop) {
  // A model without a stored key takes it from the environment. The value is never sent anywhere.
  const processEnv = { OPENAI_API_KEY: 'sk-golden', ...config.env };
  for (const [key, value] of Object.entries(processEnv)) {
    const before = process.env[key];
    process.env[key] = value;
    restore(() => {
      if (before === undefined) delete process.env[key];
      else process.env[key] = before;
    });
  }

  // What a run writes outside the storage provider (the usage event log) goes
  // to a contents directory of this process, emptied before every recording.
  if (getContentsPath() !== GOLDEN_CONTENTS_DIR) {
    throw new Error(
      'golden harness: the contents directory is not isolated. Import the golden harness before ' +
        'any module of the server, so that CONTENTS_DIR is set before server/config.js reads it.'
    );
  }
  await flushUsageEvents().catch(() => {});
  await fs.rm(path.join(GOLDEN_CONTENTS_DIR, 'data'), {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 20
  });

  const storage = await startTestStorage({ prefix: 'ihub-golden-' });
  restore(() => storage.stop());

  await integrationRegistry.ensureLoaded();
  if (config.tools?.length) {
    await registerFixtureTools(config.tools);
    restore(() => unregisterFixtureTools());
  }

  const entries = {
    'config/features.json': { runLog: true, usageTracking: true, ...config.features },
    'config/platform.json': config.platform ?? {},
    'config/apps.json': config.apps ?? [],
    'config/models.json': config.models ?? [],
    'config/groups.json': config.groups ?? { groups: {} },
    'config/users.json': { users: config.users ?? {} },
    'config/credentials.json': { credentials: config.credentials ?? {} },
    'config/workflows.json': config.workflows ?? [],
    'config/integrations.json':
      typeof config.integrations === 'function'
        ? config.integrations()
        : (config.integrations ?? { installed: [] })
  };
  for (const [key, value] of Object.entries(entries)) configCache.setCacheEntry(key, value);
  await configCache.loadAndCacheLocale('en');
  await configCache.loadAndCacheLocale('de');

  // The one replacement: the transport of the process-wide client.
  const env = { model: null };
  const previous = {
    transport: llmClient.transport,
    sleep: llmClient.sleep,
    debugDumps: llmClient.debugDumps
  };
  llmClient.transport = (request, ctx) => {
    if (!env.model)
      throw new Error('golden harness: a model call arrived before the script was set');
    return env.model.transport(request, ctx);
  };
  // A retry waits for nothing, and no request dump is written under contents/.
  llmClient.sleep = async () => {};
  llmClient.debugDumps = false;
  restore(() => Object.assign(llmClient, previous));

  /** @type {Array<{streamId: string, envelope: Object}>} */
  const envelopes = [];
  setEnvelopeDelivery((streamId, envelope) => {
    envelopes.push({ streamId, envelope: stampSeq(streamId, envelope) });
    return true;
  });
  restore(() => setEnvelopeDelivery(routeEnvelope));

  /** @type {Object[]} */
  const ledger = [];
  restore(runLog.subscribeAll(event => ledger.push(event)));
  /** @type {number[]} */
  const ledgerRestarts = [];

  Object.assign(env, {
    storage,
    configCache,
    envelopes,
    ledger,
    ledgerRestarts,
    runLog,
    llmClient,
    /** A `ChatService` as the product builds it: every collaborator is the default one. */
    chatService: new ChatService(),

    /**
     * A signed-in user with the permissions of its groups.
     *
     * @param {Object} fields - At least `id` and `groups`.
     */
    principal: fields =>
      enhanceUserWithPermissions({ authMode: 'oidc', ...fields }, {}, configCache.getPlatform()),

    /**
     * Say that the server of the case died and another one started: the ledger events from here
     * on are written by a process that did not write the ones before (`normaliseLedger`).
     */
    processRestarted() {
      ledgerRestarts.push(ledger.length);
    },

    /** Wait until everything the run wrote in the background is stored. */
    async settle() {
      await runLog.flush();
      await evidenceWritesSettled();
    },

    /** The usage records written so far, in the order they were written. */
    async usageRecords() {
      const { items } = await queryCalls({ limit: 200 });
      // The id is `<day>:<position in the day's file>`: the order of writing.
      return [...items]
        .sort((a, b) => String(a.id).localeCompare(String(b.id), 'en', { numeric: true }))
        .map(({ id: _id, ...record }) => record);
    },

    stop
  });
  return env;
}

const TOOL_EVENTS = new Set([RUN_LOG_EVENTS.TOOL_CALL, RUN_LOG_EVENTS.TOOL_RESULT]);
const INTERACTION_EVENTS = new Set([
  RUN_LOG_EVENTS.INTERACTION_RAISED,
  RUN_LOG_EVENTS.INTERACTION_ANSWERED
]);

/** The iHub tool ids offered to each model call, from the request headers of the ledger. */
function offeredToolIds(ledger) {
  const perRun = new Map();
  const offered = [];
  for (const event of ledger) {
    if (event.type !== RUN_LOG_EVENTS.REQUEST_HEADER) continue;
    // A header repeats the tool definitions only when they changed.
    if (Array.isArray(event.data?.toolSchemas)) {
      perRun.set(
        event.runId,
        event.data.toolSchemas.map(tool => tool.id ?? tool.name)
      );
    }
    offered.push(perRun.get(event.runId) ?? []);
  }
  return offered;
}

/** Each tool call with its arguments and how it ended. */
function toolCallsOf(ledger) {
  const calls = [];
  const open = new Map();
  for (const event of ledger.filter(e => TOOL_EVENTS.has(e.type))) {
    const key = `${event.runId}\u0000${event.data?.step}\u0000${event.data?.callId}`;
    if (event.type === RUN_LOG_EVENTS.TOOL_CALL) {
      const call = {
        runId: event.runId,
        toolId: event.data.toolId,
        args: event.data.args ?? null,
        execution: event.data.execution ?? null,
        outcome: null
      };
      open.set(key, call);
      calls.push(call);
    } else if (open.has(key)) {
      const { error, resultPreview } = event.data;
      open.get(key).outcome = error ? { error } : { result: resultPreview ?? null };
    }
  }
  return calls;
}

/**
 * Record one case: start an environment, run the case, and normalise what was
 * captured.
 *
 * @param {ReturnType<typeof defineCase>} goldenCase
 * @returns {Promise<Object>} The record. `report` is for people and is not compared.
 */
export async function recordCase(goldenCase) {
  const config = typeof goldenCase.config === 'function' ? goldenCase.config() : goldenCase.config;
  const env = await startGoldenEnv(config);
  let parts;
  let model;
  try {
    model = scriptedModel(goldenCase.script(env));
    env.model = model;
    parts = (await goldenCase.run(env)) ?? {};
    await env.settle();
    // A recording is only worth keeping when the script was used exactly.
    model.assertDone();

    const normaliser = createNormaliser({
      appVersion: getAppVersion(),
      idPatterns: config.idPatterns,
      volatileKeys: config.volatileKeys,
      textRules: config.textRules
    });
    const usageRecords = await env.usageRecords();

    // The order of these steps is part of the format: ids are numbered in the
    // order the normaliser meets them.
    const record = { surface: goldenCase.surface, case: goldenCase.name, title: goldenCase.title };
    record.envelopes = normaliseEnvelopes(env.envelopes, normaliser);
    record.ledger = normaliseLedger(env.ledger, normaliser, { restartsAt: env.ledgerRestarts });
    record.offeredToolIds = normaliser.normalise(offeredToolIds(env.ledger));
    const toolSchemas = {};
    record.modelRequests = model.requests.map(request => {
      const { projection, schemas } = projectModelRequest(request, normaliser);
      Object.assign(toolSchemas, schemas);
      return projection;
    });
    record.toolSchemas = toolSchemas;
    record.toolCalls = normaliser.normalise(toolCallsOf(env.ledger));
    record.approvals = normaliser.normalise(
      env.ledger
        .filter(event => INTERACTION_EVENTS.has(event.type))
        .map(event => ({ type: event.type, runId: event.runId, data: event.data }))
    );
    record.usageRecords = normaliser.normalise(usageRecords);
    for (const key of ['result', 'storedMessage', 'evidence', 'httpResponse']) {
      if (parts[key] !== undefined) record[key] = normaliser.normalise(parts[key]);
    }
    record.report = {
      note: 'For people. Not compared with the golden.',
      modelRequestBodies: model.requests.map(request =>
        normaliser.normalise(
          typeof request.body === 'string' ? JSON.parse(request.body) : request.body
        )
      )
    };
    return record;
  } finally {
    await env.stop();
  }
}
