/**
 * Shared-filesystem exclusivity primitives for cluster workers.
 *
 * Every worker of one installation sees the same `contents/` directory, so an
 * exclusively created file (`O_EXCL`) is the one compare-and-set the workers
 * have in common without a database or the cluster bus: whoever creates the
 * file first owns it. Two shapes are built on that:
 *
 *  - `withFileLock(path, fn)` — a short critical section (a lock file that is
 *    removed again when `fn` settles). A lock older than `staleMs` is treated
 *    as left behind by a dead process and taken over.
 *  - `tryCreateExclusive(path, content)` — a durable marker whose lifecycle
 *    the caller manages (e.g. "this interaction is being answered").
 *
 * @module utils/fileLock
 */
import { promises as fs } from 'fs';
import path from 'path';
import logger from './logger.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Create `filePath` with `content` unless it already exists.
 * @returns {Promise<boolean>} true when this call created the file
 */
export async function tryCreateExclusive(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.writeFile(filePath, content, { encoding: 'utf8', flag: 'wx' });
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  }
}

/**
 * Read a JSON marker file. Resolves `null` when the file does not exist;
 * `data` is `null` when it exists but does not (yet) hold valid JSON.
 * @returns {Promise<{data: Object|null, mtimeMs: number}|null>}
 */
export async function readJsonMarker(filePath) {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  let data = null;
  try {
    data = JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    data = null;
  }
  return { data, mtimeMs: stat.mtimeMs };
}

/** Remove a file, ignoring a missing one. */
export async function removeIfExists(filePath) {
  try {
    await fs.unlink(filePath);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Run `fn` while holding the lock file at `lockPath`.
 *
 * Waits (polling) for a lock held by another process; a lock older than
 * `staleMs` is assumed abandoned and removed. When the wait exceeds
 * `timeoutMs` the section runs anyway (with a warning) — the callers guard
 * bookkeeping, and blocking a request forever is worse than a rare unguarded
 * write.
 *
 * @param {string} lockPath
 * @param {() => Promise<T>} fn
 * @param {Object} [opts]
 * @param {number} [opts.staleMs=15000]
 * @param {number} [opts.timeoutMs=5000]
 * @param {number} [opts.pollMs=20]
 * @param {string} [opts.component='FileLock']
 * @returns {Promise<T>}
 * @template T
 */
export async function withFileLock(
  lockPath,
  fn,
  { staleMs = 15_000, timeoutMs = 5_000, pollMs = 20, component = 'FileLock' } = {}
) {
  const deadline = Date.now() + timeoutMs;
  const payload = JSON.stringify({ pid: process.pid, at: new Date().toISOString() });
  let held = false;
  for (;;) {
    if (await tryCreateExclusive(lockPath, payload)) {
      held = true;
      break;
    }
    const existing = await readJsonMarker(lockPath);
    if (!existing) continue; // released between the two calls — retry at once
    if (Date.now() - existing.mtimeMs > staleMs) {
      await removeIfExists(lockPath);
      continue;
    }
    if (Date.now() >= deadline) {
      logger.warn('Lock wait exceeded; continuing without the lock', {
        component,
        lockPath: path.basename(lockPath),
        timeoutMs
      });
      break;
    }
    await sleep(pollMs);
  }
  try {
    return await fn();
  } finally {
    if (held) await removeIfExists(lockPath);
  }
}

export default { withFileLock, tryCreateExclusive, readJsonMarker, removeIfExists };
