/**
 * Chat access — who may read or write a persisted chat.
 *
 * The shape mirrors `services/loop/runAccess.authorizeLedgerRun` with two
 * deliberate differences:
 *
 *  - **404 for both unknown and not-yours.** Chat ids are client-minted and
 *    enumerable, so answering 403 for someone else's chat and 404 for a
 *    nonexistent one turns the endpoint into an existence oracle.
 *  - **An absent chat is authorized.** A chat that has not been stored yet is
 *    not somebody else's chat; the caller is about to create it. Returning
 *    404 here would make the first turn of every new chat fail.
 *
 * The caller is resolved in the identity mode recorded *on the chat*, not the
 * mode configured right now. An admin switching `platform.runLog.identityMode`
 * would otherwise orphan every chat written before the switch.
 *
 * @module services/chat/chatAccess
 */
import { resolvePrincipal, isAnonymousUser, isAdminUser } from '../loop/runIdentity.js';
import { getChatRepository, isPersistableChatId } from './ChatRepository.js';

/**
 * Decide whether `user` may act on chat `chatId`.
 *
 * A storage failure is not caught: an authorization decision that cannot read
 * the owner must fail closed, and a rejection surfaces as a 500 rather than
 * as access granted.
 *
 * @param {string} chatId - Chat id from the request.
 * @param {Object} user - `req.user`, possibly undefined for an anonymous
 *   caller when `anonymousAuth.enabled`.
 * @param {Object} [options]
 * @param {import('./ChatRepository.js').ChatRepository} [options.repository] -
 *   Repository to read through; defaults to the process-wide one.
 * @returns {Promise<{ok: true, chat: Object|null}|{ok: false, status: 404}>}
 *   `chat` is null when nothing is stored for this id — persistence is off,
 *   the id is not storable, or the chat is new.
 */
export async function authorizeChat(chatId, user, { repository = getChatRepository() } = {}) {
  // An id the store cannot key (a headless `agent:<runId>:<hex>` chat) has no
  // stored document by construction, so there is nothing to own.
  if (!repository || !isPersistableChatId(chatId)) return { ok: true, chat: null };

  const chat = await repository.getChat(chatId);
  if (!chat) return { ok: true, chat: null };

  if (isAdminUser(user)) return { ok: true, chat };
  // An anonymous caller never owns a stored chat: anonymous principals get a
  // fresh random id per resolution, so no comparison could ever match.
  if (isAnonymousUser(user)) return { ok: false, status: 404 };

  const me = await resolvePrincipal(user, { mode: chat.identityMode || 'default' });
  if (me.id === chat.ownerId) return { ok: true, chat };
  return { ok: false, status: 404 };
}
