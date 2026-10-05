// Google Drive OAuth Integration Routes
// Handles OAuth2 PKCE flow for Google Workspace file access authentication

import express from 'express';
import crypto from 'crypto';
import GoogleDriveService from '../../services/integrations/GoogleDriveService.js';
import { authOptional, authRequired } from '../../middleware/authRequired.js';
import { requireFeature } from '../../featureRegistry.js';
import logger from '../../utils/logger.js';
import rateLimit from 'express-rate-limit';
import {
  sendInternalError,
  sendAuthRequired,
  sendBadRequest,
  sendErrorResponse
} from '../../utils/responseHelpers.js';
import { isValidReturnUrl } from '../../utils/oauthReturnUrl.js';
import {
  DEFAULT_INTEGRATION_RETURN_URL,
  issueIntegrationOAuthState,
  verifyIntegrationOAuthState,
  withQueryParam
} from '../../utils/integrationOAuthState.js';
import { buildContentDisposition } from '../../utils/safeContentDisposition.js';

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

/**
 * Initiate Google Drive OAuth2 flow
 * GET /api/integrations/googledrive/auth?providerId=xxx
 */
router.get('/auth', authRequired, googleDriveAuthLimiter, async (req, res) => {
  try {
    const { providerId, returnUrl } = req.query;

    if (!providerId) {
      return sendBadRequest(res, 'providerId query parameter is required');
    }

    // authRequired lets the anonymous principal through when anonymous
    // access is allowed, and does not guarantee req.user.id is truthy.
    // Refuse to start an OAuth flow without a signed-in user id — otherwise
    // tokens would land under a shared key and could be read by another caller.
    if (!req.user?.id || req.user.id === 'anonymous') {
      return sendAuthRequired(res);
    }

    const codeVerifier = crypto.randomBytes(32).toString('base64url');

    // Validate returnUrl to prevent open redirects
    const validatedReturnUrl = isValidReturnUrl(returnUrl, req)
      ? returnUrl
      : DEFAULT_INTEGRATION_RETURN_URL;

    // Signed, self-contained state instead of a session: the callback may
    // land on another cluster worker (see utils/integrationOAuthState.js).
    const state = issueIntegrationOAuthState({
      service: 'googledrive',
      providerId,
      userId: req.user.id,
      returnUrl: validatedReturnUrl,
      codeVerifier
    });

    const authUrl = GoogleDriveService.generateAuthUrl(providerId, state, codeVerifier, req);

    logger.info('Initiating Google Drive OAuth', {
      component: 'Google Drive',
      userId: req.user?.id,
      providerId
    });

    res.redirect(authUrl);
  } catch (error) {
    return sendInternalError(res, error, 'initiate Google Drive OAuth');
  }
});

/**
 * Handle Google Drive OAuth callback (provider-specific)
 * GET /api/integrations/googledrive/:providerId/callback
 */
router.get('/:providerId/callback', authOptional, async (req, res) => {
  const { providerId } = req.params;
  const verified = verifyIntegrationOAuthState(req, { service: 'googledrive', providerId });
  const { returnUrl } = verified;
  try {
    const { code, error: oauthError } = req.query;

    if (oauthError) {
      logger.error('Google Drive OAuth error:', {
        component: 'Google Drive',
        error: oauthError,
        providerId
      });
      const errorCode = oauthError === 'access_denied' ? 'access_denied' : 'oauth_failed';
      return res.redirect(withQueryParam(returnUrl, 'googledrive_error', errorCode));
    }

    if (!verified.ok) {
      logger.error('Invalid Google Drive OAuth state parameter', {
        component: 'Google Drive',
        providerId,
        reason: verified.error
      });
      return res.redirect(withQueryParam(returnUrl, 'googledrive_error', verified.error));
    }

    if (!code) {
      logger.error('Google Drive OAuth callback missing code', {
        component: 'Google Drive',
        providerId
      });
      return res.redirect(withQueryParam(returnUrl, 'googledrive_error', 'missing_code'));
    }

    const tokens = await GoogleDriveService.exchangeCodeForTokens(
      providerId,
      code,
      verified.codeVerifier,
      req
    );

    if (!tokens.refreshToken) {
      logger.error('No refresh token received from Google Drive OAuth.', {
        component: 'Google Drive',
        providerId
      });
      logger.warn(
        'Storing tokens WITHOUT refresh capability - user will need to reconnect periodically',
        { component: 'Google Drive' }
      );
    }

    await GoogleDriveService.storeUserTokens(verified.userId, tokens);

    logger.info('Google Drive OAuth completed', {
      component: 'Google Drive',
      userId: verified.userId,
      providerId
    });

    res.redirect(withQueryParam(returnUrl, 'googledrive_connected', 'true'));
  } catch (error) {
    logger.error('Error handling Google Drive OAuth callback:', {
      component: 'Google Drive',
      error: error.message,
      providerId
    });
    // Use a stable error code rather than echoing `error.message` —
    // some upstream errors interpolate user-influenced strings.
    res.redirect(withQueryParam(returnUrl, 'googledrive_error', 'callback_failed'));
  }
});

/**
 * Get Google Drive connection status for current user
 * GET /api/integrations/googledrive/status
 */
router.get('/status', authRequired, googleDriveApiLimiter, async (req, res) => {
  try {
    if (!req.user?.id || req.user.id === 'anonymous') {
      return sendAuthRequired(res);
    }

    const providerId = typeof req.query.providerId === 'string' ? req.query.providerId : undefined;

    const isAuthenticated = await GoogleDriveService.isUserAuthenticated(req.user.id, providerId);

    if (!isAuthenticated) {
      return res.json({
        connected: false,
        message: 'Google Drive account not connected'
      });
    }

    const userInfo = await GoogleDriveService.getUserInfo(req.user.id, providerId);
    const tokenInfo = await GoogleDriveService.getTokenExpirationInfo(req.user.id, providerId);

    res.json({
      connected: true,
      userInfo: {
        displayName: userInfo.displayName,
        mail: userInfo.mail,
        picture: userInfo.picture
      },
      tokenInfo: {
        expiresAt: tokenInfo.expiresAt,
        minutesUntilExpiry: tokenInfo.minutesUntilExpiry,
        isExpiring: tokenInfo.isExpiring,
        isExpired: tokenInfo.isExpired
      },
      message: tokenInfo.isExpiring
        ? 'Google Drive account connected (tokens expiring soon)'
        : 'Google Drive account connected successfully'
    });
  } catch (error) {
    logger.error('Error getting Google Drive status:', {
      component: 'Google Drive',
      error: error.message
    });

    if (error.message.includes('authentication required')) {
      return res.json({
        connected: false,
        message: 'Google Drive authentication expired'
      });
    }

    return sendInternalError(res, error, 'get Google Drive status');
  }
});

/**
 * Disconnect Google Drive account
 * POST /api/integrations/googledrive/disconnect
 */
router.post('/disconnect', authRequired, async (req, res) => {
  try {
    if (!req.user?.id || req.user.id === 'anonymous') {
      return sendAuthRequired(res);
    }

    const providerId =
      (typeof req.query.providerId === 'string' && req.query.providerId) ||
      (typeof req.body?.providerId === 'string' && req.body.providerId) ||
      undefined;

    const success = await GoogleDriveService.deleteUserTokens(req.user.id, providerId);

    if (success) {
      logger.info('Google Drive disconnected', {
        component: 'Google Drive',
        userId: req.user.id,
        providerId
      });
      res.json({
        success: true,
        message: 'Google Drive account disconnected successfully'
      });
    } else {
      res.json({
        success: false,
        message: 'No Google Drive connection found to disconnect'
      });
    }
  } catch (error) {
    return sendInternalError(res, error, 'disconnect Google Drive');
  }
});

/**
 * Get available source categories
 * GET /api/integrations/googledrive/sources?providerId=xxx
 */
router.get('/sources', authRequired, googleDriveApiLimiter, async (req, res) => {
  try {
    if (!req.user?.id || req.user.id === 'anonymous') {
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
    if (!req.user?.id || req.user.id === 'anonymous') {
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
    if (!req.user?.id || req.user.id === 'anonymous') {
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
    if (!req.user?.id || req.user.id === 'anonymous') {
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
