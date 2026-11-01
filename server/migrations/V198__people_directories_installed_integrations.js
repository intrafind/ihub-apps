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

const text = value => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
const list = value =>
  Array.isArray(value) ? value.map(item => String(item).trim()).filter(Boolean) : [];
const number = value => (typeof value === 'number' && !Number.isNaN(value) ? value : undefined);

function put(target, key, value) {
  if (value !== undefined) target[key] = value;
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
  put(values, 'authProvider', text(directory.authProvider));
  put(values, 'url', text(directory.url));
  if (typeof directory.starttls === 'boolean') values.starttls = directory.starttls;
  put(values, 'baseDn', text(directory.baseDn));
  put(values, 'preset', text(directory.preset));
  put(values, 'tlsMinVersion', text(directory.tlsOptions?.minVersion));
  put(values, 'tlsMaxVersion', text(directory.tlsOptions?.maxVersion));
  put(values, 'tlsCiphers', text(directory.tlsOptions?.ciphers));
  if (directory.bind?.mode === 'anonymous' || directory.bind?.mode === 'service') {
    values.bindMode = directory.bind.mode;
    if (directory.bind.mode === 'service') {
      put(values, 'bindDn', text(directory.bind.dn));
      put(values, 'bindPasswordRef', text(directory.bind.passwordRef));
    }
  }
  put(values, 'searchBase', text(directory.searchBase));
  put(values, 'personFilter', text(directory.personFilter));
  const searchAttributes = list(directory.searchAttributes);
  if (searchAttributes.length) values.searchAttributes = searchAttributes;
  for (const field of MAPPED_PERSON_FIELDS) {
    const raw = directory.attributeMapping?.[field];
    const sources = list(Array.isArray(raw) ? raw : raw ? [raw] : []);
    if (sources.length) values[`mapping_${field}`] = sources;
  }
  if (directory.units === true) values.units = true;
  if (directory.allowPlaintext === true) values.allowPlaintext = true;
  const tlsCa = list(directory.tlsCa);
  if (tlsCa.length) values.tlsCa = tlsCa;
  const allowedHosts = list(directory.allowedHosts);
  if (allowedHosts.length) values.allowedHosts = allowedHosts;
  for (const key of ['maxResults', 'timeoutMs', 'concurrency', 'requestDelayMs']) {
    put(values, key, number(directory[key]));
  }
  if (directory.dataFlow === 'external') values.dataFlow = 'external';
  const browse = directory.browse;
  if (browse?.enabled === true) {
    values.browse = true;
    const groups = list(browse.groups);
    if (groups.length) values.browseGroups = groups;
    put(values, 'browseMaxResults', number(browse.maxResults));
    put(values, 'browseBase', text(browse.base));
    if (browse.bind?.mode === 'anonymous' || browse.bind?.mode === 'service') {
      values.browseBindMode = browse.bind.mode;
      if (browse.bind.mode === 'service') {
        put(values, 'browseBindDn', text(browse.bind.dn));
        put(values, 'browseBindPasswordRef', text(browse.bind.passwordRef));
      }
    }
    const deny = list(browse.denyAttributes);
    if (deny.length) values.browseDenyAttributes = deny;
  }
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
 * Rewrite an app's directory references to bindings. Returns the app and
 * whether it changed.
 * @param {object} app
 * @param {string[]} directoryIds - Ids of the directories (installed or not)
 */
export function migrateApp(app, directoryIds) {
  if (!app || typeof app !== 'object') return { app, changed: false };
  const ids = new Set(directoryIds);
  const bindings = { ...(app.integrations || {}) };
  let changed = false;
  let bindAll = false;
  let bindAllFromRequirement = false;

  const required = Array.isArray(app.requiredIntegrations) ? app.requiredIntegrations : null;
  if (required && required.includes(ALL_DIRECTORIES_REFERENCE)) {
    bindAll = true;
    bindAllFromRequirement = true;
  }

  const kept = [];
  const perDirectory = new Map(); // id → Set of actions, or null for every action
  let selectsSearch = false;
  if (Array.isArray(app.tools)) {
    for (const ref of app.tools) {
      if (typeof ref !== 'string') {
        kept.push(ref);
        continue;
      }
      if (ref === ALL_DIRECTORIES_REFERENCE) {
        bindAll = true;
        selectsSearch = true;
        changed = true;
        continue;
      }
      if (ids.has(ref)) {
        perDirectory.set(ref, null);
        selectsSearch = true;
        changed = true;
        continue;
      }
      const at = ref.indexOf('__');
      if (at > 0 && ids.has(ref.slice(0, at)) && SEARCH_ACTIONS.includes(ref.slice(at + 2))) {
        const id = ref.slice(0, at);
        const action = ref.slice(at + 2);
        if (!perDirectory.has(id)) perDirectory.set(id, new Set());
        perDirectory.get(id)?.add(action);
        selectsSearch = true;
        changed = true;
        continue;
      }
      // `ldapBrowse` and `<id>__browse_*` keep selecting the browser tools.
      kept.push(ref);
    }
  }

  if (bindAll) {
    const existing = bindings[DEFINITION] || {};
    const binding = { ...existing };
    if (selectsSearch) {
      delete binding.actions;
    } else if (
      bindAllFromRequirement &&
      kept.includes(LDAP_BROWSE_REFERENCE) &&
      !Array.isArray(existing.actions)
    ) {
      // The app reached the directories through the LDAP browser only: the
      // binding keeps it visible while a directory is installed, the browse
      // tools still come through `ldapBrowse`.
      binding.actions = [];
    }
    bindings[DEFINITION] = binding;
    changed = true;
  }
  for (const [id, actions] of perDirectory) {
    const existing = bindings[id] || {};
    const binding = { ...existing };
    if (actions === null || actions.size === SEARCH_ACTIONS.length) delete binding.actions;
    else binding.actions = Array.from(new Set([...(existing.actions || []), ...actions]));
    bindings[id] = binding;
  }

  if (required) changed = true;
  if (!changed) return { app, changed: false };

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
  return { app: next, changed: true };
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

/**
 * @param {object} ctx - migration context
 * @param {{ encrypt?: (value: string) => string }} [deps] - the credential
 *   store's encryption (the token storage service when absent; injectable for tests)
 */
export async function up(ctx, deps = {}) {
  const hadFile = await ctx.fileExists(DIRECTORIES_FILE);
  const file = hadFile ? (await ctx.readJson(DIRECTORIES_FILE)) || {} : {};
  const directories = Array.isArray(file.directories)
    ? file.directories.filter(d => d && typeof d.id === 'string' && d.id)
    : [];

  const integrations = (await ctx.fileExists(INTEGRATIONS_FILE))
    ? (await ctx.readJson(INTEGRATIONS_FILE)) || {}
    : {};
  if (!Array.isArray(integrations.installed)) integrations.installed = [];
  if (!integrations.security) {
    integrations.security = { blockPrivateIps: true, allowedHosts: [] };
  }

  let migrated = 0;
  const skipped = [];
  const credentials = [];
  const seen = new Set();
  for (const directory of directories) {
    if (seen.has(directory.id)) {
      // A hand-edited file may repeat an id; the first entry was the one in use.
      skipped.push(directory);
      continue;
    }
    seen.add(directory.id);
    if (integrations.installed.some(inst => inst.id === directory.id)) {
      // Another installation (an MCP server, an agent, a catalog integration)
      // holds the id. The directory cannot take it; it is kept in a side file
      // below instead of being lost with peopleDirectories.json.
      skipped.push(directory);
      continue;
    }
    const instance = instanceFrom(directory);
    for (const { field, value } of plainPasswordsOf(directory)) {
      let encrypt = deps.encrypt;
      if (!encrypt) {
        const { default: tokenStorage } = await import('../services/TokenStorageService.js');
        encrypt = v => tokenStorage.encryptString(v);
      }
      const credential = credentialOf(instance, field, encrypt(value));
      credentials.push(credential);
      instance.values[field] = credential.id;
      ctx.log(
        `People directory "${directory.id}": plain-text password moved to credential "${credential.id}"`
      );
    }
    const now = new Date().toISOString();
    instance.installedAt = now;
    instance.updatedAt = now;
    integrations.installed.push(instance);
    migrated += 1;
    ctx.log(`People directory "${directory.id}" → installed integration (${DEFINITION})`);
  }
  if (hadFile || migrated > 0) await ctx.writeJson(INTEGRATIONS_FILE, integrations);

  if (credentials.length) {
    const store = (await ctx.fileExists(CREDENTIALS_FILE))
      ? (await ctx.readJson(CREDENTIALS_FILE)) || {}
      : {};
    if (!store.credentials || typeof store.credentials !== 'object') store.credentials = {};
    for (const credential of credentials) store.credentials[credential.id] = credential;
    await ctx.writeJson(CREDENTIALS_FILE, store);
  }

  // Apps: every directory id, moved or not, so a reference to a skipped
  // directory still becomes the binding the admin completes by installing it.
  const directoryIds = [
    ...directories.map(d => d.id),
    ...integrations.installed.filter(inst => inst.definition === DEFINITION).map(inst => inst.id)
  ];
  for (const file of await ctx.listFiles('apps', '*.json')) {
    const rel = `apps/${file}`;
    const app = await ctx.readJson(rel);
    if (!app) continue;
    const { app: next, changed } = migrateApp(app, directoryIds);
    if (changed) {
      await ctx.writeJson(rel, next);
      ctx.log(`${rel}: people directory references → integrations binding`);
    }
  }

  if (skipped.length) {
    await ctx.writeJson(UNMIGRATED_FILE, { directories: skipped });
    ctx.warn(
      `${skipped.length} people director${skipped.length === 1 ? 'y' : 'ies'} not migrated because an installed integration already has the id: ${skipped
        .map(d => `"${d.id}"`)
        .join(
          ', '
        )}. Kept in ${UNMIGRATED_FILE}; install each as "LDAP people directory" under a free id and bind it to its apps.`
    );
  }
  if (hadFile) {
    await ctx.deleteFile(DIRECTORIES_FILE);
    ctx.log(`${DIRECTORIES_FILE} removed: people directories are installed integrations now`);
  }
}
