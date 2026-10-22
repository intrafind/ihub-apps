// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Executor for `project-items` steps (#1036, spec 2 §8): the documents of a
 * project as a `KnowledgeDoc[]` in workflow state, so a `forEach` loop can
 * iterate them one document per round and read each with `project-read`.
 *
 * Config:
 *   project         a project id, or a `$.data…` reference to one (such as a
 *                   workflow input of type `project`)
 *   filter          `{ kinds?: string[], status?: string[], pinned?: boolean,
 *                     origin?: string[] }`; `status` defaults to the usable
 *                   states (`ready`, `stale`)
 *   limit           at most this many documents (default 500, the loop cap)
 *   outputVariable  state key for the list (default `_projectItems`)
 *
 * Output: `{ project, name, count, total, documents }`.
 *
 * @module services/workflow/executors/ProjectItemsNodeExecutor
 */
import { BaseNodeExecutor } from './BaseNodeExecutor.js';
import { projectNodeFailure, resolveNodeProject } from '../projectNodes.js';
import { projectName } from '../../projects/projectView.js';

const DEFAULT_STATUS = Object.freeze(['ready', 'stale']);
const DEFAULT_LIMIT = 500;
const PAGE = 100;

function list(value) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return null;
}

/**
 * Whether a document passes the step's filter.
 *
 * @param {Object} doc - KnowledgeDoc
 * @param {Object} filter
 * @returns {boolean}
 */
export function matchesFilter(doc, filter = {}) {
  const kinds = list(filter.kinds);
  const status = list(filter.status) || DEFAULT_STATUS;
  const origins = list(filter.origin);
  if (kinds && !kinds.includes(doc.kind)) return false;
  if (status.length && !status.includes(doc.status)) return false;
  if (typeof filter.pinned === 'boolean' && doc.pinned !== filter.pinned) return false;
  return !origins || origins.includes(doc.provenance?.origin || 'linked');
}

export class ProjectItemsNodeExecutor extends BaseNodeExecutor {
  async execute(node, state, context) {
    const config = node.config || {};
    const outputVariable = config.outputVariable || '_projectItems';
    const filter = this.resolveVariables(config.filter || {}, state) || {};
    const limit = Math.max(1, Math.min(DEFAULT_LIMIT, Number(config.limit) || DEFAULT_LIMIT));
    let resolvedInputs = { project: config.project, filter, limit };
    try {
      const { project, provider, ctx } = await resolveNodeProject({
        executor: this,
        node,
        state,
        context
      });
      resolvedInputs = { ...resolvedInputs, project: project.id };
      const documents = [];
      let total = 0;
      let cursor = null;
      do {
        const page = await provider.list(project, ctx, { cursor, limit: PAGE });
        total += page.items.length;
        for (const doc of page.items) {
          if (documents.length < limit && matchesFilter(doc, filter)) documents.push(doc);
        }
        cursor = page.nextCursor;
      } while (cursor && documents.length < limit);
      const output = {
        project: project.id,
        name: projectName(project, context.language),
        count: documents.length,
        total,
        documents
      };
      this.logger.info('Project items listed', {
        component: 'ProjectItemsNodeExecutor',
        nodeId: node.id,
        projectId: project.id,
        count: documents.length,
        total
      });
      return this.createSuccessResult(output, {
        stateUpdates: { [outputVariable]: documents },
        resolvedInputs
      });
    } catch (error) {
      return projectNodeFailure(this, node, error, resolvedInputs);
    }
  }
}

export default ProjectItemsNodeExecutor;
