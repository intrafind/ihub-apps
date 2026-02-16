import configCache from '../../configCache.js';
import { createCompletionRequest } from '../../adapters/index.js';
import { getToolsForApp } from '../../toolLoader.js';
import ErrorHandler from '../../utils/ErrorHandler.js';
import ApiKeyVerifier from '../../utils/ApiKeyVerifier.js';
import logger from '../../utils/logger.js';

function preprocessMessagesWithFileData(messages) {
  return messages.map(msg => {
    // Handle array of files (multiple file upload)
    if (Array.isArray(msg.fileData)) {
      const filesInfo = msg.fileData
        .map(file => {
          if (file.content) {
            return `[File: ${file.fileName} (${file.displayType || file.fileType})]\n\n${file.content}\n\n`;
          }
          return '';
        })
        .filter(Boolean)
        .join('');

      if (filesInfo) {
        return { ...msg, content: filesInfo + (msg.content || '') };
      }
      return msg;
    }

    // Handle single file (legacy behavior)
    if (msg.fileData && msg.fileData.content) {
      const fileInfo = `[File: ${msg.fileData.fileName || msg.fileData.name} (${msg.fileData.displayType || msg.fileData.fileType || msg.fileData.type})]\n\n${msg.fileData.content}\n\n`;
      return { ...msg, content: fileInfo + (msg.content || '') };
    }

    return msg;
  });
}

/**
 * Filter models based on app requirements
 * @param {Array} models - All available models
 * @param {Object} app - App configuration
 * @returns {Array} Filtered models that match app requirements
 */
function filterModelsForApp(models, app) {
  let availableModels = models;

  // Filter by allowedModels if specified
  if (app?.allowedModels && app.allowedModels.length > 0) {
    availableModels = availableModels.filter(model => app.allowedModels.includes(model.id));
  }

  // Filter by tools requirement
  if (app?.tools && app.tools.length > 0) {
    availableModels = availableModels.filter(model => model.supportsTools);
  }

  // Apply model settings filter if specified (e.g., supportsImageGeneration)
  if (app?.settings?.model?.filter) {
    const filter = app.settings.model.filter;
    availableModels = availableModels.filter(model => {
      // Check each filter property
      for (const [key, value] of Object.entries(filter)) {
        if (model[key] !== value) {
          return false;
        }
      }
      return true;
    });
  }

  return availableModels;
}

class RequestBuilder {
  constructor() {
    this.errorHandler = new ErrorHandler();
    this.apiKeyVerifier = new ApiKeyVerifier();
  }

  async prepareChatRequest({
    appId,
    modelId,
    messages,
    temperature,
    style,
    outputFormat,
    language,
    useMaxTokens = false,
    bypassAppPrompts = false,
    thinkingEnabled,
    thinkingBudget,
    thinkingThoughts,
    enabledTools,
    imageAspectRatio,
    imageQuality,
    processMessageTemplates,
    res,
    clientRes,
    user,
    chatId
  }) {
    try {
      const { data: apps } = configCache.getApps();
      if (!apps) {
        const error = new Error('Failed to load apps configuration');
        error.code = 'CONFIG_ERROR';
        return { success: false, error };
      }

      const app = apps.find(a => a.id === appId);
      if (!app) {
        const error = await this.errorHandler.createModelError(appId, 'unknown', language);
        error.code = 'APP_NOT_FOUND';
        return { success: false, error };
      }

      const { data: models } = configCache.getModels();
      if (!models) {
        const error = new Error('Failed to load models configuration');
        error.code = 'CONFIG_ERROR';
        return { success: false, error };
      }

      // Filter models based on app requirements (allowedModels, tools, settings.model.filter)
      const filteredModels = filterModelsForApp(models, app);
      console.log(
        `App ${app.id}: Filtered ${filteredModels.length} compatible models from ${models.length} total models`
      );

      // Check if no models are available at all
      if (filteredModels.length === 0) {
        // Determine the most appropriate error message
        let errorCode;

        // If there are no models in the system at all
        if (models.length === 0) {
          errorCode = 'noModelsAvailable';
        }
        // If models exist but none passed the app-specific filters
        else if (app.allowedModels || app.tools || app.settings?.model?.filter) {
          errorCode = 'noCompatibleModels';
        }
        // Otherwise, likely a permissions issue
        else {
          errorCode = 'noModelsForUser';
        }

        const error = new Error(
          errorCode === 'noModelsAvailable'
            ? `No AI models are available for this app. Please contact your administrator to configure models and permissions.`
            : errorCode === 'noCompatibleModels'
              ? `No compatible AI models found for app '${app.id}'. The app requires specific model features that are not available.`
              : `You don't have permission to access any AI models for this app.`
        );
        error.code = errorCode;
        return { success: false, error };
      }

      // Find the default model from filtered models, or fall back to global default
      const defaultModelFromFiltered = filteredModels.find(m => m.default)?.id;
      const globalDefaultModel = models.find(m => m.default)?.id;
      const defaultModel = defaultModelFromFiltered || globalDefaultModel;

      // Determine which model to use
      let resolvedModelId = modelId || app.preferredModel || defaultModel;

      // Check if we still don't have a model ID (all sources were null/undefined)
      if (!resolvedModelId) {
        console.log(
          `No model ID could be determined for app ${app.id}. No modelId provided, no preferred model, and no default model available.`
        );
        // Use the first available model from filtered list as last resort
        if (filteredModels.length > 0) {
          resolvedModelId = filteredModels[0].id;
          console.log(`Using first available model as fallback: ${resolvedModelId}`);
        } else {
          // This shouldn't happen since we checked filteredModels.length above, but handle it anyway
          const error = new Error('No model ID provided and no default model available.');
          error.code = 'noModelIdProvided';
          return { success: false, error };
        }
      }

      // Check if the resolved model is in the filtered list
      const isModelInFilteredList = filteredModels.some(m => m.id === resolvedModelId);

      if (!isModelInFilteredList) {
        console.log(
          `Model ${resolvedModelId} is not compatible with app ${app.id} requirements. Searching for fallback...`
        );

        // Try to find a compatible fallback model
        let fallbackModel = null;

        // 1. Try app's preferred model if it's in the filtered list
        if (app.preferredModel && filteredModels.some(m => m.id === app.preferredModel)) {
          fallbackModel = app.preferredModel;
          console.log(`Using app's preferred model as fallback: ${fallbackModel}`);
        }
        // 2. Try default model from filtered list
        else if (defaultModelFromFiltered) {
          fallbackModel = defaultModelFromFiltered;
          console.log(`Using default model from filtered list as fallback: ${fallbackModel}`);
        }
        // 3. Try first available model from filtered list
        else if (filteredModels.length > 0) {
          fallbackModel = filteredModels[0].id;
          console.log(`Using first available compatible model as fallback: ${fallbackModel}`);
        }

        if (fallbackModel) {
          resolvedModelId = fallbackModel;
        } else {
          // No compatible models found - this should be caught by the earlier check, but handle it
          const error = new Error(
            `No compatible AI models found for app '${app.id}'. The app requires specific model features that are not available.`
          );
          error.code = 'noCompatibleModels';
          return { success: false, error };
        }
      }

      const model = models.find(m => m.id === resolvedModelId);

      if (!model) {
        const error = await this.errorHandler.createModelError(
          resolvedModelId,
          'unknown',
          language
        );
        return { success: false, error };
      }

      // Get model name for global prompt variables
      const modelName = model?.name || model?.id || resolvedModelId;

      let llmMessages = await processMessageTemplates(
        messages,
        bypassAppPrompts ? null : app,
        style,
        outputFormat,
        language,
        app.outputSchema,
        user,
        chatId,
        modelName
      );
      // Extract raw file/image data from the last user message before preprocessing
      // flattens it into the content string. This is needed so workflow tools
      // can receive the structured file object for their inputFiles mechanism.
      const lastUserMsg = [...llmMessages].reverse().find(m => m.role === 'user');
      const userFileData = lastUserMsg?.fileData || lastUserMsg?.imageData || null;

      logger.info({
        component: 'RequestBuilder',
        message: 'File data extraction from messages',
        hasLastUserMsg: !!lastUserMsg,
        hasFileData: !!lastUserMsg?.fileData,
        hasImageData: !!lastUserMsg?.imageData,
        userFileDataFileName: userFileData?.fileName || 'none',
        messageKeys: lastUserMsg ? Object.keys(lastUserMsg).join(', ') : 'none'
      });

      llmMessages = preprocessMessagesWithFileData(llmMessages);

      logger.info({
        component: 'RequestBuilder',
        message: 'Preparing chat request',
        appId: app.id,
        modelId: model.id,
        useMaxTokens
      });

      // Determine model token limit (default to 8192 if not specified)
      const modelTokenLimit = model.tokenLimit || 8192;
      logger.info({
        component: 'RequestBuilder',
        message: 'Model token limit',
        modelTokenLimit
      });

      // If app specifies tokenLimit, use it; otherwise use model's tokenLimit
      const appTokenLimit = app.tokenLimit !== undefined ? app.tokenLimit : modelTokenLimit;
      logger.info({
        component: 'RequestBuilder',
        message: 'App token limit',
        appTokenLimit
      });

      // Use max tokens if requested, otherwise use the minimum of app and model limits
      const finalTokens = useMaxTokens ? modelTokenLimit : Math.min(appTokenLimit, modelTokenLimit);
      logger.info({
        component: 'RequestBuilder',
        message: 'Final token limit for request',
        finalTokens
      });

      const apiKeyResult = await this.apiKeyVerifier.verifyApiKey(model, res, clientRes, language);
      if (!apiKeyResult.success) {
        return { success: false, error: apiKeyResult.error };
      }

      const context = { user, chatId, language, enabledTools };
      const tools = await getToolsForApp(app, language, context);

      // Build imageConfig if image generation is supported and parameters are provided
      // Pass raw user parameters to adapter for provider-specific translation
      let imageConfig = null;
      if (model.supportsImageGeneration) {
        // Use provided parameters or fall back to model/app defaults
        const aspectRatio =
          imageAspectRatio ||
          model.imageGeneration?.aspectRatio ||
          app.imageGeneration?.aspectRatio;
        const quality =
          imageQuality || model.imageGeneration?.quality || app.imageGeneration?.quality;

        if (aspectRatio || quality) {
          // Pass raw parameters to adapter - adapter will handle provider-specific translation
          imageConfig = {
            aspectRatio,
            quality
          };
          logger.info({
            component: 'RequestBuilder',
            message: 'Image generation config passed to adapter',
            aspectRatio,
            quality
          });
        }
      }

      const request = createCompletionRequest(model, llmMessages, apiKeyResult.apiKey, {
        temperature: parseFloat(temperature) || app.preferredTemperature || 0.7,
        maxTokens: finalTokens,
        stream: !!clientRes,
        tools,
        responseFormat: outputFormat,
        responseSchema: app.outputSchema,
        user,
        chatId,
        thinkingEnabled,
        thinkingBudget,
        thinkingThoughts,
        imageConfig
      });

      return {
        success: true,
        data: {
          app,
          model,
          llmMessages,
          request,
          tools,
          apiKey: apiKeyResult.apiKey,
          temperature: parseFloat(temperature) || app.preferredTemperature || 0.7,
          maxTokens: finalTokens,
          userFileData
        }
      };
    } catch (error) {
      logger.error({
        component: 'RequestBuilder',
        message: 'Error in prepareChatRequest',
        error: error.message,
        stack: error.stack
      });
      const chatError = new Error(error.message || 'Internal server error');
      chatError.code = 'INTERNAL_ERROR';
      return { success: false, error: chatError };
    }
  }
}

export default RequestBuilder;
