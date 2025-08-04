import fs from 'fs/promises';
import path from 'path';
import { getRootDir } from '../pathUtils.js';
import config from '../config.js';

/**
 * Checks if the contents directory is empty or doesn't exist
 * @returns {Promise<boolean>} True if directory is empty or doesn't exist
 */
export async function isContentsDirectoryEmpty() {
  try {
    const rootDir = getRootDir();
    const contentsPath = path.join(rootDir, config.CONTENTS_DIR);

    const stats = await fs.stat(contentsPath);
    if (!stats.isDirectory()) {
      return true;
    }

    const files = await fs.readdir(contentsPath);
    // Filter out hidden files and directories like .gitkeep, .DS_Store, etc.
    const visibleFiles = files.filter(file => !file.startsWith('.'));
    return visibleFiles.length === 0;
  } catch (error) {
    // If directory doesn't exist, it's considered empty
    if (error.code === 'ENOENT') {
      return true;
    }
    throw error;
  }
}

/**
 * Recursively copies a directory from source to destination
 * @param {string} src - Source directory path
 * @param {string} dest - Destination directory path
 */
async function copyDirectory(src, dest) {
  try {
    await fs.mkdir(dest, { recursive: true });

    const entries = await fs.readdir(src, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        await copyDirectory(srcPath, destPath);
      } else {
        await fs.copyFile(srcPath, destPath);
      }
    }
  } catch (error) {
    console.error(`Error copying directory from ${src} to ${dest}:`, error);
    throw error;
  }
}

/**
 * Copies the default configuration from configs/default to the contents directory
 * @returns {Promise<boolean>} True if copy was successful
 */
export async function copyDefaultConfiguration() {
  try {
    const rootDir = getRootDir();
    const defaultConfigPath = path.join(rootDir, 'configs', 'default');
    const contentsPath = path.join(rootDir, config.CONTENTS_DIR);

    // Check if default config directory exists
    try {
      await fs.stat(defaultConfigPath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        console.warn(`Default configuration directory not found at: ${defaultConfigPath}`);
        return false;
      }
      throw error;
    }

    console.log(`📋 Copying default configuration from ${defaultConfigPath} to ${contentsPath}`);

    // Copy the entire default directory structure
    await copyDirectory(defaultConfigPath, contentsPath);

    console.log('✅ Default configuration copied successfully');
    return true;
  } catch (error) {
    console.error('❌ Failed to copy default configuration:', error);
    throw error;
  }
}

/**
 * Performs initial setup if the contents directory is empty
 * This function should be called during server startup
 * @returns {Promise<boolean>} True if setup was performed
 */
export async function performInitialSetup() {
  try {
    console.log('🔍 Checking if initial setup is required...');

    const isEmpty = await isContentsDirectoryEmpty();

    if (isEmpty) {
      console.log('📦 Contents directory is empty, performing initial setup...');
      await copyDefaultConfiguration();
      return true;
    } else {
      console.log('✅ Contents directory already exists and is not empty, skipping initial setup');
      return false;
    }
  } catch (error) {
    console.error('❌ Error during initial setup check:', error);
    throw error;
  }
}
