// Office 365 OAuth Integration Routes
// Handles OAuth2 PKCE flow for Microsoft 365 file access authentication

import express from 'express';
import Office365Service from '../../services/integrations/Office365Service.js';
import { authRequired } from '../../middleware/authRequired.js';
import { requireFeature } from '../../featureRegistry.js';
import logger from '../../utils/logger.js';
import rateLimit from 'express-rate-limit';
import { sendInternalError, sendAuthRequired, sendBadRequest, sendErrorResponse } from '../../utils/responseHelpers.js';
import { buildContentDisposition } from '../../utils/safeContentDisposition.js';
import { createOAuthIntegrationRouter } from './oauthIntegrationFactory.js';

const router = express.Router();

/**
 * Validate an identifier used in Office 365 / Microsoft Graph URLs.
 * Restricts characters and length to reduce risk when interpolated into URLs.
 *
 * NOTE: Adjust the regex if your environment uses a wider ID character set.
 */
function isValidGraphId(id) {
  if (typeof id !== 'string') return false;
  const trimmed = id.trim();
  if (!trimmed || trimmed.length > 512) return false;
  // Allow common safe characters; disallow whitespace and URL control chars.
  return /^[A-Za-z0-9._\-]+$/.test(trimmed);
}

// Gate all Office 365 routes behind the integrations feature flag
router.use(requireFeature('integrations'));

// Rate limiter for Office 365 OAuth initiation to prevent abuse/DoS
const office365AuthLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // limit each IP to 10 auth initiation requests per windowMs
  standardHeaders: true,
  legacyHeaders: false
});

createOAuthIntegrationRouter(router, {
  providerKey: 'office365',
  displayName: 'Office 365',
  requiresProviderId: true,
  usesPkce: true,
  authLimiter: office365AuthLimiter,
  buildAuthUrl: ({ providerId, state, codeVerifier, req }) =>
    Office365Service.generateAuthUrl(providerId, state, codeVerifier, req),
  exchangeCodeForTokens: ({ providerId, code, codeVerifier, req }) =>
    Office365Service.exchangeCodeForTokens(providerId, code, codeVerifier, req),
  storeUserTokens: (userId, tokens) => Office365Service.storeUserTokens(userId, tokens),
  isUserAuthenticated: (userId, providerId) => Office365Service.isUserAuthenticated(userId, providerId),
  getUserInfo: (userId, providerId) => Office365Service.getUserInfo(userId, providerId),
  getTokenExpirationInfo: (userId, providerId) =>
    Office365Service.getTokenExpirationInfo(userId, providerId),
  deleteUserTokens: (userId, providerId) => Office365Service.deleteUserTokens(userId, providerId),
  formatUserInfo: userInfo => ({
    displayName: userInfo.displayName,
    mail: userInfo.mail,
    userPrincipalName: userInfo.userPrincipalName,
    jobTitle: userInfo.jobTitle
  })
});

/**
 * Get available source categories
 * GET /api/integrations/office365/sources
 */
router.get('/sources', authRequired, async (req, res) => {
  try {
    if (!req.user?.id) {
      return sendAuthRequired(res);
    }

    // Return static source categories (no Graph API calls)
    const sources = [
      {
        id: 'personal',
        name: 'OneDrive',
        description: 'Your personal OneDrive files',
        icon: 'hard-drive'
      },
      {
        id: 'sharepoint',
        name: 'SharePoint Sites',
        description: 'Files from SharePoint sites you follow',
        icon: 'folder'
      },
      {
        id: 'teams',
        name: 'Microsoft Teams',
        description: 'Files from your Teams channels',
        icon: 'user-group'
      }
    ];

    res.json({
      success: true,
      sources
    });
  } catch (error) {
    logger.error('❌ Error getting Office 365 sources:', {
      component: 'Office 365',
      error: error.message
    });

    return sendInternalError(res, error, 'get Office 365 sources');
  }
});

/**
 * List drives for a specific source
 * GET /api/integrations/office365/drives/:source
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
      case 'personal':
        drives = await Office365Service.listPersonalDrives(req.user.id, providerId);
        break;
      case 'sharepoint':
        drives = await Office365Service.listSharePointDrives(req.user.id, providerId);
        break;
      case 'teams':
        drives = await Office365Service.listTeamsDrives(req.user.id, providerId);
        break;
      default:
        return sendBadRequest(res, 'Source must be one of: personal, sharepoint, teams');
    }

    res.json({
      success: true,
      drives
    });
  } catch (error) {
    logger.error('Error listing Office 365 drives', {
      component: 'Office 365',
      source: req.params.source,
      error: error.message
    });

    if (error.message.includes('authentication required')) {
      return sendErrorResponse(res, 401, 'Authentication required');
    }

    return sendInternalError(res, error, 'list Office 365 drives');
  }
});

/**
 * List items in a drive folder
 * GET /api/integrations/office365/items?driveId=xxx&folderId=xxx&search=xxx
 */
router.get('/items', authRequired, async (req, res) => {
  try {
    if (!req.user?.id) {
      return sendAuthRequired(res);
    }

    const { driveId, folderId, search } = req.query;
    const providerId = typeof req.query.providerId === 'string' ? req.query.providerId : undefined;

    if (driveId && !isValidGraphId(driveId)) {
      return sendBadRequest(res, 'driveId contains invalid characters or is too long');
    }

    if (folderId && !isValidGraphId(folderId)) {
      return sendBadRequest(res, 'folderId contains invalid characters or is too long');
    }

    let items;
    // If search query is provided, use search endpoint
    if (search && search.trim().length > 0) {
      if (!driveId) {
        return sendBadRequest(res, 'driveId is required for search');
      }
      items = await Office365Service.searchItems(req.user.id, driveId, search, providerId);
    } else {
      items = await Office365Service.listItems(req.user.id, driveId, folderId, providerId);
    }

    res.json({
      success: true,
      items
    });
  } catch (error) {
    logger.error('❌ Error listing Office 365 items:', {
      component: 'Office 365',
      error: error.message
    });

    if (error.message.includes('authentication required')) {
      return sendErrorResponse(res, 401, 'Authentication required');
    }

    return sendInternalError(res, error, 'list Office 365 items');
  }
});

/**
 * Download a file from Office 365
 * GET /api/integrations/office365/download?fileId=xxx&driveId=xxx
 */
router.get('/download', authRequired, async (req, res) => {
  try {
    if (!req.user?.id) {
      return sendAuthRequired(res);
    }

    const { fileId, driveId } = req.query;
    const providerId = typeof req.query.providerId === 'string' ? req.query.providerId : undefined;

    if (!fileId) {
      return sendBadRequest(res, 'fileId query parameter is required');
    }

    if (!isValidGraphId(fileId)) {
      return sendBadRequest(res, 'fileId contains invalid characters or is too long');
    }

    if (driveId && !isValidGraphId(driveId)) {
      return sendBadRequest(res, 'driveId contains invalid characters or is too long');
    }

    const file = await Office365Service.downloadFile(req.user.id, fileId, driveId, providerId);

    // Force `application/octet-stream` rather than reflecting the
    // upstream Graph Content-Type. The download is always served with
    // `Content-Disposition: attachment` so even `text/html` would not
    // render today, but reflecting upstream MIME types means any
    // future refactor that drops the attachment disposition would
    // open an XSS path. Keep the safer baseline.
    res.setHeader('Content-Type', 'application/octet-stream');
    if (file.size) res.setHeader('Content-Length', file.size);
    res.setHeader('Content-Disposition', buildContentDisposition(file.name));

    // Send file content
    res.send(file.content);
  } catch (error) {
    logger.error('❌ Error downloading Office 365 file:', {
      component: 'Office 365',
      error: error.message
    });

    if (error.message.includes('authentication required')) {
      return sendErrorResponse(res, 401, 'Authentication required');
    }

    return sendInternalError(res, error, 'download Office 365 file');
  }
});

export default router;
