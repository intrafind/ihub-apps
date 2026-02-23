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
import registerSwaggerRoutes from './routes/swagger.js';
import registerWorkflowRoutes from './routes/workflow/index.js';
import jiraRoutes from './routes/integrations/jira.js';
import office365Routes from './routes/integrations/office365.js';
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
import {
  getBasePath,
  buildServerPath,
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
  for (let i = 0; i < workerCount; i++) {
    cluster.fork();
  }

  cluster.on('exit', (worker, code, signal) => {
    logger.warn({
      component: 'Server',
      message: `Worker ${worker.process.pid} exited (${code || signal})`,
      workerPid: worker.process.pid,
      code,
      signal
    });
    cluster.fork();
  });
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
  } catch (err) {
    logger.error({
      component: 'Server',
      message: 'Failed to perform initial setup',
      error: err.message,
      stack: err.stack
    });
    logger.warn({
      component: 'Server',
      message: 'Server will continue, but may not function properly without configuration files'
    });
  }

  // Load platform configuration and initialize telemetry
  let platformConfig = {};
  try {
    platformConfig = await loadJson('config/platform.json');
    if (platformConfig?.defaultLanguage) {
      setDefaultLanguage(platformConfig.defaultLanguage);
    }
    await initTelemetry(platformConfig?.telemetry || {});
  } catch (err) {
    logger.error({
      component: 'Server',
      message: 'Failed to initialize telemetry',
      error: err.message,
      stack: err.stack
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
  } catch (err) {
    console.error('Failed to initialize encryption key or JWT secret:', err);
    console.warn('Encrypted API keys, tokens, or JWT authentication may not work properly');
  }

  // Run config migrations (adds missing fields to existing installations)
  try {
    const { runMigrations } = await import('./migrations/runner.js');
    await runMigrations();
  } catch (error) {
    console.error('⚠️  Error running config migrations:', error.message);
    // Continue - non-critical
  }

  // Ensure default providers are present (migration for existing installations)
  try {
    const { ensureDefaultProviders } = await import('./utils/providerMigration.js');
    await ensureDefaultProviders();
  } catch (error) {
    console.error('⚠️  Error ensuring default providers:', error.message);
    // Continue - this is non-critical
  }

  // Initialize configuration cache for optimal performance
  try {
    await configCache.initialize();
    // Set configCache reference in logger after initialization
    logger.setConfigCache(configCache);
    // Reconfigure logger to pick up logging settings from platform config
    logger.reconfigureLogger();
  } catch (err) {
    logger.error({
      component: 'Server',
      message: 'Failed to initialize configuration cache',
      error: err.message,
      stack: err.stack
    });
    logger.warn({
      component: 'Server',
      message: 'Server will continue with file-based configuration loading'
    });
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

  // Add base path detection and validation middleware
  app.use(basePathDetectionMiddleware);
  app.use(basePathValidationMiddleware);

  // Helper to verify API key exists for a model and provide a meaningful error
  // Implemented in serverHelpers.js

  // --- API Endpoints handled in separate route modules ---
  // All API routes are registered with base path support
  const basePath = getBasePath();

  registerAuthRoutes(app, basePath);
  registerOAuthRoutes(app, basePath);
  registerGeneralRoutes(app, { getLocalizedError, basePath });
  registerModelRoutes(app, { getLocalizedError, basePath });
  registerToolRoutes(app, basePath);
  registerSkillRoutes(app, basePath);
  registerPageRoutes(app, basePath);
  registerRendererRoutes(app, basePath);
  registerSessionRoutes(app, basePath);
  registerMagicPromptRoutes(app, { basePath });
  registerChatRoutes(app, {
    verifyApiKey,
    processMessageTemplates,
    getLocalizedError,
    DEFAULT_TIMEOUT,
    basePath
  });
  registerOpenAIProxyRoutes(app, { basePath });
  await registerAdminRoutes(app, basePath);
  registerShortLinkRoutes(app, basePath);
  await registerSwaggerRoutes(app, basePath);
  registerWorkflowRoutes(app, { basePath, getLocalizedError });

  // --- Integration Routes ---
  // Note: These must be registered after authentication middleware is set up
  app.use('/api/integrations/jira', jiraRoutes);
  app.use('/api/integrations/office365', office365Routes);

  // --- Session Management handled in sessionRoutes ---

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

  // Start server
  server.listen(PORT, HOST, () => {
    const protocol = server instanceof https.Server ? 'https' : 'http';
    logger.info({
      component: 'Server',
      message: 'Server is running',
      protocol,
      host: HOST,
      port: PORT,
      url: `${protocol}://${HOST}:${PORT}`
    });
    logger.info({
      component: 'Server',
      message: 'Open in browser to use iHub Apps',
      url: `${protocol}://${HOST}:${PORT}`
    });
  });

  const handleShutdownSignal = async () => {
    await shutdownTelemetry();
    process.exit(0);
  };

  process.on('SIGTERM', handleShutdownSignal);
  process.on('SIGINT', handleShutdownSignal);
}
