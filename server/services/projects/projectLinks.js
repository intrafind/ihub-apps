// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Where projects are linked from configuration (spec 1 §6.1, §6.2): the
 * `projects` lists on apps, workflows (top level; the prompt, planner,
 * verifier and project step nodes, inside inline loop bodies too; and a
 * planner's task template) and agent profiles.
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
import { visibleToUser as profileVisibleToUser } from '../../routes/agents/profiles.js';
import { filterByPermissions } from '../workflow/workflowAccess.js';
import { appUsesProjects } from './projectSettings.js';

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

/** How deep inline loop bodies are followed; loops nest a few levels at most. */
const MAX_BODY_DEPTH = 16;

/**
 * Append the links of a list of nodes to `result`, following the steps of
 * inline loop bodies (`loop.config.body`, which `LoopNodeExecutor` runs,
 * nested loops too).
 *
 * @param {unknown} nodes
 * @param {Array<{ids: string[], nodeId: string|null}>} result
 * @param {number} depth
 */
function collectNodeLinks(nodes, result, depth) {
  if (!Array.isArray(nodes) || depth > MAX_BODY_DEPTH) return;
  for (const node of nodes) {
    if (node?.type === 'loop') collectNodeLinks(node.config?.body, result, depth + 1);
    if (!PROJECT_NODE_TYPES.includes(node?.type)) continue;
    const ids = linkedIdsOf(node?.config?.projects);
    if (node.type === 'planner') ids.push(...linkedIdsOf(node?.config?.taskTemplate?.projects));
    if (ids.length) result.push({ ids: [...new Set(ids)], nodeId: node.id || null });
  }
}

/**
 * Every object of a workflow that carries a `projects` list: the workflow,
 * the config of each project-aware node (inline loop bodies followed) and a
 * planner's task template. The same places {@link findDependencies} reads, as
 * the objects themselves, for callers that rewrite the lists.
 *
 * @param {Object} workflow
 * @returns {Object[]}
 */
export function workflowLinkOwners(workflow) {
  const owners = [workflow];
  const walk = (nodes, depth) => {
    if (!Array.isArray(nodes) || depth > MAX_BODY_DEPTH) return;
    for (const node of nodes) {
      if (node?.type === 'loop') walk(node.config?.body, depth + 1);
      if (!PROJECT_NODE_TYPES.includes(node?.type)) continue;
      if (node.config && typeof node.config === 'object') {
        owners.push(node.config);
        const template = node.config.taskTemplate;
        if (node.type === 'planner' && template && typeof template === 'object') {
          owners.push(template);
        }
      }
    }
  };
  walk(workflow?.nodes, 0);
  return owners;
}

/**
 * The links of a workflow: its own list plus every project node's, the
 * steps of inline loop bodies included. A planner's `taskTemplate.projects`
 * counts as its node's links: the workers it materializes at run time carry
 * them, so a caller who may run the workflow must reach them, and deleting
 * one must see the dependency.
 *
 * @param {Object} workflow
 * @returns {Array<{ids: string[], nodeId: string|null}>}
 */
function workflowLinks(workflow) {
  const result = [{ ids: linkedIdsOf(workflow?.projects), nodeId: null }];
  collectNodeLinks(workflow?.nodes, result, 0);
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

/**
 * The policy the profile routes apply (`visibleToUser`): a profile a user
 * cannot open cannot grant them its linked projects either.
 */
function agentUsableBy(profile, user) {
  if (profile?.enabled === false) return false;
  return profileVisibleToUser(profile, user);
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
  for (const app of usableApps) {
    // An app with projects switched off grants none of its links.
    if (!appUsesProjects(app)) continue;
    for (const id of linkedIdsOf(app?.projects)) ids.add(id);
  }

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
