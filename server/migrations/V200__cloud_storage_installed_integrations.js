// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V200 — cloud storage providers become installed integrations
 *
 * `platform.cloudStorage.providers[]` (Office 365, Google Drive, Nextcloud)
 * moves into `config/integrations.json` as the singleton installations
 * `office365` (`com.intrafind/office365`), `googledrive`
 * (`com.intrafind/google-drive`) and `nextcloud` (`com.intrafind/nextcloud`),
 * and the block leaves platform.json:
 *
 * - the provider's fields become install values; `clientSecretRef` stays the
 *   credential reference it was (V061), a plain-text `clientSecret` is moved
 *   into the credential store as `integration-<id>-clientSecretRef`;
 * - Office 365's tenant id (`tenantIdRef`, a credential since V061) is
 *   decrypted into the plain `tenantId` value — it is an identifier, not a
 *   secret — and a plain `tenantId` is copied;
 * - the provider's `id` is kept as the installation's `providerId` value when
 *   it differs from the installation id, so the callback URLs
 *   (`/api/integrations/<type>/<providerId>/callback`), the users' stored
 *   connections and the Nextcloud embed plugin's provider id stay valid;
 * - `displayName` → `label`; enabled when `cloudStorage.enabled` and the
 *   provider's `enabled` both hold.
 *
 * One installation per type: the first enabled provider of a type (else the
 * first) is moved; further providers of the same type are written to
 * `config/cloudStorage.unmigrated.json` with a warning, for the admin to
 * decide.
 */

export const version = '200';
export const description = 'cloud_storage_installed_integrations';

const PLATFORM_FILE = 'config/platform.json';
const INTEGRATIONS_FILE = 'config/integrations.json';
const CREDENTIALS_FILE = 'config/credentials.json';
/** Providers the migration could not move, for the admin to re-install by hand. */
const UNMIGRATED_FILE = 'config/cloudStorage.unmigrated.json';

export const PROVIDER_TYPES = Object.freeze({
  office365: { instanceId: 'office365', definition: 'com.intrafind/office365' },
  googledrive: { instanceId: 'googledrive', definition: 'com.intrafind/google-drive' },
  nextcloud: { instanceId: 'nextcloud', definition: 'com.intrafind/nextcloud' }
});
const DEFINITION_VERSION = '1.0.0';

export async function precondition(ctx) {
  return ctx.fileExists(PLATFORM_FILE);
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function localizedOf(value) {
  const t = text(value);
  return t ? { en: t } : undefined;
}

function put(target, key, value) {
  if (value !== undefined) target[key] = value;
}

/** Office 365 sources (`provider.sources` key → install value), in value order. */
const OFFICE365_SOURCES = [
  ['personalDrive', 'sourcePersonalDrive'],
  ['followedSites', 'sourceFollowedSites'],
  ['teams', 'sourceTeams']
];
/** Google Drive sources (`provider.sources` key → install value), in value order. */
const GOOGLE_DRIVE_SOURCES = [
  ['myDrive', 'sourceMyDrive'],
  ['sharedDrives', 'sourceSharedDrives'],
  ['sharedWithMe', 'sourceSharedWithMe']
];

/**
 * Put a `false` install value for each source the provider switched off
 * (`false`); any other setting writes no value.
 *
 * @param {Record<string, unknown>} values - the install values being built
 * @param {object} sources - `provider.sources`
 * @param {Array<[string, string]>} fields - source key → install value name
 */
function putSwitchedOffSources(values, sources, fields) {
  for (const [source, field] of fields) {
    if (sources[source] === false) values[field] = false;
  }
}

/** The install values only one provider type has. */
function putTypeValues(values, provider) {
  if (provider.type === 'office365') {
    put(values, 'tenantId', text(provider.tenantId));
    put(values, 'siteUrl', text(provider.siteUrl));
    put(values, 'driveId', text(provider.driveId));
    putSwitchedOffSources(values, provider.sources || {}, OFFICE365_SOURCES);
  } else if (provider.type === 'googledrive') {
    putSwitchedOffSources(values, provider.sources || {}, GOOGLE_DRIVE_SOURCES);
  } else if (provider.type === 'nextcloud') {
    put(values, 'serverUrl', text(provider.serverUrl));
  }
}

/**
 * The installation a provider becomes, without the secrets (see
 * {@link secretsOf}).
 * @param {object} provider - a `cloudStorage.providers[]` entry
 * @param {boolean} cloudStorageEnabled - the block's `enabled`
 */
export function instanceFrom(provider, cloudStorageEnabled = true) {
  const spec = PROVIDER_TYPES[provider.type];
  if (!spec) return null;
  const values = {};
  put(values, 'clientId', text(provider.clientId));
  put(values, 'clientSecretRef', text(provider.clientSecretRef));
  put(values, 'redirectUri', text(provider.redirectUri));
  const providerId = text(provider.id);
  if (providerId && providerId !== spec.instanceId) values.providerId = providerId;
  putTypeValues(values, provider);
  const instance = {
    id: spec.instanceId,
    definition: spec.definition,
    definitionVersion: DEFINITION_VERSION,
    enabled: cloudStorageEnabled !== false && provider.enabled !== false,
    values,
    auth: { mode: 'oauth-user' },
    actions: { enabled: ['*'], disabled: [], overrides: {} },
    allowedGroups: []
  };
  const label = localizedOf(provider.displayName) || localizedOf(provider.name);
  if (label) instance.label = label;
  return instance;
}

/**
 * The provider's plain-text secrets a hand-edited file may hold, with the
 * install field each belongs to.
 * @param {object} provider
 * @returns {Array<{ field: string, value: string }>}
 */
export function secretsOf(provider) {
  const out = [];
  if (!text(provider.clientSecretRef) && text(provider.clientSecret)) {
    out.push({ field: 'clientSecretRef', value: text(provider.clientSecret) });
  }
  return out;
}

/**
 * Pick the provider of each type that becomes the installation: the first
 * enabled one, else the first. The others are returned as skipped.
 * @param {object[]} providers
 * @returns {{ chosen: Map<string, object>, skipped: object[] }}
 */
export function chooseProviders(providers) {
  const chosen = new Map();
  const skipped = [];
  const byType = new Map();
  for (const provider of providers) {
    if (!provider || !PROVIDER_TYPES[provider.type]) {
      if (provider) skipped.push(provider);
      continue;
    }
    if (!byType.has(provider.type)) byType.set(provider.type, []);
    byType.get(provider.type).push(provider);
  }
  for (const [type, list] of byType) {
    const pick = list.find(p => p.enabled !== false) || list[0];
    chosen.set(type, pick);
    for (const other of list) if (other !== pick) skipped.push(other);
  }
  return { chosen, skipped };
}

/** `config/integrations.json` (empty when absent), with an `installed` list and a `security` block. */
async function readIntegrations(ctx) {
  const config = (await ctx.fileExists(INTEGRATIONS_FILE))
    ? (await ctx.readJson(INTEGRATIONS_FILE)) || {}
    : {};
  if (!Array.isArray(config.installed)) config.installed = [];
  if (!config.security) config.security = { blockPrivateIps: true, allowedHosts: [] };
  return config;
}

/**
 * The credential store and its encryption, each loaded on first use: most
 * providers need neither. `changed` tells whether the store must be written.
 *
 * @param {object} ctx - migration context
 * @param {{ crypto?: { encrypt: (v: string) => string, decrypt: (v: string) => string } }} deps - see {@link up}
 */
function lazySecrets(ctx, deps) {
  let cryptoTools = deps.crypto;
  let store = null;
  return {
    changed: false,
    /** The store as loaded so far (null before the first {@link credentialStore} call). */
    get store() {
      return store;
    },
    async tools() {
      if (!cryptoTools) {
        const { default: tokenStorage } = await import('../services/TokenStorageService.js');
        cryptoTools = {
          encrypt: value => tokenStorage.encryptString(value),
          decrypt: value => tokenStorage.decryptString(value)
        };
      }
      return cryptoTools;
    },
    async credentialStore() {
      if (!store) {
        store = (await ctx.fileExists(CREDENTIALS_FILE))
          ? (await ctx.readJson(CREDENTIALS_FILE)) || {}
          : {};
        if (!store.credentials || typeof store.credentials !== 'object') store.credentials = {};
      }
      return store;
    }
  };
}

/**
 * Office 365: the tenant id was filed as a credential (V061); it is an
 * identifier, so it goes back into the values in the clear. A credential that
 * is missing or cannot be decrypted is reported, not fatal.
 */
async function restoreTenantId(ctx, provider, instance, secrets) {
  if (instance.values.tenantId || !text(provider.tenantIdRef)) return;
  const credentials = (await secrets.credentialStore()).credentials;
  const entry = credentials[text(provider.tenantIdRef)];
  const stored = typeof entry === 'string' ? entry : entry?.value;
  if (typeof stored !== 'string' || !stored) {
    ctx.warn(
      `Office 365 provider "${provider.id}": the tenant id credential "${provider.tenantIdRef}" was not found; enter the tenant id on the installation`
    );
    return;
  }
  try {
    instance.values.tenantId = (await secrets.tools()).decrypt(stored);
  } catch {
    ctx.warn(
      `Office 365 provider "${provider.id}": the tenant id credential "${provider.tenantIdRef}" could not be decrypted; enter the tenant id on the installation`
    );
  }
}

/** Move the provider's plain-text secrets (see {@link secretsOf}) into the credential store. */
async function moveSecrets(ctx, provider, instance, spec, secrets) {
  const plain = secretsOf(provider);
  if (!plain.length) return;
  const { credentials } = await secrets.credentialStore();
  const cryptoTools = await secrets.tools();
  for (const { field, value } of plain) {
    const id = `integration-${spec.instanceId}-${field}`;
    credentials[id] = {
      id,
      type: 'secret',
      name: `${instance.label?.en || spec.instanceId}: client secret`,
      description: `Managed by the installed integration "${spec.instanceId}"`,
      value: cryptoTools.encrypt(value)
    };
    secrets.changed = true;
    instance.values[field] = id;
    ctx.log(`Cloud storage provider "${provider.id}": client secret moved to credential "${id}"`);
  }
}

/**
 * Install the provider chosen for a type, unless an installation of that type
 * exists: then the provider joins `skipped`.
 *
 * @param {object} ctx - migration context
 * @param {object} job
 * @param {string} job.type - the provider type
 * @param {object} job.provider - the provider chosen for it (see {@link chooseProviders})
 * @param {object} job.block - `platform.cloudStorage`
 * @param {{ installed: object[] }} job.config - `config/integrations.json`, appended to
 * @param {ReturnType<typeof lazySecrets>} job.secrets
 * @param {object[]} job.skipped - the providers that are not migrated
 */
async function migrateProvider(ctx, { type, provider, block, config, secrets, skipped }) {
  const spec = PROVIDER_TYPES[type];
  if (config.installed.some(inst => inst?.id === spec.instanceId)) {
    ctx.log(
      `Installed integration "${spec.instanceId}" exists; provider "${provider.id}" left as it is`
    );
    skipped.push(provider);
    return;
  }
  const instance = instanceFrom(provider, block.enabled);
  if (type === 'office365') await restoreTenantId(ctx, provider, instance, secrets);
  await moveSecrets(ctx, provider, instance, spec, secrets);
  const now = new Date().toISOString();
  instance.installedAt = now;
  instance.updatedAt = now;
  config.installed.push(instance);
  ctx.log(
    `Cloud storage provider "${provider.id}" (${type}) → installed integration "${spec.instanceId}" (${instance.enabled ? 'enabled' : 'disabled'})`
  );
}

/** Keep the providers that could not be moved in a side file, and say so. */
async function keepUnmigrated(ctx, block, skipped) {
  await ctx.writeJson(UNMIGRATED_FILE, { enabled: block.enabled, providers: skipped });
  const names = skipped.map(p => `"${p.id}" (${p.type})`).join(', ');
  ctx.warn(
    `${skipped.length} cloud storage provider(s) not migrated (one installation per provider type): ${names}. Kept in ${UNMIGRATED_FILE}; the installed integration of each type holds the first enabled provider.`
  );
}

/**
 * @param {object} ctx - migration context
 * @param {{ crypto?: { encrypt: (v: string) => string, decrypt: (v: string) => string } }} [deps]
 *   the credential store's encryption (the token storage service when absent; injectable for tests)
 */
export async function up(ctx, deps = {}) {
  if (!(await ctx.fileExists(PLATFORM_FILE))) return;
  const platform = (await ctx.readJson(PLATFORM_FILE)) || {};
  if (!Object.hasOwn(platform, 'cloudStorage')) return;
  const block = platform.cloudStorage || {};
  const providers = Array.isArray(block.providers) ? block.providers.filter(Boolean) : [];
  const secrets = lazySecrets(ctx, deps);
  const config = await readIntegrations(ctx);

  const { chosen, skipped } = chooseProviders(providers);
  // Sequential on purpose: the installations, log lines and warnings follow the
  // provider order, and the credential store is read only once a provider needs it.
  for (const [type, provider] of chosen) {
    await migrateProvider(ctx, { type, provider, block, config, secrets, skipped });
  }

  await ctx.writeJson(INTEGRATIONS_FILE, config);
  if (secrets.changed) await ctx.writeJson(CREDENTIALS_FILE, secrets.store);
  if (skipped.length) await keepUnmigrated(ctx, block, skipped);

  delete platform.cloudStorage;
  await ctx.writeJson(PLATFORM_FILE, platform);
  ctx.log('platform.cloudStorage removed: the providers are installed integrations now');
}
