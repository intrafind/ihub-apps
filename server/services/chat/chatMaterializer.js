/**
 * Materialization — the only module that writes chat turns to durable storage.
 *
 * A turn becomes two writes: the human half at run start and the assistant
 * half at run end. Both are best effort *with respect to the turn* — a storage
 * failure never fails a chat that is otherwise fine — but they are not best
 * effort with respect to silence: every failure is logged at `error`, because
 * a chat that quietly stopped being persisted is a bug the operator has to see
 * before the user does.
 *
 * Nothing here decides *whether* a turn is persisted. That is
 * `chatPersistence.isChatPersistenceActive()`, evaluated once per request by
 * the route; this module is either handed a repository or is not called.
 *
 * @module services/chat/chatMaterializer
 */
import logger from '../../utils/logger.js';
import { deriveChatTitle } from './ChatRepository.js';

const COMPONENT = 'chatMaterializer';

/**
 * Attachment descriptors for a stored message and for the `message/user`
 * ledger event, which validates this exact shape. Only the descriptor
 * survives: the base64 payload of an upload belongs in the request, never in a
 * document that is read back for as long as the chat lives.
 *
 * The field names are read generously because the upload shapes differ: the
 * chat client sends `{ type: 'document', fileName, fileSize, fileType }`,
 * where `type` is the upload *kind* and the mime type lives on `fileType`.
 * Recording the kind as the type would lose which format was sent, so a real
 * mime type wins when one is present.
 *
 * @param {Array<Object>} [attachments] - upload metadata as the route saw it
 * @returns {Array<{type: string, name?: string, bytes?: number}>}
 */
export function normalizeAttachments(attachments) {
  if (!Array.isArray(attachments)) return [];
  return attachments
    .filter(entry => entry && typeof entry === 'object' && !Array.isArray(entry))
    .map(entry => {
      const name = entry.name || entry.fileName;
      const bytes = Number(entry.bytes ?? entry.size ?? entry.fileSize);
      return {
        type: String(entry.fileType || entry.mimeType || entry.type || 'file'),
        ...(name ? { name: String(name) } : {}),
        ...(Number.isFinite(bytes) ? { bytes } : {})
      };
    });
}

/** Usage as stored on a message: the three counters, nothing provider-specific. */
function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const promptTokens = Number(usage.promptTokens) || 0;
  const completionTokens = Number(usage.completionTokens) || 0;
  const totalTokens = Number(usage.totalTokens) || promptTokens + completionTokens;
  if (!promptTokens && !completionTokens && !totalTokens) return null;
  return { promptTokens, completionTokens, totalTokens };
}

/**
 * The error to record on a stored assistant message, or null when the turn
 * ended cleanly. An abort is recorded too: "the user stopped it" is part of
 * what happened, and without it a truncated answer reads as a complete one.
 */
function messageError(summary) {
  if (summary?.status === 'aborted') {
    return { code: 'ABORTED', message: 'Turn stopped before it finished.' };
  }
  if (summary?.status !== 'error') return null;
  const info = summary.errorInfo || summary.error;
  if (!info) return { code: 'ERROR', message: 'Turn failed.' };
  return {
    code: String(info.code || 'ERROR'),
    message: String(info.message || info)
  };
}

/**
 * Write the human half of a turn: create the chat if this is its first
 * message, mark it busy for the run, and append the user message.
 *
 * Called at run start, before the first client frame, so the chat document
 * exists by the time anything can ask for it. Marking the chat `running` with
 * a live `activeRunId` up front is also what lets a delete cascade into this
 * run's ledger if the process dies mid-turn.
 *
 * @param {Object} params
 * @param {import('./ChatRepository.js').default} params.repository
 * @param {string} params.chatId
 * @param {string} params.ownerId - run principal, resolved once by the route
 * @param {string} params.identityMode - the mode `ownerId` was resolved in
 * @param {string} [params.appId]
 * @param {string} [params.modelId]
 * @param {Object} [params.settings] - How this turn was answered (style, tools,
 *   websearch, thinking …), so reopening the chat restores it
 * @param {string} params.runId
 * @param {string} params.content - raw text of the new user message
 * @param {string} [params.clientMessageId] - client exchange id, for reconciling an
 *   optimistic render instead of duplicating it
 * @param {Array<Object>} [params.attachments] - already-normalized descriptors
 * @param {string} [params.replaceFromMessageId] - truncate the stored history from this
 *   message (inclusive) before appending — an edit or a regenerate
 * @returns {Promise<Object|null>} the stored message, or null when nothing was written
 */
export async function materializeUserTurn({
  repository,
  chatId,
  ownerId,
  identityMode,
  appId,
  modelId,
  settings,
  runId,
  content,
  clientMessageId,
  attachments,
  replaceFromMessageId
}) {
  if (!repository) return null;
  const text = typeof content === 'string' ? content : '';
  const title = deriveChatTitle(text);
  const descriptors = normalizeAttachments(attachments);
  try {
    const chat = await repository.ensureChat({
      chatId,
      ownerId,
      identityMode,
      appId,
      modelId,
      settings,
      title
    });
    if (!chat) {
      logger.error('Chat user turn not materialized: storage unavailable', {
        component: COMPONENT,
        chatId,
        runId
      });
      return null;
    }
    await repository.updateChat(chatId, {
      activeRunId: runId,
      status: 'running',
      // The sender is demonstrably present, so nothing in this chat is unseen.
      hasUnseenActivity: false,
      ...(modelId ? { modelId } : {}),
      // How the user has this chat set up right now. The repository merges,
      // so a turn that changed one toggle does not reset the others.
      ...(settings ? { settings } : {}),
      // A chat opened by an empty auto-start turn has no title yet; the first
      // message carrying text names it. A title the user set is never touched.
      ...(!chat.title && title && !chat.titleSetByUser ? { title } : {})
      // No `runIds` here: the repository derives them from `activeRunId` on
      // every patch, so that a run the delete cascade owes the ledger is
      // recorded whether or not a message from it ever landed. Computing them
      // here as well meant a second implementation of the same cap, and the
      // two disagreed on where a repeated id lands in the list.
    });
    const appended = await repository.appendMessage(
      chatId,
      {
        role: 'user',
        content: text,
        ts: new Date().toISOString(),
        runId,
        ...(clientMessageId ? { clientMessageId: String(clientMessageId) } : {}),
        ...(descriptors.length > 0 ? { attachments: descriptors } : {})
      },
      replaceFromMessageId ? { replaceFromMessageId } : {}
    );
    return appended?.message ?? null;
  } catch (error) {
    logger.error('Chat user turn not materialized', {
      component: COMPONENT,
      chatId,
      runId,
      error: error.message
    });
    return null;
  }
}

/**
 * Write the assistant half of a turn and release the chat.
 *
 * Called once per turn at the single choke point before the ledger's
 * `run/end`, so every terminal shape — normal, aborted, error, passthrough
 * answer, malformed response — lands here with the same summary.
 *
 * The answer is appended first and the chat released after. `releaseRun`
 * clears `activeRunId` and raises `hasUnseenActivity` — together, "this chat
 * is idle and has an answer waiting" — and the two calls take the chat lock
 * separately, so there is a window between them. Releasing first puts a reader
 * in that window in front of a settled chat whose answer is not stored yet:
 * `GET /api/chats/:id` clears the unseen flag, returns a transcript without
 * the answer, and the flag never comes back. This order can only show a chat
 * as briefly still running, which the next poll corrects.
 *
 * Appending to a chat whose document is gone is safe in this order:
 * `appendMessage` warns and returns null rather than creating an orphan.
 *
 * "Released" is conditional on this run still owning the chat. A superseded
 * turn finishes after its replacement has already claimed the chat, and it
 * must not announce the chat idle while the replacement is generating, nor
 * push its answer behind the replacement's question — both are permanent, and
 * the second one is replayed to the model on every later turn.
 *
 * @param {Object} params
 * @param {import('./ChatRepository.js').default} params.repository
 * @param {string} params.chatId
 * @param {string} params.runId
 * @param {Object} params.summary - the turn outcome: `status`, `content`, `finishReason`,
 *   `usage`, and `error`/`errorInfo` on a failure
 * @param {boolean} params.clientConnected - whether an SSE client was attached when the
 *   turn ended, sampled with `hasChatClient()`; the emit result cannot tell you
 * @returns {Promise<Object|null>} the stored message, or null when nothing was written
 */
export async function materializeAssistantTurn({
  repository,
  chatId,
  runId,
  summary,
  clientConnected
}) {
  if (!repository) return null;
  const status = summary?.status;
  const content = typeof summary?.content === 'string' ? summary.content : '';
  const error = messageError(summary);
  const usage = normalizeUsage(summary?.usage);
  try {
    // A turn that paused for a clarification produced no answer — the question
    // is an interaction, not a message. Everything else is recorded, an empty
    // answer and an abort included, so the stored history says what happened.
    // The run is still released below either way, or the chat stays "running".
    const pausedWithoutAnswer = status === 'paused' && !content && !error;

    // Store the answer BEFORE announcing the run finished. `releaseRun` clears
    // `activeRunId` and raises `hasUnseenActivity` — together, "this chat is
    // idle and has an answer waiting" — and the two calls take the chat lock
    // separately, so there is a window between them. In the other order a
    // reader lands in that window and sees a settled chat whose answer is not
    // stored yet: `GET /api/chats/:id` then clears the unseen flag and returns
    // a transcript without the answer, and the flag never comes back. This
    // order can only ever show a chat as briefly still running, which the next
    // poll corrects.
    // The append gets its own catch so the release below is unconditional.
    // Sharing one try meant a rejecting `appendMessage` skipped `releaseRun`
    // entirely and landed in the outer catch, which only logs — leaving the
    // chat claiming a run that has ended, with nothing in the tree to correct
    // it. And it does reject: `appendMessage` runs under a 15 s lease with a
    // 5 s wait budget, so a worker killed mid-write guarantees the next waiter
    // times out. A chat stuck `running` then makes every later open replay a
    // dead run and spin on an empty placeholder. Losing the answer is bad;
    // losing the answer *and* wedging the chat is worse.
    let appended = null;
    if (!pausedWithoutAnswer) {
      try {
        appended = await repository.appendMessage(
          chatId,
          {
            role: 'assistant',
            content,
            ts: new Date().toISOString(),
            runId,
            finishReason: summary?.finishReason ?? null,
            ...(usage ? { usage } : {}),
            ...(error ? { error } : {})
          },
          // The end of the transcript for an ordinary turn, and the position
          // right after this run's own question for a superseded one.
          { insertAfterRunId: runId }
        );
      } catch (appendError) {
        logger.error('Chat answer not stored; releasing the run anyway', {
          component: COMPONENT,
          chatId,
          runId,
          error: appendError.message
        });
      }
    }

    const { chat } = await repository.releaseRun(chatId, runId, {
      activeRunId: null,
      status: status === 'error' ? 'error' : 'active',
      // Nobody was watching when the answer landed, so the history list marks
      // the chat until it is opened.
      hasUnseenActivity: !clientConnected
    });
    if (!chat) {
      logger.error('Chat assistant turn not materialized: no chat document', {
        component: COMPONENT,
        chatId,
        runId
      });
      return null;
    }
    return appended?.message ?? null;
  } catch (err) {
    logger.error('Chat assistant turn not materialized', {
      component: COMPONENT,
      chatId,
      runId,
      error: err.message
    });
    return null;
  }
}
