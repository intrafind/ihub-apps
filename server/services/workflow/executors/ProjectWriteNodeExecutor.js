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
 *   name            the document name: a whole `$.data…` reference is used
 *                   verbatim; otherwise a `{{…}}` template over the state
 *                   (`{{item.name}}` is the current loop item) or a text
 *                   with embedded `${$.data…}` references
 *   text            the text, resolved the same way (usually `$.data.<var>`)
 *   contentType     default `text/markdown`
 *   pinned          default false
 *   wait            wait for the document to be ready (default true), so a
 *                   later step of the run can read it; `false` stores it
 *                   `pending` and moves on
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
   * Resolve a config value. A whole `$.…` reference returns the state's
   * value verbatim: a text that came out of the run is data, never another
   * template. Only a string written in the config is a template — `{{…}}`
   * against the state's data with `item` as the loop item, whose inserted
   * values stay verbatim (never rendered again) — or, without
   * `{{`, a text with embedded `${$.…}` references.
   *
   * @param {*} value - The configured value.
   * @param {Object} state
   * @returns {*}
   */
  render(value, state) {
    if (typeof value !== 'string') return this.resolveVariables(value, state);
    if (value.startsWith('$.')) return this.resolveVariable(value, state);
    if (!value.includes('{{')) return this.resolveVariables(value, state);
    const data = state?.data || {};
    // Opaque: a value the template pulls in is inserted verbatim and never
    // scanned again, so a run text holding `{{…}}` cannot reach other state.
    return renderTemplate(
      value,
      { ...data, item: data.item ?? data._loopItem ?? null },
      { opaqueValues: true }
    );
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
      const { project, provider, ctx, canWrite, authorizeWrite } = await resolveNodeProject({
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
      // The rule is checked again on the current project under the write's
      // lock: an editor removed since `canWrite` was computed adds nothing.
      const doc = await provider.put(project, ctx, {
        name,
        text,
        contentType,
        pinned,
        wait,
        authorize: authorizeWrite
      });
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
