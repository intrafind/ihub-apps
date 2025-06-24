import cors from 'cors';
import express from 'express';
import { loadJson, loadText } from './configLoader.js';
import { getApiKeyForModel } from './utils.js';
import { sendSSE, clients, activeRequests } from './sse.js';

export function setupMiddleware(app) {
  app.use(cors());
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ limit: '50mb', extended: true }));
}

export function getLocalizedContent(content, language = 'en', fallbackLanguage = 'en') {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (typeof content === 'object') {
    try {
      if (content[language]) return content[language];
      if (content[fallbackLanguage]) return content[fallbackLanguage];
      const available = Object.keys(content);
      if (available.length > 0) {
        if (language !== 'en') console.error(`Missing translation for language: ${language}`);
        return content[available[0]];
      }
      return '';
    } catch (err) {
      console.error('Error accessing content object:', err);
      return '';
    }
  }
  try {
    return String(content);
  } catch (e) {
    console.error('Failed to convert content to string:', e);
    return '';
  }
}

export async function getLocalizedError(errorKey, params = {}, language = 'en') {
  try {
    const translations = await loadJson(`locales/${language}.json`);
    const hasServer = translations?.serverErrors && translations.serverErrors[errorKey];
    const hasTool = translations?.toolErrors && translations.toolErrors[errorKey];
    if (!translations || (!hasServer && !hasTool)) {
      if (language !== 'en') {
        const enTranslations = await loadJson('locales/en.json');
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
  const providers = ['openai', 'anthropic', 'google'];
  const missing = [];
  for (const provider of providers) {
    const envVar = `${provider.toUpperCase()}_API_KEY`;
    if (!process.env[envVar]) missing.push(provider);
  }
  if (missing.length > 0) {
    console.warn(`⚠️ WARNING: Missing API keys for providers: ${missing.join(', ')}`);
    console.warn('Some models may not work. Please check your .env file configuration.');
  } else {
    console.log('✓ All provider API keys are configured');
  }
}

export async function verifyApiKey(model, res, clientRes = null, language = 'en') {
  try {
    const apiKey = await getApiKeyForModel(model.id);
    if (!apiKey) {
      console.error(`API key not found for model: ${model.id} (${model.provider}). Please set ${model.provider.toUpperCase()}_API_KEY in your environment.`);
      const localizedErrorMessage = await getLocalizedError('apiKeyNotFound', { provider: model.provider }, language);
      if (clientRes) sendSSE(clientRes, 'error', { message: localizedErrorMessage });
      return false;
    }
    return apiKey;
  } catch (error) {
    console.error(`Error getting API key for model ${model.id}:`, error);
    const localizedErrorMessage = await getLocalizedError('internalError', {}, language);
    if (clientRes) sendSSE(clientRes, 'error', { message: localizedErrorMessage });
    return false;
  }
}

export async function processMessageTemplates(messages, app, style = null, outputFormat = null, language = 'en') {
  console.log(`Using language '${language}' for message templates`);
  let llmMessages = [...messages].map(msg => {
    if (msg.role === 'user' && msg.promptTemplate && msg.variables) {
      let processedContent = typeof msg.promptTemplate === 'object'
        ? getLocalizedContent(msg.promptTemplate, language)
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
    let systemPrompt = typeof app.system === 'object' ? getLocalizedContent(app.system, language) : (app.system || '');
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
        const styles = await loadJson('config/styles.json');
        if (styles && styles[style]) {
          systemPrompt += `\n\n${styles[style]}`;
        }
      } catch (err) {
        console.error('Error loading styles:', err);
      }
    }
    if (outputFormat === 'markdown') {
      systemPrompt += '\n\nPlease format your response using Markdown syntax for better readability.';
    } else if (outputFormat === 'html') {
      systemPrompt += '\n\nPlease format your response using HTML tags for better readability and structure.';
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
