// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V205 — storage providers: several installations per provider,
 * the installation id is the provider id, apps bind them (#3094)
 *
 * Until now the storage providers Office 365 (`com.intrafind/office365`),
 * Google Drive (`com.intrafind/google-drive`) and Nextcloud
 * (`com.intrafind/nextcloud`) were singletons (`office365`, `googledrive`,
 * `nextcloud`, created by V200 from `platform.cloudStorage`), each with a
 * `providerId` value that kept the id the provider had before. From now on a
 * provider can be installed any number of times, and the installation id IS
 * the provider id: it names the provider in the OAuth routes, the callback URL
 * (`/api/integrations/<service>/<id>/callback`), the users' stored
 * connections (`<userId>__<id>.json`), project cloud documents and the
 * Nextcloud embed plugin.
 *
 * 1. **Rename.** Each storage installation whose `values.providerId` differs
 *    from its id is renamed to that provider id, so none of the above
 *    changes. `providerId` is dropped from every storage installation.
 *    References to the old id are rewritten: `groups.json` →
 *    `permissions.integrations` entries and the keys of `app.integrations`.
 *    Example: `{ id: "office365", values: { providerId: "o365-corp" } }`
 *    becomes `{ id: "o365-corp" }`, and a group granting `["office365"]` now
 *    grants `["o365-corp"]`. When the provider id cannot be an installation id
 *    (another installation holds it, it is reserved or not a valid id) the
 *    installation keeps its id and a warning says that users reconnect and the
 *    admin registers the redirect URI of the installation id.
 * 2. **Unmigrated providers.** The providers V200 parked in
 *    `config/cloudStorage.unmigrated.json` (a second provider of one type)
 *    become further installations under their provider id (a fallback id
 *    `<type>-<provider id>` with a warning when that is taken), with the
 *    secrets handled as V200 did: `clientSecretRef` stays the credential
 *    reference, a plain-text `clientSecret` goes into the credential store as
 *    `integration-<id>-clientSecretRef`, Office 365's `tenantIdRef` is
 *    decrypted into the plain `tenantId`. The file is then deleted; providers
 *    of an unknown type stay in it with a warning.
 * 3. **Credential store leftovers** (#3094): the Office 365 tenant id was a
 *    credential (V061, `tenantIdRef`) until V200 decrypted it into the
 *    installation and left the entry behind. An entry is deleted when it is
 *    a tenant id credential — created by V061 (`cloudstorage_<id>_tenant`),
 *    named by an unmigrated provider's `tenantIdRef`, or a `secret` whose id
 *    or name mentions "tenant" and whose value is an Office 365
 *    installation's tenant id — and no config file names it any more.
 * 4. **App binding.** Every app with `upload.cloudStorageUpload.enabled: true`
 *    binds every storage provider as optional:
 *    `app.integrations["type:storage"] = { required: false }`. The switch
 *    `upload.cloudStorageUpload` is removed from every app (the app schema
 *    refuses it from now on). Apps in `apps/*.json` and the legacy
 *    `config/apps.json` array are migrated.
 *
 * Idempotent: a second run finds no `providerId`, no unmigrated file, no
 * leftover credential and no `cloudStorageUpload`. Missing files are a no-op.
 * References are written before `integrations.json`, so a run that stops
 * half-way finds the renames again on the next start.
 *
 * Self-contained (see `server/migrations/README.md`): the only application
 * code is the credential store's encryption, imported lazily as V200 does and
 * injectable for tests.
 */

export const version = '205';
export const description = 'storage_provider_installations';

const INTEGRATIONS_FILE = 'config/integrations.json';
const GROUPS_FILE = 'config/groups.json';
const CREDENTIALS_FILE = 'config/credentials.json';
const LEGACY_APPS_FILE = 'config/apps.json';
/** Providers V200 could not move (one installation per type then). */
const UNMIGRATED_FILE = 'config/cloudStorage.unmigrated.json';

/** Provider type → its definition, as of this migration (2026-11-02). */
export const STORAGE_DEFINITIONS = Object.freeze({
  office365: 'com.intrafind/office365',
  googledrive: 'com.intrafind/google-drive',
  nextcloud: 'com.intrafind/nextcloud'
});
const STORAGE_DEFINITION_IDS = new Set(Object.values(STORAGE_DEFINITIONS));
const DEFINITION_VERSION = '1.0.0';

/** The `app.integrations` key that binds every storage provider. */
export const STORAGE_TYPE_BINDING = 'type:storage';

/**
 * Installation ids no storage provider may take, as of 2026-11-02: the ids
 * InstalledIntegrationService reserves and the fixed ids of the built-in
 * singletons (iFinder, iAssistant, iHub, Jira, Entra, web search and its
 * engines). Snapshot — do NOT replace with a registry lookup.
 */
export const RESERVED_IDS = Object.freeze([
  'a2a',
  'app',
  'workflow',
  'knowledge',
  'ifinder',
  'iassistant',
  'ihub',
  'jira',
  'entra',
  'websearch',
  'brave',
  'staan',
  'qwant'
]);
const RESERVED_PREFIX = /^(workflow|knowledge|source)_/i;
/** An installation id: the safe id characters, at most 64 (`integrationsConfigSchema`). */
const INSTANCE_ID_PATTERN = /^[a-zA-Z0-9._-]{1,64}$/;
/** Credential ids V061 gave the Office 365 tenant id (`cloudstorage_<id>_tenant`, `…_tenant_2`). */
const V061_TENANT_CREDENTIAL = /^cloudstorage_.+_tenant(_\d+)?$/;
/** Directories whose JSON files may name a credential. */
const REFERENCE_DIRS = Object.freeze(['config', 'apps', 'tools', 'models', 'sources', 'workflows']);

export async function precondition(ctx) {
  if (await ctx.fileExists(INTEGRATIONS_FILE)) return true;
  if (await ctx.fileExists(UNMIGRATED_FILE)) return true;
  if (await ctx.fileExists(LEGACY_APPS_FILE)) return true;
  return (await ctx.listFiles('apps', '*.json')).length > 0;
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** The provider type of a storage definition id, or null. */
export function storageTypeOf(definitionId) {
  return (
    Object.keys(STORAGE_DEFINITIONS).find(t => STORAGE_DEFINITIONS[t] === definitionId) || null
  );
}

/**
 * Whether `id` can be the id of a new or renamed installation.
 * @param {unknown} id
 * @param {Set<string>} taken - the ids other installations hold
 * @returns {boolean}
 */
export function isUsableId(id, taken) {
  return (
    typeof id === 'string' &&
    INSTANCE_ID_PATTERN.test(id) &&
    !id.includes('__') &&
    !RESERVED_IDS.includes(id.toLowerCase()) &&
    !RESERVED_PREFIX.test(id) &&
    !taken.has(id)
  );
}

/**
 * A free id for a provider whose own id cannot be used:
 * `<type>-<provider id>` cleaned up, then `-2`, `-3`, … until free.
 * @param {string} type
 * @param {string|undefined} providerId
 * @param {Set<string>} taken
 * @returns {string}
 */
export function fallbackId(type, providerId, taken) {
  const cleaned = String(providerId || '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/_{2,}/g, '_')
    .replace(/^[-._]+|[-._]+$/g, '');
  const base = (cleaned ? `${type}-${cleaned}` : type).slice(0, 56);
  if (isUsableId(base, taken)) return base;
  let n = 2;
  while (!isUsableId(`${base}-${n}`, taken)) n += 1;
  return `${base}-${n}`;
}

/**
 * The installation an unmigrated provider becomes, without its secrets (a
 * snapshot of V200's `instanceFrom`, minus the retired `providerId` value).
 * @param {object} provider - a former `cloudStorage.providers[]` entry
 * @param {string} id - the installation id
 * @param {boolean} [cloudStorageEnabled] - the former block's `enabled`
 * @returns {object|null}
 */
export function instanceFrom(provider, id, cloudStorageEnabled = true) {
  const definition = STORAGE_DEFINITIONS[provider?.type];
  if (!definition) return null;
  const values = {};
  if (text(provider.clientId)) values.clientId = text(provider.clientId);
  if (text(provider.clientSecretRef)) values.clientSecretRef = text(provider.clientSecretRef);
  if (text(provider.redirectUri)) values.redirectUri = text(provider.redirectUri);
  const sources = provider.sources || {};
  if (provider.type === 'office365') {
    if (text(provider.tenantId)) values.tenantId = text(provider.tenantId);
    if (text(provider.siteUrl)) values.siteUrl = text(provider.siteUrl);
    if (text(provider.driveId)) values.driveId = text(provider.driveId);
    if (sources.personalDrive === false) values.sourcePersonalDrive = false;
    if (sources.followedSites === false) values.sourceFollowedSites = false;
    if (sources.teams === false) values.sourceTeams = false;
  } else if (provider.type === 'googledrive') {
    if (sources.myDrive === false) values.sourceMyDrive = false;
    if (sources.sharedDrives === false) values.sourceSharedDrives = false;
    if (sources.sharedWithMe === false) values.sourceSharedWithMe = false;
  } else if (provider.type === 'nextcloud') {
    if (text(provider.serverUrl)) values.serverUrl = text(provider.serverUrl);
  }
  const instance = {
    id,
    definition,
    definitionVersion: DEFINITION_VERSION,
    enabled: cloudStorageEnabled !== false && provider.enabled !== false,
    values,
    auth: { mode: 'oauth-user' },
    actions: { enabled: ['*'], disabled: [], overrides: {} }
  };
  const label = text(provider.displayName) || text(provider.name);
  if (label) instance.label = { en: label };
  return instance;
}

/**
 * Rename the storage installations to their `providerId` and drop the value
 * (step 1). Mutates the installations.
 * @param {object[]} installed - `integrations.json` → `installed`
 * @param {object} ctx - for the log
 * @returns {{ renames: Map<string, string>, changed: boolean }}
 */
export function renameToProviderIds(installed, ctx) {
  const renames = new Map();
  let changed = false;
  for (const instance of installed) {
    if (!instance || !STORAGE_DEFINITION_IDS.has(instance.definition)) continue;
    const values = instance.values && typeof instance.values === 'object' ? instance.values : null;
    if (!values || !Object.hasOwn(values, 'providerId')) continue;
    const providerId = text(values.providerId);
    delete values.providerId;
    changed = true;
    if (!providerId || providerId === instance.id) {
      ctx.log(`Storage installation "${instance.id}": providerId value dropped (same id)`);
      continue;
    }
    const taken = new Set(installed.filter(i => i && i !== instance).map(i => i.id));
    if (!isUsableId(providerId, taken)) {
      ctx.warn(
        `Storage installation "${instance.id}" keeps its id: its provider id "${providerId}" cannot be an installation id (taken, reserved or invalid). Users connected to "${providerId}" have to connect again, and the redirect URI of the installation id has to be registered with the provider.`
      );
      continue;
    }
    renames.set(instance.id, providerId);
    ctx.log(
      `Storage installation "${instance.id}" renamed to its provider id "${providerId}" (callback URL and user connections unchanged)`
    );
    instance.id = providerId;
    instance.updatedAt = new Date().toISOString();
  }
  return { renames, changed };
}

/**
 * Rewrite a group list of `permissions.integrations` for the renames.
 * @param {unknown} list
 * @param {Map<string, string>} renames
 * @returns {string[]|null} the new list, or null when nothing changed
 */
export function renamedGrants(list, renames) {
  if (!Array.isArray(list) || renames.size === 0) return null;
  if (!list.some(entry => renames.has(entry))) return null;
  return [...new Set(list.map(entry => (renames.has(entry) ? renames.get(entry) : entry)))];
}

/**
 * Migrate one app: rename bindings of renamed installations and replace
 * `upload.cloudStorageUpload` by the `type:storage` binding (step 4).
 * Mutates the app.
 * @param {object} app
 * @param {Map<string, string>} renames
 * @returns {string[]} what changed, for the log; empty when nothing did
 */
export function migrateApp(app, renames) {
  const changes = [];
  if (!app || typeof app !== 'object') return changes;
  const bindings =
    app.integrations && typeof app.integrations === 'object' && !Array.isArray(app.integrations)
      ? app.integrations
      : null;
  if (bindings) {
    for (const [from, to] of renames) {
      if (!Object.hasOwn(bindings, from)) continue;
      if (!Object.hasOwn(bindings, to)) bindings[to] = bindings[from];
      delete bindings[from];
      changes.push(`binding "${from}" → "${to}"`);
    }
  }
  const upload = app.upload && typeof app.upload === 'object' ? app.upload : null;
  if (upload && Object.hasOwn(upload, 'cloudStorageUpload')) {
    const enabled = upload.cloudStorageUpload?.enabled === true;
    delete upload.cloudStorageUpload;
    if (enabled) {
      if (!app.integrations || typeof app.integrations !== 'object') app.integrations = {};
      if (!Object.hasOwn(app.integrations, STORAGE_TYPE_BINDING)) {
        app.integrations[STORAGE_TYPE_BINDING] = { required: false };
      }
      changes.push(`upload.cloudStorageUpload → integrations["${STORAGE_TYPE_BINDING}"]`);
    } else {
      changes.push('upload.cloudStorageUpload (off) removed');
    }
  }
  return changes;
}

/** Every string anywhere in a JSON value. */
function collectStrings(value, out) {
  if (typeof value === 'string') out.add(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out);
  else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, out);
  }
  return out;
}

/** The value a credential entry stores (string or `{ value }`). */
function storedValueOf(entry) {
  if (typeof entry === 'string') return entry;
  return typeof entry?.value === 'string' ? entry.value : undefined;
}

/**
 * @param {object} ctx - migration context
 * @param {{ crypto?: { encrypt: (v: string) => string, decrypt: (v: string) => string } }} [deps]
 *   the credential store's encryption (the token storage service when absent; injectable for tests)
 */
export async function up(ctx, deps = {}) {
  let cryptoTools = deps.crypto;
  async function tools() {
    if (!cryptoTools) {
      const { default: tokenStorage } = await import('../services/TokenStorageService.js');
      // Migrations run before the server loads the key; V200 did not, so its
      // tenant id decryption could never succeed (see step 3).
      if (!tokenStorage.encryptionKey) await tokenStorage.initializeEncryptionKey();
      cryptoTools = {
        encrypt: value => tokenStorage.encryptString(value),
        decrypt: value => tokenStorage.decryptString(value)
      };
    }
    return cryptoTools;
  }
  /** Decrypt a stored credential value; plain text passes, a failure is undefined. */
  async function plainOf(stored) {
    if (typeof stored !== 'string' || !stored) return undefined;
    if (!stored.startsWith('ENC[')) return stored;
    try {
      return (await tools()).decrypt(stored);
    } catch {
      return undefined;
    }
  }

  const hasConfig = await ctx.fileExists(INTEGRATIONS_FILE);
  const config = hasConfig ? (await ctx.readJson(INTEGRATIONS_FILE)) || {} : {};
  if (!Array.isArray(config.installed)) config.installed = [];
  const installed = config.installed;

  let store = null;
  async function credentialStore() {
    if (!store) {
      store = (await ctx.fileExists(CREDENTIALS_FILE))
        ? (await ctx.readJson(CREDENTIALS_FILE)) || {}
        : {};
      if (!store.credentials || typeof store.credentials !== 'object') store.credentials = {};
    }
    return store;
  }
  let credentialsAdded = false;

  // 1. Rename the installations to their provider ids.
  const { renames, changed: renamedAny } = renameToProviderIds(installed, ctx);
  let integrationsChanged = renamedAny;

  // 2. Install the providers V200 parked.
  /** Credentials an unmigrated provider named as its tenant id. */
  const unmigratedTenantRefs = new Set();
  let unmigrated = null;
  const leftovers = [];
  if (await ctx.fileExists(UNMIGRATED_FILE)) {
    unmigrated = (await ctx.readJson(UNMIGRATED_FILE)) || {};
    const providers = Array.isArray(unmigrated.providers)
      ? unmigrated.providers.filter(Boolean)
      : [];
    for (const provider of providers) {
      if (!STORAGE_DEFINITIONS[provider.type]) {
        leftovers.push(provider);
        ctx.warn(
          `Unmigrated cloud storage provider "${provider.id}" has an unknown type "${provider.type}"; kept in ${UNMIGRATED_FILE}`
        );
        continue;
      }
      const taken = new Set(installed.filter(Boolean).map(i => i.id));
      const ownId = text(provider.id);
      const id = isUsableId(ownId, taken) ? ownId : fallbackId(provider.type, ownId, taken);
      const instance = instanceFrom(provider, id, unmigrated.enabled);
      if (id !== ownId) {
        ctx.warn(
          `Cloud storage provider "${ownId}" (${provider.type}) installed as "${id}": its own id cannot be an installation id. Users connect again, and the redirect URI of "${id}" has to be registered with the provider.`
        );
      }
      if (
        provider.type === 'office365' &&
        !instance.values.tenantId &&
        text(provider.tenantIdRef)
      ) {
        const ref = text(provider.tenantIdRef);
        const plain = await plainOf(storedValueOf((await credentialStore()).credentials[ref]));
        if (plain) {
          instance.values.tenantId = plain;
          unmigratedTenantRefs.add(ref);
        } else {
          ctx.warn(
            `Office 365 provider "${ownId}": the tenant id credential "${ref}" was not found or could not be decrypted; enter the tenant id on the installation "${id}"`
          );
        }
      }
      if (!text(provider.clientSecretRef) && text(provider.clientSecret)) {
        const credentialId = `integration-${id}-clientSecretRef`;
        const credentials = (await credentialStore()).credentials;
        if (!Object.hasOwn(credentials, credentialId)) {
          credentials[credentialId] = {
            id: credentialId,
            type: 'secret',
            name: `${instance.label?.en || id}: client secret`,
            description: `Managed by the installed integration "${id}"`,
            value: (await tools()).encrypt(text(provider.clientSecret))
          };
          credentialsAdded = true;
        }
        instance.values.clientSecretRef = credentialId;
        ctx.log(
          `Cloud storage provider "${ownId}": client secret moved to credential "${credentialId}"`
        );
      }
      const now = new Date().toISOString();
      instance.installedAt = now;
      instance.updatedAt = now;
      installed.push(instance);
      integrationsChanged = true;
      ctx.log(
        `Unmigrated cloud storage provider "${ownId}" (${provider.type}) → installed integration "${id}" (${instance.enabled ? 'enabled' : 'disabled'})`
      );
    }
  }

  if (credentialsAdded) await ctx.writeJson(CREDENTIALS_FILE, store);

  // 4 (references first). Groups: grants of renamed installations.
  if (renames.size > 0 && (await ctx.fileExists(GROUPS_FILE))) {
    const groupsFile = (await ctx.readJson(GROUPS_FILE)) || {};
    let groupsChanged = false;
    for (const [groupId, group] of Object.entries(groupsFile.groups || {})) {
      const next = renamedGrants(group?.permissions?.integrations, renames);
      if (!next) continue;
      group.permissions.integrations = next;
      groupsChanged = true;
      ctx.log(`Group "${groupId}": storage provider grants renamed`);
    }
    if (groupsChanged) await ctx.writeJson(GROUPS_FILE, groupsFile);
  }

  // Apps: renamed bindings and the storage binding instead of the switch.
  let bound = 0;
  for (const file of await ctx.listFiles('apps', '*.json')) {
    const rel = `apps/${file}`;
    let app;
    try {
      app = await ctx.readJson(rel);
    } catch (error) {
      ctx.warn(`Skipped ${rel}: ${error.message}`);
      continue;
    }
    const changes = migrateApp(app, renames);
    if (changes.length === 0) continue;
    if (app.integrations?.[STORAGE_TYPE_BINDING]) bound += 1;
    await ctx.writeJson(rel, app);
    ctx.log(`App "${app.id || file}": ${changes.join(', ')}`);
  }
  if (await ctx.fileExists(LEGACY_APPS_FILE)) {
    let apps = null;
    try {
      apps = await ctx.readJson(LEGACY_APPS_FILE);
    } catch (error) {
      ctx.warn(`Skipped ${LEGACY_APPS_FILE}: ${error.message}`);
    }
    if (Array.isArray(apps)) {
      let legacyChanged = false;
      for (const app of apps) {
        const changes = migrateApp(app, renames);
        if (changes.length === 0) continue;
        legacyChanged = true;
        ctx.log(`App "${app?.id}" (${LEGACY_APPS_FILE}): ${changes.join(', ')}`);
      }
      if (legacyChanged) await ctx.writeJson(LEGACY_APPS_FILE, apps);
    }
  }
  if (bound > 0) ctx.log(`${bound} app(s) bind every storage provider (type:storage, optional)`);

  // The installations themselves.
  if (integrationsChanged) {
    if (!config.security) config.security = { blockPrivateIps: true, allowedHosts: [] };
    await ctx.writeJson(INTEGRATIONS_FILE, config);
  }

  if (unmigrated) {
    if (leftovers.length > 0) {
      await ctx.writeJson(UNMIGRATED_FILE, { enabled: unmigrated.enabled, providers: leftovers });
    } else {
      await ctx.deleteFile(UNMIGRATED_FILE);
      ctx.log(`${UNMIGRATED_FILE} removed: every provider in it is an installation now`);
    }
  }

  // 3. Tenant ids V200 could not decrypt, then the credentials nothing names any more.
  if (await ctx.fileExists(CREDENTIALS_FILE)) {
    const state = { store: await credentialStore(), installed, unmigratedTenantRefs, plainOf };
    if (await recoverTenantIds(ctx, state)) {
      if (!config.security) config.security = { blockPrivateIps: true, allowedHosts: [] };
      await ctx.writeJson(INTEGRATIONS_FILE, config);
    }
    await removeTenantIdLeftovers(ctx, state);
  }
}

/** Snapshot of V061's `sanitizeId` (2026-11-02): how it named a provider's credentials. */
function v061IdOf(raw) {
  return (
    String(raw || '')
      .replace(/[^a-zA-Z0-9._-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 60) || 'default'
  );
}

/**
 * Step 3a: an Office 365 installation without a tenant id gets it back from
 * the credential V061 filed it under (`cloudstorage_<provider id>_tenant`).
 * V200 meant to decrypt it, but migrations run before the server loads the
 * encryption key, so V200 left the tenant id empty with a warning. The
 * provider id is the installation id now (step 1). Mutates the installations.
 * @param {object} ctx
 * @param {{ store: object, installed: object[], plainOf: (v: string) => Promise<string|undefined> }} state
 * @returns {Promise<boolean>} whether a tenant id was recovered
 */
async function recoverTenantIds(ctx, { store, installed, plainOf }) {
  const credentials = store.credentials || {};
  let recovered = false;
  for (const instance of installed) {
    if (instance?.definition !== STORAGE_DEFINITIONS.office365) continue;
    if (text(instance.values?.tenantId)) continue;
    const base = `cloudstorage_${v061IdOf(instance.id)}_tenant`;
    const ref = Object.hasOwn(credentials, base)
      ? base
      : Object.keys(credentials).find(id => new RegExp(`^${escapeRegExp(base)}_\\d+$`).test(id));
    if (!ref) {
      ctx.warn(
        `Office 365 installation "${instance.id}" has no tenant id; enter it on the installation`
      );
      continue;
    }
    const plain = await plainOf(storedValueOf(credentials[ref]));
    if (!plain) {
      ctx.warn(
        `Office 365 installation "${instance.id}" has no tenant id and the credential "${ref}" could not be read; enter the tenant id on the installation`
      );
      continue;
    }
    if (!instance.values || typeof instance.values !== 'object') instance.values = {};
    instance.values.tenantId = plain.trim();
    instance.updatedAt = new Date().toISOString();
    recovered = true;
    ctx.log(
      `Office 365 installation "${instance.id}": tenant id restored from credential "${ref}"`
    );
  }
  return recovered;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Step 3b: delete the Office 365 tenant id credentials (`tenantIdRef`) that
 * V061 created or V200 left behind, when no config file names them. A
 * credential whose value cannot be read is kept: it may be the only copy of a
 * tenant id.
 * @param {object} ctx
 * @param {{ store: object, installed: object[], unmigratedTenantRefs: Set<string>, plainOf: (v: string) => Promise<string|undefined> }} state
 */
async function removeTenantIdLeftovers(ctx, { store, installed, unmigratedTenantRefs, plainOf }) {
  const credentials = store.credentials || {};
  const tenantIds = new Set(
    installed
      .filter(i => i?.definition === STORAGE_DEFINITIONS.office365)
      .map(i => text(i.values?.tenantId))
      .filter(Boolean)
  );
  const candidates = [];
  for (const [id, entry] of Object.entries(credentials)) {
    if (unmigratedTenantRefs.has(id) || V061_TENANT_CREDENTIAL.test(id)) {
      candidates.push(id);
      continue;
    }
    const type = typeof entry === 'object' ? entry?.type : undefined;
    const name = typeof entry?.name === 'string' ? entry.name : '';
    if (type !== 'secret' || !/tenant/i.test(`${id} ${name}`) || tenantIds.size === 0) continue;
    const plain = await plainOf(storedValueOf(entry));
    if (plain && tenantIds.has(plain.trim())) candidates.push(id);
  }
  if (candidates.length === 0) return;

  const referenced = new Set();
  for (const dir of REFERENCE_DIRS) {
    for (const file of await ctx.listFiles(dir, '*.json')) {
      const rel = `${dir}/${file}`;
      if (rel === CREDENTIALS_FILE) continue;
      try {
        collectStrings(await ctx.readJson(rel), referenced);
      } catch {
        /* an unreadable file names nothing we can see; keep going */
      }
    }
  }

  let removed = 0;
  for (const id of candidates) {
    if (referenced.has(id)) {
      ctx.warn(
        `Credential "${id}" looks like a former Office 365 tenant id but is still referenced; kept`
      );
      continue;
    }
    if (!(await plainOf(storedValueOf(credentials[id])))) {
      ctx.warn(
        `Credential "${id}" looks like a former Office 365 tenant id but could not be read; kept`
      );
      continue;
    }
    delete credentials[id];
    removed += 1;
    ctx.log(`Credential "${id}" removed: the Office 365 tenant id is stored on the installation`);
  }
  if (removed > 0) await ctx.writeJson(CREDENTIALS_FILE, store);
}
