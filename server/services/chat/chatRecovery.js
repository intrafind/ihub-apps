/**
 * Chats whose turn died with its process.
 *
 * A turn's answer is written by the process running it, when the run ends
 * (`chatMaterializer.materializeAssistantTurn`). A restart, a crash or a
 * deploy in the middle of a turn — a long workflow is the likely victim —
 * leaves the chat `running` with an `activeRunId` nothing will ever release:
 * the history keeps listing it as running, and opening it re-attaches to a run
 * that sends nothing, so the placeholder spins until the user gives up. The
 * user coming back can not tell what happened, or whether anything did.
 *
 * {@link settleInterruptedChat} closes such a chat out when it is read: it
 * stores an answer that says the turn was interrupted, with whatever the
 * run's ledger still knows of what it did (the tool calls it made and what
 * they found, see `runActivity.rebuildRunActivity`), ends the run on the ledger
 * so the audit trail says so too, and releases the chat.
 *
 * "Died" has to be certain, because settling a live turn would store a false
 * answer in front of the real one. A run is alive while any worker still holds
 * it: the ledger run is open here or owned by another worker, a chat request
 * or durable turn is in flight for the chat, or a workflow bridged to it is
 * running. A turn that has only just claimed the chat is given a grace period,
 * because it claims the chat before it opens its ledger run.
 *
 * @module services/chat/chatRecovery
 */
import { RUN_LOG_EVENTS } from '../../../shared/runEvents.js';
import defaultRunLog, { RUN_PRESENCE_KIND } from '../loop/RunLog.js';
import { hasRemote } from '../../clusterBus.js';
import { hasActiveChatRequest, isChatDurable } from '../../sse.js';
import { activeWorkflowExecutions } from '../../tools/workflowRunner.js';
import { getExecutionRegistry } from '../workflow/ExecutionRegistry.js';
import { getWorkflowEngine } from '../workflow/WorkflowEngine.js';
import { executionHandoff } from '../workflow/executionChat.js';
import { settleAssistantTurn } from './chatMaterializer.js';
import { rebuildRunActivity } from './runActivity.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'chatRecovery';

/** How long after a turn claimed its chat it is presumed alive regardless. */
export const INTERRUPTED_RUN_GRACE_MS = 2 * 60 * 1000;

/** Error code of the answer stored for an interrupted turn. */
export const RUN_INTERRUPTED = 'RUN_INTERRUPTED';

const INTERRUPTED_MESSAGE =
  'This answer was interrupted: the server stopped while it was being produced.';

/** Settles in progress in this process, so concurrent reads settle a chat once. */
const settling = new Map();

/**
 * Whether anything, anywhere, still holds the chat's active run.
 *
 * @param {Object} chat - Chat document.
 * @param {Object} [deps]
 * @param {Object} [deps.runLog] - RunLog.
 * @param {number} [deps.now] - Current time (ms).
 * @returns {boolean}
 */
export function isChatRunAlive(chat, { runLog = defaultRunLog, now = Date.now() } = {}) {
  const runId = chat?.activeRunId;
  if (!runId) return false;
  // The later of the two: `runClaimedAt` is only written by the Responses API
  // and never cleared, so on a chat that API once used it can be far older
  // than the turn now running, which the UI claims by appending its question.
  const claimed = Math.max(
    Date.parse(chat.runClaimedAt || '') || 0,
    Date.parse(chat.lastMessageAt || '') || 0
  );
  if (!claimed || now - claimed < INTERRUPTED_RUN_GRACE_MS) return true;
  // Known to this worker's ledger — running, or ended within the last minute
  // (the ledger keeps a finished run that long). The second case matters: a
  // run's answer is stored just *after* its ledger ends, and the client reloads
  // the chat list the moment it sees the end, so a finished run would
  // otherwise be settled as interrupted in the gap before its own answer lands.
  if (runLog.getRunMeta(runId)) return true;
  // Held by another worker (the owner's presence outlives the end the same way).
  if (hasRemote(RUN_PRESENCE_KIND, runId)) return true;
  if (hasActiveChatRequest(chat.id) || isChatDurable(chat.id)) return true;
  if (activeWorkflowExecutions.has(chat.id) || hasRemote('workflow', chat.id)) return true;
  return false;
}

/**
 * The workflow execution behind a chat run, for an `@workflow` turn (whose run
 * id is the execution id), or null for an ordinary turn.
 */
async function executionOf(runId) {
  try {
    return (await getExecutionRegistry().get(runId)) || null;
  } catch {
    return null;
  }
}

/** The answer a completed execution gave, read from its state. */
async function executionAnswer(runId) {
  try {
    const state = await getWorkflowEngine().getState(runId);
    return state ? executionHandoff(state) : null;
  } catch {
    return null;
  }
}

/**
 * How a dead run is closed: the answer to store, and whether the run ends on
 * the ledger. An ordinary turn was interrupted. An `@workflow` turn is closed
 * by what its execution says it is — the execution outlives the chat bridge
 * that died with the process:
 *
 * - paused at a human checkpoint: still resumable from its execution page, so
 *   the chat says so and its run stays open;
 * - completed: its answer is delivered from the execution;
 * - cancelled: stored as a stopped turn;
 * - anything else: interrupted, and an execution left running is marked
 *   failed so "My Executions" stops listing it as running.
 *
 * @returns {Promise<{summary: Object, endRun: Object|null}>}
 */
async function closingTurn(runId, runLog) {
  const activity = (await rebuildRunActivity(runLog, runId)) || {};
  const interrupted = {
    status: 'error',
    finishReason: 'error',
    error: { code: RUN_INTERRUPTED, message: INTERRUPTED_MESSAGE }
  };
  const execution = await executionOf(runId);
  if (!execution) {
    return {
      summary: {
        status: 'error',
        content: '',
        finishReason: 'error',
        errorInfo: interrupted.error,
        activity
      },
      endRun: interrupted
    };
  }

  const result = status => ({
    status,
    executionId: runId,
    workflowName: execution.workflowName
  });
  switch (execution.status) {
    case 'paused':
      return {
        summary: {
          status: 'success',
          content: '',
          finishReason: 'paused',
          activity: { ...activity, workflowResult: result('paused') }
        },
        endRun: null
      };
    case 'completed':
    case 'approved': {
      const handoff = await executionAnswer(runId);
      return {
        summary: {
          status: 'success',
          content: handoff?.outputText || '',
          finishReason: 'stop',
          activity: {
            ...activity,
            workflowResult: result('completed'),
            ...(handoff?.outputFormat ? { outputFormat: handoff.outputFormat } : {})
          }
        },
        endRun: { status: 'completed', finishReason: 'stop' }
      };
    }
    case 'cancelled':
      return {
        summary: {
          status: 'aborted',
          content: '',
          finishReason: 'cancelled',
          activity: { ...activity, workflowResult: result('cancelled') }
        },
        endRun: { status: 'aborted', finishReason: 'cancelled' }
      };
    default:
      if (execution.status === 'running' || execution.status === 'pending') {
        try {
          getExecutionRegistry().updateStatus(runId, 'failed', { reason: 'server_restart' });
        } catch {
          /* the registry may not hold it; the ledger end below still records it */
        }
      }
      return {
        summary: {
          status: 'error',
          content: '',
          finishReason: 'error',
          errorInfo: interrupted.error,
          activity: { ...activity, workflowResult: result('failed') }
        },
        endRun: interrupted
      };
  }
}

async function settle(chat, { repository, runLog }) {
  const runId = chat.activeRunId;
  const chatId = chat.id;

  // The answer may be stored already — the process died between the append
  // and the release. Then only the release is missing.
  const { messages } = await repository.getMessages(chatId);
  const answer = messages.find(m => m.role === 'assistant' && m.runId === runId);

  let endRun;
  if (!answer) {
    const closing = await closingTurn(runId, runLog);
    endRun = closing.endRun;
    const settled = await settleAssistantTurn({
      repository,
      chatId,
      runId,
      summary: closing.summary,
      // Nobody watched it end; the history marks it until it is opened.
      clientConnected: false,
      // Another worker may be settling the same chat: the check above is not
      // atomic, this one is. The worker that released the chat goes on to end
      // the run on the ledger — also when its answer could not be written,
      // since a released chat is never settled again.
      onlyIfUnanswered: true
    });
    if (settled.skipped || !settled.released) return repository.getChat(chatId);
  } else {
    // Conditional on the run still holding the chat, under the chat lock: of
    // several workers settling it, one releases it and ends the run.
    const { released } = await repository.releaseRun(chatId, runId, {
      activeRunId: null,
      status: answer.error && answer.error.code !== 'ABORTED' ? 'error' : 'active',
      hasUnseenActivity: true
    });
    if (!released) return repository.getChat(chatId);
    // The run answered; only its end was not recorded.
    endRun = answer.error
      ? {
          status: answer.error.code === 'ABORTED' ? 'aborted' : 'error',
          finishReason: answer.finishReason ?? 'error',
          error: { code: String(answer.error.code), message: String(answer.error.message || '') }
        }
      : { status: 'completed', finishReason: answer.finishReason ?? 'stop' };
  }

  // The ledger is the audit record of the run: it should end, and say how.
  try {
    if (endRun && !(await runLog.hasEnded(runId))) {
      const start = await runLog.readStart(runId);
      await runLog.appendRecovered(runId, RUN_LOG_EVENTS.RUN_END, endRun, {
        kind: start?.data?.kind || 'chat'
      });
    }
  } catch (error) {
    logger.warn('Interrupted run not ended on the ledger', {
      component: COMPONENT,
      chatId,
      runId,
      error: error.message
    });
  }

  logger.info('Settled a chat whose run was interrupted', { component: COMPONENT, chatId, runId });
  return repository.getChat(chatId);
}

/**
 * Close out a chat whose active run no process holds any more, and return the
 * chat as it now stands. A chat that is not running, or whose run is alive,
 * comes back unchanged.
 *
 * Never throws: a failure is logged and the chat returned as it was read.
 *
 * @param {Object} chat - Chat document.
 * @param {Object} deps
 * @param {import('./ChatRepository.js').default} deps.repository
 * @param {Object} [deps.runLog] - RunLog.
 * @param {number} [deps.now] - Current time (ms).
 * @returns {Promise<Object>} the chat
 */
export async function settleInterruptedChat(
  chat,
  { repository, runLog = defaultRunLog, now } = {}
) {
  if (!chat || chat.status !== 'running' || !chat.activeRunId || !repository) return chat;
  if (isChatRunAlive(chat, { runLog, now })) return chat;
  const key = `${chat.id}:${chat.activeRunId}`;
  if (!settling.has(key)) {
    settling.set(
      key,
      settle(chat, { repository, runLog })
        .catch(error => {
          logger.error('Interrupted chat not settled', {
            component: COMPONENT,
            chatId: chat.id,
            runId: chat.activeRunId,
            error: error.message
          });
          return chat;
        })
        .finally(() => settling.delete(key))
    );
  }
  return (await settling.get(key)) || chat;
}

/**
 * {@link settleInterruptedChat} over a page of the chat list, in place.
 *
 * @param {Object[]} chats - Chat documents.
 * @param {Object} deps - See {@link settleInterruptedChat}.
 * @returns {Promise<Object[]>}
 */
export async function settleInterruptedChats(chats, deps) {
  if (!Array.isArray(chats)) return chats;
  return Promise.all(
    chats.map(chat =>
      chat?.status === 'running' ? settleInterruptedChat(chat, deps) : Promise.resolve(chat)
    )
  );
}
