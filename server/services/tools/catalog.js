// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The tool catalog: every tool the server knows, before any app or user narrows it.
 * The tools of the installed integrations (which include the MCP servers, the A2A
 * agents and iHub's own `ask_user` and scheduled-task tools) and the platform tools
 * of workflows and agents, and the ids of the tools skills and workflows add.
 */

import configCache from '../../configCache.js';
import { installedIntegrationRefs } from '../integrations/installedRefs.js';
import { markAgentIdConflicts } from '../a2a/a2aTools.js';
import logger from '../../utils/logger.js';
import { localizeTools } from '../../utils/toolLocalization.js';
import { isKnowledgeTool } from '../knowledge/knowledgeTools.js';
import { platformToolDefinitions } from './platformTools.js';

/** Agent ids whose id clash has been logged, so each is reported once. */
const reportedA2aIdConflicts = new Set();

/**
 * The tools the skills feature adds to an app with skills: load a skill's
 * instructions, read one of its files, and search the catalog when the list
 * in the prompt is shortened. They belong to skills, not to an integration.
 */
export const ACTIVATE_SKILL_TOOL_ID = 'activate_skill';

export const READ_SKILL_RESOURCE_TOOL_ID = 'read_skill_resource';

export const FIND_SKILL_TOOL_ID = 'find_skill';

export const SKILL_TOOL_IDS = Object.freeze([
  ACTIVATE_SKILL_TOOL_ID,
  READ_SKILL_RESOURCE_TOOL_ID,
  FIND_SKILL_TOOL_ID
]);

/**
 * Prefix of the tool a workflow with chat integration becomes in an app
 * (`workflow_<workflowId>`). Such tools belong to workflows.
 */
export const WORKFLOW_TOOL_ID_PREFIX = 'workflow_';

/**
 * Mark the skills of every A2A agent whose id is also a local tool's (base)
 * id or another installation's id (`_a2a.idConflict`), so that reference
 * never silently grants the remote agent; `a2a__<agentId>` still selects the
 * agent as a whole. The admin API refuses such ids; this covers a hand-edited
 * config and a tool or installation added after the agent.
 *
 * @param {Array<Object>} a2aTools - Discovered A2A tools
 * @param {Array<Object>} otherTools - Local and MCP tools
 * @returns {Array<Object>} The A2A tools, clashing ones marked
 */
function guardA2aAgentIds(a2aTools, otherTools) {
  if (!a2aTools.length) return a2aTools;
  // The agents are installations themselves; only the other installations
  // (MCP servers, catalog integrations) can take an agent's id.
  const agentIds = new Set(a2aTools.map(tool => tool._a2a?.agentId).filter(Boolean));
  const { tools, conflicts } = markAgentIdConflicts(a2aTools, {
    tools: otherTools,
    mcpServers: installedIntegrationRefs().filter(ref => !agentIds.has(ref.id))
  });
  for (const [agentId, conflict] of conflicts) {
    if (reportedA2aIdConflicts.has(agentId)) continue;
    reportedA2aIdConflicts.add(agentId);
    logger.warn(
      'A2A agent id is also a tool or installed integration id; select the agent as a2a__<agentId>',
      { component: 'ToolLoader', agentId, conflictKind: conflict.kind, conflictId: conflict.id }
    );
  }
  return tools;
}

/**
 * Tools of the installed integrations (Admin → Integrations → Installed).
 * Imported lazily: the integration services read configCache, which imports
 * this module.
 */
async function discoverIntegrationTools(language) {
  try {
    const { discoverIntegrationTools: discover } =
      await import('../integrations/integrationTools.js');
    return await discover(language);
  } catch (error) {
    logger.error('Error discovering integration tools', { component: 'ToolLoader', error });
    return [];
  }
}

/** Drop the integration tools the user's groups do not grant (lazy import, see above). */
export async function filterIntegrationToolsForUser(tools, user) {
  if (!tools.some(t => t._integration)) return tools;
  const { filterIntegrationToolsForUser: filter } =
    await import('../integrations/integrationTools.js');
  return filter(tools, user);
}

/**
 * The platform tools — the agent workspace, the evidence tools and the page
 * reader (see `services/tools/platformTools.js`) — localized. They belong to
 * workflows and agents, not to an integration: nothing selects them by an app
 * binding or exposes them over the gateways.
 *
 * @param {string|null} language
 * @returns {Object[]}
 */
export function loadPlatformTools(language = null) {
  const platformConfig = configCache.getPlatform() || {};
  const effectiveLanguage = language || platformConfig?.defaultLanguage || 'en';
  return localizeTools(platformToolDefinitions(), effectiveLanguage);
}

/**
 * Load the tools a request can be offered by id: the platform tools of
 * workflows and agents, and the tools of the installed integrations (which
 * include the MCP servers, the remote A2A agents, the people directories and
 * iHub's own `ask_user` and scheduled-task tools). The first tool of an id
 * wins, in that order.
 *
 * The project knowledge tools (`knowledge_*`) are never in this list: they
 * belong to projects and come with the request's project scope
 * (`getToolsForApp` → `knowledgeToolsFor`); `runTool` dispatches them itself.
 *
 * @param {string} language - Optional language for localization
 * @returns {Promise<Object[]>}
 */
export async function loadTools(language = null) {
  const local = loadPlatformTools(language).filter(tool => !isKnowledgeTool(tool.id));
  // Installed integrations include the MCP servers, the remote A2A agents and
  // the people directories (their tools keep `_mcp`, `_a2a` and
  // `_peopleDirectory`).
  const discoveredIntegrationTools = await discoverIntegrationTools(language);
  const otherTools = discoveredIntegrationTools.filter(t => !t._a2a);
  const a2aTools = guardA2aAgentIds(
    discoveredIntegrationTools.filter(t => t._a2a),
    [...local, ...otherTools]
  );
  const discovered = [...otherTools, ...a2aTools];
  const all = [];
  const seen = new Set();
  for (const tool of [...local, ...discovered]) {
    // A discovered tool of a knowledge id does not put a knowledge tool into
    // the list either.
    if (seen.has(tool.id) || isKnowledgeTool(tool.id)) continue;
    seen.add(tool.id);
    all.push(tool);
  }
  return all;
}
