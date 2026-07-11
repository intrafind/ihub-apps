// JIRA OAuth Integration Routes
// Handles OAuth2 PKCE flow for JIRA authentication

import express from 'express';
import JiraService from '../../services/integrations/JiraService.js';
import { authRequired } from '../../middleware/authRequired.js';
import { requireFeature } from '../../featureRegistry.js';
import logger from '../../utils/logger.js';
import rateLimit from 'express-rate-limit';
import { sendInternalError, sendAuthRequired, sendErrorResponse } from '../../utils/responseHelpers.js';
import { createOAuthIntegrationRouter } from './oauthIntegrationFactory.js';

const router = express.Router();

// Gate all Jira routes behind the integrations feature flag
router.use(requireFeature('integrations'));

// Rate limiter for JIRA OAuth initiation to prevent abuse/DoS. Jira
// previously had no rate limiter on `/auth` unlike the other three OAuth
// integrations — bringing it in line with Office 365/Google Drive/Nextcloud
// as part of consolidating this into the shared factory.
const jiraAuthLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false
});

createOAuthIntegrationRouter(router, {
  providerKey: 'jira',
  displayName: 'JIRA',
  requiresProviderId: false,
  usesPkce: true,
  authLimiter: jiraAuthLimiter,
  buildAuthUrl: ({ state, codeVerifier }) => JiraService.generateAuthUrl(state, codeVerifier),
  exchangeCodeForTokens: ({ code, codeVerifier }) => JiraService.exchangeCodeForTokens(code, codeVerifier),
  storeUserTokens: (userId, tokens) => JiraService.storeUserTokens(userId, tokens),
  isUserAuthenticated: userId => JiraService.isUserAuthenticated(userId),
  getUserInfo: userId => JiraService.getUserInfo(userId),
  getTokenExpirationInfo: userId => JiraService.getTokenExpirationInfo(userId),
  deleteUserTokens: userId => JiraService.deleteUserTokens(userId),
  formatUserInfo: userInfo => ({
    displayName: userInfo.displayName,
    emailAddress: userInfo.emailAddress,
    accountType: userInfo.accountType,
    active: userInfo.active
  }),
  logMissingRefreshToken: () =>
    logger.error(
      'CRITICAL: No refresh token received from JIRA OAuth - user will need to re-authenticate when access token expires',
      {
        component: 'JIRA',
        causes: [
          'JIRA app does not support offline access',
          'User denied offline_access scope',
          'Atlassian OAuth server configuration issue'
        ]
      }
    )
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
