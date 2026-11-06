// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

function uniqueStrings(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter(value => typeof value === 'string' && value.length > 0))];
}

/**
 * Break down the groups of an audit entry for its detail view.
 *
 * A login entry records, in `details.groups`, the groups the identity provider
 * sent (`external`, each with the iHub groups it mapped to) and the groups an
 * admin assigned by hand (`manual`); `actor.groups` holds the groups the user
 * ended up with. Whatever is effective but neither mapped nor manual was added
 * automatically (the `authenticated` group, provider default groups, or a
 * provider that maps its groups itself).
 *
 * @param {Object} entry - An audit log entry as the API returns it
 * @returns {{
 *   effective: string[],
 *   hasSources: boolean,
 *   external: Array<{name: string, mappedTo: string[]}>,
 *   externalTotal: number,
 *   mappedCount: number,
 *   mapped: string[],
 *   manual: string[],
 *   automatic: string[]
 * }|null} null when the entry carries no groups at all
 */
export function describeAuditEntryGroups(entry) {
  const effective = uniqueStrings(entry?.actor?.groups);
  const sources = entry?.details?.groups;
  const hasSources = Boolean(sources && typeof sources === 'object');

  if (!hasSources) {
    if (effective.length === 0) return null;
    return {
      effective,
      hasSources: false,
      external: [],
      externalTotal: 0,
      mappedCount: 0,
      mapped: [],
      manual: [],
      automatic: []
    };
  }

  const external = (Array.isArray(sources.external) ? sources.external : [])
    .filter(group => group && typeof group.name === 'string' && group.name.length > 0)
    .map(group => ({ name: group.name, mappedTo: uniqueStrings(group.mappedTo) }));
  const externalTotal = Number.isFinite(sources.externalTotal)
    ? Math.max(sources.externalTotal, external.length)
    : external.length;
  const mapped = uniqueStrings(external.flatMap(group => group.mappedTo));
  const manual = uniqueStrings(sources.manual);
  const explained = new Set([...mapped, ...manual]);
  const automatic = effective.filter(group => !explained.has(group));

  return {
    effective,
    hasSources: true,
    external,
    externalTotal,
    mappedCount: external.filter(group => group.mappedTo.length > 0).length,
    mapped,
    manual,
    automatic
  };
}

/**
 * The `details` of an entry other than the group breakdown, which the detail
 * view renders on its own. Null when nothing else is left.
 *
 * @param {Object} entry
 * @returns {Object|null}
 */
export function otherAuditEntryDetails(entry) {
  const details = entry?.details;
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null;
  // eslint-disable-next-line no-unused-vars
  const { groups, ...rest } = details;
  return Object.keys(rest).length > 0 ? rest : null;
}
