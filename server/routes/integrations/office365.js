// Office 365 OAuth Integration Routes
// Handles OAuth2 PKCE flow for Microsoft 365 file access authentication

import express from 'express';
import crypto from 'crypto';
import Office365Service from '../../services/integrations/Office365Service.js';
import { authOptional, authRequired } from '../../middleware/authRequired.js';
import { requireFeature } from '../../featureRegistry.js';
import logger from '../../utils/logger.js';
import rateLimit from 'express-rate-limit';

const router = express.Router();

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
      return res.status(400).json({
        error: 'Missing providerId',
        message: 'providerId query parameter is required'
      });
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
      return res.status(500).json({
        error: 'Session not available',
        message: 'Session middleware is required for Office 365 OAuth integrations.'
      });
    }

    // Generate state for CSRF protection
    const state = crypto.randomBytes(32).toString('hex');

    // Generate PKCE parameters
    const codeVerifier = crypto.randomBytes(32).toString('base64url');

    // Store OAuth parameters in session with provider-specific key
    // This allows multiple Office 365 providers to have concurrent OAuth flows
    const sessionKey = `oauth_office365_${providerId}`;
    req.session[sessionKey] = {
      state,
      codeVerifier,
      providerId,
      userId: req.user?.id || 'fallback-user',
      returnUrl: returnUrl || '/settings/integrations',
      timestamp: Date.now()
    };

    // Generate authorization URL (pass request for auto-detection)
    const authUrl = Office365Service.generateAuthUrl(providerId, state, codeVerifier, req);

    logger.info(
      `🔗 Initiating Office 365 OAuth for user ${req.user?.id} - Provider: ${providerId}`,
      {
        component: 'Office 365'
      }
    );

    // Redirect to Microsoft OAuth consent screen
    res.redirect(authUrl);
  } catch (error) {
    logger.error('❌ Error initiating Office 365 OAuth:', {
      component: 'Office 365',
      error: error.message
    });
    res.status(500).json({
      error: 'OAuth initiation failed',
      message: error.message
    });
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
    if (!storedAuth || storedAuth.state !== state) {
      logger.error('❌ Invalid Office 365 OAuth state parameter', {
        component: 'Office 365',
        providerId
      });
      return res.redirect('/settings/integrations?office365_error=invalid_state');
    }

    // Verify providerId matches
    if (storedAuth.providerId !== providerId) {
      logger.error('❌ Provider ID mismatch in Office 365 OAuth callback', {
        component: 'Office 365',
        urlProviderId: providerId,
        sessionProviderId: storedAuth.providerId
      });
      return res.redirect('/settings/integrations?office365_error=provider_mismatch');
    }

    // Check session timeout (15 minutes)
    if (Date.now() - storedAuth.timestamp > 15 * 60 * 1000) {
      logger.error('❌ Office 365 OAuth session expired', {
        component: 'Office 365',
        providerId
      });
      return res.redirect('/settings/integrations?office365_error=session_expired');
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

    logger.info(`✅ Office 365 OAuth completed for user ${storedAuth.userId}`, {
      component: 'Office 365',
      providerId: storedAuth.providerId
    });

    // Redirect back to settings with success
    res.redirect('/settings/integrations?office365_connected=true');
  } catch (error) {
    logger.error('❌ Error handling Office 365 OAuth callback:', {
      component: 'Office 365',
      error: error.message,
      providerId: req.params.providerId
    });

    // Clear session data on error
    if (req.session) {
      delete req.session[`oauth_office365_${req.params.providerId}`];
    }

    res.redirect(`/settings/integrations?office365_error=${encodeURIComponent(error.message)}`);
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

    logger.info(`✅ Office 365 OAuth completed for user ${storedAuth.userId}`, {
      component: 'Office 365',
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
    res.redirect(`${returnUrl}${separator}office365_error=${encodeURIComponent(error.message)}`);
  }
});

/**
 * Get Office 365 connection status for current user
 * GET /api/integrations/office365/status
 */
router.get('/status', authRequired, async (req, res) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Authentication required' });
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

    res.status(500).json({
      error: 'Status check failed',
      message: error.message
    });
  }
});

/**
 * Disconnect Office 365 account
 * POST /api/integrations/office365/disconnect
 */
router.post('/disconnect', authRequired, async (req, res) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const success = await Office365Service.deleteUserTokens(req.user.id);

    if (success) {
      logger.info(`🔓 Office 365 disconnected for user ${req.user.id}`, {
        component: 'Office 365'
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
    logger.error('❌ Error disconnecting Office 365:', {
      component: 'Office 365',
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
 * GET /api/integrations/office365/sources
 */
router.get('/sources', authRequired, async (req, res) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Authentication required' });
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

    res.status(500).json({
      error: 'Failed to get sources',
      message: error.message
    });
  }
});

/**
 * List drives for a specific source
 * GET /api/integrations/office365/drives/:source
 */
router.get('/drives/:source', authRequired, async (req, res) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Authentication required' });
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
        return res.status(400).json({
          error: 'Invalid source',
          message: `Source must be one of: personal, sharepoint, teams`
        });
    }

    res.json({
      success: true,
      drives
    });
  } catch (error) {
    logger.error(`❌ Error listing Office 365 drives for source ${req.params.source}:`, {
      component: 'Office 365',
      error: error.message
    });

    if (error.message.includes('authentication required')) {
      return res.status(401).json({
        error: 'Authentication required',
        message: 'Please reconnect your Office 365 account'
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
 * GET /api/integrations/office365/items?driveId=xxx&folderId=xxx&search=xxx
 */
router.get('/items', authRequired, async (req, res) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { driveId, folderId, search } = req.query;

    let items;
    // If search query is provided, use search endpoint
    if (search && search.trim().length > 0) {
      if (!driveId) {
        return res.status(400).json({
          error: 'Missing driveId',
          message: 'driveId is required for search'
        });
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
      return res.status(401).json({
        error: 'Authentication required',
        message: 'Please reconnect your Office 365 account'
      });
    }

    res.status(500).json({
      error: 'Failed to list items',
      message: error.message
    });
  }
});

/**
 * Download a file from Office 365
 * GET /api/integrations/office365/download?fileId=xxx&driveId=xxx
 */
router.get('/download', authRequired, async (req, res) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { fileId, driveId } = req.query;

    if (!fileId) {
      return res.status(400).json({
        error: 'Missing fileId',
        message: 'fileId query parameter is required'
      });
    }

    const file = await Office365Service.downloadFile(req.user.id, fileId, driveId);

    // Set appropriate headers
    res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
    res.setHeader('Content-Length', file.size);
    res.setHeader('Content-Disposition', `attachment; filename="${file.name}"`);

    // Send file content
    res.send(file.content);
  } catch (error) {
    logger.error('❌ Error downloading Office 365 file:', {
      component: 'Office 365',
      error: error.message
    });

    if (error.message.includes('authentication required')) {
      return res.status(401).json({
        error: 'Authentication required',
        message: 'Please reconnect your Office 365 account'
      });
    }

    res.status(500).json({
      error: 'Failed to download file',
      message: error.message
    });
  }
});

export default router;
