// Import required modules
import express from 'express';
import dotenv from 'dotenv';
import http from 'http';
import https from 'https';
import cluster from 'cluster';
import { loadJson } from './configLoader.js';
import { getRootDir } from './pathUtils.js';
import configCache from './configCache.js';

// Import adapters and utilities
import registerChatRoutes from './routes/chat/index.js';
import registerAdminRoutes from './routes/adminRoutes.js';
import registerStaticRoutes from './routes/staticRoutes.js';
import registerGeneralRoutes from './routes/generalRoutes.js';
import registerModelRoutes from './routes/modelRoutes.js';
import registerToolRoutes from './routes/toolRoutes.js';
import registerPageRoutes from './routes/pageRoutes.js';
import registerSessionRoutes from './routes/sessionRoutes.js';
import registerMagicPromptRoutes from './routes/magicPromptRoutes.js';
import registerShortLinkRoutes from './routes/shortLinkRoutes.js';
import registerOpenAIProxyRoutes from './routes/openaiProxy.js';
import registerAuthRoutes from './routes/auth.js';
import { setDefaultLanguage } from '../shared/localize.js';
import { initTelemetry, shutdownTelemetry } from './telemetry.js';
import {
  setupMiddleware,
  getLocalizedError,
  validateApiKeys,
  verifyApiKey,
  processMessageTemplates,
  cleanupInactiveClients
} from './serverHelpers.js';

// Teams integration imports
import { TeamsBot, createTeamsAdapter } from './teamsBot.js';
import { TeamsMessageExtension } from './teamsMessageExtension.js';

// Initialize environment variables
dotenv.config();

import config from './config.js';

// ----- Cluster setup -----
const workerCount = config.WORKERS;

if (cluster.isPrimary && workerCount > 1) {
  console.log(`Primary process ${process.pid} starting ${workerCount} workers`);
  for (let i = 0; i < workerCount; i++) {
    cluster.fork();
  }

  cluster.on('exit', (worker, code, signal) => {
    console.warn(`Worker ${worker.process.pid} exited (${code || signal}).`);
    cluster.fork();
  });
} else {
  // Determine if we're running from a packaged binary
  // Either via process.pkg (when using pkg directly) or APP_ROOT_DIR env var (our shell script approach)
  const isPackaged = process.pkg !== undefined || config.APP_ROOT_DIR !== undefined;

  // Resolve the application root directory
  const rootDir = getRootDir();
  if (isPackaged) {
    console.log(`Running in packaged binary mode with APP_ROOT_DIR: ${rootDir}`);
  } else {
    console.log('Running in normal mode');
  }
  console.log(`Root directory: ${rootDir}`);

  // Get the contents directory, either from environment variable or use default 'contents'
  const contentsDir = config.CONTENTS_DIR;
  console.log(`Using contents directory: ${contentsDir}`);

  // Load platform configuration and initialize telemetry
  let platformConfig = {};
  try {
    platformConfig = await loadJson('config/platform.json');
    if (platformConfig?.defaultLanguage) {
      setDefaultLanguage(platformConfig.defaultLanguage);
    }
    await initTelemetry(platformConfig?.telemetry || {});
  } catch (err) {
    console.error('Failed to initialize telemetry:', err);
  }

  // Initialize configuration cache for optimal performance
  try {
    await configCache.initialize();
  } catch (err) {
    console.error('Failed to initialize configuration cache:', err);
    console.warn('Server will continue with file-based configuration loading');
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

  // Helper to verify API key exists for a model and provide a meaningful error
  // Implemented in serverHelpers.js

  // --- API Endpoints handled in separate route modules ---
  registerAuthRoutes(app);
  registerGeneralRoutes(app, { getLocalizedError });
  registerModelRoutes(app, { getLocalizedError });
  registerToolRoutes(app);
  registerPageRoutes(app);
  registerSessionRoutes(app);
  registerMagicPromptRoutes(app, { verifyApiKey, DEFAULT_TIMEOUT });
  registerChatRoutes(app, {
    verifyApiKey,
    processMessageTemplates,
    getLocalizedError,
    DEFAULT_TIMEOUT
  });
  registerOpenAIProxyRoutes(app, { getLocalizedError });
  await registerAdminRoutes(app);
  registerShortLinkRoutes(app);

  // --- Teams Integration Setup ---
  let teamsAdapter = null;
  let teamsBot = null;
  let teamsMessageExtension = null;

  try {
    teamsAdapter = createTeamsAdapter();
    if (teamsAdapter) {
      teamsBot = new TeamsBot();
      teamsMessageExtension = new TeamsMessageExtension();

      // Teams bot messaging endpoint
      app.post('/api/teams/messages', (req, res) => {
        teamsAdapter.processActivity(req, res, async context => {
          if (context.activity.type === 'message') {
            await teamsBot.run(context);
          } else if (context.activity.type === 'invoke') {
            // Handle message extensions and other invoke activities
            if (context.activity.name === 'composeExtension/submitAction') {
              const response = await teamsMessageExtension.handleMessageExtensionAction(context);
              return response;
            } else if (context.activity.name === 'composeExtension/query') {
              const response = await teamsMessageExtension.handleComposeExtensionQuery(context);
              return response;
            }
          }
        });
      });

      // Teams tab configuration endpoint
      app.get('/teams/config', (req, res) => {
        res.send(`
          <!DOCTYPE html>
          <html>
          <head>
              <title>AI Hub Apps - Teams Configuration</title>
              <script src="https://res.cdn.office.net/teams-js/2.0.0/js/MicrosoftTeams.min.js"></script>
          </head>
          <body>
              <div style="text-align: center; padding: 20px;">
                  <h2>AI Hub Apps Configuration</h2>
                  <p>Click Save to add AI Hub Apps to this team.</p>
                  <button onclick="saveConfiguration()">Save Configuration</button>
              </div>
              <script>
                  microsoftTeams.app.initialize();
                  
                  function saveConfiguration() {
                      microsoftTeams.pages.config.setConfig({
                          suggestedDisplayName: 'AI Hub Apps',
                          entityId: 'aihubapps-team-tab',
                          contentUrl: '${req.protocol}://${req.get('host')}/?teams=true&teamContext=true',
                          websiteUrl: '${req.protocol}://${req.get('host')}'
                      }).then(() => {
                          microsoftTeams.pages.config.setValidityState(true);
                      });
                  }
                  
                  // Enable the Save button
                  microsoftTeams.pages.config.setValidityState(true);
              </script>
          </body>
          </html>
        `);
      });

      // Dynamic Teams manifest endpoint
      app.get('/teams/manifest.json', async (req, res) => {
        try {
          const { loadTeamsConfiguration, loadAppConfigurations } = await import('./configCache.js');
          const { enhanceUserWithPermissions, filterResourcesByPermissions } = await import('./utils/authorization.js');
          
          // Get user from query parameter (for admin/development use) or default user
          const user = {
            id: req.query.userId || 'default',
            groups: req.query.groups ? req.query.groups.split(',') : ['authenticated', 'teams-users']
          };
          
          // Enhance user with permissions
          const enhancedUser = await enhanceUserWithPermissions(user);
          
          // Get available apps and Teams configuration
          const [apps, teamsConfig] = await Promise.all([
            loadAppConfigurations(),
            loadTeamsConfiguration()
          ]);
          
          // Filter apps by user permissions
          const allowedApps = filterResourcesByPermissions(apps, enhancedUser.permissions?.apps || []);
          
          // Generate dynamic manifest
          const manifest = await generateDynamicTeamsManifest(allowedApps, teamsConfig, req);
          
          res.json(manifest);
        } catch (error) {
          console.error('Error generating dynamic Teams manifest:', error);
          res.status(500).json({ error: 'Failed to generate manifest' });
        }
      });

      console.log('✅ Teams integration initialized successfully');
    } else {
      console.log(
        '⚠️  Teams integration disabled (TEAMS_APP_ID or TEAMS_APP_PASSWORD not configured)'
      );
    }
  } catch (error) {
    console.error('❌ Failed to initialize Teams integration:', error);
  }

/**
 * Generate dynamic Teams manifest based on user permissions and configuration
 */
async function generateDynamicTeamsManifest(allowedApps, teamsConfig, req) {
  const appId = process.env.TEAMS_APP_ID || '{{TEAMS_APP_ID}}';
  const domainName = req.get('host') || '{{DOMAIN_NAME}}';
  const protocol = req.protocol;

  // Base manifest structure
  const manifest = {
    "$schema": "https://developer.microsoft.com/en-us/json-schemas/teams/v1.16/MicrosoftTeams.schema.json",
    "manifestVersion": "1.16",
    "version": "1.0.0",
    "id": appId,
    "packageName": "com.aihubapps.teams",
    "developer": {
      "name": teamsConfig?.ui?.branding?.appName || "AI Hub Apps",
      "websiteUrl": `${protocol}://${domainName}`,
      "privacyUrl": `${protocol}://${domainName}/privacy`,
      "termsOfUseUrl": `${protocol}://${domainName}/terms`
    },
    "icons": {
      "color": "color-icon.png",
      "outline": "outline-icon.png"
    },
    "name": {
      "short": teamsConfig?.ui?.branding?.appName || "AI Hub Apps",
      "full": `${teamsConfig?.ui?.branding?.appName || "AI Hub Apps"} - AI-Powered Assistant Suite`
    },
    "description": {
      "short": "Access AI-powered applications for your daily tasks.",
      "full": `AI Hub Apps brings powerful AI capabilities directly to Microsoft Teams. Access ${Object.keys(allowedApps).length} AI-powered applications including ${Object.keys(allowedApps).slice(0, 3).join(', ')} and more through an intelligent bot interface and convenient message actions.`
    },
    "accentColor": teamsConfig?.ui?.branding?.accentColor || "#6366F1",
    "bots": [{
      "botId": appId,
      "scopes": ["personal", "team", "groupchat"],
      "supportsCalling": false,
      "supportsVideo": false,
      "supportsFiles": teamsConfig?.messageExtensions?.fileSupport?.enabled || true,
      "commandLists": [{
        "scopes": ["personal", "team", "groupchat"],
        "commands": generateBotCommands(allowedApps, teamsConfig)
      }]
    }],
    "composeExtensions": [{
      "botId": appId,
      "commands": generateMessageExtensionCommands(allowedApps, teamsConfig),
      "messageHandlers": [{
        "type": "link",
        "value": {
          "domains": [domainName]
        }
      }]
    }],
    "configurableTabs": [{
      "configurationUrl": `${protocol}://${domainName}/teams/config`,
      "canUpdateConfiguration": true,
      "scopes": ["team", "groupchat"]
    }],
    "staticTabs": [{
      "entityId": "aihubapps",
      "name": teamsConfig?.ui?.branding?.appName || "AI Hub Apps",
      "contentUrl": `${protocol}://${domainName}/?teams=true`,
      "websiteUrl": `${protocol}://${domainName}`,
      "scopes": ["personal"]
    }],
    "permissions": ["identity", "messageTeamMembers"],
    "validDomains": [domainName, "token.botframework.com"],
    "webApplicationInfo": {
      "id": appId,
      "resource": `${protocol}://${domainName}`
    },
    "authorization": {
      "permissions": {
        "resourceSpecific": [
          {
            "name": "ChannelMessage.Read.Group",
            "type": "Application"
          },
          {
            "name": "TeamMember.Read.Group",
            "type": "Application"
          }
        ]
      }
    }
  };

  return manifest;
}

/**
 * Generate bot commands based on allowed apps
 */
function generateBotCommands(allowedApps, teamsConfig) {
  const commands = [
    {
      "title": "Help",
      "description": "Show available AI Hub Apps and how to use them"
    },
    {
      "title": "List Apps",
      "description": "Show all available AI-powered applications"
    }
  ];

  // Add commands for top apps
  const topApps = Object.entries(allowedApps).slice(0, 5);
  topApps.forEach(([appId, app]) => {
    const title = app.name?.en || appId;
    const description = app.description?.en || `Use ${title} for AI assistance`;
    commands.push({
      title: title.length > 32 ? title.substring(0, 29) + '...' : title,
      description: description.length > 80 ? description.substring(0, 77) + '...' : description
    });
  });

  return commands;
}

/**
 * Generate message extension commands based on allowed apps and configuration
 */
function generateMessageExtensionCommands(allowedApps, teamsConfig) {
  const commands = [];
  const configuredCommands = teamsConfig?.messageExtensions?.commands || [];

  // Use configured commands that match allowed apps
  configuredCommands.forEach(command => {
    if (allowedApps[command.appId]) {
      commands.push({
        "id": command.id,
        "type": "action",
        "title": command.title?.en || command.id,
        "description": command.description?.en || `Use ${command.id} action`,
        "context": command.context || ["message", "compose"],
        "fetchTask": false,
        "parameters": [{
          "name": "content",
          "title": `Content to ${command.id}`,
          "description": `The content that will be processed by ${command.id}`
        }]
      });
    }
  });

  // If no configured commands, create default ones for common apps
  if (commands.length === 0) {
    const defaultCommands = [
      { appId: 'summarizer', id: 'summarize', title: 'Summarize', description: 'Create a summary of the selected content' },
      { appId: 'translator', id: 'translate', title: 'Translate', description: 'Translate the selected text' },
      { appId: 'chat', id: 'analyze', title: 'Analyze', description: 'Analyze the selected content' },
      { appId: 'email-composer', id: 'improve-writing', title: 'Improve Writing', description: 'Enhance the selected text' }
    ];

    defaultCommands.forEach(command => {
      if (allowedApps[command.appId]) {
        commands.push({
          "id": command.id,
          "type": "action",
          "title": command.title,
          "description": command.description,
          "context": ["message", "compose"],
          "fetchTask": false,
          "parameters": [{
            "name": "content",
            "title": `Content to ${command.id}`,
            "description": `The content that will be processed`
          }]
        });
      }
    });
  }

  return commands;
}

  // --- Session Management handled in sessionRoutes ---

  // Register static file and SPA routes after API routes
  registerStaticRoutes(app, { isPackaged, rootDir });

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
      console.log(`Starting HTTPS server with SSL certificate from ${config.SSL_CERT}`);
    } catch (error) {
      console.error('Error setting up HTTPS server:', error);
      console.log('Falling back to HTTP server');
      server = http.createServer(serverOptions, app);
    }
  } else {
    // Create regular HTTP server with socket reuse options
    server = http.createServer(serverOptions, app);
    console.log('Starting HTTP server (no SSL configuration provided)');
  }

  // Start server
  server.listen(PORT, HOST, () => {
    const protocol = server instanceof https.Server ? 'https' : 'http';
    console.log(`Server is running on ${protocol}://${HOST}:${PORT}`);
    console.log(`Open ${protocol}://${HOST}:${PORT} in your browser to use AI Hub Apps`);
  });

  const handleShutdownSignal = async () => {
    await shutdownTelemetry();
    process.exit(0);
  };

  process.on('SIGTERM', handleShutdownSignal);
  process.on('SIGINT', handleShutdownSignal);
}
