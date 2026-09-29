/**
 * Chat import — turn a transcript another surface holds into a durable chat.
 *
 * The Outlook task pane and the browser-extension side panel keep their
 * conversation in the client (every turn is sent `ephemeral`), so there is
 * nothing on the server for the web app to open. "Open in web" is therefore an
 * explicit act of storing: the pane posts what was typed and answered, this
 * module writes it as a chat the web app already knows how to show
 * (`/apps/:appId/c/:chatId`) and the user continues it there like any other.
 *
 * Only the conversation is stored — `role` and `content`. The host item the
 * pane attached to the turns (the open email, its attachments) never reaches
 * the server as chat content and is deliberately not part of an import: a
 * stored transcript is replayed to the model verbatim, and an email body
 * pushed into it would also be readable by everything that reads chats.
 *
 * Nothing here decides *whether* a chat may be stored (that is the route,
 * through `chatPersistence`) or *who* may use which app.
 *
 * @module services/chat/chatImport
 */
import { randomUUID } from 'node:crypto';

/** Most messages one import may carry. A pane conversation is a handful. */
export const MAX_IMPORT_MESSAGES = 200;

/** Longest model id accepted; the id is echoed back into the chat document. */
const MAX_MODEL_ID_LENGTH = 200;

/** Roles a transcript may contain. Anything else is host bookkeeping. */
const IMPORTABLE_ROLES = new Set(['user', 'assistant']);

/**
 * An error the caller can act on: `code` says what was wrong with the input.
 */
export class ChatImportError extends Error {
  /**
   * @param {string} code - Machine-readable reason.
   * @param {string} message - Human-readable reason.
   */
  constructor(code, message) {
    super(message);
    this.name = 'ChatImportError';
    this.code = code;
  }
}

/**
 * The timestamp to record for an imported message: the one the client held if
 * it is a real date, otherwise the moment of the import. A message never gets a
 * timestamp in the future, so the history list cannot pin a chat to the top.
 *
 * @param {unknown} value - Client-supplied timestamp.
 * @param {number} now - Import time, ms since epoch.
 * @returns {string} ISO timestamp.
 */
function timestampOf(value, now) {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return new Date(Number.isFinite(parsed) && parsed <= now ? parsed : now).toISOString();
}

/**
 * Validate and normalize the transcript of an import.
 *
 * Empty messages are dropped rather than refused: the pane's own transcript
 * holds placeholders (a stopped or failed turn has no content) and a provider
 * rejects a blank message on replay. A transcript with nothing left is refused.
 *
 * @param {unknown} messages - `messages` as received.
 * @returns {Array<{role: string, content: string, ts?: unknown}>} Importable messages, oldest first.
 * @throws {ChatImportError} `INVALID_MESSAGES`, `TOO_MANY_MESSAGES` or `EMPTY_TRANSCRIPT`.
 */
export function normalizeImportMessages(messages) {
  if (!Array.isArray(messages)) {
    throw new ChatImportError('INVALID_MESSAGES', 'messages must be an array');
  }
  if (messages.length > MAX_IMPORT_MESSAGES) {
    throw new ChatImportError(
      'TOO_MANY_MESSAGES',
      `A chat can be imported with at most ${MAX_IMPORT_MESSAGES} messages`
    );
  }
  const importable = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw new ChatImportError('INVALID_MESSAGES', 'Every message must be an object');
    }
    if (typeof message.role !== 'string' || typeof message.content !== 'string') {
      throw new ChatImportError('INVALID_MESSAGES', 'Every message needs a role and a content');
    }
    if (!IMPORTABLE_ROLES.has(message.role)) continue;
    if (!message.content.trim()) continue;
    importable.push(message);
  }
  if (importable.length === 0) {
    throw new ChatImportError('EMPTY_TRANSCRIPT', 'There is no conversation to import');
  }
  return importable;
}

/**
 * Store a transcript as a new chat owned by `ownerId`.
 *
 * The chat id is minted here, in the web app's own `chat-<uuid>` shape, and
 * never taken from the caller: an import can therefore neither overwrite nor
 * append to a chat that already exists.
 *
 * @param {Object} params
 * @param {import('./ChatRepository.js').ChatRepository} params.repository - Chat repository.
 * @param {string} params.ownerId - Run principal that owns the chat.
 * @param {string} params.identityMode - The mode `ownerId` was resolved in.
 * @param {string} params.appId - App the conversation was held with.
 * @param {string} [params.modelId] - Model the conversation last used.
 * @param {Array<{role: string, content: string, ts?: unknown}>} params.messages - Output of
 *   {@link normalizeImportMessages}.
 * @param {() => number} [params.clock] - Time source, for tests.
 * @returns {Promise<Object>} The stored chat document.
 * @throws {ChatImportError} `STORAGE_UNAVAILABLE` when the chat could not be written.
 */
export async function importChat({
  repository,
  ownerId,
  identityMode,
  appId,
  modelId,
  messages,
  clock = Date.now
}) {
  const chatId = `chat-${randomUUID()}`;
  const now = clock();
  const chat = await repository.ensureChat({
    chatId,
    ownerId,
    identityMode,
    appId,
    modelId:
      typeof modelId === 'string' && modelId ? modelId.slice(0, MAX_MODEL_ID_LENGTH) : undefined
  });
  if (!chat) {
    throw new ChatImportError('STORAGE_UNAVAILABLE', 'The chat could not be stored');
  }
  try {
    for (const message of messages) {
      const stored = await repository.appendMessage(chatId, {
        role: message.role,
        content: message.content,
        ts: timestampOf(message.ts, now)
      });
      if (!stored) {
        throw new ChatImportError('STORAGE_UNAVAILABLE', 'The chat could not be stored');
      }
    }
  } catch (error) {
    // Half a conversation in the history is worse than none: the user would
    // open it and continue from a transcript that stops mid-way. Best effort —
    // the chat is brand new, so a failed cleanup leaves nothing else behind
    // than the retention sweep already collects.
    await repository.deleteChat(chatId).catch(() => {});
    throw error;
  }
  // The document as it stands after the appends: the message count, the derived
  // title and the last-message time are what the caller and the history show.
  return (await repository.getChat(chatId)) || chat;
}
