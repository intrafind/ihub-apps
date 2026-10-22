// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A transcription turn: a recording or an audio/video file sent to a
 * transcription model selected in a chat. The audio travels over the realtime
 * WebSocket (`websocket/realtimeTranscription.js`), not the chat POST, so the
 * bridge stores the turn itself: the file as the question, the transcript as
 * the answer, written by the transcription model.
 *
 * Stored, the transcript is chat history like any other answer — a chat model
 * selected next answers "summarize this" from it. The server owns every
 * chat's history, so a transcript only the browser held would never reach
 * that model.
 *
 * Best effort, like all materialization: a storage failure costs the stored
 * turn, never the transcript the user is watching arrive.
 *
 * @module services/chat/transcriptionTurn
 */
import configCache from '../../configCache.js';
import logger from '../../utils/logger.js';
import runLog from '../loop/RunLog.js';
import { resolvePrincipal } from '../loop/runIdentity.js';
import { authorizeChat } from './chatAccess.js';
import { getChatRepository, isPersistableChatId } from './ChatRepository.js';
import { resolveChatStorage } from './chatPersistence.js';
import { resolveChatOwner } from './chatOwner.js';
import { settleAssistantTurn, settleUserTurn } from './chatMaterializer.js';
import { resolveChatProjects } from '../knowledge/chatProjects.js';
import { findByIdCaseInsensitive } from '../../utils/resourceLookup.js';

const COMPONENT = 'TranscriptionTurn';
const MAX_LABEL_CHARS = 300;

/**
 * Whether the user may use the app the chat belongs to: the same group
 * permissions the chat POST's `chatAuthRequired` enforces.
 */
function appPermitted(user, appId) {
  const apps = user?.permissions?.apps;
  if (!apps) return false;
  const has = value => (apps instanceof Set ? apps.has(value) : apps.includes?.(value));
  return has('*') || has(appId);
}

/**
 * Store the question half of a transcription turn when the chat is stored.
 *
 * @param {Object} params
 * @param {Object} params.user - The bridge's authenticated user (with permissions).
 * @param {string} [params.chatId]
 * @param {string} [params.appId]
 * @param {string} params.modelId - The transcription model.
 * @param {boolean} [params.ephemeral]
 * @param {string} [params.clientMessageId] - The client's exchange id.
 * @param {{name?: string, type?: string, bytes?: number}} [params.attachment]
 * @param {string} [params.projectId] - The project the chat opens inside
 *   (#1036); resolved like the chat POST's `projectId`, so a chat that a
 *   transcription turn starts is listed in its project from the first turn.
 * @param {Object} [params.repository] - Defaults to the process-wide one.
 * @param {{stored: boolean, temporary: boolean}} [params.storage] - How a chat
 *   this turn creates is stored; decided from the live config
 *   (`resolveChatStorage`) when omitted.
 * @returns {Promise<{ok: true, turn: Object|null}|{ok: false, code: string}>}
 *   `turn` is null when nothing is to be stored (no chat named, persistence
 *   off); `ok: false` when the chat named is not the user's to write
 *   (`not-permitted`), the project named cannot take the chat
 *   (`project-refused`) or the question could not be stored (`not-stored`).
 */
export async function beginTranscriptionTurn({
  user,
  chatId,
  appId,
  modelId,
  ephemeral,
  clientMessageId,
  attachment,
  projectId,
  repository = getChatRepository(),
  storage = resolveChatStorage({
    features: configCache.getFeatures(),
    platformConfig: configCache.getPlatform(),
    user,
    ephemeral
  })
}) {
  if (!chatId || !appId || !isPersistableChatId(chatId)) return { ok: true, turn: null };
  if (!storage?.stored || !repository) return { ok: true, turn: null };
  if (!appPermitted(user, appId)) return { ok: false, code: 'not-permitted' };
  const access = await authorizeChat(chatId, user, { repository, intent: 'write' });
  if (!access.ok) return { ok: false, code: 'not-permitted' };
  // The container project, checked against the caller's access the way the
  // chat POST checks it; refused before the upstream is dialled, like the
  // chat itself. An omitted project changes nothing.
  const chatProjects = await resolveChatProjects({
    req: { user },
    chat: access.chat,
    app: findByIdCaseInsensitive(configCache.getApps()?.data || [], appId) || null,
    projectId
  });
  if (!chatProjects.ok) {
    logger.warn('Transcription turn refused: project', {
      component: COMPONENT,
      chatId,
      projectId,
      code: chatProjects.code
    });
    return { ok: false, code: 'project-refused' };
  }

  const identityMode = access.chat?.identityMode || runLog.identityMode();
  // The chat's owner (a guest for an anonymous visitor) and the run's
  // principal are not the same thing: an anonymous run never gets a stable id.
  const owner = await resolveChatOwner(user, { mode: identityMode });
  if (!owner) return { ok: true, turn: null };
  const principal = await resolvePrincipal(user, { mode: identityMode });
  // A run of the ledger like any chat turn: while it lasts, every worker sees
  // the chat's `activeRunId` as alive (`chatRecovery.isChatRunAlive`), so a
  // long recording is not settled as interrupted under the user.
  const { runId } = await runLog.startRun({
    kind: 'chat',
    principal,
    refs: { chatId },
    model: modelId
  });
  const label = String(attachment?.name || '').slice(0, MAX_LABEL_CHARS);
  const { message: question, refusal } = await settleUserTurn({
    repository,
    chatId,
    ownerId: owner.id,
    identityMode: owner.mode,
    temporary: access.chat ? access.chat.temporary === true : storage.temporary,
    appId,
    modelId,
    runId,
    content: label,
    clientMessageId,
    attachments: attachment ? [attachment] : [],
    ...(chatProjects.projectPatch ? { projects: chatProjects.projectPatch } : {}),
    projectId: chatProjects.containerId,
    // The audio is not kept, so the question cannot be edited or resent.
    message: { transcription: true }
  });
  if (refusal) {
    // A first turn that raced this one opened the chat in another project.
    runLog.endRun(runId, { status: 'error', error: refusal });
    return { ok: false, code: 'project-refused' };
  }
  if (!question) {
    runLog.endRun(runId, {
      status: 'error',
      error: { code: 'NOT_STORED', message: 'question not stored' }
    });
    // Not "nothing to store": transcribing on would end in a `done` for a
    // turn the chat does not have.
    return { ok: false, code: 'not-stored' };
  }
  return { ok: true, turn: { repository, chatId, runId, modelId } };
}

/** The stored outcome of a transcription: an error wins over an abort. */
function outcomeStatus({ error, aborted }) {
  if (error) return 'error';
  return aborted ? 'aborted' : 'success';
}

/**
 * Store the transcript as the answer and release the chat. Called once, on
 * every ending: done, failure, or a client that went away — a partial
 * transcript is stored with the error that cut it short.
 *
 * @param {Object|null} turn - From {@link beginTranscriptionTurn}.
 * @param {{content: string, error?: string|null, aborted?: boolean}} outcome
 * @returns {Promise<boolean>} Whether the answer is stored (true when there was
 *   nothing to store) — a success is only acknowledged when it is.
 */
export async function endTranscriptionTurn(turn, { content, error = null, aborted = false }) {
  if (!turn) return true;
  const status = outcomeStatus({ error, aborted });
  let stored = false;
  try {
    // A storage failure is reported, not thrown: no stored message.
    const settled = await settleAssistantTurn({
      repository: turn.repository,
      chatId: turn.chatId,
      runId: turn.runId,
      summary: {
        status,
        content,
        finishReason: status === 'success' ? 'stop' : status,
        ...(error ? { error } : {})
      },
      clientConnected: !aborted,
      message: { model: turn.modelId, transcription: true }
    });
    stored = Boolean(settled.message) || settled.skipped;
    if (!stored) {
      logger.error('Transcription answer not stored', {
        component: COMPONENT,
        chatId: turn.chatId,
        runId: turn.runId
      });
    }
  } catch (err) {
    logger.error('Transcription turn not settled', {
      component: COMPONENT,
      chatId: turn.chatId,
      runId: turn.runId,
      error: err.message
    });
  } finally {
    // After the answer is stored, as for any chat turn (see settleAssistantTurn).
    runLog.endRun(turn.runId, runEndOf(status, error, stored));
  }
  return stored;
}

/** The ledger's `run/end` for a transcription: a lost answer is an error too. */
function runEndOf(status, error, stored) {
  if (status === 'success' && stored) return { status: 'completed', finishReason: 'stop' };
  const message = error ? String(error) : 'answer not stored';
  return {
    status: status === 'aborted' ? 'aborted' : 'error',
    finishReason: status === 'success' ? 'error' : status,
    error: { code: error ? 'TRANSCRIPTION_FAILED' : 'NOT_STORED', message }
  };
}
