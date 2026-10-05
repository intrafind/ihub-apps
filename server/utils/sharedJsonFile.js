import fs from 'fs/promises';
import path from 'path';
import { atomicWriteJSON } from './atomicWrite.js';
import { withFileLock } from './fileLock.js';

/**
 * A JSON file that several cluster workers read and write.
 *
 * The debounced whole-file store (`debouncedJsonStore.js`) keeps one copy per
 * worker and writes that copy back wholesale, so two workers silently
 * overwrite each other: a short link created on one worker was erased by the
 * next save of another, and a link deleted on one came back with the next save
 * of a worker that still had it.
 *
 * Here every change is a read-modify-write of the file on disk under a lock
 * file that every worker honours, and a read re-reads the file whenever it
 * changed since this worker last read it (inode, mtime and size; an atomic
 * write always replaces the inode). Meant for small files with infrequent
 * writes — every change rewrites the whole file.
 *
 * @param {Object} options
 * @param {string} options.filePath - Absolute path to the JSON file
 * @param {() => any} options.createDefault - Contents when the file is missing or unreadable
 * @param {string} [options.component] - Logger component for lock warnings
 * @returns {{read: () => Promise<any>, update: (mutate: (data: any) => any) => Promise<any>}}
 */
export function createSharedJsonFile({ filePath, createDefault, component = 'SharedJsonFile' }) {
  const lockPath = `${filePath}.lock`;
  let cached = null;
  let cachedStamp = null;

  async function stampOf() {
    try {
      const stat = await fs.stat(filePath);
      return `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
    } catch {
      return null;
    }
  }

  async function readFromDisk() {
    try {
      return JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch {
      return createDefault();
    }
  }

  /** The current contents; re-read only when the file changed. */
  async function read() {
    const stamp = await stampOf();
    if (cached === null || stamp !== cachedStamp) {
      cached = await readFromDisk();
      cachedStamp = stamp;
    }
    return cached;
  }

  /**
   * Change the file. `mutate` gets the contents as they are on disk now and
   * edits them in place; its return value is passed through. A throw leaves
   * the file untouched.
   */
  async function update(mutate) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    return withFileLock(
      lockPath,
      async () => {
        const data = await readFromDisk();
        const result = await mutate(data);
        await atomicWriteJSON(filePath, data);
        cached = data;
        cachedStamp = await stampOf();
        return result;
      },
      { component }
    );
  }

  return { read, update };
}
