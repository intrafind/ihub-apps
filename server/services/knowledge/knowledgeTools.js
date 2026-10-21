// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The knowledge tools as one request sees them (spec 2 §4.1): the three
 * functions of `tools/knowledge.json`, with the request's scope appended to
 * each description so the model knows which project ids `project` accepts
 * and which projects it already has in context.
 *
 * Offered whenever the request reaches a project that is not loaded in
 * full by configuration (`mode: 'context'`); a project the planner loads
 * because it fits still allows a search, which is harmless.
 *
 * @module services/knowledge/knowledgeTools
 */
import { createRequire } from 'node:module';
import { getLocalizedContent } from '../../../shared/localize.js';
import { describeScope, resolveProjectScope } from './ProjectScope.js';

const require = createRequire(import.meta.url);

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

function localizeDeep(value, language) {
  if (Array.isArray(value)) return value.map(entry => localizeDeep(entry, language));
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    const looksLocalized = keys.length > 0 && keys.every(key => /^[a-z]{2}(-[A-Z]{2})?$/.test(key));
    if (looksLocalized) return getLocalizedContent(value, language);
    const out = {};
    for (const [key, entry] of Object.entries(value)) out[key] = localizeDeep(entry, language);
    return out;
  }
  return value;
}

/**
 * The shipped definitions, expanded and localized, when the installation's
 * tool list does not carry them (the migration has not run, or an admin
 * deleted the file).
 */
function shippedDefinitions(language) {
  const tool = require('../../defaults/tools/knowledge.json');
  return Object.entries(tool.functions || {}).map(([fn, cfg]) => ({
    ...localizeDeep({ ...tool, functions: undefined }, language),
    id: `${tool.id}_${fn}`,
    name: `${tool.id}_${fn}`,
    description: getLocalizedContent(cfg.description, language),
    parameters: localizeDeep(cfg.parameters || {}, language),
    method: fn,
    script: tool.script
  }));
}

/**
 * The knowledge tools for one request, or an empty list when it reaches no
 * project or every project is loaded in full by configuration.
 *
 * @param {Object} options
 * @param {Object} options.app - The app object with its link fields.
 * @param {Object} options.user - The requesting user.
 * @param {string} [options.language]
 * @param {Object[]} [options.allTools] - The installation's localized tools.
 * @returns {Promise<Object[]>}
 */
export async function knowledgeToolsFor({ app, user, language = 'en', allTools = [] }) {
  if (!hasProjectScope(app) || !user) return [];
  const scope = await resolveProjectScope({ appConfig: app, user });
  if (!scope.length) return [];
  if (scope.every(entry => entry.mode === 'context')) return [];
  const fromConfig = KNOWLEDGE_TOOL_IDS.map(id => allTools.find(tool => tool.id === id)).filter(
    Boolean
  );
  const definitions =
    fromConfig.length === KNOWLEDGE_TOOL_IDS.length &&
    fromConfig.every(tool => tool.enabled !== false)
      ? fromConfig
      : fromConfig.length
        ? []
        : shippedDefinitions(language);
  if (!definitions.length) return [];
  const scopeText = describeScope(
    scope.map(entry => ({ ...entry, effective: entry.mode === 'context' ? 'loaded' : 'searched' })),
    language
  );
  return definitions.map(tool => ({
    ...tool,
    description: `${tool.description || ''}\n\nProjects available: ${scopeText}.`.trim()
  }));
}
