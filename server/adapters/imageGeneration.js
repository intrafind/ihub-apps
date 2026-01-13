/**
 * Image Generation adapter for handling text-to-image models
 * Supports OpenAI DALL-E and other image generation providers
 */
import { BaseAdapter } from './BaseAdapter.js';

class ImageGenerationAdapter extends BaseAdapter {
  /**
   * Create an image generation request
   * @param {Object} model - The model configuration
   * @param {string} prompt - The text prompt for image generation
   * @param {string} apiKey - The API key
   * @param {Object} options - Additional options (size, quality, style, n)
   * @returns {Object} Request details including URL, headers, and body
   */
  createImageRequest(model, prompt, apiKey, options = {}) {
    const provider = model.provider;

    if (provider === 'openai-image' || provider === 'openai') {
      return this.createOpenAIImageRequest(model, prompt, apiKey, options);
    }

    if (provider === 'azure-openai-image' || provider === 'azure-openai') {
      return this.createAzureOpenAIImageRequest(model, prompt, apiKey, options);
    }

    if (provider === 'google-image' || provider === 'google') {
      return this.createGoogleImagenRequest(model, prompt, apiKey, options);
    }

    // For unsupported providers, throw an error to aid debugging
    throw new Error(
      `Unsupported image generation provider: ${provider}. Supported providers: openai-image, openai, azure-openai-image, azure-openai, google-image, google`
    );
  }

  /**
   * Create OpenAI DALL-E image generation request
   */
  createOpenAIImageRequest(model, prompt, apiKey, options = {}) {
    const body = {
      model: model.modelId,
      prompt: prompt,
      n: options.n || 1,
      size: options.size || '1024x1024',
      response_format: 'url' // Can be 'url' or 'b64_json'
    };

    // Add quality and style for DALL-E 3
    if (model.modelId === 'dall-e-3') {
      if (options.quality) {
        body.quality = options.quality;
      }
      if (options.style) {
        body.style = options.style;
      }
    }

    console.log('OpenAI Image Generation request:', JSON.stringify(body, null, 2));

    return {
      url: model.url,
      method: 'POST',
      headers: this.createRequestHeaders(apiKey),
      body
    };
  }

  /**
   * Create Azure OpenAI DALL-E image generation request
   */
  createAzureOpenAIImageRequest(model, prompt, apiKey, options = {}) {
    const body = {
      prompt: prompt,
      n: options.n || 1,
      size: options.size || '1024x1024'
    };

    // Add quality and style for DALL-E 3
    if (model.modelId.includes('dall-e-3')) {
      if (options.quality) {
        body.quality = options.quality;
      }
      if (options.style) {
        body.style = options.style;
      }
    }

    console.log('Azure OpenAI Image Generation request:', JSON.stringify(body, null, 2));

    return {
      url: model.url,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': apiKey
      },
      body
    };
  }

  /**
   * Create Google Imagen (Nano Banana) image generation request
   */
  createGoogleImagenRequest(model, prompt, apiKey, options = {}) {
    const body = {
      instances: [
        {
          prompt: prompt
        }
      ],
      parameters: {
        sampleCount: options.n || 1
      }
    };

    // Add optional parameters
    if (options.aspectRatio) {
      body.parameters.aspectRatio = options.aspectRatio;
    }
    if (options.negativePrompt) {
      body.instances[0].negativePrompt = options.negativePrompt;
    }
    if (options.seed) {
      body.parameters.seed = options.seed;
    }

    console.log('Google Imagen request:', JSON.stringify(body, null, 2));

    return {
      url: model.url,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body
    };
  }

  /**
   * Process image generation response
   * @param {string} provider - The provider name
   * @param {Object} responseData - The response from the API
   * @returns {Object} Processed image data
   */
  processImageResponse(provider, responseData) {
    if (provider === 'openai-image' || provider === 'openai') {
      return this.processOpenAIImageResponse(responseData);
    }

    if (provider === 'azure-openai-image' || provider === 'azure-openai') {
      return this.processAzureOpenAIImageResponse(responseData);
    }

    if (provider === 'google-image' || provider === 'google') {
      return this.processGoogleImagenResponse(responseData);
    }

    // Fallback to OpenAI format
    return this.processOpenAIImageResponse(responseData);
  }

  /**
   * Process OpenAI DALL-E image response
   */
  processOpenAIImageResponse(responseData) {
    const result = {
      type: 'image',
      images: [],
      error: false,
      errorMessage: null
    };

    try {
      if (responseData.data && Array.isArray(responseData.data)) {
        result.images = responseData.data.map(img => ({
          url: img.url || img.b64_json,
          revised_prompt: img.revised_prompt,
          format: 'png',
          isBase64: !!img.b64_json
        }));
      }

      result.metadata = {
        created: responseData.created,
        model: responseData.model || 'unknown'
      };
    } catch (error) {
      console.error('Error processing image response:', error);
      result.error = true;
      result.errorMessage = `Error processing image response: ${error.message}`;
    }

    return result;
  }

  /**
   * Process Azure OpenAI DALL-E image response
   */
  processAzureOpenAIImageResponse(responseData) {
    const result = {
      type: 'image',
      images: [],
      error: false,
      errorMessage: null
    };

    try {
      if (responseData.data && Array.isArray(responseData.data)) {
        result.images = responseData.data.map(img => ({
          url: img.url || img.b64_json,
          revised_prompt: img.revised_prompt,
          format: 'png',
          isBase64: !!img.b64_json
        }));
      }

      result.metadata = {
        created: responseData.created,
        model: 'azure-dalle'
      };
    } catch (error) {
      console.error('Error processing Azure OpenAI image response:', error);
      result.error = true;
      result.errorMessage = `Error processing image response: ${error.message}`;
    }

    return result;
  }

  /**
   * Process Google Imagen (Nano Banana) image response
   */
  processGoogleImagenResponse(responseData) {
    const result = {
      type: 'image',
      images: [],
      error: false,
      errorMessage: null
    };

    try {
      if (responseData.predictions && Array.isArray(responseData.predictions)) {
        result.images = responseData.predictions.map(prediction => {
          // Google Imagen returns base64 encoded images in the 'bytesBase64Encoded' field
          const imageData = prediction.bytesBase64Encoded || prediction.image;
          return {
            url: imageData,
            format: 'png',
            isBase64: true
          };
        });
      }

      result.metadata = {
        model: 'imagen'
      };
    } catch (error) {
      console.error('Error processing Google Imagen response:', error);
      result.error = true;
      result.errorMessage = `Error processing image response: ${error.message}`;
    }

    return result;
  }

  /**
   * Format messages is not applicable for image generation.
   * Image generation uses a single prompt instead of a conversation history.
   * This method is here to satisfy the adapter interface but returns messages unchanged.
   * @param {Array} messages - Messages array (not used for image generation)
   * @returns {Array} Messages unchanged
   */
  formatMessages(messages) {
    // For image generation, we don't format messages
    // The prompt is extracted from the last user message
    return messages;
  }

  /**
   * Process response buffer is not applicable for image generation
   * Images are not streamed like chat responses
   */
  processResponseBuffer(buffer) {
    return {
      content: [],
      complete: true,
      error: false,
      errorMessage: null,
      finishReason: 'stop'
    };
  }

  /**
   * Create completion request delegates to createImageRequest
   */
  createCompletionRequest(model, messages, apiKey, options = {}) {
    // Extract prompt from the last user message
    const lastUserMessage = [...messages].reverse().find(m => m.role === 'user');
    const prompt = lastUserMessage ? lastUserMessage.content : '';

    return this.createImageRequest(model, prompt, apiKey, options);
  }
}

const imageGenerationAdapter = new ImageGenerationAdapter();
export default imageGenerationAdapter;
