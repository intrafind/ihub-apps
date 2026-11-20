// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Spool directories: where a payload waits on disk instead of in memory.
 *
 * A multipart upload (chat, scheduled task, Inference API, project) is written
 * to a spool file while it is received, and the archive `create_zip` builds is
 * written to one while it is built. Every spool lives in a directory of its own
 * under `contents/data/tmp/<area>/`:
 *
 * - the area directory and the spool directory are created `0700`, the file in
 *   it `0600`, so only the server's user reads them;
 * - the directory has a random name (`u-XXXXXX`) and the file a fixed one
 *   ({@link SPOOL_FILE_NAME}): the client's file name never reaches the disk;
 * - whoever created the directory removes it when the request (or the tool
 *   call) ends, on every path;
 * - {@link sweepSpoolDirs} removes what a crash left behind: directories older
 *   than {@link SPOOL_MAX_AGE_MS}, at start-up and on a timer.
 *
 * A spool file is **plaintext**, also when storage encryption is on: it exists
 * for the seconds between receiving a file and storing it (see
 * `docs/storage-encryption.md`).
 *
 * @module services/uploads/uploadSpool
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import multer from 'multer';
import { getContentsPath } from '../../utils/contentsPath.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'UploadSpool';

/** The name of the one file in a spool directory. */
export const SPOOL_FILE_NAME = 'upload';

/** A spool directory older than this belongs to nobody any more. */
export const SPOOL_MAX_AGE_MS = 60 * 60 * 1000;

/** Spool area of chat, scheduled-task and Inference API uploads. */
export const CHAT_UPLOAD_SPOOL_AREA = 'chat-uploads';

/** Spool area of the archives `create_zip` builds. */
export const ZIP_SPOOL_AREA = 'zip-spool';

/** The areas {@link startSpoolSweeper} looks after (project uploads have their own reconciler). */
const SWEPT_AREAS = [CHAT_UPLOAD_SPOOL_AREA, ZIP_SPOOL_AREA];

/** Spool directories this process is using right now; the sweep leaves them alone. */
const activeDirs = new Set();

/**
 * The directory of a spool area: `contents/data/tmp/<area>`.
 *
 * @param {string} area
 * @returns {string}
 */
export function spoolRoot(area) {
  return getContentsPath('data', 'tmp', area);
}

/**
 * A fresh private directory (`0700`) for one spool file.
 *
 * @param {string} root - From {@link spoolRoot}.
 * @param {Object} [options]
 * @param {boolean} [options.track=true] - Keep the directory out of this
 *   process's sweeps until {@link removeSpoolDir}. A caller that tells the
 *   sweep itself what is in use (`busy`) passes `false`.
 * @returns {Promise<string>} Absolute path of the new directory.
 */
export async function newSpoolDir(root, { track = true } = {}) {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const dir = await fs.mkdtemp(path.join(root, 'u-'));
  if (track) activeDirs.add(path.resolve(dir));
  return dir;
}

/**
 * Create the (empty) spool file of a directory with mode `0600` and return its
 * path. A writer that opens it afterwards (`flags: 'w'`) keeps the mode.
 *
 * @param {string} dir - From {@link newSpoolDir}.
 * @returns {Promise<string>}
 */
export async function createSpoolFile(dir) {
  const file = path.join(dir, SPOOL_FILE_NAME);
  const handle = await fs.open(file, 'wx', 0o600);
  await handle.close();
  return file;
}

/**
 * Remove a spool directory and what is in it. Never throws; a directory that
 * is gone already is fine.
 *
 * @param {string|null|undefined} dir
 * @returns {Promise<void>}
 */
export async function removeSpoolDir(dir) {
  if (!dir) return;
  activeDirs.delete(path.resolve(dir));
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch (error) {
    logger.warn('Could not remove a spool directory', {
      component: COMPONENT,
      error: error.message
    });
  }
}

/**
 * Remove the spool directories of an area that nobody uses any more: older
 * than `maxAgeMs` (by modification time: the moment the file landed in it) and
 * not in use by this process.
 *
 * @param {string} root - From {@link spoolRoot}.
 * @param {Object} [options]
 * @param {number} [options.now=Date.now()]
 * @param {number} [options.maxAgeMs=SPOOL_MAX_AGE_MS]
 * @param {Set<string>} [options.busy] - Resolved paths to keep whatever their age.
 * @returns {Promise<number>} How many directories were removed.
 */
export async function sweepSpoolDirs(
  root,
  { now = Date.now(), maxAgeMs = SPOOL_MAX_AGE_MS, busy = null } = {}
) {
  let entries = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const resolved = path.resolve(dir);
    if (activeDirs.has(resolved) || busy?.has(resolved)) continue;
    try {
      const stat = await fs.stat(dir);
      if (now - stat.mtimeMs < maxAgeMs) continue;
      await fs.rm(dir, { recursive: true, force: true });
      removed += 1;
    } catch {
      // Raced with its owner, or already gone.
    }
  }
  return removed;
}

/**
 * A multer storage engine that writes the one file of a request into a fresh
 * spool directory. The directory is reported through `onDir` before the first
 * byte is written, so the caller can remove it whatever happens next.
 *
 * @param {Object} options
 * @param {string|(() => string)} options.root - The area directory, or a function returning it.
 * @param {(req: import('express').Request, dir: string) => void} options.onDir
 * @param {(root: string) => Promise<string>} [options.newDir=newSpoolDir]
 * @returns {import('multer').StorageEngine}
 */
export function spoolStorage({ root, onDir, newDir = newSpoolDir }) {
  return multer.diskStorage({
    destination: (req, _file, cb) => {
      Promise.resolve()
        .then(() => newDir(typeof root === 'function' ? root() : root))
        .then(async dir => {
          onDir(req, dir);
          // Created 0600 here; multer opens it for writing and keeps the mode.
          await createSpoolFile(dir);
          return dir;
        })
        .then(
          dir => cb(null, dir),
          error => cb(error)
        );
    },
    filename: (_req, _file, cb) => cb(null, SPOOL_FILE_NAME)
  });
}

let sweepTimer = null;

/**
 * Sweep the chat-upload and ZIP spool areas now (start-up: what a crash left
 * behind) and every `intervalMs`.
 *
 * @param {{intervalMs?: number}} [options]
 * @returns {Promise<number>} Directories removed by the first sweep.
 */
export async function startSpoolSweeper({ intervalMs = 15 * 60 * 1000 } = {}) {
  const sweep = async () => {
    let removed = 0;
    for (const area of SWEPT_AREAS) {
      try {
        removed += await sweepSpoolDirs(spoolRoot(area));
      } catch (error) {
        logger.warn('Could not sweep a spool directory', {
          component: COMPONENT,
          area,
          error: error.message
        });
      }
    }
    if (removed) {
      logger.info('Removed abandoned spool directories', { component: COMPONENT, removed });
    }
    return removed;
  };
  const removed = await sweep();
  if (!sweepTimer) {
    sweepTimer = setInterval(sweep, intervalMs);
    sweepTimer.unref?.();
  }
  return removed;
}

/** Stop the sweep timer (shutdown and tests). */
export function stopSpoolSweeper() {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}
