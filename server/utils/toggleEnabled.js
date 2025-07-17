import { promises as fs } from 'fs';
import { join } from 'path';
import { getRootDir } from '../pathUtils.js';

/**
 * Toggle the `enabled` flag of a JSON resource file and refresh cache.
 *
 * @param {string} resourcePath - Path under the repository root to the resource directory.
 * @param {string} id - Identifier of the resource (file name without extension).
 * @param {Function} cacheRefreshFn - Function to refresh the corresponding cache.
 * @returns {Promise<{data: object, enabled: boolean, notFound?: boolean}>}
 */
export async function toggleEnabled(resourcePath, id, cacheRefreshFn) {
  const filePath = join(getRootDir(), resourcePath, `${id}.json`);
  let data;
  try {
    const content = await fs.readFile(filePath, 'utf8');
    data = JSON.parse(content);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { notFound: true };
    }
    throw error;
  }

  data.enabled = !data.enabled;
  await fs.writeFile(filePath, JSON.stringify(data, null, 2));

  if (typeof cacheRefreshFn === 'function') {
    await cacheRefreshFn();
  }

  return { data, enabled: data.enabled };
}

