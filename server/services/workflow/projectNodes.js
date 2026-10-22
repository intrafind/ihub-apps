// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What the project steps of a workflow share (#1036, spec 1 §6.2 and spec 2
 * §8): which project links a run carries, how a workflow input of type
 * `project` reaches the scope, and how one step resolves the project it
 * names into a provider it may read from or write to.
 *
 * A run reaches a project in three ways, all resolved through
 * `resolveProjectScope`, so the user-projects flag and the running user's
 * rights apply the same way they do in a chat:
 *
 *   - the workflow's `projects` links (node links win, as `sources` did);
 *   - a start-node input variable of `type: 'project'`, whose value lands in
 *     `state.data.<name>` like every other input and is treated as a link
 *     `{ id, mode: 'auto' }`;
 *   - the id a `project-items`, `project-read` or `project-write` step names
 *     in `config.project` (a literal or a `$.data…` reference). A project
 *     named only there is reached with the user's own rights and no `write`
 *     grant from a link.
 *
 * @module services/workflow/projectNodes
 */
import { callerContext, permissionsFor } from '../../middleware/projectAccess.js';
import { resolveProjectScope } from '../knowledge/ProjectScope.js';
import { providerFor } from '../knowledge/registry.js';
import { normalizeProjectLink } from '../../validators/projectSchema.js';

/** The input type of the run dialog's project picker. */
export const PROJECT_INPUT_TYPE = 'project';

/**
 * A failure of a project step, with the code the client and the audit
 * understand (spec 1 §5.4).
 */
export class ProjectNodeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ProjectNodeError';
    this.code = code;
    this.details = details;
  }
}

function idOf(link) {
  return typeof link === 'string' ? link : link?.id;
}

/**
 * The start node's input variables of type `project`.
 *
 * @param {Object} workflow
 * @returns {Array<{name: string, required?: boolean, label?: *}>}
 */
export function projectInputVariables(workflow) {
  const start = (workflow?.nodes || []).find(node => node.type === 'start');
  const variables = start?.config?.inputVariables;
  if (!Array.isArray(variables)) return [];
  return variables.filter(
    variable =>
      variable && variable.type === PROJECT_INPUT_TYPE && typeof variable.name === 'string'
  );
}

/**
 * The links a run's project inputs contribute: one `{ id, mode: 'auto' }`
 * per input of type `project` that was given a value. Reads the state, so
 * it works for every step after `start` — and from `initialData` when the
 * run has no state yet.
 *
 * @param {Object} workflow
 * @param {{data?: Object}|null} state
 * @param {Object} [initialData]
 * @returns {Array<{id: string, mode: 'auto', write: false}>}
 */
export function projectInputLinks(workflow, state, initialData = null) {
  const data = state?.data || initialData || {};
  return projectInputVariables(workflow)
    .map(variable => data[variable.name])
    .filter(value => typeof value === 'string' && value.trim())
    .map(value => ({ id: value.trim(), mode: 'auto', write: false }));
}

/**
 * The project links one step runs with: its own `config.projects`, else the
 * workflow's, plus the run's project inputs. Deduplicated by id; the first
 * mention of an id keeps its mode and write grant.
 *
 * @param {Object} nodeConfig - The step's config.
 * @param {Object} workflow
 * @param {{data?: Object}|null} state
 * @returns {Array<string|Object>}
 */
export function workflowProjectLinks(nodeConfig, workflow, state) {
  const own = Array.isArray(nodeConfig?.projects)
    ? nodeConfig.projects
    : Array.isArray(workflow?.projects)
      ? workflow.projects
      : [];
  const seen = new Set();
  const links = [];
  for (const link of [...own, ...projectInputLinks(workflow, state)]) {
    const id = idOf(link);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    links.push(link);
  }
  return links;
}

/**
 * Check the project inputs of a run before it starts: every input of type
 * `project` that is required or given must name a project the running user
 * may use. Throws a {@link ProjectNodeError} (`INVALID_REF` for a malformed
 * or missing value, `PROJECT_NOT_FOUND` for one the user cannot reach).
 *
 * @param {Object} workflow
 * @param {Object} initialData
 * @param {Object} user
 * @returns {Promise<void>}
 */
export async function assertProjectInputs(workflow, initialData, user) {
  const variables = projectInputVariables(workflow);
  if (!variables.length) return;
  const data = initialData && typeof initialData === 'object' ? initialData : {};
  for (const variable of variables) {
    const value = data[variable.name];
    if (value === undefined || value === null || value === '') {
      if (variable.required)
        throw new ProjectNodeError('INVALID_REF', `Input "${variable.name}" needs a project`, {
          input: variable.name
        });
      continue;
    }
    if (typeof value !== 'string' || !value.trim())
      throw new ProjectNodeError('INVALID_REF', `Input "${variable.name}" must be a project id`, {
        input: variable.name
      });
    const scope = await resolveProjectScope({
      appConfig: { projects: [{ id: value.trim(), mode: 'auto' }] },
      user
    });
    if (!scope.length)
      throw new ProjectNodeError(
        'PROJECT_NOT_FOUND',
        `Project "${value}" is not available to you`,
        { input: variable.name, projectId: value }
      );
  }
}

/**
 * The knowledge context one step reads or writes with.
 *
 * @param {Object} node
 * @param {Object} state
 * @param {Object} context - The engine's execution context.
 * @returns {import('../knowledge/KnowledgeProvider.js').KnowledgeContext}
 */
export function knowledgeContextOf(node, state, context) {
  const type = state?.data?._agentModelConfig ? 'agent' : 'workflow';
  return {
    user: context.user,
    chatId: context.chatId || context.executionId,
    language: context.language,
    purpose: type,
    run: { type, id: String(context.executionId), nodeId: node.id }
  };
}

/**
 * Resolve the project a step names into the project, its provider and what
 * the step may do with it.
 *
 * @param {Object} options
 * @param {Object} options.executor - The executor (for `resolveVariables`).
 * @param {Object} options.node
 * @param {Object} options.state
 * @param {Object} options.context
 * @returns {Promise<{project: Object, provider: Object, link: Object|null,
 *   canWrite: boolean, ctx: Object}>}
 * @throws {ProjectNodeError}
 */
export async function resolveNodeProject({ executor, node, state, context }) {
  const config = node.config || {};
  const raw = executor.resolveVariables(config.project, state);
  const projectId =
    typeof raw === 'string' ? raw.trim() : raw && typeof raw === 'object' ? raw.id : '';
  if (!projectId || typeof projectId !== 'string')
    throw new ProjectNodeError(
      'INVALID_REF',
      `${node.type}: "project" must name a project id (got ${JSON.stringify(config.project)})`
    );
  if (!context.user)
    throw new ProjectNodeError('FORBIDDEN', `${node.type}: the run has no user to act as`);

  const links = workflowProjectLinks(config, context.workflow, state);
  const link = links.map(normalizeProjectLink).find(entry => entry.id === projectId) || null;
  const scope = await resolveProjectScope({
    appConfig: { projects: link ? [link] : [{ id: projectId, mode: 'auto' }] },
    user: context.user
  });
  const entry = scope.find(candidate => candidate.project.id === projectId);
  if (!entry)
    throw new ProjectNodeError(
      'PROJECT_NOT_FOUND',
      `Project "${projectId}" is not available to the running user`,
      { projectId }
    );
  const { project } = entry;
  const provider = providerFor(project);
  // A user project takes writes from its owner and editors; an admin project
  // only through a link that grants `write` (spec 2 §8).
  const canWrite =
    project.ownership === 'user'
      ? Boolean(permissionsFor(project, context.user, callerContext(context.user)).canEdit)
      : Boolean(link?.write);
  return {
    project,
    provider,
    link,
    canWrite: canWrite && provider.capabilities(project).write === true,
    ctx: knowledgeContextOf(node, state, context)
  };
}

/**
 * The error result of a step for a failure, with its code beside the
 * message so the execution view and the audit can tell them apart.
 *
 * @param {Object} executor
 * @param {Object} node
 * @param {Error} error
 * @param {Object} [resolvedInputs]
 */
export function projectNodeFailure(executor, node, error, resolvedInputs) {
  const code = error?.code || 'PROJECT_STEP_FAILED';
  return executor.createErrorResult(`${node.type}: ${error?.message || String(error)}`, {
    nodeId: node.id,
    code,
    ...(error?.details || {}),
    ...(resolvedInputs ? { resolvedInputs } : {})
  });
}
