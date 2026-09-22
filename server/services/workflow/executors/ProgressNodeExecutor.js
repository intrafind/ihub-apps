/**
 * Executor for `progress` workflow nodes.
 *
 * A zero-cost node that emits a `workflow.node.progress` event with a
 * configured message. Designed to be placed inside loop bodies (before
 * long-running prompt nodes) so the chat shows each iteration as its own
 * step rather than letting the parent loop's single start/complete pair
 * mask all internal activity.
 *
 * The message supports the same {{var}} / {{path.to.value}} interpolation
 * that other prompt templates use; it resolves against `state.data`.
 *
 * @module services/workflow/executors/ProgressNodeExecutor
 */

import { BaseNodeExecutor } from './BaseNodeExecutor.js';
import { resolveProgressTemplate, emitProgressMessage } from '../nodeProgress.js';

export class ProgressNodeExecutor extends BaseNodeExecutor {
  async execute(node, state, context) {
    const messageTemplate = (node.config && (node.config.message || node.config.progress)) || '';
    const resolved = resolveProgressTemplate(messageTemplate, state?.data || {}, context?.language);
    // Default to 'running' so the chat client's step lifecycle works: when
    // the next iteration emits its own running step, the chat client marks
    // this one as completed automatically. That gives ONE step per doc
    // instead of a separate start + done pair.
    const status = (node.config && node.config.status) || 'running';

    emitProgressMessage({
      message: resolved,
      nodeId: node?.id,
      executionId: context?.executionId || context?.runId || context?.chatId,
      status
    });

    return this.createSuccessResult({ message: resolved });
  }
}

export default ProgressNodeExecutor;
