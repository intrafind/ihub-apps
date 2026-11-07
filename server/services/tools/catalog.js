// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The tool catalog: every tool the server knows, before any app or user narrows it.
 * The tools of `contents/tools/`, the platform tools, the tools of MCP servers, A2A
 * agents and installed integrations, and the ids of the tools skills and workflows add.
 */

import configCache from '../../configCache.js';
import { installedIntegrationRefs } from '../integrations/installedRefs.js';
import { markAgentIdConflicts } from '../a2a/a2aTools.js';
import logger from '../../utils/logger.js';
import { localizeTools } from '../../utils/toolLocalization.js';
import { isKnowledgeTool } from '../knowledge/knowledgeTools.js';
import { platformToolDefinitions } from './platformTools.js';

/**
 * Load tools defined locally in contents/tools/
 * @param {string} language - Optional language for localization
 */
export async function loadConfiguredTools(language = null) {
  // Try to get tools from cache first
  const { data: tools } = configCache.getTools();
  if (!tools) {
    logger.warn('Tools could not be loaded', { component: 'ToolLoader' });
    return [];
  }

  // Always localize tools to ensure nested multilingual fields (like descriptions in schemas)
  // are converted to strings. Use provided language or fall back to platform default.
  const platformConfig = configCache.getPlatform() || {};
  const effectiveLanguage = language || platformConfig?.defaultLanguage || 'en';
  const localized = localizeTools(tools, effectiveLanguage);

  // OpenAPI tool files are gone: migration V211 turned every one into a
  // custom integration, and nothing creates them any more. A file put back
  // by hand has nothing to run it, so it is not offered.
  const offered = [];
  for (const tool of localized) {
    if (tool?.type === 'openapi') {
      if (!reportedOpenApiToolFiles.has(tool.id)) {
        reportedOpenApiToolFiles.add(tool.id);
        logger.warn(
          'OpenAPI tool files are no longer supported; build the integration under Admin → Integrations → Add manually',
          { component: 'ToolLoader', toolId: tool.id }
        );
      }
      continue;
    }
    offered.push(tool);
  }
  return offered;
}

/** OpenAPI tool files already reported as unsupported, so each is logged once. */
const reportedOpenApiToolFiles = new Set();

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
 * The platform tools — the workflow and agent tools (agent workspace,
 * evidence; see `services/tools/platformTools.js`) — localized, as plain
 * tools. A file in `contents/tools/` with the same id takes the place of the
 * shipped definition whether it is enabled or not, as a configured tool did
 * before migration V199: an admin-edited file V199 kept keeps serving its
 * tool, and one switched off (`enabled: false`) keeps it off.
 *
 * @param {string|null} language
 * @returns {Object[]}
 */
export function loadPlatformTools(language) {
  const { data: files } = configCache.getTools(true);
  const configuredIds = new Set((files || []).map(tool => tool?.id));
  const platformConfig = configCache.getPlatform() || {};
  const effectiveLanguage = language || platformConfig?.defaultLanguage || 'en';
  return localizeTools(
    platformToolDefinitions().filter(tool => !configuredIds.has(tool.id)),
    effectiveLanguage
  );
}

/**
 * iHub's local tools — every tool that is not an installed integration's: the
 * configured tools (`contents/tools/`) and the platform tools of workflows and
 * agents. The inbound MCP gateway offers these to the callers whose groups or
 * apps grant them, as it offered the tool files before migration V199.
 *
 * A leftover `contents/tools/knowledge.json` (an admin-edited copy V199 kept)
 * does not put a knowledge tool into the list: those ids are the projects'
 * (see {@link loadTools}).
 *
 * @param {string|null} [language] - Language for localization (platform default when absent)
 * @returns {Promise<Object[]>}
 */
export async function loadLocalTools(language = null) {
  const configured = await loadConfiguredTools(language);
  const platform = loadPlatformTools(language);
  return [...configured, ...platform].filter(tool => !isKnowledgeTool(tool.id));
}

/**
 * Load the tools a request can be offered by id: the configured tools
 * (`contents/tools/`), the platform tools of workflows and agents, and the
 * tools of the installed integrations (which include the MCP servers, the
 * remote A2A agents, the people directories and iHub's own `ask_user` and
 * scheduled-task tools). The first tool of an id wins, in that order.
 *
 * The project knowledge tools (`knowledge_*`) are never in this list: they
 * belong to projects and come with the request's project scope
 * (`getToolsForApp` → `knowledgeToolsFor`); `runTool` dispatches them itself.
 *
 * @param {string} language - Optional language for localization
 * @returns {Promise<Object[]>}
 */
export async function loadTools(language = null) {
  const local = await loadLocalTools(language);
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
