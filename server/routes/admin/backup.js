import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { ZipArchive } from 'archiver';
import yauzl from 'yauzl';
import configCache from '../../configCache.js';
import { announceFullConfigReload } from '../../configSync.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { resolveAndValidatePath } from '../../utils/pathSecurity.js';
import logger from '../../utils/logger.js';
import {
  sendInternalError,
  sendBadRequest,
  sendErrorResponse
} from '../../utils/responseHelpers.js';
import { runConfigMigrations } from '../../migrations/runner.js';
import { logAudit } from '../../services/AuditLogService.js';
import { getContentsPath } from '../../utils/contentsPath.js';

/**
 * The directory name the backup archive files the contents under.
 *
 * Fixed rather than taken from `CONTENTS_DIR`, so a backup made on one
 * installation imports into another whatever each names its contents directory.
 */
const ARCHIVE_CONTENTS_DIR = 'contents';

/**
 * Prefix of the per-upload directory an imported archive and its extracted
 * contents live in. {@link removeUploadDir} only ever deletes directories
 * carrying it.
 */
const IMPORT_UPLOAD_DIR_PREFIX = 'ihub-import-';

/**
 * Folder inside the contents directory holding what an import replaced, one
 * `<timestamp>/` folder per import, and the import's staging area while it runs.
 *
 * Inside the contents directory because that is the one place the server can
 * always write to and rename within: in a container the contents directory is a
 * volume mount point, which cannot be renamed, and its parent belongs to root.
 * Never exported, and never restored from an archive.
 */
export const IMPORT_BACKUPS_DIR = '.backups';

/** Prefix of the staging folder inside {@link IMPORT_BACKUPS_DIR}. */
const IMPORT_STAGING_PREFIX = '.staging-';

/** How many import backups are kept; older ones are removed after an import. */
const IMPORT_BACKUPS_TO_KEEP = 3;

/** A staging folder this old is left over from an import that crashed. */
const STALE_STAGING_AGE_MS = 60 * 60 * 1000;

/**
 * Remove the private directory an import upload was stored in.
 *
 * `dir` is the directory this module created for the upload (recorded on the
 * request when it was made), never a path taken from the request itself. It is
 * still refused unless it is a direct child of the system temp directory with
 * the import prefix, so this can never become a recursive delete of anything else.
 *
 * @param {string} dir - Upload directory created by the upload storage below.
 * @returns {Promise<void>}
 */
async function removeUploadDir(dir) {
  if (
    path.dirname(dir) !== os.tmpdir() ||
    !path.basename(dir).startsWith(IMPORT_UPLOAD_DIR_PREFIX)
  ) {
    return;
  }
  await fs.rm(dir, { recursive: true, force: true });
}

/**
 * Get all files recursively from a directory
 */
async function getAllFiles(dirPath, arrayOfFiles = [], skipPaths = new Set()) {
  try {
    const files = await fs.readdir(dirPath, { withFileTypes: true });

    for (const file of files) {
      const fullPath = path.join(dirPath, file.name);
      if (skipPaths.has(fullPath)) {
        continue;
      }
      if (file.isDirectory()) {
        arrayOfFiles = await getAllFiles(fullPath, arrayOfFiles, skipPaths);
      } else {
        arrayOfFiles.push(fullPath);
      }
    }
  } catch (error) {
    logger.warn('Could not read directory', {
      component: 'AdminBackup',
      dirPath,
      error: error.message
    });
  }

  return arrayOfFiles;
}

/**
 * The configuration files under the contents directory, without the backups
 * earlier imports left in {@link IMPORT_BACKUPS_DIR}.
 */
function getConfigurationFiles(contentsPath) {
  return getAllFiles(contentsPath, [], new Set([path.join(contentsPath, IMPORT_BACKUPS_DIR)]));
}

/**
 * Ensure directory exists, create if it doesn't
 */
async function ensureDir(dirPath) {
  try {
    await fs.access(dirPath);
  } catch {
    await fs.mkdir(dirPath, { recursive: true });
  }
}

/**
 * Extract ZIP file to destination directory.
 * Returns the number of contents files successfully extracted.
 */
function extractZip(zipPath, extractPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, async (err, zipfile) => {
      if (err) {
        reject(err);
        return;
      }

      // The path validator (resolveAndValidatePath) calls fs.realpath() on the
      // base directory, so the contents/ base must exist before we start
      // validating entries — otherwise every entry is rejected as a path
      // traversal and the import silently extracts nothing.
      const contentsBase = path.join(extractPath, ARCHIVE_CONTENTS_DIR);
      try {
        await ensureDir(contentsBase);
      } catch (mkdirErr) {
        reject(mkdirErr);
        return;
      }

      let extractedCount = 0;

      zipfile.readEntry();

      zipfile.on('entry', async entry => {
        logger.info('ZIP entry', { component: 'AdminBackup', fileName: entry.fileName });

        // Skip directories
        if (/\/$/.test(entry.fileName)) {
          logger.info('Skipping directory', { component: 'AdminBackup', fileName: entry.fileName });
          zipfile.readEntry();
          return;
        }

        // Skip macOS metadata files
        if (
          entry.fileName.includes('__MACOSX/') ||
          entry.fileName.includes('.DS_Store') ||
          entry.fileName.startsWith('._')
        ) {
          logger.info('Skipping metadata', { component: 'AdminBackup', fileName: entry.fileName });
          zipfile.readEntry();
          return;
        }

        // Check if this is a contents file (either direct contents/ or nested */contents/)
        const contentsMatch = entry.fileName.match(/(?:^|.*\/)contents\/(.+)$/);
        if (!contentsMatch) {
          logger.info('Skipping non-contents file', {
            component: 'AdminBackup',
            fileName: entry.fileName
          });
          zipfile.readEntry();
          return;
        }

        // Extract the relative path within contents/
        const relativePath = contentsMatch[1];

        // Backups of earlier imports belong to the installation they were made
        // on; restoring them would also write into the import's own work area.
        if (relativePath.split('/')[0] === IMPORT_BACKUPS_DIR) {
          logger.info('Skipping import backup entry', {
            component: 'AdminBackup',
            fileName: entry.fileName
          });
          zipfile.readEntry();
          return;
        }

        const entryPath = await resolveAndValidatePath(relativePath, contentsBase);

        // Prevent ZIP slip: skip entries that would escape the extract directory
        if (!entryPath) {
          logger.warn('Skipping ZIP entry with path traversal', {
            component: 'AdminBackup',
            fileName: entry.fileName
          });
          zipfile.readEntry();
          return;
        }

        logger.info('Extracting ZIP entry', {
          component: 'AdminBackup',
          fileName: entry.fileName,
          relativePath
        });

        // Ensure the directory exists
        await ensureDir(path.dirname(entryPath));

        // Extract file
        zipfile.openReadStream(entry, (err, readStream) => {
          if (err) {
            reject(err);
            return;
          }

          const writeStream = createWriteStream(entryPath);
          readStream.pipe(writeStream);

          writeStream.on('close', () => {
            extractedCount++;
            zipfile.readEntry();
          });

          writeStream.on('error', err => {
            reject(err);
          });
        });
      });

      zipfile.on('end', () => {
        resolve(extractedCount);
      });

      zipfile.on('error', err => {
        reject(err);
      });
    });
  });
}

/**
 * Export configuration as ZIP file
 */
export async function exportConfig(req, res) {
  try {
    logger.info('Starting configuration export', { component: 'AdminBackup' });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `ihub-config-backup-${timestamp}.zip`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const archive = new ZipArchive({
      zlib: { level: 9 } // Maximum compression
    });

    archive.on('error', err => {
      logger.error('Archive error', { component: 'AdminBackup', error: err });
      if (!res.headersSent) {
        sendInternalError(res, err, 'create backup archive');
      }
    });

    // Pipe archive data to response
    archive.pipe(res);

    // Get all files from contents directory
    const contentsPath = getContentsPath();
    const allFiles = await getConfigurationFiles(contentsPath);

    let fileCount = 0;

    for (const filePath of allFiles) {
      try {
        // Path inside the archive, under ARCHIVE_CONTENTS_DIR whatever the
        // live directory is called. ZIP entry names are `/`-separated.
        const relativePath = path.posix.join(
          ARCHIVE_CONTENTS_DIR,
          ...path.relative(contentsPath, filePath).split(path.sep)
        );

        // Debug logging
        logger.info('Adding to archive', { component: 'AdminBackup', relativePath, filePath });

        // Add file to archive
        archive.file(filePath, { name: relativePath });
        fileCount++;
      } catch (error) {
        logger.warn('Could not add file to archive', {
          component: 'AdminBackup',
          filePath,
          error: error.message
        });
      }
    }

    logger.info('Added files to backup archive', { component: 'AdminBackup', fileCount });

    // Add metadata file with backup information
    const metadata = {
      backupDate: new Date().toISOString(),
      version: '1.0',
      description: 'iHub Apps Configuration Backup',
      fileCount: fileCount,
      note: 'This backup includes all configuration files, custom pages, apps, models, and frontend customizations (CSS, HTML, etc.)'
    };

    archive.append(JSON.stringify(metadata, null, 2), { name: 'backup-metadata.json' });

    await archive.finalize();
    await logAudit({
      req,
      action: 'export',
      resource: 'backup',
      resourceId: 'backup',
      summary: `Exported configuration backup (${fileCount} files)`
    });
    logger.info('Configuration export completed', { component: 'AdminBackup' });
  } catch (error) {
    logger.error('Export error', { component: 'AdminBackup', error });
    if (!res.headersSent) {
      return sendInternalError(res, error, 'export configuration');
    }
  }
}

/**
 * What an admin can do about a filesystem error during an import, by error code.
 * The import runs as the server's user inside the contents directory, so these
 * are the failures a deployment can actually cause.
 */
const IMPORT_FS_ERROR_HINTS = {
  EACCES:
    'The server is not allowed to write in the configuration directory. Make sure the user running iHub owns the contents directory and everything in it.',
  EPERM:
    'The server is not allowed to write in the configuration directory. Make sure the user running iHub owns the contents directory and everything in it.',
  EROFS: 'The configuration directory is on a read-only filesystem.',
  ENOSPC:
    'Not enough disk space. An import needs room for a second copy of the configuration next to the current one.',
  EDQUOT:
    'The disk quota is exhausted. An import needs room for a second copy of the configuration next to the current one.',
  EBUSY:
    'A folder inside the contents directory is a separate mount point, which cannot be replaced. Mount the volume on the contents directory itself (or its parent), not on folders inside it.',
  EXDEV:
    'A folder inside the contents directory is on a separate filesystem, which cannot be replaced. Mount the volume on the contents directory itself (or its parent), not on folders inside it.'
};

/**
 * An import step failed on the filesystem: an error whose message says what
 * happened to the live configuration and, where known, how to fix the cause.
 *
 * @param {string} outcome - What the failure means for the live configuration.
 * @param {Error} cause - The underlying filesystem error.
 * @param {string} [mountPoint] - Folder (relative to the contents directory) the
 *   failure came from, when that folder is a separate mount point.
 * @returns {Error} Error carrying `adminMessage`, safe to show to an admin.
 */
function importStepError(outcome, cause, mountPoint) {
  const hint = mountPoint
    ? `The folder "${mountPoint}" in the contents directory is a separate mount point, which cannot be replaced. Mount the volume on the contents directory itself (or its parent), not on folders inside it.`
    : IMPORT_FS_ERROR_HINTS[cause?.code];
  const adminMessage = hint ? `${outcome}. ${hint} (${cause.code})` : `${outcome}.`;
  const error = new Error(`${outcome}: ${cause?.message ?? cause}`, { cause });
  error.adminMessage = adminMessage;
  return error;
}

/**
 * The entry of the contents directory a failed rename was about, if that entry
 * is a mount point of its own. Moving one fails with EBUSY as root but with
 * EACCES for any other user, so the error code alone would blame permissions.
 *
 * @param {string} contentsPath - Live contents directory.
 * @param {Error} error - Error from fs.rename, carrying `path` and `dest`.
 * @returns {Promise<string|undefined>} Entry name relative to the contents directory.
 */
async function findMountPointEntry(contentsPath, error) {
  for (const candidate of [error?.path, error?.dest]) {
    if (candidate && path.dirname(candidate) === contentsPath && (await isMountPoint(candidate))) {
      return path.basename(candidate);
    }
  }
  return undefined;
}

/**
 * Whether `target` is a mount point. Docker volumes are bind mounts from the
 * host's filesystem and share its device id, so on Linux the mount table is
 * the reliable answer; elsewhere a device change from the parent is.
 *
 * @param {string} target - Absolute path.
 * @returns {Promise<boolean>}
 */
async function isMountPoint(target) {
  try {
    const resolved = await fs.realpath(target);
    try {
      const mountInfo = await fs.readFile('/proc/self/mountinfo', 'utf8');
      // Field 5 is the mount point, with spaces and the like escaped as \ooo.
      return mountInfo
        .split('\n')
        .map(line =>
          line
            .split(' ')[4]
            ?.replace(/\\([0-7]{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)))
        )
        .includes(resolved);
    } catch {
      const [entry, parent] = await Promise.all([
        fs.stat(resolved),
        fs.stat(path.dirname(resolved))
      ]);
      return entry.dev !== parent.dev;
    }
  } catch {
    // Not there (any more); not a mount point we can name.
    return false;
  }
}

/**
 * Undo recorded renames, newest first.
 *
 * @param {Array<[string, string]>} moves - `[from, to]` pairs, in the order done.
 * @returns {Promise<Error|null>} The first error, or null if every move was undone.
 */
async function undoMoves(moves) {
  let firstError = null;
  for (const [from, to] of [...moves].reverse()) {
    try {
      await fs.rename(to, from);
    } catch (error) {
      firstError ??= error;
      logger.error('Could not undo import move', { component: 'AdminBackup', from, to, error });
    }
  }
  return firstError;
}

/**
 * Best-effort removal of an import work folder. A leftover folder is harmless
 * (old staging folders are pruned later), so a failure is only logged.
 *
 * @param {string} target - Folder to remove.
 * @param {object} [options] - `{ onlyIfEmpty: true }` uses rmdir, which refuses
 *   a folder that still holds anything.
 */
async function removeImportFolder(target, { onlyIfEmpty = false } = {}) {
  try {
    await (onlyIfEmpty ? fs.rmdir(target) : fs.rm(target, { recursive: true, force: true }));
  } catch (error) {
    logger.warn('Could not remove import folder', { component: 'AdminBackup', target, error });
  }
}

/**
 * Refuse a copy source outside the extraction root (it is derived from the
 * uploaded file's temp path) and a backup name that is not a plain folder name.
 */
function assertImportPaths(extractRoot, extractedContentsPath, backupName) {
  const resolvedExtractRoot = path.resolve(extractRoot);
  const extractRootWithSep = resolvedExtractRoot.endsWith(path.sep)
    ? resolvedExtractRoot
    : resolvedExtractRoot + path.sep;
  if (!path.resolve(extractedContentsPath).startsWith(extractRootWithSep)) {
    throw new Error('Refusing to stage imported configuration: source path is invalid.');
  }
  if (path.basename(backupName) !== backupName || backupName.startsWith('.')) {
    throw new Error('Refusing to stage imported configuration: backup name is invalid.');
  }
}

/**
 * Copy the extracted configuration into the staging folder and create the
 * (empty) backup folder. On failure nothing of either is left behind.
 */
async function stageImport({ sourcePath, stagingPath, backupPath }) {
  const skippedSource = path.join(sourcePath, IMPORT_BACKUPS_DIR);
  let backupCreated = false;
  try {
    await fs.mkdir(path.dirname(backupPath), { recursive: true });
    await fs.mkdir(backupPath);
    backupCreated = true;
    await fs.cp(sourcePath, stagingPath, {
      recursive: true,
      filter: source => source !== skippedSource
    });
  } catch (error) {
    await removeImportFolder(stagingPath);
    if (backupCreated) {
      await removeImportFolder(backupPath, { onlyIfEmpty: true });
    }
    throw importStepError(
      'Failed to stage the imported configuration; the live configuration was not modified',
      error
    );
  }
}

/**
 * Move every top-level entry of the live contents (except the backups folder)
 * into the backup folder, then every staged entry into the live contents.
 *
 * @returns {Promise<Array<[string, string]>>} The renames done, in order.
 * @throws The rename error, with `moves` set to the renames done before it.
 */
async function swapEntries({ liveContentsPath, stagingPath, backupPath }) {
  const moves = [];
  const move = async (from, to) => {
    await fs.rename(from, to);
    moves.push([from, to]);
  };
  try {
    const liveEntries = await fs.readdir(liveContentsPath);
    for (const name of liveEntries.filter(entry => entry !== IMPORT_BACKUPS_DIR)) {
      await move(path.join(liveContentsPath, name), path.join(backupPath, name));
    }
    for (const name of await fs.readdir(stagingPath)) {
      await move(path.join(stagingPath, name), path.join(liveContentsPath, name));
    }
  } catch (error) {
    error.moves = moves;
    throw error;
  }
  return moves;
}

/**
 * Stage an extracted configuration and swap it in for the live one, keeping the
 * replaced configuration in `<contents>/.backups/<backupName>/`.
 *
 * The contents directory itself is never renamed or removed: in a container it
 * is a volume mount point, which Linux refuses to rename (EBUSY), and its
 * parent is not writable for the server (EACCES). Instead each top-level entry
 * is renamed, all within the contents directory and so on one filesystem. Every
 * rename is recorded; if one fails, the recorded ones are undone so the live
 * configuration is exactly what it was. Staging failures leave it untouched.
 *
 * @param {object} params
 * @param {string} params.contentsPath - Live contents directory.
 * @param {string} params.extractedContentsPath - Source directory (from the extracted ZIP).
 * @param {string} params.extractRoot - Directory extractedContentsPath must resolve within
 *   (the temp extraction directory) — validated to guard against a tainted/traversal path.
 * @param {string} params.backupName - Folder name for the replaced configuration.
 * @returns {Promise<string>} Absolute path of the backup folder.
 */
export async function stageAndSwapContents({
  contentsPath: liveContentsPath,
  extractedContentsPath,
  extractRoot,
  backupName
}) {
  assertImportPaths(extractRoot, extractedContentsPath, backupName);

  const backupsRoot = path.join(liveContentsPath, IMPORT_BACKUPS_DIR);
  const stagingPath = path.join(backupsRoot, `${IMPORT_STAGING_PREFIX}${backupName}`);
  const backupPath = path.join(backupsRoot, backupName);

  await stageImport({ sourcePath: path.resolve(extractedContentsPath), stagingPath, backupPath });

  try {
    await swapEntries({ liveContentsPath, stagingPath, backupPath });
  } catch (error) {
    const undoError = await undoMoves(error.moves ?? []);
    const mountPoint = await findMountPointEntry(liveContentsPath, error);
    if (undoError) {
      // Leave staging and backup in place: they hold whatever could not be moved back.
      throw importStepError(
        `Failed to activate the imported configuration, and the rollback failed as well; the previous configuration is in ${IMPORT_BACKUPS_DIR}/${backupName}`,
        error,
        mountPoint
      );
    }
    await removeImportFolder(stagingPath);
    await removeImportFolder(backupPath, { onlyIfEmpty: true });
    throw importStepError(
      'Failed to activate the imported configuration; rolled back to the previous configuration',
      error,
      mountPoint
    );
  }

  await removeImportFolder(stagingPath);
  return backupPath;
}

/**
 * Staging folders in `backupsRoot` old enough to be left over from an import
 * that crashed; a younger one may belong to an import still running.
 *
 * @param {string} backupsRoot - The {@link IMPORT_BACKUPS_DIR} folder.
 * @param {import('node:fs').Dirent[]} entries - Its entries.
 * @returns {Promise<string[]>} Folder names.
 */
async function findStaleStagingFolders(backupsRoot, entries) {
  const staging = entries.filter(
    entry => entry.isDirectory() && entry.name.startsWith(IMPORT_STAGING_PREFIX)
  );
  const stale = [];
  for (const entry of staging) {
    const { mtimeMs } = await fs.stat(path.join(backupsRoot, entry.name));
    if (Date.now() - mtimeMs > STALE_STAGING_AGE_MS) {
      stale.push(entry.name);
    }
  }
  return stale;
}

/**
 * Remove all but the newest {@link IMPORT_BACKUPS_TO_KEEP} import backups, and
 * staging folders left behind by an import that crashed.
 *
 * Backups sit on the same volume as the live configuration, so without this
 * every import would grow it by a full copy.
 *
 * @param {string} contentsPath - Live contents directory.
 */
export async function pruneImportBackups(contentsPath) {
  const backupsRoot = path.join(contentsPath, IMPORT_BACKUPS_DIR);
  try {
    const entries = await fs.readdir(backupsRoot, { withFileTypes: true });
    const backups = entries
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(entry => entry.name)
      .sort()
      .reverse();
    const expired = [
      ...backups.slice(IMPORT_BACKUPS_TO_KEEP),
      ...(await findStaleStagingFolders(backupsRoot, entries))
    ];

    for (const name of expired) {
      await fs.rm(path.join(backupsRoot, name), { recursive: true, force: true });
      logger.info('Removed old import backup', { component: 'AdminBackup', name });
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      return;
    }
    logger.warn('Could not prune old import backups', { component: 'AdminBackup', error });
  }
}

/**
 * Import configuration from uploaded ZIP file
 */
export async function importConfig(req, res) {
  const contentsPath = getContentsPath();
  let tempZipPath = null;
  let tempExtractPath = null;

  try {
    logger.info('Starting configuration import', { component: 'AdminBackup' });

    // Check if file was uploaded
    if (!req.file) {
      return sendBadRequest(res, 'No ZIP file uploaded');
    }

    tempZipPath = req.file.path;
    tempExtractPath = path.join(path.dirname(tempZipPath), `extract_${Date.now()}`);

    logger.info('Extracting ZIP file', { component: 'AdminBackup', tempExtractPath });

    // Extract ZIP file
    await fs.mkdir(tempExtractPath, { recursive: true });
    const extractedCount = await extractZip(tempZipPath, tempExtractPath);

    // Debug: List what was actually extracted
    const extractedItems = await fs.readdir(tempExtractPath, { withFileTypes: true });
    logger.info('Extracted items from ZIP', {
      component: 'AdminBackup',
      items: extractedItems.map(item => `${item.name}${item.isDirectory() ? '/' : ''}`),
      extractedCount
    });

    // Verify the ZIP actually contained contents/ files
    const extractedContentsPath = path.join(tempExtractPath, ARCHIVE_CONTENTS_DIR);
    if (extractedCount === 0) {
      return sendBadRequest(res, 'Invalid backup file: No contents directory found');
    }

    // Get backup metadata if available
    let metadata = null;
    try {
      const metadataPath = path.join(tempExtractPath, 'backup-metadata.json');
      const metadataContent = await fs.readFile(metadataPath, 'utf-8');
      metadata = JSON.parse(metadataContent);
      logger.info('Backup metadata loaded', { component: 'AdminBackup', metadata });
    } catch {
      logger.info('No metadata found in backup (this is normal for manual backups)', {
        component: 'AdminBackup'
      });
    }

    // Milliseconds included so two imports in the same second get their own backup.
    const backupName = new Date().toISOString().replace(/[:.]/g, '-');

    logger.info('Staging and swapping in imported configuration', {
      component: 'AdminBackup',
      backupName
    });

    try {
      await stageAndSwapContents({
        contentsPath,
        extractedContentsPath,
        extractRoot: tempExtractPath,
        backupName
      });
    } catch (error) {
      logger.error('Failed to swap in imported configuration', { component: 'AdminBackup', error });
      if (error.adminMessage) {
        return sendErrorResponse(res, 500, error.adminMessage);
      }
      throw error;
    }

    logger.info('Configuration files replaced', { component: 'AdminBackup' });
    await pruneImportBackups(contentsPath);

    // Run pending migrations against the imported configuration. The backup
    // carries contents/.migration-history.json, so the runner only applies the
    // delta between the backup's version and this server's available migrations.
    let migrationResult = null;
    let migrationError = null;
    try {
      logger.info('Running configuration migrations on imported files', {
        component: 'AdminBackup'
      });
      migrationResult = await runConfigMigrations();
      logger.info('Migrations complete', { component: 'AdminBackup', migrationResult });
    } catch (error) {
      migrationError = error.message;
      logger.error('Migration failed during import', { component: 'AdminBackup', error });
      // Continue with cache reload — the contents are already replaced, and the
      // admin needs to see the partial state plus the error in the response.
    }

    // Reload configuration cache
    logger.info('Reloading configuration cache', { component: 'AdminBackup' });
    await configCache.clear();
    await configCache.initialize();
    // An import replaces every file under contents/, so the other workers have
    // to drop everything they hold rather than a named set of entries.
    announceFullConfigReload();
    logger.info('Configuration cache reloaded', { component: 'AdminBackup' });

    // Count imported files
    const importedFiles = await getConfigurationFiles(contentsPath);

    await logAudit({
      req,
      action: 'import',
      resource: 'backup',
      resourceId: 'backup',
      summary: `Imported configuration backup (${importedFiles.length} files)`
    });
    res.json({
      success: true,
      message: migrationError
        ? 'Configuration imported, but one or more migrations failed. See server logs and the migrations field for details.'
        : 'Configuration imported successfully',
      importedFiles: importedFiles.length,
      backupPath: `${IMPORT_BACKUPS_DIR}/${backupName}`,
      metadata: metadata,
      migrations: migrationResult,
      migrationError,
      note: 'All configurations have been replaced and cache has been reloaded. Frontend customizations (CSS, HTML, etc.) are included if they were in the backup.'
    });

    logger.info('Configuration import completed', {
      component: 'AdminBackup',
      importedCount: importedFiles.length
    });
  } catch (error) {
    logger.error('Import error', { component: 'AdminBackup', error });
    sendInternalError(res, error, 'import configuration');
  } finally {
    // Clean up temporary files
    try {
      if (tempZipPath) {
        await fs.unlink(tempZipPath);
      }
      if (tempExtractPath) {
        await fs.rm(tempExtractPath, { recursive: true, force: true });
      }
      if (req.importUploadDir) {
        await removeUploadDir(req.importUploadDir);
      }
    } catch (error) {
      logger.warn('Could not clean up temporary files', { component: 'AdminBackup', error });
    }
  }
}

/**
 * Register backup routes
 */
export default async function registerBackupRoutes(app) {
  // Setup multer for file uploads
  const multer = (await import('multer')).default;
  // The archive and the contents extracted from it hold the whole configuration,
  // secrets included, so each upload gets a private (mode 0700) directory instead
  // of sharing the system temp directory with every other local user.
  const storage = multer.diskStorage({
    destination: (req, _file, cb) => {
      fs.mkdtemp(path.join(os.tmpdir(), IMPORT_UPLOAD_DIR_PREFIX)).then(dir => {
        req.importUploadDir = dir;
        cb(null, dir);
      }, cb);
    }
  });
  const upload = multer({
    storage,
    limits: {
      fileSize: 100 * 1024 * 1024 // 100MB limit
    },
    fileFilter: (req, file, cb) => {
      if (file.mimetype === 'application/zip' || file.originalname.endsWith('.zip')) {
        cb(null, true);
      } else {
        cb(new Error('Only ZIP files are allowed'), false);
      }
    }
  });

  // Export configuration
  app.get(buildServerPath('/api/admin/backup/export'), adminAuth, exportConfig);

  // Import configuration
  app.post(
    buildServerPath('/api/admin/backup/import'),
    adminAuth,
    upload.single('backup'),
    importConfig
  );
}
