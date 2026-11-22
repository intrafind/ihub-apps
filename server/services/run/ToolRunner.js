// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The tool runner: the one way a tool call of a run, of the MCP gateway or of
 * an inbound A2A task reaches a tool.
 *
 * `execute(call, { toolId, toolDef, args, signal, toolContext })` applies the
 * checks every caller had on its own before (see docs/agent-loop.md, "Tool
 * runner"), builds the tool's parameters from the call's arguments and the
 * trusted context, and dispatches: an `app__<id>` call to the app-as-tool
 * gateway, everything else to `runTool` (`services/tools/runTool.js`), which
 * keeps the checks of the tool kinds themselves (skills, system skills,
 * workflows, integrations, scripts).
 *
 * What a call is and how it is labelled is decided by `toolDisplayOf`
 * (`utils/toolDisplay.js`) and nothing else; the runner logs every call with
 * those fields.
 *
 * The legacy workflow executors (`PromptNodeExecutor`, `ToolNodeExecutor`) are
 * frozen and still call `runTool` themselves; they are the entries of
 * `server/tests/run/runToolAllowList.json`.
 *
 * @module services/run/ToolRunner
 */

import configCache from '../../configCache.js';
import logger from '../../utils/logger.js';
import { isValidId } from '../../utils/pathSecurity.js';
import { toolDisplayOf } from '../../utils/toolDisplay.js';
import { RESERVED_TOOL_CONTEXT_KEYS } from '../../utils/toolCallContext.js';
import { APPROVAL_ERROR_CODES } from '../../../shared/toolApproval.js';
import { repairToolArguments } from '../loop/toolArgs.js';
import { runTool as defaultRunTool } from '../tools/runTool.js';

const COMPONENT = 'ToolRunner';

/** Prefix of the tool an app becomes when another app may call it. */
const APP_TOOL_PREFIX = 'app__';

/**
 * Prefix of a workflow's tool (`WORKFLOW_TOOL_ID_PREFIX` of `tools/catalog.js`,
 * which this module does not import: the catalog loads every tool source).
 */
const WORKFLOW_TOOL_ID_PREFIX = 'workflow_';

/** Codes of a call the runner refused before it reached a tool. */
export const TOOL_REFUSAL_CODES = Object.freeze({
  /** The tool id is not a safe id. */
  INVALID_TOOL_ID: 'TOOL_ID_INVALID',
  /** The caller handed no definition it resolved for this tool id. */
  NOT_RESOLVED: 'TOOL_NOT_RESOLVED',
  /** The caller did not say who decides the approval of the call. */
  APPROVAL_UNDECIDED: 'TOOL_APPROVAL_UNDECIDED',
  /** The tool needs a person's approval and nobody here can give it. */
  APPROVAL_REQUIRED_NO_USER: APPROVAL_ERROR_CODES.APPROVAL_REQUIRED_NO_USER
});

/**
 * Who decides whether a call needs a person's approval.
 *
 * - `seam`: the run's approval seam did, before the call reached the runner
 *   (chat turns and apps run as a tool; the seam is the first of the run).
 * - `refuse`: nobody can approve here; a call the approval policy gates is
 *   refused with `APPROVAL_REQUIRED_NO_USER` (the MCP gateway).
 * - `caller`: the call is the caller's own act, not a tool a model picked: a
 *   workflow an MCP client or an A2A agent starts by name, like a person
 *   starting it on the workflow page.
 */
export const APPROVAL_DECIDERS = Object.freeze(['seam', 'refuse', 'caller']);

/** A call the runner refused. `code` is one of {@link TOOL_REFUSAL_CODES}. */
export class ToolCallRefusedError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'ToolCallRefusedError';
    this.code = code;
  }
}

const RESERVED = new Set(RESERVED_TOOL_CONTEXT_KEYS);

const isWorkflowTool = toolId => String(toolId).startsWith(WORKFLOW_TOOL_ID_PREFIX);
const isAppTool = toolId => String(toolId).startsWith(APP_TOOL_PREFIX);

/**
 * The tool definition of a workflow an external caller starts by name (the
 * MCP gateway's `workflows/run`, an A2A skill): what `execute` takes as the
 * resolved definition of that call.
 *
 * @param {string} workflowId
 * @param {Object} [workflow] - The workflow's configuration, for its name
 * @returns {{id: string, name?: unknown}}
 */
export function workflowToolDef(workflowId, workflow = null) {
  return {
    id: `${WORKFLOW_TOOL_ID_PREFIX}${workflowId}`,
    ...(workflow?.name ? { name: workflow.name } : {})
  };
}

/**
 * The parameter names a tool's own schema declares.
 *
 * @param {Object|null|undefined} toolDef
 * @returns {Set<string>}
 */
function declaredParameters(toolDef) {
  const properties = toolDef?.parameters?.properties;
  return new Set(properties && typeof properties === 'object' ? Object.keys(properties) : []);
}

/**
 * The call's own arguments without the keys that carry iHub's context.
 *
 * Arguments an external caller sent (`argsFrom: 'caller'`) lose every
 * reserved key. A model's arguments keep a reserved key only where the
 * tool's own schema declares that parameter (the `runId` of the evidence
 * tools) and the tool is neither a workflow nor an app, whose runners read
 * those keys as context.
 *
 * @param {Object} args
 * @param {Object|null} toolDef
 * @param {string} toolId
 * @param {'model'|'caller'} argsFrom
 * @returns {Object}
 */
function ownArguments(args, toolDef, toolId, argsFrom) {
  const declared =
    argsFrom === 'model' && !isWorkflowTool(toolId) && !isAppTool(toolId)
      ? declaredParameters(toolDef)
      : new Set();
  const own = {};
  for (const [key, value] of Object.entries(args)) {
    if (RESERVED.has(key) && !declared.has(key)) continue;
    own[key] = value;
  }
  return own;
}

/**
 * The parameters the tool is called with: a default the arguments may
 * override, the call's own arguments, then the trusted context, which always
 * wins. The order of the keys is the order the callers used before.
 *
 * @param {Object} params
 * @param {string} params.toolId
 * @param {Object|null} params.toolDef
 * @param {Object} params.args
 * @param {Object} params.toolContext
 * @returns {Object}
 */
export function buildToolParams({ toolId, toolDef, args, toolContext }) {
  const argsFrom = toolContext.argsFrom === 'caller' ? 'caller' : 'model';
  const params = {};
  // A model may name another language for its call; an external caller may not.
  if (argsFrom === 'model' && toolContext.language !== undefined) {
    params.language = toolContext.language;
  }
  Object.assign(params, ownArguments(args, toolDef, toolId, argsFrom));
  const set = (key, value) => {
    if (value !== undefined) params[key] = value;
  };
  set('chatId', toolContext.chatId);
  // The identity the tool runs as. Today a user object; a service account an
  // admin chooses for an agent has the same shape.
  set('user', toolContext.principal);
  if (toolContext.passthrough === true) params.passthrough = true;
  set('appConfig', toolContext.appConfig);
  if (argsFrom === 'caller') set('language', toolContext.language);
  set('integrationScopes', toolContext.integrationScopes);
  set('turnSkills', toolContext.turnSkills);
  // The user's timezone, for the scheduling tools' defaults. Only when known:
  // a value the model put in `args` could only pick a default timezone.
  if (toolContext.clientTimezone) params.clientTimezone = toolContext.clientTimezone;
  if (isWorkflowTool(toolId)) {
    // The upload, for the workflow's input files.
    if (toolContext.fileData) params._fileData = toolContext.fileData;
    // A workflow links its execution back to the chat only when the chat is
    // stored (see `tools/workflowRunner.js`).
    if (typeof toolContext.chatStored === 'boolean') params._chatStored = toolContext.chatStored;
  }
  return params;
}

/**
 * The call's arguments: as the caller resolved them, else repaired from the
 * raw arguments of the model's call (glued objects, missing braces, prose
 * around the JSON).
 *
 * @param {Object|null} call
 * @param {unknown} args
 * @param {string} toolId
 * @returns {Object}
 */
function resolveArguments(call, args, toolId) {
  if (args && typeof args === 'object' && !Array.isArray(args)) return args;
  const raw = call?.function?.arguments;
  if (raw === undefined || raw === null || raw === '') return {};
  const repair = repairToolArguments(raw);
  if (repair.failed) {
    logger.warn('Failed to parse tool arguments', {
      component: COMPONENT,
      toolId,
      length: String(raw).length
    });
  }
  return repair.args && typeof repair.args === 'object' ? repair.args : {};
}

/**
 * The runner. Construct one per service; `runTool` is injectable for tests.
 */
export class ToolRunner {
  /**
   * @param {Object} [options]
   * @param {Function} [options.runTool] - `runTool(toolId, params, options)`; tests inject a stub
   * @param {Function} [options.invokeAppTool] - the app-as-tool gateway; tests inject a stub
   * @param {Function} [options.getPlatform] - the platform configuration (approval defaults)
   */
  constructor({ runTool, invokeAppTool, getPlatform } = {}) {
    this.runTool = runTool || defaultRunTool;
    this.invokeAppTool = invokeAppTool || null;
    this.getPlatform = getPlatform || (() => configCache.getPlatform?.() || null);
  }

  /**
   * Run one tool call.
   *
   * @param {Object|null} call - The model's tool call (`{ id, function: { name, arguments } }`),
   *   or null for a call an external caller made
   * @param {Object} request
   * @param {string} request.toolId - The tool to run
   * @param {Object} request.toolDef - The definition the caller resolved for `toolId` from
   *   what it offers (the loop's offered tools, the gateway's registered tools)
   * @param {Object} [request.args] - The call's arguments; repaired from `call` when left out
   * @param {AbortSignal} [request.signal] - The caller's abort signal; reaches integration
   *   tools and an app run as a tool
   * @param {Object} request.toolContext - What the caller vouches for:
   * @param {string} request.toolContext.origin - `chat`, `subagent`, `mcp`, `a2a` (logged)
   * @param {'seam'|'refuse'|'caller'} request.toolContext.approval - who decides approval,
   *   see {@link APPROVAL_DECIDERS}
   * @param {Object} [request.toolContext.principal] - the identity the tool runs as
   * @param {string} [request.toolContext.chatId]
   * @param {Object} [request.toolContext.appConfig] - the calling app
   * @param {string} [request.toolContext.language] - a default the model may override; set
   *   for an external caller, the language of the call
   * @param {'model'|'caller'} [request.toolContext.argsFrom='model'] - who wrote the arguments
   * @param {Object} [request.toolContext.integrationScopes]
   * @param {Object} [request.toolContext.turnSkills]
   * @param {string} [request.toolContext.clientTimezone]
   * @param {boolean} [request.toolContext.chatStored] - for workflow tools
   * @param {Array} [request.toolContext.fileData] - the upload, for workflow tools
   * @param {boolean} [request.toolContext.passthrough] - a passthrough call (workflow from chat)
   * @param {{admit: Function}} [request.toolContext.pageReads] - the turn's page-read gate
   * @param {Function} [request.toolContext.onMcpAppResult] - receives an MCP App's raw result
   * @param {Object} [request.toolContext.platform] - platform configuration for the approval
   *   policy (defaults to the cached one)
   * @returns {Promise<unknown>} The tool's result
   * @throws {ToolCallRefusedError} When a check refuses the call
   */
  async execute(call, { toolId, toolDef, args, signal, toolContext } = {}) {
    const context = toolContext || {};
    if (!isValidId(toolId)) {
      throw new ToolCallRefusedError(TOOL_REFUSAL_CODES.INVALID_TOOL_ID, 'Invalid tool id');
    }
    if (!toolDef || typeof toolDef !== 'object' || toolDef.id !== toolId) {
      logger.warn('Refused a tool call without a resolved definition', {
        component: COMPONENT,
        toolId,
        origin: context.origin || null
      });
      throw new ToolCallRefusedError(
        TOOL_REFUSAL_CODES.NOT_RESOLVED,
        `Tool '${toolId}' is not registered for this run.`
      );
    }
    if (!APPROVAL_DECIDERS.includes(context.approval)) {
      throw new ToolCallRefusedError(
        TOOL_REFUSAL_CODES.APPROVAL_UNDECIDED,
        `Tool '${toolId}' was called without saying who decides its approval.`
      );
    }

    // Page reads are capped per turn (`websearch.maxPageReads`): past the cap
    // the gate answers the call itself instead of fetching the page.
    const capped = context.pageReads?.admit?.(toolId);
    if (capped) return capped;

    if (context.approval === 'refuse' && (await this._needsApproval(toolDef, context))) {
      throw new ToolCallRefusedError(
        TOOL_REFUSAL_CODES.APPROVAL_REQUIRED_NO_USER,
        `Tool '${toolId}' needs a person's approval and nobody here can give it.`
      );
    }

    const params = buildToolParams({
      toolId,
      toolDef,
      args: resolveArguments(call, args, toolId),
      toolContext: context
    });

    logger.info('Tool call', {
      component: COMPONENT,
      toolId,
      origin: context.origin || null,
      userId: context.principal?.id || null,
      ...toolDisplayOf(toolDef)
    });

    if (isAppTool(toolId)) return this._invokeApp(toolId, params, signal);

    const options = {};
    if (signal) options.signal = signal;
    if (typeof context.onMcpAppResult === 'function') {
      options.onMcpAppResult = context.onMcpAppResult;
    }
    return this.runTool(toolId, params, options);
  }

  /**
   * Whether the approval policy gates this call where nobody can approve:
   * resolved like a chat without an app (platform default, tool or
   * installation, action). Loaded on demand: the policy module reaches the
   * audit log, which a caller that never refuses does not need.
   *
   * @private
   */
  async _needsApproval(toolDef, context) {
    const [{ directCallNeedsApproval }, { installedIntegrationById }] = await Promise.all([
      import('../../utils/toolApproval.js'),
      import('../integrations/installedRefs.js')
    ]);
    return directCallNeedsApproval(toolDef, context.platform ?? this.getPlatform(), {
      getInstallation: installedIntegrationById
    });
  }

  /**
   * An `app__<id>` call: the app-as-tool gateway runs the other app. Its
   * permission, feature and nesting guards live there. The caller's abort
   * signal ends the app's run too.
   *
   * @private
   */
  async _invokeApp(toolId, params, signal) {
    const invoke = this.invokeAppTool || (await import('../chat/appToolsGateway.js')).invokeAppTool;
    const { chatId, user, appConfig, language, ...args } = params;
    return invoke({
      toolId,
      args,
      user,
      chatId,
      language,
      callerAppId: appConfig?.id,
      ...(signal ? { abortSignal: signal } : {})
    });
  }
}

/** The runner of the server. */
export const toolRunner = new ToolRunner();

export default toolRunner;
