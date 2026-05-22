/**
 * Executor for `inbox-finalize` nodes — deterministic inbox lifecycle close.
 *
 * Marks the inbox item that was loaded by an earlier `inbox-load` node as
 * done. Reads `state.data.currentInboxItem` and calls
 * `inboxStore.markInboxItemDone()` directly. Emits `agent.inbox.marked_done`.
 *
 * NO LLM call is made. This replaces the previous `prompt`-type orchestrator
 * node that asked the LLM to "Call write_inbox(mode='markDone')" — which
 * was deterministic work dressed up as LLM agency and produced ambiguous
 * tool-call args (e.g. wrong item text) that occasionally marked the wrong
 * item or duplicated the inbox mutation.
 *
 * Failure modes:
 *   - currentInboxItem missing  → log warning, return success with isNoop
 *   - inboxId missing            → return failure
 *   - item not found / already done → log warning, return success (race-tolerant)
 *
 * @module services/workflow/executors/InboxFinalizeNodeExecutor
 */

import { BaseNodeExecutor } from './BaseNodeExecutor.js';
import inboxStore from '../../../agents/inbox/inboxStore.js';
import { actionTracker } from '../../../actionTracker.js';

function emit(event, payload, chatId) {
  try {
    actionTracker.emit('fire-sse', { event, chatId, ...payload });
  } catch {
    // Best effort — never fail a node because of an SSE emit.
  }
}

function truncateForNote(value) {
  if (typeof value !== 'string') return undefined;
  const clean = value.replace(/\s+/g, ' ').trim();
  if (!clean) return undefined;
  return clean.length > 120 ? `${clean.slice(0, 117)}...` : clean;
}

export class InboxFinalizeNodeExecutor extends BaseNodeExecutor {
  async execute(node, state, context) {
    const startedAt = new Date();
    const startMs = startedAt.getTime();
    const config = node.config || {};
    const inboxId =
      config.inboxId || state?.data?._inboxMeta?.inboxId || state?.data?._agentProfile?.inboxId;

    if (!inboxId) {
      return this.createErrorResult(
        `inbox-finalize node '${node.id}' has no inboxId (config.inboxId / state._inboxMeta / state._agentProfile all unset)`,
        { nodeId: node.id }
      );
    }

    const chatId = context?.chatId || state?.executionId;
    const profileId = context?.user?.profileId;
    const item = state?.data?.currentInboxItem;

    if (!item || typeof item !== 'object' || !item.text) {
      this.logger.warn('inbox-finalize: no currentInboxItem in state, nothing to mark done', {
        component: 'InboxFinalizeNodeExecutor',
        nodeId: node.id,
        inboxId
      });
      return this.createSuccessResult({ ok: true, noop: true, reason: 'no current item' });
    }

    // Compose a short completion note from the synthesizer output or report
    // contents so the inbox line shows progress for the human reader.
    const note =
      truncateForNote(state?.data?._synthesizerSummary) ||
      truncateForNote(state?.data?._synthesizerOutput) ||
      undefined;

    try {
      const result = await inboxStore.markInboxItemDone(inboxId, {
        text: item.text,
        note,
        updatedBy: context?.user?.id || `agent:${profileId || 'unknown'}`
      });
      emit(
        'agent.inbox.marked_done',
        { inboxId, profileId, version: result.version, item: item.text },
        chatId
      );
      this.logger.info('inbox-finalize: marked item done', {
        component: 'InboxFinalizeNodeExecutor',
        nodeId: node.id,
        inboxId,
        item: item.text,
        version: result.version
      });
      const completedAtIso = new Date().toISOString();
      const durationMs = Date.now() - startMs;
      try {
        actionTracker.emit('fire-sse', {
          event: 'agent.step.completed',
          chatId,
          nodeId: node.id,
          kind: 'inbox-finalize',
          startedAt: startedAt.toISOString(),
          completedAt: completedAtIso,
          durationMs
        });
      } catch {
        // best effort
      }
      const stepLog = {
        nodeId: node.id,
        kind: 'inbox-finalize',
        startedAt: startedAt.toISOString(),
        completedAt: completedAtIso,
        durationMs,
        tools: [
          { id: 'inbox-store.markInboxItemDone', description: 'Deterministic inbox markDone' }
        ],
        toolCalls: [
          {
            name: 'inbox-store.markInboxItemDone',
            args: this._previewToolValue({ inboxId, item: item.text, note }),
            result: this._previewToolValue({ ok: true, version: result.version }),
            durationMs
          }
        ],
        messages: []
      };
      return this.createSuccessResult(
        { ok: true, inboxId, version: result.version, item: item.text },
        {
          stateUpdates: {
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
          }
        }
      );
    } catch (err) {
      // Race-tolerant: NOT_FOUND means another run already marked it.
      if (err.code === 'NOT_FOUND') {
        this.logger.warn('inbox-finalize: item already marked done elsewhere', {
          component: 'InboxFinalizeNodeExecutor',
          nodeId: node.id,
          inboxId,
          item: item.text
        });
        emit(
          'agent.inbox.marked_done',
          { inboxId, profileId, item: item.text, alreadyDone: true },
          chatId
        );
        return this.createSuccessResult({
          ok: true,
          inboxId,
          item: item.text,
          alreadyDone: true
        });
      }
      this.logger.error('inbox-finalize failed', {
        component: 'InboxFinalizeNodeExecutor',
        nodeId: node.id,
        inboxId,
        error: err.message
      });
      return this.createErrorResult(`Failed to mark inbox item done: ${err.message}`, {
        nodeId: node.id
      });
    }
  }

  _previewToolValue(value) {
    try {
      const json = JSON.stringify(value);
      return json.length > 1024 ? `${json.slice(0, 1024)}…` : json;
    } catch {
      return null;
    }
  }
}

export default InboxFinalizeNodeExecutor;
