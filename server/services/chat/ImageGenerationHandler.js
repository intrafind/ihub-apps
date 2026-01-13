import { logInteraction } from '../../utils.js';
import { recordChatRequest, recordChatResponse } from '../../usageTracker.js';
import { throttledFetch } from '../../requestThrottler.js';
import ErrorHandler from '../../utils/ErrorHandler.js';
import imageGenerationAdapter from '../../adapters/imageGeneration.js';

class ImageGenerationHandler {
  constructor() {
    this.errorHandler = new ErrorHandler();
  }

  /**
   * Execute image generation request
   * @param {Object} params - Request parameters
   * @returns {Object} Response with generated images
   */
  async executeImageGeneration({
    request,
    res,
    buildLogData,
    messageId,
    model,
    DEFAULT_TIMEOUT,
    getLocalizedError,
    clientLanguage
  }) {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`Request timed out after ${DEFAULT_TIMEOUT / 1000} seconds`));
      }, DEFAULT_TIMEOUT);
    });

    try {
      const fetchOptions = {
        method: request.method || 'POST',
        headers: request.headers,
        body: JSON.stringify(request.body)
      };

      console.log('Image generation request:', {
        url: request.url,
        model: model.id,
        prompt: request.body.prompt
      });

      const responsePromise = throttledFetch(model.id, request.url, fetchOptions);
      const llmResponse = await Promise.race([responsePromise, timeoutPromise]);
      clearTimeout(timeoutId);

      if (!llmResponse.ok) {
        const errorResult = await this.errorHandler.createEnhancedLLMApiError(
          llmResponse,
          model,
          clientLanguage
        );

        const errorLog = buildLogData(false, {
          responseType: 'error',
          error: {
            message: errorResult.message,
            code: errorResult.code,
            httpStatus: errorResult.httpStatus,
            details: errorResult.details
          }
        });

        await logInteraction('image_generation_error', errorLog);

        return res.status(llmResponse.status).json({
          error: errorResult.message,
          code: errorResult.code,
          details: errorResult.details
        });
      }

      const responseData = await llmResponse.json();
      console.log('Image generation response:', responseData);

      // Process the image response using the adapter
      const processedResponse = imageGenerationAdapter.processImageResponse(
        model.provider,
        responseData
      );

      // Add messageId for client tracking
      processedResponse.messageId = messageId;

      // Log the request and response
      const baseLog = buildLogData(false);
      await recordChatRequest({
        userId: baseLog.userSessionId,
        appId: baseLog.appId,
        modelId: model.id,
        tokens: 0 // Image generation doesn't use tokens in the same way
      });

      await recordChatResponse({
        userId: baseLog.userSessionId,
        appId: baseLog.appId,
        modelId: model.id,
        tokens: 0
      });

      const responseLog = buildLogData(false, {
        responseType: 'image',
        imageCount: processedResponse.images?.length || 0,
        model: model.id
      });
      await logInteraction('image_generation_response', responseLog);

      return res.json(processedResponse);
    } catch (fetchError) {
      clearTimeout(timeoutId);

      if (fetchError.message.includes('timed out')) {
        const timeoutLog = buildLogData(false, {
          responseType: 'error',
          error: {
            message: 'Request timed out',
            timeout: DEFAULT_TIMEOUT / 1000
          }
        });
        await logInteraction('image_generation_timeout', timeoutLog);

        return res.status(504).json({
          error: 'Request timed out',
          message: `Request to ${model.provider} API timed out after ${DEFAULT_TIMEOUT / 1000} seconds`
        });
      }

      const errorLog = buildLogData(false, {
        responseType: 'error',
        error: {
          message: fetchError.message,
          stack: fetchError.stack
        }
      });
      await logInteraction('image_generation_error', errorLog);

      return res.status(500).json({
        error: 'Image generation failed',
        message: fetchError.message
      });
    }
  }

  /**
   * Execute streaming image generation (not applicable for images, but kept for interface compatibility)
   */
  async executeStreamingImageGeneration(params) {
    // Image generation doesn't support streaming
    // Fall back to non-streaming
    return await this.executeImageGeneration(params);
  }
}

export default ImageGenerationHandler;
