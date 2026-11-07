// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The knowledge tools as one request sees them (spec 2 §4.1): the three
 * functions of the shipped `tools/knowledge.json`, with the request's scope
 * appended to each description so the model knows which project ids
 * `project` accepts and which projects it already has in context.
 *
 * The tools belong to projects, not to an integration or a tool list
 * (Unified Integrations concept §6.9): they are offered whenever the
 * projects feature is on and the request reaches a project, and never
 * otherwise. Their definitions are the shipped file, read here as data; no
 * installation or action switch adds, removes or
 * changes them. `runTool` hands a call to {@link runKnowledgeTool}, which runs
 * the implementation in `server/tools/knowledge.js`; that resolves the
 * request's scope again on every call, so the model cannot reach a project
 * the request did not bring.
 *
 * A project loaded in full (`mode: 'context'`, or one the planner loads
 * because it fits) still allows a search, which is harmless — and the planner
 * may have to cut such a project at the hard limit, when `knowledge_read` is
 * the only way to the omitted text.
 *
 * @module services/knowledge/knowledgeTools
 */
import configCache from '../../configCache.js';
import { isProjectsConfigured } from '../projects/projectSettings.js';
import { readShippedToolDefinitions, runShippedTool } from '../tools/shippedToolDefinitions.js';
import { localizeTools, platformDefaultLanguage } from '../../utils/toolLocalization.js';
import { describeScope, resolveProjectScope } from './ProjectScope.js';

/** The shipped tool file the knowledge tools are defined in. */
export const KNOWLEDGE_TOOL_FILE_ID = 'knowledge';

/** The three function ids, in the order the model sees them. */
export const KNOWLEDGE_TOOL_IDS = Object.freeze([
  'knowledge_search',
  'knowledge_read',
  'knowledge_list'
]);

const DEFINITIONS = readShippedToolDefinitions([KNOWLEDGE_TOOL_FILE_ID]);

/**
 * Whether a tool id is one of the knowledge tools.
 *
 * @param {string} toolId
 * @returns {boolean}
 */
export function isKnowledgeTool(toolId) {
  return KNOWLEDGE_TOOL_IDS.includes(toolId);
}

/**
 * Whether the projects feature is on — the master switch every project
 * hangs on (`features.projects`).
 *
 * @returns {boolean}
 */
export function isProjectsFeatureOn() {
  return isProjectsConfigured(configCache.getFeatures());
}

/**
 * Whether an app object carries any project link or attachment.
 *
 * @param {Object|null} app
 * @returns {boolean}
 */
export function hasProjectScope(app) {
  if (!app) return false;
  return Boolean(
    (Array.isArray(app.projects) && app.projects.length) ||
    app._projectId ||
    (Array.isArray(app._attachedProjectIds) && app._attachedProjectIds.length) ||
    (Array.isArray(app._workflowProjects) && app._workflowProjects.length)
  );
}

/**
 * The knowledge tools for one request, or an empty list when the projects
 * feature is off or the request reaches no project the user may use.
 *
 * @param {Object} options
 * @param {Object} options.app - The app object with its link fields (`projects`,
 *   `_projectId`, `_attachedProjectIds`, `_workflowProjects`).
 * @param {Object} options.user - The requesting user.
 * @param {string|null} [options.language] - Language of the descriptions; the
 *   platform's default language when absent, as for every other tool.
 * @returns {Promise<Object[]>} Localized definitions, `knowledge_search` first.
 * @example
 * const tools = await knowledgeToolsFor({ app: { id: 'chat', _projectId: 'prj_1' }, user });
 * // → knowledge_search, knowledge_read, knowledge_list; each description ends with
 * //   "Projects available: prj_1 (…)."
 */
export async function knowledgeToolsFor({ app, user, language = null }) {
  if (!isProjectsFeatureOn() || !hasProjectScope(app) || !user) return [];
  const lang = language || platformDefaultLanguage();
  const scope = await resolveProjectScope({ appConfig: app, user });
  if (!scope.length) return [];
  const scopeText = describeScope(
    scope.map(entry => ({ ...entry, effective: entry.mode === 'context' ? 'loaded' : 'searched' })),
    lang
  );
  const definitions = localizeTools(
    KNOWLEDGE_TOOL_IDS.map(id => DEFINITIONS.get(id)),
    lang
  );
  return definitions.map(tool => ({
    ...tool,
    description: `${tool.description || ''}\n\nProjects available: ${scopeText}.`.trim()
  }));
}

/**
 * Run a knowledge tool call (`runTool` dispatches every `knowledge_*` id here).
 *
 * @param {string} toolId - `knowledge_search`, `knowledge_read` or `knowledge_list`
 * @param {Object} [params] - The model's arguments plus iHub's context
 *   (`user`, `chatId`, `appConfig` with the request's project links)
 * @returns {Promise<Object>} The implementation's result
 * @throws {Error} When the id is not a knowledge tool or the projects feature is off
 */
export async function runKnowledgeTool(toolId, params = {}) {
  const tool = DEFINITIONS.get(toolId);
  if (!tool || !isProjectsFeatureOn()) {
    throw new Error(`Tool ${toolId} is not available`);
  }
  return runShippedTool(tool, params);
}
