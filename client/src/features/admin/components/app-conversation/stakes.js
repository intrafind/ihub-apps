// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The stakes line of a proposed change (plan 2.8): who gets the change once
 * it is applied, and which connected systems the app can use. Apply saves at
 * once, also for a published or shared app (owner decision 1), so the card
 * says this above the button.
 *
 * Pure: the page's facts go in, message keys and their values come out.
 *
 * @module features/admin/components/app-conversation/stakes
 */

import { effectiveGroupNames } from '../app-editor/audienceText';
import { STAKES_KEYS } from './conversationState';

const SEPARATOR = ', ';

/** The sentence that names the connected systems, when there are any. */
function integrationsLine(names) {
  const list = (Array.isArray(names) ? names : []).filter(name => typeof name === 'string' && name);
  return list.length > 0
    ? [{ key: STAKES_KEYS.integrations, values: { names: list.join(SEPARATOR) } }]
    : [];
}

/**
 * The stakes line of an app of the admin area.
 *
 * @param {object} facts
 * @param {boolean} facts.published - The saved app is published.
 * @param {object|null} [facts.accessView] - The content-access view (`useAppAccess`).
 * @param {string[]} [facts.integrationNames] - The connected systems the app can use.
 * @returns {Array<{key: string, values?: object}>}
 *
 * @example
 * adminStakes({ published: false });
 * // → [{ key: 'admin.apps.conversation.stakes.notPublished' }]
 */
export function adminStakes({ published, accessView, integrationNames } = {}) {
  const audience = accessView?.audience;
  let line;
  if (!published) line = { key: STAKES_KEYS.notPublished };
  else if (audience?.allSignedIn === true && audience?.anonymous === true)
    line = { key: STAKES_KEYS.publishedEveryone };
  else if (audience?.allSignedIn === true) line = { key: STAKES_KEYS.publishedSignedIn };
  else {
    const groups = effectiveGroupNames(accessView);
    line =
      groups.length > 0
        ? { key: STAKES_KEYS.publishedGroups, values: { groups: groups.join(SEPARATOR) } }
        : { key: STAKES_KEYS.published };
  }
  return [line, ...integrationsLine(integrationNames)];
}

/**
 * The stakes line of a personal app.
 *
 * @param {object} facts
 * @param {{ users?: number, groups?: number, everyone?: boolean }|null} [facts.sharedWith] -
 *   As `GET /api/apps/{appId}` answers it.
 * @param {string[]} [facts.integrationNames]
 * @returns {Array<{key: string, values?: object}>}
 *
 * @example
 * personalStakes({ sharedWith: { users: 2, groups: 1 } });
 * // → [{ key: 'admin.apps.conversation.stakes.shared', values: { count: 3 } }]
 */
export function personalStakes({ sharedWith, integrationNames } = {}) {
  const count =
    (Number.isInteger(sharedWith?.users) ? sharedWith.users : 0) +
    (Number.isInteger(sharedWith?.groups) ? sharedWith.groups : 0);
  let line;
  if (sharedWith?.everyone === true) line = { key: STAKES_KEYS.sharedEveryone };
  else if (count > 0) line = { key: STAKES_KEYS.shared, values: { count } };
  else line = { key: STAKES_KEYS.onlyYou };
  return [line, ...integrationsLine(integrationNames)];
}
