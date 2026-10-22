// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Where projects are linked from configuration (spec 1 §6.1, §6.2): the
 * `projects` lists on apps, workflows (top level, and the prompt, planner,
 * verifier and project step nodes) and agent profiles.
 *
 * Two questions are answered here:
 *
 *  - {@link linkedProjectIds}: which admin projects does *this caller* reach
 *    through an app, workflow or agent they may use? That is what lets a
 *    user read an admin project (`projectAccess`, the `linked` context).
 *  - {@link findDependencies}: what links *this project*? That is what stops
 *    an admin deleting a project an app still relies on, and what the admin
 *    page lists.
 *
 * @module services/projects/projectLinks
 */
import configCache from '../../configCache.js';
import { filterResourcesByPermissions } from '../../utils/authorization.js';
import { normalizeProjectLink } from '../../validators/projectSchema.js';
import { effectiveGroups } from './projectAccess.js';
import { filterByPermissions } from '../workflow/workflowAccess.js';

/**
 * Node types whose `config.projects` is honoured: the model steps and the
 * project steps (`project-items`, `project-read`, `project-write`), whose
 * own links win over the workflow's (`workflowProjectLinks`).
 */
export const PROJECT_NODE_TYPES = Object.freeze([
  'prompt',
  'planner',
  'verifier',
  'project-items',
  'project-read',
  'project-write'
]);

/**
 * The project ids a `projects` list names, whatever shape each entry has.
 *
 * @param {unknown} links
 * @returns {string[]}
 */
export function linkedIdsOf(links) {
  if (!Array.isArray(links)) return [];
  const ids = [];
  for (const link of links) {
    const { id } = normalizeProjectLink(link);
    if (id) ids.push(id);
  }
  return ids;
}

/**
 * The links of a workflow: its own list plus every project node's.
 *
 * @param {Object} workflow
 * @returns {Array<{ids: string[], nodeId: string|null}>}
 */
function workflowLinks(workflow) {
  const result = [{ ids: linkedIdsOf(workflow?.projects), nodeId: null }];
  for (const node of Array.isArray(workflow?.nodes) ? workflow.nodes : []) {
    if (!PROJECT_NODE_TYPES.includes(node?.type)) continue;
    const ids = linkedIdsOf(node?.config?.projects);
    if (ids.length) result.push({ ids, nodeId: node.id || null });
  }
  return result;
}

/**
 * The policy the workflow routes apply (`workflowAccess.filterByPermissions`):
 * a signed-in user runs a workflow their `permissions.workflows` grant. The
 * link follows the same rule so a workflow a user may execute never answers
 * 404 for the project it links.
 */
function workflowUsableBy(workflow, user) {
  if (workflow?.enabled === false) return false;
  return filterByPermissions([workflow], user).length > 0;
}

function agentUsableBy(profile, user) {
  if (profile?.enabled === false) return false;
  const allowed = Array.isArray(profile?.groups) ? profile.groups : [];
  if (allowed.length === 0 || allowed.includes('*')) return true;
  const groups = effectiveGroups(user);
  return allowed.some(group => groups.includes(group));
}

/**
 * The admin project ids a caller reaches through an app, workflow or agent
 * they may use.
 *
 * @param {Object|undefined} user - `req.user` with resolved permissions.
 * @returns {Set<string>}
 */
export function linkedProjectIds(user) {
  const ids = new Set();
  if (!user) return ids;
  const apps = configCache.getApps()?.data || [];
  const usableApps = filterResourcesByPermissions(apps, user.permissions?.apps || new Set());
  for (const app of usableApps) for (const id of linkedIdsOf(app?.projects)) ids.add(id);

  for (const workflow of configCache.getWorkflows?.()?.data || []) {
    if (!workflowUsableBy(workflow, user)) continue;
    for (const link of workflowLinks(workflow)) for (const id of link.ids) ids.add(id);
  }

  for (const profile of configCache.getAgentProfiles?.()?.data || []) {
    if (!agentUsableBy(profile, user)) continue;
    for (const id of linkedIdsOf(profile?.projects)) ids.add(id);
  }
  return ids;
}

/**
 * Everything that links one project.
 *
 * @param {string} projectId
 * @returns {Array<{type: 'app'|'workflow'|'agent', id: string, name: string, nodeId?: string}>}
 */
export function findDependencies(projectId) {
  const dependencies = [];
  const nameOf = entry =>
    typeof entry?.name === 'object' && entry.name
      ? entry.name.en || Object.values(entry.name)[0] || entry.id
      : entry?.name || entry?.id || '';
  for (const app of configCache.getApps(true)?.data || []) {
    if (linkedIdsOf(app?.projects).includes(projectId)) {
      dependencies.push({ type: 'app', id: app.id, name: nameOf(app) });
    }
  }
  for (const workflow of configCache.getWorkflows?.(true)?.data || []) {
    for (const link of workflowLinks(workflow)) {
      if (!link.ids.includes(projectId)) continue;
      dependencies.push({
        type: 'workflow',
        id: workflow.id,
        name: nameOf(workflow),
        ...(link.nodeId ? { nodeId: link.nodeId } : {})
      });
    }
  }
  for (const profile of configCache.getAgentProfiles?.(true)?.data || []) {
    if (linkedIdsOf(profile?.projects).includes(projectId)) {
      dependencies.push({ type: 'agent', id: profile.id, name: nameOf(profile) });
    }
  }
  return dependencies;
}
