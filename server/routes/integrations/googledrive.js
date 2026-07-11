// Google Drive OAuth Integration Routes
// Handles OAuth2 PKCE flow for Google Workspace file access authentication

import express from 'express';
import GoogleDriveService from '../../services/integrations/GoogleDriveService.js';
import { authRequired } from '../../middleware/authRequired.js';
import { requireFeature } from '../../featureRegistry.js';
import logger from '../../utils/logger.js';
import rateLimit from 'express-rate-limit';
import { sendInternalError, sendAuthRequired, sendBadRequest, sendErrorResponse } from '../../utils/responseHelpers.js';
import { buildContentDisposition } from '../../utils/safeContentDisposition.js';
import { createOAuthIntegrationRouter } from './oauthIntegrationFactory.js';

const router = express.Router();

/**
 * Validate Google Drive fileId to ensure it is a safe opaque identifier.
 * Google Drive IDs are typically URL-safe base64-like strings.
 * This restricts to alphanumerics, underscore and hyphen, 1-200 chars.
 */
function isValidFileId(fileId) {
  if (typeof fileId !== 'string') return false;
  const FILE_ID_REGEX = /^[A-Za-z0-9_-]{1,200}$/;
  return FILE_ID_REGEX.test(fileId);
}

// Gate all Google Drive routes behind the integrations feature flag
router.use(requireFeature('integrations'));

// Rate limiter for Google Drive OAuth initiation to prevent abuse/DoS
const googleDriveAuthLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false
});

// Rate limiter for status and other authenticated endpoints
const googleDriveApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false
});

createOAuthIntegrationRouter(router, {
  providerKey: 'googledrive',
  displayName: 'Google Drive',
  requiresProviderId: true,
  usesPkce: true,
  authLimiter: googleDriveAuthLimiter,
  statusLimiter: googleDriveApiLimiter,
  buildAuthUrl: ({ providerId, state, codeVerifier, req }) =>
    GoogleDriveService.generateAuthUrl(providerId, state, codeVerifier, req),
  exchangeCodeForTokens: ({ providerId, code, codeVerifier, req }) =>
    GoogleDriveService.exchangeCodeForTokens(providerId, code, codeVerifier, req),
  storeUserTokens: (userId, tokens) => GoogleDriveService.storeUserTokens(userId, tokens),
  isUserAuthenticated: (userId, providerId) => GoogleDriveService.isUserAuthenticated(userId, providerId),
  getUserInfo: (userId, providerId) => GoogleDriveService.getUserInfo(userId, providerId),
  getTokenExpirationInfo: (userId, providerId) =>
    GoogleDriveService.getTokenExpirationInfo(userId, providerId),
  deleteUserTokens: (userId, providerId) => GoogleDriveService.deleteUserTokens(userId, providerId),
  formatUserInfo: userInfo => ({
    displayName: userInfo.displayName,
    mail: userInfo.mail,
    picture: userInfo.picture
  })
});

/**
 * Get available source categories
 * GET /api/integrations/googledrive/sources?providerId=xxx
 */
router.get('/sources', authRequired, googleDriveApiLimiter, async (req, res) => {
  try {
    if (!req.user?.id) {
      return sendAuthRequired(res);
    }

    const { providerId } = req.query;

    const allSources = [
      {
        id: 'myDrive',
        name: 'My Drive',
        description: 'Your personal Google Drive files',
        icon: 'hard-drive'
      },
      {
        id: 'sharedDrives',
        name: 'Shared Drives',
        description: 'Files from shared team drives',
        icon: 'user-group'
      },
      {
        id: 'sharedWithMe',
        name: 'Shared with Me',
        description: 'Files shared with you by others',
        icon: 'share'
      }
    ];

    let sources = allSources;

    if (providerId) {
      try {
        const provider = GoogleDriveService._getProviderConfig(providerId);
        if (provider.sources) {
          sources = allSources.filter(s => provider.sources[s.id] !== false);
        }
      } catch {
        // Provider not found or invalid — return all sources as fallback
      }
    }

    res.json({
      success: true,
      sources
    });
  } catch (error) {
    logger.error('Error getting Google Drive sources:', {
      component: 'Google Drive',
      error: error.message
    });

    return sendInternalError(res, error, 'get Google Drive sources');
  }
});

/**
 * List drives for a specific source
 * GET /api/integrations/googledrive/drives/:source
 */
router.get('/drives/:source', authRequired, async (req, res) => {
  try {
    if (!req.user?.id) {
      return sendAuthRequired(res);
    }

    const { source } = req.params;
    const providerId = typeof req.query.providerId === 'string' ? req.query.providerId : undefined;
    let drives = [];

    switch (source) {
      case 'myDrive':
        // My Drive is a single virtual drive entry
        drives = [
          {
            id: 'root',
            name: 'My Drive',
            description: 'Your personal Google Drive',
            driveType: 'personal',
            source: 'myDrive'
          }
        ];
        break;
      case 'sharedDrives':
        drives = await GoogleDriveService.listSharedDrives(req.user.id, providerId);
        break;
      case 'sharedWithMe':
        // Shared with Me is a virtual drive entry (flat list, no folder hierarchy)
        drives = [
          {
            id: 'sharedWithMe',
            name: 'Shared with Me',
            description: 'Files shared with you',
            driveType: 'shared',
            source: 'sharedWithMe'
          }
        ];
        break;
      default:
        return sendBadRequest(res, 'Source must be one of: myDrive, sharedDrives, sharedWithMe');
    }

    res.json({
      success: true,
      drives
    });
  } catch (error) {
    logger.error('Error listing Google Drive drives', {
      component: 'Google Drive',
      source: req.params.source,
      error: error.message
    });

    if (error.message.includes('authentication required')) {
      return sendErrorResponse(res, 401, 'Authentication required');
    }

    return sendInternalError(res, error, 'list Google Drive drives');
  }
});

/**
 * List items in a drive folder
 * GET /api/integrations/googledrive/items?driveId=xxx&folderId=xxx&search=xxx&source=xxx
 */
router.get('/items', authRequired, async (req, res) => {
  try {
    if (!req.user?.id) {
      return sendAuthRequired(res);
    }

    const { driveId, folderId, search, source } = req.query;
    const providerId = typeof req.query.providerId === 'string' ? req.query.providerId : undefined;

    let items;

    if (search && search.trim().length > 0) {
      // Search mode
      const searchDriveId =
        driveId && driveId !== 'root' && driveId !== 'sharedWithMe' ? driveId : null;
      items = await GoogleDriveService.searchFiles(req.user.id, search, searchDriveId, providerId);
    } else if (source === 'sharedWithMe' || driveId === 'sharedWithMe') {
      // Shared with Me - flat list
      items = await GoogleDriveService.listSharedWithMe(req.user.id, providerId);
    } else if (driveId === 'root' || !driveId) {
      // My Drive
      items = await GoogleDriveService.listMyDriveFiles(req.user.id, folderId, providerId);
    } else {
      // Shared drive
      items = await GoogleDriveService.listSharedDriveFiles(
        req.user.id,
        driveId,
        folderId,
        providerId
      );
    }

    res.json({
      success: true,
      items
    });
  } catch (error) {
    logger.error('Error listing Google Drive items:', {
      component: 'Google Drive',
      error: error.message
    });

    if (error.message.includes('authentication required')) {
      return sendErrorResponse(res, 401, 'Authentication required');
    }

    return sendInternalError(res, error, 'list Google Drive items');
  }
});

/**
 * Download a file from Google Drive
 * GET /api/integrations/googledrive/download?fileId=xxx
 */
router.get('/download', authRequired, async (req, res) => {
  try {
    if (!req.user?.id) {
      return sendAuthRequired(res);
    }

    const { fileId } = req.query;
    const providerId = typeof req.query.providerId === 'string' ? req.query.providerId : undefined;

    if (!fileId) {
      return sendBadRequest(res, 'fileId query parameter is required');
    }

    if (!isValidFileId(fileId)) {
      return sendBadRequest(res, 'fileId must be a valid Google Drive file identifier');
    }

    const file = await GoogleDriveService.downloadFile(req.user.id, fileId, providerId);

    // Force `application/octet-stream` rather than reflecting the
    // upstream Google Drive Content-Type. The download is always served
    // with `Content-Disposition: attachment` so even `text/html` would
    // not render today, but reflecting upstream MIME types means any
    // future refactor that drops the attachment disposition would
    // open an XSS path. Keep the safer baseline.
    res.setHeader('Content-Type', 'application/octet-stream');
    if (file.size) res.setHeader('Content-Length', file.size);
    res.setHeader('Content-Disposition', buildContentDisposition(file.name));

    res.send(file.content);
  } catch (error) {
    logger.error('Error downloading Google Drive file:', {
      component: 'Google Drive',
      error: error.message
    });

    if (error.message.includes('authentication required')) {
      return sendErrorResponse(res, 401, 'Authentication required');
    }

    return sendInternalError(res, error, 'download Google Drive file');
  }
});

export default router;
