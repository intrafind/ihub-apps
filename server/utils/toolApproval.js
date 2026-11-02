// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Tool approval resolver (intrafind/ihub-apps#2945).
 *
 * Every tool an app offers is stamped once, in `getToolsForApp`, with the
 * policy the approval seam reads:
 *
 * - `approval`         `never | writes | always`
 * - `sideEffect`       `read | write | destructive | unknown`
 * - `sideEffectSource` where the side effect came from (`admin`, `tool`,
 *                      `definition`, `annotation`, `default`)
 * - `dataFlow`         `internal | external`
 * - `approvalSource`   which layer set the effective mode (for audit and the admin UI)
 *
 * ## Precedence
 *
 * The layers below are read in this order. **The strictest mode wins**, so a
 * later layer can only tighten what an earlier one set:
 *
 * | # | Layer                     | Where                                                        |
 * |---|---------------------------|--------------------------------------------------------------|
 * | 1 | Platform default          | `platform.json` → `toolApproval.defaults[dataFlow]`, else `.default` |
 * | 2 | Tool config               | tool file `approval` (per function, else the tool's), `requiresApproval: true` = `always` |
 * | 2 | Installation default      | `integrations.json` → `installed[].approval.default`         |
 * | 3 | Installation action       | `installed[].approval.actions[<action name>]`                |
 * | 4 | App override              | app `toolApproval.tools[<tool id or installation id>]`, else `toolApproval.default` |
 *
 * Nothing configured resolves to `never`: approval is opt-in.
 *
 * An app value looser than the admin floor is ignored and logged once.
 * Annotations a remote MCP server puts on its tools feed `sideEffect` only;
 * they never relax a gate (a claimed `read` still counts as a write under
 * `writes`, see `shared/toolApproval.js#needsApproval`).
 *
 * Actions are keyed by their **original name** (`_integration.action`, the
 * MCP tool's own name), never by the prefixed tool id, so a changed tool
 * prefix does not drop the setting.
 *
 * @module utils/toolApproval
 */
import logger from './logger.js';
import {
  APPROVAL_MODES,
  DATA_FLOWS,
  SIDE_EFFECTS,
  isApprovalMode,
  modeRank,
  needsApproval
} from '../../shared/toolApproval.js';

export { APPROVAL_MODES, SIDE_EFFECTS, DATA_FLOWS, needsApproval };

const COMPONENT = 'ToolApproval';

/** App overrides that tried to loosen a gate, logged once per app, tool and value. */
const loggedLoosening = new Set();

/**
 * The platform's approval defaults, cleaned: only known modes survive.
 *
 * Shape in `platform.json`:
 *
 * ```json
 * "toolApproval": { "defaults": { "default": "never", "external": "writes" } }
 * ```
 *
 * `internal` / `external` apply to tools of that data flow; `default` to every
 * tool whose data flow has no entry of its own.
 *
 * @param {Object|null|undefined} platform - platform config
 * @returns {{default?: string, internal?: string, external?: string}}
 */
export function platformApprovalDefaults(platform) {
  const raw = platform?.toolApproval?.defaults;
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const key of ['default', ...DATA_FLOWS]) {
    if (isApprovalMode(raw[key])) out[key] = raw[key];
  }
  return out;
}

/**
 * What is wrong with a `toolApproval` platform block, or null when it is fine
 * (for the admin save). Only `defaults.default`, `.internal` and `.external`
 * with a known mode are accepted.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function toolApprovalConfigProblem(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return 'toolApproval must be an object';
  }
  const defaults = value.defaults;
  if (defaults === undefined || defaults === null) return null;
  if (typeof defaults !== 'object' || Array.isArray(defaults)) {
    return 'toolApproval.defaults must be an object';
  }
  for (const [key, mode] of Object.entries(defaults)) {
    if (!['default', ...DATA_FLOWS].includes(key)) {
      return `toolApproval.defaults.${key} is not a known key (default, internal, external)`;
    }
    if (mode !== undefined && mode !== null && !isApprovalMode(mode)) {
      return `toolApproval.defaults.${key} must be one of ${APPROVAL_MODES.join(', ')}`;
    }
  }
  return null;
}

/**
 * Side effect from MCP tool annotations (spec 2025-03-26). Kept here, beside
 * the resolver, so the gate and the integration adapter read them the same way.
 *
 * @param {Object|null|undefined} annotations
 * @returns {'read'|'write'|'destructive'|'unknown'}
 */
export function sideEffectFromAnnotations(annotations) {
  if (!annotations || typeof annotations !== 'object') return 'unknown';
  if (annotations.readOnlyHint === true) return 'read';
  if (annotations.destructiveHint === true) return 'destructive';
  if (annotations.destructiveHint === false || annotations.readOnlyHint === false) return 'write';
  return 'unknown';
}

/**
 * The original action name of an integration tool (what `approval.actions`
 * and `actions.overrides` are keyed by), or null for any other tool.
 *
 * @param {Object} toolDef
 * @returns {string|null}
 */
export function actionNameOf(toolDef) {
  const name = toolDef?._integration?.action || toolDef?._mcp?.originalName;
  return typeof name === 'string' && name ? name : null;
}

/**
 * The resolved side effect of a tool and where it came from.
 *
 * 1. The installation's admin override (`actions.overrides[action].sideEffect`).
 * 2. The tool file's own `sideEffect` (per function, copied by `expandToolFunctions`).
 * 3. An integration action's declared side effect (definition, OpenAPI method).
 * 4. MCP annotations — **untrusted**, see the module docs.
 * 5. `readOnly: true` (iHub's own connectors) or an internal tool → `read`.
 * 6. `unknown`.
 *
 * @param {Object} toolDef
 * @param {Object|null} [installation] - the tool's installed integration
 * @returns {{sideEffect: string, sideEffectSource: string}}
 */
export function resolveSideEffect(toolDef, installation = null) {
  const action = actionNameOf(toolDef);
  const override = action ? installation?.actions?.overrides?.[action]?.sideEffect : undefined;
  if (SIDE_EFFECTS.includes(override)) return { sideEffect: override, sideEffectSource: 'admin' };
  const declared = toolDef?.sideEffect;
  const isMcp = Boolean(toolDef?._mcp);
  if (SIDE_EFFECTS.includes(declared) && declared !== 'unknown' && !isMcp) {
    return {
      sideEffect: declared,
      sideEffectSource: toolDef?._integration ? 'definition' : 'tool'
    };
  }
  if (isMcp) {
    const fromAnnotations = sideEffectFromAnnotations(toolDef._mcp.annotations);
    if (fromAnnotations !== 'unknown') {
      return { sideEffect: fromAnnotations, sideEffectSource: 'annotation' };
    }
  }
  if (toolDef?.readOnly === true || toolDef?.isInternalTool === true) {
    return { sideEffect: 'read', sideEffectSource: 'tool' };
  }
  return { sideEffect: 'unknown', sideEffectSource: 'default' };
}

/**
 * Where a tool's data goes. Declared values win; remote MCP servers and A2A
 * agents are external; everything else is iHub's own (`internal`).
 *
 * @param {Object} toolDef
 * @returns {'internal'|'external'}
 */
export function resolveDataFlow(toolDef) {
  if (DATA_FLOWS.includes(toolDef?.dataFlow)) return toolDef.dataFlow;
  if (toolDef?._mcp || toolDef?._a2a) return 'external';
  return 'internal';
}

/**
 * The app's override for a tool: by the tool id, else by the installation id
 * of an integration tool, else the app's default. Null when the app sets none.
 *
 * @param {Object|null} app
 * @param {Object} toolDef
 * @returns {string|null}
 */
export function appApprovalFor(app, toolDef) {
  const config = app?.toolApproval;
  if (!config || typeof config !== 'object') return null;
  const tools = config.tools && typeof config.tools === 'object' ? config.tools : {};
  const instanceId = toolDef?._integration?.instanceId;
  const candidates = [
    tools[toolDef?.id],
    instanceId ? tools[instanceId] : undefined,
    config.default
  ];
  let strictest = null;
  for (const mode of candidates) {
    if (modeRank(mode) > modeRank(strictest)) strictest = mode;
  }
  return strictest;
}

/**
 * Resolve the approval policy of one tool for one app.
 *
 * Idempotent: a tool that was already stamped (it carries `approvalSource`)
 * comes back with its stamped policy.
 *
 * @param {Object} toolDef - the tool as `loadTools` / `getToolsForApp` produce it
 * @param {Object|null} app - the app the tool is offered by (null: no app override)
 * @param {Object|null} platform - platform config
 * @param {Object} [options]
 * @param {Object|null} [options.installation] - the tool's installed integration, when it has one
 * @param {Object} [options.log] - logger (tests)
 * @returns {{approval: string, sideEffect: string, sideEffectSource: string,
 *   dataFlow: string, approvalSource: string}}
 *
 * @example
 * resolveToolApproval(
 *   { id: 'jira__comment', _integration: { instanceId: 'jira', action: 'comment' }, sideEffect: 'write' },
 *   { id: 'support' },
 *   { toolApproval: { defaults: { external: 'writes' } } },
 *   { installation: { id: 'jira', approval: { actions: { comment: 'always' } } } }
 * ) // { approval: 'always', approvalSource: 'action', sideEffect: 'write', … }
 */
export function resolveToolApproval(toolDef, app, platform, options = {}) {
  if (toolDef && typeof toolDef.approvalSource === 'string' && isApprovalMode(toolDef.approval)) {
    return {
      approval: toolDef.approval,
      sideEffect: SIDE_EFFECTS.includes(toolDef.sideEffect) ? toolDef.sideEffect : 'unknown',
      sideEffectSource: toolDef.sideEffectSource || 'default',
      dataFlow: resolveDataFlow(toolDef),
      approvalSource: toolDef.approvalSource
    };
  }
  const installation = options.installation || null;
  const log = options.log || logger;
  const { sideEffect, sideEffectSource } = resolveSideEffect(toolDef, installation);
  const dataFlow = resolveDataFlow(toolDef);

  let approval = 'never';
  let approvalSource = 'default';
  const apply = (mode, source) => {
    if (modeRank(mode) > modeRank(approval)) {
      approval = mode;
      approvalSource = source;
    }
  };

  // 1. platform default by data flow
  const defaults = platformApprovalDefaults(platform);
  if (defaults[dataFlow]) apply(defaults[dataFlow], `platform:${dataFlow}`);
  else if (defaults.default) apply(defaults.default, 'platform');

  // 2. tool config / installation default
  if (toolDef?.requiresApproval === true) apply('always', 'tool');
  if (!toolDef?._integration && isApprovalMode(toolDef?.approval)) apply(toolDef.approval, 'tool');
  const installationApproval = installation?.approval;
  if (installationApproval && typeof installationApproval === 'object') {
    apply(installationApproval.default, 'installation');
    // 3. the action, by its original name
    const action = actionNameOf(toolDef);
    if (action) apply(installationApproval.actions?.[action], 'action');
  }

  // 4. the app: may only tighten
  const appMode = appApprovalFor(app, toolDef);
  if (appMode) {
    if (modeRank(appMode) < modeRank(approval)) {
      const key = `${app?.id}|${toolDef?.id}|${appMode}`;
      if (!loggedLoosening.has(key)) {
        loggedLoosening.add(key);
        log.warn('App tool approval override is looser than the admin setting; ignored', {
          component: COMPONENT,
          appId: app?.id,
          toolId: toolDef?.id,
          appMode,
          effective: approval,
          effectiveSource: approvalSource
        });
      }
    } else {
      apply(appMode, 'app');
    }
  }

  return { approval, sideEffect, sideEffectSource, dataFlow, approvalSource };
}

/**
 * Stamp every tool with its resolved policy. Returns new tool objects: the
 * loaded tools are shared between apps and must not carry one app's policy.
 *
 * @param {Array<Object>} tools
 * @param {Object|null} app
 * @param {Object|null} platform
 * @param {Object} [options]
 * @param {(instanceId: string) => Object|null} [options.getInstallation] - installed integration lookup
 * @returns {Array<Object>}
 */
export function stampToolApproval(tools, app, platform, { getInstallation } = {}) {
  return (Array.isArray(tools) ? tools : []).map(tool => {
    if (!tool || typeof tool !== 'object') return tool;
    const instanceId = tool._integration?.instanceId;
    const installation = instanceId && getInstallation ? getInstallation(instanceId) : null;
    return { ...tool, ...resolveToolApproval(tool, app, platform, { installation }) };
  });
}

/**
 * Whether this tool, as offered, needs a person's approval. Interactive tools
 * (`ask_user`) never do: they do not run, they ask.
 *
 * @param {Object} toolDef - a stamped tool (or one resolved on the fly)
 * @param {Object|null} [app]
 * @param {Object|null} [platform]
 * @returns {boolean}
 */
export function toolNeedsApproval(toolDef, app = null, platform = null) {
  if (!toolDef || toolDef.interactive === true || toolDef.requiresUserInput === true) return false;
  return needsApproval(resolveToolApproval(toolDef, app, platform));
}

/** Test hook: forget which loosening attempts were already logged. */
export function _resetLoggedLoosening() {
  loggedLoosening.clear();
}
