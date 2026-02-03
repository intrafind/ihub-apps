/**
 * Black Forest Labs (BFL) FLUX API adapter
 * Supports asynchronous image generation with polling
 */
import { BaseAdapter } from './BaseAdapter.js';
import logger from '../utils/logger.js';

class BFLAdapterClass extends BaseAdapter {
  constructor() {
    super();
    this.maxPollingRetries = 120; // 2 minutes max with 1s intervals
    this.initialPollingDelay = 500; // Start with 500ms
    this.maxPollingDelay = 5000; // Max 5s between polls
  }

  /**
   * Format messages for BFL API
   * BFL uses a simple prompt-based interface with optional image references
   * @param {Array} messages - Messages to format
   * @returns {Object} Formatted request for BFL API
   */
  formatMessages(messages) {
    // Extract the user's prompt from the last message
    const lastMessage = messages[messages.length - 1];
    const prompt = lastMessage?.content || '';

    // Extract reference images if present
    const referenceImages = [];
    for (const message of messages) {
      if (this.hasImageData(message)) {
        if (Array.isArray(message.imageData)) {
          message.imageData
            .filter(img => img && img.base64)
            .forEach(img => {
              referenceImages.push({
                data: this.cleanBase64Data(img.base64),
                mimeType: img.fileType || 'image/jpeg'
              });
            });
        } else if (message.imageData && message.imageData.base64) {
          referenceImages.push({
            data: this.cleanBase64Data(message.imageData.base64),
            mimeType: message.imageData.fileType || 'image/jpeg'
          });
        }
      }
    }

    return {
      prompt,
      referenceImages
    };
  }

  /**
   * Create a completion request for BFL API
   * BFL uses async polling, so this initiates the generation
   * @param {Object} model - The model configuration
   * @param {Array} messages - The messages to process
   * @param {string} apiKey - The API key
   * @param {Object} options - Additional options
   * @returns {Object} Request details for BFL API
   */
  createCompletionRequest(model, messages, apiKey, options = {}) {
    const { prompt, referenceImages } = this.formatMessages(messages);

    // Build request body
    const body = {
      prompt
    };

    // Add image generation configuration
    const imageConfig = options.imageConfig || model.imageGeneration || {};

    if (imageConfig.width) {
      body.width = imageConfig.width;
    }
    if (imageConfig.height) {
      body.height = imageConfig.height;
    }
    if (imageConfig.aspectRatio) {
      body.aspect_ratio = imageConfig.aspectRatio;
    }
    if (imageConfig.safetyTolerance !== undefined) {
      body.safety_tolerance = imageConfig.safetyTolerance;
    }

    // Add reference images if present (for models that support it)
    if (referenceImages.length > 0) {
      const maxImages = imageConfig.maxReferenceImages || 4;
      body.reference_images = referenceImages.slice(0, maxImages).map(img => ({
        image: `data:${img.mimeType};base64,${img.data}`
      }));
    }

    // Add grounding search if supported (FLUX.2 [max] only)
    if (imageConfig.supportsGrounding && options.enableGrounding !== false) {
      body.grounding = true;
    }

    logger.info('BFL request body:', { ...body, prompt: prompt.substring(0, 100) });

    return {
      url: model.url,
      method: 'POST',
      headers: this.createBFLHeaders(apiKey),
      body,
      // Store for polling
      apiKey,
      modelId: model.modelId
    };
  }

  /**
   * Create headers for BFL API requests
   * @param {string} apiKey - API key
   * @returns {Object} Headers object
   */
  createBFLHeaders(apiKey) {
    return {
      'Content-Type': 'application/json',
      accept: 'application/json',
      'x-key': apiKey
    };
  }

  /**
   * Poll for results from BFL API
   * Implements exponential backoff
   * @param {string} pollingUrl - URL to poll
   * @param {string} apiKey - API key
   * @returns {Promise<Object>} Result object
   */
  async pollForResults(pollingUrl, apiKey) {
    let delay = this.initialPollingDelay;
    let retries = 0;

    while (retries < this.maxPollingRetries) {
      // Wait before polling
      await new Promise(resolve => setTimeout(resolve, delay));

      try {
        const response = await fetch(pollingUrl, {
          method: 'GET',
          headers: this.createBFLHeaders(apiKey)
        });

        if (!response.ok) {
          const errorText = await response.text();
          logger.error('BFL polling error:', {
            status: response.status,
            statusText: response.statusText,
            error: errorText
          });

          if (response.status === 429) {
            // Rate limited - increase delay
            delay = Math.min(delay * 2, this.maxPollingDelay);
            retries++;
            continue;
          }

          throw new Error(`BFL API error: ${response.status} ${errorText}`);
        }

        const result = await response.json();
        logger.info('BFL poll result:', {
          status: result.status,
          id: result.id
        });

        // Check status
        if (result.status === 'Ready') {
          return {
            success: true,
            data: result
          };
        } else if (result.status === 'Pending') {
          // Continue polling with exponential backoff
          delay = Math.min(delay * 1.5, this.maxPollingDelay);
          retries++;
          continue;
        } else if (result.status === 'Request Moderated') {
          return {
            success: false,
            error: 'request_moderated',
            message: 'Your request was flagged by content moderation.'
          };
        } else if (result.status === 'Content Moderated') {
          return {
            success: false,
            error: 'content_moderated',
            message: 'Generated content was flagged by content moderation.'
          };
        } else if (result.status === 'Task not found') {
          return {
            success: false,
            error: 'task_not_found',
            message: 'Task not found or expired.'
          };
        } else if (result.status === 'Error') {
          return {
            success: false,
            error: 'generation_error',
            message: result.error || 'Image generation failed.'
          };
        } else {
          // Unknown status - continue polling
          logger.warn('Unknown BFL status:', result.status);
          delay = Math.min(delay * 1.5, this.maxPollingDelay);
          retries++;
          continue;
        }
      } catch (error) {
        logger.error('Error polling BFL API:', error);
        throw error;
      }
    }

    // Timeout
    return {
      success: false,
      error: 'timeout',
      message: 'Image generation timed out. Please try again.'
    };
  }

  /**
   * Download image from BFL signed URL and convert to base64
   * @param {string} imageUrl - Signed URL from BFL
   * @returns {Promise<Object>} Image data with base64
   */
  async downloadImage(imageUrl) {
    try {
      const response = await fetch(imageUrl);

      if (!response.ok) {
        throw new Error(`Failed to download image: ${response.status}`);
      }

      const buffer = await response.arrayBuffer();
      const base64 = Buffer.from(buffer).toString('base64');

      // Determine MIME type from response headers or default to PNG
      const contentType = response.headers.get('content-type') || 'image/png';

      return {
        mimeType: contentType,
        data: base64
      };
    } catch (error) {
      logger.error('Error downloading BFL image:', error);
      throw error;
    }
  }

  /**
   * Process response buffer from BFL API
   * This is called by the chat service, but BFL uses async polling
   * So we handle the initial response and then poll
   * @param {string} data - Response data
   * @returns {Object} Processed result
   */
  processResponseBuffer(data) {
    const result = {
      content: [],
      images: [],
      complete: false,
      error: false,
      errorMessage: null,
      finishReason: null,
      // BFL-specific fields
      pollingUrl: null,
      requestId: null
    };

    if (!data) return result;

    try {
      const parsed = JSON.parse(data);

      // Initial submission response - contains polling URL
      if (parsed.polling_url || parsed.id) {
        result.pollingUrl = parsed.polling_url;
        result.requestId = parsed.id;
        result.content.push('Image generation started...');
        // Not complete yet - need to poll
        result.complete = false;
        return result;
      }

      // Polling result - check status
      if (parsed.status === 'Ready' && parsed.result) {
        // Extract image URL
        const imageUrl = parsed.result.sample || parsed.result.url;
        if (imageUrl) {
          // Store the image URL - will be downloaded separately
          result.images.push({
            url: imageUrl,
            needsDownload: true
          });
          result.content.push('Image generated successfully');
          result.complete = true;
          result.finishReason = 'stop';
        }
      } else if (parsed.status === 'Pending') {
        result.content.push('Image generation in progress...');
        result.complete = false;
      } else if (
        parsed.status === 'Request Moderated' ||
        parsed.status === 'Content Moderated'
      ) {
        result.error = true;
        result.errorMessage = 'Content was flagged by moderation system.';
        result.complete = true;
      } else if (parsed.status === 'Error' || parsed.status === 'Task not found') {
        result.error = true;
        result.errorMessage = parsed.error || 'Image generation failed.';
        result.complete = true;
      }
    } catch (error) {
      logger.error('Error parsing BFL response:', error);
      result.error = true;
      result.errorMessage = `Error parsing BFL response: ${error.message}`;
    }

    return result;
  }

  /**
   * Execute full generation flow (submit + poll + download)
   * This is a helper method for non-streaming execution
   * @param {Object} request - Request object from createCompletionRequest
   * @returns {Promise<Object>} Final result with downloaded image
   */
  async executeGeneration(request) {
    try {
      // Step 1: Submit generation request
      logger.info('Submitting BFL generation request...');
      const submitResponse = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: JSON.stringify(request.body)
      });

      if (!submitResponse.ok) {
        const errorText = await submitResponse.text();
        logger.error('BFL submission error:', {
          status: submitResponse.status,
          error: errorText
        });
        throw new Error(`BFL API error: ${submitResponse.status} ${errorText}`);
      }

      const submitResult = await submitResponse.json();
      logger.info('BFL submission result:', submitResult);

      // Step 2: Poll for completion
      logger.info('Polling for BFL results...');
      const pollResult = await this.pollForResults(submitResult.polling_url, request.apiKey);

      if (!pollResult.success) {
        return {
          content: [],
          images: [],
          complete: true,
          error: true,
          errorMessage: pollResult.message,
          finishReason: 'error'
        };
      }

      // Step 3: Download image
      const imageUrl = pollResult.data.result.sample || pollResult.data.result.url;
      logger.info('Downloading image from:', imageUrl);
      const imageData = await this.downloadImage(imageUrl);

      // Return in standard format
      return {
        content: ['Image generated successfully'],
        images: [
          {
            mimeType: imageData.mimeType,
            data: imageData.data,
            metadata: {
              model: request.modelId,
              requestId: submitResult.id
            }
          }
        ],
        complete: true,
        error: false,
        errorMessage: null,
        finishReason: 'stop'
      };
    } catch (error) {
      logger.error('Error executing BFL generation:', error);
      return {
        content: [],
        images: [],
        complete: true,
        error: true,
        errorMessage: error.message,
        finishReason: 'error'
      };
    }
  }
}

const BFLAdapter = new BFLAdapterClass();
export default BFLAdapter;
