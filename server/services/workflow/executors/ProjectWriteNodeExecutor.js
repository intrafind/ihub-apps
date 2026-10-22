// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Executor for `project-write` steps (#1036, spec 2 §8): store a text the
 * run produced as a document of a project, with provenance
 * `{ origin: 'written', run: { type, id: executionId, nodeId } }`.
 *
 * Allowed when the running user owns or edits a user project, or when the
 * workflow's link to an admin project carries `write: true`. There is no
 * chat tool for this on purpose: a write into a shared project happens in
 * an explicit step the author placed, never in a model's tool call.
 *
 * Config:
 *   project         a project id or a `$.data…` reference
 *   name            the document name; `$.data…` references and `{{…}}`
 *                   templates over the state are resolved (`{{item.name}}`
 *                   is the current loop item)
 *   text            the text, resolved the same way (usually `$.data.<var>`)
 *   contentType     default `text/markdown`
 *   pinned          default false
 *   wait            wait for the document to be ready (default true), so a
 *                   later step of the run can read it
 *   outputVariable  state key for the stored document (default `_writtenDocument`)
 *
 * Output: the stored `KnowledgeDoc`.
 *
 * @module services/workflow/executors/ProjectWriteNodeExecutor
 */
import { BaseNodeExecutor } from './BaseNodeExecutor.js';
import { ProjectNodeError, projectNodeFailure, resolveNodeProject } from '../projectNodes.js';
import { renderTemplate } from '../../templating/renderTemplate.js';

const MAX_NAME = 300;

function asText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}

export class ProjectWriteNodeExecutor extends BaseNodeExecutor {
  /**
   * Resolve a config value: `$.data…` references first, then `{{…}}`
   * templates against the state's data with `item` as the loop item.
   */
  render(value, state) {
    const resolved = this.resolveVariables(value, state);
    if (typeof resolved !== 'string' || !resolved.includes('{{')) return resolved;
    const data = state?.data || {};
    return renderTemplate(resolved, { ...data, item: data.item ?? data._loopItem ?? null });
  }

  async execute(node, state, context) {
    const config = node.config || {};
    const outputVariable = config.outputVariable || '_writtenDocument';
    const name = asText(this.render(config.name, state)).trim().slice(0, MAX_NAME);
    const text = asText(this.render(config.text, state));
    const contentType =
      typeof config.contentType === 'string' && config.contentType.trim()
        ? config.contentType.trim()
        : 'text/markdown';
    const pinned = config.pinned === true;
    const wait = config.wait !== false;
    let resolvedInputs = { project: config.project, name, contentType, pinned, chars: text.length };
    try {
      if (!name) throw new ProjectNodeError('INVALID_REF', '"name" resolved to an empty value');
      if (!text.trim())
        throw new ProjectNodeError('INVALID_REF', '"text" resolved to an empty value');
      const { project, provider, ctx, canWrite } = await resolveNodeProject({
        executor: this,
        node,
        state,
        context
      });
      resolvedInputs = { ...resolvedInputs, project: project.id };
      if (!canWrite)
        throw new ProjectNodeError(
          'FORBIDDEN',
          project.ownership === 'admin'
            ? `The workflow's link to project "${project.id}" does not grant writes`
            : `The running user may not write to project "${project.id}"`,
          { projectId: project.id }
        );
      const doc = await provider.put(project, ctx, { name, text, contentType, pinned, wait });
      this.logger.info('Project document written', {
        component: 'ProjectWriteNodeExecutor',
        nodeId: node.id,
        projectId: project.id,
        itemId: doc.id,
        chars: text.length
      });
      return this.createSuccessResult(doc, {
        stateUpdates: { [outputVariable]: doc },
        resolvedInputs
      });
    } catch (error) {
      return projectNodeFailure(this, node, error, resolvedInputs);
    }
  }
}

export default ProjectWriteNodeExecutor;
