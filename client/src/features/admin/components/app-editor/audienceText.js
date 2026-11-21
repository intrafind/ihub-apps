// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Who can use an app, as the publish dialog says it. Pure: the content-access
 * view of the server goes in, a message key and its values come out.
 *
 * The view is the body of `GET /api/admin/content-access/apps/{id}`:
 * `{ scope, groups, audience: { allSignedIn, anonymous } }`. A full admin
 * (`scope: 'all'`) sees every group, a content admin (`scope: 'membership'`)
 * only the groups they manage. `audience` is computed over all groups for
 * both, so the sentence about everyone is true for both.
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
 * The sentence that says who will see the app.
 *
 * Order of precedence: everyone including people who are not signed in,
 * everyone who signs in, then the groups. A content admin never reads "No
 * group can use this app": the page sees only the groups they manage, so it
 * says that instead.
 *
 * @param {object|null|undefined} view - The content-access view.
 * @returns {{
 *   kind: 'everyone'|'everyoneSignedIn'|'groups'|'noGroups'|'noOwnGroups',
 *   key: string,
 *   values: {groups?: string},
 *   noteKey: string|null
 * }|null} The message key with its values, and the key of a second sentence
 *   where the first tells only part of it. `null` when the view does not say
 *   who can use the app (not loaded, or without `audience` or a known scope).
 *
 * @example
 * audienceText({ scope: 'membership', groups: [], audience: { allSignedIn: true, anonymous: false } });
 * // → { kind: 'everyoneSignedIn', key: 'admin.apps.edit.publish.everyoneSignedIn', values: {}, noteKey: null }
 */
export function audienceText(view) {
  const audience = view?.audience;
  if (!audience || typeof audience !== 'object') return null;

  const sentence = (kind, values = {}, noteKey = null) => ({
    kind,
    key: AUDIENCE_KEYS[kind],
    values,
    noteKey
  });

  if (audience.anonymous === true) return sentence('everyone');
  if (audience.allSignedIn === true) return sentence('everyoneSignedIn');

  const names = effectiveGroupNames(view);
  const groups = { groups: names.join(GROUP_SEPARATOR) };

  if (view.scope === 'all') {
    return names.length > 0 ? sentence('groups', groups) : sentence('noGroups');
  }
  if (view.scope === 'membership') {
    return names.length > 0
      ? sentence('groups', groups, AUDIENCE_KEYS.partial)
      : sentence('noOwnGroups');
  }
  return null;
}
