// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import crypto from 'node:crypto';
import multer from 'multer';
import path, { join } from 'node:path';
import fs from 'node:fs';
import { getContentsPath } from '../../utils/contentsPath.js';
import configCache from '../../configCache.js';
import configStore from '../../services/config/ConfigStore.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { authRequired } from '../../middleware/authRequired.js';
import { buildServerPath } from '../../utils/basePath.js';
import { resolveAndValidatePath } from '../../utils/pathSecurity.js';
import { ServiceError } from '../../utils/ServiceError.js';
import logger from '../../utils/logger.js';
import { recordUpload } from '../../telemetry/metrics.js';
import { logAudit } from '../../services/AuditLogService.js';
import { APP_ID_PATTERN, APP_ID_MAX_LENGTH } from '../../../shared/validationPatterns.js';
import { sendCreated, segment } from '../../utils/created.js';

/**
 * Views `ui.json → startPage.defaultPage` may name as the "/" route: the
 * personalized start page, the apps browser, a content page (`defaultPageId`)
 * or an app (`defaultPageAppId`). Mirrored on the client in utils/homePage.js.
 */
const VALID_DEFAULT_PAGES = ['start', 'apps', 'page', 'app'];

/**
 * How the start page and the sidebar rank the apps that are neither favorites
 * nor admin-picked defaults. Mirrored on the client in utils/appShortcuts.js.
 */
const VALID_APP_SHORTCUT_MODES = ['order', 'recent'];

/** Upper bound for `startPage.appsCount` / `startPage.sidebarAppsCount`. */
const MAX_APP_SHORTCUTS = 12;

/** Nobody curates more default apps than this; the counts cap the lists anyway. */
const MAX_FEATURED_APPS = 50;

export default function registerAdminUIRoutes(app) {
  // Configure multer for file uploads
  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      const uploadDir = getContentsPath('uploads', 'assets');
      // Create directory if it doesn't exist
      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }
      cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
      // Generate unique filename with timestamp
      const uniqueSuffix = Date.now() + '-' + crypto.randomBytes(6).toString('hex');
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
  app.post(
    buildServerPath('/api/admin/ui/upload-asset'),
    authRequired,
    adminAuth,
    upload.single('asset'),
    (req, res) => {
      if (!req.file) {
        recordUpload('admin_asset', 'rejected_other');
        throw new ServiceError('BAD_REQUEST', 'No file uploaded');
      }
      recordUpload('admin_asset', 'accepted', req.file.size);

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

      logAudit({
        req,
        action: 'create',
        resource: 'uiAsset',
        resourceId: assetInfo.filename,
        summary: `Uploaded UI asset ${assetInfo.filename}`
      });

      sendCreated(res, publicUrl, assetInfo);
    }
  );

  /**
   * List uploaded assets
   */
  app.get(buildServerPath('/api/admin/ui/assets'), authRequired, adminAuth, (req, res) => {
    const assetsDir = getContentsPath('uploads', 'assets');

    // Create directory if it doesn't exist
    if (!fs.existsSync(assetsDir)) {
      fs.mkdirSync(assetsDir, { recursive: true });
      return res.json({ assets: [] });
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
          logger.warn('Error reading file stats', {
            component: 'AdminUI',
            filename,
            error: statError.message
          });
          return null;
        }
      })
      .filter(asset => asset !== null)
      .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));

    res.json({ assets });
  });

  /**
   * Delete asset
   */
  app.delete(
    buildServerPath('/api/admin/ui/assets/:id'),
    authRequired,
    adminAuth,
    async (req, res) => {
      const { id } = req.params;
      const assetsDir = getContentsPath('uploads', 'assets');

      // Validate path stays within assets directory (prevents traversal)
      const filepath = await resolveAndValidatePath(id, assetsDir);
      if (!filepath) {
        throw new ServiceError('BAD_REQUEST', 'Invalid asset id');
      }

      if (!fs.existsSync(filepath)) {
        throw new ServiceError('NOT_FOUND', 'Asset not found');
      }

      fs.unlinkSync(filepath);

      logAudit({
        req,
        action: 'delete',
        resource: 'uiAsset',
        resourceId: id,
        summary: `Deleted UI asset ${id}`
      });

      res.status(204).end();
    }
  );

  /**
   * Get UI configuration
   */
  app.get(buildServerPath('/api/admin/ui/config'), authRequired, adminAuth, (req, res) => {
    const uiConfig = configCache.getUI();

    res.json({ config: uiConfig?.data || {} });
  });

  /**
   * Update UI configuration
   */
  app.post(buildServerPath('/api/admin/ui/config'), authRequired, adminAuth, async (req, res) => {
    const { config } = req.body;

    if (!config || typeof config !== 'object') {
      throw new ServiceError('BAD_REQUEST', 'Invalid configuration data');
    }

    // Validate the configuration structure (basic validation)
    validateUIConfig(config);

    // Write the updated configuration atomically
    await configStore.writeJson('config/ui.json', config);

    // Refresh the cache
    await configCache.refreshCacheEntry('config/ui.json');

    logAudit({
      req,
      action: 'update',
      resource: 'uiConfig',
      summary: 'Updated UI configuration'
    });

    res.status(204).end();
  });

  /**
   * Backup UI configuration
   */
  app.post(buildServerPath('/api/admin/ui/backup'), authRequired, adminAuth, async (req, res) => {
    const uiConfig = configCache.getUI();
    const currentConfig = uiConfig?.data || {};
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    // `backups/` is not a configuration namespace, so this lands on the
    // contained path — the store creates the directory on the way.
    await configStore.writeJson(`backups/ui-config-backup-${timestamp}.json`, currentConfig);

    logAudit({
      req,
      action: 'export',
      resource: 'uiConfig',
      resourceId: `ui-config-backup-${timestamp}.json`,
      summary: 'Backed up UI configuration'
    });

    res.json({ backupPath: `backups/ui-config-backup-${timestamp}.json` });
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
        throw new ServiceError('BAD_REQUEST', `Missing required section: ${section}`);
      }
    }

    // Validate header section
    if (config.header && typeof config.header !== 'object') {
      throw new ServiceError('BAD_REQUEST', 'Header section must be an object');
    }

    // Validate footer section
    if (config.footer && typeof config.footer !== 'object') {
      throw new ServiceError('BAD_REQUEST', 'Footer section must be an object');
    }

    // Validate pwa section if present
    if (config.pwa !== undefined) {
      if (typeof config.pwa !== 'object') {
        throw new ServiceError('BAD_REQUEST', 'pwa section must be an object');
      }
      const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
      const VALID_DISPLAYS = ['standalone', 'fullscreen', 'minimal-ui', 'browser'];
      const { pwa } = config;
      if (pwa.themeColor && !HEX_COLOR.test(pwa.themeColor)) {
        throw new ServiceError(
          'BAD_REQUEST',
          'pwa.themeColor must be a valid 6-digit hex color (e.g. #003557)'
        );
      }
      if (pwa.backgroundColor && !HEX_COLOR.test(pwa.backgroundColor)) {
        throw new ServiceError(
          'BAD_REQUEST',
          'pwa.backgroundColor must be a valid 6-digit hex color'
        );
      }
      if (pwa.display && !VALID_DISPLAYS.includes(pwa.display)) {
        throw new ServiceError(
          'BAD_REQUEST',
          `pwa.display must be one of: ${VALID_DISPLAYS.join(', ')}`
        );
      }
      if (pwa.name && typeof pwa.name !== 'string') {
        throw new ServiceError('BAD_REQUEST', 'pwa.name must be a string');
      }
      if (pwa.shortName && typeof pwa.shortName !== 'string') {
        throw new ServiceError('BAD_REQUEST', 'pwa.shortName must be a string');
      }
    }

    // Validate errorPages section if present. Each screen is an object of
    // localized `{ lang: value }` fields; unset fields fall back to i18n.
    if (config.errorPages !== undefined) {
      if (typeof config.errorPages !== 'object' || Array.isArray(config.errorPages)) {
        throw new ServiceError('BAD_REQUEST', 'errorPages section must be an object');
      }
      for (const [pageKey, page] of Object.entries(config.errorPages)) {
        if (page !== null && (typeof page !== 'object' || Array.isArray(page))) {
          throw new ServiceError('BAD_REQUEST', `errorPages.${pageKey} must be an object`);
        }
      }
    }

    // Validate startPage section if present. `defaultAppId` ends up in a URL
    // path (/apps/<id>) and an API call on the client, so it must look like an
    // app id; `title` and `subtitle` are localized `{ lang: value }` objects.
    if (config.startPage !== undefined) {
      const { startPage } = config;
      if (typeof startPage !== 'object' || startPage === null || Array.isArray(startPage)) {
        throw new ServiceError('BAD_REQUEST', 'startPage section must be an object');
      }
      if (startPage.showDefaultApp !== undefined && typeof startPage.showDefaultApp !== 'boolean') {
        throw new ServiceError('BAD_REQUEST', 'startPage.showDefaultApp must be a boolean');
      }
      if (startPage.showUserName !== undefined && typeof startPage.showUserName !== 'boolean') {
        throw new ServiceError('BAD_REQUEST', 'startPage.showUserName must be a boolean');
      }
      if (
        startPage.defaultAppId !== undefined &&
        startPage.defaultAppId !== null &&
        startPage.defaultAppId !== ''
      ) {
        if (
          typeof startPage.defaultAppId !== 'string' ||
          startPage.defaultAppId.length > APP_ID_MAX_LENGTH ||
          !APP_ID_PATTERN.test(startPage.defaultAppId)
        ) {
          throw new ServiceError('BAD_REQUEST', 'startPage.defaultAppId must be a valid app id');
        }
      }
      for (const field of ['title', 'subtitle']) {
        const value = startPage[field];
        if (value === undefined || value === null) continue;
        if (typeof value !== 'object' || Array.isArray(value)) {
          throw new ServiceError('BAD_REQUEST', `startPage.${field} must be a localized object`);
        }
      }
      // `defaultPage` decides what the "/" route shows. Anything but "start"
      // redirects to another route, so the ids it points at reach a URL path
      // and get the same treatment as `defaultAppId` above.
      if (
        startPage.defaultPage !== undefined &&
        startPage.defaultPage !== null &&
        startPage.defaultPage !== ''
      ) {
        if (!VALID_DEFAULT_PAGES.includes(startPage.defaultPage)) {
          throw new ServiceError(
            'BAD_REQUEST',
            `startPage.defaultPage must be one of: ${VALID_DEFAULT_PAGES.join(', ')}`
          );
        }
      }
      for (const field of ['defaultPageId', 'defaultPageAppId']) {
        const value = startPage[field];
        if (value === undefined || value === null || value === '') continue;
        if (
          typeof value !== 'string' ||
          value.length > APP_ID_MAX_LENGTH ||
          !APP_ID_PATTERN.test(value)
        ) {
          throw new ServiceError('BAD_REQUEST', `startPage.${field} must be a valid id`);
        }
      }
      // App shortcuts: which apps lead the start-page grid and the sidebar's
      // Apps section, how the rest rank, and how many each list shows.
      if (
        startPage.appsMode !== undefined &&
        startPage.appsMode !== null &&
        startPage.appsMode !== ''
      ) {
        if (!VALID_APP_SHORTCUT_MODES.includes(startPage.appsMode)) {
          throw new ServiceError(
            'BAD_REQUEST',
            `startPage.appsMode must be one of: ${VALID_APP_SHORTCUT_MODES.join(', ')}`
          );
        }
      }
      for (const field of ['appsCount', 'sidebarAppsCount']) {
        const value = startPage[field];
        // Unset means "use the built-in default", which the client applies.
        if (value === undefined || value === null || value === '') continue;
        if (!Number.isInteger(value) || value < 0 || value > MAX_APP_SHORTCUTS) {
          throw new ServiceError(
            'BAD_REQUEST',
            `startPage.${field} must be an integer between 0 and ${MAX_APP_SHORTCUTS}`
          );
        }
      }
      if (startPage.featuredAppIds !== undefined && startPage.featuredAppIds !== null) {
        const { featuredAppIds } = startPage;
        if (!Array.isArray(featuredAppIds)) {
          throw new ServiceError(
            'BAD_REQUEST',
            'startPage.featuredAppIds must be an array of app ids'
          );
        }
        if (featuredAppIds.length > MAX_FEATURED_APPS) {
          throw new ServiceError(
            'BAD_REQUEST',
            `startPage.featuredAppIds must not hold more than ${MAX_FEATURED_APPS} ids`
          );
        }
        // These ids end up in /apps/<id> links on the client, so they get the
        // same treatment as every other app id in this config.
        for (const id of featuredAppIds) {
          if (typeof id !== 'string' || id.length > APP_ID_MAX_LENGTH || !APP_ID_PATTERN.test(id)) {
            throw new ServiceError(
              'BAD_REQUEST',
              'startPage.featuredAppIds must only contain valid app ids'
            );
          }
        }
        if (new Set(featuredAppIds).size !== featuredAppIds.length) {
          throw new ServiceError(
            'BAD_REQUEST',
            'startPage.featuredAppIds must not contain duplicates'
          );
        }
      }
    }
  }
}
