// JIRA OAuth Integration Routes
// Handles OAuth2 PKCE flow for JIRA authentication

import express from 'express';
import crypto from 'crypto';
import JiraService from '../../services/integrations/JiraService.js';
import { authOptional, authRequired } from '../../middleware/authRequired.js';
import { requireFeature } from '../../featureRegistry.js';
import logger from '../../utils/logger.js';
import {
  sendInternalError,
  sendAuthRequired,
  sendErrorResponse
} from '../../utils/responseHelpers.js';
import { isValidReturnUrl } from '../../utils/oauthReturnUrl.js';

const router = express.Router();

// Gate all Jira routes behind the integrations feature flag
router.use(requireFeature('integrations'));

/**
 * Initiate JIRA OAuth2 flow for Atlassian Cloud
 * GET /api/integrations/jira/auth
 */
router.get('/auth', authRequired, async (req, res) => {
  try {
    const { returnUrl } = req.query;

    logger.debug('🔍 JIRA Auth Debug:', {
      hasUser: !!req.user,
      userId: req.user?.id,
      userGroups: req.user?.groups,
      returnUrl,
      hasSession: !!req.session,
      cookies: Object.keys(req.cookies || {}),
      authHeader: req.headers.authorization ? 'present' : 'missing'
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

    // Generate PKCE parameters (may be ignored by Atlassian Cloud)
    const codeVerifier = crypto.randomBytes(32).toString('base64url');

    // Validate returnUrl to reject `javascript:`, `data:`, off-host
    // redirects, and protocol-relative URLs that would leak the flow
    // off-site after the callback finishes.
    const validatedReturnUrl = isValidReturnUrl(returnUrl, req)
      ? returnUrl
      : '/settings/integrations';

    // Store OAuth parameters in session with a consistent key
    // Using oauth_jira key for consistency with Office 365 pattern
    const sessionKey = 'oauth_jira';
    req.session[sessionKey] = {
      state,
      codeVerifier,
      userId: req.user.id,
      returnUrl: validatedReturnUrl,
      timestamp: Date.now()
    };

    // Generate authorization URL for Atlassian Cloud
    const authUrl = JiraService.generateAuthUrl(state, codeVerifier);

    logger.info('Initiating JIRA OAuth', { component: 'Jira', userId: req.user?.id, authUrl });

    // Redirect to Atlassian OAuth consent screen
    res.redirect(authUrl);
  } catch (error) {
    return sendInternalError(res, error, 'initiate JIRA OAuth');
  }
});

/**
 * Handle JIRA OAuth callback
 * GET /api/integrations/jira/callback
 */
router.get('/callback', authOptional, async (req, res) => {
  try {
    const { code, state, error } = req.query;

    // Use consistent session key
    const sessionKey = 'oauth_jira';
    const storedAuth = req.session?.[sessionKey];

    // Get return URL early for error redirects
    const returnUrl = storedAuth?.returnUrl || '/settings/integrations';
    const separator = returnUrl.includes('?') ? '&' : '?';

    // Check for OAuth errors
    if (error) {
      logger.error('JIRA OAuth error', { component: 'Jira', oauthError: error });
      // Stable error code rather than echoing the upstream error string.
      return res.redirect(`${returnUrl}${separator}jira_error=oauth_failed`);
    }

    // Surface a stable error code if the IdP returned no `code`
    // rather than failing inside `exchangeCodeForTokens`.
    if (!code) {
      logger.error('JIRA OAuth callback missing code', { component: 'Jira' });
      return res.redirect(`${returnUrl}${separator}jira_error=missing_code`);
    }

    // Check if session is available
    if (!req.session) {
      logger.error('No session available for JIRA OAuth callback', { component: 'Jira' });
      return res.redirect(`${returnUrl}${separator}jira_error=no_session`);
    }

    // Validate state parameter
    if (!storedAuth || storedAuth.state !== state) {
      logger.error('Invalid JIRA OAuth state parameter', { component: 'Jira' });
      return res.redirect(`${returnUrl}${separator}jira_error=invalid_state`);
    }

    // Check session timeout (15 minutes)
    if (Date.now() - storedAuth.timestamp > 15 * 60 * 1000) {
      logger.error('JIRA OAuth session expired', { component: 'Jira' });
      return res.redirect(`${returnUrl}${separator}jira_error=session_expired`);
    }

    // Exchange authorization code for tokens
    const tokens = await JiraService.exchangeCodeForTokens(code, storedAuth.codeVerifier);

    // Verify we received a refresh token (required for long-term access)
    if (!tokens.refreshToken) {
      logger.error(
        'CRITICAL: No refresh token received from JIRA OAuth - user will need to re-authenticate when access token expires',
        {
          component: 'Jira',
          causes: [
            'JIRA app does not support offline access',
            'User denied offline_access scope',
            'Atlassian OAuth server configuration issue'
          ]
        }
      );

      // Still store the tokens but with a clear warning in logs
      logger.warn(
        'Storing tokens WITHOUT refresh capability - user will need to reconnect every hour',
        { component: 'Jira' }
      );
    }

    // Store encrypted tokens for user
    await JiraService.storeUserTokens(storedAuth.userId, tokens);

    // Clear session data using the consistent key
    delete req.session[sessionKey];

    logger.info('JIRA OAuth completed', {
      component: 'Jira',
      userId: storedAuth.userId,
      returnUrl
    });

    // Redirect back to the original page with success
    res.redirect(`${returnUrl}${separator}jira_connected=true`);
  } catch (error) {
    logger.error('Error handling JIRA OAuth callback', { component: 'Jira', error });

    // Get return URL from session (default to /settings/integrations)
    const sessionKey = 'oauth_jira';
    const returnUrl = req.session?.[sessionKey]?.returnUrl || '/settings/integrations';

    // Clear session data on error
    if (req.session && req.session[sessionKey]) {
      delete req.session[sessionKey];
    }

    const separator = returnUrl.includes('?') ? '&' : '?';
    // Use a stable error code rather than echoing `error.message` —
    // some upstream errors interpolate user-influenced strings, and
    // we don't want those landing in the redirect URL.
    res.redirect(`${returnUrl}${separator}jira_error=callback_failed`);
  }
});

/**
 * Get JIRA connection status for current user
 * GET /api/integrations/jira/status
 */
router.get('/status', authRequired, async (req, res) => {
  try {
    if (!req.user?.id) {
      return sendAuthRequired(res);
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
    logger.error('Error getting JIRA status', { component: 'Jira', error });

    if (error.message.includes('authentication required')) {
      return res.json({
        connected: false,
        message: 'JIRA authentication expired'
      });
    }

    return sendInternalError(res, error, 'get JIRA status');
  }
});

/**
 * Disconnect JIRA account
 * POST /api/integrations/jira/disconnect
 */
router.post('/disconnect', authRequired, async (req, res) => {
  try {
    if (!req.user?.id) {
      return sendAuthRequired(res);
    }

    const success = await JiraService.deleteUserTokens(req.user.id);

    if (success) {
      logger.info('JIRA disconnected', { component: 'Jira', userId: req.user.id });
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
    return sendInternalError(res, error, 'disconnect JIRA');
  }
});

/**
 * Refresh JIRA connection and force token refresh
 * POST /api/integrations/jira/refresh
 */
router.post('/refresh', authRequired, async (req, res) => {
  try {
    if (!req.user?.id) {
      return sendAuthRequired(res);
    }

    logger.info('Manual JIRA refresh requested', { component: 'Jira', userId: req.user.id });

    // Force a fresh check of authentication which will trigger refresh if needed
    const isAuthenticated = await JiraService.isUserAuthenticated(req.user.id);

    if (!isAuthenticated) {
      return sendErrorResponse(res, 401, 'Authentication required');
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
    logger.error('Error refreshing JIRA connection', { component: 'Jira', error });

    if (error.message.includes('authentication required') || error.message.includes('expired')) {
      return sendErrorResponse(res, 401, 'Authentication required');
    }

    return sendInternalError(res, error, 'refresh JIRA connection');
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
      return sendAuthRequired(res);
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
    logger.error('Error proxying JIRA attachment', { component: 'Jira', error });

    if (error.message.includes('authentication required')) {
      return sendErrorResponse(res, 401, 'Authentication expired');
    }

    return sendInternalError(res, error, 'proxy JIRA attachment');
  }
});

/**
 * Test JIRA connection
 * GET /api/integrations/jira/test
 */
router.get('/test', authRequired, async (req, res) => {
  try {
    if (!req.user?.id) {
      return sendAuthRequired(res);
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
    return sendInternalError(res, error, 'test JIRA connection');
  }
});

export default router;
