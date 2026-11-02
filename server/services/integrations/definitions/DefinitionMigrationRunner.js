// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import semver from 'semver';
import configStore from '../../config/ConfigStore.js';
import logger from '../../../utils/logger.js';
import integrationRegistry from './IntegrationRegistry.js';
import installedIntegrationService, {
  IntegrationError,
  INTEGRATIONS_FILE
} from '../InstalledIntegrationService.js';
import { getStorage, readFacet } from '../../../storage/bootstrap.js';
import { LockTimeoutError } from '../../../storage/errors.js';
import { resolveStorageConfig } from '../../../storage/StorageRegistry.js';
import { FilesystemLockManager } from '../../../storage/providers/filesystem/FilesystemLockManager.js';
import { resolveFilesystemBaseDir } from '../../../storage/providers/filesystem/FilesystemStorageProvider.js';
import {
  validateIntegrationsConfig,
  MIGRATION_LOG_LIMIT
} from '../../../validators/integrationsConfigSchema.js';
import {
  definitionIdToDirName,
  isStrictSemver
} from '../../../validators/integrationDefinitionSchema.js';
import {
  appBindsInstallation,
  bindingKeysOf,
  canonicalJson,
  describeCollisions,
  installationMigrationState,
  migrationsBetween,
  planMigration,
  validateMigrationResult
} from './migrationPlanner.js';
import * as backups from './migrationBackups.js';

/**
 * The definition migration runner (versioning concept §3, phase 2): brings
 * an installation — its values, its action policy and the bindings of the
 * apps that bind it — from its `definitionVersion` to the loaded definition
 * with the declarative steps of the definition's `migrations`.
 *
 * Triggers: the server start (built-in definitions an iHub release updated,
 * {@link runIntegrationStartupMigrations}), a marketplace update
 * ({@link DefinitionMigrationRunner#applyDefinitionUpdate}) and an admin
 * (`POST /api/admin/integrations/installed/:id/_migrate`). Each installation
 * is its own unit of work under the cluster-wide lock
 * `integration-migration:<instanceId>`; one failing never blocks the others.
 *
 * A run:
 *
 * 1. takes a backup (`migrationBackups.js`) of `config/integrations.json`, the
 *    app files that bind the installation, the marketplace manifest and, for
 *    a marketplace definition whose folder is still the version the
 *    installation was written for, the definition folder;
 * 2. plans the steps and validates the result against the definition
 *    (`migrationPlanner.js`); a collision or an unknown reference fails the
 *    run before anything is written;
 * 3. commits: the results are written to the backup's `staging/` folder, a
 *    commit marker carrying the lock's fencing token is written, the token is
 *    checked again under the lock (a holder whose lease was taken over gives
 *    up here and discards its staging), the files move into place, and the
 *    marker is finalised. A failure while moving rolls everything back from
 *    the backup; a crash leaves an unfinished marker that
 *    {@link DefinitionMigrationRunner#recoverInterruptedCommits} rolls back at
 *    the next start (and before the next run on that installation);
 * 4. on failure, keeps `definitionVersion` and the values, and marks the
 *    installation `status: migrationFailed` with the reason. It then offers
 *    no tools until an admin re-runs the migration, restores a backup or
 *    uninstalls it.
 *
 * A restore writes back exactly what a migration may have changed, taken
 * from a backup: the installation's entry in `integrations.json`, the app
 * bindings it kept (by key, not the whole app file), the definition's entry
 * of the marketplace manifest and, when the backup holds one, the definition
 * folder. Everything else that changed since stays as it is. Credentials and
 * the credential store are never touched.
 *
 * Files are read fresh through the configuration store, not from the cache:
 * the startup run happens before the cache exists, in the cluster primary
 * (or the single process) right after the numbered config migrations, so no
 * worker ever serves a built-in definition with unmigrated values.
 *
 * @module services/integrations/definitions/DefinitionMigrationRunner
 */

const COMPONENT = 'DefinitionMigrationRunner';
const APPS_NAMESPACE = 'apps';
const INSTALLATIONS_MANIFEST = 'config/installations.json';
export const MIGRATION_LOCK_PREFIX = 'integration-migration:';

/**
 * Lease lifetime and wait budget. The lease is refreshed while a run works,
 * so the TTL only bounds how long a crashed run blocks the installation.
 */
const LOCK_OPTIONS = Object.freeze({ ttlMs: 60_000, waitMs: 2_000 });
const STARTUP_LOCK_OPTIONS = Object.freeze({ ttlMs: 60_000, waitMs: 10_000 });

/** A lease for lock managers that hand none to the section (no fencing). */
const UNFENCED_LEASE = Object.freeze({ token: null, isCurrent: async () => true });

/** The lock name of an installation. */
export function migrationLockName(instanceId) {
  return `${MIGRATION_LOCK_PREFIX}${instanceId}`;
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

/** Append a log entry and keep the last {@link MIGRATION_LOG_LIMIT}. */
function appendLog(log, entry) {
  return [...(Array.isArray(log) ? log : []), entry].slice(-MIGRATION_LOG_LIMIT);
}

/** The installation without its migration state (a run that succeeded or a restore clears it). */
function withoutState(instance) {
  const { status: _status, statusReason: _reason, ...rest } = instance;
  return rest;
}

/** The marketplace manifest key of a definition (`integration:<folder>`). */
export function manifestKeyOf(definitionId) {
  return `integration:${definitionIdToDirName(definitionId)}`;
}

let fallbackLocks = null;

/**
 * The lock manager: the storage provider's, or, before the provider is up
 * (the startup run happens before it) and when it failed to come up, a
 * filesystem lock manager over the same base directory the filesystem
 * provider uses, so the leases and fencing counters are the same files.
 *
 * @returns {Promise<import('../../../storage/LockManager.js').LockManager>}
 */
async function defaultLocks() {
  const locks = readFacet(getStorage(), 'locks');
  if (locks && typeof locks.withLock === 'function') return locks;
  if (!fallbackLocks) {
    let platform = null;
    try {
      platform = await configStore.readJson('config/platform.json');
    } catch {
      platform = null;
    }
    const { provider, config } = resolveStorageConfig(platform || {});
    fallbackLocks = new FilesystemLockManager({
      baseDir: resolveFilesystemBaseDir(provider === 'filesystem' ? config : {})
    });
  }
  return fallbackLocks;
}

/**
 * The protocols whose adapters list their actions at run time
 * (`dynamicActions` of `protocols/mcp/McpAdapter.js` and
 * `protocols/a2a/A2aAdapter.js`): their action names come from the remote
 * system, so they are not checked against the definition. Kept as a list
 * rather than read from the adapters, so the startup run does not load
 * every protocol adapter (and the MCP client manager) in the cluster
 * primary.
 */
const DYNAMIC_ACTION_PROTOCOLS = Object.freeze(['mcp', 'a2a']);

/** Whether a definition's actions are listed by the remote system (MCP, A2A). */
function hasDynamicActions(definition) {
  return DYNAMIC_ACTION_PROTOCOLS.includes(definition?.protocol?.type);
}

export class DefinitionMigrationRunner {
  /**
   * @param {object} [options]
   * @param {object} [options.registry] - the definitions registry
   * @param {object} [options.service] - the installed integrations service (its change queue and hooks)
   * @param {object} [options.store] - the configuration store
   * @param {object|(() => Promise<object>)} [options.locks] - a lock manager, or a function resolving one
   * @param {() => Date} [options.clock]
   */
  constructor({
    registry = integrationRegistry,
    service = installedIntegrationService,
    store = configStore,
    locks = defaultLocks,
    clock = () => new Date()
  } = {}) {
    this.registry = registry;
    this.service = service;
    this.store = store;
    this.locksSource = locks;
    this.clock = clock;
  }

  async _locks() {
    return typeof this.locksSource === 'function' ? this.locksSource() : this.locksSource;
  }

  _now() {
    return this.clock();
  }

  // --- Locks ---------------------------------------------------------------

  /**
   * Run `fn(lease)` under the installation's lock. A lock held elsewhere for
   * longer than the wait budget is `MIGRATION_LOCKED` (409).
   */
  async _withInstanceLock(instanceId, fn, options = LOCK_OPTIONS) {
    const locks = await this._locks();
    try {
      return await locks.withLock(
        migrationLockName(instanceId),
        lease => fn(lease && typeof lease.isCurrent === 'function' ? lease : UNFENCED_LEASE),
        options
      );
    } catch (error) {
      if (error instanceof LockTimeoutError || error?.code === 'LOCK_TIMEOUT') {
        throw new IntegrationError(
          `A migration of "${instanceId}" is already running; try again when it has finished`,
          { status: 409, code: 'MIGRATION_LOCKED' }
        );
      }
      throw error;
    }
  }

  /** Run `fn(leases)` holding the locks of several installations (taken in id order). */
  async _withInstanceLocks(instanceIds, fn, options = LOCK_OPTIONS) {
    const ids = [...new Set(instanceIds)].sort();
    const leases = new Map();
    const take = async index => {
      if (index >= ids.length) return fn(leases);
      return this._withInstanceLock(
        ids[index],
        lease => {
          leases.set(ids[index], lease);
          return take(index + 1);
        },
        options
      );
    };
    return take(0);
  }

  // --- Reading -------------------------------------------------------------

  /** `config/integrations.json`, validated, read fresh from the store. */
  async _readIntegrations() {
    const data = await this.store.readJson(INTEGRATIONS_FILE);
    if (!data) return { installed: [], security: { blockPrivateIps: true, allowedHosts: [] } };
    const result = validateIntegrationsConfig(data);
    if (!result.success) {
      throw new IntegrationError(
        'integrations.json is invalid; fix the file before migrating installations',
        { status: 500, code: 'INVALID_CONFIG', details: result.errors }
      );
    }
    return result.data;
  }

  /** Every app document with its path. */
  async _readApps() {
    const documents = await this.store.listDocuments(APPS_NAMESPACE);
    return documents.map(doc => ({ path: doc.path, data: doc.data }));
  }

  /** The apps that bind an installation by its id, its definition or its type. */
  _boundApps(allApps, instance, definition) {
    const keys = bindingKeysOf(instance, definition);
    return allApps.filter(app => appBindsInstallation(app.data, keys));
  }

  /** The binding keys of an app a migration may rewrite (own and definition), present now. */
  _rewritableKeys(app, instance) {
    const bindings = app?.integrations || {};
    return [instance.id, instance.definition].filter(
      (key, i, all) => key && Object.hasOwn(bindings, key) && all.indexOf(key) === i
    );
  }

  // --- State for the admin API ---------------------------------------------

  /**
   * The migration view of installations for the admin API:
   * `{ pending, from, to, migrations, summary, warnings, collisions, errors,
   * backups, defaultBackup, downgrade }`, or null when nothing applies (no
   * state and no backup). A pending migration is planned against the current
   * apps (no writes) for its summary and warnings.
   *
   * @param {Array<object>} instances - stored installations
   * @returns {Promise<Map<string, object|null>>} instance id → view
   */
  async describe(instances) {
    await this.registry.ensureLoaded();
    const snapshotsByInstance = new Map();
    for (const snapshot of await backups.listSnapshots()) {
      if (snapshot.manifest.kind === 'journal') continue;
      const list = snapshotsByInstance.get(snapshot.manifest.instanceId) || [];
      list.push(snapshot);
      snapshotsByInstance.set(snapshot.manifest.instanceId, list);
    }
    let allApps = null;
    const out = new Map();
    for (const instance of instances) {
      const entry = this.registry.get(instance.definition);
      const state = installationMigrationState(instance, entry);
      const snapshots = snapshotsByInstance.get(instance.id) || [];
      if (!state.status && snapshots.length === 0) {
        out.set(instance.id, null);
        continue;
      }
      const view = {
        pending: state.pending,
        blocked: state.blocked,
        downgrade: state.downgrade,
        from: state.from,
        to: state.to,
        migrations: state.migrations,
        summary: null,
        warnings: [],
        collisions: [],
        errors: [],
        backups: snapshots.map(backups.snapshotView),
        defaultBackup: this._defaultBackup(state, entry, snapshots)?.id || null
      };
      if (state.pending && state.migrations.length > 0 && entry) {
        try {
          allApps ??= await this._readApps();
          const apps = this._boundApps(allApps, instance, entry.definition);
          const plan = planMigration({
            instance,
            apps: apps.map(app => ({ path: app.path, app: app.data })),
            definition: entry.definition,
            from: state.from,
            to: state.to
          });
          view.summary = plan.summary;
          view.warnings = plan.warnings;
          view.collisions = plan.collisions;
          if (plan.ok) {
            view.errors = validateMigrationResult({
              before: instance,
              after: plan.instance,
              apps: plan.apps,
              definition: entry.definition,
              dynamicActions: hasDynamicActions(entry.definition)
            });
          }
        } catch (error) {
          logger.warn('Could not plan a pending integration migration for the admin view', {
            component: COMPONENT,
            instanceId: instance.id,
            error: error.message
          });
        }
      }
      out.set(instance.id, view);
    }
    return out;
  }

  /**
   * The backup a restore takes when none is named: for `needsReview` the
   * newest one that represents the loaded definition's version, for
   * `migrationFailed` the newest one taken before a migration.
   */
  _defaultBackup(state, entry, snapshots) {
    const offered = snapshots.filter(s => s.manifest.kind !== 'journal');
    if (state.status === 'needsReview') {
      const version = entry?.definition?.version;
      return offered.find(s => s.manifest.representedVersion === version) || null;
    }
    if (state.status === 'migrationFailed') {
      return offered.find(s => (s.manifest.kind || 'pre-migration') === 'pre-migration') || null;
    }
    return null;
  }

  // --- Manual and startup runs ---------------------------------------------

  /**
   * Migrate one installation to the loaded definition (`_migrate`, and the
   * startup run). Runs under the installation's lock.
   *
   * @param {string} instanceId
   * @param {{ by?: string, trigger?: string, lockOptions?: object, notify?: boolean }} [options]
   * @returns {Promise<{ result: string, instance: object, logEntry: object|null }>}
   * @throws {IntegrationError} `NOT_FOUND`, `MIGRATION_LOCKED`, `DEFINITION_MISSING`,
   *   `INCOMPATIBLE_DEFINITION`, `MIGRATION_NOT_APPLICABLE`, `MIGRATION_FAILED`
   *   (422, `details` carries the log entry and the state), `MIGRATION_LOCK_LOST`,
   *   `MIGRATION_CONFLICT`
   */
  async migrate(
    instanceId,
    { by = 'admin', trigger = 'manual', lockOptions = LOCK_OPTIONS, notify = true } = {}
  ) {
    await this.registry.ensureLoaded();
    const outcome = await this._withInstanceLock(
      instanceId,
      lease =>
        this.service._serialize(() => this._migrateLocked(instanceId, { by, trigger, lease })),
      lockOptions
    );
    if (outcome.error) {
      if (notify) await this._afterCommit([outcome.unitResult], {});
      throw outcome.error;
    }
    if (notify && outcome.changed) await this._afterCommit([outcome.unitResult], {});
    return { result: outcome.result, instance: outcome.instance, logEntry: outcome.logEntry };
  }

  async _migrateLocked(instanceId, { by, trigger, lease }) {
    await this._recoverLocked(instanceId);
    const config = await this._readIntegrations();
    const before = config.installed.find(inst => inst.id === instanceId);
    if (!before) {
      throw new IntegrationError('Integration not found', { status: 404, code: 'NOT_FOUND' });
    }
    const entry = this.registry.get(before.definition);
    this._assertMigratable(before, entry);
    const state = installationMigrationState(before, entry);
    if (state.status === 'needsReview') {
      throw new IntegrationError(
        `"${instanceId}" needs a review before it can be migrated: ${state.statusReason}`,
        { status: 409, code: 'MIGRATION_NOT_APPLICABLE' }
      );
    }
    const definition = entry.definition;
    const from = before.definitionVersion;
    const to = definition.version;
    if (!isStrictSemver(from)) {
      throw new IntegrationError(
        `"${instanceId}" records no valid definitionVersion, so a migration has no starting point; restore a backup or adopt the loaded version`,
        { status: 409, code: 'MIGRATION_NOT_APPLICABLE' }
      );
    }
    if (semver.lt(to, from)) {
      throw new IntegrationError(
        `"${instanceId}" is at ${from}, newer than the loaded ${to}; migrations only run forward`,
        { status: 409, code: 'MIGRATION_NOT_APPLICABLE' }
      );
    }
    if (from === to && before.status !== 'migrationFailed') {
      return { result: 'current', instance: before, logEntry: null, changed: false };
    }
    const allApps = await this._readApps();
    const unit = await this._prepareUnit({
      instance: before,
      definition,
      currentEntry: entry,
      allApps,
      by,
      trigger,
      lease
    });
    if (!unit.snapshot) {
      // Nothing stored changes (no migration between the versions): stamp
      // the version, clear a failed state, log it. One write, no backup.
      await this._writeEntries([unit.after]);
      return {
        result: 'stamped',
        instance: unit.after,
        logEntry: unit.logEntry,
        changed: true,
        unitResult: unit
      };
    }
    if (unit.failed) {
      await this._writeEntries([unit.after]).catch(error =>
        logger.error('Could not record a failed integration migration', {
          component: COMPONENT,
          instanceId,
          error: error.message
        })
      );
      return {
        error: this._failureError(unit),
        changed: true,
        unitResult: unit
      };
    }
    try {
      await this._commit({ units: [unit], trigger });
    } catch (error) {
      // A lost lock or a concurrent change is not the migration's failure:
      // the installation belongs to whoever holds it now, or the admin just
      // runs it again. Anything else failed the commit, which rolled back.
      if (
        error instanceof IntegrationError &&
        ['MIGRATION_LOCK_LOST', 'MIGRATION_CONFLICT'].includes(error.code)
      ) {
        throw error;
      }
      const failed = await this._markCommitFailed(unit, error);
      return { error: this._failureError(failed), changed: true, unitResult: failed };
    }
    await this._writeBoundarySnapshots(unit, { by, trigger });
    return {
      result: 'migrated',
      instance: unit.after,
      logEntry: unit.logEntry,
      changed: true,
      unitResult: unit
    };
  }

  /**
   * Record a commit that failed (and was rolled back) as a failed
   * migration: the entry as it was, `migrationFailed` with the error, a
   * failed log entry. Best effort; the error itself is what the caller sees.
   */
  async _markCommitFailed(unit, error) {
    const reason = `the commit failed and was rolled back: ${error.message}`.slice(0, 4000);
    const logEntry = { ...unit.logEntry, result: 'failed', reason };
    const after = {
      ...unit.before,
      status: 'migrationFailed',
      statusReason: reason,
      migrationLog: appendLog(unit.before.migrationLog, logEntry)
    };
    try {
      await this._writeEntries([after]);
    } catch (writeError) {
      logger.error('Could not record a failed integration migration', {
        component: COMPONENT,
        instanceId: unit.instanceId,
        error: writeError.message
      });
    }
    return { ...unit, failed: true, reason, logEntry, after, appWrites: [] };
  }

  _assertMigratable(instance, entry) {
    if (!entry) {
      throw new IntegrationError(
        `The definition "${instance.definition}" of "${instance.id}" is not installed`,
        { status: 422, code: 'DEFINITION_MISSING' }
      );
    }
    if (entry.status === 'incompatible') {
      throw new IntegrationError(
        `Integration definition "${entry.definition.id}" ${entry.statusReason || 'is incompatible with this server version'}; it never migrates`,
        { status: 422, code: 'INCOMPATIBLE_DEFINITION' }
      );
    }
  }

  /** The 422 a failed run answers with; `details` carries the log entry and the new state. */
  _failureError(unit) {
    return new IntegrationError(`Migration of "${unit.instanceId}" failed: ${unit.reason}`, {
      status: 422,
      code: 'MIGRATION_FAILED',
      details: {
        reason: unit.reason,
        logEntry: unit.logEntry,
        status: unit.after.status,
        statusReason: unit.after.statusReason,
        backup: unit.snapshot?.id || null,
        collisions: unit.plan?.collisions || [],
        errors: unit.errors || []
      }
    });
  }

  /**
   * Plan one installation against a definition: back it up, run the steps,
   * validate. Returns the unit the commit writes — migrated, stamped, or
   * marked failed (values untouched).
   */
  async _prepareUnit({
    instance,
    definition,
    currentEntry,
    allApps,
    by,
    trigger,
    lease,
    manifest
  }) {
    const from = instance.definitionVersion;
    const to = definition.version;
    const now = this._now().toISOString();
    const selected = migrationsBetween(definition.migrations, from, to);
    const boundApps = this._boundApps(allApps, instance, definition);
    const base = {
      instanceId: instance.id,
      definitionId: definition.id,
      before: instance,
      lease,
      from,
      to,
      appWrites: [],
      snapshot: null,
      failed: false
    };
    // A backup is taken whenever something stored may change, and always
    // for a marketplace update (it keeps the pre-update definition folder,
    // which "Restore backup" puts back).
    if (selected.length === 0 && trigger !== 'marketplace') {
      const logEntry = {
        from,
        to,
        at: now,
        by,
        trigger,
        result: 'stamped',
        migrations: [],
        steps: [],
        warnings: [],
        changes: { values: 0, actions: 0, apps: 0 }
      };
      return {
        ...base,
        logEntry,
        after: {
          ...withoutState(instance),
          definitionVersion: to,
          updatedAt: now,
          migrationLog: appendLog(instance.migrationLog, logEntry)
        }
      };
    }
    const snapshot = await this._snapshot({
      instance,
      definitionId: definition.id,
      currentEntry,
      boundApps,
      by,
      trigger,
      manifest
    });
    const plan = planMigration({
      instance,
      apps: boundApps.map(app => ({ path: app.path, app: app.data })),
      definition,
      from,
      to
    });
    let reason = null;
    let errors = [];
    if (!plan.ok) {
      reason = describeCollisions(plan.collisions);
    } else {
      errors = validateMigrationResult({
        before: instance,
        after: plan.instance,
        apps: plan.apps,
        definition,
        dynamicActions: hasDynamicActions(definition)
      });
      if (errors.length > 0) {
        reason = `the migrated installation does not fit ${definition.id} ${to}: ${errors.map(e => e.message).join('; ')}`;
      }
    }
    const logEntry = {
      from,
      to,
      at: now,
      by,
      trigger,
      result: reason ? 'failed' : selected.length > 0 ? 'migrated' : 'stamped',
      migrations: plan.migrations,
      steps: plan.steps,
      warnings: plan.warnings,
      changes: plan.summary,
      ...(reason ? { reason: reason.slice(0, 4000) } : {}),
      backup: snapshot.id
    };
    if (reason) {
      return {
        ...base,
        snapshot,
        plan,
        errors,
        reason,
        failed: true,
        logEntry,
        after: {
          ...instance,
          status: 'migrationFailed',
          statusReason: reason.slice(0, 4000),
          migrationLog: appendLog(instance.migrationLog, logEntry)
        }
      };
    }
    const appWrites = plan.apps
      .filter(app => app.changed)
      .map(app => {
        const original = boundApps.find(candidate => candidate.path === app.path);
        const keys = this._rewritableKeys(original?.data, instance);
        return {
          path: app.path,
          bindings: Object.fromEntries(keys.map(key => [key, clone(app.app.integrations[key])]))
        };
      });
    return {
      ...base,
      snapshot,
      plan,
      logEntry,
      appWrites,
      after: {
        ...withoutState(plan.instance),
        updatedAt: now,
        migrationLog: appendLog(instance.migrationLog, logEntry)
      }
    };
  }

  /**
   * Back an installation up before a run. The definition folder is copied
   * only for a marketplace definition whose folder still is the version the
   * installation was written for (the pre-update package).
   */
  async _snapshot({
    instance,
    definitionId,
    currentEntry,
    boundApps,
    by,
    trigger,
    manifest,
    kind = 'pre-migration',
    representedVersion = instance.definitionVersion
  }) {
    const integrations = await this.store.readJson(INTEGRATIONS_FILE);
    const manifestData = await this.store.readJson(INSTALLATIONS_MANIFEST);
    const entryKey = manifestKeyOf(definitionId);
    const definitionFolder =
      currentEntry?.source === 'installed' &&
      currentEntry.definition?.version === representedVersion
        ? {
            folder: definitionIdToDirName(definitionId),
            sourceDir: currentEntry.dir,
            version: currentEntry.definition.version
          }
        : null;
    return backups.createSnapshot({
      instanceId: instance.id,
      definitionId,
      representedVersion,
      kind,
      createdBy: by,
      trigger,
      now: this._now(),
      integrations: integrations || { installed: [] },
      apps: boundApps
        .map(app => ({
          path: app.path,
          data: app.data,
          bindingKeys: this._rewritableKeys(app.data, instance)
        }))
        .filter(app => app.bindingKeys.length > 0),
      installations:
        manifestData && (manifest || manifestData.installations?.[entryKey])
          ? { data: manifestData, entryKey }
          : null,
      definition: definitionFolder
    });
  }

  /** Keep the state at every migration boundary a run passed (best effort, after the commit). */
  async _writeBoundarySnapshots(unit, { by, trigger }) {
    for (const boundary of unit.plan?.boundaries || []) {
      try {
        const integrations = (await this.store.readJson(INTEGRATIONS_FILE)) || { installed: [] };
        integrations.installed = (integrations.installed || []).map(inst =>
          inst.id === unit.instanceId ? withoutState(boundary.instance) : inst
        );
        await backups.createSnapshot({
          instanceId: unit.instanceId,
          definitionId: unit.definitionId,
          representedVersion: boundary.version,
          kind: 'boundary',
          createdBy: by,
          trigger,
          now: this._now(),
          integrations,
          apps: boundary.apps
            .map(app => ({
              path: app.path,
              data: app.app,
              bindingKeys: this._rewritableKeys(app.app, unit.before)
            }))
            .filter(app => app.bindingKeys.length > 0)
        });
      } catch (error) {
        logger.warn('Could not keep the backup of a migration boundary', {
          component: COMPONENT,
          instanceId: unit.instanceId,
          version: boundary.version,
          error: error.message
        });
      }
    }
  }

  // --- The staged commit ---------------------------------------------------

  /**
   * Write installations, apps, the marketplace manifest entry and (for a
   * marketplace update) the definition folder together, or not at all.
   *
   * @param {object} input
   * @param {Array<object>} input.units - prepared units (each with a backup and a lease)
   * @param {object|null} [input.definitionSwap] - a staged definition folder to move in
   * @param {{ entryKey: string, patch: object }|null} [input.manifest] - the manifest entry to update
   * @param {string} [input.trigger]
   */
  async _commit({ units, definitionSwap = null, manifest = null, trigger }) {
    const primary = units.find(unit => unit.snapshot)?.snapshot;
    if (!primary) throw new Error('A commit needs a backup to stage in');

    // The results, computed from the files as they are now: only the
    // entries and binding keys of these installations change.
    const config = await this._readIntegrations();
    for (const unit of units) {
      const index = config.installed.findIndex(inst => inst.id === unit.instanceId);
      if (index < 0 || canonicalJson(config.installed[index]) !== canonicalJson(unit.before)) {
        throw new IntegrationError(
          `"${unit.instanceId}" changed while it was being migrated; run the migration again`,
          { status: 409, code: 'MIGRATION_CONFLICT' }
        );
      }
      config.installed[index] = unit.after;
    }
    const validated = validateIntegrationsConfig(config);
    if (!validated.success) {
      throw new IntegrationError('The migrated integrations configuration is invalid', {
        status: 500,
        code: 'INVALID_CONFIG',
        details: validated.errors
      });
    }
    const appResults = new Map();
    for (const unit of units) {
      for (const write of unit.appWrites || []) {
        const current = appResults.get(write.path) ?? (await this.store.readJson(write.path));
        if (!current) continue;
        current.integrations = { ...(current.integrations || {}), ...clone(write.bindings) };
        appResults.set(write.path, current);
      }
    }
    let manifestResult = null;
    if (manifest) {
      manifestResult = (await this.store.readJson(INSTALLATIONS_MANIFEST)) || {
        installations: {}
      };
      manifestResult.installations ??= {};
      manifestResult.installations[manifest.entryKey] = {
        ...(manifestResult.installations[manifest.entryKey] || {}),
        ...manifest.patch
      };
    }

    // 1. Stage.
    const targets = [INTEGRATIONS_FILE];
    await backups.stageJson(primary, INTEGRATIONS_FILE, validated.data);
    for (const [relPath, data] of appResults) {
      await backups.stageJson(primary, relPath, data);
      targets.push(relPath);
    }
    if (manifestResult) {
      await backups.stageJson(primary, INSTALLATIONS_MANIFEST, manifestResult);
      targets.push(INSTALLATIONS_MANIFEST);
    }

    // 2. Markers, carrying the fencing token of each installation's lease.
    const startedAt = this._now().toISOString();
    for (const unit of units) {
      await backups.writeMarker(unit.snapshot, {
        instanceId: unit.instanceId,
        definitionId: unit.definitionId,
        lock: migrationLockName(unit.instanceId),
        token: unit.lease?.token ?? null,
        from: unit.from,
        to: unit.to,
        trigger: trigger || null,
        startedAt,
        finished: false,
        staging: primary.id,
        targets,
        manifestEntry: manifest?.entryKey || null,
        definition: definitionSwap
          ? { id: definitionSwap.id, folder: definitionIdToDirName(definitionSwap.id), swap: true }
          : null
      });
    }

    // 3. Fencing: every holder must still hold its lease before anything moves.
    for (const unit of units) {
      if (await unit.lease.isCurrent()) continue;
      for (const other of units) await backups.removeMarker(other.snapshot);
      await backups.removeStaging(primary);
      throw new IntegrationError(
        `The migration lock of "${unit.instanceId}" was taken over while the migration ran; its results were discarded`,
        { status: 409, code: 'MIGRATION_LOCK_LOST' }
      );
    }

    // 4. Move into place.
    let previous = null;
    try {
      if (definitionSwap) {
        ({ previous } = await this.registry.commitStaged(definitionSwap, { keepPrevious: true }));
      }
      await this.store.writeJson(
        INTEGRATIONS_FILE,
        await backups.readStagedJson(primary, INTEGRATIONS_FILE)
      );
      for (const relPath of appResults.keys()) {
        await this.store.writeJson(relPath, await backups.readStagedJson(primary, relPath));
      }
      if (manifestResult) {
        await this.store.writeJson(
          INSTALLATIONS_MANIFEST,
          await backups.readStagedJson(primary, INSTALLATIONS_MANIFEST)
        );
      }
    } catch (error) {
      logger.error('Integration migration commit failed; rolling back from the backup', {
        component: COMPONENT,
        instances: units.map(unit => unit.instanceId),
        error: error.message
      });
      for (const unit of units) {
        await this._rollbackUnit(unit.snapshot, {
          instanceId: unit.instanceId,
          manifestEntry: manifest?.entryKey || null,
          restoreDefinition: false,
          reason: `commit failed: ${error.message}`
        }).catch(rollbackError =>
          logger.error('Rollback of an integration migration failed', {
            component: COMPONENT,
            instanceId: unit.instanceId,
            error: rollbackError.message
          })
        );
      }
      if (definitionSwap) {
        await this.registry.restorePrevious(definitionSwap, previous).catch(restoreError =>
          logger.error('Could not put the previous integration definition folder back', {
            component: COMPONENT,
            definitionId: definitionSwap.id,
            error: restoreError.message
          })
        );
      }
      await backups.removeStaging(primary).catch(() => {});
      throw error;
    }

    // 5. Finalise.
    const finishedAt = this._now().toISOString();
    for (const unit of units) {
      const marker = await backups.readMarker(unit.snapshot);
      await backups.writeMarker(unit.snapshot, { ...marker, finished: true, finishedAt });
    }
    await backups.removeStaging(primary);
    if (definitionSwap) await this.registry.dropPrevious(definitionSwap.id, previous);
  }

  /** Write installation entries (a failed mark, a stamp, an adopt): one file, no backup needed. */
  async _writeEntries(entries) {
    const config = await this._readIntegrations();
    for (const entry of entries) {
      const index = config.installed.findIndex(inst => inst.id === entry.id);
      if (index < 0) continue;
      config.installed[index] = entry;
    }
    const validated = validateIntegrationsConfig(config);
    if (!validated.success) {
      throw new IntegrationError('Invalid integrations configuration', {
        status: 500,
        code: 'INVALID_CONFIG',
        details: validated.errors
      });
    }
    await this.store.writeJson(INTEGRATIONS_FILE, validated.data);
  }

  // --- Rollback and recovery -----------------------------------------------

  /**
   * Put back what a backup holds for one installation: its entry in
   * `integrations.json` (its migration log is kept and gets an entry), the
   * binding keys of its apps, the marketplace manifest entry (when named)
   * and the definition folder (when asked and held). Finalises an open
   * marker as rolled back.
   */
  async _rollbackUnit(
    snapshot,
    { instanceId, manifestEntry = null, restoreDefinition = false, reason, by = 'system' }
  ) {
    const kept = await backups.readSnapshotJson(snapshot, INTEGRATIONS_FILE);
    const keptEntry = (kept?.installed || []).find(inst => inst.id === instanceId) || null;
    if (restoreDefinition) {
      const dir = await backups.snapshotDefinitionDir(snapshot);
      if (dir) {
        const staged = await this.registry.stageCopy(snapshot.manifest.definitionId, dir);
        await this.registry.commitStaged(staged);
      }
    }
    const config = await this._readIntegrations();
    const index = config.installed.findIndex(inst => inst.id === instanceId);
    const current = index >= 0 ? config.installed[index] : null;
    if (keptEntry) {
      const logEntry = {
        from: current?.definitionVersion || null,
        to: keptEntry.definitionVersion || snapshot.manifest.representedVersion,
        at: this._now().toISOString(),
        by,
        trigger: 'recovery',
        result: 'rolledBack',
        migrations: [],
        steps: [],
        warnings: [],
        reason: String(reason || 'interrupted commit rolled back').slice(0, 4000),
        backup: snapshot.id
      };
      const restored = {
        ...keptEntry,
        migrationLog: appendLog(current?.migrationLog ?? keptEntry.migrationLog, logEntry)
      };
      if (index >= 0) config.installed[index] = restored;
      else config.installed.push(restored);
      const validated = validateIntegrationsConfig(config);
      if (validated.success) await this.store.writeJson(INTEGRATIONS_FILE, validated.data);
    }
    await this._restoreAppBindings(snapshot);
    if (manifestEntry) await this._restoreManifestEntry(snapshot, manifestEntry);
    const marker = await backups.readMarker(snapshot);
    if (marker && marker.finished !== true) {
      await backups.writeMarker(snapshot, {
        ...marker,
        finished: true,
        rolledBack: true,
        rolledBackAt: this._now().toISOString(),
        reason: String(reason || '').slice(0, 2000)
      });
    }
    await backups.removeStaging(snapshot).catch(() => {});
  }

  /** Restore the binding keys a backup kept, app by app; other changes to the apps stay. */
  async _restoreAppBindings(snapshot) {
    for (const file of backups.snapshotApps(snapshot)) {
      const kept = await backups.readSnapshotJson(snapshot, file.path);
      const current = await this.store.readJson(file.path);
      if (!kept || !current) continue;
      let changed = false;
      const integrations = { ...(current.integrations || {}) };
      for (const key of file.bindingKeys || []) {
        const keptBinding = kept.integrations?.[key];
        if (canonicalJson(integrations[key]) === canonicalJson(keptBinding)) continue;
        if (keptBinding === undefined) delete integrations[key];
        else integrations[key] = clone(keptBinding);
        changed = true;
      }
      if (changed) await this.store.writeJson(file.path, { ...current, integrations });
    }
  }

  /** Restore one entry of the marketplace manifest from a backup. */
  async _restoreManifestEntry(snapshot, entryKey) {
    const file = backups.snapshotFile(snapshot, 'marketplace-manifest');
    if (!file) return;
    const kept = await backups.readSnapshotJson(snapshot, file.path);
    const current = (await this.store.readJson(INSTALLATIONS_MANIFEST)) || { installations: {} };
    current.installations ??= {};
    const keptEntry = kept?.installations?.[entryKey];
    if (canonicalJson(current.installations[entryKey]) === canonicalJson(keptEntry)) return;
    if (keptEntry === undefined) delete current.installations[entryKey];
    else current.installations[entryKey] = clone(keptEntry);
    await this.store.writeJson(INSTALLATIONS_MANIFEST, current);
  }

  /**
   * Roll back every commit that was interrupted (a marker without its
   * finished flag): the installation, its apps, the manifest entry and, when
   * the commit swapped it, the definition folder go back to the backup. Runs
   * at the server start before anything loads, and under an installation's
   * lock before each run on it.
   *
   * @param {{ instanceId?: string }} [filter]
   * @returns {Promise<number>} how many commits were rolled back
   */
  async recoverInterruptedCommits({ instanceId } = {}) {
    if (instanceId) return this._recoverLocked(instanceId);
    let count = 0;
    for (const { snapshot, marker } of await backups.listUnfinishedCommits()) {
      count += await this._recoverOne(snapshot, marker);
    }
    return count;
  }

  async _recoverLocked(instanceId) {
    let count = 0;
    for (const { snapshot, marker } of await backups.listUnfinishedCommits({ instanceId })) {
      count += await this._recoverOne(snapshot, marker);
    }
    return count;
  }

  async _recoverOne(snapshot, marker) {
    try {
      logger.warn('Rolling back an interrupted integration migration', {
        component: COMPONENT,
        instanceId: marker.instanceId,
        backup: snapshot.id,
        from: marker.from,
        to: marker.to
      });
      await this._rollbackUnit(snapshot, {
        instanceId: snapshot.manifest.instanceId,
        manifestEntry: marker.manifestEntry || null,
        restoreDefinition: Boolean(marker.definition?.swap),
        reason: `the migration ${marker.from} → ${marker.to} was interrupted and rolled back`
      });
      return 1;
    } catch (error) {
      logger.error('Could not roll back an interrupted integration migration', {
        component: COMPONENT,
        backup: snapshot.id,
        error: error.message
      });
      return 0;
    }
  }

  // --- Restore and adopt ---------------------------------------------------

  /**
   * Restore a backup (`_restore`): for `needsReview` the newest backup of the
   * loaded definition's version, for `migrationFailed` the newest backup
   * taken before a migration, or the one named. The installation entry is
   * replaced by the backup's (its log is kept), the binding keys of its apps
   * and the manifest entry are put back, and the definition folder too when
   * the backup holds one of another version than the loaded one.
   *
   * @param {string} instanceId
   * @param {{ backup?: string, by?: string, notify?: boolean }} [options]
   * @throws {IntegrationError} `NOT_FOUND`, `MIGRATION_LOCKED`, `RESTORE_NOT_APPLICABLE`,
   *   `BACKUP_NOT_FOUND`, `DEFINITION_MISSING`
   */
  async restore(instanceId, { backup, by = 'admin', notify = true } = {}) {
    await this.registry.ensureLoaded();
    const outcome = await this._withInstanceLock(instanceId, lease =>
      this.service._serialize(() => this._restoreLocked(instanceId, { backup, by, lease }))
    );
    if (notify)
      await this._afterCommit([outcome.unit], { definitionChanged: outcome.definitionChanged });
    if (outcome.definitionChanged) {
      await this.reconcileDowngrades(outcome.unit.definitionId, { by, notify });
    }
    return {
      instance: outcome.unit.after,
      logEntry: outcome.unit.logEntry,
      backup: outcome.backup
    };
  }

  async _restoreLocked(instanceId, { backup, by, lease, automatic = false }) {
    await this._recoverLocked(instanceId);
    const config = await this._readIntegrations();
    const instance = config.installed.find(inst => inst.id === instanceId);
    if (!instance) {
      throw new IntegrationError('Integration not found', { status: 404, code: 'NOT_FOUND' });
    }
    const entry = this.registry.get(instance.definition);
    const state = installationMigrationState(instance, entry);
    if (!automatic && !['migrationFailed', 'needsReview'].includes(state.status)) {
      throw new IntegrationError(
        `"${instanceId}" has nothing to restore: a backup is restored for a failed migration or an installation that needs a review`,
        { status: 409, code: 'RESTORE_NOT_APPLICABLE' }
      );
    }
    let snapshot = null;
    if (backup) {
      const named = await backups.openSnapshot(String(backup));
      if (named && named.manifest.instanceId === instanceId && named.manifest.kind !== 'journal') {
        snapshot = named;
      }
    } else {
      const snapshots = (await backups.listSnapshots({ instanceId })).filter(
        s => s.manifest.kind !== 'journal'
      );
      snapshot = this._defaultBackup(state, entry, snapshots);
    }
    if (!snapshot) {
      throw new IntegrationError(
        backup
          ? `Backup "${backup}" of "${instanceId}" was not found`
          : `"${instanceId}" has no backup to restore for its state`,
        { status: 404, code: 'BACKUP_NOT_FOUND' }
      );
    }
    const kept = await backups.readSnapshotJson(snapshot, INTEGRATIONS_FILE);
    const keptEntry = (kept?.installed || []).find(inst => inst.id === instanceId);
    if (!keptEntry) {
      throw new IntegrationError(`Backup "${snapshot.id}" holds no entry of "${instanceId}"`, {
        status: 422,
        code: 'BACKUP_INVALID'
      });
    }
    const representedVersion = snapshot.manifest.representedVersion;
    const definitionDir = await backups.snapshotDefinitionDir(snapshot);
    const restoreDefinition =
      Boolean(definitionDir) && entry?.definition?.version !== representedVersion;
    if (!entry && !restoreDefinition) {
      throw new IntegrationError(
        `The definition "${instance.definition}" of "${instanceId}" is not installed and the backup holds none`,
        { status: 422, code: 'DEFINITION_MISSING' }
      );
    }

    // A journal of the current state, so a crash while restoring rolls back
    // to it; offered as a backup itself when the current version is valid.
    const allApps = await this._readApps();
    const boundApps = this._boundApps(allApps, instance, entry?.definition);
    const currentVersionValid = isStrictSemver(instance.definitionVersion);
    const journal = await this._snapshot({
      instance,
      definitionId: instance.definition,
      currentEntry: entry,
      boundApps,
      by,
      trigger: automatic ? 'downgrade' : 'restore',
      manifest: restoreDefinition,
      kind: currentVersionValid ? 'pre-restore' : 'journal',
      representedVersion: currentVersionValid ? instance.definitionVersion : representedVersion
    });

    const now = this._now().toISOString();
    const logEntry = {
      from: instance.definitionVersion || null,
      to: representedVersion,
      at: now,
      by,
      trigger: automatic ? 'downgrade' : 'restore',
      result: 'restored',
      migrations: [],
      steps: [],
      warnings: [],
      reason: `restored backup ${snapshot.id}${restoreDefinition ? ' with its definition folder' : ''}`,
      backup: snapshot.id
    };
    const after = {
      ...withoutState(keptEntry),
      definitionVersion: keptEntry.definitionVersion || representedVersion,
      updatedAt: now,
      migrationLog: appendLog(instance.migrationLog, logEntry)
    };
    const appWrites = [];
    for (const file of backups.snapshotApps(snapshot)) {
      const keptApp = await backups.readSnapshotJson(snapshot, file.path);
      if (!keptApp) continue;
      appWrites.push({
        path: file.path,
        bindings: Object.fromEntries(
          (file.bindingKeys || [])
            .filter(key => keptApp.integrations?.[key] !== undefined)
            .map(key => [key, clone(keptApp.integrations[key])])
        )
      });
    }
    let definitionSwap = null;
    let manifest = null;
    if (restoreDefinition) {
      definitionSwap = await this.registry.stageCopy(snapshot.manifest.definitionId, definitionDir);
      const manifestFile = backups.snapshotFile(snapshot, 'marketplace-manifest');
      const keptManifest = manifestFile
        ? await backups.readSnapshotJson(snapshot, manifestFile.path)
        : null;
      const entryKey = manifestKeyOf(snapshot.manifest.definitionId);
      const keptManifestEntry = keptManifest?.installations?.[entryKey];
      if (keptManifestEntry) manifest = { entryKey, patch: clone(keptManifestEntry) };
    }
    const unit = {
      instanceId,
      definitionId: instance.definition,
      before: instance,
      after,
      lease,
      from: instance.definitionVersion || null,
      to: representedVersion,
      appWrites,
      snapshot: journal,
      logEntry
    };
    try {
      await this._commit({ units: [unit], definitionSwap, manifest, trigger: 'restore' });
    } catch (error) {
      if (definitionSwap) await this.registry.discardStaged(definitionSwap).catch(() => {});
      throw error;
    }
    return { unit, backup: backups.snapshotView(snapshot), definitionChanged: restoreDefinition };
  }

  /**
   * Adopt the loaded definition's version for an installation that needs a
   * review (`_adopt`): its stored values, policy and app bindings are
   * validated like the result of a migration; only then is
   * `definitionVersion` stamped and the state cleared.
   *
   * @param {string} instanceId
   * @param {{ by?: string, notify?: boolean }} [options]
   * @throws {IntegrationError} `NOT_FOUND`, `MIGRATION_LOCKED`, `ADOPT_NOT_APPLICABLE`,
   *   `DEFINITION_MISSING`, `INCOMPATIBLE_DEFINITION`, `ADOPT_INVALID` (422, `details` lists the problems)
   */
  async adopt(instanceId, { by = 'admin', notify = true } = {}) {
    await this.registry.ensureLoaded();
    const unit = await this._withInstanceLock(instanceId, () =>
      this.service._serialize(async () => {
        await this._recoverLocked(instanceId);
        const config = await this._readIntegrations();
        const instance = config.installed.find(inst => inst.id === instanceId);
        if (!instance) {
          throw new IntegrationError('Integration not found', { status: 404, code: 'NOT_FOUND' });
        }
        const entry = this.registry.get(instance.definition);
        this._assertMigratable(instance, entry);
        const state = installationMigrationState(instance, entry);
        if (state.status !== 'needsReview') {
          throw new IntegrationError(
            `"${instanceId}" does not need a review; adopting a version is offered for that state only`,
            { status: 409, code: 'ADOPT_NOT_APPLICABLE' }
          );
        }
        const definition = entry.definition;
        const allApps = await this._readApps();
        const apps = this._boundApps(allApps, instance, definition);
        const errors = validateMigrationResult({
          before: instance,
          after: instance,
          apps: apps.map(app => ({ path: app.path, app: app.data })),
          definition,
          dynamicActions: hasDynamicActions(definition)
        });
        if (errors.length > 0) {
          throw new IntegrationError(
            `The stored values of "${instanceId}" do not fit ${definition.id} ${definition.version}`,
            { status: 422, code: 'ADOPT_INVALID', details: errors }
          );
        }
        const now = this._now().toISOString();
        const logEntry = {
          from: isStrictSemver(instance.definitionVersion) ? instance.definitionVersion : null,
          to: definition.version,
          at: now,
          by,
          trigger: 'adopt',
          result: 'adopted',
          migrations: [],
          steps: [],
          warnings: [],
          reason: state.statusReason ? String(state.statusReason).slice(0, 4000) : undefined
        };
        const after = {
          ...withoutState(instance),
          definitionVersion: definition.version,
          updatedAt: now,
          migrationLog: appendLog(instance.migrationLog, logEntry)
        };
        await this._writeEntries([after]);
        return { instanceId, definitionId: definition.id, before: instance, after, logEntry };
      })
    );
    if (notify) await this._afterCommit([unit], {});
    return { instance: unit.after, logEntry: unit.logEntry };
  }

  /**
   * After a definition went back to an older version (a restored folder, an
   * iHub downgrade): every installation of it that is now ahead of the
   * definition gets the newest backup of the definition's version restored,
   * when one exists; the others stay `needsReview`.
   *
   * @param {string} definitionId
   * @param {{ by?: string, notify?: boolean, lockOptions?: object }} [options]
   * @returns {Promise<Array<{ id: string, restored: boolean, backup?: string, reason?: string }>>}
   */
  async reconcileDowngrades(definitionId, { by = 'system', notify = true, lockOptions } = {}) {
    await this.registry.reload();
    const entry = this.registry.get(definitionId);
    if (!entry || entry.status === 'incompatible') return [];
    const results = [];
    const config = await this._readIntegrations();
    for (const instance of config.installed.filter(inst => inst.definition === definitionId)) {
      const state = installationMigrationState(instance, entry);
      if (!state.downgrade) continue;
      results.push(await this._autoRestore(instance.id, { by, notify, lockOptions }));
    }
    return results;
  }

  async _autoRestore(instanceId, { by, notify, lockOptions = LOCK_OPTIONS }) {
    try {
      const outcome = await this._withInstanceLock(
        instanceId,
        lease =>
          this.service._serialize(async () => {
            const config = await this._readIntegrations();
            const instance = config.installed.find(inst => inst.id === instanceId);
            const entry = instance ? this.registry.get(instance.definition) : null;
            const state = instance ? installationMigrationState(instance, entry) : null;
            if (!state?.downgrade) return null;
            const snapshots = await backups.listSnapshots({ instanceId });
            const match = snapshots.find(
              s =>
                s.manifest.kind !== 'journal' &&
                s.manifest.representedVersion === entry.definition.version
            );
            if (!match) return null;
            return this._restoreLocked(instanceId, {
              backup: match.id,
              by,
              lease,
              automatic: true
            });
          }),
        lockOptions
      );
      if (!outcome) {
        return { id: instanceId, restored: false, reason: 'no backup of the loaded version' };
      }
      if (notify) await this._afterCommit([outcome.unit], {});
      return { id: instanceId, restored: true, backup: outcome.backup.id };
    } catch (error) {
      logger.warn('Could not restore an installation after its definition went back', {
        component: COMPONENT,
        instanceId,
        error: error.message
      });
      return { id: instanceId, restored: false, reason: error.message };
    }
  }

  // --- Marketplace update --------------------------------------------------

  /**
   * Update an installed marketplace definition together with its
   * installations (concept §3 trigger 1): the new folder is staged, every
   * installation of the definition is planned against the staged definition
   * under its lock, and the folder moves in only in the same commit as the
   * migrated installations, their apps and the manifest entry. An
   * installation whose migration fails is marked `migrationFailed` (its
   * values untouched) in that commit; the others migrate. A failing commit
   * leaves the previous folder and every value as it was.
   *
   * @param {object} input
   * @param {string} input.definitionId
   * @param {Record<string, string|object>} input.files - the package files
   * @param {string} input.manifestKey - `integration:<folder>`
   * @param {object} input.manifestPatch - fields of the manifest entry to set
   * @param {string} [input.by]
   * @param {boolean} [input.notify=true]
   * @returns {Promise<{ installations: Array<object> }>}
   */
  async applyDefinitionUpdate({
    definitionId,
    files,
    manifestKey,
    manifestPatch,
    by = 'admin',
    notify = true
  }) {
    await this.registry.ensureLoaded();
    const staged = await this.registry.stageInstalled(definitionId, files);
    let committed = false;
    try {
      const config = await this._readIntegrations();
      const ids = config.installed
        .filter(inst => inst.definition === definitionId)
        .map(inst => inst.id);
      if (ids.length === 0) {
        await this.registry.commitStaged(staged);
        committed = true;
        const manifestData = (await this.store.readJson(INSTALLATIONS_MANIFEST)) || {
          installations: {}
        };
        manifestData.installations ??= {};
        manifestData.installations[manifestKey] = {
          ...(manifestData.installations[manifestKey] || {}),
          ...manifestPatch
        };
        await this.store.writeJson(INSTALLATIONS_MANIFEST, manifestData);
        if (notify) await this._afterCommit([], { definitionChanged: true, definitionId });
        return { installations: [] };
      }
      const outcome = await this._withInstanceLocks(ids, leases =>
        this.service._serialize(() =>
          this._updateLocked({ definitionId, staged, leases, manifestKey, manifestPatch, by })
        )
      );
      committed = true;
      if (notify) {
        await this._afterCommit(outcome.units, { definitionChanged: true, definitionId });
      }
      return { installations: outcome.results };
    } finally {
      if (!committed) await this.registry.discardStaged(staged).catch(() => {});
    }
  }

  async _updateLocked({ definitionId, staged, leases, manifestKey, manifestPatch, by }) {
    for (const id of leases.keys()) await this._recoverLocked(id);
    const config = await this._readIntegrations();
    const currentEntry = this.registry.get(definitionId);
    const definition = staged.definition;
    const allApps = await this._readApps();
    const units = [];
    const results = [];
    for (const instance of config.installed.filter(inst => inst.definition === definitionId)) {
      const lease = leases.get(instance.id);
      const from = instance.definitionVersion;
      if (!lease) {
        results.push({
          id: instance.id,
          result: 'skipped',
          reason: 'installed while the update ran'
        });
        continue;
      }
      if (!isStrictSemver(from)) {
        results.push({
          id: instance.id,
          result: 'skipped',
          reason: 'needs a review (no valid definitionVersion); not migrated'
        });
        continue;
      }
      if (!semver.gt(definition.version, from)) {
        results.push({ id: instance.id, result: 'skipped', reason: `already at ${from}` });
        continue;
      }
      const unit = await this._prepareUnit({
        instance,
        definition,
        currentEntry,
        allApps,
        by,
        trigger: 'marketplace',
        lease,
        manifest: true
      });
      units.push(unit);
      results.push({
        id: instance.id,
        result: unit.logEntry.result,
        from,
        to: definition.version,
        logEntry: unit.logEntry,
        status: unit.after.status || null,
        statusReason: unit.after.statusReason || null,
        summary: unit.plan?.summary || null,
        warnings: unit.plan?.warnings || []
      });
    }
    if (units.length === 0) {
      await this.registry.commitStaged(staged);
      const manifestData = (await this.store.readJson(INSTALLATIONS_MANIFEST)) || {
        installations: {}
      };
      manifestData.installations ??= {};
      manifestData.installations[manifestKey] = {
        ...(manifestData.installations[manifestKey] || {}),
        ...manifestPatch
      };
      await this.store.writeJson(INSTALLATIONS_MANIFEST, manifestData);
      return { units, results };
    }
    await this._commit({
      units,
      definitionSwap: staged,
      manifest: { entryKey: manifestKey, patch: manifestPatch },
      trigger: 'marketplace'
    });
    for (const unit of units) {
      if (!unit.failed) await this._writeBoundarySnapshots(unit, { by, trigger: 'marketplace' });
    }
    return { units, results };
  }

  // --- After a commit ------------------------------------------------------

  /**
   * Refresh what derives from the written files, in this worker and (by
   * the cache announcements) in the others: the registry when the
   * definition changed, the caches of `integrations.json`, the apps and the
   * marketplace manifest, the OpenAPI schemas and connector hooks of each
   * installation (`InstalledIntegrationService._afterChange`, which also
   * re-syncs the scope providers), and the adapters' view of the definition.
   */
  async _afterCommit(units, { definitionChanged = false, definitionId = null } = {}) {
    try {
      if (definitionChanged) {
        await this.registry.reload();
        this.registry._announce?.();
      }
      const { default: configCache } = await import('../../../configCache.js');
      await configCache.refreshCacheEntry?.(INTEGRATIONS_FILE);
      await configCache.refreshAppsCache?.();
      await configCache.refreshInstallationsCache?.();
      for (const unit of units.filter(Boolean)) {
        await this.service._afterChange(unit.instanceId, {
          before: unit.before,
          after: unit.after
        });
      }
      const ids = new Set(units.filter(Boolean).map(unit => unit.definitionId));
      if (definitionId) ids.add(definitionId);
      if (definitionChanged && ids.size > 0) {
        const { notifyDefinitionsChanged } = await import('../protocols/index.js');
        await notifyDefinitionsChanged({ definitionIds: [...ids] });
      }
    } catch (error) {
      logger.warn('Integration migration committed, but refreshing what derives from it failed', {
        component: COMPONENT,
        error: error.message
      });
    }
  }

  // --- Server start --------------------------------------------------------

  /**
   * What runs at the server start, after the numbered config migrations and
   * before anything loads the installations: roll back interrupted commits,
   * migrate installations of built-in definitions an iHub release updated,
   * and restore the matching backup of installations whose definition went
   * back (an iHub downgrade). Installations of marketplace definitions are
   * migrated by the marketplace update or by an admin; incompatible
   * definitions never migrate. Each installation on its own: one failing is
   * logged and leaves the others alone.
   *
   * @param {{ by?: string }} [options]
   * @returns {Promise<{ recovered: number, results: Array<object> }>}
   */
  async runStartup({ by = 'system' } = {}) {
    const recovered = await this.recoverInterruptedCommits();
    await this.registry.reload();
    let config;
    try {
      config = await this._readIntegrations();
    } catch (error) {
      logger.error('Integration migrations skipped: integrations.json is invalid', {
        component: COMPONENT,
        error: error.message
      });
      return { recovered, results: [] };
    }
    const results = [];
    for (const instance of config.installed) {
      const entry = this.registry.get(instance.definition);
      if (!entry || entry.status === 'incompatible') continue;
      const state = installationMigrationState(instance, entry);
      if (state.status === 'migrationPending' && entry.source === 'shipped') {
        try {
          const outcome = await this.migrate(instance.id, {
            by,
            trigger: 'startup',
            lockOptions: STARTUP_LOCK_OPTIONS,
            notify: false
          });
          results.push({ id: instance.id, result: outcome.result });
          logger.info('Migrated an installation to its built-in definition', {
            component: COMPONENT,
            instanceId: instance.id,
            from: state.from,
            to: state.to,
            result: outcome.result
          });
        } catch (error) {
          results.push({ id: instance.id, result: 'failed', reason: error.message });
          logger.error('Migration of an installation to its built-in definition failed', {
            component: COMPONENT,
            instanceId: instance.id,
            from: state.from,
            to: state.to,
            code: error.code,
            error: error.message
          });
        }
      } else if (state.downgrade) {
        const outcome = await this._autoRestore(instance.id, {
          by,
          notify: false,
          lockOptions: STARTUP_LOCK_OPTIONS
        });
        results.push({ ...outcome, result: outcome.restored ? 'restored' : 'needsReview' });
      }
    }
    return { recovered, results };
  }
}

const definitionMigrationRunner = new DefinitionMigrationRunner();
export default definitionMigrationRunner;

/**
 * The startup trigger (`server.js`, in the cluster primary or the single
 * process, after `server/migrations` ran and before the workers load the
 * installations). Never throws: a failure is logged and the server starts;
 * the installations concerned stay pending or failed and say why.
 *
 * @returns {Promise<{ recovered: number, results: Array<object> }|null>}
 */
export async function runIntegrationStartupMigrations() {
  try {
    return await definitionMigrationRunner.runStartup();
  } catch (error) {
    logger.error('Integration definition migrations at startup failed', {
      component: COMPONENT,
      error: error.message
    });
    return null;
  }
}
