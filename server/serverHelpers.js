import cors from 'cors';
import express from 'express';
import session from 'express-session';
import { proxyAuth } from './middleware/proxyAuth.js';
import localAuthMiddleware from './middleware/localAuth.js';
import { initializePassport, configureOidcProviders } from './middleware/oidcAuth.js';
import jwtAuthMiddleware from './middleware/jwtAuth.js';
import ldapAuthMiddleware from './middleware/ldapAuth.js';
import ntlmAuthMiddleware, { createNtlmMiddleware } from './middleware/ntlmAuth.js';
import { enhanceUserWithPermissions } from './utils/authorization.js';
import { loadJson, loadText } from './configLoader.js';
import { getApiKeyForModel } from './utils.js';
import { sendSSE, clients, activeRequests } from './sse.js';
import { getLocalizedContent } from '../shared/localize.js';
import config from './config.js';
import configCache from './configCache.js';
import ErrorHandler from './utils/ErrorHandler.js';
import ApiKeyVerifier from './utils/ApiKeyVerifier.js';

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
 * Configure Express middleware.
 * Body parser limits are controlled by the `requestBodyLimitMB` option in
 * `platform.json`.
 */
export function setupMiddleware(app, platformConfig = {}) {
  const limitMb = parseInt(platformConfig.requestBodyLimitMB || '50', 10);
  const limit = limitMb * 1024 * 1024;

  // Trust proxy for proper IP and protocol detection
  app.set('trust proxy', 1);

  app.use(cors());
  // Reject requests with a Content-Length exceeding the configured limit
  app.use(checkContentLength(limit));
  app.use(express.json({ limit: `${limitMb}mb` }));
  app.use(express.urlencoded({ limit: `${limitMb}mb`, extended: true }));

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

const errorHandler = new ErrorHandler();

export async function getLocalizedError(errorKey, params = {}, language) {
  return await errorHandler.getLocalizedError(errorKey, params, language);
}

const apiKeyVerifier = new ApiKeyVerifier();

export function validateApiKeys() {
  return apiKeyVerifier.validateApiKeys();
}

export async function verifyApiKey(model, res, clientRes = null, language) {
  const result = await apiKeyVerifier.verifyApiKey(model, res, clientRes, language);
  return result.success ? result.apiKey : false;
}

/**
 * Resolve global prompt variables that should be automatically available in prompts
 * @param {object} user - User object from request
 * @param {string} modelName - Name of the model being used
 * @param {string} language - Current language setting
 * @param {string} style - Current style/tone setting
 * @returns {object} Object containing global prompt variables
 */
function resolveGlobalPromptVariables(user = null, modelName = null, language = null, style = null) {
  const now = new Date();
  const platformConfig = configCache.getPlatform() || {};

  // Get timezone from user or default to UTC
  const timezone = user?.timezone || user?.settings?.timezone || 'UTC';

  // Create timezone-aware date formatter
  const tzOptions = { timeZone: timezone };
  const dateFormatter = new Intl.DateTimeFormat(language || 'en', tzOptions);
  const timeFormatter = new Intl.DateTimeFormat(language || 'en', {
    ...tzOptions,
    timeStyle: 'medium'
  });

  const globalPromptVars = {
    // Date and time variables
    year: now.getFullYear().toString(),
    month: (now.getMonth() + 1).toString().padStart(2, '0'),
    date: now.toISOString().split('T')[0], // YYYY-MM-DD format
    time: timeFormatter.format(now),
    day_of_week: now.toLocaleDateString(language || 'en', { ...tzOptions, weekday: 'long' }),

    // Locale and timezone
    timezone: timezone,
    locale: language || platformConfig.defaultLanguage || 'en',

    // User information (only if user is authenticated)
    user_name: user?.name || user?.displayName || '',
    user_email: user?.email || '',

    // Model information
    model_name: modelName || '',

    // Style/tone setting
    tone: style || '',

    // Location (from user profile if available)
    location: user?.location || user?.settings?.location || '',

    // Platform context (configurable in platform.json)
    platform_context: platformConfig.globalPromptVariables?.context || ''
  };

  // Filter out empty values to avoid replacing with empty strings unintentionally
  const filteredVars = {};
  for (const [key, value] of Object.entries(globalPromptVars)) {
    if (value !== null && value !== undefined && value !== '') {
      filteredVars[key] = value;
    }
  }

  return filteredVars;
}

export async function processMessageTemplates(
  messages,
  app,
  style = null,
  outputFormat = null,
  language,
  outputSchema = null,
  user = null,
  modelName = null
) {
  const defaultLang = configCache.getPlatform()?.defaultLanguage || 'en';
  const lang = language || defaultLang;
  console.log(`Using language '${lang}' for message templates`);

  // Resolve global prompt variables once for use throughout the function
  const globalPromptVariables = resolveGlobalPromptVariables(user, modelName, lang, style);
  console.log(`Resolved ${Object.keys(globalPromptVariables).length} global prompt variables`);

  let llmMessages = [...messages].map(msg => {
    if (msg.role === 'user' && msg.promptTemplate && msg.variables) {
      let processedContent =
        typeof msg.promptTemplate === 'object'
          ? getLocalizedContent(msg.promptTemplate, lang)
          : msg.promptTemplate || msg.content;
      if (typeof processedContent !== 'string') processedContent = String(processedContent || '');
      // Combine user-defined variables with global prompt variables (user variables take precedence)
      const variables = { ...globalPromptVariables, ...msg.variables, content: msg.content };
      if (variables && Object.keys(variables).length > 0) {
        for (const [key, value] of Object.entries(variables)) {
          const strValue = typeof value === 'string' ? value : String(value || '');
          processedContent = processedContent.replace(
            new RegExp(`\\{\\{${key}\\}\\}`, 'g'),
            strValue
          );
        }
      }
      const processedMsg = { role: 'user', content: processedContent };
      if (msg.imageData) processedMsg.imageData = msg.imageData;
      if (msg.fileData) processedMsg.fileData = msg.fileData;
      return processedMsg;
    }
    const processedMsg = { role: msg.role, content: msg.content };
    if (msg.imageData) processedMsg.imageData = msg.imageData;
    if (msg.fileData) processedMsg.fileData = msg.fileData;
    return processedMsg;
  });
  let userVariables = {};
  const lastUserMessage = messages.findLast(msg => msg.role === 'user');
  if (lastUserMessage && lastUserMessage.variables) {
    userVariables = lastUserMessage.variables;
  }
  if (app && !llmMessages.some(msg => msg.role === 'system')) {
    let systemPrompt =
      typeof app.system === 'object' ? getLocalizedContent(app.system, lang) : app.system || '';
    if (typeof systemPrompt !== 'string') systemPrompt = String(systemPrompt || '');
    // Combine user variables with global prompt variables for system prompt processing
    const allVariables = { ...globalPromptVariables, ...userVariables };
    if (Object.keys(allVariables).length > 0) {
      for (const [key, value] of Object.entries(allVariables)) {
        if (typeof value === 'function' || (typeof value === 'object' && value !== null)) continue;
        const strValue = String(value || '');
        systemPrompt = systemPrompt.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), strValue);
      }
    }
    if (app.sourcePath && systemPrompt.includes('{{source}}')) {
      const sourcePath = userVariables.source_path || app.sourcePath;
      console.log(`Loading source content from file: ${sourcePath}`);
      try {
        const sourceContent = await loadText(sourcePath.replace(/^\//, ''));
        systemPrompt = systemPrompt.replace('{{source}}', sourceContent || '');
        console.log(`Loaded source content (${sourceContent?.length || 0} characters)`);
      } catch (error) {
        console.error(`Error loading source content from ${sourcePath}:`, error);
        systemPrompt = systemPrompt.replace(
          '{{source}}',
          `Error loading content from ${sourcePath}: ${error.message}. Please check the file path and try again.`
        );
      }
    }
    if (style) {
      try {
        // Try to get styles from cache first
        let styles = configCache.getStyles();

        if (styles && styles[style] && style !== 'keep') {
          systemPrompt += `\n\n${styles[style]}`;
        } else {
          console.log(`No specific style found for '${style}'. Nothing added to system prompt.`);
        }
      } catch (err) {
        console.error('Error loading styles:', err);
      }
    }
    if (outputFormat === 'markdown') {
      systemPrompt +=
        '\n\nPlease format your response using Markdown syntax for better readability.';
    } else if (outputFormat === 'html') {
      systemPrompt +=
        '\n\nPlease format your response using HTML tags for better readability and structure.';
    } else if (outputFormat === 'json' || outputSchema) {
      systemPrompt += '\n\nRespond only with valid JSON.';
      if (outputSchema) {
        const schemaStr = JSON.stringify(outputSchema);
        systemPrompt += ` The JSON must match this schema: ${schemaStr}`;
      }
    }
    llmMessages.unshift({ role: 'system', content: systemPrompt });
  }
  return llmMessages;
}

export function cleanupInactiveClients() {
  setInterval(() => {
    const now = new Date();
    for (const [chatId, client] of clients.entries()) {
      if (now - client.lastActivity > 5 * 60 * 1000) {
        if (activeRequests.has(chatId)) {
          try {
            const controller = activeRequests.get(chatId);
            controller.abort();
            activeRequests.delete(chatId);
          } catch (e) {
            console.error(`Error aborting request for chat ID: ${chatId}`, e);
          }
        }
        client.response.end();
        clients.delete(chatId);
        console.log(`Removed inactive client: ${chatId}`);
      }
    }
  }, 60 * 1000);
}
