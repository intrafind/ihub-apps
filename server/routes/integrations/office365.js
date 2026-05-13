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
import { buildContentDisposition } from '../../utils/safeContentDisposition.js';

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

    logger.debug('🔍 Office 365 Auth Debug:', {
      component: 'Office 365',
      hasUser: !!req.user,
      userId: req.user?.id,
      providerId,
      returnUrl,
      hasSession: !!req.session
    });

    // Check if session is available
    if (!req.session) {
      return sendErrorResponse(res, 500, 'Session not available');
    }

    // authRequired only rejects missing `req.user` or anonymous users;
    // it does NOT guarantee req.user.id is truthy. Refuse to start an
    // OAuth flow without a real user id — otherwise tokens would land
    // under a shared sentinel key and could be read by another caller.
    if (!req.user?.id) {
      return sendAuthRequired(res);
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
    // This allows multiple Office 365 providers to have concurrent OAuth flows
    const sessionKey = `oauth_office365_${providerId}`;
    req.session[sessionKey] = {
      state,
      codeVerifier,
      providerId,
      userId: req.user.id,
      returnUrl: validatedReturnUrl,
      timestamp: Date.now()
    };

    // Generate authorization URL (pass request for auto-detection)
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
  try {
    const { code, state, error: oauthError } = req.query;
    const { providerId } = req.params;

    // Check for OAuth errors
    if (oauthError) {
      logger.error('❌ Office 365 OAuth error:', {
        component: 'Office 365',
        error: oauthError,
        providerId
      });
      // Redirect with a generic error code to avoid exposing raw error details in the URL
      return res.redirect('/settings/integrations?office365_error=oauth_failed');
    }

    // Some IdP edge cases (consent denied without `error`, or a manual
    // hit on the callback URL) can land here with no `code`. Surface a
    // stable error code instead of throwing inside `exchangeCodeForTokens`
    // and leaking the raw error into the redirect URL.
    if (!code) {
      logger.error('❌ Office 365 OAuth callback missing code', {
        component: 'Office 365',
        providerId
      });
      return res.redirect('/settings/integrations?office365_error=missing_code');
    }

    // Check if session is available
    if (!req.session) {
      logger.error('❌ No session available for Office 365 OAuth callback', {
        component: 'Office 365',
        providerId
      });
      return res.redirect('/settings/integrations?office365_error=no_session');
    }

    // Validate state parameter
    const sessionKey = `oauth_office365_${providerId}`;
    const storedAuth = req.session[sessionKey];

    // Extract returnUrl early for use in all redirects
    const returnUrl = storedAuth?.returnUrl || '/settings/integrations';
    const separator = returnUrl.includes('?') ? '&' : '?';

    if (!storedAuth || storedAuth.state !== state) {
      logger.error('❌ Invalid Office 365 OAuth state parameter', {
        component: 'Office 365',
        providerId
      });
      return res.redirect(`${returnUrl}${separator}office365_error=invalid_state`);
    }

    // Verify providerId matches
    if (storedAuth.providerId !== providerId) {
      logger.error('❌ Provider ID mismatch in Office 365 OAuth callback', {
        component: 'Office 365',
        urlProviderId: providerId,
        sessionProviderId: storedAuth.providerId
      });
      return res.redirect(`${returnUrl}${separator}office365_error=provider_mismatch`);
    }

    // Check session timeout (15 minutes)
    if (Date.now() - storedAuth.timestamp > 15 * 60 * 1000) {
      logger.error('❌ Office 365 OAuth session expired', {
        component: 'Office 365',
        providerId
      });
      return res.redirect(`${returnUrl}${separator}office365_error=session_expired`);
    }

    // Exchange authorization code for tokens (pass request for auto-detection)
    const tokens = await Office365Service.exchangeCodeForTokens(
      storedAuth.providerId,
      code,
      storedAuth.codeVerifier,
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

    // Store encrypted tokens for user
    await Office365Service.storeUserTokens(storedAuth.userId, tokens);

    // Clear session data
    delete req.session[sessionKey];

    logger.info('Office 365 OAuth completed', {
      component: 'Office 365',
      userId: storedAuth.userId,
      providerId: storedAuth.providerId
    });

    // Redirect back to the original page with success
    res.redirect(`${returnUrl}${separator}office365_connected=true`);
  } catch (error) {
    logger.error('❌ Error handling Office 365 OAuth callback:', {
      component: 'Office 365',
      error: error.message,
      providerId: req.params.providerId
    });

    // Try to get returnUrl from session before clearing
    let catchReturnUrl = '/settings/integrations';
    if (req.session) {
      const catchKey = `oauth_office365_${req.params.providerId}`;
      catchReturnUrl = req.session[catchKey]?.returnUrl || catchReturnUrl;
      delete req.session[catchKey];
    }

    const catchSeparator = catchReturnUrl.includes('?') ? '&' : '?';
    // Use a stable error code rather than echoing `error.message` —
    // some upstream errors interpolate user-influenced strings, and
    // we don't want those landing in the redirect URL.
    res.redirect(`${catchReturnUrl}${catchSeparator}office365_error=callback_failed`);
  }
});

/**
 * Handle Office 365 OAuth callback (legacy - without provider ID in URL)
 * GET /api/integrations/office365/callback
 * @deprecated Use /:providerId/callback instead
 */
router.get('/callback', authOptional, async (req, res) => {
  try {
    const { code, state, error: oauthError } = req.query;

    // Find the session key that matches the state parameter
    // We need to iterate through session keys to find the matching OAuth flow
    let storedAuth = null;
    let sessionKey = null;

    if (req.session) {
      // Look for any oauth_office365_* keys in the session
      for (const key of Object.keys(req.session)) {
        if (key.startsWith('oauth_office365_') && req.session[key]?.state === state) {
          storedAuth = req.session[key];
          sessionKey = key;
          break;
        }
      }
    }

    // Get return URL early for error redirects
    const returnUrl = storedAuth?.returnUrl || '/settings/integrations';
    const separator = returnUrl.includes('?') ? '&' : '?';

    // Check for OAuth errors
    if (oauthError) {
      logger.error('❌ Office 365 OAuth error:', {
        component: 'Office 365',
        error: oauthError
      });
      // Redirect with a generic error code to avoid exposing raw error details in the URL
      return res.redirect(`${returnUrl}${separator}office365_error=oauth_failed`);
    }

    // Surface a stable error code if the IdP returned no `code`
    // rather than failing inside `exchangeCodeForTokens`.
    if (!code) {
      logger.error('❌ Office 365 OAuth legacy callback missing code', {
        component: 'Office 365'
      });
      return res.redirect(`${returnUrl}${separator}office365_error=missing_code`);
    }

    // Check if session is available
    if (!req.session) {
      logger.error('❌ No session available for Office 365 OAuth callback', {
        component: 'Office 365'
      });
      return res.redirect(`${returnUrl}${separator}office365_error=no_session`);
    }

    // Validate state parameter - storedAuth should have been found above
    if (!storedAuth || storedAuth.state !== state) {
      logger.error('❌ Invalid Office 365 OAuth state parameter', {
        component: 'Office 365'
      });
      return res.redirect(`${returnUrl}${separator}office365_error=invalid_state`);
    }

    // Check session timeout (15 minutes)
    if (Date.now() - storedAuth.timestamp > 15 * 60 * 1000) {
      logger.error('❌ Office 365 OAuth session expired', {
        component: 'Office 365'
      });
      return res.redirect(`${returnUrl}${separator}office365_error=session_expired`);
    }

    // Exchange authorization code for tokens (pass request for auto-detection)
    const tokens = await Office365Service.exchangeCodeForTokens(
      storedAuth.providerId,
      code,
      storedAuth.codeVerifier,
      req
    );

    // Verify we received a refresh token
    if (!tokens.refreshToken) {
      logger.error('❌ CRITICAL: No refresh token received from Office 365 OAuth.', {
        component: 'Office 365'
      });
      logger.warn(
        '⚠️ Storing tokens WITHOUT refresh capability - user will need to reconnect periodically',
        { component: 'Office 365' }
      );
    }

    // Store encrypted tokens for user
    await Office365Service.storeUserTokens(storedAuth.userId, tokens);

    // Clear session data using the provider-specific key
    if (sessionKey) {
      delete req.session[sessionKey];
    }

    logger.info('Office 365 OAuth completed', {
      component: 'Office 365',
      userId: storedAuth.userId,
      providerId: storedAuth.providerId,
      returnUrl
    });

    // Redirect back to the original page with success
    res.redirect(`${returnUrl}${separator}office365_connected=true`);
  } catch (error) {
    logger.error('❌ Error handling Office 365 OAuth callback:', {
      component: 'Office 365',
      error: error.message
    });

    // Try to find any Office 365 OAuth session to get return URL
    let returnUrl = '/settings/integrations';
    if (req.session) {
      for (const key of Object.keys(req.session)) {
        if (key.startsWith('oauth_office365_')) {
          returnUrl = req.session[key]?.returnUrl || returnUrl;
          // Clear the session key
          delete req.session[key];
        }
      }
    }

    const separator = returnUrl.includes('?') ? '&' : '?';
    // Stable error code; see note on the provider-specific callback.
    res.redirect(`${returnUrl}${separator}office365_error=callback_failed`);
  }
});

/**
 * Get Office 365 connection status for current user
 * GET /api/integrations/office365/status
 */
router.get('/status', authRequired, async (req, res) => {
  try {
    if (!req.user?.id) {
      return sendAuthRequired(res);
    }

    const isAuthenticated = await Office365Service.isUserAuthenticated(req.user.id);

    if (!isAuthenticated) {
      return res.json({
        connected: false,
        message: 'Office 365 account not connected'
      });
    }

    // Get user info from Microsoft
    const userInfo = await Office365Service.getUserInfo(req.user.id);

    // Get token expiration info
    const tokenInfo = await Office365Service.getTokenExpirationInfo(req.user.id);

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
    if (!req.user?.id) {
      return sendAuthRequired(res);
    }

    const success = await Office365Service.deleteUserTokens(req.user.id);

    if (success) {
      logger.info('Office 365 disconnected', {
        component: 'Office 365',
        userId: req.user.id
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
    let drives = [];

    switch (source) {
      case 'personal':
        drives = await Office365Service.listPersonalDrives(req.user.id);
        break;
      case 'sharepoint':
        drives = await Office365Service.listSharePointDrives(req.user.id);
        break;
      case 'teams':
        drives = await Office365Service.listTeamsDrives(req.user.id);
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
      items = await Office365Service.searchItems(req.user.id, driveId, search);
    } else {
      items = await Office365Service.listItems(req.user.id, driveId, folderId);
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

    if (!fileId) {
      return sendBadRequest(res, 'fileId query parameter is required');
    }

    if (!isValidGraphId(fileId)) {
      return sendBadRequest(res, 'fileId contains invalid characters or is too long');
    }

    if (driveId && !isValidGraphId(driveId)) {
      return sendBadRequest(res, 'driveId contains invalid characters or is too long');
    }

    const file = await Office365Service.downloadFile(req.user.id, fileId, driveId);

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
