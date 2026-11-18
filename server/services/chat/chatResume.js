// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Resume of a running chat turn for a client that re-attaches mid-step.
 *
 * The client first replays the run's ledger, then opens the chat's GET stream
 * with `resumeRun` and the last ledger seq it replayed (`afterLedgerSeq`). The
 * GET asks the worker producing the run for:
 *
 * 1. the ledger events after the client's cursor, read after a flush, so a
 *    step that completed after the client's replay is not missed;
 * 2. the run's partial state — the text of unfinished steps and the run's
 *    thinking (`services/loop/partialRunState.js`) — as `step/delta` frames,
 *    taken together with the run frame counter they cover (`upTo`), without
 *    the text of a step the ledger above already completed.
 *
 * Ledger first: a step that completed after the client's replay must be
 * completed before the text of the next step is appended, or the reducer
 * would put that text in front of the completed step's.
 *
 * The snapshot is taken first and synchronously with `upTo`, so nothing is in
 * both the snapshot and a live frame above `upTo`. A ledger event written while
 * the ledger is read can also arrive live; every such frame (`step/completed`,
 * tool frames, sources, lifecycle) is idempotent in the client reducer.
 *
 * Across workers this is one bus request and one reply. It is exact because
 * the GET registers its stream before it asks, and the primary forwards both
 * messages in order: the producer already relays live frames to the GET when
 * it builds the snapshot. Across pods without a shared bus there is no resume
 * (a known limit, see `docs/streaming-events.md`).
 *
 * @module services/chat/chatResume
 */
import { hasRemote, request, respond } from '../../clusterBus.js';
import runLog from '../loop/RunLog.js';
import { currentRseq, flushStream, projectLedgerEvent } from '../loop/RunStream.js';
import { snapshotRun, trackedStream } from '../loop/partialRunState.js';
import { SSE_V2_EVENTS } from '../../../shared/runEvents.js';
import logger from '../../utils/logger.js';

export const CHAT_RESUME_CHANNEL = 'chat:resume';

/** Ledger events returned with one resume; a longer gap is the transcript re-read's job. */
const LEDGER_LIMIT = 1000;

/** How long a re-attaching GET waits for the producing worker. */
const RESUME_TIMEOUT_MS = 1500;

/**
 * Build the resume of a run this worker is producing.
 *
 * @param {Object} params
 * @param {string} params.chatId - The chat the caller is authorized for
 * @param {string} params.runId - The run to resume
 * @param {number} [params.afterLedgerSeq=0] - Last ledger seq the client replayed
 * @returns {Promise<{frames: Object[], upTo: number, truncated: boolean}|null>}
 *   null when this worker is not producing that run for that chat.
 */
export async function buildChatResume({ chatId, runId, afterLedgerSeq = 0 }) {
  if (!chatId || !runId || trackedStream(runId) !== chatId) return null;
  // A half-filled delta window would straddle the cursor; send it now, its
  // frame is numbered at or below `upTo` and covered by the snapshot.
  flushStream(chatId);
  const { frames, truncated } = snapshotRun(runId, chatId);
  const upTo = currentRseq(runId);
  let ledger = [];
  try {
    await runLog.flush();
    const events = await runLog.readEvents(runId, {
      afterSeq: Number(afterLedgerSeq) || 0,
      limit: LEDGER_LIMIT
    });
    ledger = events.flatMap(projectLedgerEvent);
  } catch (error) {
    logger.warn('Chat resume could not read the ledger', {
      component: 'chatResume',
      chatId,
      runId,
      error: error.message
    });
  }
  // The snapshot was taken before the ledger was read: a step completing in
  // between is in both. Its completed text is the ledger's.
  const completed = new Set(
    ledger.filter(f => f.type === SSE_V2_EVENTS.STEP_COMPLETED).map(f => f.data?.step ?? 0)
  );
  const partial = frames.filter(f => !(f.data.kind === 'text' && completed.has(f.data.step)));
  return { frames: [...ledger, ...partial], upTo, truncated };
}

/**
 * The resume of a run, from this worker or the one producing it.
 *
 * @param {Object} params - See {@link buildChatResume}
 * @returns {Promise<{frames: Object[], upTo: number, truncated: boolean}|null>}
 *   null when no worker is producing the run (it ended, or runs on another pod).
 */
export async function resumeChatRun(params) {
  const local = await buildChatResume(params);
  if (local) return local;
  // The worker running the turn holds its abort controller; a turn already
  // stopped may still be finishing under its run's journal owner.
  const route = hasRemote('request', params.chatId)
    ? { kind: 'request', key: params.chatId }
    : hasRemote('run', params.runId)
      ? { kind: 'run', key: params.runId }
      : null;
  if (!route) return null;
  return request(CHAT_RESUME_CHANNEL, params, { route, timeoutMs: RESUME_TIMEOUT_MS });
}

// Every worker answers for the runs it produces; the others stay silent.
respond(CHAT_RESUME_CHANNEL, async payload => (await buildChatResume(payload)) ?? undefined);
