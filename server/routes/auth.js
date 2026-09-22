import { loginUser, createUser } from '../middleware/localAuth.js';
import { createAuthorizationMiddleware } from '../utils/authorization.js';
import {
  getConfiguredProviders,
  createOidcAuthHandler,
  createOidcCallbackHandler,
  configuredProviders
} from '../middleware/oidcAuth.js';
import { loginLdapUser, getConfiguredLdapProviders } from '../middleware/ldapAuth.js';
import { processNtlmLogin, getNtlmConfig } from '../middleware/ntlmAuth.js';
import {
  teamsTokenExchange,
  teamsTabConfigSave,
  teamsClientConfig
} from '../middleware/teamsAuth.js';
import configCache from '../configCache.js';
import { buildServerPath } from '../utils/basePath.js';
import logger from '../utils/logger.js';
import { sendBadRequest, sendAuthRequired, sendErrorResponse } from '../utils/responseHelpers.js';
import { recordAuthEvent } from '../telemetry/metrics.js';
import { logAudit } from '../services/AuditLogService.js';
import { getAuthCookieOptions, getClearAuthCookieOptions } from '../utils/cookieSettings.js';
import { buildPublicBaseUrl } from '../utils/publicBaseUrl.js';
import { clearOidcLogoutHint, readOidcLogoutHint } from '../utils/oidcLogoutHint.js';

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

export default function registerAuthRoutes(app) {
  /**
   * @swagger
   * /auth/local/login:
   *   post:
   *     summary: Local authentication login (explicit)
   *     description: Authenticates a user with username and password using only local authentication
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
   *       400:
   *         description: Bad request or local auth not enabled
   *       401:
   *         description: Invalid credentials
   *       500:
   *         description: Internal server error
   */
  app.post(buildServerPath('/api/auth/local/login'), async (req, res) => {
    try {
      const platform = configCache.getPlatform() || {};
      const localAuthConfig = platform.localAuth || {};

      const { username, password } = req.body;

      // Sanitize and validate inputs
      let sanitizedUsername;
      let sanitizedPassword;

      try {
        sanitizedUsername = sanitizeAuthInput(username, 'Username', 255);
        sanitizedPassword = sanitizeAuthInput(password, 'Password', 1024);
      } catch (error) {
        return sendBadRequest(res, error.message);
      }

      if (!sanitizedUsername || !sanitizedPassword) {
        return sendBadRequest(res, 'Username and password are required');
      }

      // Check if local authentication is enabled
      if (!localAuthConfig.enabled) {
        return sendBadRequest(
          res,
          'Local authentication is not enabled. Please contact your administrator.'
        );
      }

      // Try local authentication
      let result = null;
      try {
        logger.info('[Auth] Attempting local authentication (explicit)', { component: 'Auth' });
        result = await loginUser(sanitizedUsername, sanitizedPassword, localAuthConfig);
        logger.info('[Auth] Local authentication succeeded', { component: 'Auth' });
        recordAuthEvent('local', 'login_success');
        logAudit({
          req,
          action: 'login',
          resource: 'auth',
          resourceId: result.user?.id,
          summary: 'Local login succeeded',
          source: 'web',
          actor: {
            id: result.user?.id ?? 'unknown',
            username: result.user?.username ?? result.user?.name ?? result.user?.id ?? 'unknown',
            groups: result.user?.groups || [],
            authenticated: true
          }
        });
      } catch (error) {
        logger.warn('Local authentication failed', { component: 'Auth', error });
        recordAuthEvent('local', 'login_failure');
        logAudit({
          req,
          action: 'login',
          resource: 'auth',
          result: 'failure',
          summary: 'Local login failed',
          source: 'web',
          actor: {
            id: sanitizedUsername,
            username: sanitizedUsername,
            authenticated: false
          }
        });
        return sendErrorResponse(
          res,
          401,
          'Authentication failed. Please check your username and password.'
        );
      }

      // Set HTTP-only cookie for authentication
      res.cookie('authToken', result.token, getAuthCookieOptions(result.expiresIn * 1000, req));
      // Drop any OIDC logout hint from an earlier login on this browser.
      clearOidcLogoutHint(res, req);

      res.json({
        success: true,
        user: result.user,
        expiresIn: result.expiresIn
      });
    } catch (error) {
      logger.error('Local login error', { component: 'Auth', error });
      return sendErrorResponse(res, 401, error.message || 'Authentication failed');
    }
  });

  /**
   * @swagger
   * /auth/ldap/login:
   *   post:
   *     summary: LDAP authentication login (explicit)
   *     description: Authenticates a user with username and password using only LDAP authentication
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
   *       400:
   *         description: Bad request or LDAP auth not enabled
   *       401:
   *         description: Invalid credentials
   *       500:
   *         description: Internal server error
   */
  app.post(buildServerPath('/api/auth/ldap/login'), async (req, res) => {
    try {
      const platform = configCache.getPlatform() || {};
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
        return sendBadRequest(res, error.message);
      }

      if (!sanitizedUsername || !sanitizedPassword) {
        return sendBadRequest(res, 'Username and password are required');
      }

      // Check if LDAP authentication is enabled
      if (!ldapAuthConfig.enabled || !ldapAuthConfig.providers?.length) {
        return sendBadRequest(
          res,
          'LDAP authentication is not enabled. Please contact your administrator.'
        );
      }

      let result = null;

      // If a specific provider was requested, use it
      if (sanitizedProvider) {
        const ldapProvider = ldapAuthConfig.providers.find(p => p.name === sanitizedProvider);
        if (!ldapProvider) {
          return sendBadRequest(res, `LDAP provider '${sanitizedProvider}' not found`);
        }

        try {
          logger.info('[Auth] Attempting LDAP authentication (explicit)', {
            component: 'Auth',
            provider: sanitizedProvider
          });
          result = await loginLdapUser(sanitizedUsername, sanitizedPassword, ldapProvider);
          logger.info('[Auth] LDAP authentication succeeded', { component: 'Auth' });
          recordAuthEvent('ldap', 'login_success');
        } catch (error) {
          logger.warn('[Auth] LDAP authentication failed', {
            component: 'Auth',
            provider: sanitizedProvider,
            error: error.message
          });
          recordAuthEvent('ldap', 'login_failure');
          logAudit({
            req,
            action: 'login',
            resource: 'auth',
            result: 'failure',
            summary: `LDAP login failed (provider: ${sanitizedProvider})`,
            source: 'web',
            actor: {
              id: sanitizedUsername,
              username: sanitizedUsername,
              authenticated: false
            }
          });
          return sendErrorResponse(res, 401, 'Invalid credentials');
        }
      } else {
        // Try each LDAP provider until one succeeds
        for (const ldapProvider of ldapAuthConfig.providers) {
          try {
            logger.info('[Auth] Trying LDAP provider (explicit)', {
              component: 'Auth',
              provider: ldapProvider.name
            });
            result = await loginLdapUser(sanitizedUsername, sanitizedPassword, ldapProvider);
            if (result) {
              logger.info('[Auth] LDAP authentication succeeded', {
                component: 'Auth',
                provider: ldapProvider.name
              });
              break;
            }
          } catch (error) {
            logger.warn('[Auth] LDAP provider failed', {
              component: 'Auth',
              provider: ldapProvider.name,
              error: error.message
            });
            // Continue to next provider
          }
        }

        if (!result) {
          recordAuthEvent('ldap', 'login_failure');
          logAudit({
            req,
            action: 'login',
            resource: 'auth',
            result: 'failure',
            summary: 'LDAP login failed',
            source: 'web',
            actor: {
              id: sanitizedUsername,
              username: sanitizedUsername,
              authenticated: false
            }
          });
          return sendErrorResponse(res, 401, 'Invalid credentials');
        }
      }

      logAudit({
        req,
        action: 'login',
        resource: 'auth',
        resourceId: result.user?.id,
        summary: 'LDAP login succeeded',
        source: 'web',
        actor: {
          id: result.user?.id ?? 'unknown',
          username: result.user?.username ?? result.user?.name ?? result.user?.id ?? 'unknown',
          groups: result.user?.groups || [],
          authenticated: true
        }
      });

      // Set HTTP-only cookie for authentication
      res.cookie('authToken', result.token, getAuthCookieOptions(result.expiresIn * 1000, req));
      // Drop any OIDC logout hint from an earlier login on this browser.
      clearOidcLogoutHint(res, req);

      res.json({
        success: true,
        user: result.user,
        expiresIn: result.expiresIn
      });
    } catch (error) {
      logger.error('LDAP login error', { component: 'Auth', error });
      return sendErrorResponse(res, 401, error.message || 'Authentication failed');
    }
  });

  /**
   * NTLM authentication initiation (GET) - triggers NTLM authentication flow
   * Used when multiple auth providers are available and user explicitly selects NTLM
   */
  app.get(buildServerPath('/api/auth/ntlm/login'), async (req, res) => {
    try {
      const platform = configCache.getPlatform() || {};
      const ntlmAuthConfig = platform.ntlmAuth || {};

      if (!ntlmAuthConfig.enabled) {
        return sendBadRequest(res, 'NTLM authentication is not enabled');
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
        return sendErrorResponse(
          res,
          401,
          'NTLM authentication in progress. Please ensure Windows Integrated Authentication is enabled in your browser.'
        );
      }

      // User is authenticated via NTLM
      const result = await processNtlmLogin(req, ntlmAuthConfig);

      // Set HTTP-only cookie for authentication
      res.cookie('authToken', result.token, getAuthCookieOptions(result.expiresIn * 1000, req));
      // Drop any OIDC logout hint from an earlier login on this browser.
      clearOidcLogoutHint(res, req);

      // Validate and sanitize return URL to prevent open redirect attacks
      const rawReturnUrl = req.query.returnUrl;
      let returnUrl;

      if (rawReturnUrl === null || rawReturnUrl === undefined) {
        // No return URL provided, use default
        returnUrl = '/';
      } else if (typeof rawReturnUrl === 'string') {
        returnUrl = rawReturnUrl;
      } else {
        // Reject array or non-string values to prevent type confusion attacks
        logger.warn('[Security] Invalid return URL type', {
          component: 'Auth',
          type: typeof rawReturnUrl
        });
        return sendBadRequest(res, 'Invalid return URL');
      }

      // Only allow relative URLs (starting with /) and same-origin URLs
      try {
        // Normalize backslashes to prevent bypass via \evil.com interpreted as /evil.com
        returnUrl = returnUrl.replace(/\\/g, '/');

        // If returnUrl is an absolute URL, validate it's same origin
        if (returnUrl.startsWith('http://') || returnUrl.startsWith('https://')) {
          const returnUrlObj = new URL(returnUrl);
          const currentHost = req.get('host');

          // Only allow same-origin redirects
          if (returnUrlObj.host !== currentHost) {
            logger.warn('[Security] Blocked open redirect attempt', {
              component: 'Auth',
              returnUrl
            });
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
        logger.error('[Security] Invalid return URL', { component: 'Auth', returnUrl, error });
        returnUrl = '/';
      }

      // Redirect to the validated return URL with success indicator
      // returnUrl has been validated above: same-origin check, no //, no backslash -- lgtm[js/server-side-unvalidated-url-redirection]
      res.redirect(returnUrl + (returnUrl.includes('?') ? '&' : '?') + 'ntlm=success'); // lgtm[js/server-side-unvalidated-url-redirection]
    } catch (error) {
      logger.error('NTLM login error', { component: 'Auth', error });
      return sendErrorResponse(res, 401, error.message || 'NTLM authentication failed');
    }
  });

  /**
   * NTLM authentication login (POST - for API usage)
   */
  app.post(buildServerPath('/api/auth/ntlm/login'), async (req, res) => {
    try {
      const platform = configCache.getPlatform() || {};
      const ntlmAuthConfig = platform.ntlmAuth || {};

      if (!ntlmAuthConfig.enabled) {
        return sendBadRequest(res, 'NTLM authentication is not enabled');
      }

      // Mark session to indicate NTLM was explicitly requested
      if (req.session) {
        req.session.ntlmRequested = true;
      }

      // Check if NTLM data is available from the middleware
      if (!req.ntlm || !req.ntlm.Authenticated) {
        return sendErrorResponse(
          res,
          401,
          'NTLM authentication required. This endpoint requires Windows Integrated Authentication.'
        );
      }

      const result = await processNtlmLogin(req, ntlmAuthConfig);

      logAudit({
        req,
        action: 'login',
        resource: 'auth',
        resourceId: result.user?.id,
        summary: 'NTLM login succeeded',
        source: 'web',
        actor: {
          id: result.user?.id ?? 'unknown',
          username: result.user?.username ?? result.user?.name ?? result.user?.id ?? 'unknown',
          groups: result.user?.groups || [],
          authenticated: true
        }
      });

      // Set HTTP-only cookie for authentication
      res.cookie('authToken', result.token, getAuthCookieOptions(result.expiresIn * 1000, req));
      // Drop any OIDC logout hint from an earlier login on this browser.
      clearOidcLogoutHint(res, req);

      res.json({
        success: true,
        user: result.user,
        expiresIn: result.expiresIn
      });
    } catch (error) {
      logger.error('NTLM login error', { component: 'Auth', error });
      return sendErrorResponse(res, 401, error.message || 'NTLM authentication failed');
    }
  });

  /**
   * Get current user information
   */
  app.get(buildServerPath('/api/auth/user'), (req, res) => {
    if (!req.user || req.user.id === 'anonymous') {
      return sendAuthRequired(res);
    }

    res.json({
      success: true,
      user: {
        id: req.user.id,
        username: req.user.username,
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
  app.post(buildServerPath('/api/auth/logout'), (req, res) => {
    // Presence-only check: whether an OIDC RP-Initiated Logout redirect is
    // needed. Deliberately does not read/parse the cookie's content here - the
    // ID token it carries is only ever touched by GET /api/auth/oidc-logout,
    // never by this JSON-responding endpoint.
    //
    // Presence alone is authoritative because the hint is written on *every*
    // OIDC callback and cleared on every other successful login (see
    // setOidcLogoutHint / clearOidcLogoutHint call sites), so it can only
    // exist for a live OIDC session that has a logoutURL. Deliberately NOT
    // gated on req.user.authMode === 'oidc': the iHub JWT typically expires
    // long before the provider's SSO session, and gating on it would mean a
    // logout after that expiry silently stops ending the provider session -
    // exactly the shared-device case this feature exists for.
    const oidcLogoutRequired = req.cookies?.oidcLogoutHint !== undefined;

    // Clear the authentication cookie
    res.clearCookie('authToken', getClearAuthCookieOptions(req));
    // Only clear the hint here when it WON'T be used - i.e. when the client
    // will redirect straight to /?logout=true and never call
    // GET /api/auth/oidc-logout at all. When oidcLogoutRequired is true, that
    // route is the one responsible for reading *and* clearing this cookie (see
    // below) - clearing it here too would delete it before the client's
    // follow-up navigation ever gets to read it, silently downgrading every
    // OIDC logout to a local-only one.
    if (!oidcLogoutRequired) {
      clearOidcLogoutHint(res, req);
    }
    recordAuthEvent(req.user?.authMode || 'unknown', 'logout');
    if (req.user && req.user.id !== 'anonymous') {
      logAudit({
        req,
        action: 'logout',
        resource: 'auth',
        resourceId: req.user.id,
        summary: 'Logout',
        source: 'web'
      });
    }

    // Clear NTLM session flag to prevent auto-relogin
    if (req.session) {
      // Regenerate session to ensure clean state
      req.session.regenerate(err => {
        if (err) {
          logger.error('Session regeneration error', { component: 'Auth', error: err });
          // Even if regeneration fails, ensure NTLM auto-login is disabled
          req.session.ntlmRequested = false;
          return;
        }

        // Set flag in the new session to prevent NTLM auto-login
        req.session.ntlmRequested = false;
      });
    }

    // Log the event for analytics
    if (req.user && req.user.id !== 'anonymous') {
      logger.info('User logged out', { component: 'Auth', userId: req.user.id });
    }

    res.json({
      success: true,
      message: 'Logged out successfully',
      oidcLogoutRequired
    });
  });

  /**
   * Create new user (admin only)
   */
  app.post(
    buildServerPath('/api/auth/users'),
    createAuthorizationMiddleware({ requireAdmin: true }),
    async (req, res) => {
      try {
        const platform = configCache.getPlatform() || {};
        const localAuthConfig = platform.localAuth || {};

        if (!localAuthConfig.enabled) {
          return sendBadRequest(res, 'Local authentication is not enabled');
        }

        const userData = req.body;
        const usersFilePath = localAuthConfig.usersFile || 'contents/config/users.json';

        const newUser = await createUser(userData, usersFilePath);

        res.status(201).json({
          success: true,
          user: newUser
        });
      } catch (error) {
        logger.error('User creation error', { component: 'Auth', error });
        return sendBadRequest(res, error.message || 'Failed to create user');
      }
    }
  );

  /**
   * Get authentication status and configuration
   */
  app.get(buildServerPath('/api/auth/status'), (req, res) => {
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
              username: req.user.username,
              name: req.user.name,
              email: req.user.email,
              groups: req.user.groups,
              // Expose resolved permissions so the client can distinguish a
              // content admin (permissions.contentAdmin) from a full admin
              // (isAdmin). Without this the admin sidebar can't filter its
              // sections and the user menu can't show the admin link for
              // content-admin-only users (issue #1923). Mirrors /api/auth/user.
              permissions: req.user.permissions,
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
        : { enabled: false, providers: [] },
      // Expose Jira integration status (no secrets)
      jira: {
        enabled: Boolean(
          platform.jira?.enabled && platform.jira?.clientId && platform.jira?.clientSecret
        )
      },
      // UI hints for the pre-auth gate (no sensitive data)
      gateUI: (() => {
        const uiConfig = configCache.getUI()?.data || {};
        const lang = req.headers['accept-language']?.split(',')[0]?.split('-')[0] || 'en';
        const title = uiConfig.title || {};
        const appName = title[lang] || title.en || 'iHub Apps';
        const logoUrl = uiConfig.header?.logo?.url || null;
        const headerColor = uiConfig.header?.defaultColor || null;
        return { appName, logoUrl, primaryColor: headerColor };
      })(),
      // Setup wizard state — default true so existing installs are never blocked
      setup: {
        configured: platform.setup?.configured ?? true
      }
    };

    res.json(status);
  });

  /**
   * OIDC provider authentication routes
   */
  app.get(buildServerPath('/api/auth/oidc/providers'), (req, res) => {
    const providers = getConfiguredProviders();
    res.json({
      success: true,
      providers
    });
  });

  /**
   * LDAP provider list
   */
  app.get(buildServerPath('/api/auth/ldap/providers'), (req, res) => {
    const providers = getConfiguredLdapProviders();
    res.json({
      success: true,
      providers
    });
  });

  /**
   * NTLM authentication status
   */
  app.get(buildServerPath('/api/auth/ntlm/status'), (req, res) => {
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
  app.get(buildServerPath('/api/auth/oidc/:provider'), (req, res, next) => {
    const providerName = req.params.provider;
    const handler = createOidcAuthHandler(providerName);
    handler(req, res, next);
  });

  /**
   * OIDC authentication callback
   * GET /api/auth/oidc/:provider/callback
   */
  app.get(buildServerPath('/api/auth/oidc/:provider/callback'), (req, res, next) => {
    const providerName = req.params.provider;
    const handler = createOidcCallbackHandler(providerName);
    handler(req, res, next);
  });

  /**
   * OIDC RP-Initiated Logout redirect (https://openid.net/specs/openid-connect-rpinitiated-1_0.html)
   * GET /api/auth/oidc-logout
   *
   * Reads the hint stashed in the httpOnly oidcLogoutHint cookie (set on OIDC
   * login, see createOidcCallbackHandler) and redirects the browser to the
   * provider's end_session_endpoint so it also terminates its own SSO session,
   * not just iHub's local one. Always safe to hit directly: with no usable hint
   * it just falls back to the normal post-logout landing page. Not gated behind
   * auth - it's an exit point of the auth flow, like the OIDC routes above, not
   * a protected resource.
   *
   * The hint cookie is SameSite=Strict (see utils/oidcLogoutHint.js), so a
   * cross-site navigation to this URL never carries one and can only ever reach
   * the local fallback below - it cannot force a global SSO logout at the user's
   * IdP, nor burn the hint to downgrade this session's real logout.
   *
   * Note: this is a plain top-level navigation target (the client redirects the
   * whole page here via window.location.href), never called via fetch/XHR - the
   * ID token must never travel through a JS-readable response body, only
   * through this httpOnly cookie and the Location header of the 302 below.
   */
  app.get(buildServerPath('/api/auth/oidc-logout'), (req, res) => {
    const fallbackUrl = `${buildServerPath('/')}?logout=true`;

    const { present, parseError, hint } = readOidcLogoutHint(req);

    clearOidcLogoutHint(res, req);

    if (!present) {
      // Expected whenever this URL is opened without going through
      // POST /api/auth/logout first (e.g. a stale bookmark, a cross-site
      // navigation, or a browser that dropped the cookie between the two
      // requests) - not an error.
      logger.info('OIDC logout redirect requested with no hint cookie - local logout only', {
        component: 'Auth'
      });
      return res.redirect(fallbackUrl);
    }

    // A hint means this really is the second half of a logout, and a hint can
    // only arrive on a same-site navigation (SameSite=Strict). Clear the iHub
    // session too, so the endpoint can never end the provider session while
    // leaving iHub signed in - and so that this doesn't double as a cross-site
    // forced logout for iHub itself, which an unconditional clear would.
    res.clearCookie('authToken', getClearAuthCookieOptions(req));

    if (parseError) {
      logger.warn('OIDC logout hint cookie was present but not valid JSON - falling back', {
        component: 'Auth'
      });
      return res.redirect(fallbackUrl);
    }

    const provider = hint?.provider ? configuredProviders.get(hint.provider) : null;
    if (!provider) {
      // The provider referenced by the cookie is no longer configured - most
      // likely removed or renamed since the user logged in.
      logger.warn('OIDC logout hint referenced an unknown provider - falling back', {
        component: 'Auth',
        providerName: hint?.provider
      });
      return res.redirect(fallbackUrl);
    }
    if (!provider.logoutURL) {
      // Most likely logoutURL was unset on this provider after the user logged
      // in (the hint cookie is only ever set while it was configured).
      logger.warn('OIDC logout hint referenced a provider without logoutURL - falling back', {
        component: 'Auth',
        providerName: provider.name
      });
      return res.redirect(fallbackUrl);
    }
    // The spec requires the request to identify the client, via id_token_hint
    // (RECOMMENDED) or client_id. The hint carries no ID token when it was too
    // large to store (see setOidcLogoutHint); client_id alone still terminates
    // the session, so only give up when neither is available.
    if (!hint.idToken && !provider.clientId) {
      logger.warn(
        'OIDC logout hint has neither an idToken nor a configured clientId - falling back',
        { component: 'Auth', providerName: provider.name }
      );
      return res.redirect(fallbackUrl);
    }

    // logoutURL isn't validated at save time (platformConfigSchema is only used
    // for schema export, not enforced by the admin config save route), so a
    // malformed value can reach here - guard the same way as every other
    // invalid-state branch above rather than letting new URL() throw.
    let logoutUrl;
    try {
      logoutUrl = new URL(provider.logoutURL);
    } catch {
      logger.warn('OIDC provider logoutURL is not a valid URL - falling back', {
        component: 'Auth',
        providerName: provider.name
      });
      return res.redirect(fallbackUrl);
    }
    // new URL() happily parses `javascript:` and friends, and an unresolved
    // `${VAR}` placeholder (configCache keeps those verbatim and only warns)
    // parses as a perfectly legal host - both would send the browser somewhere
    // useless. Take the same graceful fallback instead.
    if (logoutUrl.protocol !== 'https:' && logoutUrl.protocol !== 'http:') {
      logger.warn('OIDC provider logoutURL is not an http(s) URL - falling back', {
        component: 'Auth',
        providerName: provider.name,
        protocol: logoutUrl.protocol
      });
      return res.redirect(fallbackUrl);
    }
    if (provider.logoutURL.includes('${')) {
      logger.warn(
        'OIDC provider logoutURL still contains an unresolved ${VAR} placeholder - ' +
          'falling back. Set the environment variable it references.',
        { component: 'Auth', providerName: provider.name }
      );
      return res.redirect(fallbackUrl);
    }

    // Where the provider sends the browser after it has logged the user out.
    // `?logout=true` is load-bearing: it is what stops the client from
    // immediately auto-redirecting back into the provider on `autoRedirect`
    // deployments (see AuthContext / auth-gate). Providers that match
    // post-logout URIs exactly and reject query strings need
    // postLogoutRedirectURL set to whatever they will accept instead.
    //
    // Default uses the shared X-Forwarded-Host-aware helper, not req.get('host')
    // directly: in dev, Vite proxies /api/* to this server with changeOrigin (see
    // vite.config.js), which rewrites Host to localhost:3000 - the backend port,
    // not the SPA the browser actually needs to land back on (localhost:5173).
    // Vite compensates by setting X-Forwarded-Host to the real browser host,
    // which buildPublicBaseUrl() already knows to prefer.
    const postLogoutRedirectUri =
      provider.postLogoutRedirectURL || `${buildPublicBaseUrl(req)}/?logout=true`;

    if (hint.idToken) {
      logoutUrl.searchParams.set('id_token_hint', hint.idToken);
    }
    logoutUrl.searchParams.set('post_logout_redirect_uri', postLogoutRedirectUri);
    if (provider.clientId) {
      logoutUrl.searchParams.set('client_id', provider.clientId);
    }

    // Log the target host/path only - never the query string, which carries
    // id_token_hint.
    logger.info('OIDC RP-Initiated Logout redirect issued', {
      component: 'Auth',
      providerName: provider.name,
      endSessionHost: logoutUrl.host,
      hasIdTokenHint: !!hint.idToken,
      postLogoutRedirectUri
    });

    res.redirect(logoutUrl.toString());
  });

  /**
   * Teams SSO token exchange
   * POST /api/auth/teams/exchange
   */
  app.post(buildServerPath('/api/auth/teams/exchange'), teamsTokenExchange);

  /**
   * Teams tab configuration save
   * POST /api/auth/teams/config
   */
  app.post(buildServerPath('/api/auth/teams/config'), teamsTabConfigSave);

  /**
   * Teams client configuration (public Azure AD client/tenant IDs)
   * GET /api/auth/teams/client-config
   */
  app.get(buildServerPath('/api/auth/teams/client-config'), teamsClientConfig);
}
