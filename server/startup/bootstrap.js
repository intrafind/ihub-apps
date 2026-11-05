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
