/**
 * Azure OpenAI Image Generation adapter for DALL-E and GPT-Image models
 * Handles image generation through Azure OpenAI Service
 * Reference: https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/dall-e
 */
import { BaseAdapter } from './BaseAdapter.js';
import logger from '../utils/logger.js';

class AzureImageAdapterClass extends BaseAdapter {
  /**
   * Override header creation to use api-key for Azure instead of Bearer token
   * @param {string} apiKey - API key
   * @returns {Object} Headers object
   */
  createRequestHeaders(apiKey, additionalHeaders = {}) {
    return {
      'Content-Type': 'application/json',
      'api-key': apiKey,
      ...additionalHeaders
    };
  }

  /**
   * Format messages for Azure Image Generation API
   * The image generation API accepts a simple prompt, not a messages array
   * @param {Array} messages - Messages to format
   * @returns {string} Prompt string extracted from messages
   */
  formatMessages(messages) {
    // For image generation, we need to extract the user's prompt from the messages
    // Combine all user messages and assistant context into a single prompt
    const userMessages = messages.filter(m => m.role === 'user');

    // Get the last user message as the primary prompt
    const lastUserMessage = userMessages[userMessages.length - 1];

    if (!lastUserMessage) {
      return 'Generate an image';
    }

    return lastUserMessage.content || 'Generate an image';
  }

  /**
   * Create an image generation request for Azure OpenAI
   */
  createCompletionRequest(model, messages, apiKey, options = {}) {
    const prompt = this.formatMessages(messages);

    // Azure OpenAI Image Generation API parameters
    const body = {
      prompt,
      n: 1, // Number of images to generate (Azure supports 1-10)
      size: options.imageSize || model.imageGeneration?.imageSize || '1024x1024',
      quality: options.quality || 'standard', // 'standard' or 'hd'
      style: options.style || 'vivid', // 'vivid' or 'natural'
      response_format: 'b64_json' // 'url' or 'b64_json'
    };

    logger.info('Azure Image Generation request:', {
      prompt: prompt.substring(0, 100) + (prompt.length > 100 ? '...' : ''),
      size: body.size,
      quality: body.quality,
      style: body.style
    });

    return {
      url: model.url,
      method: 'POST',
      headers: this.createRequestHeaders(apiKey),
      body
    };
  }

  /**
   * Process response from Azure Image Generation API
   * Azure returns images in a different format than chat completions
   * This processes the complete non-streaming response and formats it
   * for compatibility with the streaming handler
   */
  processResponseBuffer(data) {
    const result = {
      content: [],
      images: [],
      complete: false,
      error: false,
      errorMessage: null,
      finishReason: null
    };

    if (!data) return result;

    try {
      const parsed = JSON.parse(data);

      // Azure Image Generation API returns data in the format:
      // { created: timestamp, data: [{ b64_json: "...", revised_prompt: "..." }] }
      if (parsed.data && Array.isArray(parsed.data)) {
        for (const image of parsed.data) {
          if (image.b64_json) {
            // Add image to results in the format expected by the client
            result.images.push({
              mimeType: 'image/png',
              data: image.b64_json
            });

            // Also add text description if revised prompt is available
            if (image.revised_prompt) {
              result.content.push(
                `✨ Image generated successfully!\n\nRevised prompt: "${image.revised_prompt}"`
              );
            } else {
              result.content.push('✨ Image generated successfully!');
            }
          } else if (image.url) {
            // Handle URL-based response (if response_format was 'url')
            result.content.push(`🖼️ Image URL: ${image.url}`);
          }
        }

        result.complete = true;
        result.finishReason = 'stop';
      }
      // Handle error responses
      else if (parsed.error) {
        result.error = true;
        result.errorMessage = parsed.error.message || 'Unknown error from Azure Image API';
        result.complete = true;
      }
    } catch (error) {
      logger.error('Error parsing Azure Image Generation response:', error);
      result.error = true;
      result.errorMessage = `Error parsing Azure Image response: ${error.message}`;
    }

    return result;
  }
}

const AzureImageAdapter = new AzureImageAdapterClass();
export default AzureImageAdapter;
