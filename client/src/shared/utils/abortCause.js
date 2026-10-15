/**
 * Why a turn was stopped, in words.
 *
 * The server records a cause with every abort (`server/services/chat/abortCause.js`):
 * what stopped it, who, from where and when. This is what the viewer reads.
 */

/**
 * @param {Function} t - i18next `t`.
 * @param {{kind?: string, message?: string, actor?: {type?: string, id?: string}}|null} cause
 * @param {Object} [viewer]
 * @param {string} [viewer.userId] - The signed-in user's id; the person who stopped it reads "you".
 * @param {boolean} [viewer.isAdmin] - Administrators also see which user it was.
 * @returns {string} e.g. "Stopped from the chat (you)"; empty without a cause
 */
export function abortCauseText(t, cause, { userId, isAdmin } = {}) {
  if (!cause || typeof cause !== 'object') return '';
  const base = cause.kind
    ? t(`abortCauses.${cause.kind}`, { defaultValue: cause.message || '' })
    : cause.message || '';
  const actor = cause.actor || {};
  let by = '';
  if (actor.type === 'admin') {
    by = t('abortCauses.byAdmin', 'an administrator');
  } else if (actor.type === 'user' && actor.id) {
    if (userId && actor.id === userId) by = t('abortCauses.byYou', 'you');
    else if (isAdmin) by = t('abortCauses.byUser', { id: actor.id, defaultValue: 'user {{id}}' });
  }
  return by ? `${base} (${by})` : base;
}
