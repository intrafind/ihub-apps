/**
 * Chat routes — the durable-chat surface (#2304 §9).
 *
 *   GET    /api/chats            ?limit&cursor   the caller's chats, newest activity first
 *   GET    /api/chats/:chatId                    chat metadata + stored transcript
 *   PATCH  /api/chats/:chatId    { title }       rename a chat
 *   DELETE /api/chats/:chatId                    erase a chat, its transcript and its runs
 *
 * The turns themselves are written by `services/chat/chatMaterializer.js` off
 * the chat request path; nothing here creates or appends to a chat. This
 * router only lists, reads, renames and erases what that path stored.
 *
 * Two deliberate differences from the sibling `routes/runs.js`:
 *
 *  - **`authenticatedOnly`, not `authRequired`.** `authRequired` means "401
 *    only when anonymous access is switched off"; with `anonymousAuth.enabled`
 *    an unauthenticated caller reaches the handler with `req.user ===
 *    undefined`. Chats are owned resources, so the stricter guard is the
 *    correct one — and anonymous callers never own a stored chat anyway
 *    (`resolvePrincipal` mints a fresh id per call).
 *  - **404 for both unknown and not-yours.** Chat ids are client-minted and
 *    enumerable; a 403 on someone else's chat would turn every endpoint here
 *    into an existence oracle. `chatAccess.authorizeChat` collapses the two.
 *
 * No `@swagger` blocks: `routes/swagger.js` scans an explicit file list that
 * does not include this router (nor `runs.js`), so they would be inert.
 *
 * @module routes/chats
 */
import { authenticatedOnly } from '../middleware/authRequired.js';
import { buildServerPath } from '../utils/basePath.js';
import { validateIdForPath } from '../utils/pathSecurity.js';
import {
  sendBadRequest,
  sendErrorResponse,
  sendFailedOperationError,
  sendNotFound
} from '../utils/responseHelpers.js';
import configCache from '../configCache.js';
import runLog from '../services/loop/RunLog.js';
import { resolvePrincipal } from '../services/loop/runIdentity.js';
import { authorizeChat } from '../services/chat/chatAccess.js';
import { getChatRepository, MAX_TITLE_LENGTH } from '../services/chat/ChatRepository.js';
import { isChatPersistenceConfigured } from '../services/chat/chatPersistence.js';
import { StorageError } from '../storage/errors.js';
import logger from '../utils/logger.js';

const COMPONENT = 'ChatRoutes';

/**
 * Machine-readable code for "durable chats are not answering right now" —
 * the feature is off, an admin disabled `platform.chats`, or the storage
 * provider failed to come up. The client shows the ephemeral experience
 * rather than an error when it sees this.
 */
const UNAVAILABLE_CODE = 'CHAT_PERSISTENCE_UNAVAILABLE';

/**
 * How much of a submitted title survives to normalization. The global body
 * limit is megabytes and the repository normalizes by collapsing whitespace
 * with a regex over the whole string, so an unbounded title is cheap CPU for
 * the caller and expensive for the server. A window several times the stored
 * cap leaves the collapse room to still fill 200 characters.
 */
const TITLE_INPUT_WINDOW = MAX_TITLE_LENGTH * 4;

/**
 * Report that durable chats are unavailable. 503 rather than 404: the routes
 * exist, they just cannot serve anything until storage and the feature flag
 * agree, and a retry may well succeed.
 *
 * @param {import('express').Response} res - Express response.
 * @returns {import('express').Response}
 */
function sendPersistenceUnavailable(res) {
  return sendErrorResponse(res, 503, 'Chat persistence is unavailable', {
    details: { code: UNAVAILABLE_CODE }
  });
}

/**
 * Translate a storage failure into a response.
 *
 * The storage errors that carry an `httpStatus` were designed for exactly
 * this hand-off (a lock timeout is a 503, an unusable key a 400), and a bad
 * paging cursor is the caller's mistake, not a server fault. Everything else
 * is a genuine 500.
 *
 * @param {import('express').Response} res - Express response.
 * @param {Error} error - The thrown error.
 * @param {string} operation - Operation name for the 500 message and the log.
 * @returns {import('express').Response}
 */
function sendChatStorageError(res, error, operation) {
  if (error instanceof StorageError) {
    const status = error.httpStatus || (error.code === 'INVALID_CURSOR' ? 400 : null);
    if (status) {
      return sendErrorResponse(res, status, error.message, { details: { code: error.code } });
    }
  }
  return sendFailedOperationError(res, operation, error);
}

/**
 * The repository to serve this request from, or null once a 503 has been
 * sent. Both halves are checked: the policy answers "should we", the
 * repository answers "can we" — a provider that came up without a document or
 * lock facet is configured-but-unusable.
 *
 * @param {import('express').Response} res - Express response.
 * @returns {import('../services/chat/ChatRepository.js').ChatRepository|null}
 */
function requireRepository(res) {
  const repository = getChatRepository();
  const configured = isChatPersistenceConfigured(
    configCache.getFeatures(),
    configCache.getPlatform() || {}
  );
  if (!configured || !repository.isAvailable()) {
    sendPersistenceUnavailable(res);
    return null;
  }
  return repository;
}

/**
 * The caller's owner id, in the identity mode configured right now.
 *
 * Listing can only ever find chats written under the current mode. Reading
 * one is mode-agnostic — `authorizeChat` resolves the caller in the mode
 * recorded on the chat — but there is no index that spans modes, so chats
 * written before an admin changed `platform.runLog.identityMode` drop out of
 * the sidebar while remaining readable by id. That is the documented cost of
 * changing the mode on a live installation.
 *
 * @param {Object} user - `req.user`; guaranteed non-anonymous by
 *   `authenticatedOnly`.
 * @returns {Promise<string>} Owner id to scope the listing by.
 */
async function resolveOwnerId(user) {
  const principal = await resolvePrincipal(user, { mode: runLog.identityMode() });
  return principal.id;
}

/**
 * Authorize a chat for this caller and require that it exists.
 *
 * `authorizeChat` deliberately reports an absent chat as authorized — the
 * write path calls it before creating one. Every route here addresses an
 * existing chat, so absent is 404.
 *
 * @param {string} chatId - Chat id from the path.
 * @param {Object} user - `req.user`.
 * @param {import('../services/chat/ChatRepository.js').ChatRepository} repository - Repository.
 * @param {'read'|'write'} [intent='read'] - What the caller is about to do.
 *   The admin bypass covers reads only, so a rename or a delete of someone
 *   else's chat is refused even for an admin.
 * @returns {Promise<{chat: Object, viaAdmin: boolean}|null>} The chat and how
 *   it was authorized, or null once a 404 is due.
 */
async function loadOwnedChat(chatId, user, repository, intent = 'read') {
  const auth = await authorizeChat(chatId, user, { repository, intent });
  if (!auth.ok || !auth.chat) return null;
  return { chat: auth.chat, viaAdmin: auth.viaAdmin === true };
}

/**
 * Register the `/api/chats` endpoints.
 *
 * Call it next to `registerRunRoutes(app)` in `server/server.js`; the paths
 * are built with `buildServerPath` so a subpath deployment works unchanged.
 *
 * @param {import('express').Application} app - Express application.
 * @returns {void}
 */
export default function registerChatRoutes(app) {
  app.get(buildServerPath('/api/chats'), authenticatedOnly, async (req, res) => {
    try {
      const repository = requireRepository(res);
      if (!repository) return;
      const ownerId = await resolveOwnerId(req.user);
      // The chat documents go out exactly as stored. App name, colour and icon
      // are joined on the client from the apps list it already holds, so this
      // endpoint stays independent of app configuration.
      const { items, nextCursor } = await repository.listChats(ownerId, {
        limit: req.query.limit,
        cursor: typeof req.query.cursor === 'string' ? req.query.cursor : null
      });
      res.json({ items, nextCursor });
    } catch (error) {
      sendChatStorageError(res, error, 'list chats');
    }
  });

  app.get(buildServerPath('/api/chats/:chatId'), authenticatedOnly, async (req, res) => {
    try {
      const { chatId } = req.params;
      if (!validateIdForPath(chatId, 'chat', res)) return;
      const repository = requireRepository(res);
      if (!repository) return;
      const access = await loadOwnedChat(chatId, req.user, repository, 'read');
      if (!access) return sendNotFound(res, 'Chat');
      const { chat, viaAdmin } = access;
      const stored = await repository.getMessages(chatId);
      // Opening a chat is what "seen" means — for its owner. Only write when
      // the flag is actually set: the clear is a locked read-modify-write, and
      // a plain read should not contend with a turn that is producing into
      // this chat. An admin reading someone else's chat clears nothing: the
      // owner has not seen the answer, and a support read should not tell them
      // they have.
      const seen =
        chat.hasUnseenActivity && !viaAdmin ? await repository.clearUnseen(chatId) : null;
      // `messages` is the array, not the stored envelope — a hydrating client
      // should not have to reach through `messages.messages`. The document's
      // schema version rides alongside it so a future migration is visible.
      res.json({ chat: seen || chat, messages: stored.messages, version: stored.version });
    } catch (error) {
      sendChatStorageError(res, error, 'get chat');
    }
  });

  app.patch(buildServerPath('/api/chats/:chatId'), authenticatedOnly, async (req, res) => {
    try {
      const { chatId } = req.params;
      if (!validateIdForPath(chatId, 'chat', res)) return;
      const title = req.body?.title;
      if (typeof title !== 'string') {
        return sendBadRequest(res, 'title is required and must be a string');
      }
      const repository = requireRepository(res);
      if (!repository) return;
      const access = await loadOwnedChat(chatId, req.user, repository, 'write');
      if (!access) return sendNotFound(res, 'Chat');
      // The repository caps and marks the title as user-set so no later turn
      // derives over it; an empty title clears that mark instead.
      const renamed = await repository.renameChat(chatId, title.slice(0, TITLE_INPUT_WINDOW));
      if (!renamed) return sendNotFound(res, 'Chat');
      res.json({ chat: renamed });
    } catch (error) {
      sendChatStorageError(res, error, 'rename chat');
    }
  });

  app.delete(buildServerPath('/api/chats/:chatId'), authenticatedOnly, async (req, res) => {
    try {
      const { chatId } = req.params;
      if (!validateIdForPath(chatId, 'chat', res)) return;
      const repository = requireRepository(res);
      if (!repository) return;
      const access = await loadOwnedChat(chatId, req.user, repository, 'write');
      if (!access) return sendNotFound(res, 'Chat');
      // The chat document is the only place a chat's runs are recorded, so it
      // has to be read before it is removed — `deleteChat` returns them for
      // exactly this reason.
      const { runIds } = await repository.deleteChat(chatId);
      // `deleteRun` is the single entry point that cascades a run's ledger
      // file, its spill directory and its pending interactions. One run that
      // refuses to go must not strand the rest, so each is attempted on its
      // own and a failure is logged rather than thrown: the chat itself is
      // already gone, and reporting a 500 would invite a retry that can only
      // 404.
      for (const runId of runIds) {
        try {
          await runLog.deleteRun(runId);
        } catch (error) {
          logger.error('Failed to cascade a chat delete into one of its runs', {
            component: COMPONENT,
            chatId,
            runId,
            error: error.message
          });
        }
      }
      // True even when a concurrent delete won the race: the postcondition the
      // caller asked for — this chat no longer exists — holds either way.
      res.json({ deleted: true });
    } catch (error) {
      sendChatStorageError(res, error, 'delete chat');
    }
  });
}
