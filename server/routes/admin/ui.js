import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { join } from 'path';
import { getRootDir } from '../../pathUtils.js';
import configCache from '../../configCache.js';
import { atomicWriteJSON } from '../../utils/atomicWrite.js';
import { adminAuth } from '../../middleware/adminAuth.js';

export default function registerAdminUIRoutes(app) {
  // Configure multer for file uploads
  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      const uploadDir = join(getRootDir(), 'contents/uploads/assets');
      // Create directory if it doesn't exist
      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }
      cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
      // Generate unique filename with timestamp
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
      const ext = path.extname(file.originalname);
      const name = path.basename(file.originalname, ext);
      cb(null, `${name}-${uniqueSuffix}${ext}`);
    }
  });

  const fileFilter = (req, file, cb) => {
    // Allow only specific file types for UI assets
    const allowedTypes = [
      'image/svg+xml',
      'image/png',
      'image/jpeg',
      'image/jpg',
      'image/x-icon',
      'image/vnd.microsoft.icon'
    ];
    const allowedExtensions = ['.svg', '.png', '.jpg', '.jpeg', '.ico'];

    const ext = path.extname(file.originalname).toLowerCase();

    if (allowedTypes.includes(file.mimetype) && allowedExtensions.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only SVG, PNG, JPG, and ICO files are allowed.'), false);
    }
  };

  const upload = multer({
    storage,
    limits: {
      fileSize: 2 * 1024 * 1024, // 2MB limit
      files: 1 // Single file per request
    },
    fileFilter
  });

  /**
   * Upload asset file (logo, icon, favicon, etc.)
   */
  app.post('/api/admin/ui/upload-asset', adminAuth, upload.single('asset'), (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: 'No file uploaded'
        });
      }

      const { assetType = 'general', description = '' } = req.body;

      // Generate public URL for the uploaded file
      const publicUrl = `/uploads/assets/${req.file.filename}`;

      const assetInfo = {
        id: req.file.filename,
        originalName: req.file.originalname,
        filename: req.file.filename,
        path: req.file.path,
        publicUrl,
        size: req.file.size,
        mimetype: req.file.mimetype,
        assetType,
        description,
        uploadedAt: new Date().toISOString(),
        uploadedBy: req.user?.username || 'admin'
      };

      res.json({
        success: true,
        message: 'Asset uploaded successfully',
        asset: assetInfo
      });
    } catch (error) {
      console.error('Error uploading asset:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to upload asset',
        error: error.message
      });
    }
  });

  /**
   * List uploaded assets
   */
  app.get('/api/admin/ui/assets', adminAuth, (req, res) => {
    try {
      const assetsDir = join(getRootDir(), 'contents/uploads/assets');

      // Create directory if it doesn't exist
      if (!fs.existsSync(assetsDir)) {
        fs.mkdirSync(assetsDir, { recursive: true });
        return res.json({ success: true, assets: [] });
      }

      const files = fs.readdirSync(assetsDir);
      const assets = files
        .filter(filename => {
          // Filter out hidden files and directories
          return !filename.startsWith('.') && filename.length > 0;
        })
        .map(filename => {
          try {
            const filepath = join(assetsDir, filename);
            const stats = fs.statSync(filepath);

            // Skip directories
            if (stats.isDirectory()) {
              return null;
            }

            const ext = path.extname(filename).toLowerCase();

            return {
              id: filename,
              filename,
              publicUrl: `/uploads/assets/${filename}`,
              size: stats.size,
              mimetype: getMimeType(ext),
              uploadedAt: stats.mtime.toISOString(),
              isImage: ['.svg', '.png', '.jpg', '.jpeg', '.ico'].includes(ext)
            };
          } catch (statError) {
            console.warn(`Error reading file stats for ${filename}:`, statError.message);
            return null;
          }
        })
        .filter(asset => asset !== null)
        .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));

      res.json({ success: true, assets });
    } catch (error) {
      console.error('Error listing assets:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to load assets',
        error: error.message
      });
    }
  });

  /**
   * Delete asset
   */
  app.delete('/api/admin/ui/assets/:id', adminAuth, (req, res) => {
    try {
      const { id } = req.params;
      const filepath = join(getRootDir(), 'contents/uploads/assets', id);

      if (!fs.existsSync(filepath)) {
        return res.status(404).json({
          success: false,
          message: 'Asset not found'
        });
      }

      fs.unlinkSync(filepath);

      res.json({
        success: true,
        message: 'Asset deleted successfully'
      });
    } catch (error) {
      console.error('Error deleting asset:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to delete asset',
        error: error.message
      });
    }
  });

  /**
   * Get UI configuration
   */
  app.get('/api/admin/ui/config', adminAuth, (req, res) => {
    try {
      const uiConfig = configCache.getUI();

      res.json({
        success: true,
        config: uiConfig?.data || {}
      });
    } catch (error) {
      console.error('Error getting UI config:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get UI configuration',
        error: error.message
      });
    }
  });

  /**
   * Update UI configuration
   */
  app.post('/api/admin/ui/config', adminAuth, async (req, res) => {
    try {
      const { config } = req.body;

      if (!config || typeof config !== 'object') {
        return res.status(400).json({
          success: false,
          message: 'Invalid configuration data'
        });
      }

      // Get the current config path
      const configPath = join(getRootDir(), 'contents/config/ui.json');

      // Validate the configuration structure (basic validation)
      validateUIConfig(config);

      // Write the updated configuration atomically
      await atomicWriteJSON(configPath, config);

      // Refresh the cache
      await configCache.refreshCacheEntry('config/ui.json');

      res.json({
        success: true,
        message: 'UI configuration updated successfully'
      });
    } catch (error) {
      console.error('Error updating UI config:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to update UI configuration',
        error: error.message
      });
    }
  });

  /**
   * Backup UI configuration
   */
  app.post('/api/admin/ui/backup', adminAuth, async (req, res) => {
    try {
      const uiConfig = configCache.getUI();
      const currentConfig = uiConfig?.data || {};
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupDir = join(getRootDir(), 'contents/backups');

      // Create backup directory if it doesn't exist
      if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir, { recursive: true });
      }

      const backupPath = join(backupDir, `ui-config-backup-${timestamp}.json`);
      await atomicWriteJSON(backupPath, currentConfig);

      res.json({
        success: true,
        message: 'Configuration backed up successfully',
        backupPath: `backups/ui-config-backup-${timestamp}.json`
      });
    } catch (error) {
      console.error('Error backing up UI config:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to backup UI configuration',
        error: error.message
      });
    }
  });

  // Helper functions (defined within the scope of registerAdminUIRoutes)
  function getMimeType(ext) {
    const mimeTypes = {
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.ico': 'image/x-icon'
    };
    return mimeTypes[ext] || 'application/octet-stream';
  }

  function validateUIConfig(config) {
    // Basic validation for UI configuration structure
    const requiredSections = ['title', 'header', 'footer'];

    for (const section of requiredSections) {
      if (!config.hasOwnProperty(section)) {
        throw new Error(`Missing required section: ${section}`);
      }
    }

    // Validate header section
    if (config.header && typeof config.header !== 'object') {
      throw new Error('Header section must be an object');
    }

    // Validate footer section
    if (config.footer && typeof config.footer !== 'object') {
      throw new Error('Footer section must be an object');
    }

    // Additional validation can be added here
  }
}
