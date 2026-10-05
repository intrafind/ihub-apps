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
import { atomicWriteJSON, atomicCreateJSON } from '../utils/atomicWrite.js';
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
import { getContentsPath } from '../utils/contentsPath.js';

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

  const fileByVersion = new Map();
  for (const migration of migrations) {
    const existing = fileByVersion.get(migration.version);
    if (existing) {
      throw new Error(
        `Duplicate migration version V${migration.version}: ${existing} and ${migration.file} both declare the same version. Each migration must have a unique version number.`
      );
    }
    fileByVersion.set(migration.version, migration.file);
  }

  return migrations;
}

/**
 * Historical migration renumberings, keyed by the version/filename a file
 * used to ship under before it was renumbered to resolve a version collision.
 * Existing installs may have a history entry recorded under the old
 * version/file; reconcile it to the new version so it isn't re-applied and
 * doesn't trigger a spurious checksum mismatch against the file that kept
 * the original number.
 */
const RENAMED_MIGRATIONS = [
  // The 5.5.30 follow-ups (Translator system prompt, Mistral transcription,
  // Gemini TTS, dictation through transcription models) were written as
  // V143-V146 and shifted up each time main took a number first: to V145-V148
  // (app wizard field cleanup, V144), V146-V149 (short-link allowlist, V145),
  // V147-V150 (local sign-in lockout, V146), V148-V151 (proxy auth trusted
  // sources, V147). Every old number reconciles to the current one, keeping
  // their order. Matching on the file keeps these rules off the history rows of
  // main's V144-V147.
  {
    oldVersion: '143',
    oldFile: 'V143__translator_task_in_system_prompt.js',
    newVersion: '148',
    newFile: 'V148__translator_task_in_system_prompt.js'
  },
  {
    oldVersion: '145',
    oldFile: 'V145__translator_task_in_system_prompt.js',
    newVersion: '148',
    newFile: 'V148__translator_task_in_system_prompt.js'
  },
  {
    oldVersion: '146',
    oldFile: 'V146__translator_task_in_system_prompt.js',
    newVersion: '148',
    newFile: 'V148__translator_task_in_system_prompt.js'
  },
  {
    oldVersion: '147',
    oldFile: 'V147__translator_task_in_system_prompt.js',
    newVersion: '148',
    newFile: 'V148__translator_task_in_system_prompt.js'
  },
  {
    oldVersion: '144',
    oldFile: 'V144__seed_mistral_realtime_transcription_model.js',
    newVersion: '149',
    newFile: 'V149__seed_mistral_realtime_transcription_model.js'
  },
  {
    oldVersion: '146',
    oldFile: 'V146__seed_mistral_realtime_transcription_model.js',
    newVersion: '149',
    newFile: 'V149__seed_mistral_realtime_transcription_model.js'
  },
  {
    oldVersion: '147',
    oldFile: 'V147__seed_mistral_realtime_transcription_model.js',
    newVersion: '149',
    newFile: 'V149__seed_mistral_realtime_transcription_model.js'
  },
  {
    oldVersion: '148',
    oldFile: 'V148__seed_mistral_realtime_transcription_model.js',
    newVersion: '149',
    newFile: 'V149__seed_mistral_realtime_transcription_model.js'
  },
  {
    oldVersion: '145',
    oldFile: 'V145__seed_google_tts_models.js',
    newVersion: '150',
    newFile: 'V150__seed_google_tts_models.js'
  },
  {
    oldVersion: '147',
    oldFile: 'V147__seed_google_tts_models.js',
    newVersion: '150',
    newFile: 'V150__seed_google_tts_models.js'
  },
  {
    oldVersion: '148',
    oldFile: 'V148__seed_google_tts_models.js',
    newVersion: '150',
    newFile: 'V150__seed_google_tts_models.js'
  },
  {
    oldVersion: '149',
    oldFile: 'V149__seed_google_tts_models.js',
    newVersion: '150',
    newFile: 'V150__seed_google_tts_models.js'
  },
  {
    oldVersion: '146',
    oldFile: 'V146__dictation_via_transcription_models.js',
    newVersion: '151',
    newFile: 'V151__dictation_via_transcription_models.js'
  },
  {
    oldVersion: '148',
    oldFile: 'V148__dictation_via_transcription_models.js',
    newVersion: '151',
    newFile: 'V151__dictation_via_transcription_models.js'
  },
  {
    oldVersion: '149',
    oldFile: 'V149__dictation_via_transcription_models.js',
    newVersion: '151',
    newFile: 'V151__dictation_via_transcription_models.js'
  },
  {
    oldVersion: '150',
    oldFile: 'V150__dictation_via_transcription_models.js',
    newVersion: '151',
    newFile: 'V151__dictation_via_transcription_models.js'
  },
  {
    // The staan provider was renumbered twice while its branch was open: the
    // CIMD governance migrations took V112/V113 and the proxy-defaults fix took
    // V114, both on main in parallel. Either old number reconciles to V116.
    oldVersion: '112',
    oldFile: 'V112__add_staan_websearch_provider.js',
    newVersion: '116',
    newFile: 'V116__add_staan_websearch_provider.js'
  },
  {
    oldVersion: '114',
    oldFile: 'V114__add_staan_websearch_provider.js',
    newVersion: '116',
    newFile: 'V116__add_staan_websearch_provider.js'
  },
  {
    oldVersion: '018',
    oldFile: 'V018__add_setup_configured_flag.js',
    newVersion: '075',
    newFile: 'V075__add_setup_configured_flag.js'
  },
  {
    oldVersion: '043',
    oldFile: 'V043__fix_ifinder_jwt_subject_template.js',
    newVersion: '076',
    newFile: 'V076__fix_ifinder_jwt_subject_template.js'
  },
  {
    oldVersion: '073',
    oldFile: 'V073__seed_voxtral_transcription_model.js',
    newVersion: '077',
    newFile: 'V077__seed_voxtral_transcription_model.js'
  },
  // The storage-provider migrations were written against V094-V096 while
  // V094 (default iAssistant app) and V095 (LLM transport timeouts) landed on
  // main in parallel. Both sides were self-consistent; merged, the runner saw
  // two V094s and two V095s and refuses to start on a duplicate version. The
  // storage set moved because the other two had already shipped. Anyone who
  // ran the branch before the merge has the old numbers in their history.
  {
    oldVersion: '094',
    oldFile: 'V094__add_storage_settings.js',
    newVersion: '096',
    newFile: 'V096__add_storage_settings.js'
  },
  {
    oldVersion: '095',
    oldFile: 'V095__add_chat_persistence.js',
    newVersion: '097',
    newFile: 'V097__add_chat_persistence.js'
  },
  {
    oldVersion: '096',
    oldFile: 'V096__add_workflow_state_retention.js',
    newVersion: '098',
    newFile: 'V098__add_workflow_state_retention.js'
  },
  // Same story one release later: the Qwant search provider and the
  // outbound-proxy defaults were both written as V110 and merged within the
  // hour, leaving main unable to boot. Qwant moved because it landed second.
  {
    oldVersion: '110',
    oldFile: 'V110__add_qwant_websearch_provider.js',
    newVersion: '111',
    newFile: 'V111__add_qwant_websearch_provider.js'
  },
  // And again, against the number Qwant had just moved *to*: the two CIMD
  // governance migrations were written as V111 and V112 while Qwant was taking
  // V111 on main. Both moved up one, keeping their order — the approval gate
  // must be seeded before the migration that grandfathers clients through it.
  {
    oldVersion: '111',
    oldFile: 'V111__add_oauth_cimd_governance.js',
    newVersion: '112',
    newFile: 'V112__add_oauth_cimd_governance.js'
  },
  {
    oldVersion: '112',
    oldFile: 'V112__grandfather_connected_cimd_clients.js',
    newVersion: '113',
    newFile: 'V113__grandfather_connected_cimd_clients.js'
  },
  // The Office.js source-mode migration was written as V115 while the brave
  // search language parameter (V115) and the staan provider (V116) landed on
  // main in parallel. It moved to V117 because those had already shipped.
  // Without this entry, anyone who ran the branch before the merge has 115
  // recorded against the Office.js file, which would mark the brave V115
  // applied and silently skip it — the match on `file` as well as `version`
  // is what keeps this entry off the brave migration's own history row.
  {
    oldVersion: '115',
    oldFile: 'V115__office_js_source_modes.js',
    newVersion: '117',
    newFile: 'V117__office_js_source_modes.js'
  },
  // …and then collided a second time: the directory login-name backfill took
  // V117 while the Office.js branch was still open, so it moved again to V118.
  // Order matters here. Entries are applied in sequence, so a history still
  // recorded at 115 is rewritten to 117 by the rule above and then to 118 by
  // this one. Matching on the file keeps both rules off the two migrations
  // that legitimately hold 115 and 117.
  {
    oldVersion: '117',
    oldFile: 'V117__office_js_source_modes.js',
    newVersion: '118',
    newFile: 'V118__office_js_source_modes.js'
  },
  // The same V117 slot, contested a third time: the iAssistant stream-ceiling
  // migration was written as V117 while the login-name backfill was taking it
  // and Office.js was moving onto V118, so it moved to V119. Matching on the
  // file is again what keeps this rule off the backfill's own history row,
  // which legitimately holds 117.
  {
    oldVersion: '117',
    oldFile: 'V117__iassistant_stream_ceiling_and_grounding.js',
    newVersion: '119',
    newFile: 'V119__iassistant_stream_ceiling_and_grounding.js'
  },
  // The iFinder skill-pointer migration was written as V109 while the legacy
  // private-key migration took that number on main; by the time its branch
  // merged, main had reached V124. Matching on the file keeps this rule off
  // the private-key migration's own history row, which legitimately holds 109.
  {
    oldVersion: '109',
    oldFile: 'V109__ifinder_search_skill_pointer.js',
    newVersion: '125',
    newFile: 'V125__ifinder_search_skill_pointer.js'
  },
  // The web tool parameters migration was renumbered three times while its
  // branch was open: the prompt placeholder migration took V136 (and user
  // prompts V137) on main, then the scheduled tasks defaults took V138, then
  // the speech platform defaults took V139. Every old number reconciles to
  // V140. Without these rules an install that ran the branch would count
  // main's migration of that number as applied and never run it. Matching on
  // the file keeps them off the history rows of the migrations that
  // legitimately hold 136, 138 and 139.
  {
    oldVersion: '136',
    oldFile: 'V136__web_tools_filters_and_page_offset.js',
    newVersion: '140',
    newFile: 'V140__web_tools_filters_and_page_offset.js'
  },
  {
    oldVersion: '138',
    oldFile: 'V138__web_tools_filters_and_page_offset.js',
    newVersion: '140',
    newFile: 'V140__web_tools_filters_and_page_offset.js'
  },
  {
    oldVersion: '139',
    oldFile: 'V139__web_tools_filters_and_page_offset.js',
    newVersion: '140',
    newFile: 'V140__web_tools_filters_and_page_offset.js'
  },
  // The short-link host allowlist was written as V143, and the app wizard
  // field cleanup took V144 on main first. It moved to V145; an install that
  // ran the branch reconciles its V143 row instead of applying it again.
  {
    oldVersion: '143',
    oldFile: 'V143__add_short_link_allowed_hosts.js',
    newVersion: '145',
    newFile: 'V145__add_short_link_allowed_hosts.js'
  },
  // The EU AI Act migration moved fourteen times while its branch was open and
  // dev installs were running it: the prompt placeholder (V136), scheduled
  // tasks defaults (V138), speech defaults (V139), web tool parameters (V140),
  // provider plain names (V141) and text-to-speech (V142) each took its number
  // on main first, the app wizard field cleanup (V144) left V143 out of order,
  // the short-link host allowlist (V145), local sign-in lockout (V146) and
  // proxy-auth trusted sources (V147) took the next three, the 5.5.30
  // follow-ups took V148-V151, the user skills settings took V152, the
  // workflow code node removal took V153 and the user skills marketplace took
  // V154. Every old number reconciles to V155, so main's migration of that
  // number runs.
  {
    oldVersion: '136',
    oldFile: 'V136__add_ai_transparency.js',
    newVersion: '155',
    newFile: 'V155__add_ai_transparency.js'
  },
  {
    oldVersion: '138',
    oldFile: 'V138__add_ai_transparency.js',
    newVersion: '155',
    newFile: 'V155__add_ai_transparency.js'
  },
  {
    oldVersion: '139',
    oldFile: 'V139__add_ai_transparency.js',
    newVersion: '155',
    newFile: 'V155__add_ai_transparency.js'
  },
  {
    oldVersion: '140',
    oldFile: 'V140__add_ai_transparency.js',
    newVersion: '155',
    newFile: 'V155__add_ai_transparency.js'
  },
  {
    oldVersion: '141',
    oldFile: 'V141__add_ai_transparency.js',
    newVersion: '155',
    newFile: 'V155__add_ai_transparency.js'
  },
  {
    oldVersion: '142',
    oldFile: 'V142__add_ai_transparency.js',
    newVersion: '155',
    newFile: 'V155__add_ai_transparency.js'
  },
  {
    oldVersion: '143',
    oldFile: 'V143__add_ai_transparency.js',
    newVersion: '155',
    newFile: 'V155__add_ai_transparency.js'
  },
  {
    oldVersion: '145',
    oldFile: 'V145__add_ai_transparency.js',
    newVersion: '155',
    newFile: 'V155__add_ai_transparency.js'
  },
  {
    oldVersion: '146',
    oldFile: 'V146__add_ai_transparency.js',
    newVersion: '155',
    newFile: 'V155__add_ai_transparency.js'
  },
  {
    oldVersion: '147',
    oldFile: 'V147__add_ai_transparency.js',
    newVersion: '155',
    newFile: 'V155__add_ai_transparency.js'
  },
  {
    oldVersion: '148',
    oldFile: 'V148__add_ai_transparency.js',
    newVersion: '155',
    newFile: 'V155__add_ai_transparency.js'
  },
  {
    oldVersion: '152',
    oldFile: 'V152__add_ai_transparency.js',
    newVersion: '155',
    newFile: 'V155__add_ai_transparency.js'
  },
  {
    oldVersion: '153',
    oldFile: 'V153__add_ai_transparency.js',
    newVersion: '155',
    newFile: 'V155__add_ai_transparency.js'
  },
  {
    oldVersion: '154',
    oldFile: 'V154__add_ai_transparency.js',
    newVersion: '155',
    newFile: 'V155__add_ai_transparency.js'
  }
];

/**
 * Rewrite history entries for migrations that were renumbered to resolve a
 * duplicate-version collision. Matches on the recorded `file` name (not just
 * version) so it only touches the entry that actually corresponds to the
 * renamed file, leaving the sibling that kept its original number untouched.
 * @param {object} history
 * @returns {boolean} whether any entry was changed
 */
export function reconcileRenamedMigrations(history) {
  let changed = false;
  for (const { oldVersion, oldFile, newVersion, newFile } of RENAMED_MIGRATIONS) {
    const entry = history.migrations.find(m => m.version === oldVersion && m.file === oldFile);
    if (entry) {
      entry.version = newVersion;
      entry.file = newFile;
      changed = true;
      logger.info(
        `Reconciled migration history entry: ${oldFile} (V${oldVersion}) -> ${newFile} (V${newVersion})`,
        { component: 'Migration' }
      );
    }
  }
  return changed;
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
      logger.warn(msg, { component: 'Migration' });
      continue;
    }

    const currentChecksum = await computeChecksum(file.filePath);
    if (currentChecksum !== entry.checksum) {
      const msg = `Checksum mismatch for ${entry.file}: expected ${entry.checksum.substring(0, 12)}..., got ${currentChecksum.substring(0, 12)}...`;
      if (mode === 'strict') {
        throw new Error(msg);
      }
      logger.warn(msg, { component: 'Migration' });
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
        // Convert glob pattern to regex (e.g., *.json → ^.*\.json$)
        const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
        const regex = new RegExp(`^${escaped}$`);
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
    log: message => logger.info(message, { component: 'Migration', version: migration.version }),
    warn: message => logger.warn(message, { component: 'Migration', version: migration.version }),

    // Metadata
    version: migration.version,
    description: migration.description,
    contentsDir,
    defaultsDir
  };
}

/**
 * Acquire a lock file to prevent concurrent migration runs.
 *
 * Creates the lock with the 'wx' flag (create-or-fail) rather than the
 * previous read-then-write: two processes racing to acquire at the same
 * instant could both pass a plain existence check before either had written,
 * and both proceed to migrate concurrently. 'wx' makes the create itself the
 * check, so only one caller can ever win it.
 * @param {string} contentsDir
 */
export async function acquireLock(contentsDir) {
  const lockPath = join(contentsDir, LOCK_FILE);

  // At most one retry: the first pass either creates the lock or, finding it
  // held and stale, steals it; the second pass' create then either succeeds
  // or (having lost a steal race to another process) reports who holds it.
  for (let attempt = 0; attempt < 2; attempt++) {
    const lockData = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      hostname: os.hostname()
    };

    try {
      await atomicCreateJSON(lockPath, lockData);
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }

    let existing = null;
    try {
      existing = JSON.parse(await fs.readFile(lockPath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') continue; // released between our create and this read — retry
      // Corrupt/unreadable lock file: treat as stale rather than blocking forever.
    }

    const age = existing ? Date.now() - new Date(existing.startedAt).getTime() : Infinity;
    if (existing && age < LOCK_STALE_MS) {
      throw new Error(
        `Migration lock held by PID ${existing.pid} since ${existing.startedAt}. ` +
          `If the process is no longer running, delete ${lockPath}`
      );
    }

    logger.warn('Stale migration lock detected, overriding', {
      component: 'Migration',
      ageSeconds: existing ? Math.round(age / 1000) : undefined
    });

    try {
      await fs.unlink(lockPath);
    } catch {
      // Already gone — the next iteration's create settles it either way.
    }
  }

  throw new Error(`Failed to acquire migration lock at ${lockPath} after stealing a stale lock`);
}

/**
 * Release the migration lock file.
 * @param {string} contentsDir
 */
export async function releaseLock(contentsDir) {
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
  const contentsDir = getContentsPath();
  const migrationsDir = join(rootDir, 'server', 'migrations');
  const defaultsDir = join(rootDir, 'server', 'defaults');

  // Load migration config
  const migrationConfig = await loadMigrationConfig(contentsDir);
  if (!migrationConfig.enabled) {
    logger.info('Configuration migrations are disabled', { component: 'Migration' });
    return { applied: 0, skipped: 0, failed: 0, disabled: true };
  }

  // Acquire lock
  await acquireLock(contentsDir);

  try {
    // Scan for migration files
    const migrationFiles = await scanMigrationFiles(migrationsDir);
    if (migrationFiles.length === 0) {
      logger.info('No migration files found', { component: 'Migration' });
      return { applied: 0, skipped: 0, failed: 0 };
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
        logger.info('Baseline established for existing installation (V001 auto-recorded)', {
          component: 'Migration'
        });
      }
    }

    // Reconcile history entries for migrations renumbered to resolve a
    // duplicate-version collision (see RENAMED_MIGRATIONS), before validating
    // checksums so a renamed file's old history entry doesn't show up as
    // "removed from disk" or collide with its sibling's checksum.
    if (reconcileRenamedMigrations(history)) {
      await saveHistory(contentsDir, history);
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
      logger.info('All migrations already applied', {
        component: 'Migration',
        count: migrationFiles.length
      });
      return { applied: 0, skipped: 0, failed: 0 };
    }

    logger.info('Found pending migrations to apply', {
      component: 'Migration',
      count: pending.length
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
            logger.info('Migration skipped (precondition not met)', {
              component: 'Migration',
              version: migration.version,
              description: migration.description
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
        logger.info('Migration applied', {
          component: 'Migration',
          version: migration.version,
          description: migration.description,
          executionTimeMs: entry.executionTimeMs
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

        logger.error('Migration failed', {
          component: 'Migration',
          version: migration.version,
          description: migration.description,
          error
        });

        if (migrationConfig.onFailure === 'halt') {
          const haltError = new Error(
            `Migration V${migration.version} (${migration.description}) failed: ${error.message}`
          );
          // Distinguishes an operator-requested halt from an ordinary migration
          // error, so the caller (server.js) can exit the process instead of
          // logging a warning and serving traffic on unmigrated config.
          haltError.migrationHalt = true;
          throw haltError;
        }
      }
    }

    logger.info('Migration run complete', {
      component: 'Migration',
      applied,
      skipped,
      failed
    });
    return { applied, skipped, failed };
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
