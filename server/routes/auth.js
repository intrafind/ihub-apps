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
import { buildServerPath } from '../utils/basePath.js';
import logger from '../utils/logger.js';

/**
 * Sanitize and validate authentication input
 * @param {string} value - Input value to sanitize
 * @param {string} fieldName - Name of the field for error messages
 * @param {number} maxLength - Maximum allowed length
 * @returns {string} Sanitized value
 * @throws {Error} If validation fails
 */
function sanitizeAuthInput(value, fieldName, maxLength = 255) {
  // Check if value exists and is a string
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string`);
  }

  // Trim whitespace
  const trimmed = value.trim();

  // Check if empty after trimming
  if (trimmed.length === 0) {
    return null;
  }

  // Check length constraints
  if (trimmed.length > maxLength) {
    throw new Error(`${fieldName} exceeds maximum length of ${maxLength} characters`);
  }

  // Remove null bytes and control characters that could cause issues
  const sanitized = trimmed.replace(/\0/g, '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  return sanitized;
}

export default function registerAuthRoutes(app, basePath = '') {
  /**
   * @swagger
   * /auth/login:
   *   post:
   *     summary: Universal authentication login
   *     description: Authenticates a user with username and password using local or LDAP authentication
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
   *               provider:
   *                 type: string
   *                 description: Optional LDAP provider name (if multiple LDAP providers are configured)
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
   *         description: Bad request (missing credentials or no auth methods enabled)
   *       401:
   *         description: Invalid credentials
   *       500:
   *         description: Internal server error
   */
  app.post(buildServerPath('/api/auth/login', basePath), async (req, res) => {
    try {
      const platform = app.get('platform') || {};
      const localAuthConfig = platform.localAuth || {};
      const ldapAuthConfig = platform.ldapAuth || {};

      const { username, password, provider } = req.body;

      // Sanitize and validate inputs
      let sanitizedUsername;
      let sanitizedPassword;
      let sanitizedProvider;

      try {
        sanitizedUsername = sanitizeAuthInput(username, 'Username', 255);
        sanitizedPassword = sanitizeAuthInput(password, 'Password', 1024);
        sanitizedProvider = sanitizeAuthInput(provider, 'Provider', 100);
      } catch (error) {
        return res.status(400).json({ error: error.message });
      }

      if (!sanitizedUsername || !sanitizedPassword) {
        return res.status(400).json({ error: 'Username and password are required' });
      }

      // Check if any authentication method is enabled before attempting authentication
      if (!localAuthConfig.enabled && !ldapAuthConfig.enabled) {
        return res.status(400).json({
          error: 'No authentication methods are enabled. Please contact your administrator.'
        });
      }

      let result = null;

      // Try local authentication first if enabled
      if (localAuthConfig.enabled) {
        try {
          logger.info('[Auth] Attempting local authentication');
          result = await loginUser(sanitizedUsername, sanitizedPassword, localAuthConfig);
          logger.info('[Auth] Local authentication succeeded');
        } catch (error) {
          logger.warn('[Auth] Local authentication failed:', { error: error.message });
          // Continue to try LDAP if enabled
        }
      }

      // Try LDAP authentication if local auth failed or is disabled
      if (!result && ldapAuthConfig.enabled && ldapAuthConfig.providers?.length > 0) {
        logger.info('[Auth] Attempting LDAP authentication');

        // If a specific provider was requested, use it
        if (sanitizedProvider) {
          const ldapProvider = ldapAuthConfig.providers.find(p => p.name === sanitizedProvider);
          if (!ldapProvider) {
            return res
              .status(400)
              .json({ error: `LDAP provider '${sanitizedProvider}' not found` });
          }

          try {
            result = await loginLdapUser(sanitizedUsername, sanitizedPassword, ldapProvider);
            logger.info('[Auth] LDAP authentication succeeded');
          } catch (error) {
            logger.warn(`[Auth] LDAP authentication failed for provider '${sanitizedProvider}':`, {
              error: error.message
            });
          }
        } else {
          // Try each LDAP provider until one succeeds
          for (const ldapProvider of ldapAuthConfig.providers) {
            try {
              logger.info(`[Auth] Trying LDAP provider: ${ldapProvider.name}`);
              result = await loginLdapUser(sanitizedUsername, sanitizedPassword, ldapProvider);
              if (result) {
                logger.info(
                  `[Auth] LDAP authentication succeeded with provider: ${ldapProvider.name}`
                );
                break;
              }
            } catch (error) {
              logger.warn(`[Auth] LDAP provider '${ldapProvider.name}' failed:`, {
                error: error.message
              });
              // Continue to next provider
            }
          }
        }
      }

      // If no authentication method succeeded
      if (!result) {
        // Return a generic error message to avoid information disclosure
        return res.status(401).json({
          success: false,
          error: 'Invalid credentials'
        });
      }

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
      logger.error('Login error:', error);
      res.status(401).json({
        success: false,
        error: error.message || 'Authentication failed'
      });
    }
  });

  /**
   * NTLM authentication initiation (GET) - triggers NTLM authentication flow
   * Used when multiple auth providers are available and user explicitly selects NTLM
   */
  app.get(buildServerPath('/api/auth/ntlm/login', basePath), async (req, res) => {
    try {
      const platform = app.get('platform') || {};
      const ntlmAuthConfig = platform.ntlmAuth || {};

      if (!ntlmAuthConfig.enabled) {
        return res.status(400).json({ error: 'NTLM authentication is not enabled' });
      }

      // Mark session to indicate NTLM was explicitly requested
      // This allows the NTLM middleware to activate
      if (req.session) {
        req.session.ntlmRequested = true;
      }

      // Check if NTLM data is available from the middleware
      if (!req.ntlm || !req.ntlm.Authenticated) {
        // NTLM middleware will handle the challenge-response
        // This response should not be reached if middleware is working
        return res.status(401).json({
          error:
            'NTLM authentication in progress. Please ensure Windows Integrated Authentication is enabled in your browser.'
        });
      }

      // User is authenticated via NTLM
      const result = await processNtlmLogin(req, ntlmAuthConfig);

      // Set HTTP-only cookie for authentication
      res.cookie('authToken', result.token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: result.expiresIn * 1000
      });

      // Validate and sanitize return URL to prevent open redirect attacks
      let returnUrl = req.query.returnUrl || '/';

      // Only allow relative URLs (starting with /) and same-origin URLs
      try {
        // If returnUrl is an absolute URL, validate it's same origin
        if (returnUrl.startsWith('http://') || returnUrl.startsWith('https://')) {
          const returnUrlObj = new URL(returnUrl);
          const currentHost = req.get('host');

          // Only allow same-origin redirects
          if (returnUrlObj.host !== currentHost) {
            logger.warn(`[Security] Blocked open redirect attempt to: ${returnUrl}`);
            returnUrl = '/';
          }
        } else if (!returnUrl.startsWith('/')) {
          // Ensure relative URLs start with /
          returnUrl = '/' + returnUrl;
        }

        // Remove any attempts to use protocol-relative URLs (//example.com)
        if (returnUrl.startsWith('//')) {
          returnUrl = '/';
        }
      } catch (error) {
        logger.error('[Security] Invalid return URL:', returnUrl, error);
        returnUrl = '/';
      }

      // Redirect to the validated return URL with success indicator
      res.redirect(returnUrl + (returnUrl.includes('?') ? '&' : '?') + 'ntlm=success');
    } catch (error) {
      logger.error('NTLM login error:', error);
      res.status(401).json({
        success: false,
        error: error.message || 'NTLM authentication failed'
      });
    }
  });

  /**
   * NTLM authentication login (POST - for API usage)
   */
  app.post(buildServerPath('/api/auth/ntlm/login', basePath), async (req, res) => {
    try {
      const platform = app.get('platform') || {};
      const ntlmAuthConfig = platform.ntlmAuth || {};

      if (!ntlmAuthConfig.enabled) {
        return res.status(400).json({ error: 'NTLM authentication is not enabled' });
      }

      // Mark session to indicate NTLM was explicitly requested
      if (req.session) {
        req.session.ntlmRequested = true;
      }

      // Check if NTLM data is available from the middleware
      if (!req.ntlm || !req.ntlm.Authenticated) {
        return res.status(401).json({
          error:
            'NTLM authentication required. This endpoint requires Windows Integrated Authentication.'
        });
      }

      const result = await processNtlmLogin(req, ntlmAuthConfig);

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
      logger.error('NTLM login error:', error);
      res.status(401).json({
        success: false,
        error: error.message || 'NTLM authentication failed'
      });
    }
  });

  /**
   * Get current user information
   */
  app.get(buildServerPath('/api/auth/user', basePath), (req, res) => {
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
  app.post(buildServerPath('/api/auth/logout', basePath), (req, res) => {
    // Clear the authentication cookie
    res.clearCookie('authToken', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax'
    });

    // Clear NTLM session flag to prevent auto-relogin
    if (req.session) {
      // Regenerate session to ensure clean state
      req.session.regenerate(err => {
        if (err) {
          logger.error('Session regeneration error:', err);
        }

        // Set flag in the new session to prevent NTLM auto-login
        req.session.ntlmRequested = false;
      });
    }

    // Log the event for analytics
    if (req.user && req.user.id !== 'anonymous') {
      logger.info(`User ${req.user.id} logged out`);
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
    buildServerPath('/api/auth/users', basePath),
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
        logger.error('User creation error:', error);
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
  app.get(buildServerPath('/api/auth/status', basePath), (req, res) => {
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
          enabled: localAuthConfig.enabled ?? false,
          showDemoAccounts: localAuthConfig.showDemoAccounts ?? true
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
      },
      // Add cloud storage configuration (sanitize sensitive fields)
      cloudStorage: platform.cloudStorage
        ? {
            enabled: platform.cloudStorage.enabled,
            providers: (platform.cloudStorage.providers || []).map(p => ({
              id: p.id,
              name: p.name,
              displayName: p.displayName,
              type: p.type,
              enabled: p.enabled
            }))
          }
        : { enabled: false, providers: [] }
    };

    res.json(status);
  });

  /**
   * OIDC provider authentication routes
   */
  app.get(buildServerPath('/api/auth/oidc/providers', basePath), (req, res) => {
    const providers = getConfiguredProviders();
    res.json({
      success: true,
      providers
    });
  });

  /**
   * LDAP provider list
   */
  app.get(buildServerPath('/api/auth/ldap/providers', basePath), (req, res) => {
    const providers = getConfiguredLdapProviders();
    res.json({
      success: true,
      providers
    });
  });

  /**
   * NTLM authentication status
   */
  app.get(buildServerPath('/api/auth/ntlm/status', basePath), (req, res) => {
    const ntlmConfig = getNtlmConfig();
    res.json({
      success: true,
      enabled: ntlmConfig?.enabled ?? false,
      domain: ntlmConfig?.domain,
      type: ntlmConfig?.type || 'ntlm',
      authenticated: req.ntlm?.Authenticated ?? false,
      user: req.ntlm?.Authenticated
        ? {
            username: req.ntlm.UserName || req.ntlm.username,
            domain: req.ntlm.Domain || req.ntlm.domain,
            workstation: req.ntlm.Workstation || req.ntlm.workstation
          }
        : null
    });
  });

  /**
   * OIDC authentication initiation
   * GET /api/auth/oidc/:provider
   */
  app.get(buildServerPath('/api/auth/oidc/:provider', basePath), (req, res, next) => {
    const providerName = req.params.provider;
    const handler = createOidcAuthHandler(providerName);
    handler(req, res, next);
  });

  /**
   * OIDC authentication callback
   * GET /api/auth/oidc/:provider/callback
   */
  app.get(buildServerPath('/api/auth/oidc/:provider/callback', basePath), (req, res, next) => {
    const providerName = req.params.provider;
    const handler = createOidcCallbackHandler(providerName);
    handler(req, res, next);
  });

  /**
   * Teams SSO token exchange
   * POST /api/auth/teams/exchange
   */
  app.post(buildServerPath('/api/auth/teams/exchange', basePath), teamsTokenExchange);

  /**
   * Teams tab configuration save
   * POST /api/auth/teams/config
   */
  app.post(buildServerPath('/api/auth/teams/config', basePath), teamsTabConfigSave);
}
