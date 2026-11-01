// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The action policy of an installation (`actions: { enabled, disabled,
 * overrides }`) as the install wizard builds it from its checkboxes.
 *
 * `enabled` is either `['*']` plus the actions switched on against their
 * default (a denylist: `disabled` holds what the admin switched off, and an
 * action the system adds later is on), or an explicit list of action names
 * (an allowlist: nothing else runs, an action added later stays off). The
 * migration of `mcpServers.json` wrote `allowedTools` as such an allowlist.
 */

/** Whether a stored policy is an explicit allowlist rather than `*` with exceptions. */
export function isAllowlist(policy) {
  return Array.isArray(policy?.enabled) && !policy.enabled.includes('*');
}

/**
 * The policy to save.
 *
 * With no known actions there is nothing to decide on — for an MCP server,
 * its tools are listed only while it is reachable (and, per-user servers,
 * once someone connected) — so the stored policy is sent back unchanged
 * instead of a fresh `['*']` that would switch every tool on. A stored
 * allowlist stays an allowlist: the checked names, plus names it grants that
 * the system did not list this time (a partial listing must not drop them).
 *
 * @param {object} params
 * @param {Array<{ name: string, enabledByDefault?: boolean }>} params.knownActions
 * @param {Set<string>|string[]} params.checkedActions - the names switched on
 * @param {object|null} [params.stored] - the instance's current `actions`
 * @param {object} [params.overrides] - per-action overrides to carry along
 * @returns {{ enabled: string[], disabled: string[], overrides: object }}
 */
export function buildActionsPolicy({ knownActions, checkedActions, stored = null, overrides }) {
  const kept = overrides ?? stored?.overrides ?? {};
  if (!Array.isArray(knownActions) || knownActions.length === 0) {
    return {
      enabled: Array.isArray(stored?.enabled) ? [...stored.enabled] : ['*'],
      disabled: Array.isArray(stored?.disabled) ? [...stored.disabled] : [],
      overrides: kept
    };
  }
  const names = knownActions.map(a => a.name);
  const checked = checkedActions instanceof Set ? checkedActions : new Set(checkedActions || []);
  if (isAllowlist(stored)) {
    const unlisted = stored.enabled.filter(name => !names.includes(name));
    return {
      enabled: [...names.filter(name => checked.has(name)), ...unlisted],
      disabled: [],
      overrides: kept
    };
  }
  const defaultOn = new Set(
    knownActions.filter(a => a.enabledByDefault !== false).map(a => a.name)
  );
  return {
    enabled: ['*', ...names.filter(name => checked.has(name) && !defaultOn.has(name))],
    disabled: names.filter(name => !checked.has(name) && defaultOn.has(name)),
    overrides: kept
  };
}
