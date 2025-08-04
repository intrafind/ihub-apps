import { loginUser, createUser } from '../middleware/localAuth.js';
import { createAuthorizationMiddleware } from '../utils/authorization.js';
import {
  getConfiguredProviders,
  createOidcAuthHandler,
  createOidcCallbackHandler
} from '../middleware/oidcAuth.js';
import { loginLdapUser, getConfiguredLdapProviders } from '../middleware/ldapAuth.js';
import { processNtlmLogin, getNtlmConfig } from '../middleware/ntlmAuth.js';
import { teamsTokenExchange, teamsTabConfigSave } from '../middleware/teamsAuth.js';
import configCache from '../configCache.js';

export default function registerAuthRoutes(app) {
  /**
   * @swagger
   * /auth/login:
   *   post:
   *     summary: Local authentication login
   *     description: Authenticates a user with username and password using local authentication
   *     tags:
   *       - Authentication
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - username
   *               - password
   *             properties:
   *               username:
   *                 type: string
   *                 description: User's username
   *               password:
   *                 type: string
   *                 description: User's password
   *     responses:
   *       200:
   *         description: Login successful
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 user:
   *                   type: object
   *                   properties:
   *                     id:
   *                       type: string
   *                     username:
   *                       type: string
   *                     groups:
   *                       type: array
   *                       items:
   *                         type: string
   *                 token:
   *                   type: string
   *                   description: JWT authentication token
   *                 expiresIn:
   *                   type: number
   *                   description: Token expiration time in seconds
   *       400:
   *         description: Bad request (missing credentials or local auth disabled)
   *       401:
   *         description: Invalid credentials
   *       500:
   *         description: Internal server error
   */
  app.post('/api/auth/login', async (req, res) => {
    try {
      const platform = app.get('platform') || {};
      const localAuthConfig = platform.localAuth || {};

      if (!localAuthConfig.enabled) {
        return res.status(400).json({ error: 'Local authentication is not enabled' });
      }

      const { username, password } = req.body;

      if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required' });
      }

      const result = await loginUser(username, password, localAuthConfig);

      // Set HTTP-only cookie for authentication
      res.cookie('authToken', result.token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production', // Use HTTPS in production
        sameSite: 'lax',
        maxAge: result.expiresIn * 1000 // Convert seconds to milliseconds
      });

      res.json({
        success: true,
        user: result.user,
        token: result.token, // Still return token for backward compatibility
        expiresIn: result.expiresIn
      });
    } catch (error) {
      console.error('Login error:', error);
      res.status(401).json({
        success: false,
        error: error.message || 'Authentication failed'
      });
    }
  });

  /**
   * LDAP authentication login
   */
  app.post('/api/auth/ldap/login', async (req, res) => {
    try {
      const platform = app.get('platform') || {};
      const ldapAuthConfig = platform.ldapAuth || {};

      if (!ldapAuthConfig.enabled) {
        return res.status(400).json({ error: 'LDAP authentication is not enabled' });
      }

      const { username, password, provider } = req.body;

      if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required' });
      }

      if (!provider) {
        return res.status(400).json({ error: 'LDAP provider is required' });
      }

      // Find the specified LDAP provider
      const ldapProvider = ldapAuthConfig.providers?.find(p => p.name === provider);
      if (!ldapProvider) {
        return res.status(400).json({ error: `LDAP provider '${provider}' not found` });
      }

      const result = await loginLdapUser(username, password, ldapProvider);

      // Set HTTP-only cookie for authentication
      res.cookie('authToken', result.token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: result.expiresIn * 1000
      });

      res.json({
        success: true,
        user: result.user,
        token: result.token, // Still return token for backward compatibility
        expiresIn: result.expiresIn
      });
    } catch (error) {
      console.error('LDAP login error:', error);
      res.status(401).json({
        success: false,
        error: error.message || 'LDAP authentication failed'
      });
    }
  });

  /**
   * NTLM authentication login (for API usage)
   */
  app.post('/api/auth/ntlm/login', async (req, res) => {
    try {
      const platform = app.get('platform') || {};
      const ntlmAuthConfig = platform.ntlmAuth || {};

      if (!ntlmAuthConfig.enabled) {
        return res.status(400).json({ error: 'NTLM authentication is not enabled' });
      }

      // Check if NTLM data is available from the middleware
      if (!req.ntlm || !req.ntlm.authenticated) {
        return res.status(401).json({
          error:
            'NTLM authentication required. This endpoint requires Windows Integrated Authentication.'
        });
      }

      const result = processNtlmLogin(req, ntlmAuthConfig);

      // Set HTTP-only cookie for authentication
      res.cookie('authToken', result.token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: result.expiresIn * 1000
      });

      res.json({
        success: true,
        user: result.user,
        token: result.token, // Still return token for backward compatibility
        expiresIn: result.expiresIn
      });
    } catch (error) {
      console.error('NTLM login error:', error);
      res.status(401).json({
        success: false,
        error: error.message || 'NTLM authentication failed'
      });
    }
  });

  /**
   * Get current user information
   */
  app.get('/api/auth/user', (req, res) => {
    if (!req.user || req.user.id === 'anonymous') {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    res.json({
      success: true,
      user: {
        id: req.user.id,
        name: req.user.name,
        email: req.user.email,
        groups: req.user.groups,
        permissions: req.user.permissions,
        isAdmin: req.user.isAdmin,
        authenticated: req.user.authenticated,
        authMethod: req.user.authMethod
      }
    });
  });

  /**
   * Logout (clear cookies and track logout)
   */
  app.post('/api/auth/logout', (req, res) => {
    // Clear the authentication cookie
    res.clearCookie('authToken', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax'
    });

    // Log the event for analytics
    if (req.user && req.user.id !== 'anonymous') {
      console.log(`User ${req.user.id} logged out`);
    }

    res.json({
      success: true,
      message: 'Logged out successfully'
    });
  });

  /**
   * Create new user (admin only)
   */
  app.post(
    '/api/auth/users',
    createAuthorizationMiddleware({ requireAdmin: true }),
    async (req, res) => {
      try {
        const platform = app.get('platform') || {};
        const localAuthConfig = platform.localAuth || {};

        if (!localAuthConfig.enabled) {
          return res.status(400).json({ error: 'Local authentication is not enabled' });
        }

        const userData = req.body;
        const usersFilePath = localAuthConfig.usersFile || 'contents/config/users.json';

        const newUser = await createUser(userData, usersFilePath);

        res.status(201).json({
          success: true,
          user: newUser
        });
      } catch (error) {
        console.error('User creation error:', error);
        res.status(400).json({
          success: false,
          error: error.message || 'Failed to create user'
        });
      }
    }
  );

  /**
   * Get authentication status and configuration
   */
  app.get('/api/auth/status', (req, res) => {
    const platform = configCache.getPlatform() || {};
    const authConfig = platform.auth || {};
    const proxyAuthConfig = platform.proxyAuth || {};
    const localAuthConfig = platform.localAuth || {};
    const oidcAuthConfig = platform.oidcAuth || {};
    const ldapAuthConfig = platform.ldapAuth || {};
    const ntlmAuthConfig = platform.ntlmAuth || {};

    // Check for auto-redirect scenario
    const enabledAuthMethods = [
      proxyAuthConfig.enabled,
      localAuthConfig.enabled,
      oidcAuthConfig.enabled,
      ldapAuthConfig.enabled,
      ntlmAuthConfig.enabled,
      platform.anonymousAuth?.enabled
    ].filter(Boolean).length;

    const oidcProviders = getConfiguredProviders();
    const enabledOidcProviders = oidcProviders.filter(p => p.enabled !== false);
    const autoRedirectProvider = enabledOidcProviders.find(p => p.autoRedirect === true);

    // Don't auto-redirect if this request comes from an OIDC callback or admin route
    const isOidcCallback = req.headers.referer && req.headers.referer.includes('/api/auth/oidc/');
    const isAdminRoute = req.headers.referer && req.headers.referer.includes('/admin');

    // Auto-redirect should happen if:
    // 1. Only OIDC is enabled (no anonymous, local, or proxy)
    // 2. There's exactly one OIDC provider enabled
    // 3. That provider has autoRedirect set to true
    // 4. Not an OIDC callback or admin route
    const shouldAutoRedirect =
      enabledAuthMethods === 1 &&
      oidcAuthConfig.enabled &&
      enabledOidcProviders.length === 1 &&
      autoRedirectProvider &&
      !isOidcCallback &&
      !isAdminRoute;

    const status = {
      authMode: authConfig.mode || 'proxy',
      anonymousAuth: {
        enabled: platform.anonymousAuth?.enabled ?? false,
        defaultGroups: platform.anonymousAuth?.defaultGroups || ['anonymous']
      },
      authenticated: req.user && req.user.id !== 'anonymous',
      autoRedirect: shouldAutoRedirect
        ? {
            provider: autoRedirectProvider.name,
            url: `/api/auth/oidc/${autoRedirectProvider.name}`
          }
        : null,
      user:
        req.user && req.user.id !== 'anonymous'
          ? {
              id: req.user.id,
              name: req.user.name,
              email: req.user.email,
              groups: req.user.groups,
              isAdmin: req.user.isAdmin,
              authMethod: req.user.authMethod
            }
          : null,
      authMethods: {
        proxy: {
          enabled: proxyAuthConfig.enabled ?? false,
          userHeader: proxyAuthConfig.userHeader,
          groupsHeader: proxyAuthConfig.groupsHeader
        },
        local: {
          enabled: localAuthConfig.enabled ?? false
        },
        oidc: {
          enabled: oidcAuthConfig.enabled ?? false,
          providers: oidcProviders
        },
        ldap: {
          enabled: ldapAuthConfig.enabled ?? false,
          providers: getConfiguredLdapProviders()
        },
        ntlm: {
          enabled: ntlmAuthConfig.enabled ?? false,
          domain: ntlmAuthConfig.domain,
          type: ntlmAuthConfig.type || 'ntlm'
        }
      }
    };

    res.json(status);
  });

  /**
   * OIDC provider authentication routes
   */
  app.get('/api/auth/oidc/providers', (req, res) => {
    const providers = getConfiguredProviders();
    res.json({
      success: true,
      providers
    });
  });

  /**
   * LDAP provider list
   */
  app.get('/api/auth/ldap/providers', (req, res) => {
    const providers = getConfiguredLdapProviders();
    res.json({
      success: true,
      providers
    });
  });

  /**
   * NTLM authentication status
   */
  app.get('/api/auth/ntlm/status', (req, res) => {
    const ntlmConfig = getNtlmConfig();
    res.json({
      success: true,
      enabled: ntlmConfig?.enabled ?? false,
      domain: ntlmConfig?.domain,
      type: ntlmConfig?.type || 'ntlm',
      authenticated: req.ntlm?.authenticated ?? false,
      user: req.ntlm?.authenticated
        ? {
            username: req.ntlm.username,
            domain: req.ntlm.domain,
            workstation: req.ntlm.workstation
          }
        : null
    });
  });

  /**
   * OIDC authentication initiation
   * GET /api/auth/oidc/:provider
   */
  app.get('/api/auth/oidc/:provider', (req, res, next) => {
    const providerName = req.params.provider;
    const handler = createOidcAuthHandler(providerName);
    handler(req, res, next);
  });

  /**
   * OIDC authentication callback
   * GET /api/auth/oidc/:provider/callback
   */
  app.get('/api/auth/oidc/:provider/callback', (req, res, next) => {
    const providerName = req.params.provider;
    const handler = createOidcCallbackHandler(providerName);
    handler(req, res, next);
  });

  /**
   * Teams SSO token exchange
   * POST /api/auth/teams/exchange
   */
  app.post('/api/auth/teams/exchange', teamsTokenExchange);

  /**
   * Teams tab configuration save
   * POST /api/auth/teams/config
   */
  app.post('/api/auth/teams/config', teamsTabConfigSave);
}
