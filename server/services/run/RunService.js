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
 * Callers today: an app called as a tool (`chat/appToolsGateway.js`) and an
 * app called through the MCP gateway or by an A2A agent (`mcp/appInvoker.js`).
 *
 * @module services/run/RunService
 */

import { v4 as uuidv4 } from 'uuid';
import configCache from '../../configCache.js';
import logger from '../../utils/logger.js';
import { canUserAccessResource } from '../../utils/authorization.js';
import ChatService, {
  CHAT_MAX_TOOL_ROUNDS,
  chatCompactionModel,
  chatContextPolicies,
  chatToolPolicies
} from '../chat/ChatService.js';
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

  /** @private */
  get chatService() {
    this._chatService ??= new ChatService();
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
   * @param {Readonly<Object>} spec - built by {@link appRunSpec}
   * @param {{interactions?: string, seams?: Function, failed?: Function, completed?: Function}|null} host -
   *   who receives the run (`hosts/HeadlessHost.js`); anything else is refused
   * @returns {Promise<Object>} what the host makes of the run (`HeadlessHost.completed` /
   *   `failed`); a refusal is a failed run with `error.code` from {@link RUN_REFUSAL_CODES}
   */
  async run(spec, host) {
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
    const svc = this.chatService;
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
    const result = await svc.agentLoop.run({
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
    });

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
}

/** The run service of the server. */
export const runService = new RunService();

export default runService;
