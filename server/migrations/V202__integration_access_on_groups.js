// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V202 — which groups may use an installed integration moves onto
 * the groups (#3093)
 *
 * Until now every installation in `config/integrations.json` carried
 * `allowedGroups` (empty: everyone who may use the app). From now on the
 * groups decide, like for apps: `groups.json` → `permissions.integrations`
 * lists `*`, installation ids, definition ids and type keys
 * (`type:people-directory`), resolved with inheritance.
 *
 * For every group in `config/groups.json` that has no
 * `permissions.integrations` yet, this migration grants what the group could
 * use before. A group could use an installation when the installation's
 * `allowedGroups` was empty (or held `*`), or named the group or a group it
 * inherits (`inherits`, transitively):
 *
 * - a group that could use EVERY installation gets `["*"]`, so it keeps
 *   getting the ones installed later, as an empty `allowedGroups` did;
 * - any other group gets the ids of the installations it could use.
 *
 * Example: `websearch` open to everyone, `x500bund` limited to
 * `["authenticated"]`, `authenticated` inheriting `anonymous` →
 * `authenticated` (and every group inheriting it) gets `["*"]`, `anonymous`
 * gets `["websearch", "ihub"]`.
 *
 * The always-installed `ihub` installation (iHub's own tools) counts even
 * when the file does not hold it: the server serves it open to everyone until
 * an admin edits it.
 *
 * Then `allowedGroups` is removed from every installation. A group named in
 * an `allowedGroups` list that `groups.json` does not define is reported with
 * a warning: nothing can carry its grant, so the admin has to create it.
 *
 * Idempotent: groups that already have `permissions.integrations` are left
 * alone, and a file without `allowedGroups` is not rewritten. No
 * `groups.json` means nothing to grant: the migration does nothing. No
 * `integrations.json` means no installation was limited: every group gets
 * `["*"]`.
 *
 * Self-contained: no application module is imported (see
 * `server/migrations/README.md`).
 */

export const version = '202';
export const description = 'integration_access_on_groups';

const GROUPS_FILE = 'config/groups.json';
const INTEGRATIONS_FILE = 'config/integrations.json';

/**
 * The always-installed built-ins as of this migration (2026-11-01): the
 * server serves them, open to everyone, when the file does not hold them.
 * Snapshot — do NOT replace with a registry lookup.
 */
export const ALWAYS_INSTALLED_IDS = Object.freeze(['ihub']);

/** The grant of every installation, the ones installed later included. */
const ALL = '*';

export async function precondition(ctx) {
  return ctx.fileExists(GROUPS_FILE);
}

/**
 * A group and every group it inherits, transitively (cycles tolerated).
 * @param {string} groupId
 * @param {Object<string, object>} groups - `groups.json` → `groups`
 * @returns {Set<string>}
 */
export function reachOf(groupId, groups) {
  const reach = new Set();
  const queue = [groupId];
  while (queue.length > 0) {
    const id = queue.shift();
    if (typeof id !== 'string' || reach.has(id)) continue;
    reach.add(id);
    const parents = groups?.[id]?.inherits;
    if (Array.isArray(parents)) queue.push(...parents);
  }
  return reach;
}

/**
 * Whether an installation's `allowedGroups` admitted a group with this reach:
 * an empty or missing list (or `*`) admits everyone.
 * @param {unknown} allowedGroups
 * @param {Set<string>} reach - from {@link reachOf}
 * @returns {boolean}
 */
export function admits(allowedGroups, reach) {
  if (!Array.isArray(allowedGroups) || allowedGroups.length === 0) return true;
  if (allowedGroups.includes(ALL)) return true;
  return allowedGroups.some(group => reach.has(group));
}

/**
 * What one group could use before, as its `permissions.integrations`.
 * @param {string} groupId
 * @param {Object<string, object>} groups - `groups.json` → `groups`
 * @param {Array<{ id: string, allowedGroups?: string[] }>} installed
 * @returns {string[]} `["*"]` or the installation ids, in file order
 */
export function grantFor(groupId, groups, installed) {
  const reach = reachOf(groupId, groups);
  const usable = installed.filter(instance => admits(instance.allowedGroups, reach));
  if (usable.length === installed.length) return [ALL];
  return usable.map(instance => instance.id);
}

/**
 * The installations as the server saw them: the file's (entries without an
 * id skipped) plus the always-installed built-ins it does not hold.
 * @param {object|null} config - `integrations.json`
 * @returns {Array<{ id: string, allowedGroups?: string[] }>}
 */
export function installationsOf(config) {
  const installed = Array.isArray(config?.installed)
    ? config.installed.filter(
        instance => instance && typeof instance.id === 'string' && instance.id.length > 0
      )
    : [];
  const out = installed.map(instance => ({
    id: instance.id,
    allowedGroups: instance.allowedGroups
  }));
  for (const id of ALWAYS_INSTALLED_IDS) {
    if (!out.some(instance => instance.id === id)) out.push({ id, allowedGroups: [] });
  }
  return out;
}

export async function up(ctx) {
  if (!(await ctx.fileExists(GROUPS_FILE))) {
    ctx.log('No groups.json: nothing to grant');
    return;
  }
  const groupsData = await ctx.readJson(GROUPS_FILE);
  const groups =
    groupsData && typeof groupsData.groups === 'object' && groupsData.groups !== null
      ? groupsData.groups
      : null;

  const hasIntegrationsFile = await ctx.fileExists(INTEGRATIONS_FILE);
  const config = hasIntegrationsFile ? await ctx.readJson(INTEGRATIONS_FILE) : null;
  if (!hasIntegrationsFile) {
    ctx.log('No integrations.json: no installation was limited to groups');
  }
  const installed = installationsOf(config);

  // 1. Grant each group what it could use before.
  let groupsChanged = false;
  if (groups) {
    for (const [groupId, group] of Object.entries(groups)) {
      if (!group || typeof group !== 'object') continue;
      if (Array.isArray(group.permissions?.integrations)) {
        ctx.log(`Group "${groupId}" already has permissions.integrations; left as it is`);
        continue;
      }
      const grant = grantFor(groupId, groups, installed);
      if (!group.permissions || typeof group.permissions !== 'object') group.permissions = {};
      group.permissions.integrations = grant;
      groupsChanged = true;
      ctx.log(`Group "${groupId}" may use integrations: ${JSON.stringify(grant)}`);
    }

    // Groups an installation named that groups.json does not define: their
    // members lose the installation unless the admin creates the group.
    const unknown = new Map();
    for (const instance of installed) {
      if (!Array.isArray(instance.allowedGroups)) continue;
      for (const group of instance.allowedGroups) {
        if (group === ALL || Object.hasOwn(groups, group)) continue;
        if (!unknown.has(group)) unknown.set(group, []);
        unknown.get(group).push(instance.id);
      }
    }
    for (const [group, ids] of unknown) {
      ctx.warn(
        `Group "${group}" is named in allowedGroups of ${ids.map(id => `"${id}"`).join(', ')} but is not defined in groups.json; ` +
          `create the group and grant it these integrations (Admin → Groups → Integrations), or its members lose them`
      );
    }
  } else {
    ctx.warn('groups.json holds no groups: no group was granted integrations');
  }

  if (groupsChanged) {
    if (groupsData.metadata && typeof groupsData.metadata === 'object') {
      groupsData.metadata.lastModified = new Date().toISOString();
    }
    await ctx.writeJson(GROUPS_FILE, groupsData);
  }

  // 2. Installations carry no groups any more.
  if (hasIntegrationsFile && Array.isArray(config?.installed)) {
    let removed = 0;
    for (const instance of config.installed) {
      if (instance && typeof instance === 'object' && Object.hasOwn(instance, 'allowedGroups')) {
        delete instance.allowedGroups;
        removed += 1;
      }
    }
    if (removed > 0) {
      await ctx.writeJson(INTEGRATIONS_FILE, config);
      ctx.log(`Removed allowedGroups from ${removed} installed integration(s)`);
    }
  }
}
