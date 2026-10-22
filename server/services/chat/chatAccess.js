// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

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
 * **The admin bypass is read-only.** It is documented and tested as a read
 * affordance — admins see every run — but the decision it returns used to be a
 * single verb-less boolean, and every write path authorizes through the same
 * call. That meant an admin holding a chat id from a support ticket or a
 * shared link could append a turn to someone else's conversation (stored with
 * no record of who actually sent it), rename it, or delete it and cascade its
 * ledger, with no audit entry anywhere. Callers now declare their intent and
 * a write by a non-owner is refused like any other.
 *
 * @module services/chat/chatAccess
 */
import { isAnonymousUser, isAdminUser } from '../loop/runIdentity.js';
import { resolveChatOwner } from './chatOwner.js';
import { getChatRepository, isPersistableChatId } from './ChatRepository.js';

/**
 * Whether `user` may use the user project a chat lives in. Loaded lazily: the
 * project modules import the chat repository for their own cascade.
 *
 * Only a user project opens its chats to its members, and only while the
 * `userProjects` feature is on: an admin project is configuration linked to
 * apps, never a container that shares transcripts, and switching the feature
 * off revokes the member reads with it (the saved association stays).
 */
async function isProjectMember(projectId, user) {
  try {
    const [
      { getProjectRepository },
      { callerContext, permissionsFor },
      { isUserProjectsConfigured },
      { default: configCache }
    ] = await Promise.all([
      import('../projects/ProjectRepository.js'),
      import('../../middleware/projectAccess.js'),
      import('../projects/projectSettings.js'),
      import('../../configCache.js')
    ]);
    if (!isUserProjectsConfigured(configCache.getFeatures())) return false;
    const project = await getProjectRepository().get(projectId);
    if (!project || project.ownership !== 'user') return false;
    return permissionsFor(project, user, callerContext(user)).canUse === true;
  } catch {
    return false;
  }
}

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
 * @param {'read'|'write'} [options.intent='read'] - What the caller is about to
 *   do. The admin bypass applies to `read` only; an admin acting on a chat
 *   they do not own is refused a `write` exactly as any other non-owner is.
 * @returns {Promise<{ok: true, chat: Object|null, viaAdmin?: boolean}|{ok: false, status: 404}>}
 *   `chat` is null when nothing is stored for this id — storage is down, the
 *   id is not storable, or the chat is new. `viaAdmin` marks a decision
 *   that rests on the bypass rather than on ownership, so a caller can skip
 *   the side effects that belong to the owner reading their own chat.
 */
export async function authorizeChat(
  chatId,
  user,
  { repository = getChatRepository(), intent = 'read' } = {}
) {
  // An id the store cannot key (a headless `agent:<runId>:<hex>` chat) has no
  // stored document by construction, so there is nothing to own.
  if (!repository || !isPersistableChatId(chatId)) return { ok: true, chat: null };

  const chat = await repository.getChat(chatId);
  if (!chat) return { ok: true, chat: null };

  // Ownership first: an admin reading their own chat is its owner reading it,
  // with the owner's side effects (the unseen badge clears). The bypass only
  // marks a read that rests on it. An anonymous caller owns the chats of its
  // guest identity, and nothing at all without one.
  const me = await resolveChatOwner(user, { mode: chat.identityMode || 'default' });
  if (me && me.id === chat.ownerId) return { ok: true, chat };
  if (isAnonymousUser(user)) return { ok: false, status: 404 };
  // An admin who is not the owner may read, never write — a write gets the
  // same 404 as anyone else.
  if (isAdminUser(user) && intent === 'read') return { ok: true, chat, viaAdmin: true };
  // A chat inside a project is readable by the project's members (#1036,
  // spec 1 §6.4): the project page lists them, and a member opens another's
  // chat read-only. Never a write, and never the live stream: `viaProject`
  // lets the stream routes keep the member at the transcript.
  if (intent === 'read' && chat.projectId && (await isProjectMember(chat.projectId, user))) {
    return { ok: true, chat, viaProject: true };
  }
  return { ok: false, status: 404 };
}
