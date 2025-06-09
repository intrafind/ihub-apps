import fs from 'fs/promises';
import path from 'path';
import { getRootDir } from './pathUtils.js';

const cache = new Map();
const CACHE_TTL = 60 * 1000; // 60 seconds

function resolvePath(relativePath) {
  const rootDir = getRootDir();

  const contentsDir = process.env.CONTENTS_DIR || 'contents';

  const normalized = path.normalize(relativePath).replace(/^(\.\.(?:[\\/]|$))+/, '');

  return path.join(rootDir, contentsDir, normalized);
}

async function loadFile(relativePath, { useCache = true, parse = 'text' } = {}) {
  const cacheKey = `${relativePath}:${parse}`;

  try {
    if (useCache && cache.has(cacheKey)) {
      const cached = cache.get(cacheKey);
      if ((Date.now() - cached.timestamp) < CACHE_TTL) {
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
