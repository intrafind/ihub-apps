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
import { materializeAssistantTurn } from './chatMaterializer.js';
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
  const claimed = Date.parse(chat.runClaimedAt || chat.lastMessageAt || '');
  if (!Number.isFinite(claimed) || now - claimed < INTERRUPTED_RUN_GRACE_MS) return true;
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
 * What the reopened answer of an interrupted workflow run should say about the
 * workflow: its name, and the execution to open for its current state.
 */
async function interruptedWorkflow(runId) {
  try {
    const execution = await getExecutionRegistry().get(runId);
    if (!execution) return null;
    return {
      status: 'failed',
      executionId: runId,
      workflowName: execution.workflowName
    };
  } catch {
    return null;
  }
}

async function settle(chat, { repository, runLog }) {
  const runId = chat.activeRunId;
  const chatId = chat.id;

  // The answer may be stored already — the process died between the append
  // and the release. Then only the release is missing.
  const { messages } = await repository.getMessages(chatId);
  const answered = messages.some(m => m.role === 'assistant' && m.runId === runId);

  if (!answered) {
    const activity = (await rebuildRunActivity(runLog, runId)) || {};
    const workflowResult = await interruptedWorkflow(runId);
    if (workflowResult) activity.workflowResult = workflowResult;
    await materializeAssistantTurn({
      repository,
      chatId,
      runId,
      summary: {
        status: 'error',
        content: '',
        finishReason: 'error',
        errorInfo: { code: RUN_INTERRUPTED, message: INTERRUPTED_MESSAGE },
        activity: Object.keys(activity).length > 0 ? activity : null
      },
      // Nobody watched it end; the history marks it until it is opened.
      clientConnected: false
    });
  } else {
    await repository.releaseRun(chatId, runId, {
      activeRunId: null,
      status: 'active',
      hasUnseenActivity: true
    });
  }

  // The ledger is the audit record of the run: it should end, and say why.
  try {
    if (!(await runLog.hasEnded(runId))) {
      const start = await runLog.readStart(runId);
      await runLog.appendRecovered(
        runId,
        RUN_LOG_EVENTS.RUN_END,
        {
          status: 'error',
          finishReason: 'error',
          error: { code: RUN_INTERRUPTED, message: INTERRUPTED_MESSAGE }
        },
        { kind: start?.data?.kind || 'chat' }
      );
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
