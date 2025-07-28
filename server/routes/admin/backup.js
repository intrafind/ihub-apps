import path from 'path';
import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import archiver from 'archiver';
import yauzl from 'yauzl';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import configCache from '../../configCache.js';
import { authRequired } from '../../middleware/authRequired.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Define the contents directory path
const contentsPath = path.join(__dirname, '../../../contents');

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
    console.warn(`Warning: Could not read directory ${dirPath}:`, error.message);
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
 * Extract ZIP file to destination directory
 */
function extractZip(zipPath, extractPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err) {
        reject(err);
        return;
      }

      zipfile.readEntry();

      zipfile.on('entry', async entry => {
        const entryPath = path.join(extractPath, entry.fileName);

        // Skip directories or files outside contents/
        if (/\/$/.test(entry.fileName) || !entry.fileName.startsWith('contents/')) {
          zipfile.readEntry();
          return;
        }

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
            zipfile.readEntry();
          });

          writeStream.on('error', err => {
            reject(err);
          });
        });
      });

      zipfile.on('end', () => {
        resolve();
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
    console.log('🔄 Starting configuration export...');

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `ai-hub-config-backup-${timestamp}.zip`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const archive = archiver('zip', {
      zlib: { level: 9 } // Maximum compression
    });

    archive.on('error', err => {
      console.error('❌ Archive error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to create backup archive' });
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
        const relativePath = path.relative(path.join(contentsPath, '../'), filePath);

        // Add file to archive
        archive.file(filePath, { name: relativePath });
        fileCount++;
      } catch (error) {
        console.warn(`Warning: Could not add ${filePath} to archive:`, error.message);
      }
    }

    console.log(`✅ Added ${fileCount} files to backup archive`);

    // Add metadata file with backup information
    const metadata = {
      backupDate: new Date().toISOString(),
      version: '1.0',
      description: 'AI Hub Apps Configuration Backup',
      fileCount: fileCount,
      note: 'This backup includes all configuration files, custom pages, apps, models, and frontend customizations (CSS, HTML, etc.)'
    };

    archive.append(JSON.stringify(metadata, null, 2), { name: 'backup-metadata.json' });

    await archive.finalize();
    console.log('✅ Configuration export completed');
  } catch (error) {
    console.error('❌ Export error:', error);
    if (!res.headersSent) {
      res.status(500).json({
        error: 'Failed to export configuration',
        message: error.message
      });
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
    console.log('🔄 Starting configuration import...');

    // Check if file was uploaded
    if (!req.file) {
      return res.status(400).json({ error: 'No ZIP file uploaded' });
    }

    tempZipPath = req.file.path;
    tempExtractPath = path.join(path.dirname(tempZipPath), `extract_${Date.now()}`);

    console.log(`📁 Extracting ZIP file to: ${tempExtractPath}`);

    // Extract ZIP file
    await fs.mkdir(tempExtractPath, { recursive: true });
    await extractZip(tempZipPath, tempExtractPath);

    // Verify the extracted content has a contents directory
    const extractedContentsPath = path.join(tempExtractPath, 'contents');

    try {
      await fs.access(extractedContentsPath);
    } catch {
      return res.status(400).json({
        error: 'Invalid backup file: No contents directory found'
      });
    }

    // Get backup metadata if available
    let metadata = null;
    try {
      const metadataPath = path.join(tempExtractPath, 'backup-metadata.json');
      const metadataContent = await fs.readFile(metadataPath, 'utf-8');
      metadata = JSON.parse(metadataContent);
      console.log('📋 Backup metadata:', metadata);
    } catch {
      console.log('ℹ️  No metadata found in backup (this is normal for manual backups)');
    }

    // Create backup of current configuration
    const backupTimestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const currentBackupPath = path.join(
      path.dirname(contentsPath),
      `contents-backup-${backupTimestamp}`
    );

    console.log(`💾 Creating backup of current configuration at: ${currentBackupPath}`);

    try {
      await fs.cp(contentsPath, currentBackupPath, { recursive: true });
      console.log('✅ Current configuration backed up');
    } catch (error) {
      console.error('⚠️  Warning: Could not backup current configuration:', error.message);
      // Continue with import but warn user
    }

    // Replace contents directory with imported one
    console.log('🔄 Replacing configuration files...');

    // Remove current contents (but keep backup)
    await fs.rm(contentsPath, { recursive: true, force: true });

    // Copy extracted contents
    await fs.cp(extractedContentsPath, contentsPath, { recursive: true });

    console.log('✅ Configuration files replaced');

    // Reload configuration cache
    console.log('🔄 Reloading configuration cache...');
    await configCache.clear();
    await configCache.initialize();
    console.log('✅ Configuration cache reloaded');

    // Count imported files
    const importedFiles = await getAllFiles(contentsPath);

    res.json({
      success: true,
      message: 'Configuration imported successfully',
      importedFiles: importedFiles.length,
      backupPath: path.basename(currentBackupPath),
      metadata: metadata,
      note: 'All configurations have been replaced and cache has been reloaded. Frontend customizations (CSS, HTML, etc.) are included if they were in the backup.'
    });

    console.log(`✅ Configuration import completed. Imported ${importedFiles.length} files`);
  } catch (error) {
    console.error('❌ Import error:', error);

    res.status(500).json({
      error: 'Failed to import configuration',
      message: error.message
    });
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
      console.warn('Warning: Could not clean up temporary files:', error.message);
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
  app.get('/api/admin/backup/export', authRequired, exportConfig);

  // Import configuration
  app.post('/api/admin/backup/import', authRequired, upload.single('backup'), importConfig);
}
