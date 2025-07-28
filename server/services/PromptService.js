import { loadText } from '../configLoader.js';
import { getLocalizedContent } from '../../shared/localize.js';
import configCache from '../configCache.js';
import { createSourceManager } from '../sources/index.js';

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
    console.log(`Using language '${lang}' for message templates`);

    // Resolve global prompt variables once for use throughout the function
    const globalPromptVariables = this.resolveGlobalPromptVariables(user, modelName, lang, style);
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

      // Process sources using new source handler system
      try {
        const sourceManager = createSourceManager();
        let sourceContent = '';

        // Handle new sources system
        if (app.sources && Array.isArray(app.sources) && app.sources.length > 0) {
          console.log(`Loading content from ${app.sources.length} configured sources`);

          const context = {
            user: user,
            chatId: chatId,
            userVariables: userVariables
          };

          const result = await sourceManager.processAppSources(app, context);
          sourceContent = result.content;

          console.log(
            `Loaded sources: ${result.metadata.loadedSources}/${result.metadata.totalSources} successful`
          );
          if (result.metadata.errors.length > 0) {
            console.warn('Source loading errors:', result.metadata.errors);
          }

          // Replace {{sources}} template with combined content
          if (systemPrompt.includes('{{sources}}')) {
            systemPrompt = systemPrompt.replace('{{sources}}', sourceContent || '');
          }
          // Also support legacy {{source}} template
          if (systemPrompt.includes('{{source}}')) {
            systemPrompt = systemPrompt.replace('{{source}}', sourceContent || '');
          }
        }
        // Handle legacy sourcePath for backward compatibility
        else if (app.sourcePath && systemPrompt.includes('{{source}}')) {
          const sourcePath = userVariables.source_path || app.sourcePath;
          console.log(`Loading legacy source content from file: ${sourcePath}`);

          try {
            const sourceContent = await loadText(sourcePath.replace(/^\//, ''));
            systemPrompt = systemPrompt.replace('{{source}}', sourceContent || '');
            console.log(`Loaded legacy source content (${sourceContent?.length || 0} characters)`);
          } catch (error) {
            console.error(`Error loading legacy source content from ${sourcePath}:`, error);
            systemPrompt = systemPrompt.replace(
              '{{source}}',
              `Error loading content from ${sourcePath}: ${error.message}. Please check the file path and try again.`
            );
          }
        }
      } catch (error) {
        console.error('Error in source processing system:', error);
        // Fallback to legacy behavior if source system fails
        if (app.sourcePath && systemPrompt.includes('{{source}}')) {
          systemPrompt = systemPrompt.replace(
            '{{source}}',
            `Error in source processing: ${error.message}. Please check your source configuration.`
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
}

// Export a singleton instance
export default new PromptService();
