// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V205 — the admin LDAP browser becomes its own integration
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
 *    follows the Entra ID directory too; next to a type binding (a fresh
 *    install: the shipped app, then V185 and V198) that binding is removed.
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

export const version = '205';
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
/** The `browse*` install values of a directory as of V198 to V204 (snapshot). */
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
/** `browseGroups` when the directory named none: the definition's default until V205. */
export const DEFAULT_BROWSE_GROUPS = Object.freeze(['admins']);
const ALL = '*';
const MAX_ID_LENGTH = 64;
const SUFFIX = '-browser';

const text = value => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
const list = value =>
  Array.isArray(value) ? value.map(item => String(item).trim()).filter(Boolean) : [];
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isBrowseAction = name => BROWSE_ACTIONS.includes(name);
const quoted = id => `"${id}"`;

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
  let n = 2;
  while (taken.has(id)) {
    id = make(`${SUFFIX}-${n}`);
    n += 1;
  }
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
 * An app being rewritten by {@link migrateApp}: its bindings (a copy), what
 * happened, and whether anything changed. The step helpers update it.
 *
 * @typedef {Object} AppRewrite
 * @property {Object<string, object>} bindings - the app's `integrations` (a copy)
 * @property {string[]} notes - what was rewritten (logged)
 * @property {string[]} warnings - what was dropped (warned)
 * @property {boolean} changed - whether the app changed
 */

/**
 * A binding without its `actions`: the settings (such as `required`) that move
 * along to the browser binding.
 * @param {object} binding
 * @returns {object}
 */
function withoutActions(binding) {
  const carry = { ...binding };
  delete carry.actions;
  return carry;
}

/**
 * Put browse actions on the binding `key` of an app being rewritten, creating
 * the binding with the settings `carry` when the app has none.
 * @param {AppRewrite} rewrite
 * @param {string} key - a browser installation id or {@link BROWSER_DEFINITION}
 * @param {string[]|null} actions - the browse actions; `null`: all three
 * @param {object} [carry] - settings for a new binding
 */
function bindBrowser(rewrite, key, actions, carry = {}) {
  const existing = isObject(rewrite.bindings[key])
    ? rewrite.bindings[key]
    : { ...carry, actions: [] };
  rewrite.bindings[key] = mergeBrowseActions(existing, actions);
  rewrite.changed = true;
}

/**
 * The browse actions a binding names, when it binds a directory or the
 * directory definition.
 * @param {string} key - the binding's key
 * @param {unknown} binding
 * @param {Set<string>} directoryIds - ids of every directory installation
 * @returns {string[]} empty for every other binding
 */
function bindingBrowseActions(key, binding, directoryIds) {
  if (key !== DIRECTORY_DEFINITION && !directoryIds.has(key)) return [];
  if (!isObject(binding) || !Array.isArray(binding.actions)) return [];
  return binding.actions.filter(isBrowseAction);
}

/**
 * Step 1 of {@link migrateApp}: the browse actions of a binding of a directory
 * (of the directory definition) move to a binding of its browser (of the
 * browser definition), or are dropped with a warning when the directory got
 * no browser. The binding keeps its other actions, or is removed without any.
 * @param {AppRewrite} rewrite
 * @param {{ browserOf: Map<string, string>, directoryIds: Set<string> }} context
 */
function moveBrowseBindings(rewrite, { browserOf, directoryIds }) {
  for (const [key, binding] of Object.entries({ ...rewrite.bindings })) {
    const browse = bindingBrowseActions(key, binding, directoryIds);
    if (browse.length === 0) continue;
    const target = key === DIRECTORY_DEFINITION ? BROWSER_DEFINITION : browserOf.get(key);
    if (target) {
      bindBrowser(rewrite, target, browse, withoutActions(binding));
      rewrite.notes.push(`binding "${key}": browse actions → "${target}"`);
    } else {
      rewrite.warnings.push(
        `binding "${key}" named ${browse.join(', ')}, but "${key}" has no LDAP browser; the actions are dropped`
      );
    }
    const rest = binding.actions.filter(name => !isBrowseAction(name));
    if (rest.length > 0) rewrite.bindings[key] = { ...binding, actions: rest };
    else delete rewrite.bindings[key];
    rewrite.changed = true;
  }
}

/**
 * Step 2 of {@link migrateApp} for one `tools` entry: `ldapBrowse` becomes a
 * binding of the browser definition, `<directory id>__browse_*` a binding of
 * that directory's browser (dropped with a warning when it got none).
 * @param {AppRewrite} rewrite
 * @param {unknown} ref - the `tools` entry
 * @param {{ browserOf: Map<string, string>, directoryIds: Set<string> }} context
 * @returns {boolean} whether the entry leaves `tools`
 */
function moveBrowseToolRef(rewrite, ref, { browserOf, directoryIds }) {
  if (ref === LDAP_BROWSE_REFERENCE) {
    bindBrowser(rewrite, BROWSER_DEFINITION, null);
    rewrite.notes.push(`tools "${LDAP_BROWSE_REFERENCE}" → binding "${BROWSER_DEFINITION}"`);
    return true;
  }
  const browseRef = browseRefOf(ref, directoryIds);
  if (!browseRef) return false;
  rewrite.changed = true;
  const browserId = browserOf.get(browseRef.directoryId);
  if (browserId) {
    bindBrowser(rewrite, browserId, [browseRef.action]);
    rewrite.notes.push(`tools "${ref}" → binding "${browserId}"`);
  } else {
    rewrite.warnings.push(
      `tools "${ref}": "${browseRef.directoryId}" has no LDAP browser; the entry is dropped`
    );
  }
  return true;
}

/**
 * Step 2 of {@link migrateApp}: the `tools` entries of the retired browse
 * references become browser bindings.
 * @param {AppRewrite} rewrite
 * @param {unknown[]} tools - the app's `tools`
 * @param {{ browserOf: Map<string, string>, directoryIds: Set<string> }} context
 * @returns {unknown[]} the entries that stay
 */
function moveBrowseTools(rewrite, tools, context) {
  const kept = [];
  for (const ref of tools) {
    if (!moveBrowseToolRef(rewrite, ref, context)) kept.push(ref);
  }
  return kept;
}

/**
 * Step 3 of {@link migrateApp}, for an app that browsed through `ldapBrowse`:
 * the V198 leftover, the directory definition bound with no action for the
 * app's visibility, is removed.
 * @param {AppRewrite} rewrite
 */
function dropLdapBrowseLeftover(rewrite) {
  const binding = rewrite.bindings[DIRECTORY_DEFINITION];
  if (!isObject(binding) || !Array.isArray(binding.actions) || binding.actions.length > 0) return;
  delete rewrite.bindings[DIRECTORY_DEFINITION];
  rewrite.notes.push(
    `binding "${DIRECTORY_DEFINITION}" without actions removed (it served "ldapBrowse")`
  );
  rewrite.changed = true;
}

/**
 * Step 4 of {@link migrateApp}: the People search app follows every people
 * directory, Entra included. Its V198 binding of the directory definition
 * becomes the type binding; next to a type binding (a fresh install copies
 * the shipped app, then V185 and V198 add the definition binding) it is
 * redundant, and as a required binding it would hide the app while no LDAP
 * directory is on.
 * @param {object} app
 * @param {AppRewrite} rewrite
 * @returns {Object<string, object>} the app's bindings from here on
 */
function peopleSearchBindings(app, rewrite) {
  const { bindings } = rewrite;
  const definitionBinding = bindings[DIRECTORY_DEFINITION];
  if (
    app.id !== PEOPLE_SEARCH_APP_ID ||
    !isObject(definitionBinding) ||
    Object.keys(definitionBinding).length > 0
  ) {
    return bindings;
  }
  const hasType = Object.hasOwn(bindings, PEOPLE_DIRECTORY_TYPE_KEY);
  const out = {};
  for (const [key, value] of Object.entries(bindings)) {
    if (key !== DIRECTORY_DEFINITION) out[key] = value;
    else if (!hasType) out[PEOPLE_DIRECTORY_TYPE_KEY] = {};
  }
  rewrite.notes.push(
    hasType
      ? `binding "${DIRECTORY_DEFINITION}" removed: "${PEOPLE_DIRECTORY_TYPE_KEY}" covers it`
      : `binding "${DIRECTORY_DEFINITION}" → "${PEOPLE_DIRECTORY_TYPE_KEY}"`
  );
  rewrite.changed = true;
  return out;
}

/**
 * The rewritten app: its `tools` and `integrations` replaced, each removed
 * when nothing is left.
 * @param {object} app
 * @param {unknown[]|null} tools - null when the app had no `tools` list
 * @param {Object<string, object>} integrations
 * @returns {object}
 */
function rewrittenApp(app, tools, integrations) {
  const next = { ...app };
  if (tools && tools.length > 0) next.tools = tools;
  else if (tools) delete next.tools;
  if (Object.keys(integrations).length > 0) next.integrations = integrations;
  else delete next.integrations;
  return next;
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
export function migrateApp(app, context) {
  if (!isObject(app)) return { app, changed: false, notes: [], warnings: [] };
  /** @type {AppRewrite} */
  const rewrite = {
    bindings: isObject(app.integrations) ? { ...app.integrations } : {},
    notes: [],
    warnings: [],
    changed: false
  };
  // 1. Bindings of a directory or of the directory definition naming browse actions.
  moveBrowseBindings(rewrite, context);
  // 2. `tools` entries of the retired browse references.
  const hadLdapBrowse = Array.isArray(app.tools) && app.tools.includes(LDAP_BROWSE_REFERENCE);
  const tools = Array.isArray(app.tools) ? moveBrowseTools(rewrite, app.tools, context) : null;
  // 3. The V198 leftover of `ldapBrowse`.
  if (hadLdapBrowse) dropLdapBrowseLeftover(rewrite);
  // 4. The People search app binds the people directory type.
  const integrations = peopleSearchBindings(app, rewrite);

  const { notes, warnings } = rewrite;
  if (!rewrite.changed) return { app, changed: false, notes, warnings };
  return { app: rewrittenApp(app, tools, integrations), changed: true, notes, warnings };
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

/**
 * Read `integrations.json`.
 * @param {object} ctx - migration context
 * @returns {Promise<{ integrations: object|null, installed: object[] }>}
 *   `installed` is the file's own list (changed in place), or a new empty one
 */
async function readInstallations(ctx) {
  if (!(await ctx.fileExists(INTEGRATIONS_FILE))) {
    ctx.log('No integrations.json: no people directory to move a browser from');
    return { integrations: null, installed: [] };
  }
  const integrations = await ctx.readJson(INTEGRATIONS_FILE);
  const installed = Array.isArray(integrations?.installed) ? integrations.installed : [];
  return { integrations, installed };
}

/**
 * The browsers a previous run (or an admin) already created: they keep
 * serving their directory.
 * @param {object[]} installed
 * @returns {Map<string, string>} directory id → browser id
 */
function existingBrowsers(installed) {
  const browserOf = new Map();
  for (const entry of installed) {
    const directoryId = text(entry?.values?.directory);
    if (entry?.definition === BROWSER_DEFINITION && directoryId && !browserOf.has(directoryId)) {
      browserOf.set(directoryId, entry.id);
    }
  }
  return browserOf;
}

/**
 * The `browse*` values an installation carries: those of a directory
 * installation, none for every other one.
 * @param {object} entry - an entry of `installed`
 * @returns {string[]}
 */
function browseKeysOf(entry) {
  if (entry?.definition !== DIRECTORY_DEFINITION || !isObject(entry.values)) return [];
  return BROWSE_VALUE_KEYS.filter(key => Object.hasOwn(entry.values, key));
}

/**
 * The browser installation of a directory whose LDAP browser was on.
 * @param {object} directory - the directory installation
 * @param {string} browserId - from {@link browserIdFor}
 * @param {object} actions - the browser's action policy ({@link splitActionPolicy})
 * @returns {object} an entry for `integrations.json` → `installed`
 */
function browserInstallation(directory, browserId, actions) {
  const now = new Date().toISOString();
  return {
    id: browserId,
    definition: BROWSER_DEFINITION,
    definitionVersion: BROWSER_DEFINITION_VERSION,
    label: browserLabelOf(directory),
    enabled: directory.enabled !== false,
    values: browserValuesOf(directory.id, directory.values),
    auth: { mode: 'none' },
    actions,
    installedAt: now,
    updatedAt: now
  };
}

/**
 * Create the browser of a directory whose LDAP browser was on: inserted after
 * the directory in `installed`, with the browse actions' entries of the
 * directory's action policy.
 * @param {object} ctx - migration context
 * @param {object} directory - the directory installation
 * @param {Object} state
 * @param {object[]} state.installed - changed in place
 * @param {Set<string>} state.taken - installation ids in use (updated here)
 * @param {Map<string, string>} state.browserOf - directory id → browser id (updated here)
 * @returns {{ browser: object, directoryId: string, browseGroups: string[] }}
 */
function createBrowser(ctx, directory, { installed, taken, browserOf }) {
  const browserId = browserIdFor(directory.id, taken);
  const policy = splitActionPolicy(directory.actions);
  const browser = browserInstallation(directory, browserId, policy.browser);
  const groups = list(directory.values.browseGroups);
  browserOf.set(directory.id, browserId);
  installed.splice(installed.indexOf(directory) + 1, 0, browser);
  if (isObject(directory.actions)) directory.actions = policy.directory;
  ctx.log(
    `People directory "${directory.id}": LDAP browser → installation "${browserId}" (${BROWSER_DEFINITION})`
  );
  return {
    browser,
    directoryId: directory.id,
    browseGroups: groups.length > 0 ? groups : [...DEFAULT_BROWSE_GROUPS]
  };
}

/**
 * Step 1 of {@link up}, in memory: a browser for every directory with the
 * browser on, and no `browse*` value left on any directory.
 * @param {object} ctx - migration context
 * @param {object[]} installed - changed in place
 * @param {Map<string, string>} browserOf - directory id → browser id (updated here)
 * @returns {{ created: Array<{ browser: object, directoryId: string, browseGroups: string[] }>, changed: boolean }}
 */
function createBrowsers(ctx, installed, browserOf) {
  const taken = new Set(installed.filter(entry => entry?.id).map(entry => entry.id));
  const directories = installed.filter(entry => browseKeysOf(entry).length > 0);
  const created = [];
  for (const directory of directories) {
    const values = directory.values;
    if (values.browse === true) {
      created.push(createBrowser(ctx, directory, { installed, taken, browserOf }));
    } else {
      ctx.log(
        `People directory "${directory.id}": the LDAP browser was off; its kept settings (${browseKeysOf(directory).join(', ')}) are removed`
      );
    }
    for (const key of BROWSE_VALUE_KEYS) delete values[key];
  }
  return { created, changed: directories.length > 0 };
}

/**
 * Grant a browser to one of its browse groups (`permissions.integrations`).
 * @param {object} ctx - migration context
 * @param {Object<string, object>} groups - `groups.json` → `groups` (changed in place)
 * @param {string} groupId
 * @param {object} browser - the browser installation
 * @returns {boolean} whether the group changed
 */
function grantBrowser(ctx, groups, groupId, browser) {
  const group = groups[groupId];
  if (!isObject(group)) {
    ctx.warn(
      `LDAP browser "${browser.id}": group "${groupId}" of browseGroups is not defined in groups.json; nobody gets the browser through it`
    );
    return false;
  }
  if (!isObject(group.permissions)) group.permissions = {};
  if (!Array.isArray(group.permissions.integrations)) group.permissions.integrations = [];
  const granted = group.permissions.integrations;
  if (granted.includes(ALL) || granted.includes(browser.id)) {
    ctx.log(`Group "${groupId}" already may use "${browser.id}"`);
    return false;
  }
  granted.push(browser.id);
  ctx.log(`Group "${groupId}" may use the LDAP browser "${browser.id}"`);
  return true;
}

/**
 * Warn about the groups that may use a browser through `*` although they
 * could not browse before ({@link wildcardGainers}).
 * @param {object} ctx - migration context
 * @param {Object<string, object>} groups
 * @param {{ browser: object, browseGroups: string[] }} created
 */
function warnWildcardGainers(ctx, groups, { browser, browseGroups }) {
  const gainers = wildcardGainers(groups, browseGroups);
  if (gainers.length === 0) return;
  ctx.warn(
    `LDAP browser "${browser.id}": groups ${gainers.map(quoted).join(', ')} hold "*" in permissions.integrations and may now use it, ` +
      `although they were not in browseGroups (${browseGroups.join(', ')}). Replace "*" with the installations they need (Admin → Groups → Integrations) if they should not browse.`
  );
}

/**
 * Grant every created browser to its browse groups.
 * @param {object} ctx - migration context
 * @param {Object<string, object>} groups - changed in place
 * @param {Array<{ browser: object, browseGroups: string[] }>} created
 * @returns {boolean} whether a group changed
 */
function grantBrowsers(ctx, groups, created) {
  let changed = false;
  for (const entry of created) {
    for (const groupId of entry.browseGroups) {
      if (grantBrowser(ctx, groups, groupId, entry.browser)) changed = true;
    }
    warnWildcardGainers(ctx, groups, entry);
  }
  return changed;
}

/**
 * Rewrite the browse tool grants of every group ({@link migrateToolGrants}).
 * @param {object} ctx - migration context
 * @param {Object<string, object>} groups - changed in place
 * @param {Map<string, string>} browserOf - directory id → browser id
 * @returns {boolean} whether a group changed
 */
function migrateGroupToolGrants(ctx, groups, browserOf) {
  let changed = false;
  for (const [groupId, group] of Object.entries(groups)) {
    const result = migrateToolGrants(group?.permissions?.tools, browserOf);
    if (!result.changed) continue;
    group.permissions.tools = result.tools;
    changed = true;
    ctx.log(`Group "${groupId}": LDAP browser tool grants → ${JSON.stringify(result.tools)}`);
  }
  return changed;
}

/**
 * Step 2 of {@link up}: the browser grants and the tool grants in `groups.json`.
 * @param {object} ctx - migration context
 * @param {Array<{ browser: object, browseGroups: string[] }>} created
 * @param {Map<string, string>} browserOf - directory id → browser id
 */
async function migrateGroups(ctx, created, browserOf) {
  if (!(await ctx.fileExists(GROUPS_FILE))) {
    if (created.length > 0) {
      ctx.warn(
        'No groups.json: the LDAP browsers are granted to no group; grant them on Admin → Groups'
      );
    }
    return;
  }
  const groupsData = await ctx.readJson(GROUPS_FILE);
  const groups = isObject(groupsData?.groups) ? groupsData.groups : null;
  if (!groups) return;
  const granted = grantBrowsers(ctx, groups, created);
  const toolsChanged = migrateGroupToolGrants(ctx, groups, browserOf);
  if (!granted && !toolsChanged) return;
  if (isObject(groupsData.metadata)) groupsData.metadata.lastModified = new Date().toISOString();
  await ctx.writeJson(GROUPS_FILE, groupsData);
}

/**
 * Step 3 of {@link up}: rewrite every app ({@link migrateApp}). The files are
 * independent, so they are read and written in parallel; the warnings and
 * the log follow the order of the files.
 * @param {object} ctx - migration context
 * @param {{ browserOf: Map<string, string>, directoryIds: Set<string> }} context
 */
async function migrateApps(ctx, context) {
  const files = await ctx.listFiles('apps', '*.json');
  const apps = await Promise.all(
    files.map(async file => {
      const rel = `apps/${file}`;
      return { rel, app: await ctx.readJson(rel) };
    })
  );
  const results = apps
    .filter(entry => entry.app)
    .map(({ rel, app }) => ({ rel, ...migrateApp(app, context) }));
  await Promise.all(
    results.filter(result => result.changed).map(result => ctx.writeJson(result.rel, result.app))
  );
  for (const { rel, changed, notes, warnings } of results) {
    for (const warning of warnings) ctx.warn(`${rel}: ${warning}`);
    if (changed) ctx.log(`${rel}: ${notes.join('; ')}`);
  }
}

export async function up(ctx) {
  const { integrations, installed } = await readInstallations(ctx);

  // 1. Browsers, in memory (written last).
  const browserOf = existingBrowsers(installed);
  const { created, changed } = createBrowsers(ctx, installed, browserOf);

  // 2. Grants and tool grants.
  await migrateGroups(ctx, created, browserOf);

  // 3. Apps.
  const directoryIds = new Set(
    installed.filter(entry => entry?.definition === DIRECTORY_DEFINITION).map(entry => entry.id)
  );
  await migrateApps(ctx, { browserOf, directoryIds });

  // 4. The installations, last.
  if (!changed) return;
  integrations.installed = installed;
  await ctx.writeJson(INTEGRATIONS_FILE, integrations);
  ctx.log(`${created.length} LDAP browser installation(s) created`);
}
