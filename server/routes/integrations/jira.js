// JIRA OAuth Integration Routes
// Handles OAuth2 PKCE flow for JIRA authentication

import express from 'express';
import crypto from 'crypto';
import JiraService from '../../services/integrations/JiraService.js';

const router = express.Router();

/**
 * Initiate JIRA OAuth2 flow with PKCE
 * GET /api/integrations/jira/auth
 */
router.get('/auth', async (req, res) => {
  try {
    // Generate state and PKCE parameters
    const state = crypto.randomBytes(32).toString('hex');
    const codeVerifier = crypto.randomBytes(32).toString('base64url');

    // Store PKCE parameters in session
    req.session.jiraAuth = {
      state,
      codeVerifier,
      userId: req.user?.id, // Assuming user is authenticated
      timestamp: Date.now()
    };

    // Generate authorization URL
    const authUrl = JiraService.generateAuthUrl(state, codeVerifier);

    console.log(`🔐 Initiating JIRA OAuth for user ${req.user?.id}`);

    // Redirect to JIRA OAuth consent screen
    res.redirect(authUrl);
  } catch (error) {
    console.error('❌ Error initiating JIRA OAuth:', error.message);
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
router.get('/callback', async (req, res) => {
  try {
    const { code, state, error } = req.query;

    // Check for OAuth errors
    if (error) {
      console.error('❌ JIRA OAuth error:', error);
      return res.redirect(`/settings/integrations?jira_error=${encodeURIComponent(error)}`);
    }

    // Validate state parameter
    const storedAuth = req.session.jiraAuth;
    if (!storedAuth || storedAuth.state !== state) {
      console.error('❌ Invalid JIRA OAuth state parameter');
      return res.redirect('/settings/integrations?jira_error=invalid_state');
    }

    // Check session timeout (15 minutes)
    if (Date.now() - storedAuth.timestamp > 15 * 60 * 1000) {
      console.error('❌ JIRA OAuth session expired');
      return res.redirect('/settings/integrations?jira_error=session_expired');
    }

    // Exchange authorization code for tokens
    const tokens = await JiraService.exchangeCodeForTokens(code, storedAuth.codeVerifier);

    // Store encrypted tokens for user
    await JiraService.storeUserTokens(storedAuth.userId, tokens);

    // Clear session data
    delete req.session.jiraAuth;

    console.log(`✅ JIRA OAuth completed for user ${storedAuth.userId}`);

    // Redirect back to settings with success
    res.redirect('/settings/integrations?jira_connected=true');
  } catch (error) {
    console.error('❌ Error handling JIRA OAuth callback:', error.message);

    // Clear session data on error
    delete req.session.jiraAuth;

    res.redirect(`/settings/integrations?jira_error=${encodeURIComponent(error.message)}`);
  }
});

/**
 * Get JIRA connection status for current user
 * GET /api/integrations/jira/status
 */
router.get('/status', async (req, res) => {
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

    res.json({
      connected: true,
      userInfo: {
        displayName: userInfo.displayName,
        emailAddress: userInfo.emailAddress,
        accountType: userInfo.accountType,
        active: userInfo.active
      },
      message: 'JIRA account connected successfully'
    });
  } catch (error) {
    console.error('❌ Error getting JIRA status:', error.message);

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
router.post('/disconnect', async (req, res) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const success = await JiraService.deleteUserTokens(req.user.id);

    if (success) {
      console.log(`🔓 JIRA disconnected for user ${req.user.id}`);
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
    console.error('❌ Error disconnecting JIRA:', error.message);
    res.status(500).json({
      error: 'Disconnect failed',
      message: error.message
    });
  }
});

/**
 * Refresh JIRA connection
 * POST /api/integrations/jira/refresh
 */
router.post('/refresh', async (req, res) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // This will automatically refresh tokens if expired
    const userInfo = await JiraService.getUserInfo(req.user.id);

    res.json({
      success: true,
      userInfo: {
        displayName: userInfo.displayName,
        emailAddress: userInfo.emailAddress,
        accountType: userInfo.accountType,
        active: userInfo.active
      },
      message: 'JIRA connection refreshed successfully'
    });
  } catch (error) {
    console.error('❌ Error refreshing JIRA connection:', error.message);

    if (error.message.includes('authentication required')) {
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
 * Test JIRA connection
 * GET /api/integrations/jira/test
 */
router.get('/test', async (req, res) => {
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
    console.error('❌ Error testing JIRA connection:', error.message);

    res.status(500).json({
      success: false,
      error: 'Connection test failed',
      message: error.message
    });
  }
});

export default router;
