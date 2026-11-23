// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The run service: `run(spec, host)` runs one piece of model work on the
 * agent loop.
 *
 * A caller describes the run (`RunSpec`, built by {@link appRunSpec}): what
 * runs (an app), its frozen context (`RunContext.js`: who it acts as, where it
 * came from, its budget) and its inputs. The host (`hosts/HeadlessHost.js`)
 * says who watches it and receives what the run produces. The service checks
 * the context before anything runs, assembles the run (`assemble/fromApp.js`),
 * records it in the run ledger, takes its seams from `seamProfiles.build`
 * (approval first), runs the loop and hands the result to the host.
 *
 * What the service refuses, before the model is called, with the reason in
 * `error.code` and an entry in the audit log:
 *
 * - a spec without a run context built by `createRunContext`
 *   (`RUN_CONTEXT_INVALID`), and with it any principal without resolved
 *   permissions: no context can be built for one;
 * - an app the principal may not open (`APP_NOT_PERMITTED`), the same check
 *   the chat route applies (`canUserAccessResource`).
 *
 * Every tool call of the run goes through the tool runner with the run
 * context, granted exactly the tools the run offers its model (the app's
 * tools, the ones tool search can load, the web search fallback); the runner
 * refuses and audits any other.
 *
 * Two kinds of spec:
 *
 * - `app` ({@link appRunSpec}): an app run without a client, assembled here.
 *   Callers: an app called as a tool (`chat/appToolsGateway.js`) and an app
 *   called through the MCP gateway or by an A2A agent (`mcp/appInvoker.js`).
 * - `turn` ({@link turnRunSpec}): a chat turn the caller assembled
 *   (`assemble/fromApp.js`, `assembleTurn`): a person's chat
 *   (`chat/chatTurnStart.js`), a scheduled run
 *   (`scheduler/tasks/taskExecution.js`) and an app turn of the inference API
 *   (`inference/appTurn.js`, `/v1/chat/completions` and `/v1/responses`). The
 *   chat host (`hosts/ChatHost.js`) opens the turn (ledger, stored question,
 *   stream), calls {@link RunService#run} with the turn's loop inputs, and
 *   closes it with what the run returns.
 *
 * Every run runs inside the scope of its ids (`utils/runScope.js`): the log
 * lines and model-call spans written for it carry `runId`, `parentRunId`,
 * `kind`, `principalId`, `agentId`, `chatId` and `modelId`, and the gauge
 * `ihub.runs.active` counts it by kind and model while it runs.
 *
 * @module services/run/RunService
 */

import { v4 as uuidv4 } from 'uuid';
import configCache from '../../configCache.js';
import logger from '../../utils/logger.js';
import { canUserAccessResource } from '../../utils/authorization.js';
import {
  CHAT_MAX_TOOL_ROUNDS,
  chatCompactionModel,
  chatContextPolicies,
  chatToolPolicies
} from '../chat/chatTurnPolicies.js';
import { registerRunObservers } from '../../telemetry/metrics.js';
import { withRunScope } from '../../utils/runScope.js';
import { markInteractiveTools } from '../loop/seams/index.js';
import { newRunId, isValidRunId } from '../loop/RunLog.js';
import { createPageReadGate, resolveMaxPageReads } from '../chat/pageReadLimit.js';
import { createTurnSkillLog } from '../chat/turnSkillLog.js';
import { recordTextOutput } from '../provenance/turnProvenance.js';
import { isRunContext, withToolGrant } from './RunContext.js';
import { build as buildSeams } from './seamProfiles.js';
import { assembleFromApp } from './assemble/fromApp.js';
import { auditRefusal } from './runAudit.js';

const COMPONENT = 'RunService';

/** Hard timeout of each model call of a run, unless its budget says otherwise. */
export const DEFAULT_MODEL_TIMEOUT_MS = 120_000;

/** Deadline of a whole run without a client, unless its budget says otherwise. */
export const DEFAULT_WALL_CLOCK_MS = 180_000;

/** Codes of a run the service refused before it started. */
export const RUN_REFUSAL_CODES = Object.freeze({
  /** The spec is not one the service runs. */
  SPEC_INVALID: 'RUN_SPEC_INVALID',
  /** The spec carries no run context built by `createRunContext`. */
  CONTEXT_INVALID: 'RUN_CONTEXT_INVALID',
  /** The host is not one the service runs on. */
  HOST_INVALID: 'RUN_HOST_INVALID',
  /** The principal may not open the app. */
  APP_NOT_PERMITTED: 'APP_NOT_PERMITTED'
});

let bypassLogged = false;

/**
 * Whether chat turns, scheduled runs and the app turns of the inference API
 * run on the run service: the internal kill switch
 * `platform.runs.chatOnRunService` (default on; a platform change needs a
 * server restart). Off, a turn runs on the agent loop directly, as before it
 * moved onto the run service, and its callers keep the request's principal as
 * it is. Not in Admin → Features; removed one release after it shipped.
 *
 * @param {Object|null} [platform] - platform configuration (default: the cached one)
 * @returns {boolean}
 */
export function chatOnRunService(platform = configCache.getPlatform?.()) {
  const on = platform?.runs?.chatOnRunService !== false;
  if (!on && !bypassLogged) {
    bypassLogged = true;
    logger.warn(
      'Chat turns, scheduled runs and app turns of the inference API bypass the run service (platform.runs.chatOnRunService is false)',
      { component: COMPONENT }
    );
  }
  return on;
}

/** Who can answer the interactions of a turn's run (`seamProfiles.js`). */
const TURN_INTERACTIONS = Object.freeze(['none', 'person', 'owner']);

/** Runs in progress in this process, by kind and model: the gauge `ihub.runs.active`. */
const activeRuns = new Map();

/**
 * Count a run as active until the returned function is called (once).
 *
 * @param {string} kind
 * @param {string|null|undefined} model
 * @returns {() => void}
 */
export function trackActiveRun(kind, model) {
  const key = `${kind}\u0000${model || ''}`;
  const entry = activeRuns.get(key) || { kind, model: model || 'unknown', count: 0 };
  entry.count += 1;
  activeRuns.set(key, entry);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    entry.count -= 1;
    if (entry.count <= 0) activeRuns.delete(key);
  };
}

/**
 * The runs in progress in this process: one entry per kind and model.
 *
 * @returns {Array<{kind: string, model: string, count: number}>}
 */
export function activeRunCounts() {
  return [...activeRuns.values()].map(entry => ({ ...entry }));
}

registerRunObservers({ getActiveRuns: activeRunCounts });

/**
 * The ids a run's log lines and spans carry (`utils/runScope.js`).
 *
 * @param {Object} params
 * @returns {Object}
 */
function runScopeOf({ runId, kind, context, chatId, model }) {
  return {
    runId,
    parentRunId: context?.parentRunId,
    kind,
    principalId: context?.principal?.id,
    agentId: context?.agentId,
    chatId,
    modelId: model?.id
  };
}

/**
 * The spec of a chat turn: the run context and the request the caller
 * assembled (`assemble/fromApp.js`, `assembleTurn`). The chat host adds the
 * turn's own inputs (its run id, the messages after a continuation, its
 * budgets and abort signal) with {@link turnLoopSpec} when the turn reaches
 * its model.
 *
 * @param {Object} params
 * @param {Readonly<Object>} params.context - the run context (`createRunContext`)
 * @param {Object} params.prep - the assembled request (`prepareChatRequest().data`)
 * @param {'chat'|'schedule'|'inference'} [params.caller='chat'] - who asked, for the audit log
 * @returns {Readonly<Object>} the spec
 */
export function turnRunSpec({ context, prep, caller = 'chat' }) {
  return Object.freeze({
    kind: 'turn',
    context,
    prep,
    appId: prep?.app?.id ?? null,
    caller
  });
}

/**
 * A turn spec with the inputs of the turn's loop.
 *
 * @param {Readonly<Object>} spec - built by {@link turnRunSpec}
 * @param {Object} turn
 * @param {string} turn.runId - the turn's run id (minted, or the paused run it continues)
 * @param {string} turn.chatId
 * @param {string} turn.language
 * @param {Array<Object>} turn.messages - what the loop starts from
 * @param {Array<Object>} turn.tools - the tools offered to the model (`markInteractiveTools`)
 * @param {Object|null} [turn.resume] - the call(s) the loop runs first (approval, connect)
 * @param {string[]} [turn.archiveRunIds]
 * @param {Object} turn.budgets - `policies.budgets`
 * @param {AbortSignal} turn.signal
 * @param {number} [turn.timeoutMs]
 * @param {Object} turn.refs - correlation ids of the ledger and telemetry
 * @returns {Readonly<Object>}
 */
export function turnLoopSpec(spec, turn) {
  return Object.freeze({ ...spec, runId: turn.runId, turn: Object.freeze({ ...turn }) });
}

/**
 * The spec of an app's run.
 *
 * @param {Object} params
 * @param {Readonly<Object>} params.context - the run context (`createRunContext`)
 * @param {string} params.appId
 * @param {Array<Object>} params.messages - the conversation; the last entry is the user's message
 * @param {Object} [params.variables] - app variables for the prompt template
 * @param {string} [params.modelId] - a model override
 * @param {string} [params.language='en']
 * @param {string} [params.chatId] - the chat the run belongs to; minted when left out
 * @param {AbortSignal} [params.signal]
 * @param {Object<string, string>} [params.integrationScopes] - the caller's scopes (#3050)
 * @param {string} [params.clientTimezone] - the person's timezone, for the scheduling tools
 * @param {'subagent'|'mcp'|'a2a'} [params.caller='subagent'] - who asked, for logs and the audit log
 * @returns {Readonly<Object>} the spec
 */
export function appRunSpec({
  context,
  appId,
  messages = [],
  variables = {},
  modelId,
  language = 'en',
  chatId,
  signal,
  integrationScopes,
  clientTimezone,
  caller = 'subagent'
}) {
  return Object.freeze({
    kind: 'app',
    context,
    appId,
    messages: Array.isArray(messages) ? messages : [],
    variables: variables && typeof variables === 'object' ? variables : {},
    modelId,
    language,
    chatId: typeof chatId === 'string' && chatId ? chatId : null,
    signal,
    integrationScopes,
    clientTimezone,
    caller
  });
}

/**
 * The tool ids a run may call: what it offers its model, the tools tool search
 * can load into it, and the search tool the loop falls back to when the
 * provider turns native web search down.
 *
 * @private
 */
async function grantedToolIds({ tools, toolSearch, llmOptions, agentLoop, language, principal }) {
  const ids = new Set(tools.map(tool => tool?.id).filter(Boolean));
  for (const tool of toolSearch?.deferred || []) if (tool?.id) ids.add(tool.id);
  const directive = llmOptions?.nativeWebSearch;
  if (directive && typeof agentLoop?.resolveNativeWebSearchFallbackTools === 'function') {
    try {
      const fallback = await agentLoop.resolveNativeWebSearchFallbackTools(directive, {
        app: llmOptions.appConfig,
        language,
        user: principal
      });
      for (const tool of fallback || []) if (tool?.id) ids.add(tool.id);
    } catch (error) {
      logger.warn('Could not resolve the web search fallback for the tool grant', {
        component: COMPONENT,
        error: error.message
      });
    }
  }
  return [...ids];
}

/** The run service. One per process; collaborators are injectable for tests. */
export class RunService {
  /**
   * @param {Object} [options]
   * @param {Object} [options.chatService] - prepares requests and keeps the run ledger
   *   (default: a `ChatService` of its own)
   */
  constructor({ chatService } = {}) {
    this._chatService = chatService || null;
  }

  /**
   * The chat service the runs prepare their requests with and keep their
   * ledger in: the one given, else one of its own. Loaded on demand: the chat
   * service's module loads the chat host, which loads this module, and this
   * module loads neither.
   *
   * @returns {Promise<import('../chat/ChatService.js').default>}
   */
  async chatServiceOf() {
    if (!this._chatService) {
      const { default: ChatService } = await import('../chat/ChatService.js');
      this._chatService ??= new ChatService();
    }
    return this._chatService;
  }

  /**
   * A refusal: logged, audited and handed to the host as a failed run.
   *
   * @private
   */
  _refuse({ host, runId, spec, code, message }) {
    const principal = isRunContext(spec?.context) ? spec.context.principal : null;
    logger.warn('Run refused', {
      component: COMPONENT,
      code,
      appId: spec?.appId || null,
      userId: principal?.id || null,
      caller: spec?.caller || null
    });
    auditRefusal({
      principal,
      resource: 'app',
      resourceId: spec?.appId,
      code,
      origin: spec?.caller,
      runId,
      parentRunId: isRunContext(spec?.context) ? spec.context.parentRunId : null,
      summary: `Refused to run app ${spec?.appId || '(none)'}: ${message}`
    });
    const error = { code, message };
    return typeof host?.failed === 'function'
      ? host.failed({ runId, error })
      : { status: 'error', runId, error, finalMessage: null, toolCalls: [] };
  }

  /**
   * Run one piece of model work.
   *
   * @param {Readonly<Object>} spec - built by {@link appRunSpec}, or a chat turn's
   *   ({@link turnLoopSpec})
   * @param {{interactions?: string, seams?: Function, failed?: Function, completed?: Function}|null} host -
   *   who receives the run (`hosts/HeadlessHost.js`, the chat host's turn); anything else is
   *   refused
   * @returns {Promise<Object>} what the host makes of the run (`HeadlessHost.completed` /
   *   `failed`); a refusal is a failed run with `error.code` from {@link RUN_REFUSAL_CODES}
   */
  async run(spec, host) {
    if (spec?.kind === 'turn') return this._runTurn(spec, host);
    const runId = newRunId('subagent');
    if (!host || host.interactions !== 'none' || typeof host.seams !== 'function') {
      return this._refuse({
        host: null,
        runId,
        spec,
        code: RUN_REFUSAL_CODES.HOST_INVALID,
        message: 'The run has no host it can run on'
      });
    }
    if (spec?.kind !== 'app' || typeof spec.appId !== 'string' || !spec.appId) {
      return this._refuse({
        host,
        runId,
        spec,
        code: RUN_REFUSAL_CODES.SPEC_INVALID,
        message: 'The run names no app'
      });
    }
    if (!isRunContext(spec.context)) {
      return this._refuse({
        host,
        runId,
        spec,
        code: RUN_REFUSAL_CODES.CONTEXT_INVALID,
        message: 'The run has no context with a resolved principal'
      });
    }
    if (!canUserAccessResource(spec.context.principal, 'apps', spec.appId)) {
      return this._refuse({
        host,
        runId,
        spec,
        code: RUN_REFUSAL_CODES.APP_NOT_PERMITTED,
        message: `You do not have permission to access app ${spec.appId}`
      });
    }
    try {
      return await this._runApp(spec, host, runId);
    } catch (error) {
      logger.error('Run failed', {
        component: COMPONENT,
        appId: spec.appId,
        runId,
        parentRunId: spec.context.parentRunId,
        error: error.message
      });
      return host.failed({ runId, error: { message: error.message } });
    }
  }

  /** @private */
  async _runApp(spec, host, runId) {
    const svc = await this.chatServiceOf();
    const { context, language } = spec;
    const principal = context.principal;
    const parentRunId = context.parentRunId;
    const chatId = spec.chatId || `agent:${parentRunId || 'no-run'}:${uuidv4().slice(0, 8)}`;
    const startedAt = Date.now();
    const buildLogData = (streaming, extra = {}) => ({
      appId: spec.appId,
      user: principal,
      userSessionId: chatId,
      sessionId: chatId,
      ...extra
    });

    const assembled = await assembleFromApp({
      chatService: svc,
      appId: spec.appId,
      messages: spec.messages,
      variables: spec.variables,
      modelId: spec.modelId,
      language,
      principal,
      chatId,
      integrationScopes: spec.integrationScopes,
      signal: spec.signal
    });
    if (!assembled.ok) return host.failed({ runId, error: assembled.error });
    const {
      app,
      model,
      llmMessages,
      tools = [],
      toolSearch = null,
      maxTokens,
      responseFormat,
      responseSchema,
      llmOptions = {},
      userFileData
    } = assembled.data;
    const integrationScopes = assembled.integrationScopes;

    // The run may call what it offers its model, and nothing else.
    const run = withToolGrant(
      context,
      await grantedToolIds({
        tools,
        toolSearch,
        llmOptions,
        agentLoop: svc.agentLoop,
        language,
        principal
      }),
      { runId }
    );

    await svc._startLedgerRun({
      runId,
      kind: 'subagent',
      user: principal,
      refs: { chatId, appId: app.id, ...(parentRunId ? { executionId: parentRunId } : {}) },
      model,
      language,
      parentRunId: parentRunId && isValidRunId(parentRunId) ? parentRunId : undefined
    });

    const seams = buildSeams({
      interactions: host.interactions,
      host,
      bindings: {
        chatId,
        app,
        principal,
        run,
        platform: configCache.getPlatform?.() || null,
        userFileData,
        integrationScopes,
        buildLogData,
        logInteraction: svc.logInteraction,
        toolRunner: svc.toolRunner
      }
    });
    const pageReads = createPageReadGate(resolveMaxPageReads(app));
    const turnSkills = createTurnSkillLog();
    const budget = context.budget || {};
    const release = trackActiveRun('subagent', model?.id);
    const result = await withRunScope(
      runScopeOf({ runId, kind: 'subagent', context, chatId, model }),
      () =>
        svc.agentLoop.run({
          runId,
          kind: 'subagent',
          model,
          messages: llmMessages,
          tools: markInteractiveTools(tools),
          toolSearch,
          toolExecution: 'server',
          policies: {
            budgets: {
              maxToolRounds: budget.maxToolRounds || CHAT_MAX_TOOL_ROUNDS,
              maxWallClockMs: budget.maxWallClockMs || DEFAULT_WALL_CLOCK_MS
            },
            // One call at a time unless the feature allows reads side by side and
            // the model does not opt out (`parallelToolCalls: false`).
            tools: chatToolPolicies({ app, model }),
            context: chatContextPolicies(model)
          },
          summaryModel: chatCompactionModel({ model, user: principal }),
          options: { maxTokens, responseFormat, responseSchema, ...llmOptions },
          language,
          signal: spec.signal,
          timeoutMs: budget.timeoutMs || DEFAULT_MODEL_TIMEOUT_MS,
          refs: { chatId, appId: app.id, userId: principal?.id, executionId: parentRunId },
          // Seams read the run's context here; it is frozen.
          meta: { run },
          seams,
          executeTool: (call, { toolId, toolDef, args, signal }) =>
            svc.toolRunner.execute(call, {
              toolId,
              toolDef,
              args,
              signal,
              toolContext: {
                origin: 'subagent',
                // The approval seam above refuses a gated call: nobody can approve here.
                approval: 'seam',
                run,
                principal,
                chatId,
                appConfig: app,
                language,
                integrationScopes,
                turnSkills,
                ...(spec.clientTimezone ? { clientTimezone: spec.clientTimezone } : {}),
                pageReads
              }
            })
        })
    ).finally(release);

    if (result.status === 'error' || result.status === 'aborted') {
      svc._endLedgerRun(runId, {
        status: result.status,
        finishReason: result.finishReason,
        usage: result.usage,
        error: result.error,
        startedAt
      });
      return host.failed({
        runId,
        error: {
          message: result.error?.message || `App invocation ${result.status}`,
          code: result.error?.code
        }
      });
    }
    // One place for MCP, A2A and the app-as-tool gateway: the provenance of
    // the answer this run returns (null for an answer without text).
    const provenance = await recordTextOutput({
      text: result.content || '',
      finalText: result.answerText,
      model: { id: model.id },
      modelConfig: model,
      marking: result.marking?.text,
      user: principal
    });
    svc._endLedgerRun(runId, {
      status: result.status,
      finishReason: result.finishReason,
      usage: result.usage,
      provenance,
      startedAt
    });
    return host.completed({ runId, result, model, provenance });
  }

  /**
   * Run the model part of a chat turn (`hosts/ChatHost.js`): check the spec,
   * grant the run the tools it offers its model, build its seams from the
   * profile of who can answer (approval first, the host's after), run the loop
   * and hand the result to the host.
   *
   * A refusal (no context the run service built, a host it does not run on)
   * is audited and handed to the host as a failed run: the turn is told like
   * any other failed turn.
   *
   * @private
   * @param {Readonly<Object>} spec - {@link turnLoopSpec}
   * @param {Object} host - the turn: `interactions`, `principal`, `buildLogData`,
   *   `interactionBindings`, `structuredOutput`, `projectionSeams`, `seams`, `meta`,
   *   `channel`, `toolContext(info)`, `completed`, `failed`
   * @returns {Promise<Object>}
   */
  async _runTurn(spec, host) {
    const runId = spec.runId;
    const refuse = (code, message) => this._refuse({ host, runId, spec, code, message });
    if (
      !host ||
      !TURN_INTERACTIONS.includes(host.interactions) ||
      typeof host.completed !== 'function' ||
      typeof host.failed !== 'function'
    ) {
      return refuse(RUN_REFUSAL_CODES.HOST_INVALID, 'The run has no host it can run on');
    }
    if (!spec.prep?.app || !spec.prep?.model || !spec.turn || !isValidRunId(runId)) {
      return refuse(RUN_REFUSAL_CODES.SPEC_INVALID, 'The turn names no app, model or run');
    }
    if (!isRunContext(spec.context)) {
      return refuse(
        RUN_REFUSAL_CODES.CONTEXT_INVALID,
        'The run has no context with a resolved principal'
      );
    }
    // The app was checked by the caller, with the same rule (the chat route's
    // `chatAuthRequired`, `authorizeRun` of a scheduled run, the inference API's
    // target resolution), before the question was stored.
    const svc = await this.chatServiceOf();
    const { context, prep, turn } = spec;
    const { app, model, toolSearch = null, llmOptions = {}, userFileData } = prep;
    const integrationScopes = prep.integrationScopes || {};
    // The identity the tools run as: the run's principal (the request's own
    // object for a person's chat; the tool runner holds it to the context's).
    const principal = host.principal ?? context.principal;

    // The run may call what it offers its model, and nothing else.
    const run = withToolGrant(
      context,
      await grantedToolIds({
        tools: turn.tools,
        toolSearch,
        llmOptions,
        agentLoop: svc.agentLoop,
        language: turn.language,
        principal
      }),
      { runId }
    );
    const seams = buildSeams({
      interactions: host.interactions,
      structuredOutput: host.structuredOutput || null,
      host,
      bindings: {
        chatId: turn.chatId,
        app,
        principal,
        run,
        platform: configCache.getPlatform?.() || null,
        userFileData,
        integrationScopes,
        buildLogData: host.buildLogData,
        logInteraction: svc.logInteraction,
        toolRunner: svc.toolRunner,
        // Who asked (`chat`, `schedule`, `inference`): the runner logs it and
        // audits a refused passthrough call under it.
        origin: spec.caller || 'chat',
        ...host.interactionBindings
      }
    });
    const release = trackActiveRun('chat', model.id);
    try {
      const result = await withRunScope(
        runScopeOf({ runId, kind: 'chat', context, chatId: turn.chatId, model }),
        () =>
          svc.agentLoop.run({
            runId,
            kind: 'chat',
            model,
            messages: turn.messages,
            ...(turn.resume ? { resume: turn.resume } : {}),
            tools: turn.tools,
            toolSearch,
            toolExecution: 'server',
            policies: {
              budgets: turn.budgets,
              // Chat tools have side effects: one call at a time, except the
              // trusted reads of a step when the feature is on.
              tools: chatToolPolicies({ app, model }),
              context: chatContextPolicies(model)
            },
            summaryModel: chatCompactionModel({ model, user: principal }),
            ...(turn.archiveRunIds?.length ? { archiveRunIds: turn.archiveRunIds } : {}),
            options: {
              maxTokens: prep.maxTokens,
              responseFormat: prep.responseFormat,
              responseSchema: prep.responseSchema,
              ...llmOptions
            },
            language: turn.language,
            signal: turn.signal,
            timeoutMs: turn.timeoutMs,
            refs: turn.refs,
            // Seams read the run's context here; it is frozen.
            meta: { ...host.meta, run },
            seams,
            channel: host.channel ?? null,
            executeTool: (call, { toolId, toolDef, args, info, signal }) =>
              svc.toolRunner.execute(call, {
                toolId,
                toolDef,
                args,
                signal,
                toolContext: { ...host.toolContext(info), origin: spec.caller || 'chat', run }
              })
          })
      );
      return host.completed({ runId, result, run });
    } finally {
      release();
    }
  }
}

/** The run service of the server. */
export const runService = new RunService();

export default runService;
