/**
 * Executor for `template-render` workflow nodes.
 *
 * Renders a workflow-author template into Markdown and persists the result
 * as a run artifact via the existing artifact store. The default state-key
 * reads (`_evidence`, `_coverage`, `_synthesis`) reflect this node's first
 * concrete consumer (the audit-evidence workflows); each is configurable so
 * non-audit workflows can wire their own aggregation keys.
 *
 * Template syntax matches `{{var}}` / `{{#each}}` / `{{#if}}` so authors
 * have the same mental model as in prompt templates. See
 * `services/templating/renderTemplate.js` for the supported subset.
 *
 * Disk layout: `contents/data/agent-artifacts/{runId}/{artifactName}`.
 * Sub-directory support is a separate change to `artifactStore.safeArtifactName`.
 *
 * @module services/workflow/executors/TemplateRenderNodeExecutor
 */

import { BaseNodeExecutor } from './BaseNodeExecutor.js';
import { composeReport } from '../../templating/composeReport.js';
import { writeArtifactDirect } from '../../../agents/runtime/artifactStore.js';
import { actionTracker } from '../../../actionTracker.js';

const FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class TemplateRenderNodeExecutor extends BaseNodeExecutor {
  async execute(node, state, context) {
    const config = node.config || {};
    const {
      evidenceVar = '_evidence',
      coverageVar = '_coverage',
      synthesisVar = '_synthesis',
      template,
      artifactName = 'final-report.md',
      reportVar = '_report'
    } = config;

    if (!FILENAME_RE.test(artifactName)) {
      return this.createErrorResult(
        `template-render: invalid artifactName '${artifactName}' ` +
          `(must match ${FILENAME_RE}; sub-directories are not yet supported by artifactStore)`,
        { nodeId: node.id }
      );
    }

    const evidence = this.resolveVariable(`$.data.${evidenceVar}`, state) || [];
    const coverage = this.resolveVariable(`$.data.${coverageVar}`, state);
    const synthesis = this.resolveVariable(`$.data.${synthesisVar}`, state);

    const runId =
      context?.runId ||
      context?.executionId ||
      state?.metadata?.runId ||
      state?.metadata?.executionId;

    const { markdown, bytes } = composeReport({
      evidence: Array.isArray(evidence) ? evidence : [],
      coverage,
      synthesis: typeof synthesis === 'string' ? synthesis : '',
      template,
      extra: {
        runId: runId || '',
        workflowId: state?.metadata?.workflowId || '',
        generatedAt: new Date().toISOString()
      }
    });

    let artifactPath = null;
    if (runId) {
      try {
        const result = await writeArtifactDirect({
          runId,
          name: artifactName,
          content: markdown,
          contentType: 'text/markdown',
          chatId: context?.chatId || runId,
          state
        });
        artifactPath = result.path;
      } catch (err) {
        this.logger.warn('template-render: artifact persistence failed', {
          component: 'TemplateRenderNodeExecutor',
          nodeId: node.id,
          error: err.message
        });
        // Non-fatal: the report is still available in state[reportVar] for
        // the workflow's `end` node to surface as final output.
      }
    } else {
      this.logger.warn('template-render: no runId in context; skipping artifact write', {
        component: 'TemplateRenderNodeExecutor',
        nodeId: node.id
      });
    }

    this.logger.info('template-render complete', {
      component: 'TemplateRenderNodeExecutor',
      nodeId: node.id,
      bytes,
      artifactPath,
      evidenceCount: Array.isArray(evidence) ? evidence.length : 0
    });

    // Emit workflow.node.progress keyed by executionId so the workflowRunner
    // bridge can re-emit on the chat's real chatId.
    const executionId =
      context?.executionId || context?.runId || context?.chatId;
    if (executionId) {
      try {
        // chatId must equal executionId — workflowRunner bridge filters on it.
        actionTracker.emit('fire-sse', {
          event: 'workflow.node.progress',
          chatId: executionId,
          executionId,
          message: `Report written: ${artifactName} (${Math.round(bytes / 1024)} KB)`
        });
      } catch {
        /* best-effort */
      }
    }

    return this.createSuccessResult(
      {
        bytes,
        artifactName: artifactPath ? artifactName : null,
        artifactPath
      },
      {
        stateUpdates: {
          [reportVar]: {
            markdown,
            bytes,
            artifactName: artifactPath ? artifactName : null,
            generatedAt: new Date().toISOString()
          }
        }
      }
    );
  }
}

export default TemplateRenderNodeExecutor;
