import cors from 'cors';
import express from 'express';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import { proxyAuth } from './proxyAuth.js';
import localAuthMiddleware from './localAuth.js';
import { initializePassport, configureOidcProviders } from './oidcAuth.js';
import jwtAuthMiddleware from './jwtAuth.js';
import ldapAuthMiddleware from './ldapAuth.js';
import { teamsAuthMiddleware } from './teamsAuth.js';
import ntlmAuthMiddleware from './ntlmAuth.js';
import { enhanceUserWithPermissions } from '../utils/authorization.js';
import { createRateLimiters } from './rateLimiting.js';
import config from '../config.js';
import tokenStorageService from '../services/TokenStorageService.js';
import logger from '../utils/logger.js';

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
  if (!origins) return true; // Allow all if not specified

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
    return processed.length ? processed : true;
  }

  return origins;
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

  // Setup OIDC user authentication sessions
  if (needsOidcSessions) {
    logger.info('🔐 Enabling session middleware for OIDC user authentication', {
      component: 'Middleware'
    });
    app.use(
      '/api/auth/oidc',
      session({
        secret:
          config.JWT_SECRET || tokenStorageService.getJwtSecret() || 'fallback-session-secret',
        resave: false,
        saveUninitialized: false, // Only create session when needed for OIDC
        name: 'oidc.session',
        cookie: {
          secure: config.USE_HTTPS === 'true',
          httpOnly: true,
          maxAge: 30 * 60 * 1000, // 30 minutes for user auth
          sameSite: 'lax',
          path: '/api/auth/oidc'
        }
      })
    );
  }

  // Setup external integration OAuth sessions (separate from user auth)
  if (needsIntegrationSessions) {
    const enabledIntegrations = [];
    if (jiraEnabled) enabledIntegrations.push('JIRA');
    if (cloudStorageEnabled) enabledIntegrations.push('Office 365');

    logger.info(
      `🔗 Enabling session middleware for OAuth integrations: ${enabledIntegrations.join(', ')}`,
      { component: 'Middleware' }
    );
    app.use(
      '/api/integrations',
      session({
        secret:
          config.JWT_SECRET || tokenStorageService.getJwtSecret() || 'fallback-session-secret',
        resave: false,
        saveUninitialized: true, // Required for OAuth2 PKCE state persistence
        name: 'integration.session',
        cookie: {
          secure: config.USE_HTTPS === 'true',
          httpOnly: true,
          maxAge: 15 * 60 * 1000, // 15 minutes for OAuth flows
          sameSite: 'lax',
          path: '/api/integrations'
        }
      })
    );
  }

  // If no specific session middleware is needed, but we still have some auth method,
  // we might need basic session support for other features
  if (!needsOidcSessions && !needsIntegrationSessions) {
    const authConfig = platformConfig.auth || {};
    if (authConfig.mode === 'local' || authConfig.mode === 'ldap') {
      logger.info('🍪 Enabling minimal session middleware for local/LDAP authentication', {
        component: 'Middleware'
      });
      app.use(
        session({
          secret:
            config.JWT_SECRET || tokenStorageService.getJwtSecret() || 'fallback-session-secret',
          resave: false,
          saveUninitialized: false,
          name: 'app.session',
          cookie: {
            secure: config.USE_HTTPS === 'true',
            httpOnly: true,
            maxAge: 24 * 60 * 60 * 1000, // 24 hours for regular app sessions
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
      logger.debug(`${req.method} ${req.url} - Origin: ${req.get('origin') || 'none'}`, {
        component: 'Middleware'
      });
      next();
    });
  }

  // Trust proxy for proper IP and protocol detection
  app.set('trust proxy', 1);

  // Configure CORS with platform configuration
  const corsConfig = platformConfig.cors || {};
  const corsOptions = {
    origin: processCorsOrigins(corsConfig.origin) || true, // Allow all origins by default
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
    credentials: corsConfig.credentials !== undefined ? corsConfig.credentials : true,
    optionsSuccessStatus: corsConfig.optionsSuccessStatus || 200,
    maxAge: corsConfig.maxAge || 86400,
    preflightContinue: corsConfig.preflightContinue || false
  };

  app.use(cors(corsOptions));
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
  app.use('/api/apps', rateLimiters.publicApiLimiter);
  app.use('/api/tools', rateLimiters.publicApiLimiter);
  app.use('/api/models', rateLimiters.publicApiLimiter);
  app.use('/api/prompts', rateLimiters.publicApiLimiter);
  app.use('/api/styles', rateLimiters.publicApiLimiter);
  app.use('/api/translations', rateLimiters.publicApiLimiter);
  app.use('/api/configs', rateLimiters.publicApiLimiter);
  app.use('/api/sessions', rateLimiters.publicApiLimiter);
  app.use('/api/pages', rateLimiters.publicApiLimiter);
  app.use('/api/magic-prompts', rateLimiters.publicApiLimiter);
  app.use('/api/short-links', rateLimiters.publicApiLimiter);
  app.use('/api/integrations', rateLimiters.publicApiLimiter);

  // Auth API rate limiter for authentication endpoints
  app.use('/auth', rateLimiters.authApiLimiter);

  // Inference API rate limiter for AI inference endpoints
  app.use('/inference', rateLimiters.inferenceApiLimiter);

  // Admin API rate limiter for administrative endpoints (most restrictive)
  app.use('/api/admin', rateLimiters.adminApiLimiter);

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
}
