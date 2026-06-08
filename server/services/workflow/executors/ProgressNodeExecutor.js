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
import { actionTracker } from '../../../actionTracker.js';

export class ProgressNodeExecutor extends BaseNodeExecutor {
  async execute(node, state, context) {
    const messageTemplate = (node.config && (node.config.message || node.config.progress)) || '';
    const resolved = resolveTemplate(messageTemplate, state?.data || {});
    // Default to 'running' so the chat client's step lifecycle works: when
    // the next iteration emits its own running step, the chat client marks
    // this one as completed automatically. That gives ONE step per doc
    // instead of a separate start + done pair.
    const status = (node.config && node.config.status) || 'running';

    const executionId = context?.executionId || context?.runId || context?.chatId;
    if (executionId && resolved) {
      try {
        actionTracker.emit('fire-sse', {
          event: 'workflow.node.progress',
          chatId: executionId,
          executionId,
          nodeId: node?.id,
          status,
          message: resolved
        });
      } catch {
        /* best-effort */
      }
    }

    return this.createSuccessResult({ message: resolved });
  }
}

function resolveTemplate(template, data) {
  if (typeof template !== 'string' || !template) return '';
  return template.replace(/\{\{\s*([a-zA-Z0-9_.[\]]+)\s*\}\}/g, (_match, path) => {
    const value = getNested(path, data);
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') {
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    }
    return String(value);
  });
}

function getNested(path, obj) {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[p];
  }
  return cur;
}

export default ProgressNodeExecutor;
