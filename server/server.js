// Import required modules
import express from 'express';
import dotenv from 'dotenv';
import http from 'http';
import https from 'https';
import cluster from 'cluster';
import { loadJson } from './configLoader.js';
import { getRootDir } from './pathUtils.js';
import configCache from './configCache.js';
import logger from './utils/logger.js';
import { startStickyPrimary, attachStickyWorker } from './clusterSticky.js';

// Import adapters and utilities
import registerChatRoutes from './routes/chat/index.js';
import registerAdminRoutes from './routes/adminRoutes.js';
import registerStaticRoutes from './routes/staticRoutes.js';
import registerGeneralRoutes from './routes/generalRoutes.js';
import registerModelRoutes from './routes/modelRoutes.js';
import registerToolRoutes from './routes/toolRoutes.js';
import registerSkillRoutes from './routes/skillRoutes.js';
import registerPageRoutes from './routes/pageRoutes.js';
import registerRendererRoutes from './routes/rendererRoutes.js';
import registerSessionRoutes from './routes/sessionRoutes.js';
import registerMagicPromptRoutes from './routes/magicPromptRoutes.js';
import registerShortLinkRoutes from './routes/shortLinkRoutes.js';
import registerOpenAIProxyRoutes from './routes/openaiProxy.js';
import registerAuthRoutes from './routes/auth.js';
import registerOAuthRoutes from './routes/oauth.js';
import registerOAuthAuthorizeRoutes from './routes/oauthAuthorize.js';
import registerWellKnownRoutes from './routes/wellKnown.js';
import registerSwaggerRoutes from './routes/swagger.js';
import registerWorkflowRoutes from './routes/workflow/index.js';
import registerSetupRoutes from './routes/setup.js';
import registerPwaRoutes from './routes/pwaRoutes.js';
import registerThemeRoutes from './routes/themeRoutes.js';
import registerToolsServiceRoutes from './routes/toolsService/index.js';
import jiraRoutes from './routes/integrations/jira.js';
import office365Routes from './routes/integrations/office365.js';
import googledriveRoutes from './routes/integrations/googledrive.js';
import nextcloudRoutes from './routes/integrations/nextcloud.js';
import ifinderRoutes from './routes/integrations/ifinder.js';
import officeAddinRoutes from './routes/integrations/officeAddin.js';
import browserExtensionRoutes from './routes/integrations/browserExtension.js';
import nextcloudEmbedRoutes from './routes/integrations/nextcloudEmbed.js';
import registerOfficeRoutes from './routes/office.js';
import registerNextcloudEmbedPageRoutes from './routes/nextcloudEmbedPages.js';
import { setDefaultLanguage } from '../shared/localize.js';
import { initTelemetry, shutdownTelemetry } from './telemetry.js';
import { setupMiddleware } from './middleware/setup.js';
import {
  getLocalizedError,
  validateApiKeys,
  verifyApiKey,
  processMessageTemplates,
  cleanupInactiveClients
} from './serverHelpers.js';
import { performInitialSetup } from './utils/setupUtils.js';
import { runConfigMigrations } from './migrations/runner.js';
import { getProxyConfig } from './utils/httpConfig.js';
import {
  getBasePath,
  buildApiPath,
  basePathRewriteMiddleware,
  basePathDetectionMiddleware,
  basePathValidationMiddleware
} from './utils/basePath.js';

// Initialize environment variables
dotenv.config();

import config from './config.js';

// ----- Cluster setup -----
const workerCount = config.WORKERS;

if (cluster.isPrimary && workerCount > 1) {
  logger.info({
    component: 'Server',
    message: `Primary process ${process.pid} starting ${workerCount} workers`,
    pid: process.pid,
    workerCount
  });

  // Track live workers so the sticky router can pick a healthy one on each
  // incoming connection. Dead entries are replaced in the `exit` handler.
  const workers = [];
  for (let workerIndex = 0; workerIndex < workerCount; workerIndex++) {
    workers[workerIndex] = cluster.fork({ WORKER_INDEX: String(workerIndex) });
  }

  cluster.on('exit', (worker, code, signal) => {
    const slot = workers.findIndex(w => w === worker);
    logger.warn({
      component: 'Server',
      message: `Worker ${worker.process.pid} exited (${code || signal}), respawning`,
      workerPid: worker.process.pid,
      code,
      signal,
      slot
    });
    const replacement = cluster.fork({ WORKER_INDEX: String(slot >= 0 ? slot : workers.length) });
    if (slot >= 0) {
      workers[slot] = replacement;
    } else {
      workers.push(replacement);
    }
  });

  // Primary owns the public listening socket and hands each connection to a
  // worker by hashing the client's remote address. This keeps every chat
  // session pinned to one worker so in-memory SSE state stays consistent.
  startStickyPrimary({
    getWorkers: () => workers,
    port: config.PORT,
    host: config.HOST,
    onListening: () => {
      logger.info({
        component: 'Server',
        message: 'Sticky cluster primary listening',
        host: config.HOST,
        port: config.PORT,
        workerCount
      });
      if (config.HOST === '0.0.0.0' || config.HOST === '::') {
        logger.info({
          component: 'Server',
          message: 'Access the application at one of these URLs:',
          urls: [
            `http://localhost:${config.PORT}`,
            `http://127.0.0.1:${config.PORT}`,
            "(or use your machine's hostname/IP address)"
          ]
        });
      } else {
        logger.info({
          component: 'Server',
          message: 'Access the application at',
          url: `http://${config.HOST}:${config.PORT}`
        });
      }
    }
  });

  const handlePrimaryShutdown = signal => {
    logger.info({
      component: 'Server',
      message: `Primary received ${signal}, shutting down workers`,
      workerCount: workers.length
    });
    for (const w of workers) {
      try {
        w.kill(signal);
      } catch {
        // worker may already be dead
      }
    }
    // Give workers a moment to exit cleanly, then force-exit the primary.
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => handlePrimaryShutdown('SIGTERM'));
  process.on('SIGINT', () => handlePrimaryShutdown('SIGINT'));
} else {
  // Determine if we're running from a packaged binary
  // Either via process.pkg (when using pkg directly) or APP_ROOT_DIR env var (our shell script approach)
  const isPackaged = process.pkg !== undefined || config.APP_ROOT_DIR !== undefined;

  // Resolve the application root directory
  const rootDir = getRootDir();
  if (isPackaged) {
    logger.info({
      component: 'Server',
      message: 'Running in packaged binary mode',
      rootDir
    });
  } else {
    logger.info({
      component: 'Server',
      message: 'Running in normal mode'
    });
  }
  logger.info({
    component: 'Server',
    message: 'Root directory configured',
    rootDir
  });

  // Get the contents directory, either from environment variable or use default 'contents'
  const contentsDir = config.CONTENTS_DIR;
  logger.info({
    component: 'Server',
    message: 'Using contents directory',
    contentsDir
  });

  // Perform initial setup if contents directory is empty
  try {
    await performInitialSetup();
  } catch (error) {
    logger.error({
      component: 'Server',
      message: 'Failed to perform initial setup',
      error: error.message,
      stack: error.stack
    });
    logger.warn({
      component: 'Server',
      message: 'Server will continue, but may not function properly without configuration files'
    });
  }

  // Run versioned configuration migrations
  try {
    await runConfigMigrations();
  } catch (error) {
    logger.error({
      component: 'Server',
      message: 'Configuration migration failed',
      error: error.message,
      stack: error.stack
    });
    logger.warn({
      component: 'Server',
      message: 'Server will continue, but configuration may be outdated'
    });
  }

  // Load platform configuration and initialize telemetry
  let platformConfig = {};
  try {
    platformConfig = await loadJson('config/platform.json');
    if (platformConfig?.defaultLanguage) {
      setDefaultLanguage(platformConfig.defaultLanguage);
    }
  } catch (error) {
    logger.error({
      component: 'Server',
      message: 'Failed to load platform configuration',
      error: error.message,
      stack: error.stack
    });
  }

  // Initialize OpenTelemetry SDK. We do this in its own try/catch because a
  // failure here (e.g. invalid OTLP endpoint, missing exporter package) must
  // not stop the rest of the worker - including the activity tracker - from
  // starting.
  try {
    await initTelemetry(platformConfig?.telemetry || {});
  } catch (error) {
    logger.error({
      component: 'Server',
      message: 'Failed to initialize telemetry',
      error: error.message,
      stack: error.stack
    });
  }

  // Activity tracker drives the active-users / active-chats observable gauges
  // AND the periodic activity-summary log line. The log line works even when
  // OTel itself is broken, so configure it unconditionally and in its own
  // try/catch.
  try {
    const { default: activityTracker } = await import('./telemetry/ActivityTracker.js');
    activityTracker.configure(platformConfig?.telemetry?.activitySummary || {});
  } catch (error) {
    logger.error({
      component: 'Server',
      message: 'Failed to configure activity tracker',
      error: error.message,
      stack: error.stack
    });
  }

  // Log application version information
  const { logVersionInfo } = await import('./utils/versionHelper.js');
  logVersionInfo();

  // Initialize encryption key and JWT secret for secure storage and token signing
  try {
    const tokenStorageService = (await import('./services/TokenStorageService.js')).default;
    await tokenStorageService.initializeEncryptionKey();
    await tokenStorageService.initializeJwtSecret();
    await tokenStorageService.initializeRSAKeyPair();
    // Rename any pre-scoping `<userId>.json` integration token files to
    // the new `<userId>__<providerId>.json` layout. Safe no-op on
    // already-migrated installs.
    await tokenStorageService.migrateLegacyTokenFiles();
  } catch (error) {
    logger.error('Failed to initialize encryption key or JWT secret', {
      component: 'Server',
      error
    });
    logger.warn('Encrypted API keys, tokens, or JWT authentication may not work properly', {
      component: 'Server'
    });
  }

  // Initialize configuration cache for optimal performance
  try {
    await configCache.initialize();
    // Set configCache reference in logger after initialization
    logger.setConfigCache(configCache);
    // Reconfigure logger to pick up logging settings from platform config
    logger.reconfigureLogger();
  } catch (error) {
    logger.error({
      component: 'Server',
      message: 'Failed to initialize configuration cache',
      error: error.message,
      stack: error.stack
    });
    logger.warn({
      component: 'Server',
      message: 'Server will continue with file-based configuration loading'
    });
  }

  // Log proxy configuration if configured
  try {
    const proxyConfig = getProxyConfig();
    if (proxyConfig.enabled && (proxyConfig.http || proxyConfig.https)) {
      logger.info({
        component: 'Server',
        message: '🌐 Proxy configuration active',
        http: proxyConfig.http || '(not set)',
        https: proxyConfig.https || '(not set)',
        noProxy: proxyConfig.noProxy || '(not set)',
        urlPatterns:
          proxyConfig.urlPatterns?.length > 0 ? proxyConfig.urlPatterns : '(all URLs proxied)'
      });
    } else if (!proxyConfig.enabled) {
      logger.info({
        component: 'Server',
        message: 'Proxy is explicitly disabled'
      });
    }
  } catch (error) {
    logger.warn({
      component: 'Server',
      message: 'Failed to read proxy configuration',
      error: error.message
    });
  }

  // Start usage rollup scheduler
  try {
    const { startRollupScheduler } = await import('./services/UsageAggregator.js');
    const platform = configCache.getPlatform ? configCache.getPlatform() : {};
    const retentionConfig = platform?.usageTracking || {};
    startRollupScheduler(retentionConfig);
  } catch (error) {
    logger.warn('Failed to start usage rollup scheduler', { component: 'Server', error });
  }

  // Create Express application
  const app = express();
  const PORT = config.PORT;
  const HOST = config.HOST; // Default to all interfaces

  // Configure request timeouts
  const DEFAULT_TIMEOUT = config.REQUEST_TIMEOUT; // already a number

  // Store active client connections
  // --- Additional code to handle macOS port reuse ---
  // Enable port reuse to avoid EADDRINUSE errors on quick restarts
  const serverOptions = {
    // This allows the server to use a port that is in TIME_WAIT state
    // (which can happen if the server is restarted quickly)
    // Note: These are only applied when creating HTTP/HTTPS servers directly
    ...(process.platform === 'darwin' ? { reuseAddr: true, reusePort: true } : {})
  };

  /**
   * Gets the localized value from a potentially multi-language object
   * Similar to client-side getLocalizedContent utility
   *
   * @param {Object|string} content - Content that might be a translation object or direct string
   * @param {string} language - Current language code (e.g., 'en', 'de')
   * @param {string} [fallbackLanguage='en'] - Fallback language if requested language is not available
   * @returns {string} - The localized content
   */
  // Localization helpers implemented in serverHelpers.js

  /**
   * Gets a localized error message from the translations
   *
   * @param {string} errorKey - The key for the error message in serverErrors
   * @param {Object} params - Parameters to replace in the message
   * @param {string} language - The language code
   * @returns {string} - The localized error message
   */
  // Error localization and API key validation implemented in serverHelpers.js

  // Middleware
  setupMiddleware(app, platformConfig);

  // Add base path middleware chain:
  // 1. Rewrite: strips X-Forwarded-Prefix from req.url (handles non-stripping proxies)
  // 2. Detection: stores current request for runtime base path resolution
  // 3. Validation: warns on invalid X-Forwarded-Prefix values
  app.use(basePathRewriteMiddleware);
  app.use(basePathDetectionMiddleware);
  app.use(basePathValidationMiddleware);

  // Helper to verify API key exists for a model and provide a meaningful error
  // Implemented in serverHelpers.js

  // --- API Endpoints handled in separate route modules ---
  // All API routes are registered with base path support
  const basePath = getBasePath();

  registerAuthRoutes(app);
  registerOAuthRoutes(app);
  registerOAuthAuthorizeRoutes(app);
  registerWellKnownRoutes(app);
  registerGeneralRoutes(app, { getLocalizedError });
  registerModelRoutes(app, { getLocalizedError });
  registerToolRoutes(app);
  registerSkillRoutes(app);
  registerPageRoutes(app);
  registerRendererRoutes(app);
  registerSessionRoutes(app);
  registerMagicPromptRoutes(app);
  registerChatRoutes(app, {
    verifyApiKey,
    processMessageTemplates,
    getLocalizedError,
    DEFAULT_TIMEOUT
  });
  registerOpenAIProxyRoutes(app);
  await registerAdminRoutes(app);
  registerShortLinkRoutes(app);
  await registerSwaggerRoutes(app);
  registerWorkflowRoutes(app, { getLocalizedError });
  registerSetupRoutes(app);

  // --- Integration Routes ---
  // Note: These must be registered after authentication middleware is set up
  app.use(buildApiPath('/integrations/jira'), jiraRoutes);
  app.use(buildApiPath('/integrations/office365'), office365Routes);
  app.use(buildApiPath('/integrations/googledrive'), googledriveRoutes);
  app.use(buildApiPath('/integrations/nextcloud'), nextcloudRoutes);
  app.use(buildApiPath('/integrations/ifinder'), ifinderRoutes);
  app.use(buildApiPath('/integrations/office-addin'), officeAddinRoutes);
  app.use(buildApiPath('/integrations/browser-extension'), browserExtensionRoutes);
  app.use(buildApiPath('/integrations/nextcloud-embed'), nextcloudEmbedRoutes);

  // --- Session Management handled in sessionRoutes ---

  // PWA routes (manifest + SW) must be registered before static file serving
  // so the extension guard in staticRoutes does not 404 them
  registerPwaRoutes(app);
  registerOfficeRoutes(app);
  registerNextcloudEmbedPageRoutes(app);
  registerThemeRoutes(app);
  registerToolsServiceRoutes(app);

  // Register static file and SPA routes after API routes
  registerStaticRoutes(app, { isPackaged, rootDir, basePath });

  // Helper function to extract messages and format them
  // Message template processing implemented in serverHelpers.js

  // Cleanup inactive clients every minute
  cleanupInactiveClients();

  // Validate API keys at startup
  validateApiKeys();

  // Check for SSL configuration
  let server;
  if (config.SSL_KEY && config.SSL_CERT) {
    try {
      // Import synchronous file system operations for SSL cert loading
      const fsSync = await import('fs');

      // SSL configuration
      const httpsOptions = {
        key: fsSync.readFileSync(config.SSL_KEY),
        cert: fsSync.readFileSync(config.SSL_CERT),
        // Add macOS-specific options for socket reuse
        ...(process.platform === 'darwin' ? serverOptions : {})
      };

      // Add CA certificate if provided
      if (config.SSL_CA) {
        httpsOptions.ca = fsSync.readFileSync(config.SSL_CA);
      }

      // Create HTTPS server
      server = https.createServer(httpsOptions, app);
      logger.info({
        component: 'Server',
        message: 'Starting HTTPS server',
        certPath: config.SSL_CERT
      });
    } catch (error) {
      logger.error({
        component: 'Server',
        message: 'Error setting up HTTPS server',
        error: error.message,
        stack: error.stack
      });
      logger.info({
        component: 'Server',
        message: 'Falling back to HTTP server'
      });
      server = http.createServer(serverOptions, app);
    }
  } else {
    // Create regular HTTP server with socket reuse options
    server = http.createServer(serverOptions, app);
    logger.info({
      component: 'Server',
      message: 'Starting HTTP server (no SSL configuration provided)'
    });
  }

  if (cluster.isWorker) {
    // Inside a sticky cluster the primary owns the public port; this worker
    // only receives already-accepted connections via IPC.
    attachStickyWorker(server);
    logger.info({
      component: 'Server',
      message: 'Worker ready for sticky connections',
      pid: process.pid,
      workerIndex: process.env.WORKER_INDEX ?? 'unknown'
    });
  } else {
    // Single-process mode (WORKERS=1): bind the port directly.
    server.listen(PORT, HOST, () => {
      const protocol = server instanceof https.Server ? 'https' : 'http';

      logger.info({
        component: 'Server',
        message: 'Server is listening on all interfaces',
        protocol,
        bindAddress: HOST,
        port: PORT
      });

      if (HOST === '0.0.0.0' || HOST === '::') {
        logger.info({
          component: 'Server',
          message: 'Access the application at one of these URLs:',
          urls: [
            `${protocol}://localhost:${PORT}`,
            `${protocol}://127.0.0.1:${PORT}`,
            "(or use your machine's hostname/IP address)"
          ]
        });
        logger.warn({
          component: 'Server',
          message: '⚠️  IMPORTANT: Do not access via http://0.0.0.0:* in your browser',
          reason: 'Browsers will reject cookies from 0.0.0.0, causing authentication to fail',
          recommendation: 'Always use localhost, 127.0.0.1, or your actual hostname'
        });
      } else {
        logger.info({
          component: 'Server',
          message: 'Access the application at',
          url: `${protocol}://${HOST}:${PORT}`
        });
      }
    });
  }

  const handleShutdownSignal = async () => {
    await shutdownTelemetry();
    process.exit(0);
  };

  process.on('SIGTERM', handleShutdownSignal);
  process.on('SIGINT', handleShutdownSignal);
}
