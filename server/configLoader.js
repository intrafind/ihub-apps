import fs from 'fs/promises';
import path from 'path';
import { getRootDir } from './pathUtils.js';
import config from './config.js';
import logger from './utils/logger.js';

const cache = new Map();
const CACHE_TTL = 60 * 1000; // 60 seconds

function resolvePath(relativePath) {
  const rootDir = getRootDir();

  const contentsDir = config.CONTENTS_DIR;

  const normalized = path.normalize(relativePath).replace(/^(\.\.(?:[\\/]|$))+/, '');

  return path.join(rootDir, contentsDir, normalized);
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

    const filePath = resolvePath(relativePath);
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
    logger.error(`Error loading ${parse === 'json' ? 'JSON' : 'text'} ${relativePath}:`, { component: 'ConfigLoader', error });
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
    const normalized = path.normalize(relativePath).replace(/^(\.\.(?:[\\/]|$))+/, '');
    const filePath = path.join(rootDir, 'shared', 'i18n', normalized);
    const data = await fs.readFile(filePath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    logger.error(`Error loading builtin locale ${relativePath}:`, { component: 'ConfigLoader', error });
    return null;
  }
}
