import cors from 'cors';
import express from 'express';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import createMemoryStore from 'memorystore';
import { proxyAuth } from './proxyAuth.js';
import localAuthMiddleware from './localAuth.js';
import { initializePassport, configureOidcProviders } from './oidcAuth.js';
import jwtAuthMiddleware from './jwtAuth.js';
import ldapAuthMiddleware from './ldapAuth.js';
import { teamsAuthMiddleware } from './teamsAuth.js';
import ntlmAuthMiddleware from './ntlmAuth.js';
import { enhanceUserWithPermissions } from '../utils/authorization.js';
import { createRateLimiters } from './rateLimiting.js';
import { buildApiPath, buildServerPath } from '../utils/basePath.js';
import config from '../config.js';
import configCache from '../configCache.js';
import tokenStorageService from '../services/TokenStorageService.js';
import logger from '../utils/logger.js';
import activityTracker from '../telemetry/ActivityTracker.js';

/**
 * Middleware to verify the Content-Length header before parsing the body.
 * If the declared size exceeds the configured limit, the request is rejected
 * immediately with a 413 status code.
 *
 * @param {number} limit - Maximum allowed payload size in bytes
 * @returns {import('express').RequestHandler}
 */
export function checkContentLength(limit) {
  return (req, res, next) => {
    const lenHeader = req.headers['content-length'];
    const length = lenHeader ? parseInt(lenHeader, 10) : NaN;
    if (!Number.isNaN(length) && length > limit) {
      return res.status(413).send('Payload Too Large');
    }
    next();
  };
}

/**
 * Check if the request should bypass authentication
 * Includes static assets and HTML page requests (for SPA routing)
 * @param {import('express').Request} req - Express request object
 * @param {Object} platformConfig - Platform configuration object
 * @returns {boolean} - True if the request should bypass authentication
 */
function isStaticAssetRequest(req, platformConfig = {}) {
  const path = req.path || req.url;
  const isDevelopment = process.env.NODE_ENV === 'development';

  // Skip auth for API routes - they handle their own authentication
  if (path.startsWith('/api')) {
    return false;
  }

  // Common static assets (production and development)
  const isCommonStaticAsset =
    path.startsWith('/assets/') ||
    path.startsWith('/favicon') ||
    path.match(/\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|map|html)$/);

  // Vite dev server specific paths (development only)
  const isViteAsset =
    isDevelopment &&
    (path.startsWith('/vite/') ||
      path.startsWith('/@vite/') ||
      path.startsWith('/@fs/') ||
      path.startsWith('/node_modules/'));

  // NTLM authentication requires the auth middleware to run on initial page requests
  // to perform the challenge-response handshake. Do NOT bypass auth for SPA routes
  // when NTLM is enabled.
  const isNtlmEnabled = platformConfig?.ntlmAuth?.enabled === true;

  // SPA routes (HTML page requests without file extensions) - let them through
  // so the catch-all route in staticRoutes.js can serve index.html
  // This allows direct navigation to routes like /apps/meeting-analyser
  // EXCEPTION: When NTLM is enabled, SPA routes MUST go through auth middleware
  const isSPARoute =
    !isNtlmEnabled && !path.match(/\.[a-z0-9]+$/i) && !path.startsWith('/uploads/');

  return isCommonStaticAsset || isViteAsset || isSPARoute;
}

/**
 * Middleware wrapper that skips authentication for static assets
 * @param {Function[]} authMiddlewares - Array of authentication middleware functions
 * @param {Object} platformConfig - Platform configuration object
 * @returns {import('express').RequestHandler}
 */
function createAuthChain(authMiddlewares, platformConfig = {}) {
  return (req, res, next) => {
    // Skip auth for static assets (respects NTLM requirements)
    if (isStaticAssetRequest(req, platformConfig)) {
      return next();
    }

    // Run auth middleware chain
    let index = 0;
    const runNext = err => {
      if (err) return next(err);
      if (index >= authMiddlewares.length) return next();

      const middleware = authMiddlewares[index++];
      middleware(req, res, runNext);
    };

    runNext();
  };
}

/**
 * Process CORS origins, replacing environment variables and handling special cases
 * @param {string|Array} origins - CORS origins configuration
 * @returns {Array|string|boolean} - Processed origins
 */
function processCorsOrigins(origins) {
  if (!origins) return false; // Deny cross-origin if not configured

  if (typeof origins === 'string') {
    // Handle environment variable replacement
    if (origins.includes('${')) {
      const processed = origins.replace(/\$\{([^}]+)\}/g, (match, envVar) => {
        return process.env[envVar] || '';
      });
      // Split comma-separated values and filter out empty strings
      return processed
        .split(',')
        .map(o => o.trim())
        .filter(Boolean);
    }
    return origins;
  }

  if (Array.isArray(origins)) {
    const processed = [];
    for (const origin of origins) {
      if (typeof origin === 'string' && origin.includes('${')) {
        // Handle environment variable replacement
        const envProcessed = origin.replace(/\$\{([^}]+)\}/g, (match, envVar) => {
          return process.env[envVar] || '';
        });
        if (envProcessed && envProcessed !== origin) {
          // Split comma-separated values if environment variable contains multiple origins
          const envOrigins = envProcessed
            .split(',')
            .map(o => o.trim())
            .filter(Boolean);
          processed.push(...envOrigins);
        } else if (envProcessed) {
          processed.push(envProcessed);
        }
      } else if (origin) {
        processed.push(origin);
      }
    }
    return processed.length ? processed : false;
  }

  return origins;
}

/**
 * Strip a trailing slash and any path component from an origin string so the
 * comparison is "scheme + host (+ port)" — the form the browser actually sends
 * in the Origin header. Idempotent on already-clean origins.
 *
 *   "chrome-extension://abc/options.html"  -> "chrome-extension://abc"
 *   "chrome-extension://abc/"              -> "chrome-extension://abc"
 *   "https://app.example.com/"             -> "https://app.example.com"
 *   "https://app.example.com:8080"         -> "https://app.example.com:8080"
 */
function normalizeOriginForMatch(origin) {
  if (typeof origin !== 'string') return origin;
  const trimmed = origin.trim();
  // Find the start of the path: the first "/" *after* the "://"
  const schemeEnd = trimmed.indexOf('://');
  if (schemeEnd === -1) return trimmed.replace(/\/+$/, '');
  const pathStart = trimmed.indexOf('/', schemeEnd + 3);
  return pathStart === -1 ? trimmed : trimmed.slice(0, pathStart);
}

/**
 * Build the cors() `origin` callback used per-request. Performs forgiving
 * matching (normalizes trailing slash + path) and logs a structured debug
 * line on every mismatch so admins can see the exact comparison that failed.
 *
 * Returns either:
 *   - a (origin, callback) function that decides allow/deny per origin, or
 *   - the original `false` / `[]` value when nothing is configured (cors()
 *     will skip setting Access-Control-Allow-Origin entirely).
 */
function makeForgivingOriginMatcher(resolvedOrigin, req) {
  // Empty / disallowed config — preserve cors()'s default behaviour
  if (!resolvedOrigin) return false;

  const list = Array.isArray(resolvedOrigin) ? resolvedOrigin : [resolvedOrigin];
  const normalized = list.map(normalizeOriginForMatch).filter(Boolean);
  if (normalized.length === 0) return false;

  return (requestOrigin, callback) => {
    if (!requestOrigin) {
      // Same-origin / non-browser caller — allow.
      return callback(null, true);
    }
    const normalizedRequest = normalizeOriginForMatch(requestOrigin);
    if (normalized.includes(normalizedRequest)) {
      return callback(null, true);
    }
    // Don't log on every health-probe / static asset miss in production —
    // only log when this looks like an extension or unexpected origin so
    // admins notice configuration mistakes.
    logger.debug(
      'CORS: request origin not in allowlist; response will omit Access-Control-Allow-Origin',
      {
        component: 'CORS',
        requestOrigin,
        normalizedRequest,
        configuredOrigins: normalized,
        method: req?.method,
        url: req?.url
      }
    );
    return callback(null, false);
  };
}

/**
 * Setup session middleware for different authentication flows
 * @param {import('express').Application} app - Express application
 * @param {Object} platformConfig - Platform configuration
 */
function setupSessionMiddleware(app, platformConfig) {
  const oidcConfig = platformConfig.oidcAuth || {};
  const needsOidcSessions = oidcConfig.enabled;

  // Check for OAuth-based external integrations that need sessions
  const jiraEnabled = platformConfig?.jira?.enabled && platformConfig?.jira?.clientId;
  const cloudStorageEnabled =
    platformConfig?.cloudStorage?.enabled &&
    platformConfig?.cloudStorage?.providers?.some(
      p => p.type === 'office365' && p.enabled !== false
    );
  // Future integrations can be added here:
  // const microsoftEnabled = process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET;
  // const googleEnabled = process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET;

  const needsIntegrationSessions = jiraEnabled || cloudStorageEnabled; // || microsoftEnabled || googleEnabled;

  // Use memorystore instead of the default MemoryStore to avoid memory leaks.
  // The default MemoryStore never prunes expired entries; memorystore runs a
  // periodic check and removes stale sessions automatically.
  const MemoryStore = createMemoryStore(session);

  const sessionSecret =
    config.JWT_SECRET || tokenStorageService.getJwtSecret() || 'fallback-session-secret';

  // Setup OIDC user authentication sessions
  if (needsOidcSessions) {
    logger.info('Enabling session middleware for OIDC user authentication', {
      component: 'Middleware'
    });
    const oidcMaxAge = 30 * 60 * 1000; // 30 minutes for user auth
    app.use(
      '/api/auth/oidc',
      session({
        store: new MemoryStore({ checkPeriod: oidcMaxAge }),
        secret: sessionSecret,
        resave: false,
        saveUninitialized: false, // Only create session when needed for OIDC
        name: 'oidc.session',
        cookie: {
          secure: config.USE_HTTPS === 'true',
          httpOnly: true,
          maxAge: oidcMaxAge,
          sameSite: 'lax',
          // Session middleware is configured at startup, but the base path is
          // request-scoped (X-Forwarded-Prefix). A scoped cookie path like
          // '/api/auth/oidc' would not match '/ihub/api/auth/oidc/...' under
          // a subpath deployment, so the OIDC callback would lose its
          // returnUrl/state. Use '/' to make the cookie reach the callback
          // regardless of deployment layout. The cookie is httpOnly + signed.
          path: '/'
        }
      })
    );
  }

  // Always register integration session middleware — integrations can be enabled
  // dynamically via admin UI, and routes are always registered with requireFeature guards
  const enabledIntegrations = [];
  if (jiraEnabled) enabledIntegrations.push('JIRA');
  if (cloudStorageEnabled) enabledIntegrations.push('Office 365');

  logger.info('Enabling session middleware for OAuth integrations', {
    component: 'Middleware',
    enabledIntegrations:
      enabledIntegrations.length > 0
        ? enabledIntegrations.join(', ')
        : 'ready for dynamic configuration'
  });
  const integrationMaxAge = 15 * 60 * 1000; // 15 minutes for OAuth flows
  app.use(
    '/api/integrations',
    session({
      store: new MemoryStore({ checkPeriod: integrationMaxAge }),
      secret: sessionSecret,
      resave: false,
      saveUninitialized: true, // Required for OAuth2 PKCE state persistence
      name: 'integration.session',
      cookie: {
        secure: config.USE_HTTPS === 'true',
        httpOnly: true,
        maxAge: integrationMaxAge,
        sameSite: 'lax',
        path: '/'
      }
    })
  );

  // OAuth Authorization Code Flow requires session state for PKCE/CSRF across login redirect
  const oauthConfig = platformConfig.oauth || {};
  if (oauthConfig.enabled?.authz || oauthConfig.authorizationCodeEnabled) {
    logger.info('Enabling session middleware for OAuth Authorization Code Flow', {
      component: 'Middleware'
    });
    const oauthMaxAge = 15 * 60 * 1000; // 15 minutes - auth code flow is short-lived
    app.use(
      '/api/oauth',
      session({
        store: new MemoryStore({ checkPeriod: oauthMaxAge }),
        secret: sessionSecret,
        resave: false,
        saveUninitialized: true, // Required to save OAuth params before login redirect
        name: 'oauth.session',
        cookie: {
          secure: config.USE_HTTPS === 'true',
          httpOnly: true,
          maxAge: oauthMaxAge,
          sameSite: 'lax',
          path: '/'
        }
      })
    );
  }

  // If no specific session middleware is needed, but we still have some auth method,
  // we might need basic session support for other features
  if (!needsOidcSessions && !needsIntegrationSessions) {
    const authConfig = platformConfig.auth || {};
    if (authConfig.mode === 'local' || authConfig.mode === 'ldap') {
      logger.info('Enabling minimal session middleware for local/LDAP authentication', {
        component: 'Middleware'
      });
      const appMaxAge = 24 * 60 * 60 * 1000; // 24 hours for regular app sessions
      app.use(
        session({
          store: new MemoryStore({ checkPeriod: appMaxAge }),
          secret: sessionSecret,
          resave: false,
          saveUninitialized: false,
          name: 'app.session',
          cookie: {
            secure: config.USE_HTTPS === 'true',
            httpOnly: true,
            maxAge: appMaxAge,
            sameSite: 'lax'
          }
        })
      );
    }
  }
}

/**
 * Configure Express middleware.
 * Body parser limits are controlled by the `requestBodyLimitMB` option in
 * `platform.json`.
 */
export function setupMiddleware(app, platformConfig = {}) {
  const limitMb = parseInt(platformConfig.requestBodyLimitMB || '50', 10);
  const limit = limitMb * 1024 * 1024;

  // Debug middleware - log all requests (helpful for debugging NTLM/proxy issues)
  if (process.env.NODE_ENV === 'development') {
    app.use((req, res, next) => {
      logger.debug('Incoming request', {
        component: 'Middleware',
        method: req.method,
        url: req.url,
        origin: req.get('origin') || 'none'
      });
      next();
    });
  }

  // Trust proxy for proper IP and protocol detection
  app.set('trust proxy', 1);

  // CORS options are resolved per-request from the live platform config so
  // changes saved via /api/admin/cors/config take effect without a server
  // restart. The cors() middleware accepts a (req, callback) -> options
  // function for exactly this reason.
  //
  // Two behaviours we apply on top of the admin's saved config:
  //
  //   1. Spec fix for "*" + credentials: true
  //      The CORS spec forbids Access-Control-Allow-Origin: * when the
  //      response also carries Access-Control-Allow-Credentials: true.
  //      Browsers detect the violation at preflight time. Symptom: simple
  //      GETs work (no preflight) but anything that preflights (POST +
  //      JSON body, custom headers like Authorization, etc.) fails with a
  //      CORS error. When the admin saved cors.origin = "*" (or an array
  //      containing "*") AND credentials are enabled, swap the literal
  //      "*" for `true` so cors() echoes the request's Origin header —
  //      the spec-compliant equivalent of "allow any origin with
  //      credentials".
  //
  //   2. One-shot warning when (1) kicks in, so admins notice their
  //      saved config got auto-upgraded.
  let warnedAboutWildcard = false;
  const dynamicCorsOptions = (req, callback) => {
    const live = configCache.getPlatform() || platformConfig || {};
    const corsConfig = live.cors || {};
    const credentials = corsConfig.credentials !== undefined ? corsConfig.credentials : true;
    let resolvedOrigin = processCorsOrigins(corsConfig.origin);

    const isWildcard =
      resolvedOrigin === '*' || (Array.isArray(resolvedOrigin) && resolvedOrigin.includes('*'));
    if (isWildcard && credentials) {
      if (!warnedAboutWildcard) {
        warnedAboutWildcard = true;
        logger.warn(
          'CORS configured with origin: "*" and credentials: true — echoing ' +
            'the request origin instead, because the browser blocks responses ' +
            'with both headers at the same time. Set credentials: false to ' +
            'keep the literal "*", or replace "*" with an explicit allowlist.',
          { component: 'CORS' }
        );
      }
      resolvedOrigin = true; // cors() echoes req.headers.origin
    } else {
      // Match the request's Origin against the configured allowlist with
      // forgiving normalization (strip trailing slash + path component).
      // The cors() package does strict `===` matching, which silently fails
      // when the admin has pasted "chrome-extension://<id>/" (with trailing
      // slash) or a full URL like "chrome-extension://<id>/options.html"
      // — the browser only sends "chrome-extension://<id>" as the Origin
      // header. We expand the allowlist into a custom function that handles
      // these common admin mistakes and emits a debug log on miss.
      resolvedOrigin = makeForgivingOriginMatcher(resolvedOrigin, req);
    }

    callback(null, {
      origin: resolvedOrigin,
      methods: corsConfig.methods || ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'HEAD', 'PATCH'],
      allowedHeaders: corsConfig.allowedHeaders || [
        'Content-Type',
        'Authorization',
        'X-Requested-With',
        'X-Forwarded-User',
        'X-Forwarded-Groups',
        'Accept',
        'Origin',
        'Cache-Control',
        'X-File-Name'
      ],
      credentials,
      optionsSuccessStatus: corsConfig.optionsSuccessStatus || 200,
      maxAge: corsConfig.maxAge || 86400,
      preflightContinue: corsConfig.preflightContinue || false
    });
  };

  app.use(cors(dynamicCorsOptions));

  // Content-Language header for accessibility (WCAG 3.1.1)
  // Validate against a strict allowlist to prevent header injection from
  // attacker-controlled Accept-Language values.
  app.use((req, res, next) => {
    const SUPPORTED_LANGS = new Set([
      'en',
      'de',
      'fr',
      'es',
      'it',
      'pt',
      'nl',
      'pl',
      'ru',
      'zh',
      'ja',
      'ko',
      'ar'
    ]);
    const acceptLang = req.headers['accept-language'];
    const raw = acceptLang ? acceptLang.split(',')[0].split('-')[0].trim().toLowerCase() : 'en';
    const lang = /^[a-z]{2,3}$/.test(raw) && SUPPORTED_LANGS.has(raw) ? raw : 'en';
    res.setHeader('Content-Language', lang);
    next();
  });

  // Reject requests with a Content-Length exceeding the configured limit
  app.use(checkContentLength(limit));
  app.use(express.json({ limit: `${limitMb}mb` }));
  app.use(express.urlencoded({ limit: `${limitMb}mb`, extended: true }));
  app.use(cookieParser()); // Add cookie parser middleware

  // Set platform config on app for middleware access
  app.set('platform', platformConfig);

  // Create configurable rate limiters based on platform configuration
  const rateLimiters = createRateLimiters(platformConfig);

  // Rate limiting middleware - apply early to protect all endpoints
  // Public API rate limiter for general endpoints
  app.use(buildApiPath('/apps'), rateLimiters.publicApiLimiter);
  app.use(buildApiPath('/tools'), rateLimiters.publicApiLimiter);
  app.use(buildApiPath('/models'), rateLimiters.publicApiLimiter);
  app.use(buildApiPath('/prompts'), rateLimiters.publicApiLimiter);
  app.use(buildApiPath('/styles'), rateLimiters.publicApiLimiter);
  app.use(buildApiPath('/translations'), rateLimiters.publicApiLimiter);
  app.use(buildApiPath('/configs'), rateLimiters.publicApiLimiter);
  app.use(buildApiPath('/sessions'), rateLimiters.publicApiLimiter);
  app.use(buildApiPath('/pages'), rateLimiters.publicApiLimiter);
  app.use(buildApiPath('/magic-prompts'), rateLimiters.publicApiLimiter);
  app.use(buildApiPath('/short-links'), rateLimiters.publicApiLimiter);
  app.use(buildApiPath('/integrations'), rateLimiters.publicApiLimiter);

  // Auth API rate limiter for authentication endpoints
  app.use(buildServerPath('/auth'), rateLimiters.authApiLimiter);

  // Inference API rate limiter for AI inference endpoints
  app.use(buildServerPath('/inference'), rateLimiters.inferenceApiLimiter);

  // Admin API rate limiter for administrative endpoints (most restrictive)
  app.use(buildApiPath('/admin'), rateLimiters.adminApiLimiter);

  // OAuth API rate limiter for authorization/token endpoints (protect against brute force)
  app.use(buildApiPath('/oauth'), rateLimiters.oauthApiLimiter);

  // Setup session middleware for different use cases
  setupSessionMiddleware(app, platformConfig);

  // Initialize Passport for OIDC authentication
  initializePassport(app);

  // Configure OIDC providers based on platform configuration
  configureOidcProviders();

  // Apply authentication middleware chain (skips static assets automatically)
  // Order matters: proxy auth first, then unified JWT validation
  // IMPORTANT: When NTLM is enabled, SPA routes will NOT bypass auth to allow
  // the NTLM challenge-response handshake to complete
  app.use(
    createAuthChain(
      [
        proxyAuth,
        teamsAuthMiddleware,
        jwtAuthMiddleware,
        localAuthMiddleware, // Now mainly a placeholder for local auth specific logic
        ldapAuthMiddleware, // LDAP auth placeholder for any LDAP-specific logic
        ntlmAuthMiddleware // NTLM handles its own initialization internally
      ],
      platformConfig // Pass platform config to respect NTLM requirements
    )
  );

  // Enhance user with permissions after authentication
  app.use((req, res, next) => {
    if (req.user && !req.user.permissions) {
      // Use auth config from platform config
      const authConfig = platformConfig.auth || {};
      req.user = enhanceUserWithPermissions(req.user, authConfig, platformConfig);

      // logger.info('🔍 User permissions enhanced:', {
      //   userId: req.user.id,
      //   groups: req.user.groups,
      //   hasPermissions: !!req.user.permissions,
      //   appsCount: req.user.permissions?.apps?.size || 0,
      //   modelsCount: req.user.permissions?.models?.size || 0,
      //   isAdmin: req.user.isAdmin
      // });
    }
    next();
  });

  // Track every authenticated request for the activity-summary log line and
  // the ihub.active.users observable gauge. Active *chats* are still only
  // bumped from the chat / inference call sites because that is the only
  // place we have a chatId. Anonymous traffic is excluded so dashboards
  // measure real users; flip to track 'anonymous' if you want public-only
  // load instead.
  app.use((req, res, next) => {
    if (req.user && req.user.id && req.user.id !== 'anonymous') {
      activityTracker.recordActivity({ userId: req.user.id });
    }
    next();
  });
}
