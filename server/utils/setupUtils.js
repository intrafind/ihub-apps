import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { getRootDir } from '../pathUtils.js';
import config from '../config.js';
import logger from './logger.js';
import { atomicWriteJSON } from './atomicWrite.js';

/**
 * Recursively copies files and directories from source to destination,
 * but only if they don't already exist at the destination
 * @param {string} src - Source directory path
 * @param {string} dest - Destination directory path
 * @param {number} copiedCount - Running count of copied items (for logging)
 * @returns {Promise<number>} Number of items copied
 */
async function copyMissingFiles(src, dest, copiedCount = 0) {
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

      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        // Recursively process subdirectories
        copiedCount = await copyMissingFiles(srcPath, destPath, copiedCount);
      } else {
        // Check if file already exists at destination
        try {
          await fs.stat(destPath);
          // File exists, skip copying
          logger.info('Skipping existing file', {
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
 * @returns {Promise<boolean>} True if any files were copied
 */
export async function copyDefaultConfiguration() {
  try {
    const rootDir = getRootDir();
    const defaultConfigPath = path.join(rootDir, 'server', 'defaults');
    const contentsPath = path.join(rootDir, config.CONTENTS_DIR);

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
 * Files that are generated at build time (not user-editable) and must be kept
 * in sync with server/defaults on every startup. Unlike copyMissingFiles,
 * these are overwritten in contents whenever the shipped default differs, so
 * regenerated content (e.g. the consolidated documentation) is never left
 * stale after an upgrade. Paths are relative to both server/defaults and the
 * contents directory.
 */
const MANAGED_DEFAULT_FILES = ['sources/ihub-documentation.md'];

/**
 * Refreshes build-managed default files into the contents directory.
 * Overwrites only when the content differs to avoid needless writes (and to
 * keep the filesystem source cache, which is keyed on mtime, from churning).
 * Missing source files (e.g. a dev checkout where docs were never exported)
 * are skipped with a warning.
 * @returns {Promise<number>} Number of files refreshed
 */
export async function syncManagedDefaultFiles() {
  const rootDir = getRootDir();
  const defaultConfigPath = path.join(rootDir, 'server', 'defaults');
  const contentsPath = path.join(rootDir, config.CONTENTS_DIR);
  let updated = 0;

  for (const relPath of MANAGED_DEFAULT_FILES) {
    const srcPath = path.join(defaultConfigPath, relPath);
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
 * Rotates the shipped demo admin account's password on a fresh install.
 * The default admin/password123 bcrypt hash is committed to the public repo,
 * so leaving it in place makes any freshly deployed instance trivially
 * takeover-able. The generated password is logged once — it is not
 * recoverable afterwards, only resettable via the users.json file or the
 * admin UI.
 * @param {string} usersFilePath - Absolute path to the freshly copied users.json
 * @returns {Promise<void>}
 */
async function rotateDefaultAdminPassword(usersFilePath) {
  try {
    const raw = await fs.readFile(usersFilePath, 'utf8');
    const usersConfig = JSON.parse(raw);
    const adminEntry = Object.values(usersConfig.users || {}).find(u => u.username === 'admin');

    if (!adminEntry) {
      return;
    }

    const generatedPassword = crypto.randomBytes(18).toString('base64url');
    const salt = await bcrypt.genSalt(12);
    adminEntry.passwordHash = await bcrypt.hash(`${adminEntry.id}:${generatedPassword}`, salt);
    adminEntry.updatedAt = new Date().toISOString();

    await atomicWriteJSON(usersFilePath, usersConfig);

    logger.warn(
      `Generated a new local admin password for this fresh install. Username: "${adminEntry.username}", password: "${generatedPassword}". This is shown only once — store it now; it cannot be recovered later, only reset.`,
      { component: 'Setup' }
    );
  } catch (error) {
    logger.error('Failed to rotate default admin password', { component: 'Setup', error });
  }
}

/**
 * Performs initial setup by copying any missing default configuration files
 * This function should be called during server startup
 * @returns {Promise<boolean>} True if any files were copied
 */
export async function performInitialSetup() {
  try {
    logger.info('Checking for missing default configuration files', { component: 'Setup' });

    const usersFilePath = path.join(getRootDir(), config.CONTENTS_DIR, 'config', 'users.json');
    let usersFileExistedBefore = true;
    try {
      await fs.stat(usersFilePath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      usersFileExistedBefore = false;
    }

    const filesCopied = await copyDefaultConfiguration();

    if (filesCopied) {
      logger.info('Initial setup completed - missing default files have been copied', {
        component: 'Setup'
      });

      // Keep the well-known admin/password123 login in development so the
      // documented local dev/testing flow (CLAUDE.md) keeps working; rotate
      // it everywhere else, since the shipped hash is public in the repo.
      if (!usersFileExistedBefore && config.NODE_ENV !== 'development') {
        await rotateDefaultAdminPassword(usersFilePath);
      }
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
