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
import {
  DEFAULT_INTEGRATION_RETURN_URL,
  issueIntegrationOAuthState,
  verifyIntegrationOAuthState,
  withQueryParam
} from '../../utils/integrationOAuthState.js';

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

    // authRequired lets the anonymous principal through when anonymous
    // access is allowed, and does not guarantee req.user.id is truthy.
    // Refuse to start an OAuth flow without a signed-in user id — otherwise
    // tokens would land under a shared key and could be read by another caller.
    if (!req.user?.id || req.user.id === 'anonymous') {
      return sendAuthRequired(res);
    }

    // Generate PKCE parameters (may be ignored by Atlassian Cloud)
    const codeVerifier = crypto.randomBytes(32).toString('base64url');

    // Validate returnUrl to reject `javascript:`, `data:`, off-host
    // redirects, and protocol-relative URLs that would leak the flow
    // off-site after the callback finishes.
    const validatedReturnUrl = isValidReturnUrl(returnUrl, req)
      ? returnUrl
      : DEFAULT_INTEGRATION_RETURN_URL;

    // Signed, self-contained state instead of a session: the callback may
    // land on another cluster worker (see utils/integrationOAuthState.js).
    const state = issueIntegrationOAuthState({
      service: 'jira',
      userId: req.user.id,
      returnUrl: validatedReturnUrl,
      codeVerifier
    });

    // Generate authorization URL for Atlassian Cloud
    const authUrl = JiraService.generateAuthUrl(state, codeVerifier);

    logger.info('Initiating JIRA OAuth', { component: 'Jira', userId: req.user?.id });

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
  const verified = verifyIntegrationOAuthState(req, { service: 'jira' });
  const { returnUrl } = verified;
  try {
    const { code, error } = req.query;

    if (error) {
      logger.error('JIRA OAuth error', { component: 'Jira', oauthError: error });
      // Stable error code rather than echoing the upstream error string.
      const errorCode = error === 'access_denied' ? 'access_denied' : 'oauth_failed';
      return res.redirect(withQueryParam(returnUrl, 'jira_error', errorCode));
    }

    if (!verified.ok) {
      logger.error('Invalid JIRA OAuth state parameter', {
        component: 'Jira',
        reason: verified.error
      });
      return res.redirect(withQueryParam(returnUrl, 'jira_error', verified.error));
    }

    // Surface a stable error code if the IdP returned no `code`
    // rather than failing inside `exchangeCodeForTokens`.
    if (!code) {
      logger.error('JIRA OAuth callback missing code', { component: 'Jira' });
      return res.redirect(withQueryParam(returnUrl, 'jira_error', 'missing_code'));
    }

    // Exchange authorization code for tokens
    const tokens = await JiraService.exchangeCodeForTokens(code, verified.codeVerifier);

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
    await JiraService.storeUserTokens(verified.userId, tokens);

    logger.info('JIRA OAuth completed', {
      component: 'Jira',
      userId: verified.userId,
      returnUrl
    });

    res.redirect(withQueryParam(returnUrl, 'jira_connected', 'true'));
  } catch (error) {
    logger.error('Error handling JIRA OAuth callback', { component: 'Jira', error });
    // Use a stable error code rather than echoing `error.message` —
    // some upstream errors interpolate user-influenced strings, and
    // we don't want those landing in the redirect URL.
    res.redirect(withQueryParam(returnUrl, 'jira_error', 'callback_failed'));
  }
});

/**
 * Get JIRA connection status for current user
 * GET /api/integrations/jira/status
 */
router.get('/status', authRequired, async (req, res) => {
  try {
    if (!req.user?.id || req.user.id === 'anonymous') {
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
    if (!req.user?.id || req.user.id === 'anonymous') {
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
    if (!req.user?.id || req.user.id === 'anonymous') {
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

    if (!req.user?.id || req.user.id === 'anonymous') {
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
    if (!req.user?.id || req.user.id === 'anonymous') {
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
