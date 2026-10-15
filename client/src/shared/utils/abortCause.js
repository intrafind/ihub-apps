/**
 * Why a turn was stopped, in words.
 *
 * The server records a cause with every abort (`server/services/chat/abortCause.js`):
 * what stopped it, who, from where and when. This is what the viewer reads.
 */

/**
 * Who stopped it, as the viewer may read it: "you", an administrator, or (to
 * administrators) the user.
 *
 * "You" is the viewer's own id matching the actor's, or the server saying the
 * stopper was the owner (`actor.owner`) to a viewer who is not an administrator
 * — an owner's id may be a pseudonym the browser cannot match to its own.
 */
function actorPhrase(t, actor, { userId, isAdmin }) {
  if (!actor || (actor.type !== 'user' && actor.type !== 'admin')) return '';
  const own = (userId && actor.id === userId) || (actor.owner === true && !isAdmin);
  if (own) return t('abortCauses.byYou', 'you');
  if (isAdmin && actor.id) {
    return t('abortCauses.byUser', { id: actor.id, defaultValue: 'user {{id}}' });
  }
  return actor.type === 'admin' ? t('abortCauses.byAdmin', 'an administrator') : '';
}

/**
 * @param {Function} t - i18next `t`.
 * @param {{kind?: string, message?: string, actor?: {type?: string, id?: string, owner?: boolean}}|null} cause
 * @param {Object} [viewer]
 * @param {string} [viewer.userId] - The signed-in user's id; the person who stopped it reads "you".
 * @param {boolean} [viewer.isAdmin] - Administrators also see which user it was.
 * @returns {string} e.g. "Stopped from the chat (you)"; empty without a cause
 */
export function abortCauseText(t, cause, viewer = {}) {
  if (!cause || typeof cause !== 'object') return '';
  const base = cause.kind
    ? t(`abortCauses.${cause.kind}`, { defaultValue: cause.message || '' })
    : cause.message || '';
  const by = actorPhrase(t, cause.actor, viewer);
  return by ? `${base} (${by})` : base;
}
