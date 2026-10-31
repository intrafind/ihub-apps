// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Seeds an installation's contents directory from `server/defaults`.
 *
 * This is the one part of the configuration plumbing that stays on raw `fs`,
 * for the same reason the bootstrap read of `platform.json` does: it runs
 * inside `prepareContents()`, before the migration runner and long before
 * `bootstrapStorage()`, so there is no storage provider to write through —
 * and the files it copies may be the very `platform.json` the provider is
 * configured from.
 *
 * Its shape is wrong for a document store besides. It walks two directory
 * trees and copies whatever it finds — markdown sources, JSX renderers,
 * nested skill packages, images — comparing raw bytes rather than parsed
 * JSON, and it must not rewrite a file whose content already matches. A
 * document API addresses one JSON document at a time and cannot express
 * that. See the exclusion list in `docs/storage.md`.
 *
 * @module utils/setupUtils
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { getRootDir } from '../pathUtils.js';
import logger from './logger.js';
import { getContentsPath } from './contentsPath.js';

/**
 * Shipped defaults that are never seeded into contents: plaintext files that
 * only exist to be imported into an admin project (the FAQ, the meeting
 * knowledge base, the consolidated documentation). The startup import
 * (`services/projects/projectImport.js`) reads them straight from
 * `server/defaults/` when no installation copy exists, and deletes an
 * installation copy once it is imported, so no plaintext outlives the
 * import. Seeding them would put that plaintext back into `contents/` on
 * every start. Paths are relative to server/defaults; an entry ending in `/`
 * excludes a whole directory.
 */
// `integration-definitions/` are shipped catalog entries the IntegrationRegistry
// reads in place; a copy under contents/ would shadow every later update.
// `tools/iFinder.json` is retired (the iFinder built-in integration owns the
// tools since V192) and is kept only for the older migrations that read it.
export const IMPORT_ONLY_DEFAULT_FILES = [
  'sources/',
  'integration-definitions/',
  'tools/iFinder.json'
];

/**
 * Whether a path relative to server/defaults falls under an import-only entry.
 * @param {string} relPath - Posix path relative to server/defaults
 * @returns {boolean}
 */
function isImportOnlyDefault(relPath) {
  return IMPORT_ONLY_DEFAULT_FILES.some(entry =>
    entry.endsWith('/') ? `${relPath}/`.startsWith(entry) : relPath === entry
  );
}

/**
 * Recursively copies files and directories from source to destination,
 * but only if they don't already exist at the destination. Import-only
 * defaults ({@link IMPORT_ONLY_DEFAULT_FILES}) are skipped.
 * @param {string} src - Source directory path
 * @param {string} dest - Destination directory path
 * @param {number} copiedCount - Running count of copied items (for logging)
 * @param {string} relDir - Posix path of `src` relative to the defaults root
 * @returns {Promise<number>} Number of items copied
 */
async function copyMissingFiles(src, dest, copiedCount = 0, relDir = '') {
  try {
    // Ensure destination directory exists
    await fs.mkdir(dest, { recursive: true });

    const entries = await fs.readdir(src, { withFileTypes: true });

    for (const entry of entries) {
      // Skip hidden files and directories (starting with a dot)
      if (entry.name.startsWith('.')) {
        continue;
      }

      // Skip filesystem-specific files and directories
      const skipNames = [
        'lost+found', // Linux filesystem recovery directory
        'Thumbs.db', // Windows thumbnail cache
        'desktop.ini', // Windows folder customization
        '$RECYCLE.BIN', // Windows recycle bin
        'System Volume Information' // Windows system folder
      ];

      if (skipNames.includes(entry.name)) {
        continue;
      }

      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (isImportOnlyDefault(relPath)) {
        continue;
      }

      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        // Recursively process subdirectories
        copiedCount = await copyMissingFiles(srcPath, destPath, copiedCount, relPath);
      } else {
        // Check if file already exists at destination
        try {
          await fs.stat(destPath);
          // File exists, skip copying
          logger.debug('Skipping existing file', {
            component: 'Setup',
            file: path.relative(dest, destPath)
          });
        } catch (error) {
          if (error.code === 'ENOENT') {
            // File doesn't exist, copy it
            await fs.copyFile(srcPath, destPath);
            copiedCount++;
            logger.info('Copied file', { component: 'Setup', file: path.relative(dest, destPath) });
          } else {
            throw error;
          }
        }
      }
    }

    return copiedCount;
  } catch (error) {
    logger.error('Error copying missing files', { component: 'Setup', src, dest, error });
    throw error;
  }
}

/**
 * Copies missing default configuration files from server/defaults to the contents directory
 * Only copies files that don't already exist in the destination
 * @param {Object} [options]
 * @param {string} [options.defaultsPath] - Absolute path of the defaults directory
 * @param {string} [options.contentsPath] - Absolute path of the contents directory
 * @returns {Promise<boolean>} True if any files were copied
 */
export async function copyDefaultConfiguration({
  defaultsPath: defaultConfigPath = path.join(getRootDir(), 'server', 'defaults'),
  contentsPath = getContentsPath()
} = {}) {
  try {
    // Check if default config directory exists
    try {
      await fs.stat(defaultConfigPath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        logger.warn('Default configuration directory not found', {
          component: 'Setup',
          defaultConfigPath
        });
        return false;
      }
      throw error;
    }

    logger.info('Copying missing default configuration files', {
      component: 'Setup',
      defaultConfigPath,
      contentsPath
    });

    // Copy only missing files and directories
    const copiedCount = await copyMissingFiles(defaultConfigPath, contentsPath);

    if (copiedCount > 0) {
      logger.info('Default configuration files copied successfully', {
        component: 'Setup',
        count: copiedCount
      });
      return true;
    } else {
      logger.info('All default configuration files already exist, no files copied', {
        component: 'Setup'
      });
      return false;
    }
  } catch (error) {
    logger.error('Failed to copy default configuration', { component: 'Setup', error });
    throw error;
  }
}

/**
 * Default files whose shipped copy is authoritative: unlike ordinary defaults,
 * which are copied once and then belong to the installation, these are
 * overwritten in contents whenever the shipped default differs, so generated
 * or vendor-maintained content is never left stale after an upgrade. Paths
 * are relative to both server/defaults and the contents directory; an entry
 * ending in `/` is a directory whose files are all managed (recursively).
 *
 * - `skills/ifinder-search/` — the shipped iFinder search skill. Its guidance
 *   moves with the iFinder tools and the search app prompt in the same
 *   release, so an installation must not keep an older copy. Customize it by
 *   copying it under another skill id, not by editing it in place.
 *
 * The consolidated documentation (`sources/ihub-documentation.md`) is no
 * longer copied: the `ihub-documentation` admin project imports it from the
 * shipped defaults whenever it changes (`services/projects/projectImport.js`),
 * and it is an import-only default ({@link IMPORT_ONLY_DEFAULT_FILES}).
 */
export const MANAGED_DEFAULT_FILES = ['skills/ifinder-search/'];

/**
 * Files under `dir`, recursively, as paths relative to `dir` (posix separators).
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function listFilesRecursive(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const nested = await listFilesRecursive(path.join(dir, entry.name));
      files.push(...nested.map(f => `${entry.name}/${f}`));
    } else if (entry.isFile()) {
      files.push(entry.name);
    }
  }
  return files;
}

/**
 * The managed entries expanded to individual files: a directory entry becomes
 * every file the shipped default holds under it.
 * @param {string} defaultsPath - Absolute path of server/defaults
 * @param {string[]} entries - Managed paths (files, or directories ending in `/`)
 * @returns {Promise<string[]>} Relative file paths, in order
 */
export async function expandManagedDefaultFiles(defaultsPath, entries = MANAGED_DEFAULT_FILES) {
  const files = [];
  for (const entry of entries) {
    if (!entry.endsWith('/')) {
      files.push(entry);
      continue;
    }
    const dir = path.join(defaultsPath, entry);
    try {
      const nested = await listFilesRecursive(dir);
      files.push(...nested.map(f => path.posix.join(entry, f)));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      logger.warn('Managed default directory not found in defaults, skipping refresh', {
        component: 'Setup',
        directory: entry
      });
    }
  }
  return files;
}

/**
 * Refreshes managed default files into the contents directory.
 * Overwrites only when the content differs to avoid needless writes (and to
 * keep the filesystem source cache, which is keyed on mtime, from churning).
 * Missing source files (e.g. a dev checkout where docs were never exported)
 * are skipped with a warning.
 * @param {Object} [options]
 * @param {string} [options.defaultsPath] - Absolute path of the defaults directory
 * @param {string} [options.contentsPath] - Absolute path of the contents directory
 * @param {string[]} [options.entries] - Managed paths to refresh
 * @returns {Promise<number>} Number of files refreshed
 */
export async function syncManagedDefaultFiles({
  defaultsPath = path.join(getRootDir(), 'server', 'defaults'),
  contentsPath = getContentsPath(),
  entries = MANAGED_DEFAULT_FILES
} = {}) {
  let updated = 0;

  for (const relPath of await expandManagedDefaultFiles(defaultsPath, entries)) {
    const srcPath = path.join(defaultsPath, relPath);
    const destPath = path.join(contentsPath, relPath);

    try {
      const srcContent = await fs.readFile(srcPath);

      let destContent = null;
      try {
        destContent = await fs.readFile(destPath);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }

      if (destContent && srcContent.equals(destContent)) {
        continue; // Already up to date
      }

      await fs.mkdir(path.dirname(destPath), { recursive: true });
      await fs.writeFile(destPath, srcContent);
      updated++;
      logger.info('Refreshed managed default file', { component: 'Setup', file: relPath });
    } catch (error) {
      if (error.code === 'ENOENT') {
        logger.warn('Managed default file not found in defaults, skipping refresh', {
          component: 'Setup',
          file: relPath
        });
        continue;
      }
      logger.error('Failed to refresh managed default file', {
        component: 'Setup',
        file: relPath,
        error
      });
    }
  }

  return updated;
}

/**
 * Performs initial setup by copying any missing default configuration files
 * This function should be called during server startup
 * @returns {Promise<boolean>} True if any files were copied
 */
export async function performInitialSetup() {
  try {
    logger.info('Checking for missing default configuration files', { component: 'Setup' });

    const filesCopied = await copyDefaultConfiguration();

    if (filesCopied) {
      logger.info('Initial setup completed - missing default files have been copied', {
        component: 'Setup'
      });
    } else {
      logger.info('All default configuration files already exist, no setup needed', {
        component: 'Setup'
      });
    }

    // Always keep build-managed (generated) default files in sync, even when
    // the contents directory already exists from a previous run.
    const refreshed = await syncManagedDefaultFiles();
    if (refreshed > 0) {
      logger.info('Refreshed build-managed default files', {
        component: 'Setup',
        count: refreshed
      });
    }

    return filesCopied;
  } catch (error) {
    logger.error('Error during initial setup', { component: 'Setup', error });
    throw error;
  }
}
