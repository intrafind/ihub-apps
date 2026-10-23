// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Startup import of admin project items that point at a file (spec 1 §8.4):
 *
 *  - an item with `import: { file, encoding? }` — written by the sources
 *    migration (V174) for a filesystem source, or shipped in
 *    `server/defaults/projects/` — is extracted, encrypted and stored
 *    through the ingest pipeline, after which the pointer is cleared and a
 *    plaintext copy under `contents/` is deleted, so no plaintext outlives
 *    the import (spec 3 §5);
 *  - an item with `managedFile` (the consolidated documentation) is
 *    re-imported from `server/defaults/` whenever the shipped file's sha256
 *    differs from the one recorded on the item.
 *
 * The file is looked up under `contents/sources/` first and
 * `server/defaults/sources/` second (the only places a filesystem source or
 * a shipped import file could live); any other path, or a symlink whose
 * target leaves that directory, is refused, so the importer never reads or
 * deletes configuration or other installation files. The import runs
 * once per boot, under the `project-import` lock when the storage provider
 * has one, so several workers do not import the same file at once.
 *
 * @module services/projects/projectImport
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import logger from '../../utils/logger.js';
import { getContentsPath } from '../../utils/contentsPath.js';
import { getRootDir } from '../../pathUtils.js';
import { resolveAndValidateRealPath } from '../../utils/pathSecurity.js';
import { getStorage } from '../../storage/bootstrap.js';
import { acceptedTypeOf } from './extractText.js';
import { getProjectService } from './ProjectService.js';

const COMPONENT = 'ProjectImport';
const LOCK_NAME = 'project-import';
const LOCK_OPTIONS = { ttlMs: 10 * 60 * 1000, waitMs: 1000 };

/** The shipped defaults directory. */
export function defaultsDir() {
  return path.join(getRootDir(), 'server', 'defaults');
}

/**
 * A relative file path that stays inside its base directory, or null.
 *
 * @param {string} file
 * @returns {string|null} The normalized relative path.
 */
export function safeRelativeFile(file) {
  if (typeof file !== 'string' || !file.trim()) return null;
  const normalized = path.posix.normalize(file.replace(/\\/g, '/'));
  if (path.posix.isAbsolute(normalized) || normalized === '.' || normalized.startsWith('..')) {
    return null;
  }
  if (normalized.split('/').some(segment => segment === '..' || segment === '')) return null;
  return normalized;
}

/** The one directory, relative to `contents/` and `server/defaults/`, that import files come from. */
export const IMPORT_DIR = 'sources';

/**
 * The real path of an import file inside `<baseDir>/sources/`, or null when
 * the path names another directory, is missing, or (through a symlink)
 * resolves outside it.
 *
 * @param {string} relative - Normalized relative path (from {@link safeRelativeFile}).
 * @param {string} baseDir - `contents/` or `server/defaults/`.
 * @returns {Promise<string|null>}
 */
async function resolveInImportDir(relative, baseDir) {
  if (!relative?.startsWith(`${IMPORT_DIR}/`)) return null;
  return resolveAndValidateRealPath(
    relative.slice(IMPORT_DIR.length + 1),
    path.join(baseDir, IMPORT_DIR)
  );
}

/**
 * Where an import pointer resolves: the installation's copy first, then
 * the shipped default.
 *
 * @param {string} file - Relative path.
 * @param {{contentsDir: string, defaultsDir: string}} dirs
 * @returns {Promise<{path: string, where: 'contents'|'defaults'}|null>}
 */
export async function resolveImportFile(file, dirs) {
  const relative = safeRelativeFile(file);
  if (!relative) return null;
  const inContents = await resolveInImportDir(relative, dirs.contentsDir);
  if (inContents) return { path: inContents, where: 'contents' };
  const inDefaults = await resolveInImportDir(relative, dirs.defaultsDir);
  if (inDefaults) return { path: inDefaults, where: 'defaults' };
  return null;
}

async function sha256Of(filePath) {
  const bytes = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function needsImport(item) {
  if (item?.import?.file) return item.status === 'pending' || item.status === 'failed';
  return false;
}

/**
 * Import every pending file-backed item of every admin project.
 *
 * @param {Object} [options]
 * @param {import('./ProjectService.js').ProjectService} [options.service]
 * @param {string} [options.contentsDir]
 * @param {string} [options.defaultsDir]
 * @param {boolean} [options.deleteImported=true] - Remove the plaintext copy under `contents/` once ready.
 * @returns {Promise<{scanned: number, imported: number, failed: number, skipped: number, locked?: boolean}>}
 */
export async function importPendingProjects({
  service = getProjectService(),
  contentsDir = getContentsPath(),
  defaultsDir: defaults = defaultsDir(),
  deleteImported = true
} = {}) {
  const run = () => importAll({ service, contentsDir, defaultsDir: defaults, deleteImported });
  const locks = getStorage()?.locks;
  if (!locks) return run();
  try {
    return await locks.withLock(LOCK_NAME, run, LOCK_OPTIONS);
  } catch (error) {
    if (/lock|lease|timeout|held/i.test(String(error?.message))) {
      logger.info('Project import skipped: another worker holds the import lock', {
        component: COMPONENT
      });
      return { scanned: 0, imported: 0, failed: 0, skipped: 0, locked: true };
    }
    throw error;
  }
}

async function importAll({ service, contentsDir, defaultsDir: defaults, deleteImported }) {
  const result = { scanned: 0, imported: 0, failed: 0, skipped: 0 };
  if (!service.ingest) {
    logger.warn('Project import skipped: the ingest pipeline is not available', {
      component: COMPONENT
    });
    return result;
  }
  const projects = await service.repository.listAdmin({ includeDisabled: true });
  // Several items may import the same file (two sources shared a path): the
  // plaintext copy goes only once the last of them is ready.
  const pointerUses = new Map();
  for (const project of projects) {
    for (const item of project.items || []) {
      const relative = needsImport(item) ? safeRelativeFile(item.import.file) : null;
      if (relative) pointerUses.set(relative, (pointerUses.get(relative) || 0) + 1);
    }
  }
  for (const project of projects) {
    for (const item of project.items || []) {
      result.scanned += 1;
      const where = { component: COMPONENT, projectId: project.id, itemId: item.id };
      try {
        if (needsImport(item)) {
          const outcome = await importFromPointer(project, item, {
            service,
            contentsDir,
            defaultsDir: defaults,
            deleteImported,
            pointerUses
          });
          result[outcome] += 1;
        } else if (item.managedFile) {
          const outcome = await importManaged(project, item, {
            service,
            contentsDir,
            defaultsDir: defaults,
            deleteImported
          });
          result[outcome] += 1;
        } else {
          result.skipped += 1;
        }
      } catch (error) {
        result.failed += 1;
        logger.error('Project item import failed', { ...where, error: error.message });
      }
    }
  }
  if (result.imported || result.failed) {
    logger.info('Project import finished', { component: COMPONENT, ...result });
  }
  return result;
}

async function importFromPointer(
  project,
  item,
  { service, contentsDir, defaultsDir: defaults, deleteImported, pointerUses = new Map() }
) {
  const where = { component: COMPONENT, projectId: project.id, itemId: item.id };
  const resolved = await resolveImportFile(item.import.file, {
    contentsDir,
    defaultsDir: defaults
  });
  if (!resolved) {
    await service.patchItem(project.id, item.id, entry => {
      entry.status = 'failed';
      entry.error = {
        code: 'IMPORT_MISSING',
        message: `The file to import was not found under ${IMPORT_DIR}/: ${String(item.import.file).slice(0, 300)}`
      };
    });
    logger.warn('Project item import file not found', { ...where, file: item.import.file });
    return 'failed';
  }
  const name = path.basename(resolved.path);
  const outcome = await service.ingest.start(
    project,
    item,
    {
      path: resolved.path,
      contentType: acceptedTypeOf({ name }) || 'text/plain',
      name,
      purpose: 'import'
    },
    { wait: true }
  );
  if (!outcome?.item) return 'failed';
  await service.patchItem(project.id, item.id, entry => {
    delete entry.import;
  });
  const relative = safeRelativeFile(item.import.file);
  const remaining = Math.max(0, (pointerUses.get(relative) || 1) - 1);
  pointerUses.set(relative, remaining);
  if (deleteImported && resolved.where === 'contents' && remaining === 0) {
    try {
      await fs.unlink(resolved.path);
      logger.info('Removed the imported plaintext file', { ...where, file: item.import.file });
    } catch (error) {
      logger.warn('Could not remove the imported plaintext file', {
        ...where,
        file: item.import.file,
        error: error.message
      });
    }
  }
  return 'imported';
}

async function importManaged(
  project,
  item,
  { service, contentsDir, defaultsDir: defaults, deleteImported }
) {
  const where = { component: COMPONENT, projectId: project.id, itemId: item.id };
  const relative = safeRelativeFile(item.managedFile);
  const filePath = relative ? await resolveInImportDir(relative, defaults) : null;
  if (!filePath) {
    if (item.status === 'ready') return 'skipped';
    await service.patchItem(project.id, item.id, entry => {
      entry.status = 'failed';
      entry.error = {
        code: 'IMPORT_MISSING',
        message: `The managed file was not found: ${String(item.managedFile).slice(0, 300)}`
      };
    });
    logger.warn('Managed project file not found in the defaults', {
      ...where,
      file: item.managedFile
    });
    return 'failed';
  }
  const sha = await sha256Of(filePath);
  // A copy an older release cut at the upload cap is read again, in full.
  if (item.status === 'ready' && item.managedSha256 === sha && item.text?.truncated !== true) {
    return 'skipped';
  }
  const name = path.basename(filePath);
  const outcome = await service.ingest.start(
    project,
    item,
    {
      path: filePath,
      contentType: acceptedTypeOf({ name }) || 'text/plain',
      name,
      previousBlobKey: item.text?.blobKey || null,
      purpose: 'import'
    },
    { wait: true }
  );
  if (!outcome?.item) return 'failed';
  await service.patchItem(project.id, item.id, entry => {
    entry.managedSha256 = sha;
    delete entry.import;
  });
  // The copy an older release synced into contents/ is plaintext too.
  const stale = contentsDir ? await resolveInImportDir(relative, contentsDir) : null;
  if (deleteImported && stale) {
    await fs
      .unlink(stale)
      .catch(error =>
        logger.warn('Could not remove the stale managed copy', { ...where, error: error.message })
      );
  }
  logger.info('Re-imported a managed project file', { ...where, file: item.managedFile });
  return 'imported';
}

export default importPendingProjects;
