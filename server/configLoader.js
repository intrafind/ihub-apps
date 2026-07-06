import fs from 'fs/promises';
import path from 'path';
import { getRootDir } from './pathUtils.js';
import config from './config.js';
import logger from './utils/logger.js';
import { resolveAndValidatePath } from './utils/pathSecurity.js';

const cache = new Map();
const CACHE_TTL = 60 * 1000; // 60 seconds

async function resolvePath(relativePath) {
  const rootDir = getRootDir();
  const contentsDir = config.CONTENTS_DIR;
  const baseDir = path.join(rootDir, contentsDir);
  const resolved = await resolveAndValidatePath(relativePath, baseDir);
  if (!resolved) {
    logger.warn(`Path traversal blocked in configLoader: ${relativePath}`);
    return path.join(baseDir, path.basename(relativePath));
  }
  return resolved;
}

async function loadFile(relativePath, { useCache = true, parse = 'text' } = {}) {
  const cacheKey = `${relativePath}:${parse}`;

  try {
    if (useCache && cache.has(cacheKey)) {
      const cached = cache.get(cacheKey);
      if (Date.now() - cached.timestamp < CACHE_TTL) {
        return cached.data;
      }
      cache.delete(cacheKey);
    }

    const filePath = await resolvePath(relativePath);
    const data = await fs.readFile(filePath, 'utf8');
    const result = parse === 'json' ? JSON.parse(data) : data;

    if (useCache) {
      cache.set(cacheKey, { data: result, timestamp: Date.now() });
    }

    return result;
  } catch (error) {
    // For locale files, ENOENT is expected when no overrides exist
    if (error.code === 'ENOENT' && relativePath.includes('locales/')) {
      return null; // Silent fail for missing locale override files
    }
    logger.error(`Error loading ${parse === 'json' ? 'JSON' : 'text'} ${relativePath}:`, {
      component: 'ConfigLoader',
      error
    });
    return null;
  }
}

export function loadJson(relativePath, options = {}) {
  return loadFile(relativePath, { ...options, parse: 'json' });
}

export function loadText(relativePath, options = {}) {
  return loadFile(relativePath, { ...options, parse: 'text' });
}

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
