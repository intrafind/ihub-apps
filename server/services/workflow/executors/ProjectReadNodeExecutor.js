// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Executor for `project-read` steps (#1036, spec 2 §8): one document's text
 * from a project, without a tool call, so a loop body can be a read, a
 * transform and a prompt.
 *
 * Config:
 *   project         a project id or a `$.data…` reference
 *   document        the item id, usually `$.data._loopItem.id` inside a
 *                   `forEach` over a `project-items` list
 *   section         optional heading or section id to read instead of the
 *                   whole document
 *   maxChars        optional budget; the provider's default otherwise
 *   outputVariable  state key for the result (default `_projectDocument`)
 *
 * Output: `{ project, document, name, text, chars, retrieval, doc }`.
 *
 * A document longer than the budget is never passed on as its outline: the
 * step fails with `SECTION_REQUIRED` (no `section` given) or
 * `SECTION_NOT_FOUND` (the `section` is not in the document), so a loop that
 * summarizes each document cannot store a summary of an outline instead.
 *
 * @module services/workflow/executors/ProjectReadNodeExecutor
 */
import { BaseNodeExecutor } from './BaseNodeExecutor.js';
import { ProjectNodeError, projectNodeFailure, resolveNodeProject } from '../projectNodes.js';

export class ProjectReadNodeExecutor extends BaseNodeExecutor {
  async execute(node, state, context) {
    const config = node.config || {};
    const outputVariable = config.outputVariable || '_projectDocument';
    const rawDocument = this.resolveVariables(config.document, state);
    const documentId =
      typeof rawDocument === 'string'
        ? rawDocument.trim()
        : rawDocument && typeof rawDocument === 'object'
          ? String(rawDocument.id || '')
          : '';
    const section =
      typeof config.section === 'string' && config.section.trim()
        ? String(this.resolveVariables(config.section, state) || '').trim() || undefined
        : undefined;
    const maxChars = Number(config.maxChars) > 0 ? Number(config.maxChars) : undefined;
    let resolvedInputs = { project: config.project, document: documentId, section };
    try {
      if (!documentId)
        throw new ProjectNodeError(
          'INVALID_REF',
          `"document" must name an item id (got ${JSON.stringify(config.document)})`
        );
      const { project, provider, ctx } = await resolveNodeProject({
        executor: this,
        node,
        state,
        context
      });
      resolvedInputs = { ...resolvedInputs, project: project.id };
      const result = await provider.read(
        project,
        ctx,
        { itemId: documentId },
        { section, ...(maxChars ? { budgetChars: maxChars } : {}) }
      );
      // Over the budget without a usable section, the provider answers with
      // the document's outline: that is not the document's content.
      if (result.retrieval?.mode === 'outline') {
        const budget = maxChars ? `the read budget of ${maxChars} characters` : 'the read budget';
        throw new ProjectNodeError(
          section ? 'SECTION_NOT_FOUND' : 'SECTION_REQUIRED',
          section
            ? `Document "${result.doc.name}" has no section "${section}", and the whole document is over ${budget}`
            : `Document "${result.doc.name}" is over ${budget}: name a "section" to read, or raise "maxChars"`,
          {
            projectId: project.id,
            itemId: documentId,
            totalSections: result.retrieval.totalSections,
            totalTokens: result.retrieval.totalTokens
          }
        );
      }
      const output = {
        project: project.id,
        document: documentId,
        name: result.doc.name,
        text: result.text,
        chars: result.text.length,
        retrieval: result.retrieval,
        doc: result.doc
      };
      return this.createSuccessResult(output, {
        stateUpdates: { [outputVariable]: output },
        resolvedInputs
      });
    } catch (error) {
      return projectNodeFailure(this, node, error, resolvedInputs);
    }
  }
}

export default ProjectReadNodeExecutor;
