// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Steps both the primary and a worker take while starting: seeding and migrating
 * `contents/`, and bringing the storage provider up.
 */

import logger from '../utils/logger.js';
import { bootstrapStorage } from '../storage/bootstrap.js';
import { performInitialSetup } from '../utils/setupUtils.js';
import { runConfigMigrations } from '../migrations/runner.js';
import { beginAtRestPreparation, endAtRestPreparation } from '../storage/atRest/policy.js';

/** Log the reason, let the log transport flush, end the process. */
async function exitWith(message, error) {
  logger.error({
    component: 'Server',
    message,
    error: error?.message,
    code: error?.code,
    stack: error?.stack,
    pid: process.pid
  });
  await new Promise(resolve => setTimeout(resolve, 100));
  process.exit(1);
}

/**
 * Tell the key service where the storage provider keeps its data, when that
 * is not `contents/data`, so it never generates a new master key while that
 * directory holds encrypted data. Never throws: a missing `platform.json`
 * means a new installation and the default location.
 *
 * @returns {Promise<void>}
 */
async function registerSealedDataLocation() {
  try {
    const [{ loadJson }, { createProvider, resolveStorageConfig }, { default: tokenStorage }] =
      await Promise.all([
        import('../configLoader.js'),
        import('../storage/index.js'),
        import('../services/TokenStorageService.js')
      ]);
    const platformConfig = (await loadJson('config/platform.json')) || {};
    const { provider, config } = resolveStorageConfig(platformConfig);
    const baseDir = createProvider(provider, config).baseDir;
    if (typeof baseDir === 'string') tokenStorage.addSealedDataLocation(baseDir);
  } catch {
    // The default location is looked at in any case.
  }
}

/**
 * Seed contents/ from server/defaults and apply the versioned config
 * migrations. Runs EXACTLY ONCE per server start, before anything reads
 * config: in cluster mode the primary awaits this before forking, otherwise
 * the single process does it itself.
 *
 * Both steps mutate the same files, so they must never run concurrently.
 * Every worker used to call them independently, which raced: the losers of
 * the .migration-lock race logged "Configuration migration failed" at error
 * level, and performInitialSetup had several workers copying the same default
 * files at once. Doing it before the fork also guarantees the ordering the
 * workers actually need - migrations complete before any worker loads
 * platform.json - which a "only slot 0 does it" gate could not provide.
 */
export async function prepareContents() {
  // From here to the end of `prepareStorageEncryptionOrExit` this process is
  // the one that may read plaintext and encrypted data side by side: a
  // configuration migration that starts storage runs before the conversion.
  beginAtRestPreparation();
  await registerSealedDataLocation();
  try {
    await performInitialSetup();
  } catch (error) {
    logger.error({
      component: 'Server',
      message: 'Failed to perform initial setup',
      error: error.message,
      stack: error.stack
    });
    logger.warn({
      component: 'Server',
      message: 'Server will continue, but may not function properly without configuration files'
    });
  }

  try {
    await runConfigMigrations();
  } catch (error) {
    logger.error({
      component: 'Server',
      message: 'Configuration migration failed',
      error: error.message,
      stack: error.stack
    });
    if (error.belowBaseline) {
      // The installation is older than the migration baseline: the migrations
      // that would bring it forward are gone, so serving it would run on
      // configuration this release cannot read. The message names the release
      // to upgrade through.
      logger.error({
        component: 'Server',
        message: 'Halting startup: installation is below the migration baseline'
      });
      process.exit(1);
    }
    if (error.migrationHalt) {
      // The operator's `platform.json` `migrations.onFailure` is 'halt' (the
      // default) and a migration failed: continuing would serve traffic
      // against config the migration never finished updating. Exiting lets a
      // process manager / container orchestrator surface the failure instead
      // of the server quietly running on stale or half-migrated config.
      logger.error({
        component: 'Server',
        message: 'Halting startup: migrations.onFailure is "halt" and a migration failed'
      });
      process.exit(1);
    }
    logger.warn({
      component: 'Server',
      message: 'Server will continue, but configuration may be outdated'
    });
  }

  // Installed integrations (versioning concept §3, trigger 2): roll back a
  // definition migration a crash interrupted, then migrate the installations
  // of built-in definitions this release updated (and restore the backup of
  // a downgraded one). Here, after the numbered config migrations and before
  // any worker exists, so no worker serves a built-in definition with
  // unmigrated values and the run happens once per cluster (the primary, or
  // the single process). Never throws: an installation that cannot be
  // migrated stays pending or failed and says why under Admin → Integrations.
  try {
    const { runIntegrationStartupMigrations } =
      await import('../services/integrations/definitions/DefinitionMigrationRunner.js');
    await runIntegrationStartupMigrations();
  } catch (error) {
    logger.error({
      component: 'Server',
      message: 'Integration definition migrations could not run at startup',
      error: error.message,
      stack: error.stack
    });
  }
}

/**
 * Load the master encryption key before the storage provider starts.
 *
 * A blob backend that encrypts (`storage.blobs.provider: "s3"`) needs the key
 * at storage bootstrap: to check it against the key check object in the
 * bucket, and to open an S3 secret or a proxy URL stored as `ENC[...]`. The
 * key is read from `TOKEN_ENCRYPTION_KEY` or `contents/.encryption-key` with
 * plain `fs`, so it does not need storage itself.
 *
 * Never throws: a key that cannot be loaded is reported here and again by the
 * later key setup, and a blob backend that needs it then refuses to start.
 *
 * One case ends the process: the key is missing or unreadable while the data
 * directory holds data that was encrypted with it (`MASTER_KEY_REQUIRED`).
 * The key service generates no new key then, and starting without one would
 * serve an installation whose chats and files cannot be read.
 *
 * @returns {Promise<void>}
 */
export async function ensureEncryptionKey() {
  try {
    const { default: tokenStorageService } = await import('../services/TokenStorageService.js');
    if (!tokenStorageService.encryptionKey) await tokenStorageService.initializeEncryptionKey();
  } catch (error) {
    if (error?.code === 'MASTER_KEY_REQUIRED') {
      await exitWith(`Cannot start: ${error.message}`, error);
    }
    logger.error('Failed to load the encryption key before storage', {
      component: 'Server',
      error: error.message
    });
  }
}

/**
 * Bring the storage provider up or end the process with a clear error.
 *
 * The provider is mandatory (filesystem is the default). A broken `storage`
 * block, or a provider that cannot start, is a configuration error like an
 * invalid platform.json: refusing to start is the only outcome that does not
 * serve with state that is lost on the next restart.
 *
 * @param {Object} platformConfig - Parsed platform.json.
 * @returns {Promise<import('../storage/StorageProvider.js').StorageProvider>}
 */
export async function bootstrapStorageOrExit(platformConfig) {
  try {
    return await bootstrapStorage(platformConfig);
  } catch (error) {
    logger.error({
      component: 'Server',
      message: `Cannot start: ${error.message}`,
      error: error.message,
      stack: error.stack,
      pid: process.pid
    });
    // Give the log transport a moment to flush the line that explains the exit.
    await new Promise(resolve => setTimeout(resolve, 100));
    process.exit(1);
  }
}

/**
 * Bring the data directory in line with `storage.encryption.enabled` before
 * any worker exists, or end the process with a clear error: check the master
 * key against the stored data, and encrypt data that was stored in plaintext
 * before the switch was turned on (`storage/atRest/prepare.js`). The server
 * does not accept requests while this runs; progress is logged every 10 s.
 *
 * Call it once per start: in the cluster primary before the fork, or in the
 * single process, after `ensureEncryptionKey()` and before the storage
 * bootstrap. Interrupting it is safe; the next start continues.
 *
 * @param {Object} platformConfig - Parsed platform.json (the raw file).
 * @returns {Promise<void>}
 */
export async function prepareStorageEncryptionOrExit(platformConfig) {
  try {
    const { prepareStorageEncryption } = await import('../storage/atRest/prepare.js');
    await prepareStorageEncryption({ platformConfig });
  } catch (error) {
    await exitWith(
      `Cannot start: storage encryption could not be prepared: ${error.message}`,
      error
    );
  } finally {
    endAtRestPreparation();
  }
}
