/**
 * Executor for `inbox-load` nodes — deterministic inbox read.
 *
 * Reads the bound inbox via inboxStore, picks the highest-priority open
 * item, and writes it to `state.data.currentInboxItem`. Emits the
 * `agent.inbox.read` SSE event so the live tape shows what the runtime
 * loaded.
 *
 * NO LLM call is made. This replaces the previous `prompt`-type orchestrator
 * node that asked the LLM to "Call read_inbox to load all open items, pick
 * the single highest-priority open item" — which was deterministic work
 * dressed up as LLM agency and led to hallucinated tool calls.
 *
 * If no open items are available, the node emits `agent.inbox.empty` and
 * returns an `isTerminal: true` result so the engine routes the workflow
 * straight to `end` without invoking the planner.
 *
 * @module services/workflow/executors/InboxLoadNodeExecutor
 */

import { BaseNodeExecutor } from './BaseNodeExecutor.js';
import inboxStore from '../../../agents/inbox/inboxStore.js';
import { actionTracker } from '../../../actionTracker.js';
import { previewToolValue } from './valuePreview.js';

const PRIORITY_RANK = { p1: 1, p2: 2, p3: 3, unprioritized: 4 };

function pickTopItem(items) {
  const open = items.filter(i => i.status === 'open');
  if (open.length === 0) return null;
  // Stable sort: by priority rank, then by source line order (lower = earlier).
  const sorted = [...open].sort((a, b) => {
    const ra = PRIORITY_RANK[a.priority] ?? 5;
    const rb = PRIORITY_RANK[b.priority] ?? 5;
    if (ra !== rb) return ra - rb;
    return (a.line ?? 0) - (b.line ?? 0);
  });
  return sorted[0];
}

function emit(event, payload, chatId) {
  try {
    actionTracker.emit('fire-sse', { event, chatId, ...payload });
  } catch {
    // Best effort — never fail a node because of an SSE emit.
  }
}

export class InboxLoadNodeExecutor extends BaseNodeExecutor {
  async execute(node, state, context) {
    const startedAt = new Date();
    const startMs = startedAt.getTime();
    const config = node.config || {};
    const inboxId = config.inboxId || state?.data?._agentProfile?.inboxId || context?.user?.inboxId;

    if (!inboxId) {
      return this.createErrorResult(
        `inbox-load node '${node.id}' has no inboxId (config.inboxId, state.data._agentProfile.inboxId, and context.user.inboxId all unset)`,
        { nodeId: node.id }
      );
    }

    const chatId = context?.chatId || state?.executionId;
    const profileId = context?.user?.profileId;

    let inbox;
    try {
      inbox = await inboxStore.readInbox(inboxId, { status: 'all' });
    } catch (err) {
      this.logger.error('inbox-load failed', {
        component: 'InboxLoadNodeExecutor',
        nodeId: node.id,
        inboxId,
        error: err.message
      });
      return this.createErrorResult(`Failed to read inbox '${inboxId}': ${err.message}`, {
        nodeId: node.id
      });
    }

    const top = pickTopItem(inbox.items);

    if (!top) {
      emit('agent.inbox.empty', { inboxId, profileId, total: inbox.items.length }, chatId);
      this.logger.info('inbox-load: no open items, terminating workflow', {
        component: 'InboxLoadNodeExecutor',
        nodeId: node.id,
        inboxId,
        totalItems: inbox.items.length
      });
      return this.createSuccessResult(
        {
          inboxId,
          version: inbox.version,
          totalItems: inbox.items.length,
          openItems: 0,
          message: 'No open items to process'
        },
        {
          stateUpdates: {
            currentInboxItem: null,
            _inboxEmpty: true
          },
          isTerminal: true
        }
      );
    }

    const currentInboxItem = {
      id: `line-${top.line}`,
      line: top.line,
      text: top.text,
      priority: top.priority,
      raw: top.raw
    };

    emit(
      'agent.inbox.read',
      {
        inboxId,
        profileId,
        count: inbox.items.length,
        openCount: inbox.items.filter(i => i.status === 'open').length,
        picked: { text: top.text, priority: top.priority, line: top.line }
      },
      chatId
    );

    this.logger.info('inbox-load picked top item', {
      component: 'InboxLoadNodeExecutor',
      nodeId: node.id,
      inboxId,
      priority: top.priority,
      line: top.line
    });

    const completedAtIso = new Date().toISOString();
    const durationMs = Date.now() - startMs;
    try {
      actionTracker.emit('fire-sse', {
        event: 'agent.step.completed',
        chatId,
        nodeId: node.id,
        kind: 'inbox-load',
        startedAt: startedAt.toISOString(),
        completedAt: completedAtIso,
        durationMs
      });
    } catch {
      // best effort
    }
    const stepLog = {
      nodeId: node.id,
      kind: 'inbox-load',
      startedAt: startedAt.toISOString(),
      completedAt: completedAtIso,
      durationMs,
      // No LLM here — this is a deterministic step. Show the operator
      // what was read and what was picked.
      tools: [{ id: 'inbox-store.readInbox', description: 'Deterministic inbox file read' }],
      toolCalls: [
        {
          name: 'inbox-store.readInbox',
          args: previewToolValue({ inboxId, status: 'all' }),
          result: previewToolValue({
            inboxId,
            version: inbox.version,
            totalItems: inbox.items.length,
            picked: { text: top.text, priority: top.priority, line: top.line }
          }),
          durationMs
        }
      ],
      messages: []
    };
    const stateUpdates = {
      currentInboxItem,
      _inboxMeta: {
        inboxId,
        version: inbox.version
      },
      // Record a timing entry so the UI step timeline can show the
      // inbox-load step alongside the LLM tasks. Deterministic nodes
      // are usually <50ms, so this is mostly for completeness.
      _taskTimings: {
        ...(state?.data?._taskTimings || {}),
        [node.id]: {
          startedAt: startedAt.toISOString(),
          completedAt: completedAtIso,
          durationMs
        }
      },
      _stepLogs: {
        ...(state?.data?._stepLogs || {}),
        [node.id]: stepLog
      }
    };

    return this.createSuccessResult(currentInboxItem, { stateUpdates });
  }
}

export default InboxLoadNodeExecutor;
