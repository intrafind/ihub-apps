import { getLocalizedContent } from '../../shared/localize.js';
import configCache from '../configCache.js';
import { createSourceManager } from '../sources/index.js';
import SourceResolutionService from './SourceResolutionService.js';
import config from '../config.js';
import { getRootDir } from '../pathUtils.js';
import path from 'path';
import logger from '../utils/logger.js';

/**
 * Service for handling prompt processing and template resolution
 */
class PromptService {
  /**
   * Resolve global prompt variables that should be automatically available in prompts
   * @param {object} user - User object from request
   * @param {string} modelName - Name of the model being used
   * @param {string} language - Current language setting
   * @param {string} style - Current style/tone setting
   * @returns {object} Object containing global prompt variables
   */
  resolveGlobalPromptVariables(user = null, modelName = null, language = null, style = null) {
    const now = new Date();
    const platformConfig = configCache.getPlatform() || {};

    // Get timezone from user or default to UTC
    const timezone = user?.timezone || user?.settings?.timezone || 'UTC';

    // Create timezone-aware date formatter
    const tzOptions = { timeZone: timezone };
    const defaultLang = platformConfig.defaultLanguage || 'en';
    const dateFormatter = new Intl.DateTimeFormat(language || defaultLang, tzOptions);
    const timeFormatter = new Intl.DateTimeFormat(language || defaultLang, {
      ...tzOptions,
      timeStyle: 'medium'
    });

    const globalPromptVars = {
      // Date and time variables
      year: now.getFullYear().toString(),
      month: (now.getMonth() + 1).toString().padStart(2, '0'),
      date: dateFormatter.format(now),
      time: timeFormatter.format(now),
      day_of_week: now.toLocaleDateString(language || defaultLang, {
        ...tzOptions,
        weekday: 'long'
      }),

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
      location: user?.location || user?.settings?.location || ''
    };

    // Process platform context to resolve nested variables
    let platformContext = platformConfig.globalPromptVariables?.context || '';
    if (platformContext) {
      // Replace variables in platform_context with their resolved values
      for (const [key, value] of Object.entries(globalPromptVars)) {
        if (value !== null && value !== undefined && value !== '') {
          const strValue = String(value);
          platformContext = platformContext.replace(
            new RegExp(`\\{\\{${key}\\}\\}`, 'g'),
            strValue
          );
        }
      }
    }

    // Add processed platform_context to global vars
    globalPromptVars.platform_context = platformContext;

    // Filter out empty values to avoid replacing with empty strings unintentionally
    const filteredVars = {};
    for (const [key, value] of Object.entries(globalPromptVars)) {
      if (value !== null && value !== undefined && value !== '') {
        filteredVars[key] = value;
      }
    }

    return filteredVars;
  }

  /**
   * Process message templates with variable substitution and source content
   * @param {Array} messages - Array of messages to process
   * @param {Object} app - App configuration object
   * @param {string} style - Style/tone setting
   * @param {string} outputFormat - Output format preference
   * @param {string} language - Language setting
   * @param {Object} outputSchema - Output schema for structured responses
   * @param {Object} user - User object
   * @param {string} chatId - Chat identifier
   * @param {string} modelName - Model name
   * @returns {Array} Processed messages array
   */
  async processMessageTemplates(
    messages,
    app,
    style = null,
    outputFormat = null,
    language,
    outputSchema = null,
    user = null,
    chatId = null,
    modelName = null
  ) {
    const defaultLang = configCache.getPlatform()?.defaultLanguage || 'en';
    const lang = language || defaultLang;
    logger.info(`Using language '${lang}' for message templates`);

    // Resolve global prompt variables once for use throughout the function
    const globalPromptVariables = this.resolveGlobalPromptVariables(user, modelName, lang, style);
    logger.info(`Resolved ${Object.keys(globalPromptVariables).length} global prompt variables`);

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
        // Ensure user content is always included: if template is empty or doesn't contain {{content}},
        // append the user's actual content to make sure it's not lost
        if (msg.content && msg.content.trim()) {
          const templateHadContentPlaceholder =
            (msg.promptTemplate &&
              ((typeof msg.promptTemplate === 'object' &&
                Object.values(msg.promptTemplate).some(
                  v => typeof v === 'string' && v.includes('{{content}}')
                )) ||
                (typeof msg.promptTemplate === 'string' &&
                  msg.promptTemplate.includes('{{content}}')))) ||
            false;

          // If template was empty or didn't have {{content}}, append user content
          if (
            !processedContent.trim() ||
            (!templateHadContentPlaceholder && !processedContent.includes(msg.content))
          ) {
            processedContent = processedContent.trim()
              ? `${processedContent}\n\n${msg.content}`
              : msg.content;
          }
        }
        const processedMsg = { role: 'user', content: processedContent };
        if (msg.imageData) processedMsg.imageData = msg.imageData;
        if (msg.fileData) processedMsg.fileData = msg.fileData;
        if (msg.audioData) processedMsg.audioData = msg.audioData;
        return processedMsg;
      }
      // Apply global prompt variables to normal prompts as well
      let processedContent = msg.content;
      if (
        typeof processedContent === 'string' &&
        globalPromptVariables &&
        Object.keys(globalPromptVariables).length > 0
      ) {
        for (const [key, value] of Object.entries(globalPromptVariables)) {
          const strValue = typeof value === 'string' ? value : String(value || '');
          processedContent = processedContent.replace(
            new RegExp(`\\{\\{${key}\\}\\}`, 'g'),
            strValue
          );
        }
      }
      const processedMsg = { role: msg.role, content: processedContent };
      if (msg.imageData) processedMsg.imageData = msg.imageData;
      if (msg.fileData) processedMsg.fileData = msg.fileData;
      if (msg.audioData) processedMsg.audioData = msg.audioData;
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
          if (typeof value === 'function' || (typeof value === 'object' && value !== null))
            continue;
          const strValue = String(value || '');
          systemPrompt = systemPrompt.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), strValue);
        }
      }

      // Process sources using unified source resolution system
      try {
        let sourceContent = '';

        // Handle both admin source references and inline source configs
        if (app.sources && Array.isArray(app.sources) && app.sources.length > 0) {
          // Initialize source resolution service
          const sourceResolutionService = new SourceResolutionService();

          // Resolve source references to actual configurations
          const context = {
            user: user,
            chatId: chatId,
            userVariables: userVariables,
            language: lang
          };

          const resolvedSources = await sourceResolutionService.resolveAppSources(app, context);

          if (resolvedSources.length > 0) {
            // Create source manager for content loading
            const sourceManager = createSourceManager({
              filesystem: {
                basePath: path.resolve(getRootDir(), config.CONTENTS_DIR)
              }
            });

            // Load content from resolved sources
            const result = await sourceManager.loadSources(resolvedSources, context);
            sourceContent = result.content;

            if (result.metadata.errors.length > 0) {
              logger.warn('Source loading errors:', result.metadata.errors);
            }
          }

          // Replace {{sources}} template with combined content
          const hasSourcesPlaceholder = systemPrompt.includes('{{sources}}');
          const hasSourcePlaceholder = systemPrompt.includes('{{source}}');

          if (hasSourcesPlaceholder) {
            systemPrompt = systemPrompt.replace('{{sources}}', sourceContent || '');
          }
          // Also support legacy {{source}} template
          if (hasSourcePlaceholder) {
            systemPrompt = systemPrompt.replace('{{source}}', sourceContent || '');
          }

          // If no placeholder was found but we have source content, append it automatically
          if (!hasSourcesPlaceholder && !hasSourcePlaceholder && sourceContent) {
            systemPrompt += `\n\nSources:\n<sources>${sourceContent}</sources>`;
          }
        }
      } catch (error) {
        logger.error('Error in source resolution system:', error);
        throw new Error(`Failed to process sources: ${error.message}`);
      }

      if (style) {
        try {
          // Try to get styles from cache first
          let styles = configCache.getStyles();

          if (styles && styles[style] && style !== 'keep') {
            systemPrompt += `\n\n${styles[style]}`;
          } else {
            logger.info(`No specific style found for '${style}'. Nothing added to system prompt.`);
          }
        } catch (err) {
          logger.error('Error loading styles:', err);
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
}

// Export a singleton instance
export default new PromptService();
