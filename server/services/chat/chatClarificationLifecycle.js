/**
 * Chat clarification lifecycle — ends the chat run a clarification paused.
 *
 * A chat turn whose model asks the user a question (`ask_user`) ends its loop
 * with `run/paused` and leaves the run open on the ledger. The question is
 * settled outside that run: the next chat message answers or supersedes it
 * (`sessionRoutes.settleChatClarifications`), or it expires unanswered. The
 * answer feeds the next turn — a new run — so nothing ever resumes the paused
 * one. This listener writes the `run/end` that closes it, so a paused chat run
 * does not stay open in listings and stop handling forever.
 *
 * Only chat clarifications qualify: `origin: 'tool'` with a `source.chatId`
 * and no `source.checkpointId` (a question raised inside a workflow node
 * pauses an execution that `checkpointResume` resumes on the same run).
 *
 * @module services/chat/chatClarificationLifecycle
 */
import interactionService from '../loop/InteractionService.js';
import defaultRunLog, { isValidRunId } from '../loop/RunLog.js';
import { RUN_LOG_EVENTS } from '../../../shared/runEvents.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'ChatClarificationLifecycle';

/** The `run/end` written for each way a clarification can be settled. */
const RUN_END_BY_STATUS = Object.freeze({
  answered: { status: 'completed', finishReason: 'clarification_answered' },
  cancelled: { status: 'aborted', finishReason: 'clarification_superseded' },
  expired: { status: 'aborted', finishReason: 'clarification_expired' }
});

/** True for an `ask_user` question raised by a chat turn (not by a workflow node). */
export function isChatClarification(interaction) {
  return (
    !!interaction &&
    interaction.origin === 'tool' &&
    typeof interaction.source?.chatId === 'string' &&
    interaction.source.chatId.length > 0 &&
    !interaction.source.checkpointId
  );
}

/**
 * Close the run a settled clarification paused. A run that has already ended
 * is left alone.
 *
 * @param {Object} interaction - the settled interaction (`answered` | `cancelled` | `expired`)
 * @param {Object} [opts]
 * @param {Object} [opts.runLog] - RunLog (default: shared singleton)
 * @returns {Promise<Object|null>} the `run/end` event, or null when nothing was written
 */
export async function endPausedChatRun(interaction, { runLog = defaultRunLog } = {}) {
  const end = RUN_END_BY_STATUS[interaction?.status];
  if (!end || !isValidRunId(interaction.runId)) return null;
  const runId = interaction.runId;
  if (await runLog.hasEnded(runId)) return null;
  return runLog.appendRecovered(runId, RUN_LOG_EVENTS.RUN_END, end, { kind: 'chat' });
}

/**
 * End the run of every chat clarification that gets settled.
 *
 * @param {Object} [service] - InteractionService (default: shared singleton)
 * @param {Object} [deps]
 * @param {Object} [deps.runLog] - RunLog (default: shared singleton)
 * @returns {() => void} unregister
 */
export function registerChatClarificationLifecycle(service = interactionService, deps = {}) {
  const runLog = deps.runLog || defaultRunLog;
  const onSettled = interaction => {
    if (!isChatClarification(interaction)) return;
    endPausedChatRun(interaction, { runLog }).catch(err =>
      logger.warn('Could not end the chat run of a settled clarification', {
        component: COMPONENT,
        runId: interaction.runId,
        interactionId: interaction.id,
        error: err.message
      })
    );
  };
  service.on('answered', onSettled);
  service.on('cancelled', onSettled);
  service.on('expired', onSettled);
  return () => {
    service.off('answered', onSettled);
    service.off('cancelled', onSettled);
    service.off('expired', onSettled);
  };
}
