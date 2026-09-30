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
 * {@link deliverResumedWorkflows} finishes the one turn settling leaves open:
 * an `@workflow` run paused at a human checkpoint, which the user continues
 * from its execution page, gets its answer when the chat is next read.
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

/** The execution's stored state, or null when it cannot be read. */
async function executionState(runId) {
  try {
    return (await getWorkflowEngine().getState(runId)) || null;
  } catch {
    return null;
  }
}

/** The answer a completed execution gave, read from its state. */
async function executionAnswer(runId) {
  const state = await executionState(runId);
  return state ? executionHandoff(state) : null;
}

/** Why a failed execution failed, as its state records it. */
async function executionError(runId) {
  const state = await executionState(runId);
  const last = Array.isArray(state?.errors) ? state.errors.at(-1) : null;
  return typeof last?.message === 'string' && last.message ? last.message : null;
}

/**
 * The turn an `@workflow` execution closes its chat run with when the
 * execution is paused, completed or cancelled, or null for any other state:
 *
 * - paused at a human checkpoint: still resumable from its execution page, so
 *   the chat says so and its run stays open;
 * - completed: its answer is delivered from the execution;
 * - cancelled: stored as a stopped turn.
 *
 * @returns {Promise<{summary: Object, endRun: Object|null}|null>}
 */
async function workflowTurn(runId, execution, activity) {
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
      return null;
  }
}

/**
 * How a dead run is closed: the answer to store, and whether the run ends on
 * the ledger. An ordinary turn was interrupted. An `@workflow` turn is closed
 * by what its execution says it is (see {@link workflowTurn}) — the execution
 * outlives the chat bridge that died with the process. One that is neither
 * paused, completed nor cancelled was interrupted, and an execution left
 * running is marked failed so "My Executions" stops listing it as running.
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
  const interruptedTurn = extra => ({
    summary: {
      status: 'error',
      content: '',
      finishReason: 'error',
      errorInfo: interrupted.error,
      activity: { ...activity, ...extra }
    },
    endRun: interrupted
  });

  const execution = await executionOf(runId);
  if (!execution) return interruptedTurn({});
  const turn = await workflowTurn(runId, execution, activity);
  if (turn) return turn;
  if (execution.status === 'running' || execution.status === 'pending') {
    try {
      getExecutionRegistry().updateStatus(runId, 'failed', { reason: 'server_restart' });
    } catch {
      /* the registry may not hold it; the ledger end below still records it */
    }
  }
  return interruptedTurn({
    workflowResult: { status: 'failed', executionId: runId, workflowName: execution.workflowName }
  });
}

/**
 * End a run on the ledger unless it has ended already. Never throws.
 *
 * @param {string} chatId - For the log.
 * @param {string} runId
 * @param {Object|null} endRun - The `run/end` data, or null to leave it open.
 * @param {Object} runLog
 */
async function endOnLedger(chatId, runId, endRun, runLog) {
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
  await endOnLedger(chatId, runId, endRun, runLog);

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

// ── a paused workflow that was continued ────────────────────────────────────

/** Deliveries in progress in this process, so concurrent reads deliver once. */
const delivering = new Map();

/**
 * Whether a stored answer is the "waiting for your input" a paused workflow's
 * chat was closed with ({@link workflowTurn}). A live bridge never stores one:
 * it keeps the turn open through the pause.
 */
function isWaitingForInput(message) {
  return (
    message?.role === 'assistant' &&
    typeof message.runId === 'string' &&
    message.finishReason === 'paused' &&
    message.activity?.workflowResult?.status === 'paused'
  );
}

/**
 * The turn a continued workflow's chat gets once the execution is over, or
 * null while it is still paused, running or pending.
 */
async function resumedTurn(runId, execution, activity) {
  if (execution.status === 'failed') {
    const reason = (await executionError(runId)) || 'Workflow execution failed';
    const error = { code: 'WORKFLOW_FAILED', message: reason };
    return {
      summary: {
        status: 'error',
        content: `Workflow failed: ${reason}`,
        finishReason: 'error',
        errorInfo: error,
        activity: {
          ...activity,
          workflowResult: {
            status: 'failed',
            executionId: runId,
            workflowName: execution.workflowName
          }
        }
      },
      endRun: { status: 'error', finishReason: 'error', error }
    };
  }
  if (execution.status === 'paused') return null;
  return workflowTurn(runId, execution, activity);
}

async function deliver(chat, waiting, { repository, runLog }) {
  const runId = waiting.runId;
  const execution = await executionOf(runId);
  if (!execution) return false;
  const activity = (await rebuildRunActivity(runLog, runId)) || waiting.activity || {};
  const turn = await resumedTurn(runId, execution, activity);
  if (!turn) return false;

  const settled = await settleAssistantTurn({
    repository,
    chatId: chat.id,
    runId,
    summary: turn.summary,
    // The chat is being opened: this is its reader.
    clientConnected: true,
    // In the waiting answer's place, so the exchange stays where it was asked
    // and the questions asked after it stay after it. Another worker that
    // replaced it first is left its answer.
    supersedeMessageId: waiting.id
  });
  if (!settled.message) return false;
  // The engine ends its run when the workflow ends; this covers a workflow
  // failed by the orphan sweep, whose engine is gone.
  await endOnLedger(chat.id, runId, turn.endRun, runLog);
  logger.info('Delivered a continued workflow to its chat', {
    component: COMPONENT,
    chatId: chat.id,
    runId
  });
  return true;
}

/**
 * Put the result of a workflow that was continued after a restart into its
 * chat.
 *
 * A chat whose `@workflow` run was paused at a human checkpoint when its
 * process died is closed with "waiting for your input" and a link to the
 * execution page ({@link settleInterruptedChat}). The chat bridge that would
 * have delivered the answer died with the process, so when the user continues
 * the workflow there, nothing brings the result back to the chat. Reading the
 * chat does: each waiting answer whose execution has since ended is replaced,
 * in place, by the execution's answer — or by its failure or its stop.
 *
 * Never throws: a failure is logged and the transcript left as it was.
 *
 * @param {Object} chat - Chat document.
 * @param {Object[]} messages - Its stored transcript.
 * @param {Object} deps
 * @param {import('./ChatRepository.js').default} deps.repository
 * @param {Object} [deps.runLog] - RunLog.
 * @returns {Promise<boolean>} whether the transcript changed
 */
export async function deliverResumedWorkflows(
  chat,
  messages,
  { repository, runLog = defaultRunLog } = {}
) {
  if (!chat || !repository || !Array.isArray(messages)) return false;
  let changed = false;
  for (const waiting of messages.filter(isWaitingForInput)) {
    const key = `${chat.id}:${waiting.id}`;
    if (!delivering.has(key)) {
      delivering.set(
        key,
        deliver(chat, waiting, { repository, runLog })
          .catch(error => {
            logger.error('Continued workflow not delivered to its chat', {
              component: COMPONENT,
              chatId: chat.id,
              runId: waiting.runId,
              error: error.message
            });
            return false;
          })
          .finally(() => delivering.delete(key))
      );
    }
    if (await delivering.get(key)) changed = true;
  }
  return changed;
}
