/**
 * Configuration Migration Runner
 *
 * A Flyway-inspired versioned migration system for JSON configuration files.
 * Executes at server startup between performInitialSetup() and configCache.initialize().
 *
 * Migrations are JavaScript ES modules in server/migrations/ named V<version>__<description>.js.
 * Each migration runs exactly once, tracked in contents/.migration-history.json.
 */

import fs from 'fs/promises';
import { join } from 'path';
import { createHash } from 'crypto';
import { pathToFileURL } from 'url';
import os from 'os';
import { getRootDir } from '../pathUtils.js';
import config from '../config.js';
import { atomicWriteJSON } from '../utils/atomicWrite.js';
import logger from '../utils/logger.js';
import {
  setDefault,
  removeKey,
  renameKey,
  mergeDefaults,
  addIfMissing,
  removeById,
  transformWhere
} from './utils.js';

const HISTORY_FILE = '.migration-history.json';
const LOCK_FILE = '.migration-lock';
const LOCK_STALE_MS = 5 * 60 * 1000; // 5 minutes
const MIGRATION_FILE_PATTERN = /^V(\d{3})__(.+)\.js$/;

const DEFAULT_MIGRATION_CONFIG = {
  enabled: true,
  onFailure: 'halt',
  checksumValidation: 'warn'
};

/**
 * Scan the migrations directory for versioned migration files.
 * @param {string} migrationsDir - Absolute path to server/migrations/
 * @returns {Promise<Array<{version: string, description: string, file: string, filePath: string}>>}
 */
export async function scanMigrationFiles(migrationsDir) {
  let entries;
  try {
    entries = await fs.readdir(migrationsDir);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const migrations = [];
  for (const entry of entries) {
    const match = entry.match(MIGRATION_FILE_PATTERN);
    if (match) {
      migrations.push({
        version: match[1],
        description: match[2],
        file: entry,
        filePath: join(migrationsDir, entry)
      });
    }
  }

  migrations.sort((a, b) => a.version.localeCompare(b.version));
  return migrations;
}

/**
 * Load migration history from disk.
 * @param {string} contentsDir - Absolute path to contents/
 * @returns {Promise<{schemaVersion: string, migrations: Array}>}
 */
export async function loadHistory(contentsDir) {
  const historyPath = join(contentsDir, HISTORY_FILE);
  try {
    const data = await fs.readFile(historyPath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { schemaVersion: '1.0', migrations: [] };
    }
    throw error;
  }
}

/**
 * Save migration history to disk atomically.
 * @param {string} contentsDir
 * @param {object} history
 */
async function saveHistory(contentsDir, history) {
  await atomicWriteJSON(join(contentsDir, HISTORY_FILE), history);
}

/**
 * Compute SHA-256 checksum of a file's contents.
 * @param {string} filePath
 * @returns {Promise<string>}
 */
export async function computeChecksum(filePath) {
  const content = await fs.readFile(filePath, 'utf8');
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Validate that previously applied migrations haven't been modified.
 * @param {object} history
 * @param {Array} migrationFiles
 * @param {string} mode - 'strict', 'warn', or 'off'
 */
async function validateAppliedMigrations(history, migrationFiles, mode) {
  if (mode === 'off') return;

  const filesByVersion = new Map(migrationFiles.map(f => [f.version, f]));

  for (const entry of history.migrations) {
    if (entry.status !== 'success') continue;

    const file = filesByVersion.get(entry.version);
    if (!file) {
      // Migration file was removed from disk
      const msg = `Migration file ${entry.file} (V${entry.version}) was applied but is no longer on disk`;
      if (mode === 'strict') {
        throw new Error(msg);
      }
      logger.warn({ component: 'Migration', message: msg });
      continue;
    }

    const currentChecksum = await computeChecksum(file.filePath);
    if (currentChecksum !== entry.checksum) {
      const msg = `Checksum mismatch for ${entry.file}: expected ${entry.checksum.substring(0, 12)}..., got ${currentChecksum.substring(0, 12)}...`;
      if (mode === 'strict') {
        throw new Error(msg);
      }
      logger.warn({ component: 'Migration', message: msg });
    }
  }
}

/**
 * Create a MigrationContext object for use by migration scripts.
 * @param {string} contentsDir
 * @param {string} defaultsDir
 * @param {{version: string, description: string}} migration
 * @returns {object}
 */
function createMigrationContext(contentsDir, defaultsDir, migration) {
  return {
    // File operations (paths relative to contentsDir)
    readJson: async relativePath => {
      const data = await fs.readFile(join(contentsDir, relativePath), 'utf8');
      return JSON.parse(data);
    },
    writeJson: async (relativePath, data) => {
      await atomicWriteJSON(join(contentsDir, relativePath), data);
    },
    fileExists: async relativePath => {
      try {
        await fs.access(join(contentsDir, relativePath));
        return true;
      } catch {
        return false;
      }
    },
    deleteFile: async relativePath => {
      await fs.unlink(join(contentsDir, relativePath));
    },
    moveFile: async (from, to) => {
      await fs.rename(join(contentsDir, from), join(contentsDir, to));
    },
    listFiles: async (directory, pattern) => {
      const dirPath = join(contentsDir, directory);
      let entries;
      try {
        entries = await fs.readdir(dirPath);
      } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
      }
      if (pattern) {
        const regex = new RegExp(pattern);
        return entries.filter(e => regex.test(e));
      }
      return entries;
    },

    // Access defaults (paths relative to defaultsDir)
    readDefaultJson: async relativePath => {
      const data = await fs.readFile(join(defaultsDir, relativePath), 'utf8');
      return JSON.parse(data);
    },

    // JSON manipulation helpers
    setDefault,
    removeKey,
    renameKey,
    mergeDefaults,
    addIfMissing,
    removeById,
    transformWhere,

    // Logging (prefixed with migration version)
    log: message =>
      logger.info({
        component: 'Migration',
        message: `[V${migration.version}] ${message}`
      }),
    warn: message =>
      logger.warn({
        component: 'Migration',
        message: `[V${migration.version}] ${message}`
      }),

    // Metadata
    version: migration.version,
    description: migration.description,
    contentsDir,
    defaultsDir
  };
}

/**
 * Acquire a lock file to prevent concurrent migration runs.
 * @param {string} contentsDir
 */
async function acquireLock(contentsDir) {
  const lockPath = join(contentsDir, LOCK_FILE);
  try {
    const existing = await fs.readFile(lockPath, 'utf8');
    const lock = JSON.parse(existing);
    const age = Date.now() - new Date(lock.startedAt).getTime();

    if (age < LOCK_STALE_MS) {
      throw new Error(
        `Migration lock held by PID ${lock.pid} since ${lock.startedAt}. ` +
          `If the process is no longer running, delete ${lockPath}`
      );
    }
    logger.warn({
      component: 'Migration',
      message: `Stale migration lock detected (age: ${Math.round(age / 1000)}s), overriding`
    });
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) {
      // Re-throw if it's not a missing file or parse error, and not our own lock error
      if (error.message?.includes('Migration lock held')) throw error;
    }
  }

  const lockData = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    hostname: os.hostname()
  };
  await fs.writeFile(lockPath, JSON.stringify(lockData, null, 2));
}

/**
 * Release the migration lock file.
 * @param {string} contentsDir
 */
async function releaseLock(contentsDir) {
  try {
    await fs.unlink(join(contentsDir, LOCK_FILE));
  } catch {
    // Ignore errors during cleanup
  }
}

/**
 * Read the migration configuration from platform.json.
 * Uses raw fs.readFile because this runs before configCache.initialize().
 * @param {string} contentsDir
 * @returns {Promise<object>}
 */
async function loadMigrationConfig(contentsDir) {
  try {
    const platformPath = join(contentsDir, 'config', 'platform.json');
    const data = await fs.readFile(platformPath, 'utf8');
    const platform = JSON.parse(data);
    return { ...DEFAULT_MIGRATION_CONFIG, ...platform.migrations };
  } catch {
    return { ...DEFAULT_MIGRATION_CONFIG };
  }
}

/**
 * Run all pending configuration migrations.
 * This is the main entry point, called from server.js after performInitialSetup().
 */
export async function runConfigMigrations() {
  const rootDir = getRootDir();
  const contentsDir = join(rootDir, config.CONTENTS_DIR);
  const migrationsDir = join(rootDir, 'server', 'migrations');
  const defaultsDir = join(rootDir, 'server', 'defaults');

  // Load migration config
  const migrationConfig = await loadMigrationConfig(contentsDir);
  if (!migrationConfig.enabled) {
    logger.info({
      component: 'Migration',
      message: 'Configuration migrations are disabled'
    });
    return;
  }

  // Acquire lock
  await acquireLock(contentsDir);

  try {
    // Scan for migration files
    const migrationFiles = await scanMigrationFiles(migrationsDir);
    if (migrationFiles.length === 0) {
      logger.info({
        component: 'Migration',
        message: 'No migration files found'
      });
      return;
    }

    // Load history
    const history = await loadHistory(contentsDir);

    // Handle baseline for existing installations
    const isExistingInstall =
      history.migrations.length === 0 &&
      (await fileExistsRaw(join(contentsDir, 'config', 'platform.json')));

    if (isExistingInstall) {
      // Auto-record V001 baseline without executing it
      const baselineFile = migrationFiles.find(f => f.version === '001');
      if (baselineFile) {
        const checksum = await computeChecksum(baselineFile.filePath);
        history.migrations.push({
          version: '001',
          description: baselineFile.description,
          file: baselineFile.file,
          checksum,
          appliedAt: new Date().toISOString(),
          executionTimeMs: 0,
          status: 'success'
        });
        await saveHistory(contentsDir, history);
        logger.info({
          component: 'Migration',
          message: 'Baseline established for existing installation (V001 auto-recorded)'
        });
      }
    }

    // Validate previously applied migrations
    await validateAppliedMigrations(history, migrationFiles, migrationConfig.checksumValidation);

    // Determine pending migrations
    const appliedVersions = new Set(
      history.migrations
        .filter(m => m.status === 'success' || m.status === 'skipped')
        .map(m => m.version)
    );
    const pending = migrationFiles.filter(f => !appliedVersions.has(f.version));

    if (pending.length === 0) {
      logger.info({
        component: 'Migration',
        message: `All ${migrationFiles.length} migration(s) already applied`
      });
      return;
    }

    logger.info({
      component: 'Migration',
      message: `Found ${pending.length} pending migration(s) to apply`
    });

    // Execute pending migrations
    let applied = 0;
    let skipped = 0;
    let failed = 0;

    for (const migration of pending) {
      const startTime = Date.now();
      const ctx = createMigrationContext(contentsDir, defaultsDir, migration);

      try {
        // Dynamic import the migration module
        const moduleUrl = pathToFileURL(migration.filePath).href;
        const mod = await import(moduleUrl);

        // Check precondition
        if (typeof mod.precondition === 'function') {
          const shouldRun = await mod.precondition(ctx);
          if (!shouldRun) {
            const entry = {
              version: migration.version,
              description: migration.description,
              file: migration.file,
              checksum: await computeChecksum(migration.filePath),
              appliedAt: new Date().toISOString(),
              executionTimeMs: Date.now() - startTime,
              status: 'skipped'
            };
            history.migrations.push(entry);
            await saveHistory(contentsDir, history);
            skipped++;
            logger.info({
              component: 'Migration',
              message: `[V${migration.version}] Skipped (precondition not met): ${migration.description}`
            });
            continue;
          }
        }

        // Execute the migration
        await mod.up(ctx);

        const entry = {
          version: migration.version,
          description: migration.description,
          file: migration.file,
          checksum: await computeChecksum(migration.filePath),
          appliedAt: new Date().toISOString(),
          executionTimeMs: Date.now() - startTime,
          status: 'success'
        };
        history.migrations.push(entry);
        await saveHistory(contentsDir, history);
        applied++;
        logger.info({
          component: 'Migration',
          message: `[V${migration.version}] Applied: ${migration.description} (${entry.executionTimeMs}ms)`
        });
      } catch (error) {
        const entry = {
          version: migration.version,
          description: migration.description,
          file: migration.file,
          checksum: await computeChecksum(migration.filePath).catch(() => 'unknown'),
          appliedAt: new Date().toISOString(),
          executionTimeMs: Date.now() - startTime,
          status: 'failed',
          error: error.message
        };
        history.migrations.push(entry);
        await saveHistory(contentsDir, history);
        failed++;

        logger.error({
          component: 'Migration',
          message: `[V${migration.version}] Failed: ${migration.description}`,
          error: error.message,
          stack: error.stack
        });

        if (migrationConfig.onFailure === 'halt') {
          throw new Error(
            `Migration V${migration.version} (${migration.description}) failed: ${error.message}`
          );
        }
      }
    }

    logger.info({
      component: 'Migration',
      message: `Migration complete: ${applied} applied, ${skipped} skipped, ${failed} failed`
    });
  } finally {
    await releaseLock(contentsDir);
  }
}

/**
 * Raw file existence check using fs.access.
 * @param {string} absolutePath
 * @returns {Promise<boolean>}
 */
async function fileExistsRaw(absolutePath) {
  try {
    await fs.access(absolutePath);
    return true;
  } catch {
    return false;
  }
}
