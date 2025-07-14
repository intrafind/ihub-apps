import cors from 'cors';
import express from 'express';
import { loadJson, loadText } from './configLoader.js';
import { getApiKeyForModel } from './utils.js';
import { sendSSE, clients, activeRequests } from './sse.js';
import { getLocalizedContent } from '../shared/localize.js';
import config from './config.js';
import configCache from './configCache.js';

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
  app.use(cors());
  // Reject requests with a Content-Length exceeding the configured limit
  app.use(checkContentLength(limit));
  app.use(express.json({ limit: `${limitMb}mb` }));
  app.use(express.urlencoded({ limit: `${limitMb}mb`, extended: true }));
}


export async function getLocalizedError(errorKey, params = {}, language) {
  const defaultLang = configCache.getPlatform()?.defaultLanguage || 'en';
  const lang = language || defaultLang;
  try {
    // Try to get translations from cache first
    let translations = configCache.getLocalizations(lang);
    
    const hasServer = translations?.serverErrors && translations.serverErrors[errorKey];
    const hasTool = translations?.toolErrors && translations.toolErrors[errorKey];
    if (!translations || (!hasServer && !hasTool)) {
      if (lang !== defaultLang) {
        // Try default translations from cache first
        let enTranslations = configCache.getLocalizations(defaultLang);
        if (!enTranslations) {
          await configCache.loadAndCacheLocale(defaultLang);
          enTranslations = configCache.getLocalizations(defaultLang);
        }
        const enServer = enTranslations?.serverErrors?.[errorKey];
        const enTool = enTranslations?.toolErrors?.[errorKey];
        if (enServer || enTool) {
          let message = enServer || enTool;
          Object.entries(params).forEach(([k,v]) => { message = message.replace(`{${k}}`, v); });
          return message;
        }
      }
      return `Error: ${errorKey}`;
    }
    let message = translations.serverErrors?.[errorKey] || translations.toolErrors?.[errorKey];
    Object.entries(params).forEach(([k,v]) => { message = message.replace(`{${k}}`, v); });
    return message;
  } catch (error) {
    console.error(`Error getting localized error message for ${errorKey}:`, error);
    return `Error: ${errorKey}`;
  }
}

export function validateApiKeys() {
  const providers = ['openai', 'anthropic', 'google', 'mistral'];
  const missing = [];
  for (const provider of providers) {
    const envVar = `${provider.toUpperCase()}_API_KEY`;
    if (!config[envVar]) missing.push(provider);
  }
  if (missing.length > 0) {
    console.warn(`⚠️ WARNING: Missing API keys for providers: ${missing.join(', ')}`);
    console.warn('Some models may not work. Please check your .env file configuration.');
  } else {
    console.log('✓ All provider API keys are configured');
  }
}

export async function verifyApiKey(model, res, clientRes = null, language) {
  const defaultLang = configCache.getPlatform()?.defaultLanguage || 'en';
  const lang = language || defaultLang;
  try {
    const apiKey = await getApiKeyForModel(model.id);
    if (!apiKey) {
      console.error(`API key not found for model: ${model.id} (${model.provider}). Please set ${model.provider.toUpperCase()}_API_KEY in your environment.`);
      const localizedErrorMessage = await getLocalizedError('apiKeyNotFound', { provider: model.provider }, lang);
      if (clientRes) sendSSE(clientRes, 'error', { message: localizedErrorMessage });
      return false;
    }
    return apiKey;
  } catch (error) {
    console.error(`Error getting API key for model ${model.id}:`, error);
    const localizedErrorMessage = await getLocalizedError('internalError', {}, lang);
    if (clientRes) sendSSE(clientRes, 'error', { message: localizedErrorMessage });
    return false;
  }
}

export async function processMessageTemplates(messages, app, style = null, outputFormat = null, language, outputSchema = null) {
  const defaultLang = configCache.getPlatform()?.defaultLanguage || 'en';
  const lang = language || defaultLang;
  console.log(`Using language '${lang}' for message templates`);
  let llmMessages = [...messages].map(msg => {
    if (msg.role === 'user' && msg.promptTemplate && msg.variables) {
      let processedContent = typeof msg.promptTemplate === 'object'
        ? getLocalizedContent(msg.promptTemplate, lang)
        : (msg.promptTemplate || msg.content);
      if (typeof processedContent !== 'string') processedContent = String(processedContent || '');
      const variables = { ...msg.variables, content: msg.content };
      if (variables && Object.keys(variables).length > 0) {
        for (const [key, value] of Object.entries(variables)) {
          const strValue = typeof value === 'string' ? value : String(value || '');
          processedContent = processedContent.replace(`{{${key}}}`, strValue);
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
    let systemPrompt = typeof app.system === 'object' ? getLocalizedContent(app.system, lang) : (app.system || '');
    if (typeof systemPrompt !== 'string') systemPrompt = String(systemPrompt || '');
    if (Object.keys(userVariables).length > 0) {
      for (const [key, value] of Object.entries(userVariables)) {
        if (typeof value === 'function' || (typeof value === 'object' && value !== null)) continue;
        const strValue = String(value || '');
        systemPrompt = systemPrompt.replace(`{{${key}}}`, strValue);
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
        systemPrompt = systemPrompt.replace('{{source}}', `Error loading content from ${sourcePath}: ${error.message}. Please check the file path and try again.`);
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
      systemPrompt += '\n\nPlease format your response using Markdown syntax for better readability.';
    } else if (outputFormat === 'html') {
      systemPrompt += '\n\nPlease format your response using HTML tags for better readability and structure.';
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
