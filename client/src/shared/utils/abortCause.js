/**
 * Why a turn was stopped, in words.
 *
 * The server records a cause with every abort (`server/services/chat/abortCause.js`):
 * what stopped it, who, from where and when. This is what the viewer reads.
 */

/** Who stopped it, as the viewer may read it: "you", an administrator, or (to administrators) the user. */
function actorPhrase(t, actor, { userId, isAdmin }) {
  if (actor?.type === 'admin') return t('abortCauses.byAdmin', 'an administrator');
  if (actor?.type !== 'user' || !actor.id) return '';
  if (userId && actor.id === userId) return t('abortCauses.byYou', 'you');
  return isAdmin ? t('abortCauses.byUser', { id: actor.id, defaultValue: 'user {{id}}' }) : '';
}

/**
 * @param {Function} t - i18next `t`.
 * @param {{kind?: string, message?: string, actor?: {type?: string, id?: string}}|null} cause
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
