// JIRA OAuth Integration Routes
// Handles OAuth2 PKCE flow for JIRA authentication

import express from 'express';
import crypto from 'crypto';
import JiraService from '../../services/integrations/JiraService.js';
import { authOptional, authRequired } from '../../middleware/authRequired.js';
import logger from '../../utils/logger.js';

const router = express.Router();

/**
 * Initiate JIRA OAuth2 flow for Atlassian Cloud
 * GET /api/integrations/jira/auth
 */
router.get('/auth', authRequired, async (req, res) => {
  try {
    logger.debug('🔍 JIRA Auth Debug:', {
      hasUser: !!req.user,
      userId: req.user?.id,
      userGroups: req.user?.groups,
      hasSession: !!req.session,
      cookies: Object.keys(req.cookies || {}),
      authHeader: req.headers.authorization ? 'present' : 'missing'
    });

    // Check if session is available
    if (!req.session) {
      return res.status(500).json({
        error: 'Session not available',
        message: 'Session middleware is required for JIRA OAuth integrations.'
      });
    }

    // Generate state for CSRF protection
    const state = crypto.randomBytes(32).toString('hex');

    // Generate PKCE parameters (may be ignored by Atlassian Cloud)
    const codeVerifier = crypto.randomBytes(32).toString('base64url');

    // Store OAuth parameters in session
    req.session.jiraAuth = {
      state,
      codeVerifier,
      userId: req.user?.id || 'fallback-user',
      timestamp: Date.now()
    };

    // Generate authorization URL for Atlassian Cloud
    const authUrl = JiraService.generateAuthUrl(state, codeVerifier);

    logger.info(`🔗 Initiating JIRA OAuth for user ${req.user?.id} - URL: ${authUrl}`);

    // Redirect to Atlassian OAuth consent screen
    res.redirect(authUrl);
  } catch (error) {
    logger.error('❌ Error initiating JIRA OAuth:', error.message);
    res.status(500).json({
      error: 'OAuth initiation failed',
      message: error.message
    });
  }
});

/**
 * Handle JIRA OAuth callback
 * GET /api/integrations/jira/callback
 */
router.get('/callback', authOptional, async (req, res) => {
  try {
    const { code, state, error } = req.query;

    // Check for OAuth errors
    if (error) {
      logger.error('❌ JIRA OAuth error:', error);
      return res.redirect(`/settings/integrations?jira_error=${encodeURIComponent(error)}`);
    }

    // Check if session is available
    if (!req.session) {
      logger.error('❌ No session available for JIRA OAuth callback');
      return res.redirect('/settings/integrations?jira_error=no_session');
    }

    // Validate state parameter
    const storedAuth = req.session.jiraAuth;
    if (!storedAuth || storedAuth.state !== state) {
      logger.error('❌ Invalid JIRA OAuth state parameter');
      return res.redirect('/settings/integrations?jira_error=invalid_state');
    }

    // Check session timeout (15 minutes)
    if (Date.now() - storedAuth.timestamp > 15 * 60 * 1000) {
      logger.error('❌ JIRA OAuth session expired');
      return res.redirect('/settings/integrations?jira_error=session_expired');
    }

    // Exchange authorization code for tokens
    const tokens = await JiraService.exchangeCodeForTokens(code, storedAuth.codeVerifier);

    // Verify we received a refresh token (required for long-term access)
    if (!tokens.refreshToken) {
      logger.error('❌ CRITICAL: No refresh token received from JIRA OAuth.');
      logger.error(
        '   This means the user will need to re-authenticate when the access token expires (usually within 1 hour).'
      );
      logger.error('   This can happen if:');
      logger.error('   - The JIRA app configuration does not support offline access');
      logger.error('   - The user denied the offline_access scope');
      logger.error('   - Atlassian OAuth server configuration issue');

      // Still store the tokens but with a clear warning in logs
      logger.warn(
        '⚠️ Storing tokens WITHOUT refresh capability - user will need to reconnect every hour'
      );
    }

    // Store encrypted tokens for user
    await JiraService.storeUserTokens(storedAuth.userId, tokens);

    // Clear session data
    delete req.session.jiraAuth;

    logger.info(`✅ JIRA OAuth completed for user ${storedAuth.userId}`);

    // Redirect back to settings with success
    res.redirect('/settings/integrations?jira_connected=true');
  } catch (error) {
    logger.error('❌ Error handling JIRA OAuth callback:', error.message);

    // Clear session data on error
    if (req.session) {
      delete req.session.jiraAuth;
    }

    res.redirect(`/settings/integrations?jira_error=${encodeURIComponent(error.message)}`);
  }
});

/**
 * Get JIRA connection status for current user
 * GET /api/integrations/jira/status
 */
router.get('/status', authRequired, async (req, res) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const isAuthenticated = await JiraService.isUserAuthenticated(req.user.id);

    if (!isAuthenticated) {
      return res.json({
        connected: false,
        message: 'JIRA account not connected'
      });
    }

    // Get user info from JIRA
    const userInfo = await JiraService.getUserInfo(req.user.id);

    // Get token expiration info
    const tokenInfo = await JiraService.getTokenExpirationInfo(req.user.id);

    res.json({
      connected: true,
      userInfo: {
        displayName: userInfo.displayName,
        emailAddress: userInfo.emailAddress,
        accountType: userInfo.accountType,
        active: userInfo.active
      },
      tokenInfo: {
        expiresAt: tokenInfo.expiresAt,
        minutesUntilExpiry: tokenInfo.minutesUntilExpiry,
        isExpiring: tokenInfo.isExpiring,
        isExpired: tokenInfo.isExpired
      },
      message: tokenInfo.isExpiring
        ? 'JIRA account connected (tokens expiring soon)'
        : 'JIRA account connected successfully'
    });
  } catch (error) {
    logger.error('❌ Error getting JIRA status:', error.message);

    if (error.message.includes('authentication required')) {
      return res.json({
        connected: false,
        message: 'JIRA authentication expired'
      });
    }

    res.status(500).json({
      error: 'Status check failed',
      message: error.message
    });
  }
});

/**
 * Disconnect JIRA account
 * POST /api/integrations/jira/disconnect
 */
router.post('/disconnect', authRequired, async (req, res) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const success = await JiraService.deleteUserTokens(req.user.id);

    if (success) {
      logger.info(`🔓 JIRA disconnected for user ${req.user.id}`);
      res.json({
        success: true,
        message: 'JIRA account disconnected successfully'
      });
    } else {
      res.json({
        success: false,
        message: 'No JIRA connection found to disconnect'
      });
    }
  } catch (error) {
    logger.error('❌ Error disconnecting JIRA:', error.message);
    res.status(500).json({
      error: 'Disconnect failed',
      message: error.message
    });
  }
});

/**
 * Refresh JIRA connection and force token refresh
 * POST /api/integrations/jira/refresh
 */
router.post('/refresh', authRequired, async (req, res) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    logger.info(`🔄 Manual JIRA refresh requested for user ${req.user.id}`);

    // Force a fresh check of authentication which will trigger refresh if needed
    const isAuthenticated = await JiraService.isUserAuthenticated(req.user.id);

    if (!isAuthenticated) {
      return res.status(401).json({
        error: 'Authentication required',
        message: 'Please reconnect your JIRA account'
      });
    }

    // Get user info to confirm everything is working
    const userInfo = await JiraService.getUserInfo(req.user.id);

    // Get updated token info
    const tokenInfo = await JiraService.getTokenExpirationInfo(req.user.id);

    res.json({
      success: true,
      userInfo: {
        displayName: userInfo.displayName,
        emailAddress: userInfo.emailAddress,
        accountType: userInfo.accountType,
        active: userInfo.active
      },
      tokenInfo: {
        expiresAt: tokenInfo.expiresAt,
        minutesUntilExpiry: tokenInfo.minutesUntilExpiry,
        isExpiring: tokenInfo.isExpiring,
        isExpired: tokenInfo.isExpired
      },
      message: 'JIRA connection refreshed successfully'
    });
  } catch (error) {
    logger.error('❌ Error refreshing JIRA connection:', error.message);

    if (error.message.includes('authentication required') || error.message.includes('expired')) {
      return res.status(401).json({
        error: 'Authentication required',
        message: 'Please reconnect your JIRA account'
      });
    }

    res.status(500).json({
      error: 'Refresh failed',
      message: error.message
    });
  }
});

/**
 * Proxy endpoint for downloading JIRA attachments
 * GET /api/integrations/jira/attachment/:attachmentId
 */
router.get('/attachment/:attachmentId', authRequired, async (req, res) => {
  try {
    const { attachmentId } = req.params;
    const { download } = req.query;

    if (!req.user?.id) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Get attachment metadata and content
    const attachment = await JiraService.getAttachmentProxy({
      attachmentId,
      userId: req.user.id
    });

    // Set appropriate headers
    res.setHeader('Content-Type', attachment.mimeType || 'application/octet-stream');
    res.setHeader('Content-Length', attachment.size);

    // If download is requested or it's not an image, force download
    if (download === 'true' || !attachment.mimeType?.startsWith('image/')) {
      res.setHeader('Content-Disposition', `attachment; filename="${attachment.filename}"`);
    } else {
      // For images, allow inline display
      res.setHeader('Content-Disposition', `inline; filename="${attachment.filename}"`);
    }

    // Stream the attachment content directly to the response
    attachment.stream.pipe(res);
  } catch (error) {
    logger.error('❌ Error proxying JIRA attachment:', error.message);

    if (error.message.includes('authentication required')) {
      return res.status(401).json({
        error: 'Authentication expired',
        message: 'Please reconnect your JIRA account'
      });
    }

    res.status(500).json({
      error: 'Failed to retrieve attachment',
      message: error.message
    });
  }
});

/**
 * Test JIRA connection
 * GET /api/integrations/jira/test
 */
router.get('/test', authRequired, async (req, res) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Test connection by getting user info
    const userInfo = await JiraService.getUserInfo(req.user.id);

    // Test a simple search
    const testSearch = await JiraService.searchTickets({
      jql: 'assignee = currentUser() ORDER BY updated DESC',
      maxResults: 1,
      userId: req.user.id
    });

    res.json({
      success: true,
      userInfo: {
        displayName: userInfo.displayName,
        emailAddress: userInfo.emailAddress,
        accountType: userInfo.accountType
      },
      testResults: {
        canSearchTickets: true,
        accessibleTickets: testSearch.total
      },
      message: 'JIRA connection test successful'
    });
  } catch (error) {
    logger.error('❌ Error testing JIRA connection:', error.message);

    res.status(500).json({
      success: false,
      error: 'Connection test failed',
      message: error.message
    });
  }
});

export default router;
