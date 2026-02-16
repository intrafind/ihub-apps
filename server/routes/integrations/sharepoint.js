// SharePoint OAuth Integration Routes
// Handles OAuth2 PKCE flow for Microsoft 365 SharePoint/OneDrive authentication

import express from 'express';
import crypto from 'crypto';
import SharePointService from '../../services/integrations/SharePointService.js';
import { authOptional, authRequired } from '../../middleware/authRequired.js';
import logger from '../../utils/logger.js';

const router = express.Router();

/**
 * Initiate SharePoint OAuth2 flow for Microsoft 365
 * GET /api/integrations/sharepoint/auth?providerId=xxx
 */
router.get('/auth', authRequired, async (req, res) => {
  try {
    const { providerId } = req.query;

    if (!providerId) {
      return res.status(400).json({
        error: 'Missing providerId',
        message: 'providerId query parameter is required'
      });
    }

    logger.debug('🔍 SharePoint Auth Debug:', {
      component: 'SharePoint',
      hasUser: !!req.user,
      userId: req.user?.id,
      providerId,
      hasSession: !!req.session
    });

    // Check if session is available
    if (!req.session) {
      return res.status(500).json({
        error: 'Session not available',
        message: 'Session middleware is required for SharePoint OAuth integrations.'
      });
    }

    // Generate state for CSRF protection
    const state = crypto.randomBytes(32).toString('hex');

    // Generate PKCE parameters
    const codeVerifier = crypto.randomBytes(32).toString('base64url');

    // Store OAuth parameters in session
    req.session.sharepointAuth = {
      state,
      codeVerifier,
      providerId,
      userId: req.user?.id || 'fallback-user',
      timestamp: Date.now()
    };

    // Generate authorization URL
    const authUrl = SharePointService.generateAuthUrl(providerId, state, codeVerifier);

    logger.info(`🔗 Initiating SharePoint OAuth for user ${req.user?.id} - Provider: ${providerId}`, {
      component: 'SharePoint'
    });

    // Redirect to Microsoft OAuth consent screen
    res.redirect(authUrl);
  } catch (error) {
    logger.error('❌ Error initiating SharePoint OAuth:', {
      component: 'SharePoint',
      error: error.message
    });
    res.status(500).json({
      error: 'OAuth initiation failed',
      message: error.message
    });
  }
});

/**
 * Handle SharePoint OAuth callback
 * GET /api/integrations/sharepoint/callback
 */
router.get('/callback', authOptional, async (req, res) => {
  try {
    const { code, state, error: oauthError } = req.query;

    // Check for OAuth errors
    if (oauthError) {
      logger.error('❌ SharePoint OAuth error:', {
        component: 'SharePoint',
        error: oauthError
      });
      return res.redirect(`/settings/integrations?sharepoint_error=${encodeURIComponent(oauthError)}`);
    }

    // Check if session is available
    if (!req.session) {
      logger.error('❌ No session available for SharePoint OAuth callback', {
        component: 'SharePoint'
      });
      return res.redirect('/settings/integrations?sharepoint_error=no_session');
    }

    // Validate state parameter
    const storedAuth = req.session.sharepointAuth;
    if (!storedAuth || storedAuth.state !== state) {
      logger.error('❌ Invalid SharePoint OAuth state parameter', {
        component: 'SharePoint'
      });
      return res.redirect('/settings/integrations?sharepoint_error=invalid_state');
    }

    // Check session timeout (15 minutes)
    if (Date.now() - storedAuth.timestamp > 15 * 60 * 1000) {
      logger.error('❌ SharePoint OAuth session expired', {
        component: 'SharePoint'
      });
      return res.redirect('/settings/integrations?sharepoint_error=session_expired');
    }

    // Exchange authorization code for tokens
    const tokens = await SharePointService.exchangeCodeForTokens(
      storedAuth.providerId,
      code,
      storedAuth.codeVerifier
    );

    // Verify we received a refresh token
    if (!tokens.refreshToken) {
      logger.error('❌ CRITICAL: No refresh token received from SharePoint OAuth.', {
        component: 'SharePoint'
      });
      logger.warn(
        '⚠️ Storing tokens WITHOUT refresh capability - user will need to reconnect periodically',
        { component: 'SharePoint' }
      );
    }

    // Store encrypted tokens for user
    await SharePointService.storeUserTokens(storedAuth.userId, tokens);

    // Clear session data
    delete req.session.sharepointAuth;

    logger.info(`✅ SharePoint OAuth completed for user ${storedAuth.userId}`, {
      component: 'SharePoint',
      providerId: storedAuth.providerId
    });

    // Redirect back to settings with success
    res.redirect('/settings/integrations?sharepoint_connected=true');
  } catch (error) {
    logger.error('❌ Error handling SharePoint OAuth callback:', {
      component: 'SharePoint',
      error: error.message
    });

    // Clear session data on error
    if (req.session) {
      delete req.session.sharepointAuth;
    }

    res.redirect(
      `/settings/integrations?sharepoint_error=${encodeURIComponent(error.message)}`
    );
  }
});

/**
 * Get SharePoint connection status for current user
 * GET /api/integrations/sharepoint/status
 */
router.get('/status', authRequired, async (req, res) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const isAuthenticated = await SharePointService.isUserAuthenticated(req.user.id);

    if (!isAuthenticated) {
      return res.json({
        connected: false,
        message: 'SharePoint account not connected'
      });
    }

    // Get user info from Microsoft
    const userInfo = await SharePointService.getUserInfo(req.user.id);

    // Get token expiration info
    const tokenInfo = await SharePointService.getTokenExpirationInfo(req.user.id);

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
        ? 'SharePoint account connected (tokens expiring soon)'
        : 'SharePoint account connected successfully'
    });
  } catch (error) {
    logger.error('❌ Error getting SharePoint status:', {
      component: 'SharePoint',
      error: error.message
    });

    if (error.message.includes('authentication required')) {
      return res.json({
        connected: false,
        message: 'SharePoint authentication expired'
      });
    }

    res.status(500).json({
      error: 'Status check failed',
      message: error.message
    });
  }
});

/**
 * Disconnect SharePoint account
 * POST /api/integrations/sharepoint/disconnect
 */
router.post('/disconnect', authRequired, async (req, res) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const success = await SharePointService.deleteUserTokens(req.user.id);

    if (success) {
      logger.info(`🔓 SharePoint disconnected for user ${req.user.id}`, {
        component: 'SharePoint'
      });
      res.json({
        success: true,
        message: 'SharePoint account disconnected successfully'
      });
    } else {
      res.json({
        success: false,
        message: 'No SharePoint connection found to disconnect'
      });
    }
  } catch (error) {
    logger.error('❌ Error disconnecting SharePoint:', {
      component: 'SharePoint',
      error: error.message
    });
    res.status(500).json({
      error: 'Disconnect failed',
      message: error.message
    });
  }
});

/**
 * List available drives (OneDrive, SharePoint sites)
 * GET /api/integrations/sharepoint/drives
 */
router.get('/drives', authRequired, async (req, res) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const drives = await SharePointService.listDrives(req.user.id);

    res.json({
      success: true,
      drives
    });
  } catch (error) {
    logger.error('❌ Error listing SharePoint drives:', {
      component: 'SharePoint',
      error: error.message
    });

    if (error.message.includes('authentication required')) {
      return res.status(401).json({
        error: 'Authentication required',
        message: 'Please reconnect your SharePoint account'
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
 * GET /api/integrations/sharepoint/items?driveId=xxx&folderId=xxx
 */
router.get('/items', authRequired, async (req, res) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { driveId, folderId } = req.query;

    const items = await SharePointService.listItems(req.user.id, driveId, folderId);

    res.json({
      success: true,
      items
    });
  } catch (error) {
    logger.error('❌ Error listing SharePoint items:', {
      component: 'SharePoint',
      error: error.message
    });

    if (error.message.includes('authentication required')) {
      return res.status(401).json({
        error: 'Authentication required',
        message: 'Please reconnect your SharePoint account'
      });
    }

    res.status(500).json({
      error: 'Failed to list items',
      message: error.message
    });
  }
});

/**
 * Download a file from SharePoint
 * GET /api/integrations/sharepoint/download?fileId=xxx&driveId=xxx
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

    const file = await SharePointService.downloadFile(req.user.id, fileId, driveId);

    // Set appropriate headers
    res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
    res.setHeader('Content-Length', file.size);
    res.setHeader('Content-Disposition', `attachment; filename="${file.name}"`);

    // Send file content
    res.send(file.content);
  } catch (error) {
    logger.error('❌ Error downloading SharePoint file:', {
      component: 'SharePoint',
      error: error.message
    });

    if (error.message.includes('authentication required')) {
      return res.status(401).json({
        error: 'Authentication required',
        message: 'Please reconnect your SharePoint account'
      });
    }

    res.status(500).json({
      error: 'Failed to download file',
      message: error.message
    });
  }
});

export default router;
