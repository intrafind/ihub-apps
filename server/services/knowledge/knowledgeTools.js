// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The knowledge tools as one request sees them (spec 2 §4.1): the three
 * functions of `tools/knowledge.json`, with the request's scope appended to
 * each description so the model knows which project ids `project` accepts
 * and which projects it already has in context.
 *
 * Offered whenever the request reaches a project. A project loaded in full
 * (`mode: 'context'`, or one the planner loads because it fits) still allows
 * a search, which is harmless — and the planner may have to cut such a
 * project at the hard limit, when `knowledge_read` is the only way to the
 * omitted text. The tools are taken from the installation's tool list and
 * only from there: a definition the admin disabled or removed is neither
 * advertised nor runnable.
 *
 * @module services/knowledge/knowledgeTools
 */
import { describeScope, resolveProjectScope } from './ProjectScope.js';

/** The three function ids, in the order the model sees them. */
export const KNOWLEDGE_TOOL_IDS = Object.freeze([
  'knowledge_search',
  'knowledge_read',
  'knowledge_list'
]);

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
 * The knowledge tools for one request, or an empty list when it reaches no
 * project or the installation does not carry the (enabled) definitions.
 *
 * @param {Object} options
 * @param {Object} options.app - The app object with its link fields.
 * @param {Object} options.user - The requesting user.
 * @param {string} [options.language]
 * @param {Object[]} [options.allTools] - The installation's localized, enabled tools.
 * @returns {Promise<Object[]>}
 */
export async function knowledgeToolsFor({ app, user, language = 'en', allTools = [] }) {
  if (!hasProjectScope(app) || !user) return [];
  const scope = await resolveProjectScope({ appConfig: app, user });
  if (!scope.length) return [];
  const definitions = KNOWLEDGE_TOOL_IDS.map(id =>
    allTools.find(tool => tool.id === id && tool.enabled !== false)
  );
  if (definitions.some(tool => !tool)) return [];
  const scopeText = describeScope(
    scope.map(entry => ({ ...entry, effective: entry.mode === 'context' ? 'loaded' : 'searched' })),
    language
  );
  return definitions.map(tool => ({
    ...tool,
    description: `${tool.description || ''}\n\nProjects available: ${scopeText}.`.trim()
  }));
}
