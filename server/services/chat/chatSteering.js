// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Messages the person sends into a running chat answer, on the chat side:
 * what the turn does when one is read, what becomes of the ones it did not
 * read, and what the chat read model lists.
 *
 * - **Read at a step.** {@link chatSteerSeam} tells the chat stream
 *   (`steer/applied { id, step, activityKind: 'user_message' }`) and stores the
 *   message as a user message of the turn's run: `steer: true`, `runId`,
 *   `appliedAtStep`, `steerId`, and the activity row the server decided
 *   (`activityKind: 'user_message'`, `server/utils/toolDisplay.js`), so a client
 *   draws the row at that step from the stored turn as it did live. The answer is
 *   stored after it (the answer goes
 *   after the last message of its run), so the stored chat says where the
 *   message was read, and it follows the chat's retention and deletion.
 * - **The leftover.** When the answer ends, the turn lets go of the chat under
 *   the chat lock (`chatMaterializer.settleAssistantTurn`). There, and only
 *   while this run still holds the chat, {@link createLeftover} takes every
 *   message still queued (`steering.closeSteering`). They become the next turn
 *   when the answer completed in a kept chat and the caller starts next turns
 *   (the chat route): the chat is claimed for the next turn's run in the same
 *   write, so of two workers and two requests exactly one has the leftover.
 *   Otherwise they are dropped with a reason the client is told
 *   (`steer/dropped`), so it can give the text back.
 * - **The read model.** {@link chatPendingView} lists what waits
 *   (`pending[]`) and whether the reader may send more (`maySteer`).
 *
 * @module services/chat/chatSteering
 */
import configCache from '../../configCache.js';
import { isFeatureEnabled } from '../../featureRegistry.js';
import { newRunId } from '../loop/RunLog.js';
import {
  closeSteering,
  dropSteers,
  listPendingSteers,
  moveSteers,
  settleSent
} from '../loop/steering.js';
import { SSE_V2_EVENTS } from '../../../shared/runEvents.js';
import { appliedMessageDisplayOf } from '../../utils/toolDisplay.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'chatSteering';

/** The feature that offers sending messages into a running answer in the chat. */
export const STEERING_FEATURE = 'steering';

/** The i18n key of a pending item's label, per kind; the client renders it. */
const LABEL_KEYS = Object.freeze({
  steer: 'chat.pending.steer',
  send_after: 'chat.pending.sendAfter'
});

/**
 * The seam that tells the chat stream about a message read at a step and
 * stores it with the turn.
 *
 * @param {Object} params
 * @param {string} params.chatId
 * @param {string} params.runId
 * @param {{emit: Function}} params.stream - The turn's emitter.
 * @param {Object|null} [params.repository] - The chat store; null when the turn stores nothing.
 * @returns {{onSteerApplied: Function}}
 */
export function chatSteerSeam({ chatId, runId, stream, repository = null }) {
  return {
    async onSteerApplied(_ctx, applied) {
      stream.emit(SSE_V2_EVENTS.STEER_APPLIED, {
        id: applied.id,
        kind: 'steer',
        text: applied.text,
        step: applied.step,
        ...appliedMessageDisplayOf()
      });
      if (!repository) return;
      try {
        await repository.appendMessage(chatId, {
          role: 'user',
          content: applied.text,
          ts: applied.at || new Date().toISOString(),
          runId,
          steer: true,
          appliedAtStep: applied.step,
          steerId: applied.id,
          // The activity row at that step, as the live frame said it.
          ...appliedMessageDisplayOf()
        });
      } catch (error) {
        // The model read it; only the stored chat misses it.
        logger.error('Message read at a step not stored', {
          component: COMPONENT,
          chatId,
          runId,
          error: error.message
        });
      }
    }
  };
}

/**
 * Why the leftover of an answer is not sent as the next turn, or null when it is.
 *
 * @param {Object} params
 * @param {string} params.status - How the answer ended.
 * @param {string} [params.causeKind] - Why an aborted answer was stopped (`abortCause.js`).
 * @param {Object} params.chat - The chat as stored.
 * @param {boolean} params.startsNextTurn - The caller starts a next turn.
 * @returns {string|null} one of `STEER_DROP_REASONS`
 */
function dropReasonOf({ status, causeKind, chat, startsNextTurn }) {
  if (status === 'paused') return 'run_paused';
  // A newer message aborts the answer it replaces before it claims the chat.
  if (status === 'aborted') return causeKind === 'superseded' ? 'superseded' : 'run_stopped';
  if (status === 'error') return 'run_failed';
  if (chat?.temporary === true) return 'temporary_chat';
  if (!startsNextTurn) return 'run_ended';
  return null;
}

/**
 * The leftover of one answer.
 *
 * Call {@link Leftover.takerFor} with the answer's status and hand the result to
 * `settleAssistantTurn` as `takeLeftover`; call {@link Leftover.finish} after it
 * (and again from a `finally`, where it does nothing more).
 *
 * @typedef {Object} Leftover
 * @property {(status: string, causeKind?: string) => (chat: Object) => Object|null} takerFor
 * @property {(notTakenReason: string) => {runId: string, fromRunId: string,
 *   first: Object[], text: string}|null} finish - Settles what was taken: drops it, or
 *   tells that the first messages are the question of the next turn and queues the rest
 *   for it; answers the next turn to start (its run, and the text of its question), or null.
 */

/**
 * @param {Object} params
 * @param {string} params.runId - The run whose answer ends.
 * @param {boolean} [params.startsNextTurn=false] - The caller starts the next turn.
 * @returns {Leftover}
 */
export function createLeftover({ runId, startsNextTurn = false }) {
  const state = { taken: false, entries: [], claim: null, nextRunId: null, reason: null };
  let finished = false;
  return {
    takerFor(status, causeKind) {
      return chat => {
        if (state.taken) return state.claim;
        state.taken = true;
        state.entries = closeSteering(runId);
        if (state.entries.length === 0) return null;
        state.reason = dropReasonOf({ status, causeKind, chat, startsNextTurn });
        if (state.reason) return null;
        state.nextRunId = newRunId('chat');
        state.claim = {
          activeRunId: state.nextRunId,
          status: 'running',
          runClaimedAt: new Date().toISOString(),
          // The person is there: they sent the message a moment ago.
          hasUnseenActivity: false
        };
        return state.claim;
      };
    },
    finish(notTakenReason) {
      if (finished) return null;
      finished = true;
      if (!state.taken) {
        // The run no longer held the chat (a newer message replaced the
        // answer), or nothing stored it: what it did not read is dropped.
        dropSteers(runId, closeSteering(runId), notTakenReason);
        return null;
      }
      if (state.reason) {
        dropSteers(runId, state.entries, state.reason);
        return null;
      }
      if (!state.nextRunId) return null;
      // Told now, while the answer's own stream is still open: the first
      // messages are the next turn's question, the rest wait in its queue
      // (a steer is read at its first step), removable under this run's id.
      // A next turn that cannot start drops them again (`not_started`).
      const { first, rest, text } = splitLeftover(state.entries);
      settleSent(runId, first, state.nextRunId);
      moveSteers(runId, rest, state.nextRunId);
      return { runId: state.nextRunId, fromRunId: runId, first, text };
    }
  };
}

/**
 * The leftover split into the next turn and what waits behind it: the
 * messages before the first `afterwards` one, or that one alone. Several
 * steers the answer did not read are one message: they were meant for the
 * same answer.
 *
 * @param {Object[]} entries - Queued messages, oldest first.
 * @returns {{first: Object[], rest: Object[], text: string}}
 */
export function splitLeftover(entries) {
  if (entries.length === 0) return { first: [], rest: [], text: '' };
  let count = 0;
  if (entries[0].mode === 'afterwards') count = 1;
  else {
    while (count < entries.length && entries[count].mode !== 'afterwards') count++;
  }
  const first = entries.slice(0, count);
  return {
    first,
    rest: entries.slice(count),
    text: first.map(entry => entry.message).join('\n\n')
  };
}

/**
 * What the chat read model says about messages for the running answer.
 *
 * Only for a reader who may read the chat (the caller checked). The items are
 * those of the chat's active run; each names the run a removal goes to
 * (`runId`: the run it was sent to, also when it waits in the next turn's run
 * since). A reader who is not the owner (an admin, a
 * project member) sees them without actions, and `maySteer` is true only for
 * the owner while the feature is on. With the feature off neither field is
 * part of the read model: a client reads that as nothing pending and
 * `maySteer: false`.
 *
 * @param {Object} chat - The chat as stored.
 * @param {Object} params
 * @param {boolean} params.owner - The reader owns the chat.
 * @param {Object} [params.features] - The feature configuration.
 * @returns {Promise<{pending: Object[], maySteer: boolean}|null>} null with the feature off
 */
export async function chatPendingView(chat, { owner, features = configCache.getFeatures() }) {
  if (!isFeatureEnabled(STEERING_FEATURE, features)) return null;
  const runId = chat?.status === 'running' ? chat.activeRunId : null;
  const items = runId ? await listPendingSteers(runId) : [];
  const pending = items
    .filter(item => !item.chatId || item.chatId === chat.id)
    .map(item => ({
      id: item.id,
      runId: item.runId || runId,
      kind: item.kind,
      text: item.text,
      labelKey: LABEL_KEYS[item.kind] || LABEL_KEYS.steer,
      actions: owner ? ['remove'] : []
    }));
  return { pending, maySteer: owner === true };
}
