// Google Drive OAuth Integration Routes
// Handles OAuth2 PKCE flow for Google Workspace file access authentication

import express from 'express';
import crypto from 'crypto';
import GoogleDriveService from '../../services/integrations/GoogleDriveService.js';
import { authOptional, authRequired } from '../../middleware/authRequired.js';
import { requireFeature } from '../../featureRegistry.js';
import logger from '../../utils/logger.js';
import rateLimit from 'express-rate-limit';

const router = express.Router();

/**
 * Validate returnUrl to prevent open redirect attacks.
 * Allows relative paths and absolute URLs on the same hostname (any port).
 */
function isValidReturnUrl(returnUrl, req) {
  if (!returnUrl) return false;
  if (returnUrl.startsWith('/')) return true;
  try {
    const url = new URL(returnUrl);
    return url.hostname === req.hostname;
  } catch {
    return false;
  }
}

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

/**
 * Initiate Google Drive OAuth2 flow
 * GET /api/integrations/googledrive/auth?providerId=xxx
 */
router.get('/auth', authRequired, googleDriveAuthLimiter, async (req, res) => {
  try {
    const { providerId, returnUrl } = req.query;

    if (!providerId) {
      return res.status(400).json({
        error: 'Missing providerId',
        message: 'providerId query parameter is required'
      });
    }

    logger.debug('Google Drive Auth Debug:', {
      component: 'Google Drive',
      hasUser: !!req.user,
      userId: req.user?.id,
      providerId,
      returnUrl,
      hasSession: !!req.session
    });

    if (!req.session) {
      return res.status(500).json({
        error: 'Session not available',
        message: 'Session middleware is required for Google Drive OAuth integrations.'
      });
    }

    // Generate state for CSRF protection
    const state = crypto.randomBytes(32).toString('hex');

    // Generate PKCE parameters
    const codeVerifier = crypto.randomBytes(32).toString('base64url');

    // Validate returnUrl to prevent open redirects
    const validatedReturnUrl = isValidReturnUrl(returnUrl, req)
      ? returnUrl
      : '/settings/integrations';

    // Store OAuth parameters in session with provider-specific key
    const sessionKey = `oauth_googledrive_${providerId}`;
    req.session[sessionKey] = {
      state,
      codeVerifier,
      providerId,
      userId: req.user?.id || 'fallback-user',
      returnUrl: validatedReturnUrl,
      timestamp: Date.now()
    };

    // Generate authorization URL
    const authUrl = GoogleDriveService.generateAuthUrl(providerId, state, codeVerifier, req);

    logger.info(
      `Initiating Google Drive OAuth for user ${req.user?.id} - Provider: ${providerId}`,
      { component: 'Google Drive' }
    );

    res.redirect(authUrl);
  } catch (error) {
    logger.error('Error initiating Google Drive OAuth:', {
      component: 'Google Drive',
      error: error.message
    });
    res.status(500).json({
      error: 'OAuth initiation failed',
      message: error.message
    });
  }
});

/**
 * Handle Google Drive OAuth callback (provider-specific)
 * GET /api/integrations/googledrive/:providerId/callback
 */
router.get('/:providerId/callback', authOptional, async (req, res) => {
  try {
    const { code, state, error: oauthError } = req.query;
    const { providerId } = req.params;

    if (oauthError) {
      logger.error('Google Drive OAuth error:', {
        component: 'Google Drive',
        error: oauthError,
        providerId
      });
      return res.redirect('/settings/integrations?googledrive_error=oauth_failed');
    }

    if (!req.session) {
      logger.error('No session available for Google Drive OAuth callback', {
        component: 'Google Drive',
        providerId
      });
      return res.redirect('/settings/integrations?googledrive_error=no_session');
    }

    // Validate state parameter
    const sessionKey = `oauth_googledrive_${providerId}`;
    const storedAuth = req.session[sessionKey];

    const returnUrl = storedAuth?.returnUrl || '/settings/integrations';
    const separator = returnUrl.includes('?') ? '&' : '?';

    if (!storedAuth || storedAuth.state !== state) {
      logger.error('Invalid Google Drive OAuth state parameter', {
        component: 'Google Drive',
        providerId
      });
      return res.redirect(`${returnUrl}${separator}googledrive_error=invalid_state`);
    }

    if (storedAuth.providerId !== providerId) {
      logger.error('Provider ID mismatch in Google Drive OAuth callback', {
        component: 'Google Drive',
        urlProviderId: providerId,
        sessionProviderId: storedAuth.providerId
      });
      return res.redirect(`${returnUrl}${separator}googledrive_error=provider_mismatch`);
    }

    // Check session timeout (15 minutes)
    if (Date.now() - storedAuth.timestamp > 15 * 60 * 1000) {
      logger.error('Google Drive OAuth session expired', {
        component: 'Google Drive',
        providerId
      });
      return res.redirect(`${returnUrl}${separator}googledrive_error=session_expired`);
    }

    // Exchange authorization code for tokens
    const tokens = await GoogleDriveService.exchangeCodeForTokens(
      storedAuth.providerId,
      code,
      storedAuth.codeVerifier,
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

    // Store encrypted tokens for user
    await GoogleDriveService.storeUserTokens(storedAuth.userId, tokens);

    // Clear session data
    delete req.session[sessionKey];

    logger.info(`Google Drive OAuth completed for user ${storedAuth.userId}`, {
      component: 'Google Drive',
      providerId: storedAuth.providerId
    });

    res.redirect(`${returnUrl}${separator}googledrive_connected=true`);
  } catch (error) {
    logger.error('Error handling Google Drive OAuth callback:', {
      component: 'Google Drive',
      error: error.message,
      providerId: req.params.providerId
    });

    let catchReturnUrl = '/settings/integrations';
    if (req.session) {
      const catchKey = `oauth_googledrive_${req.params.providerId}`;
      catchReturnUrl = req.session[catchKey]?.returnUrl || catchReturnUrl;
      delete req.session[catchKey];
    }

    const catchSeparator = catchReturnUrl.includes('?') ? '&' : '?';
    res.redirect(
      `${catchReturnUrl}${catchSeparator}googledrive_error=${encodeURIComponent(error.message)}`
    );
  }
});

/**
 * Get Google Drive connection status for current user
 * GET /api/integrations/googledrive/status
 */
router.get('/status', authRequired, async (req, res) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const isAuthenticated = await GoogleDriveService.isUserAuthenticated(req.user.id);

    if (!isAuthenticated) {
      return res.json({
        connected: false,
        message: 'Google Drive account not connected'
      });
    }

    const userInfo = await GoogleDriveService.getUserInfo(req.user.id);
    const tokenInfo = await GoogleDriveService.getTokenExpirationInfo(req.user.id);

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

    res.status(500).json({
      error: 'Status check failed',
      message: error.message
    });
  }
});

/**
 * Disconnect Google Drive account
 * POST /api/integrations/googledrive/disconnect
 */
router.post('/disconnect', authRequired, async (req, res) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const success = await GoogleDriveService.deleteUserTokens(req.user.id);

    if (success) {
      logger.info(`Google Drive disconnected for user ${req.user.id}`, {
        component: 'Google Drive'
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
    logger.error('Error disconnecting Google Drive:', {
      component: 'Google Drive',
      error: error.message
    });
    res.status(500).json({
      error: 'Disconnect failed',
      message: error.message
    });
  }
});

/**
 * Get available source categories
 * GET /api/integrations/googledrive/sources?providerId=xxx
 */
router.get('/sources', authRequired, async (req, res) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const sources = [
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

    res.json({
      success: true,
      sources
    });
  } catch (error) {
    logger.error('Error getting Google Drive sources:', {
      component: 'Google Drive',
      error: error.message
    });

    res.status(500).json({
      error: 'Failed to get sources',
      message: error.message
    });
  }
});

/**
 * List drives for a specific source
 * GET /api/integrations/googledrive/drives/:source
 */
router.get('/drives/:source', authRequired, async (req, res) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { source } = req.params;
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
        drives = await GoogleDriveService.listSharedDrives(req.user.id);
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
        return res.status(400).json({
          error: 'Invalid source',
          message: 'Source must be one of: myDrive, sharedDrives, sharedWithMe'
        });
    }

    res.json({
      success: true,
      drives
    });
  } catch (error) {
    logger.error(`Error listing Google Drive drives for source ${req.params.source}:`, {
      component: 'Google Drive',
      error: error.message
    });

    if (error.message.includes('authentication required')) {
      return res.status(401).json({
        error: 'Authentication required',
        message: 'Please reconnect your Google Drive account'
      });
    }

    res.status(500).json({
      error: 'Failed to list drives',
      message: error.message
    });
  }
});

/**
 * List items in a drive folder
 * GET /api/integrations/googledrive/items?driveId=xxx&folderId=xxx&search=xxx&source=xxx
 */
router.get('/items', authRequired, async (req, res) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { driveId, folderId, search, source } = req.query;

    let items;

    if (search && search.trim().length > 0) {
      // Search mode
      const searchDriveId =
        driveId && driveId !== 'root' && driveId !== 'sharedWithMe' ? driveId : null;
      items = await GoogleDriveService.searchFiles(req.user.id, search, searchDriveId);
    } else if (source === 'sharedWithMe' || driveId === 'sharedWithMe') {
      // Shared with Me - flat list
      items = await GoogleDriveService.listSharedWithMe(req.user.id);
    } else if (driveId === 'root' || !driveId) {
      // My Drive
      items = await GoogleDriveService.listMyDriveFiles(req.user.id, folderId);
    } else {
      // Shared drive
      items = await GoogleDriveService.listSharedDriveFiles(req.user.id, driveId, folderId);
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
      return res.status(401).json({
        error: 'Authentication required',
        message: 'Please reconnect your Google Drive account'
      });
    }

    res.status(500).json({
      error: 'Failed to list items',
      message: error.message
    });
  }
});

/**
 * Download a file from Google Drive
 * GET /api/integrations/googledrive/download?fileId=xxx
 */
router.get('/download', authRequired, async (req, res) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { fileId } = req.query;

    if (!fileId) {
      return res.status(400).json({
        error: 'Missing fileId',
        message: 'fileId query parameter is required'
      });
    }

    if (!isValidFileId(fileId)) {
      return res.status(400).json({
        error: 'Invalid fileId',
        message: 'fileId must be a valid Google Drive file identifier'
      });
    }

    const file = await GoogleDriveService.downloadFile(req.user.id, fileId);

    res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
    res.setHeader('Content-Length', file.size);
    res.setHeader('Content-Disposition', `attachment; filename="${file.name}"`);

    res.send(file.content);
  } catch (error) {
    logger.error('Error downloading Google Drive file:', {
      component: 'Google Drive',
      error: error.message
    });

    if (error.message.includes('authentication required')) {
      return res.status(401).json({
        error: 'Authentication required',
        message: 'Please reconnect your Google Drive account'
      });
    }

    res.status(500).json({
      error: 'Failed to download file',
      message: error.message
    });
  }
});

export default router;
