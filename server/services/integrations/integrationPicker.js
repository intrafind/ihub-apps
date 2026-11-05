// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The rows of the chat's integrations picker (#2923, concept
 * `2026-10-20 Unified Integrations/03-product-concept.md` §7.2): one row per
 * integration an app offers this user, never one per action.
 *
 * Decided here, on the server, because only the server knows which
 * installation, MCP server or remote agent a tool belongs to (CLAUDE.md "the
 * server decides, the client renders"). The client switches a row on or off
 * by adding or removing the row's `refs` in the chat's `enabledTools`; it
 * never reads a tool id to find out what a row is.
 *
 * A row:
 *
 * ```jsonc
 * {
 *   "id": "integration:jira",          // stable key of the row
 *   "kind": "integration",             // integration | mcp | agent | tool
 *   "integration": "jira",             // installation id (kind integration), else null
 *   "refs": ["jira"],                  // what switching the row on adds to `enabledTools`
 *   "coveredBy": ["type:storage"],     // other references that also keep it on
 *   "name": "Atlassian Jira", "description": "…", "icon": null,
 *   "effects": ["read", "write"],      // of the actions the app offers
 *   "capabilities": ["tools"],
 *   "connection": { "mode": "personal", "status": "not_connected", "reason": null,
 *                   "account": null, "connectable": true }   // kind integration only
 * }
 * ```
 *
 * `coveredBy` exists because an app may bind several installations with one
 * key (`type:storage`, a definition id): that key keeps every one of them on,
 * while each row switches only its own installation.
 *
 * @module services/integrations/integrationPicker
 */
import logger from '../../utils/logger.js';
import {
  availableOnlyBindingKeys,
  defaultEnabledRefs
} from '../../../shared/integrationDefaults.js';
import { localized } from './definitions/installedValues.js';
import { a2aAgentReference, isInteractiveTool } from '../../utils/toolSelection.js';
import { effectsOf, listUserIntegrations } from './userIntegrations.js';

const COMPONENT = 'IntegrationPicker';

/** Binding keys that bind no tools: iAssistant is reached through the model. */
const SCOPE_ONLY_BINDINGS = new Set(['iassistant']);

/**
 * Every tool reference an app offers a chat: its `tools` and the keys of the
 * integrations it binds for their tools (`app.integrations`), the same list
 * the chat has always started with. A binding with `actions: []` binds an
 * integration for its scopes only and is left out.
 *
 * @param {Object} app
 * @returns {string[]}
 */
export function appCandidateRefs(app) {
  const listed = Array.isArray(app?.tools) ? app.tools.filter(ref => typeof ref === 'string') : [];
  const bindings =
    app?.integrations && typeof app.integrations === 'object' ? app.integrations : {};
  const bound = Object.entries(bindings)
    .filter(
      ([key, binding]) =>
        !SCOPE_ONLY_BINDINGS.has(key) &&
        !(Array.isArray(binding?.actions) && binding.actions.length === 0)
    )
    .map(([key]) => key);
  return [...new Set([...listed, ...bound])];
}

/**
 * The app's own defaults for a new chat: every reference on except the
 * bindings that are available only (`enabledByDefault: false`), web search as
 * the app says.
 *
 * @param {Object} app
 * @returns {{enabledTools: string[], websearchEnabled: boolean}}
 */
export function appIntegrationDefaults(app) {
  return {
    enabledTools: defaultEnabledRefs(app, appCandidateRefs(app)),
    websearchEnabled: app?.websearch?.enabled === true && app.websearch.enabledByDefault === true
  };
}

/**
 * The references a chat request without its own tool list runs with (an API
 * call, a task): the app's defaults, so an integration the app makes available
 * only (`enabledByDefault: false`) is not on just because nobody switched it
 * on. Undefined when the app has no such binding: the chat is then not
 * narrowed at all, exactly as before the setting existed.
 *
 * @param {Object} app
 * @returns {string[]|undefined}
 */
export function appDefaultEnabledTools(app) {
  if (availableOnlyBindingKeys(app).size === 0) return undefined;
  return appIntegrationDefaults(app).enabledTools;
}

/**
 * Who a tool belongs to, as a row key, the reference that selects all of it
 * (`isToolSelected`), its kind and its name.
 *
 * @param {Object} tool
 * @param {string} matchedRef - The app's reference that selects the tool
 * @returns {{key: string, ref: string, kind: string, integration: (string|null), name: any}}
 */
export function ownerOfTool(tool, matchedRef) {
  const integration = tool?._integration?.instanceId;
  if (integration) {
    // An A2A installation whose id is also another tool's id is selected by
    // its agent reference, never by the bare id.
    const ref =
      tool._a2a?.idConflict && tool._a2a.agentId
        ? a2aAgentReference(tool._a2a.agentId)
        : integration;
    return {
      key: `integration:${integration}`,
      ref,
      kind: 'integration',
      integration,
      name: tool._integration.instanceLabel || integration
    };
  }
  if (tool?._mcp?.serverId) {
    return {
      key: `mcp:${tool._mcp.serverId}`,
      ref: tool._mcp.serverId,
      kind: 'mcp',
      integration: null,
      name: tool._mcp.serverName || tool._mcp.serverId
    };
  }
  if (tool?._a2a?.agentId) {
    const ref = tool._a2a.idConflict ? a2aAgentReference(tool._a2a.agentId) : tool._a2a.agentId;
    return {
      key: `agent:${tool._a2a.agentId}`,
      ref,
      kind: 'agent',
      integration: null,
      name: tool._a2a.agentName || tool._a2a.agentId
    };
  }
  // A plain tool: the app's own reference is the row (a base id such as
  // `jira` folds every `jira_*` tool into one row).
  return {
    key: `tool:${matchedRef}`,
    ref: matchedRef,
    kind: 'tool',
    integration: null,
    name: matchedRef === tool?.id ? tool?.name || tool?.id : matchedRef
  };
}

/** The first paragraph of a description. */
function shortDescription(value, language) {
  return String(localized(value, language) || '').split('\n\n')[0];
}

/** The part of a listing entry's connection the picker shows. */
function connectionOf(entry, user) {
  const connection = entry?.connection;
  if (!connection) return null;
  const anonymous = !user?.id || user.id === 'anonymous';
  return {
    mode: connection.mode,
    status: connection.status,
    reason: connection.reason ?? null,
    account: connection.account ?? null,
    // Only a signed-in user can connect an account.
    connectable: connection.connectable === true && !anonymous
  };
}

/**
 * One row per owner (installation, MCP server, remote agent or tool) of the
 * app's tools, with the side effects of its actions.
 *
 * @returns {{rows: Map<string, Object>, actionsOf: Map<string, Object[]>}}
 */
function collectRows({ tools, candidates, app, language, isBoundToolEnabled }) {
  const rows = new Map();
  const actionsOf = new Map();
  for (const tool of Array.isArray(tools) ? tools : []) {
    // The model's channel to ask the user is not a switch (`isInteractiveTool`).
    if (!tool?.id || isInteractiveTool(tool)) continue;
    const matching = candidates.filter(ref => isBoundToolEnabled(app, tool, [ref]));
    // Injected tools (sources, workflows, skills, other apps) are not the
    // app's references and have no row.
    if (matching.length === 0) continue;
    const owner = ownerOfTool(tool, matching[0]);
    let row = rows.get(owner.key);
    if (!row) {
      row = {
        id: owner.key,
        kind: owner.kind,
        integration: owner.integration,
        refs: [owner.ref],
        coveredBy: new Set(),
        name: localized(owner.name, language) || owner.ref,
        description: owner.kind === 'tool' ? shortDescription(tool.description, language) : '',
        icon: null,
        capabilities: [],
        connection: null,
        order: Math.min(...matching.map(ref => candidates.indexOf(ref)))
      };
      rows.set(owner.key, row);
      actionsOf.set(owner.key, []);
    }
    for (const ref of matching) if (ref !== owner.ref) row.coveredBy.add(ref);
    actionsOf.get(owner.key).push({ sideEffect: tool.sideEffect || 'unknown' });
  }
  return { rows, actionsOf };
}

/**
 * Name, icon, capabilities and connection of the installations among the
 * rows, as Settings → Integrations lists them. Empty when there are none or
 * the listing fails.
 *
 * @returns {Promise<Map<string, Object>>}
 */
async function describeIntegrations({ rows, user, language, listIntegrations }) {
  if (![...rows.values()].some(row => row.integration)) return new Map();
  try {
    const listed = await listIntegrations({ user, language });
    return new Map((listed || []).map(entry => [entry.id, entry]));
  } catch (error) {
    logger.warn('Could not describe the integrations for the picker', {
      component: COMPONENT,
      error: error.message
    });
    return new Map();
  }
}

/**
 * The picker rows of an app for a user, in the app's order of references.
 *
 * @param {Object} params
 * @param {Object} params.app
 * @param {Object} params.user - `req.user` with permissions resolved
 * @param {string} [params.language='en']
 * @param {Object} [params.deps] - Test seams
 * @param {Function} [params.deps.getToolsForApp]
 * @param {Function} [params.deps.isBoundToolEnabled]
 * @param {Function} [params.deps.listUserIntegrations]
 * @returns {Promise<Object[]>}
 */
export async function pickerRowsForApp({ app, user, language = 'en', deps = {} }) {
  const candidates = appCandidateRefs(app);
  if (candidates.length === 0) return [];

  const getToolsForApp =
    deps.getToolsForApp || (await import('../tools/appTools.js')).getToolsForApp;
  const isBoundToolEnabled =
    deps.isBoundToolEnabled || (await import('./integrationTools.js')).isBoundToolEnabled;
  const listIntegrations = deps.listUserIntegrations || listUserIntegrations;

  let tools = [];
  try {
    // Web search is a row of its own and not a tool reference: leave the
    // engine out.
    tools = await getToolsForApp(app, language, { user, language, websearchEnabled: false });
  } catch (error) {
    logger.warn('Could not load the tools of the app for the picker', {
      component: COMPONENT,
      appId: app?.id,
      error: error.message
    });
    return [];
  }

  const { rows, actionsOf } = collectRows({ tools, candidates, app, language, isBoundToolEnabled });
  if (rows.size === 0) return [];
  const entries = await describeIntegrations({ rows, user, language, listIntegrations });

  return [...rows.values()]
    .sort((a, b) => a.order - b.order)
    .map(({ order: _order, coveredBy, ...row }) => {
      const entry = row.integration ? entries.get(row.integration) : null;
      return {
        ...row,
        coveredBy: [...coveredBy],
        ...(entry
          ? {
              name: entry.name || row.name,
              description: entry.description || '',
              icon: entry.icon || null,
              capabilities: Array.isArray(entry.capabilities) ? entry.capabilities : [],
              connection: connectionOf(entry, user)
            }
          : {}),
        effects: effectsOf(actionsOf.get(row.id)).filter(effect => effect !== 'unknown')
      };
    });
}
