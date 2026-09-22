/**
 * Configuration reads, as the rest of the server has always called them.
 *
 * `loadJson` and `loadText` keep their signatures and their semantics — every
 * failure resolves to `null` — but the file access now happens in
 * {@link module:services/config/ConfigStore}, which routes it through the
 * storage provider. The 60-second TTL cache that used to live here is gone:
 * it was invisible to `configCache.refreshCacheEntry()`, so an admin save was
 * followed by up to a minute in which readers still saw the old value.
 *
 * The builtin locale helpers below stay on the filesystem deliberately. They
 * read `shared/i18n/`, which ships with the application rather than living in
 * an installation's `contents/`, so no configuration provider owns it.
 *
 * @module configLoader
 */
import fs from 'fs/promises';
import path from 'path';
import { getRootDir } from './pathUtils.js';
import logger from './utils/logger.js';
import { resolveAndValidatePath } from './utils/pathSecurity.js';
import configStore from './services/config/ConfigStore.js';

/**
 * Load a JSON file from an installation's `contents/` directory.
 *
 * @param {string} relativePath - Path relative to `contents/`, e.g. `config/ui.json`
 * @param {Object} [options] - Reserved; the former `useCache` flag no longer
 *   has an effect because there is no cache below `configCache` any more
 * @returns {Promise<any|null>} The parsed contents, or null when the file is
 *   missing, unreadable or malformed
 */
export function loadJson(relativePath, options = {}) {
  return configStore.readJson(relativePath, options);
}

/**
 * Load a text file from an installation's `contents/` directory — a page body,
 * a renderer, a markdown source.
 *
 * @param {string} relativePath - Path relative to `contents/`, e.g. `pages/en/faq.md`
 * @param {Object} [_options] - Reserved; see {@link loadJson}
 * @returns {Promise<string|null>} The file contents, or null when it cannot be read
 */
export function loadText(relativePath, _options = {}) {
  return configStore.readText(relativePath);
}

/**
 * Load a locale file that ships with the application.
 *
 * @param {string} relativePath - Path relative to `shared/i18n/`, e.g. `en.json`
 * @returns {Promise<any|null>} The parsed contents, or null on any failure
 */
export async function loadBuiltinLocaleJson(relativePath) {
  try {
    const rootDir = getRootDir();
    const baseDir = path.join(rootDir, 'shared', 'i18n');
    const filePath = await resolveAndValidatePath(relativePath, baseDir);
    if (!filePath) {
      logger.warn(`Path traversal blocked in loadBuiltinLocaleJson: ${relativePath}`);
      return null;
    }
    const data = await fs.readFile(filePath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    logger.error(`Error loading builtin locale ${relativePath}:`, {
      component: 'ConfigLoader',
      error
    });
    return null;
  }
}

/**
 * Returns language codes for all built-in locale files found in shared/i18n/.
 * For example, if shared/i18n/ contains en.json and de.json this returns ['en', 'de'].
 * Falls back to ['en', 'de'] if the directory cannot be read.
 */
export async function listBuiltinLocales() {
  try {
    const rootDir = getRootDir();
    const i18nDir = path.join(rootDir, 'shared', 'i18n');
    const entries = await fs.readdir(i18nDir);
    return entries
      .filter(f => f.endsWith('.json'))
      .map(f => path.basename(f, '.json'))
      .sort();
  } catch (error) {
    logger.error('Error listing builtin locales, falling back to defaults:', {
      component: 'ConfigLoader',
      error
    });
    return ['en', 'de'];
  }
}
