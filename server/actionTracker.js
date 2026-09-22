/**
 * Internal event bus for workflow and agent runtime events.
 *
 * Producers (WorkflowEngine, node executors, agent tools) emit
 * `actionTracker.emit('fire-sse', { event, chatId, ...payload })` where
 * `event` is an internal name (`workflow.node.start`, `agent.task.created`, …)
 * and `chatId` is the execution id the event belongs to. Consumers are the
 * run-scoped stream endpoints (`routes/workflow/workflowRoutes.js`,
 * `routes/agents/runs.js`) and the chat bridge (`tools/workflowRunner.js`),
 * which translate these events onto SSE v2 envelopes
 * (`services/loop/RunStream.js`). Nothing on this bus reaches a client
 * verbatim — the wire dialect is SSE v2 only.
 */
import { EventEmitter } from 'events';

export class ActionTracker extends EventEmitter {
  constructor() {
    super();
    // Every listener is request/connection-scoped and pairs its on() with an
    // off() in a cleanup path, so concurrent runs legitimately exceed the
    // default 10-listener warning threshold without leaking.
    this.setMaxListeners(0);
  }
}

export const actionTracker = new ActionTracker();
