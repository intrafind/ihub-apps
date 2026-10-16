/**
 * A transcription turn: a recording or an audio/video file sent to a
 * transcription model selected in a chat. The audio travels over the realtime
 * WebSocket (`websocket/realtimeTranscription.js`), not the chat POST, so the
 * bridge stores the turn itself: the file as the question, the transcript as
 * the answer, written by the transcription model.
 *
 * Stored, the transcript is chat history like any other answer — a chat model
 * selected next answers "summarize this" from it. With durable chats the
 * server owns the history, so a transcript only the browser held would never
 * reach that model.
 *
 * Best effort, like all materialization: a storage failure costs the stored
 * turn, never the transcript the user is watching arrive.
 *
 * @module services/chat/transcriptionTurn
 */
import configCache from '../../configCache.js';
import logger from '../../utils/logger.js';
import runLog, { newRunId } from '../loop/RunLog.js';
import { resolvePrincipal } from '../loop/runIdentity.js';
import { authorizeChat } from './chatAccess.js';
import { getChatRepository, isPersistableChatId } from './ChatRepository.js';
import { isChatPersistenceActive } from './chatPersistence.js';
import { materializeUserTurn, settleAssistantTurn } from './chatMaterializer.js';

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
 * @param {Object} [params.repository] - Defaults to the process-wide one.
 * @param {boolean} [params.persist] - Whether this turn is stored; decided from
 *   the live config (`isChatPersistenceActive`) when omitted.
 * @returns {Promise<{ok: true, turn: Object|null}|{ok: false, code: string}>}
 *   `turn` is null when nothing is stored (no chat named, persistence off);
 *   `ok: false` when the chat named is not the user's to write.
 */
export async function beginTranscriptionTurn({
  user,
  chatId,
  appId,
  modelId,
  ephemeral,
  clientMessageId,
  attachment,
  repository = getChatRepository(),
  persist = isChatPersistenceActive({
    features: configCache.getFeatures(),
    platformConfig: configCache.getPlatform(),
    user,
    ephemeral
  })
}) {
  if (!chatId || !appId || !isPersistableChatId(chatId)) return { ok: true, turn: null };
  if (!persist || !repository) return { ok: true, turn: null };
  if (!appPermitted(user, appId)) return { ok: false, code: 'not-permitted' };
  const access = await authorizeChat(chatId, user, { repository, intent: 'write' });
  if (!access.ok) return { ok: false, code: 'not-permitted' };

  const identityMode = access.chat?.identityMode || runLog.identityMode();
  const principal = await resolvePrincipal(user, { mode: identityMode });
  const runId = newRunId('chat');
  const label = String(attachment?.name || '').slice(0, MAX_LABEL_CHARS);
  const question = await materializeUserTurn({
    repository,
    chatId,
    ownerId: principal.id,
    identityMode: principal.mode || identityMode,
    appId,
    modelId,
    runId,
    content: label,
    clientMessageId,
    attachments: attachment ? [attachment] : []
  });
  if (!question) return { ok: true, turn: null };
  return { ok: true, turn: { repository, chatId, runId, modelId } };
}

/**
 * Store the transcript as the answer and release the chat. Called once, on
 * every ending: done, failure, or a client that went away — a partial
 * transcript is stored with the error that cut it short.
 *
 * @param {Object|null} turn - From {@link beginTranscriptionTurn}.
 * @param {{content: string, error?: string|null, aborted?: boolean}} outcome
 */
export async function endTranscriptionTurn(turn, { content, error = null, aborted = false }) {
  if (!turn) return;
  const status = error ? 'error' : aborted ? 'aborted' : 'success';
  try {
    await settleAssistantTurn({
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
      message: { model: turn.modelId }
    });
  } catch (err) {
    logger.error('Transcription turn not settled', {
      component: COMPONENT,
      chatId: turn.chatId,
      runId: turn.runId,
      error: err.message
    });
  }
}
