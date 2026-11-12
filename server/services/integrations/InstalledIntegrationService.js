// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import configCache from '../../configCache.js';
import configStore from '../config/ConfigStore.js';
import tokenStorageService from '../TokenStorageService.js';
import logger from '../../utils/logger.js';
import integrationRegistry from './definitions/IntegrationRegistry.js';
import { getProtocolAdapter } from './protocols/index.js';
import {
  actionOverrideSchema,
  boundedLocalizedSchema,
  installedApprovalSchema,
  validateIntegrationsConfig,
  validateInstalledIntegration
} from '../../validators/integrationsConfigSchema.js';
import {
  checkInstallValues,
  secretFieldForMode
} from '../../validators/integrationDefinitionSchema.js';
import { effectiveValues, instanceLabel, localized } from './definitions/installedValues.js';
import { installationMigrationState } from './definitions/migrationPlanner.js';
import { compareCodeUnits } from '../../../shared/toolApproval.js';
import { ServiceError } from '../../utils/ServiceError.js';

/**
 * Installed integrations (04-architecture §1.3): the admin's instances of
 * catalog definitions, stored in `contents/config/integrations.json`.
 *
 * Secrets entered in the install wizard never land in that file. They are
 * written to the credential store as `secret` profiles named
 * `integration-<instanceId>-<field>` and the instance keeps the reference.
 */

export const INTEGRATIONS_FILE = 'config/integrations.json';
const CREDENTIALS_FILE = 'config/credentials.json';
/** Returned by a `_updateConfig` change to leave the file as it is. */
const SKIP = Symbol('skip');

const COMPONENT = 'InstalledIntegrationService';
const RESERVED_INSTANCE_IDS = new Set(['a2a', 'app', 'workflow', 'knowledge']);
/**
 * Tool ids with these prefixes are routed elsewhere before the tool list is
 * consulted (`workflow_*` to the workflow runner in `runTool`) or classified
 * by prefix (`knowledge_*`, `source_*` as source tools), so an installation
 * named `workflow_docs` would never reach its adapter.
 */
const RESERVED_INSTANCE_ID_PREFIX = /^(workflow|knowledge|source)_/i;

export class IntegrationError extends ServiceError {
  /**
   * @param {string} message
   * @param {Object} [options]
   * @param {number} [options.status=400]
   * @param {string} [options.code='INTEGRATION_ERROR'] - A code of `shared/apiErrors.js`
   * @param {Object|Array} [options.details] - Interpolation parameters. A list of problems (the
   *   validation errors) is answered as `details.issues`.
   */
  constructor(message, { status = 400, code = 'INTEGRATION_ERROR', details } = {}) {
    super(code, message, {
      status,
      details: Array.isArray(details) ? { issues: details } : details
    });
    this.name = 'IntegrationError';
  }
}

function emptyConfig() {
  return { installed: [], security: { blockPrivateIps: true, allowedHosts: [] } };
}

/**
 * The installation an always-installed built-in (`alwaysInstalled`, iHub's
 * own tools) has when the file does not hold one: enabled, every action on.
 * Who may use it is up to the groups (`permissions.integrations`), as for
 * every installation. It is served from here until an admin edits it, which
 * writes it to the file.
 * @param {object} definition
 */
function builtInInstance(definition) {
  return {
    id: definition.singleton.instanceId,
    definition: definition.id,
    definitionVersion: definition.version,
    enabled: true,
    values: {},
    auth: { mode: definition.auth?.default || 'none' },
    actions: { enabled: ['*'], disabled: [], overrides: {} }
  };
}

/**
 * Refuse a payload that still carries `allowedGroups`. Installations have no
 * groups of their own since #3093 (V203): the groups decide, in
 * `groups.json` → `permissions.integrations`, edited on the group page. A
 * client that still sends the field (an install dialog from before) gets a
 * 400 naming the place to go instead of a save that silently drops it.
 * @param {object|undefined} payload - Admin create/update/test payload
 * @throws {IntegrationError} `ALLOWED_GROUPS_REMOVED`
 */
export function rejectAllowedGroups(payload) {
  if (!payload || typeof payload !== 'object' || !Object.hasOwn(payload, 'allowedGroups')) return;
  throw new IntegrationError(
    '"allowedGroups" is no longer a setting of an installed integration. Which groups may use an integration is set on the group page (Admin → Groups → a group → Integrations, groups.json permissions.integrations).',
    { status: 400, code: 'ALLOWED_GROUPS_REMOVED' }
  );
}

function credentialIdFor(instanceId, fieldKey) {
  return `integration-${instanceId}-${fieldKey}`;
}

function nowIso() {
  return new Date().toISOString();
}

/** A copy of a string record with its keys sorted (stable diffs of integrations.json). */
function sortedRecord(record) {
  const out = {};
  for (const key of Object.keys(record || {}).sort(compareCodeUnits)) out[key] = record[key];
  return out;
}

/**
 * Carry the accepted action fingerprints and the last review time (#2916)
 * from the stored installation over to a saved one: they are written by the
 * server only, never by a save.
 * @param {object} instance - the installation about to be stored
 * @param {object|undefined} stored - the installation as stored
 */
/**
 * A localized text without its empty languages: `{ en: 'x', de: '' }` →
 * `{ en: 'x' }`; null when nothing is left. Anything else is returned as is
 * (the schema rejects it).
 * @param {unknown} value
 * @returns {unknown}
 */
function withoutEmptyTexts(value) {
  if (typeof value === 'string') return value.trim() ? value : null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const kept = Object.fromEntries(
    Object.entries(value).filter(([, text]) => typeof text !== 'string' || text.trim())
  );
  return Object.keys(kept).length ? kept : null;
}

/**
 * Keep what the dedicated editors of the action detail write (#2974) when an
 * update's payload does not carry it: the installation's `instructions` and
 * the per-action `overrides`. The settings editors do not know these fields;
 * a save there must not drop them.
 *
 * @param {Object} instance - the prepared installation (mutated)
 * @param {Object} stored - the stored installation
 * @param {Object} payload - the raw update payload
 */
function keepGuidance(instance, stored, payload) {
  if (!Object.hasOwn(payload || {}, 'instructions') && stored?.instructions !== undefined) {
    instance.instructions = stored.instructions;
  }
  const sentActions =
    payload?.actions && typeof payload.actions === 'object' ? payload.actions : null;
  if (!sentActions || !Object.hasOwn(sentActions, 'overrides')) {
    const overrides = stored?.actions?.overrides;
    if (overrides && Object.keys(overrides).length) {
      instance.actions = { ...instance.actions, overrides };
    }
  }
}

function keepActionReview(instance, stored) {
  const { fingerprints, reviewedAt } = stored?.actions || {};
  if (!fingerprints && !reviewedAt) return;
  instance.actions = {
    ...instance.actions,
    ...(fingerprints ? { fingerprints } : {}),
    ...(reviewedAt ? { reviewedAt } : {})
  };
}

/**
 * The instance an admin payload (without its `secrets`) describes, validated.
 * The migration state and log are the runner's (`DefinitionMigrationRunner`):
 * a payload never sets them; a save keeps the log it had, its install date
 * and its health.
 *
 * @param {object} fields - the payload without `secrets` (a copy; it is changed)
 * @param {object|undefined} existing - the stored instance on an update
 * @returns {object} the parsed instance, without `status` and `statusReason`
 * @throws {IntegrationError} `INVALID_INSTANCE`
 */
function parseInstancePayload(fields, existing) {
  delete fields.status;
  delete fields.statusReason;
  delete fields.migrationLog;
  // The tool approval (#2945) is edited on its own (`setApproval`): a save
  // that does not name it keeps the stored one, so an editor that knows
  // nothing about approval cannot drop an admin's gate. `approval: null`
  // removes it explicitly.
  const keepsApproval = !Object.hasOwn(fields, 'approval') && existing?.approval;
  if (fields.approval === null) delete fields.approval;
  // The accepted action fingerprints (#2916) are the server's: a baseline
  // or "Mark reviewed" writes them, a save keeps the stored ones (`update`).
  if (fields.actions && typeof fields.actions === 'object') {
    const { fingerprints: _fingerprints, reviewedAt: _reviewedAt, ...actions } = fields.actions;
    fields.actions = actions;
  }
  const parsed = validateInstalledIntegration({
    ...fields,
    installedAt: existing?.installedAt,
    health: existing?.health,
    ...(existing?.migrationLog ? { migrationLog: existing.migrationLog } : {}),
    ...(keepsApproval ? { approval: existing.approval } : {})
  });
  if (!parsed.success) {
    throw new IntegrationError('Invalid installed integration', {
      code: 'INVALID_INSTANCE',
      details: parsed.error ?? parsed.errors
    });
  }
  const instance = parsed.data;
  delete instance.status;
  delete instance.statusReason;
  return instance;
}

/**
 * Refuse an instance id that would collide with tool routing: one with `__`
 * (the separator of integration tool ids), a reserved id or a reserved prefix.
 *
 * @param {{ id: string }} instance
 * @throws {IntegrationError} `INVALID_ID`
 */
function assertInstanceIdAllowed(instance) {
  if (
    instance.id.includes('__') ||
    RESERVED_INSTANCE_IDS.has(instance.id.toLowerCase()) ||
    RESERVED_INSTANCE_ID_PREFIX.test(instance.id)
  ) {
    throw new IntegrationError(
      'Instance id must not contain "__", be a reserved id or start with workflow_, knowledge_ or source_',
      { code: 'INVALID_ID' }
    );
  }
}

/**
 * Refuse an instance its definition cannot run: a singleton under another
 * id, a protocol without an adapter in this release, or a sign-in mode the
 * definition or the adapter does not offer.
 *
 * @param {object} definition - the validated definition
 * @param {object} instance - the parsed instance
 * @throws {IntegrationError} `SINGLETON_ID`, `UNSUPPORTED_PROTOCOL`,
 *   `INVALID_AUTH_MODE` or `UNSUPPORTED_AUTH_MODE`
 */
function assertDefinitionRunsInstance(definition, instance) {
  if (definition.singleton && instance.id !== definition.singleton.instanceId) {
    throw new IntegrationError(
      `"${definition.id}" is installed once, as "${definition.singleton.instanceId}"`,
      { code: 'SINGLETON_ID' }
    );
  }
  const adapter = getProtocolAdapter(definition.protocol.type);
  if (!adapter) {
    throw new IntegrationError(
      `Protocol "${definition.protocol.type}" has no adapter in this release`,
      { code: 'UNSUPPORTED_PROTOCOL' }
    );
  }
  if (!definition.auth.modes.includes(instance.auth.mode)) {
    throw new IntegrationError(
      `Auth mode "${instance.auth.mode}" is not offered by the definition`,
      { code: 'INVALID_AUTH_MODE' }
    );
  }
  if (
    Array.isArray(adapter.supportedAuthModes) &&
    !adapter.supportedAuthModes.includes(instance.auth.mode)
  ) {
    throw new IntegrationError(
      `Auth mode "${instance.auth.mode}" is not available for "${definition.protocol.type}" integrations in this release`,
      { code: 'UNSUPPORTED_AUTH_MODE' }
    );
  }
}

/**
 * The secret the admin entered for the sign-in mode's secret field, trimmed;
 * null when the mode has none or the admin left it empty (keep the stored one).
 *
 * @param {Record<string, unknown>|undefined} secrets - the payload's `secrets`
 * @param {string|null} secretField - the mode's secret field key
 * @returns {string|null}
 */
function providedSecretValue(secrets, secretField) {
  if (!secrets || !secretField) return null;
  const value = secrets[secretField];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Refuse install values the definition does not accept (`checkInstallValues`).
 *
 * @param {object} definition
 * @param {object} instance - the parsed instance (its `values` and sign-in mode)
 * @param {boolean} hasCredential - a secret was entered or one is stored
 * @throws {IntegrationError} `INVALID_VALUES` with the errors as `details`
 */
function assertInstallValues(definition, instance, hasCredential) {
  const valueErrors = checkInstallValues(definition, instance.values, {
    authMode: instance.auth.mode,
    hasCredential
  });
  if (valueErrors.length) {
    throw new IntegrationError('Invalid install values', {
      code: 'INVALID_VALUES',
      // `errors` of the answer: which install value is wrong, by JSON Pointer
      details: valueErrors.map(({ kind, key, message }) => ({
        path: ['values', key],
        code: kind,
        message
      }))
    });
  }
}

/**
 * Point the instance at its secret for a sign-in mode that keeps one: a newly
 * entered secret gets the managed credential id (and is returned to be
 * stored); otherwise the instance keeps the reference it had.
 *
 * @param {object} instance - the parsed instance; `auth.credentialRef` is set here
 * @param {object|undefined} existing - the stored instance on an update
 * @param {{ definition: object, secretField: string, providedSecret: string|null }} secret
 * @returns {Array<{ id: string, value: string, instance: object, definition: object, secretField: string }>}
 *   the secret to write to the credential store, or none
 */
function applySecret(instance, existing, { definition, secretField, providedSecret }) {
  if (providedSecret) {
    const credentialRef = credentialIdFor(instance.id, secretField);
    instance.auth.credentialRef = credentialRef;
    return [{ id: credentialRef, value: providedSecret, instance, definition, secretField }];
  }
  if (!instance.auth.credentialRef && existing?.auth?.credentialRef) {
    instance.auth.credentialRef = existing.auth.credentialRef;
  }
  return [];
}

export class InstalledIntegrationService {
  constructor({ registry = integrationRegistry } = {}) {
    this.registry = registry;
    /** Tail of the change queue (see `_serialize`). */
    this._queue = Promise.resolve();
  }

  /** The whole file, validated, with defaults and the always-installed built-ins. */
  readConfig() {
    const cached = configCache.get(INTEGRATIONS_FILE);
    const data = cached?.data;
    if (!data) return this._withBuiltIns(emptyConfig());
    const result = validateIntegrationsConfig(data);
    if (!result.success) {
      logger.error('integrations.json is invalid; using an empty configuration', {
        component: COMPONENT,
        issues: result.errors.map(e => `${e.path.join('.')}: ${e.message}`)
      });
      return this._withBuiltIns(emptyConfig());
    }
    return this._withBuiltIns(result.data);
  }

  /**
   * The file for a change. An invalid file is an error here, not an empty
   * configuration: writing the fallback back would erase every installation.
   */
  _readConfigForWrite(data = configCache.get(INTEGRATIONS_FILE)?.data) {
    if (!data) return this._withBuiltIns(emptyConfig());
    const result = validateIntegrationsConfig(data);
    if (!result.success) {
      throw new IntegrationError(
        'integrations.json is invalid; fix the file before changing installations',
        { status: 500, code: 'INVALID_CONFIG', details: result.errors }
      );
    }
    return this._withBuiltIns(result.data);
  }

  /** The definitions that are installed at all times (`alwaysInstalled`), as far as the registry has loaded them. */
  _alwaysInstalledDefinitions() {
    try {
      return this.registry
        .list()
        .map(entry => entry.definition)
        .filter(definition => definition?.alwaysInstalled && definition.singleton?.instanceId);
    } catch {
      return [];
    }
  }

  /** Whether an installation is one of the always-installed built-ins. */
  isAlwaysInstalled(instanceId) {
    return this._alwaysInstalledDefinitions().some(
      definition => definition.singleton.instanceId === instanceId
    );
  }

  /**
   * The config with an installation for every always-installed built-in the
   * file lacks, and with those it holds switched on: they can be edited
   * (actions) but never removed or disabled.
   */
  _withBuiltIns(config) {
    for (const definition of this._alwaysInstalledDefinitions()) {
      const existing = config.installed.find(inst => inst.id === definition.singleton.instanceId);
      if (!existing) config.installed.push(builtInInstance(definition));
      else if (existing.enabled === false) existing.enabled = true;
    }
    return config;
  }

  async writeConfig(config) {
    const result = validateIntegrationsConfig(config);
    if (!result.success) {
      throw new IntegrationError('Invalid integrations configuration', {
        status: 500,
        code: 'INVALID_CONFIG',
        details: result.errors
      });
    }
    await configStore.writeJson(INTEGRATIONS_FILE, result.data);
    await configCache.refreshCacheEntry?.(INTEGRATIONS_FILE);
    return result.data;
  }

  /**
   * Change the stored file as one locked read-change-write step. `mutate` gets
   * the config as stored (an invalid file throws before it runs) and may run
   * more than once, so it must be synchronous and derive everything from that
   * config; do any async work and validation of the payload before calling.
   * Return {@link SKIP} to leave the file as it is. Resolves to what `mutate`
   * returned, or null when it left the file as it is. The in-process `_serialize` queue stays: it also orders the
   * credential and notification steps around a change.
   */
  async _updateConfig(mutate) {
    let outcome;
    const { written } = await configStore.updateJson(INTEGRATIONS_FILE, current => {
      const config = this._readConfigForWrite(current);
      outcome = mutate(config);
      if (outcome === SKIP) return undefined;
      const result = validateIntegrationsConfig(config);
      if (!result.success) {
        throw new IntegrationError('Invalid integrations configuration', {
          status: 500,
          code: 'INVALID_CONFIG',
          details: result.errors
        });
      }
      return result.data;
    });
    if (!written) return null;
    await configCache.refreshCacheEntry?.(INTEGRATIONS_FILE);
    return outcome;
  }

  list() {
    return this.readConfig().installed;
  }

  get(id) {
    return this.list().find(inst => inst.id === id) || null;
  }

  security() {
    return this.readConfig().security;
  }

  /**
   * An instance with its definition, document, effective values and label.
   * @param {string|object} idOrInstance
   * @param {string} [language]
   */
  async resolve(idOrInstance, language = 'en') {
    await this.registry.ensureLoaded();
    const instance = typeof idOrInstance === 'string' ? this.get(idOrInstance) : idOrInstance;
    if (!instance) return null;
    const entry = this.registry.get(instance.definition);
    if (!entry) {
      return {
        instance,
        definition: null,
        document: null,
        values: {},
        label: instance.id,
        missingDefinition: true
      };
    }
    const migration = installationMigrationState(instance, entry);
    return {
      instance,
      definition: entry.definition,
      document: entry.document,
      security: this.security(),
      values: effectiveValues(entry.definition, instance),
      label: instanceLabel(entry.definition, instance, language),
      /** `ok`, or `incompatible` when the definition cannot run on this server version. */
      status: entry.status || 'ok',
      statusReason: entry.statusReason || null,
      incompatible: entry.status === 'incompatible',
      /**
       * Where the installation stands with the definition's versions
       * (`migrationPlanner.installationMigrationState`): `migrationPending`,
       * `migrationFailed` or `needsReview`, and whether that withholds its
       * tools (`blocked`).
       */
      migration,
      /** Offers no tools and no scopes: a failed or pending migration, or one that needs a review. */
      blocked: migration.blocked
    };
  }

  /**
   * Every enabled instance whose definition and adapter exist, resolved. An
   * installation of an incompatible definition is left out: it is listed to
   * the admin with the reason, but offers no tools and no scopes. So is one
   * whose migration state withholds them (`blocked`): a failed migration, a
   * pending one with a migration between the versions, one that needs a
   * review. The old values are never served against a newer definition.
   */
  async resolveAllEnabled(language = 'en') {
    await this.registry.ensureLoaded();
    const enabled = this.list().filter(instance => instance.enabled !== false);
    // `Promise.all` keeps the input order, so the list stays in file order.
    const resolved = await Promise.all(enabled.map(instance => this.resolve(instance, language)));
    return resolved.filter(
      entry =>
        entry?.definition &&
        !entry.incompatible &&
        !entry.blocked &&
        getProtocolAdapter(entry.definition.protocol.type)
    );
  }

  /**
   * Validate an admin payload against its definition. Returns the normalized
   * instance (without secrets) and the secrets to store.
   */
  async _prepare(payload, { existing } = {}) {
    rejectAllowedGroups(payload);
    await this.registry.ensureLoaded();
    const { secrets, ...rest } = payload || {};
    const instance = parseInstancePayload(rest, existing);
    assertInstanceIdAllowed(instance);
    const entry = this._definitionEntryFor(instance);
    const definition = entry.definition;

    // The secret a sign-in mode keeps in the credential store: the service
    // account's token, the OAuth client's secret, or (optional) the secret of
    // a pre-registered client for per-user OAuth.
    const secretSpec = secretFieldForMode(definition, instance.auth.mode);
    const secretField = secretSpec?.key || null;
    const providedSecret = providedSecretValue(secrets, secretField);
    const keepsCredential = Boolean(instance.auth.credentialRef || existing?.auth?.credentialRef);
    assertInstallValues(definition, instance, Boolean(providedSecret) || keepsCredential);

    let toStore = [];
    if (secretSpec) {
      toStore = applySecret(instance, existing, { definition, secretField, providedSecret });
    } else {
      delete instance.auth.credentialRef;
    }

    if (definition.alwaysInstalled) instance.enabled = true;
    instance.definitionVersion = definition.version;
    instance.installedAt = existing?.installedAt || nowIso();
    instance.updatedAt = nowIso();
    return { instance, definition, document: entry.document, secretsToStore: toStore };
  }

  /**
   * The registry entry an instance is saved against, once the definition
   * accepts it: the id is not a built-in's fixed id, the definition exists,
   * runs on this server, takes this id (a singleton's own), has an adapter,
   * and offers the instance's sign-in mode.
   *
   * @param {object} instance - the parsed instance
   * @returns {object} the registry entry (`{ definition, document, status, … }`)
   * @throws {IntegrationError} with the code of the first check that fails
   */
  _definitionEntryFor(instance) {
    // A built-in's fixed id (`ifinder`, `iassistant`) belongs to that built-in:
    // its config is read by that id, so another definition installed under it
    // would receive the built-in's per-user tokens.
    const claimedBy = this.registry
      .list()
      .find(
        e =>
          e.definition.singleton?.instanceId === instance.id &&
          e.definition.id !== instance.definition
      );
    if (claimedBy) {
      throw new IntegrationError(`"${instance.id}" is reserved for ${claimedBy.definition.id}`, {
        code: 'INVALID_ID'
      });
    }
    const entry = this.registry.get(instance.definition);
    if (!entry) {
      throw new IntegrationError(`Unknown integration definition "${instance.definition}"`, {
        status: 404,
        code: 'UNKNOWN_DEFINITION'
      });
    }
    if (entry.status === 'incompatible') {
      // Values are validated against a definition this server cannot run;
      // nothing saved against it would be served anyway.
      throw new IntegrationError(
        `Integration definition "${entry.definition.id}" ${entry.statusReason || 'is incompatible with this server version'}`,
        { code: 'INCOMPATIBLE_DEFINITION', details: entry.compatibility }
      );
    }
    assertDefinitionRunsInstance(entry.definition, instance);
    return entry;
  }

  async _storeSecrets(secretsToStore, language = 'en') {
    if (!secretsToStore.length) return;
    // One locked read-change-write of the credential store for all of them:
    // each secret lands in the same file, next to whatever the credentials
    // routes wrote meanwhile. The encryption happens before the lock.
    const records = secretsToStore.map(({ id, value, instance, definition, secretField }) => {
      const field = definition.install.find(f => f.key === secretField);
      return {
        id,
        type: 'secret',
        name: `${instanceLabel(definition, instance, language)}: ${localized(field?.title, language, secretField)}`,
        description: `Managed by the installed integration "${instance.id}"`,
        value: tokenStorageService.encryptString(value)
      };
    });
    await configStore.updateJson(CREDENTIALS_FILE, current => {
      const store = current || { credentials: {} };
      if (!store.credentials) store.credentials = {};
      for (const record of records) store.credentials[record.id] = record;
      return store;
    });
    await configCache.refreshCredentialsCache?.();
  }

  async _removeManagedCredential(instance) {
    const ref = instance?.auth?.credentialRef;
    if (!ref?.startsWith(`integration-${instance.id}-`)) return;
    try {
      const { written } = await configStore.updateJson(CREDENTIALS_FILE, current => {
        if (!current?.credentials?.[ref]) return undefined;
        delete current.credentials[ref];
        return current;
      });
      if (written) await configCache.refreshCredentialsCache?.();
    } catch (error) {
      logger.warn('Could not remove the managed credential of an integration', {
        component: COMPONENT,
        instanceId: instance.id,
        credentialRef: ref,
        error: error.message
      });
    }
  }

  /**
   * Run one change at a time. Every change is a read-modify-write of the
   * whole file, so two admins saving at once would otherwise lose one save.
   */
  _serialize(fn) {
    const run = this._queue.then(fn, fn);
    this._queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /** Create an instance. `payload.secrets` holds sensitive field values. */
  create(payload, { language = 'en' } = {}) {
    return this._serialize(async () => {
      if (this.get(payload?.id)) {
        throw new IntegrationError(`An integration with id "${payload.id}" exists`, {
          status: 409,
          code: 'DUPLICATE_ID'
        });
      }
      const { instance, secretsToStore } = await this._prepare(payload);
      await this._storeSecrets(secretsToStore, language);
      await this._updateConfig(config => {
        if (config.installed.some(inst => inst.id === instance.id)) {
          throw new IntegrationError(`An integration with id "${instance.id}" exists`, {
            status: 409,
            code: 'DUPLICATE_ID'
          });
        }
        config.installed.push(instance);
      });
      await this._afterChange(instance.id, { before: null, after: instance });
      return instance;
    });
  }

  /**
   * Refuse an ordinary save of an installation whose migration state only
   * the migration actions may change (versioning concept §3): a save stamps
   * the loaded definition's version on the values, which must not happen to
   * values a pending migration has not brought there, to a failed one, or to
   * one that needs a review. A pending installation with no migration
   * between the versions saves normally (nothing it stores changes).
   *
   * @param {object} existing - the stored installation
   * @throws {IntegrationError} 409 `MIGRATION_PENDING`, `MIGRATION_FAILED` or `NEEDS_REVIEW`
   */
  _assertSavable(existing) {
    const state = installationMigrationState(existing, this.registry.get(existing.definition));
    if (state.status === 'migrationPending' && state.blocked) {
      throw new IntegrationError(
        `"${existing.id}" waits for the migrations ${state.migrations.join(', ')} (${state.from} → ${state.to}); run the migration before saving`,
        { status: 409, code: 'MIGRATION_PENDING', details: { migration: state } }
      );
    }
    if (state.status === 'migrationFailed') {
      throw new IntegrationError(
        `The migration of "${existing.id}" failed (${state.statusReason || 'no reason recorded'}); re-run it, restore a backup or uninstall the integration`,
        { status: 409, code: 'MIGRATION_FAILED', details: { migration: state } }
      );
    }
    if (state.status === 'needsReview') {
      throw new IntegrationError(
        `"${existing.id}" needs a review (${state.statusReason}); restore a backup, adopt the loaded version or uninstall it`,
        { status: 409, code: 'NEEDS_REVIEW', details: { migration: state } }
      );
    }
  }

  /** Replace an instance (the id cannot change). */
  update(id, payload, { language = 'en' } = {}) {
    return this._serialize(async () => {
      const existing = this.get(id);
      if (!existing)
        throw new IntegrationError('Integration not found', { status: 404, code: 'NOT_FOUND' });
      if (payload?.id && payload.id !== id) {
        throw new IntegrationError('The instance id cannot change', { code: 'ID_CHANGE' });
      }
      await this.registry.ensureLoaded();
      this._assertSavable(existing);
      const { instance, secretsToStore } = await this._prepare({ ...payload, id }, { existing });
      await this._storeSecrets(secretsToStore, language);
      await this._updateConfig(config => {
        const index = config.installed.findIndex(inst => inst.id === id);
        if (index < 0)
          throw new IntegrationError('Integration not found', { status: 404, code: 'NOT_FOUND' });
        keepActionReview(instance, config.installed[index]);
        keepGuidance(instance, config.installed[index], payload);
        config.installed[index] = instance;
      });
      // Only once the file points elsewhere: a failed write must leave the
      // credential the file still names.
      if (
        existing.auth?.credentialRef &&
        existing.auth.credentialRef !== instance.auth?.credentialRef
      ) {
        await this._removeManagedCredential(existing);
      }
      await this._afterChange(instance.id, { before: existing, after: instance });
      return instance;
    });
  }

  /**
   * Set the tool approval of an installation (#2945): `{ default?, actions? }`,
   * or null to remove it. Only this field changes, so the Overview's approval
   * controls cannot touch the values or the secret.
   *
   * @param {string} id
   * @param {{default?: string, actions?: Object<string,string>, newOrChanged?: string}|null} approval
   * @returns {Promise<Object>} the stored installation
   */
  setApproval(id, approval = null) {
    return this._serialize(async () => {
      let cleaned = null;
      if (approval !== null) {
        const parsed = installedApprovalSchema.safeParse(approval);
        if (!parsed.success) {
          throw new IntegrationError('Invalid approval settings', {
            code: 'INVALID_APPROVAL',
            details: parsed.error.issues
          });
        }
        cleaned = parsed.data;
        if (cleaned.actions && Object.keys(cleaned.actions).length === 0) delete cleaned.actions;
        if (!cleaned.default && !cleaned.actions && !cleaned.newOrChanged) cleaned = null;
      }
      const { instance, before } = await this._updateConfig(config => {
        const instance = config.installed.find(inst => inst.id === id);
        if (!instance)
          throw new IntegrationError('Integration not found', { status: 404, code: 'NOT_FOUND' });
        const before = { ...instance };
        if (cleaned) instance.approval = cleaned;
        else delete instance.approval;
        instance.updatedAt = nowIso();
        return { instance, before };
      });
      await this._afterChange(instance.id, { before, after: instance });
      return instance;
    });
  }

  /**
   * Change the admin override of one action (#2974): any of `description`,
   * `guidance`, `examples` (texts, `{ en, de }` or a string), `sideEffect`
   * and `dataFlow`. A key set to null removes that part of the override; a
   * key left out keeps it. Only this action's override changes.
   *
   * @param {string} id
   * @param {string} actionName
   * @param {Object} patch
   * @returns {Promise<{instance: Object, override: Object|null}>}
   * @throws {IntegrationError} 404 `NOT_FOUND`; 400 `INVALID_OVERRIDE`
   */
  setActionOverride(id, actionName, patch) {
    return this._serialize(async () => {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new IntegrationError('The override must be an object', { code: 'INVALID_OVERRIDE' });
      }
      const { instance, before, overrides } = await this._updateConfig(config => {
        const instance = config.installed.find(inst => inst.id === id);
        if (!instance)
          throw new IntegrationError('Integration not found', { status: 404, code: 'NOT_FOUND' });
        const merged = { ...(instance.actions?.overrides?.[actionName] || {}) };
        for (const key of ['description', 'guidance', 'examples', 'sideEffect', 'dataFlow']) {
          if (!Object.hasOwn(patch, key)) continue;
          const value =
            key === 'examples' && Array.isArray(patch[key])
              ? patch[key].map(withoutEmptyTexts).filter(Boolean)
              : key === 'description' || key === 'guidance'
                ? withoutEmptyTexts(patch[key])
                : patch[key];
          const empty =
            value === null ||
            value === '' ||
            (Array.isArray(value) && value.length === 0 && key !== 'examples');
          if (empty) delete merged[key];
          else merged[key] = value;
        }
        const parsed = actionOverrideSchema.strict().safeParse(merged);
        if (!parsed.success) {
          throw new IntegrationError('Invalid action override', {
            code: 'INVALID_OVERRIDE',
            details: parsed.error.issues
          });
        }
        const before = structuredClone(instance);
        const overrides = { ...(instance.actions?.overrides || {}) };
        if (Object.keys(parsed.data).length) overrides[actionName] = parsed.data;
        else delete overrides[actionName];
        instance.actions = { ...instance.actions, overrides };
        instance.updatedAt = nowIso();
        return { instance, before, overrides };
      });
      await this._afterChange(instance.id, { before, after: instance });
      return { instance, override: overrides[actionName] || null };
    });
  }

  /**
   * Set the installation's own model guidance (#2974), replacing the
   * definition's `instructions` (or an MCP server's) in the system prompt;
   * null or '' removes it.
   *
   * @param {string} id
   * @param {Object|string|null} instructions - `{ en, de }` or a string
   * @returns {Promise<Object>} the stored installation
   * @throws {IntegrationError} 404 `NOT_FOUND`; 400 `INVALID_INSTRUCTIONS`
   */
  setInstructions(id, instructions) {
    return this._serialize(async () => {
      let cleaned = null;
      if ((instructions ?? '') !== '') {
        const parsed = boundedLocalizedSchema.safeParse(instructions);
        if (!parsed.success) {
          throw new IntegrationError('Invalid instructions', {
            code: 'INVALID_INSTRUCTIONS',
            details: parsed.error.issues
          });
        }
        cleaned =
          typeof parsed.data === 'string'
            ? parsed.data
            : Object.fromEntries(Object.entries(parsed.data).filter(([, text]) => text.trim()));
        if (typeof cleaned === 'object' && Object.keys(cleaned).length === 0) cleaned = null;
      }
      const { instance, before } = await this._updateConfig(config => {
        const instance = config.installed.find(inst => inst.id === id);
        if (!instance)
          throw new IntegrationError('Integration not found', { status: 404, code: 'NOT_FOUND' });
        const before = structuredClone(instance);
        if (cleaned) instance.instructions = cleaned;
        else delete instance.instructions;
        instance.updatedAt = nowIso();
        return { instance, before };
      });
      await this._afterChange(instance.id, { before, after: instance });
      return instance;
    });
  }

  /**
   * Take the action fingerprint baseline of an installation (#2916): the
   * current fingerprints become the accepted ones, but only while the
   * installation has none (a baseline is never overwritten; "Mark reviewed"
   * is {@link markActionsReviewed}). Nothing else changes, `updatedAt`
   * included: the baseline is the server's, not an admin edit.
   *
   * @param {string} id
   * @param {Object<string,string>} fingerprints - current fingerprints by action name
   * @returns {Promise<Object|null>} the stored installation, or null when nothing was written
   */
  recordActionBaseline(id, fingerprints) {
    return this._serialize(async () => {
      // Null when the baseline already exists and nothing was written.
      return this._updateConfig(config => {
        const instance = config.installed.find(inst => inst.id === id);
        if (!instance || instance.actions?.fingerprints) return SKIP;
        instance.actions = { ...instance.actions, fingerprints: sortedRecord(fingerprints) };
        return instance;
      });
    });
  }

  /**
   * Mark actions of an installation as reviewed (#2916): their current
   * fingerprints become the accepted ones, so they are no longer new or
   * changed. `names` null marks every current action; accepted fingerprints of
   * actions the system no longer lists are kept (an action that comes back
   * unchanged is not new again).
   *
   * @param {string} id
   * @param {Object<string,string>} fingerprints - current fingerprints by action name
   * @param {string[]|null} [names] - the actions to mark; null for all
   * @returns {Promise<{instance: Object, reviewed: string[]}>}
   * @throws {IntegrationError} 404 `NOT_FOUND`; 400 `UNKNOWN_ACTION` when no named action is listed
   */
  markActionsReviewed(id, fingerprints, names = null) {
    return this._serialize(async () => {
      const current = fingerprints && typeof fingerprints === 'object' ? fingerprints : {};
      const reviewed = Array.isArray(names)
        ? [...new Set(names)].filter(name => Object.hasOwn(current, name))
        : Object.keys(current);
      if (Array.isArray(names) && reviewed.length === 0) {
        throw new IntegrationError('None of these actions is listed by the integration', {
          code: 'UNKNOWN_ACTION',
          details: { actions: names }
        });
      }
      const instance = await this._updateConfig(config => {
        const instance = config.installed.find(inst => inst.id === id);
        if (!instance)
          throw new IntegrationError('Integration not found', { status: 404, code: 'NOT_FOUND' });
        const accepted = { ...(instance.actions?.fingerprints || {}) };
        for (const name of reviewed) accepted[name] = current[name];
        const reviewedAt = nowIso();
        instance.actions = {
          ...instance.actions,
          fingerprints: sortedRecord(accepted),
          reviewedAt
        };
        instance.updatedAt = reviewedAt;
        return instance;
      });
      return { instance, reviewed: reviewed.sort(compareCodeUnits) };
    });
  }

  setEnabled(id, enabled) {
    return this._serialize(async () => {
      if (!enabled && this.isAlwaysInstalled(id)) {
        throw new IntegrationError(
          `"${id}" is always installed and enabled; switch its actions off instead`,
          { code: 'ALWAYS_INSTALLED' }
        );
      }
      const { instance, before } = await this._updateConfig(config => {
        const instance = config.installed.find(inst => inst.id === id);
        if (!instance)
          throw new IntegrationError('Integration not found', { status: 404, code: 'NOT_FOUND' });
        const before = { ...instance };
        instance.enabled = Boolean(enabled);
        instance.updatedAt = nowIso();
        return { instance, before };
      });
      await this._afterChange(instance.id, { before, after: instance });
      return instance;
    });
  }

  remove(id) {
    return this._serialize(async () => {
      if (this.isAlwaysInstalled(id)) {
        throw new IntegrationError(`"${id}" is always installed and cannot be removed`, {
          code: 'ALWAYS_INSTALLED'
        });
      }
      const instance = await this._updateConfig(config => {
        const instance = config.installed.find(inst => inst.id === id);
        if (!instance)
          throw new IntegrationError('Integration not found', { status: 404, code: 'NOT_FOUND' });
        config.installed = config.installed.filter(inst => inst.id !== id);
        return instance;
      });
      await this._removeManagedCredential(instance);
      await this._afterChange(instance.id, { before: instance, after: null });
      return instance;
    });
  }

  /** Instances that use a definition (the marketplace refuses to uninstall while any exist). */
  instancesOf(definitionId) {
    return this.list().filter(inst => inst.definition === definitionId);
  }

  /**
   * Test an unsaved or saved instance. `payload` is validated like a create,
   * except that the id may already exist; a secret may be provided inline or
   * the stored credential is used. `req` is the admin's request, for connectors
   * whose test shows request-derived values (the Jira redirect URI);
   * `testInput` is what the admin typed into the definition's `test.input`
   * field (a directory's sample search), passed to the connector as it is.
   */
  async test(payload, { language = 'en', user, req, testInput } = {}) {
    const existing = payload?.id ? this.get(payload.id) : null;
    const { instance, definition, document, secretsToStore } = await this._prepare(payload, {
      existing
    });
    const adapter = getProtocolAdapter(definition.protocol.type);
    const inlineSecret = secretsToStore[0]?.value;
    // An inline secret is resolved for this one test and written nowhere; the
    // resolver travels with the call, so concurrent tests cannot see it.
    const resolveSecret = inlineSecret ? () => inlineSecret : undefined;
    const probeInstance = inlineSecret
      ? { ...instance, auth: { ...instance.auth, credentialRef: '__inline__' } }
      : instance;
    return adapter.test({
      definition,
      instance: probeInstance,
      document,
      security: this.security(),
      language,
      user,
      req,
      resolveSecret,
      testInput: testInput && typeof testInput === 'object' ? testInput : undefined
    });
  }

  async _afterChange(instanceId, { before = null, after = null } = {}) {
    try {
      const { invalidate } = await import('./protocols/openapi/OpenApiAdapter.js');
      invalidate(instanceId);
      // A native connector may react to its installation changing (the
      // iFinder connector switches the iAssistant model on after setup).
      const definitionId = (after || before)?.definition;
      const entry = definitionId ? this.registry.get(definitionId) : null;
      const protocolType = entry?.definition.protocol.type;
      if (protocolType === 'native' || protocolType === 'script') {
        const { getConnectorFor } = await import('./protocols/native/NativeAdapter.js');
        const connector = await getConnectorFor(entry.definition).catch(() => null);
        await connector?.onChanged?.({ before, after, definition: entry.definition });
      }
      const { syncIntegrationScopeProviders } = await import('./integrationTools.js');
      await syncIntegrationScopeProviders();
    } catch (error) {
      logger.warn('Integration post-change hook failed', {
        component: COMPONENT,
        error: error.message
      });
    }
  }
}

const installedIntegrationService = new InstalledIntegrationService();
export default installedIntegrationService;
