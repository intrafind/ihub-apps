// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V198 — people directories become installed integrations
 *
 * Every directory of `config/peopleDirectories.json` becomes an installation
 * of the built-in definition `com.intrafind/ldap-directory` in
 * `config/integrations.json`, under the same id, so its tool ids
 * (`<id>__search_people`, …), group grants and audit records stay valid:
 *
 * - the directory's fields become install values (`bind.passwordRef` →
 *   `bindPasswordRef`, a credential reference; a plain-text `bind.password`,
 *   which the schema never accepted but a hand-edited file may hold, is
 *   written to the credential store like the install wizard does);
 * - `groups` → `allowedGroups` (`["*"]` → every user, i.e. `[]`; an empty
 *   `groups`, a browse-only directory, switches the search actions off);
 * - `name` → `label`, `description` → `description`; `enabled` is kept.
 *
 * Apps bind the installations instead of listing directories:
 * `requiredIntegrations: ["peopleDirectories"]` and `tools: ["peopleDirectories"]`
 * → `integrations["com.intrafind/ldap-directory"]: {}` (every directory,
 * including later ones); `tools: ["<dirId>"]` → `integrations["<dirId>"]`,
 * narrowed to the action when a tool id (`<dirId>__search_people`) was named.
 * `ldapBrowse` entries and exact `<dirId>__browse_*` ids keep selecting the
 * LDAP browser tools, so they stay; an app that reached the directories only
 * through `requiredIntegrations` and `ldapBrowse` gets the definition binding
 * with `actions: []` (for its visibility), not the people search actions.
 *
 * `config/peopleDirectories.json` is removed; nothing reads it any more. A
 * directory whose id another installation already holds is not moved: it is
 * written to `config/peopleDirectories.unmigrated.json` with a warning, for
 * the admin to install under a free id.
 */
export const version = '198';
export const description = 'people_directories_installed_integrations';

const DIRECTORIES_FILE = 'config/peopleDirectories.json';
/** Directories the migration could not move, for the admin to re-install by hand. */
const UNMIGRATED_FILE = 'config/peopleDirectories.unmigrated.json';
const INTEGRATIONS_FILE = 'config/integrations.json';
const CREDENTIALS_FILE = 'config/credentials.json';
export const DEFINITION = 'com.intrafind/ldap-directory';
const DEFINITION_VERSION = '1.0.0';
/** The retired references of `requiredIntegrations` and `tools`. */
const ALL_DIRECTORIES_REFERENCE = 'peopleDirectories';
const LDAP_BROWSE_REFERENCE = 'ldapBrowse';
export const SEARCH_ACTIONS = ['search_people', 'get_person', 'list_units'];
export const BROWSE_ACTIONS = ['browse_search', 'browse_read', 'browse_children'];

/** The `Person` fields an attribute mapping fills (`services/peopleDirectory/presets.js`, as of V198). */
const MAPPED_PERSON_FIELDS = [
  'name',
  'firstName',
  'lastName',
  'salutation',
  'academicTitle',
  'jobTitle',
  'department',
  'organization',
  'location',
  'email',
  'phone',
  'fax',
  'mobile',
  'managerId'
];

/** The numeric limits of a directory, taken over as they are. */
const LIMIT_KEYS = ['maxResults', 'timeoutMs', 'concurrency', 'requestDelayMs'];

const text = value => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
const list = value =>
  Array.isArray(value) ? value.map(item => String(item).trim()).filter(Boolean) : [];
const number = value => (typeof value === 'number' && !Number.isNaN(value) ? value : undefined);

function put(target, key, value) {
  if (value !== undefined) target[key] = value;
}

/** Put a {@link list} value, unless it is empty. */
function putList(target, key, value) {
  const items = list(value);
  if (items.length) target[key] = items;
}

/**
 * The sources of one attribute mapping, which names one attribute or a list of them.
 * @param {unknown} raw - `attributeMapping[field]`
 * @returns {unknown[]}
 */
function sourcesOf(raw) {
  if (Array.isArray(raw)) return raw;
  return raw ? [raw] : [];
}

/**
 * Put a bind block as `<prefix>Mode`, `<prefix>Dn` and `<prefix>PasswordRef`
 * (`bind…` for the directory, `browseBind…` for the LDAP browser). Only the
 * modes `anonymous` and `service` are taken over; DN and password reference
 * belong to `service` only.
 *
 * @param {Record<string, unknown>} values - the install values being built
 * @param {string} prefix - `bind` or `browseBind`
 * @param {unknown} bind - the entry's `bind` or `browse.bind`
 */
function putBind(values, prefix, bind) {
  const mode = bind?.mode;
  if (mode !== 'anonymous' && mode !== 'service') return;
  values[`${prefix}Mode`] = mode;
  if (mode === 'service') {
    put(values, `${prefix}Dn`, text(bind.dn));
    put(values, `${prefix}PasswordRef`, text(bind.passwordRef));
  }
}

/** The connection values: auth provider, URL, StartTLS, base DN, preset and TLS options. */
function putConnectionValues(values, directory) {
  put(values, 'authProvider', text(directory.authProvider));
  put(values, 'url', text(directory.url));
  if (typeof directory.starttls === 'boolean') values.starttls = directory.starttls;
  put(values, 'baseDn', text(directory.baseDn));
  put(values, 'preset', text(directory.preset));
  put(values, 'tlsMinVersion', text(directory.tlsOptions?.minVersion));
  put(values, 'tlsMaxVersion', text(directory.tlsOptions?.maxVersion));
  put(values, 'tlsCiphers', text(directory.tlsOptions?.ciphers));
}

/** The attribute mapping as `mapping_<field>` values, in {@link MAPPED_PERSON_FIELDS} order. */
function putMappingValues(values, attributeMapping) {
  for (const field of MAPPED_PERSON_FIELDS) {
    putList(values, `mapping_${field}`, sourcesOf(attributeMapping?.[field]));
  }
}

/** The LDAP browser values of an entry whose `browse.enabled` is true. */
function putBrowseValues(values, browse) {
  values.browse = true;
  putList(values, 'browseGroups', browse.groups);
  put(values, 'browseMaxResults', number(browse.maxResults));
  put(values, 'browseBase', text(browse.base));
  putBind(values, 'browseBind', browse.bind);
  putList(values, 'browseDenyAttributes', browse.denyAttributes);
}

/**
 * The install values of a `peopleDirectories.json` entry: the inverse of
 * `ldapDirectoryConfig.directoryFromInstance` as of this migration. Secrets
 * stay references (`bind.passwordRef` → `bindPasswordRef`).
 *
 * @param {object} directory - a `peopleDirectories.json` entry
 * @returns {Record<string, unknown>}
 */
export function valuesFromDirectory(directory) {
  const values = {};
  putConnectionValues(values, directory);
  putBind(values, 'bind', directory.bind);
  put(values, 'searchBase', text(directory.searchBase));
  put(values, 'personFilter', text(directory.personFilter));
  putList(values, 'searchAttributes', directory.searchAttributes);
  putMappingValues(values, directory.attributeMapping);
  if (directory.units === true) values.units = true;
  if (directory.allowPlaintext === true) values.allowPlaintext = true;
  putList(values, 'tlsCa', directory.tlsCa);
  putList(values, 'allowedHosts', directory.allowedHosts);
  for (const key of LIMIT_KEYS) put(values, key, number(directory[key]));
  if (directory.dataFlow === 'external') values.dataFlow = 'external';
  if (directory.browse?.enabled === true) putBrowseValues(values, directory.browse);
  return values;
}

export async function precondition(ctx) {
  if (await ctx.fileExists(DIRECTORIES_FILE)) return true;
  return (await ctx.listFiles('apps', '*.json')).length > 0;
}

function localizedOf(value) {
  if (value === undefined || value === null || value === '') return undefined;
  return typeof value === 'string' ? { en: value } : value;
}

/**
 * The installation a `peopleDirectories.json` entry becomes (without the
 * secrets, see {@link plainPasswordsOf}).
 * @param {object} directory
 */
export function instanceFrom(directory) {
  const groups = Array.isArray(directory.groups) ? directory.groups : ['authenticated'];
  const instance = {
    id: directory.id,
    definition: DEFINITION,
    definitionVersion: DEFINITION_VERSION,
    enabled: directory.enabled !== false,
    values: valuesFromDirectory(directory),
    auth: { mode: 'none' },
    actions: {
      enabled: ['*'],
      // An installation without groups is open to everyone, where a directory
      // without groups was closed (browse-only): its search actions go off.
      disabled: groups.length === 0 ? [...SEARCH_ACTIONS] : [],
      overrides: {}
    },
    allowedGroups: groups.includes('*') ? [] : groups
  };
  const label = localizedOf(directory.name);
  if (label) instance.label = label;
  const desc = localizedOf(directory.description);
  if (desc) instance.description = desc;
  return instance;
}

/**
 * Plain-text bind passwords of an entry (`bind.password`, `browse.bind.password`)
 * with the install field each belongs to. The schema never accepted them, so
 * this only covers a hand-edited file.
 * @param {object} directory
 * @returns {Array<{ field: string, value: string }>}
 */
export function plainPasswordsOf(directory) {
  const out = [];
  const bind = directory.bind;
  if (bind?.mode === 'service' && !bind.passwordRef && typeof bind.password === 'string') {
    if (bind.password) out.push({ field: 'bindPasswordRef', value: bind.password });
  }
  const browseBind = directory.browse?.bind;
  if (
    browseBind?.mode === 'service' &&
    !browseBind.passwordRef &&
    typeof browseBind.password === 'string' &&
    browseBind.password
  ) {
    out.push({ field: 'browseBindPasswordRef', value: browseBind.password });
  }
  return out;
}

/**
 * The people search a tool reference names: every directory
 * (`peopleDirectories`), one directory (`<dirId>`), or one search action of a
 * directory (`<dirId>__search_people`).
 *
 * @param {unknown} ref - an entry of `app.tools`
 * @param {Set<string>} ids - the directory ids
 * @returns {{ all: true } | { id: string, action: string | null } | null} null
 *   for any other reference (`ldapBrowse`, `<dirId>__browse_*`, other tools)
 */
function searchTargetOf(ref, ids) {
  if (typeof ref !== 'string') return null;
  if (ref === ALL_DIRECTORIES_REFERENCE) return { all: true };
  if (ids.has(ref)) return { id: ref, action: null };
  const at = ref.indexOf('__');
  if (at > 0 && ids.has(ref.slice(0, at)) && SEARCH_ACTIONS.includes(ref.slice(at + 2))) {
    return { id: ref.slice(0, at), action: ref.slice(at + 2) };
  }
  return null;
}

/**
 * Record a directory in `perDirectory`: `null` once the whole directory is
 * named (every action, whatever else is named), else the Set of its named actions.
 */
function addSearchTarget(perDirectory, { id, action }) {
  if (action === null) {
    perDirectory.set(id, null);
    return;
  }
  if (!perDirectory.has(id)) perDirectory.set(id, new Set());
  perDirectory.get(id)?.add(action);
}

/**
 * Sort an app's `tools` into the people search references and the rest.
 *
 * @param {unknown} tools - `app.tools`
 * @param {Set<string>} ids - the directory ids
 * @returns {{ kept: unknown[], perDirectory: Map<string, Set<string> | null>, all: boolean, search: boolean }}
 *   `kept`: the references that stay; `perDirectory`: id → Set of actions, or
 *   null for every action; `all`: `peopleDirectories` was named; `search`: any
 *   people search reference was named
 */
function searchSelectionOf(tools, ids) {
  const selection = { kept: [], perDirectory: new Map(), all: false, search: false };
  if (!Array.isArray(tools)) return selection;
  for (const ref of tools) {
    const target = searchTargetOf(ref, ids);
    if (!target) {
      // `ldapBrowse` and `<id>__browse_*` keep selecting the browser tools.
      selection.kept.push(ref);
      continue;
    }
    selection.search = true;
    if (target.all) selection.all = true;
    else addSearchTarget(selection.perDirectory, target);
  }
  return selection;
}

/**
 * Bind the definition, i.e. every directory, including later ones.
 *
 * @param {Record<string, object>} bindings - the app's bindings being built
 * @param {{ kept: unknown[], search: boolean }} selection - see {@link searchSelectionOf}
 * @param {boolean} fromRequirement - `requiredIntegrations` named `peopleDirectories`
 */
function bindEveryDirectory(bindings, selection, fromRequirement) {
  const existing = bindings[DEFINITION] || {};
  const binding = { ...existing };
  if (selection.search) {
    delete binding.actions;
  } else if (
    fromRequirement &&
    selection.kept.includes(LDAP_BROWSE_REFERENCE) &&
    !Array.isArray(existing.actions)
  ) {
    // The app reached the directories through the LDAP browser only: the
    // binding keeps it visible while a directory is installed, the browse
    // tools still come through `ldapBrowse`.
    binding.actions = [];
  }
  bindings[DEFINITION] = binding;
}

/** Bind each named directory, narrowed to the named actions unless all of them are named. */
function bindNamedDirectories(bindings, perDirectory) {
  for (const [id, actions] of perDirectory) {
    const existing = bindings[id] || {};
    const binding = { ...existing };
    if (actions === null || actions.size === SEARCH_ACTIONS.length) delete binding.actions;
    else binding.actions = Array.from(new Set([...(existing.actions || []), ...actions]));
    bindings[id] = binding;
  }
}

/** The app with the retired references removed and the bindings set. */
function rewrittenApp(app, required, kept, bindings) {
  const next = { ...app };
  if (required) {
    const rest = required.filter(id => id !== ALL_DIRECTORIES_REFERENCE);
    if (rest.length) next.requiredIntegrations = rest;
    else delete next.requiredIntegrations;
  }
  if (Array.isArray(app.tools)) {
    if (kept.length) next.tools = kept;
    else delete next.tools;
  }
  if (Object.keys(bindings).length) next.integrations = bindings;
  return next;
}

/**
 * Rewrite an app's directory references to bindings. Returns the app and
 * whether it changed.
 * @param {object} app
 * @param {string[]} directoryIds - Ids of the directories (installed or not)
 */
export function migrateApp(app, directoryIds) {
  if (!app || typeof app !== 'object') return { app, changed: false };
  const ids = new Set(directoryIds);
  const bindings = { ...app.integrations };
  const required = Array.isArray(app.requiredIntegrations) ? app.requiredIntegrations : null;
  const bindAllFromRequirement = required?.includes(ALL_DIRECTORIES_REFERENCE) === true;
  const selection = searchSelectionOf(app.tools, ids);
  const bindAll = bindAllFromRequirement || selection.all;
  if (bindAll) bindEveryDirectory(bindings, selection, bindAllFromRequirement);
  bindNamedDirectories(bindings, selection.perDirectory);
  // A `requiredIntegrations` list is rewritten even without a directory in it.
  if (!bindAll && !selection.search && !required) return { app, changed: false };
  return { app: rewrittenApp(app, required, selection.kept, bindings), changed: true };
}

/** The credential-store entry of a plain-text password the migration moves. */
function credentialOf(instance, field, encryptedValue) {
  const id = `integration-${instance.id}-${field}`;
  return {
    id,
    type: 'secret',
    name: `${instance.label?.en || instance.id}: ${field === 'bindPasswordRef' ? 'bind password' : 'LDAP browser bind password'}`,
    description: `Managed by the installed integration "${instance.id}"`,
    value: encryptedValue
  };
}

/** The entries of `peopleDirectories.json` the migration handles: those with an id. */
function directoriesIn(file) {
  return Array.isArray(file.directories)
    ? file.directories.filter(d => d && typeof d.id === 'string' && d.id)
    : [];
}

/** `config/integrations.json` (empty when absent), with an `installed` list and a `security` block. */
async function readIntegrations(ctx) {
  const integrations = (await ctx.fileExists(INTEGRATIONS_FILE))
    ? (await ctx.readJson(INTEGRATIONS_FILE)) || {}
    : {};
  if (!Array.isArray(integrations.installed)) integrations.installed = [];
  if (!integrations.security) {
    integrations.security = { blockPrivateIps: true, allowedHosts: [] };
  }
  return integrations;
}

/**
 * Whether a directory cannot become an installation, recording its id as seen:
 * a hand-edited file may repeat an id (the first entry was the one in use), or
 * another installation (an MCP server, an agent, a catalog integration) holds
 * the id.
 *
 * @param {{ id: string }} directory
 * @param {Set<string>} seen - the ids of the entries before this one
 * @param {object[]} installed - `integrations.installed`
 */
function isTaken(directory, seen, installed) {
  if (seen.has(directory.id)) return true;
  seen.add(directory.id);
  return installed.some(inst => inst.id === directory.id);
}

/** The credential store's encryption: the injected one, else the token storage service's. */
async function encryptorOf(deps) {
  if (deps.encrypt) return deps.encrypt;
  const { default: tokenStorage } = await import('../services/TokenStorageService.js');
  return v => tokenStorage.encryptString(v);
}

/**
 * Append an installation to `installed` for each directory whose id is free.
 * A plain-text password becomes a credential (returned for the credential
 * store) and the installation keeps a reference to it.
 *
 * @param {object} ctx - migration context
 * @param {object[]} directories - see {@link directoriesIn}
 * @param {object[]} installed - `integrations.installed`, appended to
 * @param {{ encrypt?: (value: string) => string }} deps - see {@link up}
 * @returns {Promise<{ migrated: number, skipped: object[], credentials: object[] }>}
 *   `skipped`: the directories whose id is taken (see {@link isTaken})
 */
async function installDirectories(ctx, directories, installed, deps) {
  const outcome = { migrated: 0, skipped: [], credentials: [] };
  const seen = new Set();
  // Sequential on purpose: the installations and their log lines follow the file
  // order, and the token storage is loaded only once a plain-text password needs it.
  for (const directory of directories) {
    if (isTaken(directory, seen, installed)) {
      // Kept in a side file instead of being lost with peopleDirectories.json.
      outcome.skipped.push(directory);
      continue;
    }
    const instance = instanceFrom(directory);
    const passwords = plainPasswordsOf(directory);
    const encrypt = passwords.length ? await encryptorOf(deps) : undefined;
    for (const { field, value } of passwords) {
      const credential = credentialOf(instance, field, encrypt(value));
      outcome.credentials.push(credential);
      instance.values[field] = credential.id;
      ctx.log(
        `People directory "${directory.id}": plain-text password moved to credential "${credential.id}"`
      );
    }
    const now = new Date().toISOString();
    instance.installedAt = now;
    instance.updatedAt = now;
    installed.push(instance);
    outcome.migrated += 1;
    ctx.log(`People directory "${directory.id}" → installed integration (${DEFINITION})`);
  }
  return outcome;
}

/** Add the credentials of the moved passwords to `config/credentials.json`. */
async function storeCredentials(ctx, credentials) {
  const store = (await ctx.fileExists(CREDENTIALS_FILE))
    ? (await ctx.readJson(CREDENTIALS_FILE)) || {}
    : {};
  if (!store.credentials || typeof store.credentials !== 'object') store.credentials = {};
  for (const credential of credentials) store.credentials[credential.id] = credential;
  await ctx.writeJson(CREDENTIALS_FILE, store);
}

/** An app file with its path relative to the contents directory. */
async function readApp(ctx, file) {
  const rel = `apps/${file}`;
  return { rel, app: await ctx.readJson(rel) };
}

/**
 * Rewrite the directory references of every app (see {@link migrateApp}).
 * @param {object} ctx - migration context
 * @param {string[]} directoryIds - every directory id, moved or not
 */
async function migrateApps(ctx, directoryIds) {
  const files = await ctx.listFiles('apps', '*.json');
  const reads = await Promise.allSettled(files.map(file => readApp(ctx, file)));
  // Sequential on purpose: the apps are written and logged in listing order, and a
  // failed read or write stops the migration at that app with the ones before it written.
  for (const read of reads) {
    if (read.status === 'rejected') throw read.reason;
    const { rel, app } = read.value;
    if (!app) continue;
    const { app: next, changed } = migrateApp(app, directoryIds);
    if (changed) {
      await ctx.writeJson(rel, next);
      ctx.log(`${rel}: people directory references → integrations binding`);
    }
  }
}

/** Keep the directories that could not be moved in a side file, and say so. */
async function keepUnmigrated(ctx, skipped) {
  await ctx.writeJson(UNMIGRATED_FILE, { directories: skipped });
  const ids = skipped.map(d => `"${d.id}"`).join(', ');
  ctx.warn(
    `${skipped.length} people director${skipped.length === 1 ? 'y' : 'ies'} not migrated because an installed integration already has the id: ${ids}. Kept in ${UNMIGRATED_FILE}; install each as "LDAP people directory" under a free id and bind it to its apps.`
  );
}

/**
 * @param {object} ctx - migration context
 * @param {{ encrypt?: (value: string) => string }} [deps] - the credential
 *   store's encryption (the token storage service when absent; injectable for tests)
 */
export async function up(ctx, deps = {}) {
  const hadFile = await ctx.fileExists(DIRECTORIES_FILE);
  const directories = directoriesIn(hadFile ? (await ctx.readJson(DIRECTORIES_FILE)) || {} : {});
  const integrations = await readIntegrations(ctx);

  const { migrated, skipped, credentials } = await installDirectories(
    ctx,
    directories,
    integrations.installed,
    deps
  );
  if (hadFile || migrated > 0) await ctx.writeJson(INTEGRATIONS_FILE, integrations);
  if (credentials.length) await storeCredentials(ctx, credentials);

  // Apps: every directory id, moved or not, so a reference to a skipped
  // directory still becomes the binding the admin completes by installing it.
  const directoryIds = [
    ...directories.map(d => d.id),
    ...integrations.installed.filter(inst => inst.definition === DEFINITION).map(inst => inst.id)
  ];
  await migrateApps(ctx, directoryIds);

  if (skipped.length) await keepUnmigrated(ctx, skipped);
  if (hadFile) {
    await ctx.deleteFile(DIRECTORIES_FILE);
    ctx.log(`${DIRECTORIES_FILE} removed: people directories are installed integrations now`);
  }
}
