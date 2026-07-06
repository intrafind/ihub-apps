import path from 'path';
import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import archiver from 'archiver';
import yauzl from 'yauzl';
import configCache from '../../configCache.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { getContentsPath } from '../../utils/contentsPath.js';
import { resolveAndValidatePath } from '../../utils/pathSecurity.js';
import logger from '../../utils/logger.js';
import { sendInternalError, sendBadRequest } from '../../utils/responseHelpers.js';
import { runConfigMigrations } from '../../migrations/runner.js';
import { logAudit } from '../../services/AuditLogService.js';

// Define the contents directory path
const contentsPath = getContentsPath();
const contentsDirName = path.basename(contentsPath);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Get all files recursively from a directory
 */
async function getAllFiles(dirPath, arrayOfFiles = []) {
  try {
    const files = await fs.readdir(dirPath, { withFileTypes: true });

    for (const file of files) {
      const fullPath = path.join(dirPath, file.name);
      if (file.isDirectory()) {
        arrayOfFiles = await getAllFiles(fullPath, arrayOfFiles);
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
      const contentsBase = path.join(extractPath, contentsDirName);
      try {
        await ensureDir(contentsBase);
      } catch (mkdirErr) {
        reject(mkdirErr);
        return;
      }

      let extractedCount = 0;
      const backupContentsEntryPattern = new RegExp(
        `(?:^|.*\\/)${escapeRegExp(contentsDirName)}\\/(.+)$`
      );

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
        const contentsMatch = entry.fileName.match(backupContentsEntryPattern);
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

    const archive = archiver('zip', {
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
    const allFiles = await getAllFiles(contentsPath);

    let fileCount = 0;

    for (const filePath of allFiles) {
      try {
        // Get relative path from project root
        const relativePath = path.relative(path.dirname(contentsPath), filePath);

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
 * Import configuration from uploaded ZIP file
 */
export async function importConfig(req, res) {
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
    const extractedContentsPath = path.join(tempExtractPath, contentsDirName);
    if (extractedCount === 0) {
      return sendBadRequest(res, `Invalid backup file: No ${contentsDirName} directory found`);
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

    // Create backup of current configuration
    const backupTimestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const currentBackupPath = path.join(
      path.dirname(contentsPath),
      `${contentsDirName}-backup-${backupTimestamp}`
    );

    logger.info('Creating backup of current configuration', {
      component: 'AdminBackup',
      currentBackupPath
    });

    try {
      await fs.cp(contentsPath, currentBackupPath, { recursive: true });
      logger.info('Current configuration backed up', { component: 'AdminBackup' });
    } catch (error) {
      logger.error('Could not backup current configuration', { component: 'AdminBackup', error });
      // Continue with import but warn user
    }

    // Replace contents directory with imported one
    logger.info('Replacing configuration files', { component: 'AdminBackup' });

    // Remove current contents (but keep backup)
    await fs.rm(contentsPath, { recursive: true, force: true });

    // Copy extracted contents
    await fs.cp(extractedContentsPath, contentsPath, { recursive: true });

    logger.info('Configuration files replaced', { component: 'AdminBackup' });

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
    logger.info('Configuration cache reloaded', { component: 'AdminBackup' });

    // Count imported files
    const importedFiles = await getAllFiles(contentsPath);

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
      backupPath: path.basename(currentBackupPath),
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
  const upload = multer({
    dest: '/tmp/',
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
