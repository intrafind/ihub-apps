import cors from 'cors';
import express from 'express';
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
  app.use(cors());
  // Reject requests with a Content-Length exceeding the configured limit
  app.use(checkContentLength(limit));
  app.use(express.json({ limit: `${limitMb}mb` }));
  app.use(express.urlencoded({ limit: `${limitMb}mb`, extended: true }));
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

export async function processMessageTemplates(
  messages,
  app,
  style = null,
  outputFormat = null,
  language,
  outputSchema = null
) {
  const defaultLang = configCache.getPlatform()?.defaultLanguage || 'en';
  const lang = language || defaultLang;
  console.log(`Using language '${lang}' for message templates`);
  let llmMessages = [...messages].map(msg => {
    if (msg.role === 'user' && msg.promptTemplate && msg.variables) {
      let processedContent =
        typeof msg.promptTemplate === 'object'
          ? getLocalizedContent(msg.promptTemplate, lang)
          : msg.promptTemplate || msg.content;
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
    let systemPrompt =
      typeof app.system === 'object' ? getLocalizedContent(app.system, lang) : app.system || '';
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
