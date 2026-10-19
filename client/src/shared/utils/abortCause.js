// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Why a turn was stopped, in words.
 *
 * The server records a cause with every abort (`server/services/chat/abortCause.js`):
 * what stopped it, who, from where and when. This is what the viewer reads.
 */

/** The actor types that are a person: shown by name or as "you". */
const PERSON_TYPES = new Set(['user', 'admin']);

/**
 * Who stopped it, as the viewer may read it: "you", an administrator, or (to
 * administrators) the user.
 *
 * "You" is the viewer's own id matching the actor's, or the server saying the
 * stopper was the owner (`actor.owner`) to a viewer who is not an administrator
 * — an owner's id may be a pseudonym the browser cannot match to its own.
 */
function actorPhrase(t, actor, viewer) {
  if (!PERSON_TYPES.has(actor?.type)) return '';
  if (isViewer(actor, viewer)) return t('abortCauses.byYou', 'you');
  return nameForAdmin(t, actor, viewer) || genericPhrase(t, actor);
}

/** What anyone may be told: an administrator acted; a user's identity stays private. */
function genericPhrase(t, actor) {
  return actor.type === 'admin' ? t('abortCauses.byAdmin', 'an administrator') : '';
}

/** The viewer is the actor: the same id, or the owner (whose id may be a pseudonym) to a non-admin. */
function isViewer(actor, { userId, isAdmin }) {
  if (userId && actor.id === userId) return true;
  return actor.owner === true && !isAdmin;
}

/** Administrators are told which user it was. */
function nameForAdmin(t, actor, { isAdmin }) {
  if (!isAdmin || !actor.id) return '';
  return t('abortCauses.byUser', { id: actor.id, defaultValue: 'user {{id}}' });
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
  const base = kindText(t, cause);
  const by = actorPhrase(t, cause.actor, viewer);
  return by ? `${base} (${by})` : base;
}

/** What stopped it: this client's wording for the kind, else the sentence the server stored. */
function kindText(t, cause) {
  const stored = cause.message || '';
  return cause.kind ? t(`abortCauses.${cause.kind}`, { defaultValue: stored }) : stored;
}
