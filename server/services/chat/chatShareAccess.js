/**
 * Share access — who may open a share link.
 *
 * The mirror of `chatAccess.authorizeChat`, for links instead of chats. A
 * share token is server-minted and unguessable, so unlike a chat id it *is* a
 * capability — but only in `public` mode. The other two modes bind it to a
 * sign-in, and a `users` share further to the people the owner named.
 *
 * Two answers besides "yes":
 *
 *  - **404** for a link that is missing, revoked, expired or used up, and for
 *    a signed-in caller who is not on a `users` share's list. One answer for
 *    all of them, so a dead link never confirms that it once worked.
 *  - **401** for an anonymous caller on a share that needs a sign-in. That is
 *    the one case the client can do something about — send the viewer to the
 *    login page and back to the link.
 *
 * The owner may always open their own link, in every mode — it is how they
 * check what they are about to send — and an admin may read it the way they
 * may read every chat. Neither of those opens counts as a view.
 *
 * @module services/chat/chatShareAccess
 */
import { isAdminUser, isAnonymousUser, resolvePrincipal } from '../loop/runIdentity.js';
import { isShareActive } from './chatSharing.js';

/**
 * Decide whether `user` may open `share`.
 *
 * @param {Object|null} share - Share document, or null when none was found.
 * @param {Object|undefined} user - `req.user`; undefined or `anonymous` for
 *   an anonymous caller.
 * @param {Object} [options]
 * @param {number} [options.now] - Clock, for tests.
 * @returns {Promise<{ok: true, viewerId: string|null, counts: boolean, viaOwner: boolean,
 *   viaAdmin: boolean}|{ok: false, status: 401|404}>}
 *   `viewerId` is the signed-in caller's id (null for an anonymous viewer of a
 *   public share); `counts` says whether this open is a view the owner asked
 *   to have tracked — the owner's and an admin's own opens are not.
 */
export async function authorizeShareView(share, user, { now = Date.now() } = {}) {
  if (!isShareActive(share, now)) return { ok: false, status: 404 };

  const anonymous = isAnonymousUser(user);
  const viewerId = anonymous ? null : String(user.id);

  if (!anonymous) {
    const me = await resolvePrincipal(user, { mode: share.identityMode || 'default' });
    if (me.id === share.ownerId) {
      return { ok: true, viewerId, counts: false, viaOwner: true, viaAdmin: false };
    }
    if (isAdminUser(user)) {
      return { ok: true, viewerId, counts: false, viaOwner: false, viaAdmin: true };
    }
  }

  switch (share.mode) {
    case 'public':
      return { ok: true, viewerId, counts: true, viaOwner: false, viaAdmin: false };
    case 'authenticated':
      if (anonymous) return { ok: false, status: 401 };
      return { ok: true, viewerId, counts: true, viaOwner: false, viaAdmin: false };
    case 'users': {
      if (anonymous) return { ok: false, status: 401 };
      const recipients = Array.isArray(share.recipients) ? share.recipients : [];
      if (!recipients.includes(viewerId)) return { ok: false, status: 404 };
      return { ok: true, viewerId, counts: true, viaOwner: false, viaAdmin: false };
    }
    default:
      return { ok: false, status: 404 };
  }
}

export default authorizeShareView;
