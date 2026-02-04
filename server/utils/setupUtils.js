import fs from 'fs/promises';
import path from 'path';
import { getRootDir } from '../pathUtils.js';
import config from '../config.js';
import logger from './logger.js';

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
          logger.info(`⏭️  Skipping existing file: ${path.relative(dest, destPath)}`, { component: 'Setup' });
        } catch (error) {
          if (error.code === 'ENOENT') {
            // File doesn't exist, copy it
            await fs.copyFile(srcPath, destPath);
            copiedCount++;
            logger.info(`📄 Copied file: ${path.relative(dest, destPath)}`, { component: 'Setup' });
          } else {
            throw error;
          }
        }
      }
    }

    return copiedCount;
  } catch (error) {
    logger.error(`Error copying missing files from ${src} to ${dest}:`, { component: 'Setup', error });
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
        logger.warn(`Default configuration directory not found at: ${defaultConfigPath}`, { component: 'Setup' });
        return false;
      }
      throw error;
    }

    logger.info(
      `📋 Copying missing default configuration files from ${defaultConfigPath} to ${contentsPath}`,
      { component: 'Setup' }
    );

    // Copy only missing files and directories
    const copiedCount = await copyMissingFiles(defaultConfigPath, contentsPath);

    if (copiedCount > 0) {
      logger.info(`✅ ${copiedCount} default configuration files copied successfully`, { component: 'Setup' });
      return true;
    } else {
      logger.info('ℹ️  All default configuration files already exist, no files copied', { component: 'Setup' });
      return false;
    }
  } catch (error) {
    logger.error('❌ Failed to copy default configuration:', { component: 'Setup', error });
    throw error;
  }
}

/**
 * Performs initial setup by copying any missing default configuration files
 * This function should be called during server startup
 * @returns {Promise<boolean>} True if any files were copied
 */
export async function performInitialSetup() {
  try {
    logger.info('🔍 Checking for missing default configuration files...', { component: 'Setup' });

    const filesCopied = await copyDefaultConfiguration();

    if (filesCopied) {
      logger.info('📦 Initial setup completed - missing default files have been copied', { component: 'Setup' });
    } else {
      logger.info('✅ All default configuration files already exist, no setup needed', { component: 'Setup' });
    }

    return filesCopied;
  } catch (error) {
    logger.error('❌ Error during initial setup:', { component: 'Setup', error });
    throw error;
  }
}
