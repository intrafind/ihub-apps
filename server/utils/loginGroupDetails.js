// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { loadGroupMapping } from './authorization.js';
import logger from './logger.js';

/**
 * Upper bound on the identity-provider groups recorded per login. Entra ID
 * stops listing groups in a token at 200 (group overage), and a directory
 * lookup can return far more; past this cap only the total is kept, so one
 * login cannot bloat the audit log.
 */
export const MAX_EXTERNAL_GROUPS = 200;

function uniqueStrings(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter(value => typeof value === 'string' && value.length > 0))];
}

/**
 * Describe where a user's groups came from at login, for the `details` of the
 * login audit entry. The admin opens that entry to see which groups the
 * identity provider sent (the token claim, or the directory for LDAP and
 * NTLM), which iHub groups each of them mapped to, and which groups an admin
 * assigned by hand. The effective groups are the entry's `actor.groups`.
 *
 * The mapping is looked up again here with the same exact-name rule
 * `mapExternalGroups()` applies, so each external group carries the iHub
 * groups it granted.
 *
 * Display only: authorization keeps using the groups of the current token.
 *
 * @param {{external?: string[], manual?: string[]}|undefined} loginGroups -
 *   Set by `validateAndPersistExternalUser()`.
 * @returns {{groups: {external: Array<{name: string, mappedTo: string[]}>,
 *   externalTotal?: number, manual: string[]}}|undefined} undefined when the
 *   login carried no group information.
 */
export function buildLoginGroupDetails(loginGroups) {
  if (!loginGroups || typeof loginGroups !== 'object') return undefined;

  const externalNames = uniqueStrings(loginGroups.external);
  const manual = uniqueStrings(loginGroups.manual);

  let mapping = {};
  if (externalNames.length > 0) {
    try {
      mapping = loadGroupMapping();
    } catch (error) {
      logger.warn('Could not load group mapping for the login audit entry', {
        component: 'LoginGroupDetails',
        error: error.message
      });
    }
  }

  const external = externalNames.slice(0, MAX_EXTERNAL_GROUPS).map(name => ({
    name,
    mappedTo: uniqueStrings(Object.hasOwn(mapping, name) ? mapping[name] : [])
  }));

  const groups = { external, manual };
  if (externalNames.length > MAX_EXTERNAL_GROUPS) groups.externalTotal = externalNames.length;
  return { groups };
}
