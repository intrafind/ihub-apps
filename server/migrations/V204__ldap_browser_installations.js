// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V204 — the admin LDAP browser becomes its own integration
 *
 * Until now the LDAP browser was a switch of a people directory installation
 * (`com.intrafind/ldap-directory` → `values.browse` and the `browse*` values)
 * with its own group list (`browseGroups`). From now on it is an installation
 * of `com.intrafind/ldap-browser` that names a directory installation
 * (`values.directory`) and reuses its connection; who may browse is the
 * browser installation's group grant (`permissions.integrations`).
 *
 * 1. **Browsers.** For every directory installation with `values.browse ===
 *    true`, an installation `<directory id>-browser` is created (`-browser-2`,
 *    `-browser-3`, … when the id is taken), enabled like the directory,
 *    labelled "<directory label> – LDAP browser" ("… – LDAP-Browser" in
 *    German), with the browse values mapped:
 *    `browseBase` → `baseDn`, `browseMaxResults` → `maxResults`,
 *    `browseBindMode` / `browseBindDn` / `browseBindPasswordRef` →
 *    `bindMode` / `bindDn` / `bindPasswordRef` (the credential reference moves
 *    along), `browseDenyAttributes` → `denyAttributes`. The browse actions'
 *    entries of the directory's action policy move to the browser.
 *    Every `browse*` value is removed from every directory (a directory with
 *    the browser off loses its kept browser settings; they are logged).
 * 2. **Grants.** Each browser is granted, in `groups.json` →
 *    `permissions.integrations`, to the groups of `browseGroups` (`admins`
 *    when the list was empty or missing, the definition's default until now).
 *    A group `groups.json` does not define is skipped with a warning. Groups
 *    that hold `*` may use every installation, the browser included: when
 *    such a group could not browse before, a warning names it.
 * 3. **Apps.** A binding of a directory (or of `com.intrafind/ldap-directory`)
 *    whose `actions` name browse actions gets those actions moved to a
 *    binding of the directory's browser (or of `com.intrafind/ldap-browser`);
 *    a binding left without actions is removed (its other settings, such as
 *    `required`, move along). `tools` entries `ldapBrowse` become a binding
 *    of `com.intrafind/ldap-browser`, and `<directory id>__browse_*` a binding
 *    of that directory's browser with those actions (dropped with a warning
 *    when the directory got no browser). A binding naming all three browse
 *    actions is written without `actions` (a browser binding without
 *    `actions` binds all three). The V198 leftover `{ "actions": [] }` binding
 *    of the directory definition next to `ldapBrowse` is removed.
 *    The People search app (`people-directory`) binds `type:people-directory`
 *    instead of the V198 binding `"com.intrafind/ldap-directory": {}`, so it
 *    follows the Entra ID directory too.
 * 4. **Group tool grants.** `permissions.tools` entries `ldapBrowse` become
 *    the browser installation ids, and `<directory id>__browse_*` the tool ids
 *    of the directory's browser.
 *
 * Example: `corp` with `{ browse: true, browseGroups: ["it-ops"],
 * browseBase: "ou=people,dc=corp" }` → installation `corp-browser`
 * `{ directory: "corp", baseDn: "ou=people,dc=corp" }`, `it-ops` gets
 * `"corp-browser"` in `permissions.integrations`, and the LDAP browser app's
 * `{ "com.intrafind/ldap-directory": { "actions": ["browse_search",
 * "browse_read", "browse_children"] } }` becomes
 * `{ "com.intrafind/ldap-browser": {} }`.
 *
 * Idempotent: the directories carry no `browse*` value afterwards, a group
 * already granting a browser is left alone, and a rewritten app has nothing
 * left to move. Missing files are skipped. `integrations.json` is written
 * last, so a run that stops half way repeats everything on the next start.
 *
 * Self-contained: no application module is imported (see
 * `server/migrations/README.md`).
 */

export const version = '204';
export const description = 'ldap_browser_installations';

const INTEGRATIONS_FILE = 'config/integrations.json';
const GROUPS_FILE = 'config/groups.json';

export const DIRECTORY_DEFINITION = 'com.intrafind/ldap-directory';
export const BROWSER_DEFINITION = 'com.intrafind/ldap-browser';
const BROWSER_DEFINITION_VERSION = '1.0.0';
export const BROWSE_ACTIONS = Object.freeze(['browse_search', 'browse_read', 'browse_children']);
/** The retired tool reference that selected every directory's browse tools. */
export const LDAP_BROWSE_REFERENCE = 'ldapBrowse';
export const PEOPLE_SEARCH_APP_ID = 'people-directory';
export const PEOPLE_DIRECTORY_TYPE_KEY = 'type:people-directory';
/** The `browse*` install values of a directory as of V198 to V203 (snapshot). */
export const BROWSE_VALUE_KEYS = Object.freeze([
  'browse',
  'browseGroups',
  'browseBase',
  'browseMaxResults',
  'browseBindMode',
  'browseBindDn',
  'browseBindPasswordRef',
  'browseDenyAttributes'
]);
/** `browseGroups` when the directory named none: the definition's default until V204. */
export const DEFAULT_BROWSE_GROUPS = Object.freeze(['admins']);
const ALL = '*';
const MAX_ID_LENGTH = 64;
const SUFFIX = '-browser';

const text = value => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
const list = value =>
  Array.isArray(value) ? value.map(item => String(item).trim()).filter(Boolean) : [];
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export async function precondition(ctx) {
  if (await ctx.fileExists(INTEGRATIONS_FILE)) return true;
  if (await ctx.fileExists(GROUPS_FILE)) return true;
  return (await ctx.listFiles('apps', '*.json')).length > 0;
}

/**
 * A free installation id for the browser of a directory: `<id>-browser`,
 * then `<id>-browser-2`, … — at most 64 characters.
 * @param {string} directoryId
 * @param {Set<string>} taken - Ids in use (updated here)
 * @returns {string}
 */
export function browserIdFor(directoryId, taken) {
  const make = suffix => `${directoryId.slice(0, MAX_ID_LENGTH - suffix.length)}${suffix}`;
  let id = make(SUFFIX);
  for (let n = 2; taken.has(id); n += 1) id = make(`${SUFFIX}-${n}`);
  taken.add(id);
  return id;
}

/**
 * The browser's label from the directory's: "<label> – LDAP browser" per
 * language ("– LDAP-Browser" in German). Without a label, the directory id.
 * @param {object} directory - the directory installation
 * @returns {Record<string, string>}
 */
export function browserLabelOf(directory) {
  const suffixOf = lang => (lang === 'de' ? ' – LDAP-Browser' : ' – LDAP browser');
  const label = directory?.label;
  if (isObject(label)) {
    const out = {};
    for (const [lang, value] of Object.entries(label)) {
      if (typeof value === 'string' && value.trim()) out[lang] = `${value.trim()}${suffixOf(lang)}`;
    }
    if (Object.keys(out).length > 0) return out;
  }
  if (typeof label === 'string' && label.trim()) return { en: `${label.trim()}${suffixOf('en')}` };
  return { en: `${directory.id}${suffixOf('en')}`, de: `${directory.id}${suffixOf('de')}` };
}

/**
 * The browser's install values from the directory's `browse*` values.
 * @param {string} directoryId
 * @param {Record<string, unknown>} values - the directory's values
 * @returns {Record<string, unknown>}
 */
export function browserValuesOf(directoryId, values) {
  const out = { directory: directoryId };
  const base = text(values.browseBase);
  if (base) out.baseDn = base;
  if (typeof values.browseMaxResults === 'number' && !Number.isNaN(values.browseMaxResults)) {
    out.maxResults = values.browseMaxResults;
  }
  if (values.browseBindMode === 'anonymous' || values.browseBindMode === 'service') {
    out.bindMode = values.browseBindMode;
    if (values.browseBindMode === 'service') {
      const dn = text(values.browseBindDn);
      const passwordRef = text(values.browseBindPasswordRef);
      if (dn) out.bindDn = dn;
      if (passwordRef) out.bindPasswordRef = passwordRef;
    }
  }
  const deny = list(values.browseDenyAttributes);
  if (deny.length > 0) out.denyAttributes = deny;
  return out;
}

/**
 * Split a directory's action policy: the browse actions' entries go to the
 * browser, the rest stays with the directory.
 * @param {object|undefined} policy - the directory's `actions`
 * @returns {{ directory: object, browser: object }}
 */
export function splitActionPolicy(policy) {
  const enabled = Array.isArray(policy?.enabled) ? policy.enabled : [ALL];
  const disabled = Array.isArray(policy?.disabled) ? policy.disabled : [];
  const overrides = isObject(policy?.overrides) ? policy.overrides : {};
  const isBrowse = name => BROWSE_ACTIONS.includes(name);
  const browserOverrides = {};
  const directoryOverrides = {};
  for (const [name, override] of Object.entries(overrides)) {
    if (isBrowse(name)) browserOverrides[name] = override;
    else directoryOverrides[name] = override;
  }
  return {
    directory: {
      ...(isObject(policy) ? policy : {}),
      enabled: enabled.filter(name => !isBrowse(name)),
      disabled: disabled.filter(name => !isBrowse(name)),
      overrides: directoryOverrides
    },
    browser: {
      enabled: enabled.includes(ALL) ? [ALL] : enabled.filter(isBrowse),
      disabled: disabled.filter(isBrowse),
      overrides: browserOverrides
    }
  };
}

/**
 * A group and every group it inherits, transitively (cycles tolerated).
 * Snapshot of V202's `reachOf`.
 * @param {string} groupId
 * @param {Object<string, object>} groups
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
 * The groups that may use every installation (`*` in their own or an
 * inherited `permissions.integrations`) but could not browse before (none of
 * the browse groups in their reach). The anonymous group is left out: the
 * browser never serves anonymous callers.
 * @param {Object<string, object>} groups
 * @param {string[]} browseGroups
 * @returns {string[]}
 */
export function wildcardGainers(groups, browseGroups) {
  const holdsAll = id => {
    const granted = groups?.[id]?.permissions?.integrations;
    return Array.isArray(granted) && granted.includes(ALL);
  };
  return Object.keys(groups || {}).filter(id => {
    if (id === 'anonymous') return false;
    const reach = reachOf(id, groups);
    if (![...reach].some(holdsAll)) return false;
    return !browseGroups.some(group => reach.has(group));
  });
}

/**
 * A browser binding with more browse actions. A binding without `actions`
 * binds all three and stays so; `actions === null` means all three; a list
 * naming all three is written without `actions`.
 * @param {object} binding
 * @param {string[]|null} actions
 * @returns {object}
 */
export function mergeBrowseActions(binding, actions) {
  const next = { ...binding };
  if (!Array.isArray(binding.actions) || actions === null) {
    delete next.actions;
    return next;
  }
  const merged = new Set([...binding.actions, ...actions]);
  const kept = BROWSE_ACTIONS.filter(name => merged.has(name));
  if (kept.length === BROWSE_ACTIONS.length) delete next.actions;
  else next.actions = kept;
  return next;
}

/**
 * The directory a tool reference `<directory id>__browse_*` names, or null.
 * Only ids of directory installations count: another installation's tool
 * (an MCP server's `browse_search`) is left alone.
 */
function browseRefOf(ref, directoryIds) {
  if (typeof ref !== 'string') return null;
  const at = ref.indexOf('__');
  if (at <= 0) return null;
  const directoryId = ref.slice(0, at);
  const action = ref.slice(at + 2);
  if (!BROWSE_ACTIONS.includes(action) || !directoryIds.has(directoryId)) return null;
  return { directoryId, action };
}

/**
 * Rewrite one app. Returns the app, whether it changed, and what happened.
 *
 * @param {object} app
 * @param {Object} context
 * @param {Map<string, string>} context.browserOf - directory id → browser id
 * @param {Set<string>} context.directoryIds - ids of every directory installation
 * @returns {{ app: object, changed: boolean, notes: string[], warnings: string[] }}
 */
export function migrateApp(app, { browserOf, directoryIds }) {
  const notes = [];
  const warnings = [];
  if (!isObject(app)) return { app, changed: false, notes, warnings };
  const bindings = isObject(app.integrations) ? { ...app.integrations } : {};
  let changed = false;

  /** Put browse actions (`null`: all three) on the binding `key`, creating it with `carry`. */
  const bindBrowser = (key, actions, carry = {}) => {
    const existing = isObject(bindings[key]) ? bindings[key] : { ...carry, actions: [] };
    bindings[key] = mergeBrowseActions(existing, actions);
    changed = true;
  };

  // 1. Bindings of a directory or of the directory definition naming browse actions.
  for (const [key, binding] of Object.entries({ ...bindings })) {
    if (key !== DIRECTORY_DEFINITION && !directoryIds.has(key)) continue;
    if (!isObject(binding) || !Array.isArray(binding.actions)) continue;
    const browse = binding.actions.filter(name => BROWSE_ACTIONS.includes(name));
    if (browse.length === 0) continue;
    const target = key === DIRECTORY_DEFINITION ? BROWSER_DEFINITION : browserOf.get(key);
    const rest = binding.actions.filter(name => !BROWSE_ACTIONS.includes(name));
    const { actions: _moved, ...carry } = binding;
    if (target) {
      bindBrowser(target, browse, carry);
      notes.push(`binding "${key}": browse actions → "${target}"`);
    } else {
      warnings.push(
        `binding "${key}" named ${browse.join(', ')}, but "${key}" has no LDAP browser; the actions are dropped`
      );
    }
    if (rest.length > 0) bindings[key] = { ...binding, actions: rest };
    else delete bindings[key];
    changed = true;
  }

  // 2. `tools` entries of the retired browse references.
  let tools = Array.isArray(app.tools) ? app.tools : null;
  const hadLdapBrowse = Boolean(tools?.includes(LDAP_BROWSE_REFERENCE));
  if (tools) {
    const kept = [];
    for (const ref of tools) {
      if (ref === LDAP_BROWSE_REFERENCE) {
        bindBrowser(BROWSER_DEFINITION, null);
        notes.push(`tools "${LDAP_BROWSE_REFERENCE}" → binding "${BROWSER_DEFINITION}"`);
        continue;
      }
      const browseRef = browseRefOf(ref, directoryIds);
      if (!browseRef) {
        kept.push(ref);
        continue;
      }
      changed = true;
      const browserId = browserOf.get(browseRef.directoryId);
      if (browserId) {
        bindBrowser(browserId, [browseRef.action]);
        notes.push(`tools "${ref}" → binding "${browserId}"`);
      } else {
        warnings.push(
          `tools "${ref}": "${browseRef.directoryId}" has no LDAP browser; the entry is dropped`
        );
      }
    }
    tools = kept;
  }

  // 3. The V198 leftover: the directory definition bound with no action, for
  //    the visibility of an app that browsed through `ldapBrowse`.
  const definitionBinding = bindings[DIRECTORY_DEFINITION];
  if (
    hadLdapBrowse &&
    isObject(definitionBinding) &&
    Array.isArray(definitionBinding.actions) &&
    definitionBinding.actions.length === 0
  ) {
    delete bindings[DIRECTORY_DEFINITION];
    notes.push(
      `binding "${DIRECTORY_DEFINITION}" without actions removed (it served "ldapBrowse")`
    );
    changed = true;
  }

  // 4. The People search app follows every people directory, Entra included.
  let integrationsOut = bindings;
  if (
    app.id === PEOPLE_SEARCH_APP_ID &&
    isObject(bindings[DIRECTORY_DEFINITION]) &&
    Object.keys(bindings[DIRECTORY_DEFINITION]).length === 0 &&
    !Object.hasOwn(bindings, PEOPLE_DIRECTORY_TYPE_KEY)
  ) {
    integrationsOut = {};
    for (const [key, value] of Object.entries(bindings)) {
      if (key === DIRECTORY_DEFINITION) integrationsOut[PEOPLE_DIRECTORY_TYPE_KEY] = {};
      else integrationsOut[key] = value;
    }
    notes.push(`binding "${DIRECTORY_DEFINITION}" → "${PEOPLE_DIRECTORY_TYPE_KEY}"`);
    changed = true;
  }

  if (!changed) return { app, changed: false, notes, warnings };
  const next = { ...app };
  if (tools && tools.length > 0) next.tools = tools;
  else if (tools) delete next.tools;
  if (Object.keys(integrationsOut).length > 0) next.integrations = integrationsOut;
  else delete next.integrations;
  return { app: next, changed: true, notes, warnings };
}

/**
 * Rewrite a group's tool grants: `ldapBrowse` → the browser ids,
 * `<directory id>__browse_*` → the browser's tool id.
 * @param {string[]} tools - `permissions.tools`
 * @param {Map<string, string>} browserOf
 * @returns {{ tools: string[], changed: boolean }}
 */
export function migrateToolGrants(tools, browserOf) {
  if (!Array.isArray(tools)) return { tools, changed: false };
  const out = [];
  let changed = false;
  const push = id => {
    if (!out.includes(id)) out.push(id);
  };
  for (const ref of tools) {
    if (ref === LDAP_BROWSE_REFERENCE) {
      for (const browserId of browserOf.values()) push(browserId);
      changed = true;
      continue;
    }
    const at = typeof ref === 'string' ? ref.indexOf('__') : -1;
    if (at > 0 && BROWSE_ACTIONS.includes(ref.slice(at + 2)) && browserOf.has(ref.slice(0, at))) {
      push(`${browserOf.get(ref.slice(0, at))}__${ref.slice(at + 2)}`);
      changed = true;
      continue;
    }
    push(ref);
  }
  return { tools: out, changed };
}

export async function up(ctx) {
  const hasIntegrations = await ctx.fileExists(INTEGRATIONS_FILE);
  const integrations = hasIntegrations ? await ctx.readJson(INTEGRATIONS_FILE) : null;
  const installed = Array.isArray(integrations?.installed) ? integrations.installed : [];
  if (!hasIntegrations) ctx.log('No integrations.json: no people directory to move a browser from');

  // 1. Browsers, in memory (written last).
  const taken = new Set(installed.filter(entry => entry?.id).map(entry => entry.id));
  /** directory id → browser id, for the app and grant rewrites. */
  const browserOf = new Map();
  // A browser a previous run (or an admin) already created keeps serving its directory.
  for (const entry of installed) {
    const directoryId = text(entry?.values?.directory);
    if (entry?.definition === BROWSER_DEFINITION && directoryId && !browserOf.has(directoryId)) {
      browserOf.set(directoryId, entry.id);
    }
  }
  const created = [];
  let integrationsChanged = false;
  for (const directory of [...installed]) {
    if (directory?.definition !== DIRECTORY_DEFINITION || !isObject(directory.values)) continue;
    const values = directory.values;
    const browseKeys = BROWSE_VALUE_KEYS.filter(key => Object.hasOwn(values, key));
    if (browseKeys.length === 0) continue;
    if (values.browse === true) {
      const browserId = browserIdFor(directory.id, taken);
      const policy = splitActionPolicy(directory.actions);
      const now = new Date().toISOString();
      const browser = {
        id: browserId,
        definition: BROWSER_DEFINITION,
        definitionVersion: BROWSER_DEFINITION_VERSION,
        label: browserLabelOf(directory),
        enabled: directory.enabled !== false,
        values: browserValuesOf(directory.id, values),
        auth: { mode: 'none' },
        actions: policy.browser,
        installedAt: now,
        updatedAt: now
      };
      const groups = list(values.browseGroups);
      created.push({
        browser,
        directoryId: directory.id,
        browseGroups: groups.length > 0 ? groups : [...DEFAULT_BROWSE_GROUPS]
      });
      browserOf.set(directory.id, browserId);
      installed.splice(installed.indexOf(directory) + 1, 0, browser);
      if (isObject(directory.actions)) directory.actions = policy.directory;
      ctx.log(
        `People directory "${directory.id}": LDAP browser → installation "${browserId}" (${BROWSER_DEFINITION})`
      );
    } else {
      ctx.log(
        `People directory "${directory.id}": the LDAP browser was off; its kept settings (${browseKeys.join(', ')}) are removed`
      );
    }
    for (const key of BROWSE_VALUE_KEYS) delete values[key];
    integrationsChanged = true;
  }

  // 2. Grants and tool grants.
  if (await ctx.fileExists(GROUPS_FILE)) {
    const groupsData = await ctx.readJson(GROUPS_FILE);
    const groups = isObject(groupsData?.groups) ? groupsData.groups : null;
    let groupsChanged = false;
    if (groups) {
      for (const { browser, browseGroups } of created) {
        for (const groupId of browseGroups) {
          const group = groups[groupId];
          if (!isObject(group)) {
            ctx.warn(
              `LDAP browser "${browser.id}": group "${groupId}" of browseGroups is not defined in groups.json; nobody gets the browser through it`
            );
            continue;
          }
          if (!isObject(group.permissions)) group.permissions = {};
          const granted = Array.isArray(group.permissions.integrations)
            ? group.permissions.integrations
            : (group.permissions.integrations = []);
          if (granted.includes(ALL) || granted.includes(browser.id)) {
            ctx.log(`Group "${groupId}" already may use "${browser.id}"`);
            continue;
          }
          granted.push(browser.id);
          groupsChanged = true;
          ctx.log(`Group "${groupId}" may use the LDAP browser "${browser.id}"`);
        }
        const gainers = wildcardGainers(groups, browseGroups);
        if (gainers.length > 0) {
          ctx.warn(
            `LDAP browser "${browser.id}": groups ${gainers.map(id => `"${id}"`).join(', ')} hold "*" in permissions.integrations and may now use it, ` +
              `although they were not in browseGroups (${browseGroups.join(', ')}). Replace "*" with the installations they need (Admin → Groups → Integrations) if they should not browse.`
          );
        }
      }
      for (const [groupId, group] of Object.entries(groups)) {
        const { tools, changed } = migrateToolGrants(group?.permissions?.tools, browserOf);
        if (!changed) continue;
        group.permissions.tools = tools;
        groupsChanged = true;
        ctx.log(`Group "${groupId}": LDAP browser tool grants → ${JSON.stringify(tools)}`);
      }
    }
    if (groupsChanged) {
      if (isObject(groupsData.metadata))
        groupsData.metadata.lastModified = new Date().toISOString();
      await ctx.writeJson(GROUPS_FILE, groupsData);
    }
  } else if (created.length > 0) {
    ctx.warn(
      'No groups.json: the LDAP browsers are granted to no group; grant them on Admin → Groups'
    );
  }

  // 3. Apps.
  const directoryIds = new Set(
    installed.filter(entry => entry?.definition === DIRECTORY_DEFINITION).map(entry => entry.id)
  );
  for (const file of await ctx.listFiles('apps', '*.json')) {
    const rel = `apps/${file}`;
    const app = await ctx.readJson(rel);
    if (!app) continue;
    const { app: next, changed, notes, warnings } = migrateApp(app, { browserOf, directoryIds });
    for (const warning of warnings) ctx.warn(`${rel}: ${warning}`);
    if (!changed) continue;
    await ctx.writeJson(rel, next);
    ctx.log(`${rel}: ${notes.join('; ')}`);
  }

  // 4. The installations, last.
  if (integrationsChanged) {
    integrations.installed = installed;
    await ctx.writeJson(INTEGRATIONS_FILE, integrations);
    ctx.log(`${created.length} LDAP browser installation(s) created`);
  }
}
