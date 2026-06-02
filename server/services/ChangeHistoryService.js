import { promises as fs } from 'fs';
import { join } from 'path';
import { getRootDir } from '../pathUtils.js';
import logger from '../utils/logger.js';

const HISTORY_DIR = 'data/change-history';
const MAX_SNAPSHOTS = 20;

/**
 * Get the directory for a specific resource's change history.
 */
function getResourceDir(resource, id) {
  return join(getRootDir(), 'contents', HISTORY_DIR, resource, id);
}

/**
 * Save a before/after snapshot for a resource change.
 * Keeps only the last MAX_SNAPSHOTS per resource.
 *
 * @param {Object} options
 * @param {string} options.resource - Resource type (e.g., 'app', 'group', 'prompt')
 * @param {string} options.id - Resource ID
 * @param {Object} options.before - State before the change
 * @param {Object} options.after - State after the change
 * @param {string} options.admin - Username of the admin who made the change
 */
export async function saveSnapshot({ resource, id, before, after, admin }) {
  try {
    const dir = getResourceDir(resource, id);
    await fs.mkdir(dir, { recursive: true });

    const ts = new Date().toISOString();
    const safeTs = ts.replace(/:/g, '-'); // Filesystem-safe timestamp
    const snapshot = { ts, admin, before, after };

    await fs.writeFile(join(dir, `${safeTs}.json`), JSON.stringify(snapshot, null, 2), 'utf8');

    // Prune oldest snapshots if over limit
    const files = (await fs.readdir(dir)).filter(f => f.endsWith('.json')).sort();

    if (files.length > MAX_SNAPSHOTS) {
      const toDelete = files.slice(0, files.length - MAX_SNAPSHOTS);
      for (const file of toDelete) {
        await fs.unlink(join(dir, file)).catch(() => {});
      }
    }
  } catch (error) {
    logger.error('Failed to save change history snapshot', {
      component: 'ChangeHistoryService',
      resource,
      id,
      error: error.message
    });
  }
}

/**
 * List snapshots for a resource (metadata only).
 *
 * @param {string} resource - Resource type
 * @param {string} id - Resource ID
 * @returns {Promise<Array<{ts: string, admin: string, filename: string}>>}
 */
export async function listSnapshots(resource, id) {
  const dir = getResourceDir(resource, id);

  let files;
  try {
    files = await fs.readdir(dir);
  } catch {
    return [];
  }

  const snapshots = [];
  const jsonFiles = files
    .filter(f => f.endsWith('.json'))
    .sort()
    .reverse();

  for (const file of jsonFiles) {
    try {
      const content = await fs.readFile(join(dir, file), 'utf8');
      const data = JSON.parse(content);
      snapshots.push({
        ts: data.ts,
        admin: data.admin,
        filename: file
      });
    } catch {
      // Skip unreadable files
    }
  }

  return snapshots;
}

/**
 * Get a specific snapshot with full before/after data.
 *
 * @param {string} resource - Resource type
 * @param {string} id - Resource ID
 * @param {string} filename - Snapshot filename
 * @returns {Promise<Object|null>}
 */
export async function getSnapshot(resource, id, filename) {
  // Validate filename to prevent path traversal
  if (!filename.endsWith('.json') || filename.includes('/') || filename.includes('..')) {
    return null;
  }

  const filePath = join(getResourceDir(resource, id), filename);
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}
