// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V206 — storage providers: several installations per provider,
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

export const version = '206';
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

/** Put a text on `values` when it is not empty after trimming. */
function setText(values, key, value) {
  if (text(value)) values[key] = text(value);
}

/**
 * `value` without the leading and trailing characters that are in `chars`.
 * The same as `value.replace(/^[<chars>]+|[<chars>]+$/g, '')`, in linear time:
 * that regex backtracks over every run of `chars` that does not end the
 * string (quadratic on a long run).
 * @param {string} value
 * @param {string} chars - the characters to strip, e.g. `-._`
 * @returns {string}
 */
export function trimChars(value, chars) {
  let start = 0;
  let end = value.length;
  while (start < end && chars.includes(value[start])) start += 1;
  while (end > start && chars.includes(value[end - 1])) end -= 1;
  return value.slice(start, end);
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
  const cleaned = trimChars(
    String(providerId || '')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/_{2,}/g, '_'),
    '-._'
  );
  const base = (cleaned ? `${type}-${cleaned}` : type).slice(0, 56);
  if (isUsableId(base, taken)) return base;
  let n = 2;
  while (!isUsableId(`${base}-${n}`, taken)) n += 1;
  return `${base}-${n}`;
}

/** Office 365's own install values of a former provider. */
function office365Values(provider, sources, values) {
  setText(values, 'tenantId', provider.tenantId);
  setText(values, 'siteUrl', provider.siteUrl);
  setText(values, 'driveId', provider.driveId);
  if (sources.personalDrive === false) values.sourcePersonalDrive = false;
  if (sources.followedSites === false) values.sourceFollowedSites = false;
  if (sources.teams === false) values.sourceTeams = false;
}

/** Google Drive's own install values of a former provider. */
function googleDriveValues(provider, sources, values) {
  if (sources.myDrive === false) values.sourceMyDrive = false;
  if (sources.sharedDrives === false) values.sourceSharedDrives = false;
  if (sources.sharedWithMe === false) values.sourceSharedWithMe = false;
}

/** Nextcloud's own install values of a former provider. */
function nextcloudValues(provider, sources, values) {
  setText(values, 'serverUrl', provider.serverUrl);
}

/** Provider type → the function that adds the type's own install values. */
const TYPE_VALUES = new Map([
  ['office365', office365Values],
  ['googledrive', googleDriveValues],
  ['nextcloud', nextcloudValues]
]);

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
  setText(values, 'clientId', provider.clientId);
  setText(values, 'clientSecretRef', provider.clientSecretRef);
  setText(values, 'redirectUri', provider.redirectUri);
  TYPE_VALUES.get(provider.type)?.(provider, provider.sources || {}, values);
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
 * Rename the bindings of renamed installations (step 4). Mutates the app.
 * @param {object} app
 * @param {Map<string, string>} renames
 * @returns {string[]} what changed, for the log
 */
function renameBindings(app, renames) {
  const bindings = app.integrations;
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) return [];
  const changes = [];
  for (const [from, to] of renames) {
    if (!Object.hasOwn(bindings, from)) continue;
    if (!Object.hasOwn(bindings, to)) bindings[to] = bindings[from];
    delete bindings[from];
    changes.push(`binding "${from}" → "${to}"`);
  }
  return changes;
}

/**
 * Replace `upload.cloudStorageUpload` by the optional `type:storage` binding
 * when it was on; remove it either way (step 4). Mutates the app.
 * @param {object} app
 * @returns {string[]} what changed, for the log
 */
function replaceCloudStorageUpload(app) {
  const upload = app.upload && typeof app.upload === 'object' ? app.upload : null;
  if (!upload || !Object.hasOwn(upload, 'cloudStorageUpload')) return [];
  const enabled = upload.cloudStorageUpload?.enabled === true;
  delete upload.cloudStorageUpload;
  if (!enabled) return ['upload.cloudStorageUpload (off) removed'];
  if (!app.integrations || typeof app.integrations !== 'object') app.integrations = {};
  if (!Object.hasOwn(app.integrations, STORAGE_TYPE_BINDING)) {
    app.integrations[STORAGE_TYPE_BINDING] = { required: false };
  }
  return [`upload.cloudStorageUpload → integrations["${STORAGE_TYPE_BINDING}"]`];
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
  if (!app || typeof app !== 'object') return [];
  return [...renameBindings(app, renames), ...replaceCloudStorageUpload(app)];
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
 * A lazy, single-flight loader: `load` runs on the first call and its result
 * is kept; calls while it runs share it; after a failure the next call runs
 * it again.
 * @template T
 * @param {() => Promise<T>} load
 * @returns {() => Promise<T>}
 */
function lazy(load) {
  let pending = null;
  return () => {
    pending ??= load().catch(error => {
      pending = null;
      throw error;
    });
    return pending;
  };
}

/** The credential store's encryption: the token storage service, its key loaded. */
async function loadTokenStorageCrypto() {
  const { default: tokenStorage } = await import('../services/TokenStorageService.js');
  // Migrations run before the server loads the key; V200 did not, so its
  // tenant id decryption could never succeed (see step 3).
  if (!tokenStorage.encryptionKey) await tokenStorage.initializeEncryptionKey();
  return {
    encrypt: value => tokenStorage.encryptString(value),
    decrypt: value => tokenStorage.decryptString(value)
  };
}

/**
 * Lazy access to the credential store and its encryption for one run: each
 * is loaded on first use, once.
 *
 * @param {object} ctx - migration context
 * @param {{ crypto?: { encrypt: (v: string) => string, decrypt: (v: string) => string } }} deps
 * @returns {{
 *   tools: () => Promise<{ encrypt: (v: string) => string, decrypt: (v: string) => string }>,
 *   plainOf: (stored: unknown) => Promise<string|undefined>,
 *   credentialStore: () => Promise<{ credentials: object }>
 * }}
 */
function credentialAccess(ctx, deps) {
  const tools = deps.crypto ? async () => deps.crypto : lazy(loadTokenStorageCrypto);
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
  const credentialStore = lazy(async () => {
    const store = (await ctx.fileExists(CREDENTIALS_FILE))
      ? (await ctx.readJson(CREDENTIALS_FILE)) || {}
      : {};
    if (!store.credentials || typeof store.credentials !== 'object') store.credentials = {};
    return store;
  });
  return { tools, plainOf, credentialStore };
}

/**
 * What becomes of one parked provider (step 2).
 * @typedef {Object} ParkedPlan
 * @property {object} provider - the parked `providers[]` entry
 * @property {object|null} instance - its installation; null for an unknown type
 * @property {string} [ownId] - its own id
 * @property {string} [id] - the installation id (its own, or a fallback)
 * @property {string} [tenantRef] - the credential its Office 365 tenant id is to be read from
 * @property {string} [secret] - a plain-text client secret to move into the credential store
 * @property {string} [credentialId] - the credential the client secret goes to
 * @property {string} [tenantId] - the tenant id read from `tenantRef` (resolved)
 * @property {string} [encryptedSecret] - `secret` encrypted, when its credential is new (resolved)
 */

/**
 * Plan the parked providers in the order of the file: the id and the
 * installation of each provider of a known type, and which secrets it needs.
 * Ids are taken in that order, so a provider's fallback id never collides
 * with an earlier one.
 * @param {object[]} providers - the parked providers
 * @param {object[]} installed - `integrations.json` → `installed`
 * @param {boolean} [cloudStorageEnabled] - the former block's `enabled`
 * @returns {ParkedPlan[]}
 */
function planParkedProviders(providers, installed, cloudStorageEnabled) {
  const taken = new Set(installed.filter(Boolean).map(i => i.id));
  const plans = [];
  for (const provider of providers) {
    if (!STORAGE_DEFINITIONS[provider.type]) {
      plans.push({ provider, instance: null });
      continue;
    }
    const ownId = text(provider.id);
    const id = isUsableId(ownId, taken) ? ownId : fallbackId(provider.type, ownId, taken);
    taken.add(id);
    const instance = instanceFrom(provider, id, cloudStorageEnabled);
    const needsTenantId = provider.type === 'office365' && !instance.values.tenantId;
    plans.push({
      provider,
      instance,
      ownId,
      id,
      tenantRef: needsTenantId ? text(provider.tenantIdRef) : undefined,
      secret: text(provider.clientSecretRef) ? undefined : text(provider.clientSecret),
      credentialId: `integration-${id}-clientSecretRef`
    });
  }
  return plans;
}

/**
 * Read the tenant ids and encrypt the client secrets the plans need, in
 * parallel (each provider's secrets are its own). A client secret whose
 * credential exists already is not encrypted.
 * @param {ParkedPlan[]} plans - completed in place
 * @param {ReturnType<typeof credentialAccess>} secrets
 * @returns {Promise<object|null>} the credential store; null when no plan needs it
 */
async function resolveParkedSecrets(plans, { tools, plainOf, credentialStore }) {
  if (!plans.some(plan => plan.tenantRef || plan.secret)) return null;
  const store = await credentialStore();
  await Promise.all(
    plans.map(async plan => {
      if (plan.tenantRef) {
        plan.tenantId = await plainOf(storedValueOf(store.credentials[plan.tenantRef]));
      }
      if (plan.secret && !Object.hasOwn(store.credentials, plan.credentialId)) {
        plan.encryptedSecret = (await tools()).encrypt(plan.secret);
      }
    })
  );
  return store;
}

/**
 * Install one planned provider: its tenant id, its client secret moved into
 * the credential store, its timestamps; appended to `installed`.
 * @param {object} ctx - migration context
 * @param {ParkedPlan} plan - resolved by {@link resolveParkedSecrets}
 * @param {Object} target
 * @param {object[]} target.installed - `integrations.json` → `installed`
 * @param {object|null} target.store - the credential store
 * @param {ParkedResult} target.parked - updated here
 */
function installParkedProvider(ctx, plan, { installed, store, parked }) {
  const { provider, instance, ownId, id } = plan;
  if (id !== ownId) {
    ctx.warn(
      `Cloud storage provider "${ownId}" (${provider.type}) installed as "${id}": its own id cannot be an installation id. Users connect again, and the redirect URI of "${id}" has to be registered with the provider.`
    );
  }
  if (plan.tenantRef && plan.tenantId) {
    instance.values.tenantId = plan.tenantId;
    parked.tenantRefs.add(plan.tenantRef);
  } else if (plan.tenantRef) {
    ctx.warn(
      `Office 365 provider "${ownId}": the tenant id credential "${plan.tenantRef}" was not found or could not be decrypted; enter the tenant id on the installation "${id}"`
    );
  }
  if (plan.secret) {
    if (Object.hasOwn(plan, 'encryptedSecret')) {
      store.credentials[plan.credentialId] = {
        id: plan.credentialId,
        type: 'secret',
        name: `${instance.label?.en || id}: client secret`,
        description: `Managed by the installed integration "${id}"`,
        value: plan.encryptedSecret
      };
      parked.credentialsAdded = true;
    }
    instance.values.clientSecretRef = plan.credentialId;
    ctx.log(
      `Cloud storage provider "${ownId}": client secret moved to credential "${plan.credentialId}"`
    );
  }
  const now = new Date().toISOString();
  instance.installedAt = now;
  instance.updatedAt = now;
  installed.push(instance);
  parked.installedAny = true;
  ctx.log(
    `Unmigrated cloud storage provider "${ownId}" (${provider.type}) → installed integration "${id}" (${instance.enabled ? 'enabled' : 'disabled'})`
  );
}

/**
 * The outcome of step 2.
 * @typedef {Object} ParkedResult
 * @property {object|null} unmigrated - the parked file's content; null without the file
 * @property {object[]} leftovers - providers of an unknown type, kept in the file
 * @property {Set<string>} tenantRefs - credentials a provider named as its tenant id
 * @property {boolean} installedAny - whether a provider was installed
 * @property {boolean} credentialsAdded - whether a client secret went into the credential store
 */

/**
 * Step 2: install the providers V200 parked, in the order of the file
 * (`installed` is appended to). Providers of an unknown type are left over.
 * @param {object} ctx - migration context
 * @param {object[]} installed - `integrations.json` → `installed`
 * @param {ReturnType<typeof credentialAccess>} secrets
 * @returns {Promise<ParkedResult>}
 */
async function installParkedProviders(ctx, installed, secrets) {
  /** @type {ParkedResult} */
  const parked = {
    unmigrated: null,
    leftovers: [],
    tenantRefs: new Set(),
    installedAny: false,
    credentialsAdded: false
  };
  if (!(await ctx.fileExists(UNMIGRATED_FILE))) return parked;
  const unmigrated = (await ctx.readJson(UNMIGRATED_FILE)) || {};
  parked.unmigrated = unmigrated;
  const providers = Array.isArray(unmigrated.providers) ? unmigrated.providers.filter(Boolean) : [];
  const plans = planParkedProviders(providers, installed, unmigrated.enabled);
  const store = await resolveParkedSecrets(plans, secrets);
  for (const plan of plans) {
    if (plan.instance) {
      installParkedProvider(ctx, plan, { installed, store, parked });
      continue;
    }
    parked.leftovers.push(plan.provider);
    ctx.warn(
      `Unmigrated cloud storage provider "${plan.provider.id}" has an unknown type "${plan.provider.type}"; kept in ${UNMIGRATED_FILE}`
    );
  }
  return parked;
}

/**
 * Step 4, groups: grants of renamed installations.
 * @param {object} ctx - migration context
 * @param {Map<string, string>} renames - old id → new id
 */
async function renameGroupGrants(ctx, renames) {
  if (renames.size === 0 || !(await ctx.fileExists(GROUPS_FILE))) return;
  const groupsFile = (await ctx.readJson(GROUPS_FILE)) || {};
  let changed = false;
  for (const [groupId, group] of Object.entries(groupsFile.groups || {})) {
    const next = renamedGrants(group?.permissions?.integrations, renames);
    if (!next) continue;
    group.permissions.integrations = next;
    changed = true;
    ctx.log(`Group "${groupId}": storage provider grants renamed`);
  }
  if (changed) await ctx.writeJson(GROUPS_FILE, groupsFile);
}

/**
 * Step 4, `apps/*.json`. The files are independent, so they are read and
 * written in parallel; the warnings and the log follow the order of the
 * files. An unreadable file is skipped with a warning.
 * @param {object} ctx - migration context
 * @param {Map<string, string>} renames - old id → new id
 * @returns {Promise<number>} how many changed apps bind `type:storage`
 */
async function migrateAppFiles(ctx, renames) {
  const files = await ctx.listFiles('apps', '*.json');
  const read = await Promise.all(
    files.map(async file => {
      const rel = `apps/${file}`;
      try {
        return { file, rel, app: await ctx.readJson(rel) };
      } catch (error) {
        return { file, rel, error };
      }
    })
  );
  const apps = read.map(entry =>
    entry.error ? entry : { ...entry, changes: migrateApp(entry.app, renames) }
  );
  const changed = apps.filter(entry => entry.changes?.length > 0);
  await Promise.all(changed.map(({ rel, app }) => ctx.writeJson(rel, app)));
  let bound = 0;
  for (const { file, rel, app, changes, error } of apps) {
    if (error) ctx.warn(`Skipped ${rel}: ${error.message}`);
    if (!changes?.length) continue;
    if (app.integrations?.[STORAGE_TYPE_BINDING]) bound += 1;
    ctx.log(`App "${app.id || file}": ${changes.join(', ')}`);
  }
  return bound;
}

/**
 * Step 4, the legacy `config/apps.json` array (unreadable: skipped with a
 * warning).
 * @param {object} ctx - migration context
 * @param {Map<string, string>} renames - old id → new id
 */
async function migrateLegacyApps(ctx, renames) {
  if (!(await ctx.fileExists(LEGACY_APPS_FILE))) return;
  let apps = null;
  try {
    apps = await ctx.readJson(LEGACY_APPS_FILE);
  } catch (error) {
    ctx.warn(`Skipped ${LEGACY_APPS_FILE}: ${error.message}`);
  }
  if (!Array.isArray(apps)) return;
  let changed = false;
  for (const app of apps) {
    const changes = migrateApp(app, renames);
    if (changes.length === 0) continue;
    changed = true;
    ctx.log(`App "${app?.id}" (${LEGACY_APPS_FILE}): ${changes.join(', ')}`);
  }
  if (changed) await ctx.writeJson(LEGACY_APPS_FILE, apps);
}

/** Write `integrations.json`, with the default security block when it has none. */
async function writeInstallations(ctx, config) {
  if (!config.security) config.security = { blockPrivateIps: true, allowedHosts: [] };
  await ctx.writeJson(INTEGRATIONS_FILE, config);
}

/**
 * The parked file after step 2: rewritten with the providers left over, or
 * deleted when every provider is an installation now.
 * @param {object} ctx - migration context
 * @param {ParkedResult} parked
 */
async function finishParkedFile(ctx, { unmigrated, leftovers }) {
  if (leftovers.length > 0) {
    await ctx.writeJson(UNMIGRATED_FILE, { enabled: unmigrated.enabled, providers: leftovers });
    return;
  }
  await ctx.deleteFile(UNMIGRATED_FILE);
  ctx.log(`${UNMIGRATED_FILE} removed: every provider in it is an installation now`);
}

/**
 * @param {object} ctx - migration context
 * @param {{ crypto?: { encrypt: (v: string) => string, decrypt: (v: string) => string } }} [deps]
 *   the credential store's encryption (the token storage service when absent; injectable for tests)
 */
export async function up(ctx, deps = {}) {
  const secrets = credentialAccess(ctx, deps);
  const hasConfig = await ctx.fileExists(INTEGRATIONS_FILE);
  const config = hasConfig ? (await ctx.readJson(INTEGRATIONS_FILE)) || {} : {};
  if (!Array.isArray(config.installed)) config.installed = [];
  const installed = config.installed;

  // 1. Rename the installations to their provider ids.
  const { renames, changed: renamedAny } = renameToProviderIds(installed, ctx);

  // 2. Install the providers V200 parked.
  const parked = await installParkedProviders(ctx, installed, secrets);
  if (parked.credentialsAdded) {
    await ctx.writeJson(CREDENTIALS_FILE, await secrets.credentialStore());
  }

  // 4 (references first). Groups: grants of renamed installations; apps:
  // renamed bindings and the storage binding instead of the switch.
  await renameGroupGrants(ctx, renames);
  const bound = await migrateAppFiles(ctx, renames);
  await migrateLegacyApps(ctx, renames);
  if (bound > 0) ctx.log(`${bound} app(s) bind every storage provider (type:storage, optional)`);

  // The installations themselves.
  if (renamedAny || parked.installedAny) await writeInstallations(ctx, config);
  if (parked.unmigrated) await finishParkedFile(ctx, parked);

  // 3. Tenant ids V200 could not decrypt, then the credentials nothing names any more.
  if (await ctx.fileExists(CREDENTIALS_FILE)) {
    const state = {
      store: await secrets.credentialStore(),
      installed,
      unmigratedTenantRefs: parked.tenantRefs,
      plainOf: secrets.plainOf
    };
    if (await recoverTenantIds(ctx, state)) await writeInstallations(ctx, config);
    await removeTenantIdLeftovers(ctx, state);
  }
}

/**
 * Snapshot of V061's `sanitizeId` (2026-11-02): how it named a provider's
 * credentials. Its `^_+|_+$` trim is {@link trimChars} (same result, linear).
 * @param {string|number|null|undefined} raw - a provider id from the old config
 * @returns {string}
 */
export function v061IdOf(raw) {
  return (
    trimChars(String(raw || '').replace(/[^a-zA-Z0-9._-]+/g, '_'), '_').slice(0, 60) || 'default'
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/**
 * The credential V061 filed an Office 365 installation's tenant id under:
 * `cloudstorage_<provider id>_tenant`, else a numbered one (`…_tenant_2`).
 * @param {object} instance - the installation
 * @param {object} credentials - the credential store's entries
 * @returns {string|undefined}
 */
function v061TenantRefOf(instance, credentials) {
  const base = `cloudstorage_${v061IdOf(instance.id)}_tenant`;
  if (Object.hasOwn(credentials, base)) return base;
  const numbered = new RegExp(String.raw`^${escapeRegExp(base)}_\d+$`);
  return Object.keys(credentials).find(id => numbered.test(id));
}

/**
 * Step 3a: an Office 365 installation without a tenant id gets it back from
 * the credential V061 filed it under (`cloudstorage_<provider id>_tenant`).
 * V200 meant to decrypt it, but migrations run before the server loads the
 * encryption key, so V200 left the tenant id empty with a warning. The
 * provider id is the installation id now (step 1). Mutates the installations.
 * The credentials are read in parallel; the log follows the installations.
 * @param {object} ctx
 * @param {{ store: object, installed: object[], plainOf: (v: string) => Promise<string|undefined> }} state
 * @returns {Promise<boolean>} whether a tenant id was recovered
 */
async function recoverTenantIds(ctx, { store, installed, plainOf }) {
  const credentials = store.credentials || {};
  const missing = installed.filter(
    instance =>
      instance?.definition === STORAGE_DEFINITIONS.office365 && !text(instance.values?.tenantId)
  );
  const found = await Promise.all(
    missing.map(async instance => {
      const ref = v061TenantRefOf(instance, credentials);
      const plain = ref ? await plainOf(storedValueOf(credentials[ref])) : undefined;
      return { instance, ref, plain };
    })
  );
  let recovered = false;
  for (const { instance, ref, plain } of found) {
    if (!ref) {
      ctx.warn(
        `Office 365 installation "${instance.id}" has no tenant id; enter it on the installation`
      );
      continue;
    }
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

/**
 * Whether a credential holds an Office 365 tenant id: one an unmigrated
 * provider named or V061 created, or a `secret` whose id or name mentions
 * "tenant" and whose value is an Office 365 installation's tenant id.
 * @param {string} id
 * @param {unknown} entry
 * @param {{ unmigratedTenantRefs: Set<string>, tenantIds: Set<string>, plainOf: (v: string) => Promise<string|undefined> }} known
 * @returns {Promise<boolean>}
 */
async function isTenantIdCredential(id, entry, { unmigratedTenantRefs, tenantIds, plainOf }) {
  if (unmigratedTenantRefs.has(id) || V061_TENANT_CREDENTIAL.test(id)) return true;
  const type = typeof entry === 'object' ? entry?.type : undefined;
  const name = typeof entry?.name === 'string' ? entry.name : '';
  if (type !== 'secret' || !/tenant/i.test(`${id} ${name}`) || tenantIds.size === 0) return false;
  const plain = await plainOf(storedValueOf(entry));
  return Boolean(plain) && tenantIds.has(plain.trim());
}

/**
 * Every string in the JSON files of {@link REFERENCE_DIRS} but the
 * credential store: whatever may name a credential. The files are read in
 * parallel; an unreadable one is skipped.
 * @param {object} ctx
 * @returns {Promise<Set<string>>}
 */
async function referencedStrings(ctx) {
  const referenced = new Set();
  const listed = await Promise.all(
    REFERENCE_DIRS.map(async dir =>
      (await ctx.listFiles(dir, '*.json')).map(file => `${dir}/${file}`)
    )
  );
  const files = listed.flat().filter(rel => rel !== CREDENTIALS_FILE);
  await Promise.all(
    files.map(async rel => {
      try {
        collectStrings(await ctx.readJson(rel), referenced);
      } catch {
        /* an unreadable file names nothing we can see; keep going */
      }
    })
  );
  return referenced;
}

/**
 * Step 3b: delete the Office 365 tenant id credentials (`tenantIdRef`) that
 * V061 created or V200 left behind, when no config file names them. A
 * credential whose value cannot be read is kept: it may be the only copy of a
 * tenant id. The credentials are read in parallel; the log follows the store.
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
  const entries = Object.entries(credentials);
  const verdicts = await Promise.all(
    entries.map(([id, entry]) =>
      isTenantIdCredential(id, entry, { unmigratedTenantRefs, tenantIds, plainOf })
    )
  );
  const candidates = entries.filter((_, index) => verdicts[index]).map(([id]) => id);
  if (candidates.length === 0) return;

  const referenced = await referencedStrings(ctx);
  const readable = await Promise.all(
    candidates.map(id =>
      referenced.has(id) ? Promise.resolve(undefined) : plainOf(storedValueOf(credentials[id]))
    )
  );
  let removed = 0;
  for (const [index, id] of candidates.entries()) {
    if (referenced.has(id)) {
      ctx.warn(
        `Credential "${id}" looks like a former Office 365 tenant id but is still referenced; kept`
      );
    } else if (readable[index]) {
      delete credentials[id];
      removed += 1;
      ctx.log(`Credential "${id}" removed: the Office 365 tenant id is stored on the installation`);
    } else {
      ctx.warn(
        `Credential "${id}" looks like a former Office 365 tenant id but could not be read; kept`
      );
    }
  }
  if (removed > 0) await ctx.writeJson(CREDENTIALS_FILE, store);
}
