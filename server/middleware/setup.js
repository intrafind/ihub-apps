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
import ntlmAuthMiddleware, { createNtlmMiddleware } from './ntlmAuth.js';
import { enhanceUserWithPermissions } from '../utils/authorization.js';
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
 * Configure Express middleware.
 * Body parser limits are controlled by the `requestBodyLimitMB` option in
 * `platform.json`.
 */
export function setupMiddleware(app, platformConfig = {}) {
  const limitMb = parseInt(platformConfig.requestBodyLimitMB || '50', 10);
  const limit = limitMb * 1024 * 1024;

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

  // Session middleware for OIDC (only needed if OIDC is enabled)
  const oidcConfig = platformConfig.oidcAuth || {};
  if (oidcConfig.enabled) {
    app.use(
      session({
        secret: config.JWT_SECRET || 'fallback-session-secret',
        resave: false,
        saveUninitialized: true, // Changed to true for OAuth2 state persistence
        name: 'oidc.session',
        cookie: {
          secure: config.USE_HTTPS === 'true', // Set to false for HTTP localhost development
          httpOnly: true,
          maxAge: 10 * 60 * 1000, // 10 minutes for OIDC flow
          sameSite: 'lax', // Always use 'lax' for better compatibility
          path: '/', // Ensure cookie is available for all paths
          domain: undefined // Let browser handle domain for better localhost compatibility
        }
      })
    );
  }

  // Initialize Passport for OIDC authentication
  initializePassport(app);

  // Configure OIDC providers based on platform configuration
  configureOidcProviders();

  // NTLM middleware setup (must come before other auth middlewares)
  const ntlmConfig = platformConfig.ntlmAuth || {};
  if (ntlmConfig.enabled) {
    console.log('[Server] Configuring NTLM authentication middleware');
    app.use(createNtlmMiddleware(ntlmConfig));
    app.use(ntlmAuthMiddleware);
  }

  // Authentication middleware (order matters: proxy auth first, then unified JWT validation)
  app.use(proxyAuth);
  app.use(teamsAuthMiddleware);
  app.use(jwtAuthMiddleware);
  app.use(localAuthMiddleware); // Now mainly a placeholder for local auth specific logic
  app.use(ldapAuthMiddleware); // LDAP auth placeholder for any LDAP-specific logic

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
