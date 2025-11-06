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
  const jiraEnabled = process.env.JIRA_BASE_URL && process.env.JIRA_OAUTH_CLIENT_ID;
  // Future integrations can be added here:
  // const microsoftEnabled = process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET;
  // const googleEnabled = process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET;

  const needsIntegrationSessions = jiraEnabled; // || microsoftEnabled || googleEnabled;

  // Setup OIDC user authentication sessions
  if (needsOidcSessions) {
    console.log('🔐 Enabling session middleware for OIDC user authentication');
    app.use(
      '/auth/oidc',
      session({
        secret: config.JWT_SECRET || 'fallback-session-secret',
        resave: false,
        saveUninitialized: false, // Only create session when needed for OIDC
        name: 'oidc.session',
        cookie: {
          secure: config.USE_HTTPS === 'true',
          httpOnly: true,
          maxAge: 30 * 60 * 1000, // 30 minutes for user auth
          sameSite: 'lax',
          path: '/auth/oidc'
        }
      })
    );
  }

  // Setup external integration OAuth sessions (separate from user auth)
  if (needsIntegrationSessions) {
    const enabledIntegrations = [];
    if (jiraEnabled) enabledIntegrations.push('JIRA');

    console.log(
      `🔗 Enabling session middleware for OAuth integrations: ${enabledIntegrations.join(', ')}`
    );
    app.use(
      '/api/integrations',
      session({
        secret: config.JWT_SECRET || 'fallback-session-secret',
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
      console.log('🍪 Enabling minimal session middleware for local/LDAP authentication');
      app.use(
        session({
          secret: config.JWT_SECRET || 'fallback-session-secret',
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
      console.log(`[Debug] ${req.method} ${req.url} - Origin: ${req.get('origin') || 'none'}`);
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

  // Authentication middleware (order matters: proxy auth first, then unified JWT validation)
  app.use(proxyAuth);
  app.use(teamsAuthMiddleware);
  app.use(jwtAuthMiddleware);
  app.use(localAuthMiddleware); // Now mainly a placeholder for local auth specific logic
  app.use(ldapAuthMiddleware); // LDAP auth placeholder for any LDAP-specific logic
  app.use(ntlmAuthMiddleware); // NTLM handles its own initialization internally

  // Enhance user with permissions after authentication
  app.use((req, res, next) => {
    if (req.user && !req.user.permissions) {
      // Use auth config from platform config
      const authConfig = platformConfig.auth || {};
      req.user = enhanceUserWithPermissions(req.user, authConfig, platformConfig);

      // console.log('🔍 User permissions enhanced:', {
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
