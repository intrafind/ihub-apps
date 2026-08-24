import fs from 'fs/promises';
import path from 'path';
import { atomicWriteJSON } from './atomicWrite.js';
import logger from './logger.js';

/**
 * Create a debounced whole-file JSON store: lazy load-or-default, a dirty
 * flag, a debounced save with an unref'd periodic safety-net flush, and
 * atomic writes so a crash mid-write can't corrupt the file.
 *
 * Shared by usageTracker.js and shortLinkManager.js, which both load one
 * JSON object, mutate it in place, and debounce-save it back to disk.
 *
 * @param {Object} options
 * @param {string} options.filePath - Absolute path to the JSON file
 * @param {() => any} options.createDefault - Returns the default shape when the file is missing/unreadable
 * @param {number} [options.saveIntervalMs=10000] - Debounce/periodic-safety-net interval
 * @param {string} [options.component] - Logger component name for error messages
 * @param {(data: any) => void} [options.onBeforeSave] - Called just before serializing, e.g. to stamp lastUpdated
 */
export function createDebouncedJsonStore({
  filePath,
  createDefault,
  saveIntervalMs = 10000,
  component = 'DebouncedJsonStore',
  onBeforeSave
}) {
  let data = null;
  let dirty = false;
  let saveTimer = null;

  async function load() {
    if (data) return data;
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      data = JSON.parse(raw);
    } catch {
      data = createDefault();
    }
    return data;
  }

  async function flush() {
    if (!data || !dirty) return;
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    onBeforeSave?.(data);
    await atomicWriteJSON(filePath, data);
    dirty = false;
  }

  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(async () => {
      saveTimer = null;
      try {
        await flush();
      } catch (error) {
        logger.error(`Failed to save ${component} data`, { component, error });
      }
    }, saveIntervalMs);
    if (typeof saveTimer.unref === 'function') saveTimer.unref();
  }

  function markDirty() {
    dirty = true;
    scheduleSave();
  }

  // Wholesale-replaces the in-memory data (e.g. a reset-to-defaults action)
  // rather than mutating the existing object in place.
  function replace(newData) {
    data = newData;
    dirty = true;
  }

  // Periodic safety-net flush: the debounced timer above clears itself before
  // running, so if a save throws, nothing re-arms it — this interval
  // guarantees a dirty store eventually drains even with no further writes.
  const periodicFlush = setInterval(() => {
    if (dirty) {
      flush().catch(error =>
        logger.error(`${component} periodic save error`, { component, error })
      );
    }
  }, saveIntervalMs);
  if (typeof periodicFlush.unref === 'function') periodicFlush.unref();

  function stop() {
    clearInterval(periodicFlush);
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
  }

  return { load, markDirty, replace, flush, stop };
}
