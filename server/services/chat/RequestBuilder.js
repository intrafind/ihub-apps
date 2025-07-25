import configCache from '../../configCache.js';
import { createCompletionRequest } from '../../adapters/index.js';
import { getToolsForApp } from '../../toolLoader.js';
import ErrorHandler from '../../utils/ErrorHandler.js';
import ApiKeyVerifier from '../../utils/ApiKeyVerifier.js';

function preprocessMessagesWithFileData(messages) {
  return messages.map(msg => {
    if (msg.fileData && msg.fileData.content) {
      const fileInfo = `[File: ${msg.fileData.name} (${msg.fileData.type})]\n\n${msg.fileData.content}\n\n`;
      return { ...msg, content: fileInfo + (msg.content || '') };
    }
    return msg;
  });
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
    processMessageTemplates,
    res,
    clientRes,
    user
  }) {
    try {
      const { data: apps, etag: appsEtag } = configCache.getApps();
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

      const { data: models, etag: modelsEtag } = configCache.getModels();
      if (!models) {
        const error = new Error('Failed to load models configuration');
        error.code = 'CONFIG_ERROR';
        return { success: false, error };
      }

      const defaultModel = models.find(m => m.default)?.id;
      let resolvedModelId = modelId || app.preferredModel || defaultModel;
      if (!models.some(m => m.id === resolvedModelId)) {
        resolvedModelId = defaultModel;
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
        modelName
      );
      llmMessages = preprocessMessagesWithFileData(llmMessages);

      const appTokenLimit = app.tokenLimit || 1024;
      const modelTokenLimit = model.tokenLimit || appTokenLimit;
      const finalTokens = useMaxTokens ? modelTokenLimit : Math.min(appTokenLimit, modelTokenLimit);

      const apiKeyResult = await this.apiKeyVerifier.verifyApiKey(model, res, clientRes, language);
      if (!apiKeyResult.success) {
        return { success: false, error: apiKeyResult.error };
      }

      const tools = await getToolsForApp(app, language);
      const request = createCompletionRequest(model, llmMessages, apiKeyResult.apiKey, {
        temperature: parseFloat(temperature) || app.preferredTemperature || 0.7,
        maxTokens: finalTokens,
        stream: !!clientRes,
        tools,
        responseFormat: outputFormat,
        responseSchema: app.outputSchema
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
          maxTokens: finalTokens
        }
      };
    } catch (error) {
      console.error('Error in prepareChatRequest:', error);
      const chatError = new Error(error.message || 'Internal server error');
      chatError.code = 'INTERNAL_ERROR';
      return { success: false, error: chatError };
    }
  }
}

export default RequestBuilder;
