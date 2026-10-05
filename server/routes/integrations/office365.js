// Office 365 OAuth Integration Routes
// Handles OAuth2 PKCE flow for Microsoft 365 file access authentication

import express from 'express';
import crypto from 'crypto';
import Office365Service from '../../services/integrations/Office365Service.js';
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

/** Picker source id → the provider's `sources` toggle that enables it. */
const SOURCE_SETTINGS = { personal: 'personalDrive', sharepoint: 'followedSites', teams: 'teams' };

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
  // `!` is part of real Graph IDs: business drive IDs look like `b!Xk3…`,
  // consumer item IDs like `ABC123!105`. It is a valid path character.
  return /^[A-Za-z0-9._!\-]+$/.test(trimmed);
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

/**
 * Initiate Office 365 OAuth2 flow for Microsoft 365
 * GET /api/integrations/office365/auth?providerId=xxx
 */
router.get('/auth', authRequired, office365AuthLimiter, async (req, res) => {
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
      service: 'office365',
      providerId,
      userId: req.user.id,
      returnUrl: validatedReturnUrl,
      codeVerifier
    });

    const authUrl = Office365Service.generateAuthUrl(providerId, state, codeVerifier, req);

    logger.info('Initiating Office 365 OAuth', {
      component: 'Office 365',
      userId: req.user?.id,
      providerId
    });

    // Redirect to Microsoft OAuth consent screen
    res.redirect(authUrl);
  } catch (error) {
    return sendInternalError(res, error, 'initiate Office 365 OAuth');
  }
});

/**
 * Handle Office 365 OAuth callback (provider-specific)
 * GET /api/integrations/office365/:providerId/callback
 */
router.get('/:providerId/callback', authOptional, async (req, res) => {
  const { providerId } = req.params;
  const verified = verifyIntegrationOAuthState(req, { service: 'office365', providerId });
  const { returnUrl } = verified;
  try {
    const { code, error: oauthError } = req.query;

    // Only stable codes go into the URL — never the raw IdP error text.
    if (oauthError) {
      logger.error('❌ Office 365 OAuth error:', {
        component: 'Office 365',
        error: oauthError,
        providerId
      });
      const errorCode = oauthError === 'access_denied' ? 'access_denied' : 'oauth_failed';
      return res.redirect(withQueryParam(returnUrl, 'office365_error', errorCode));
    }

    if (!verified.ok) {
      logger.error('❌ Invalid Office 365 OAuth state parameter', {
        component: 'Office 365',
        providerId,
        reason: verified.error
      });
      return res.redirect(withQueryParam(returnUrl, 'office365_error', verified.error));
    }

    // Some IdP edge cases (consent denied without `error`, or a manual
    // hit on the callback URL) can land here with no `code`.
    if (!code) {
      logger.error('❌ Office 365 OAuth callback missing code', {
        component: 'Office 365',
        providerId
      });
      return res.redirect(withQueryParam(returnUrl, 'office365_error', 'missing_code'));
    }

    // Exchange authorization code for tokens (pass request for auto-detection)
    const tokens = await Office365Service.exchangeCodeForTokens(
      providerId,
      code,
      verified.codeVerifier,
      req
    );

    // Verify we received a refresh token
    if (!tokens.refreshToken) {
      logger.error('❌ CRITICAL: No refresh token received from Office 365 OAuth.', {
        component: 'Office 365',
        providerId
      });
      logger.warn(
        '⚠️ Storing tokens WITHOUT refresh capability - user will need to reconnect periodically',
        { component: 'Office 365' }
      );
    }

    await Office365Service.storeUserTokens(verified.userId, tokens);

    logger.info('Office 365 OAuth completed', {
      component: 'Office 365',
      userId: verified.userId,
      providerId
    });

    res.redirect(withQueryParam(returnUrl, 'office365_connected', 'true'));
  } catch (error) {
    logger.error('❌ Error handling Office 365 OAuth callback:', {
      component: 'Office 365',
      error: error.message,
      providerId
    });
    // Stable error codes only — some upstream errors interpolate
    // user-influenced strings. invalid_client = expired/wrong client secret.
    const errorCode = error.code === 'invalid_client' ? 'invalid_client' : 'callback_failed';
    res.redirect(withQueryParam(returnUrl, 'office365_error', errorCode));
  }
});

/**
 * Get Office 365 connection status for current user
 * GET /api/integrations/office365/status
 */
router.get('/status', authRequired, async (req, res) => {
  try {
    if (!req.user?.id || req.user.id === 'anonymous') {
      return sendAuthRequired(res);
    }

    const providerId = typeof req.query.providerId === 'string' ? req.query.providerId : undefined;

    const isAuthenticated = await Office365Service.isUserAuthenticated(req.user.id, providerId);

    if (!isAuthenticated) {
      return res.json({
        connected: false,
        message: 'Office 365 account not connected'
      });
    }

    // Get user info from Microsoft
    const userInfo = await Office365Service.getUserInfo(req.user.id, providerId);

    // Get token expiration info
    const tokenInfo = await Office365Service.getTokenExpirationInfo(req.user.id, providerId);

    res.json({
      connected: true,
      userInfo: {
        displayName: userInfo.displayName,
        mail: userInfo.mail,
        userPrincipalName: userInfo.userPrincipalName,
        jobTitle: userInfo.jobTitle
      },
      tokenInfo: {
        expiresAt: tokenInfo.expiresAt,
        minutesUntilExpiry: tokenInfo.minutesUntilExpiry,
        isExpiring: tokenInfo.isExpiring,
        isExpired: tokenInfo.isExpired
      },
      message: tokenInfo.isExpiring
        ? 'Office 365 account connected (tokens expiring soon)'
        : 'Office 365 account connected successfully'
    });
  } catch (error) {
    logger.error('❌ Error getting Office 365 status:', {
      component: 'Office 365',
      error: error.message
    });

    if (error.message.includes('authentication required')) {
      return res.json({
        connected: false,
        message: 'Office 365 authentication expired'
      });
    }

    return sendInternalError(res, error, 'get Office 365 status');
  }
});

/**
 * Disconnect Office 365 account
 * POST /api/integrations/office365/disconnect
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

    const success = await Office365Service.deleteUserTokens(req.user.id, providerId);

    if (success) {
      logger.info('Office 365 disconnected', {
        component: 'Office 365',
        userId: req.user.id,
        providerId
      });
      res.json({
        success: true,
        message: 'Office 365 account disconnected successfully'
      });
    } else {
      res.json({
        success: false,
        message: 'No Office 365 connection found to disconnect'
      });
    }
  } catch (error) {
    return sendInternalError(res, error, 'disconnect Office 365');
  }
});

/**
 * Get available source categories
 * GET /api/integrations/office365/sources
 */
router.get('/sources', authRequired, async (req, res) => {
  try {
    if (!req.user?.id || req.user.id === 'anonymous') {
      return sendAuthRequired(res);
    }

    // Static source categories (no Graph API calls), limited to the sources
    // the admin enabled for this provider.
    const providerId = typeof req.query.providerId === 'string' ? req.query.providerId : undefined;
    const enabled = Office365Service.getEnabledSources(providerId);
    const allSources = [
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
    const sources = allSources.filter(source => enabled[SOURCE_SETTINGS[source.id]]);

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
    if (!req.user?.id || req.user.id === 'anonymous') {
      return sendAuthRequired(res);
    }

    const { source } = req.params;
    const providerId = typeof req.query.providerId === 'string' ? req.query.providerId : undefined;
    let drives = [];

    // Sources the admin switched off are not offered, and the sign-in did not
    // ask for their permissions either.
    const enabled = Office365Service.getEnabledSources(providerId);
    const sourceSetting = SOURCE_SETTINGS[source];
    if (sourceSetting && !enabled[sourceSetting]) {
      return sendErrorResponse(res, 403, 'This source is not enabled for this provider');
    }

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
    if (!req.user?.id || req.user.id === 'anonymous') {
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
    if (!req.user?.id || req.user.id === 'anonymous') {
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
