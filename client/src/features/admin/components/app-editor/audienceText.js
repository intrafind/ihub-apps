// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Who can use an app, as the publish dialog says it. Pure: the content-access
 * view of the server goes in, message keys and their values come out.
 *
 * The view is the body of `GET /api/admin/content-access/apps/{id}`:
 * `{ scope, groups, audience: { allSignedIn, anonymous } }`. A full admin
 * (`scope: 'all'`) sees every group, a content admin (`scope: 'membership'`)
 * only the groups they manage. `audience` is computed over all groups for
 * both, so the sentences about everyone are true for both.
 *
 * @module features/admin/components/app-editor/audienceText
 */

/**
 * The sentences of the publish dialog, by case. Written out in full so that
 * the i18n test finds every key.
 */
export const AUDIENCE_KEYS = Object.freeze({
  everyone: 'admin.apps.edit.publish.everyone',
  everyoneSignedIn: 'admin.apps.edit.publish.everyoneSignedIn',
  notSignedIn: 'admin.apps.edit.publish.notSignedIn',
  groups: 'admin.apps.edit.publish.groups',
  noGroups: 'admin.apps.edit.publish.noGroups',
  noOwnGroups: 'admin.apps.edit.publish.noOwnGroups',
  partial: 'admin.apps.edit.publish.partial'
});

const GROUP_SEPARATOR = ', ';

/**
 * The names of the groups whose members get the app, in the view's order.
 *
 * A group that people carry without being a member (the group of every
 * signed-in user, the anonymous group) is left out: `audience` stands for it,
 * and its name ("Authenticated") is not a team anybody belongs to.
 *
 * @param {object|null|undefined} view - The content-access view.
 * @returns {string[]}
 */
export function effectiveGroupNames(view) {
  const rows = Array.isArray(view?.groups) ? view.groups : [];
  return rows
    .filter(row => row && row.effective === true && row.implicit !== true)
    .map(row => (typeof row.name === 'string' && row.name ? row.name : row.id))
    .filter(name => typeof name === 'string' && name);
}

/**
 * The sentences that say who will see the app.
 *
 * Order of precedence:
 *
 * 1. Everyone, including people who are not signed in: the anonymous groups
 *    and the group of every signed-in user both grant the app.
 * 2. Everyone who signs in.
 * 3. The groups. A content admin never reads "No group can use this app": the
 *    page sees only the groups they manage, so it says that instead.
 *
 * The two facts of `audience` are independent. On an installation where the
 * group of signed-in users does not inherit from the anonymous one, an app can
 * be open to people who are not signed in and to nobody else. The first
 * sentence then says that, and the groups follow where there are any.
 *
 * @param {object|null|undefined} view - The content-access view.
 * @returns {{
 *   kind: 'everyone'|'everyoneSignedIn'|'notSignedIn'|'groups'|'noGroups'|'noOwnGroups',
 *   sentences: Array<{key: string, values: {groups?: string}}>
 * }|null} The case and its sentences in reading order, each a message key
 *   with its values. `null` when the view does not say who can use the app
 *   (not loaded, without `audience`, or with groups of an unknown scope).
 *
 * @example
 * audienceText({ scope: 'membership', groups: [], audience: { allSignedIn: true, anonymous: false } });
 * // → { kind: 'everyoneSignedIn',
 * //     sentences: [{ key: 'admin.apps.edit.publish.everyoneSignedIn', values: {} }] }
 */
export function audienceText(view) {
  const audience = view?.audience;
  if (!audience || typeof audience !== 'object') return null;

  const sentence = (name, values = {}) => ({ key: AUDIENCE_KEYS[name], values });
  const anonymous = audience.anonymous === true;

  if (audience.allSignedIn === true) {
    const kind = anonymous ? 'everyone' : 'everyoneSignedIn';
    return { kind, sentences: [sentence(kind)] };
  }

  const all = view.scope === 'all';
  const membership = view.scope === 'membership';
  const names = all || membership ? effectiveGroupNames(view) : [];
  const groups =
    names.length > 0 ? [sentence('groups', { groups: names.join(GROUP_SEPARATOR) })] : [];
  // A content admin sees a part of the groups; the page says so.
  const partial = membership ? [sentence('partial')] : [];

  if (anonymous) {
    return { kind: 'notSignedIn', sentences: [sentence('notSignedIn'), ...groups, ...partial] };
  }
  if (!all && !membership) return null;
  if (groups.length > 0) return { kind: 'groups', sentences: [...groups, ...partial] };
  const kind = all ? 'noGroups' : 'noOwnGroups';
  return { kind, sentences: [sentence(kind)] };
}
