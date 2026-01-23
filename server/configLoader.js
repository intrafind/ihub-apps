import fs from 'fs/promises';
import path from 'path';
import { getRootDir } from './pathUtils.js';
import config from './config.js';

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

    // For config files, try to load from defaults if the file doesn't exist
    if (error.code === 'ENOENT' && relativePath.startsWith('config/')) {
      try {
        const rootDir = getRootDir();
        const defaultFilePath = path.join(rootDir, 'server', 'defaults', relativePath);
        const defaultData = await fs.readFile(defaultFilePath, 'utf8');
        const result = parse === 'json' ? JSON.parse(defaultData) : defaultData;

        // Cache the default data
        if (useCache) {
          cache.set(cacheKey, { data: result, timestamp: Date.now() });
        }

        console.log(`✓ Loaded default: ${relativePath}`);
        return result;
      } catch (defaultError) {
        console.error(
          `Error loading ${parse === 'json' ? 'JSON' : 'text'} ${relativePath} (neither custom nor default):`,
          defaultError
        );
        return null;
      }
    }

    console.error(`Error loading ${parse === 'json' ? 'JSON' : 'text'} ${relativePath}:`, error);
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
    console.error(`Error loading builtin locale ${relativePath}:`, error);
    return null;
  }
}
