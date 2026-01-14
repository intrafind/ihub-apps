/**
 * Google Gemini API adapter
 */
import { convertToolsFromGeneric, normalizeToolName } from './toolCalling/index.js';
import { BaseAdapter } from './BaseAdapter.js';

class GoogleAdapterClass extends BaseAdapter {
  /**
   * Helper to process inline image data from response parts
   */
  processInlineImage(part) {
    if (part.inlineData && part.inlineData.mimeType?.startsWith('image/')) {
      return {
        mimeType: part.inlineData.mimeType,
        data: part.inlineData.data,
        thoughtSignature: part.thoughtSignature || null
      };
    }
    return null;
  }

  /**
   * Format messages for Google Gemini API, including handling image data
   */
  formatMessages(messages) {
    // Extract system message for separate handling
    let systemInstruction = '';
    const geminiContents = [];
    let currentToolResponses = [];

    const pushToolResponses = () => {
      if (currentToolResponses.length > 0) {
        geminiContents.push({
          role: 'user',
          parts: currentToolResponses
        });
        currentToolResponses = [];
      }
    };

    // First pass - extract system messages and handle image data
    for (const message of messages) {
      if (message.role === 'tool') {
        let responseObj;
        responseObj = this.safeJsonParse(message.content, message.content);
        currentToolResponses.push({
          functionResponse: {
            name: normalizeToolName(message.name || message.tool_call_id || 'tool'),
            response: { result: responseObj }
          }
        });
      } else {
        pushToolResponses();

        if (message.role === 'system') {
          // Collect system messages - ideally there should be only one
          systemInstruction += (systemInstruction ? '\n\n' : '') + message.content;
        } else {
          // Handle assistant messages with tool calls
          if (
            message.role === 'assistant' &&
            Array.isArray(message.tool_calls) &&
            message.tool_calls.length > 0
          ) {
            const parts = [];
            if (message.content) {
              parts.push({ text: message.content });
            }
            for (const call of message.tool_calls) {
              let argsObj;
              argsObj = this.safeJsonParse(call.function.arguments, {});
              parts.push({
                functionCall: {
                  name: normalizeToolName(call.function.name),
                  args: argsObj
                }
              });
            }

            geminiContents.push({ role: 'model', parts });
            continue;
          }

          // Convert OpenAI roles to Gemini roles
          const geminiRole = message.role === 'assistant' ? 'model' : 'user';

          const textContent = message.content;

          // Check if this message contains image data
          if (this.hasImageData(message)) {
            // For image messages, we need to create a parts array with both text and image
            const parts = [];

            // Add text part if content exists (possibly including file content)
            if (textContent) {
              parts.push({ text: textContent });
            }

            // Handle multiple images
            if (Array.isArray(message.imageData)) {
              message.imageData
                .filter(img => img && img.base64)
                .forEach(img => {
                  parts.push({
                    inlineData: {
                      mimeType: img.fileType || 'image/jpeg',
                      data: this.cleanBase64Data(img.base64)
                    }
                  });
                });
            } else {
              // Handle single image (legacy behavior)
              parts.push({
                inlineData: {
                  mimeType: message.imageData.fileType || 'image/jpeg',
                  data: this.cleanBase64Data(message.imageData.base64)
                }
              });
            }

            geminiContents.push({ role: geminiRole, parts });
          } else {
            // Regular text message (possibly including file content)
            geminiContents.push({
              role: geminiRole,
              parts: [{ text: textContent }]
            });
          }
        }
      }
    }
    pushToolResponses();

    // Debug logs to trace message transformation
    this.debugLogMessages(messages, geminiContents, 'Google');
    console.log('System instruction:', systemInstruction);

    // Return both regular messages and the system instruction
    return {
      contents: geminiContents,
      systemInstruction
    };
  }

  /**
   * Create a completion request for Gemini
   */
  createCompletionRequest(model, messages, apiKey, options = {}) {
    const { temperature, stream, tools, responseFormat, responseSchema } =
      this.extractRequestOptions(options);

    // Format messages and extract system instruction
    const { contents, systemInstruction } = this.formatMessages(messages);

    // Build Gemini API URL with API key
    let url;
    if (stream) {
      // For streaming requests, use the streamGenerateContent endpoint with alt=sse
      // Ensure the URL ends with streamGenerateContent for streaming
      const baseUrl = model.url.includes(':streamGenerateContent')
        ? model.url
        : model.url.replace(':generateContent', ':streamGenerateContent');
      url = `${baseUrl}?alt=sse&key=${apiKey}`;
    } else {
      // Convert the configured streaming URL to the non-streaming endpoint
      const nonStreamingUrl = model.url.replace(':streamGenerateContent', ':generateContent');
      url = `${nonStreamingUrl}?key=${apiKey}`;
    }

    // Build request body
    const requestBody = {
      contents,
      generationConfig: {
        temperature: parseFloat(temperature),
        maxOutputTokens: options.maxTokens || 2048
      }
    };

    if (tools && tools.length > 0) {
      requestBody.tools = convertToolsFromGeneric(tools, 'google');
    }
    if ((responseFormat && responseFormat === 'json') || responseSchema) {
      requestBody.generationConfig.responseMimeType = 'application/json';
      if (responseSchema) {
        requestBody.generationConfig.response_schema = responseSchema;
      }
    }

    // Add system instruction if present
    if (systemInstruction) {
      requestBody.systemInstruction = { parts: [{ text: systemInstruction }] };
    }

    // Add thinking configuration if model supports it and user hasn't disabled it
    if (model.thinking?.enabled) {
      // Use options if provided, otherwise fall back to model defaults
      // If user explicitly set thinkingEnabled to false, don't add thinking config
      const thinkingEnabled = options.thinkingEnabled ?? true;

      if (thinkingEnabled) {
        requestBody.generationConfig.thinkingConfig = {
          thinkingBudget: options.thinkingBudget ?? model.thinking.budget,
          includeThoughts: options.thinkingThoughts ?? model.thinking.thoughts
        };
        console.log(
          'Thinking enabled - added thinkingConfig with budget:',
          requestBody.generationConfig.thinkingConfig.thinkingBudget
        );
      } else {
        console.log('Thinking disabled - not adding thinkingConfig');
      }
    }

    // Add image generation configuration if model supports it
    if (model.supportsImageGeneration || model.imageGeneration?.enabled) {
      // Enable image generation by setting responseModalities to include IMAGE
      requestBody.generationConfig.responseModalities = ['TEXT', 'IMAGE'];

      // Add imageConfig if provided in options or model configuration
      const imageConfig = options.imageConfig || model.imageGeneration || {};

      if (imageConfig.aspectRatio || imageConfig.imageSize) {
        requestBody.generationConfig.imageConfig = {};

        if (imageConfig.aspectRatio) {
          requestBody.generationConfig.imageConfig.aspectRatio = imageConfig.aspectRatio;
        }

        if (imageConfig.imageSize) {
          requestBody.generationConfig.imageConfig.imageSize = imageConfig.imageSize;
        }
      }

      console.log('Image generation enabled with config:', {
        responseModalities: requestBody.generationConfig.responseModalities,
        imageConfig: requestBody.generationConfig.imageConfig
      });
    }

    console.log('Google request body:', requestBody);

    return {
      url,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: requestBody
    };
  }

  /**
   * Process streaming response from Gemini
   */
  processResponseBuffer(data) {
    try {
      const result = {
        content: [],
        tool_calls: [],
        thinking: [],
        images: [],
        thoughtSignatures: [],
        groundingMetadata: null,
        complete: false,
        error: false,
        errorMessage: null,
        finishReason: null
      };

      if (!data) return result;

      try {
        const parsed = JSON.parse(data);

        // Debug: Log the full parsed response to see what metadata we receive
        console.log('Full Gemini response structure:', JSON.stringify(parsed, null, 2));

        // Handle full response object (non-streaming) - detect by presence of finishReason at the top level
        // OR if the response contains all expected fields for a complete response
        if (
          parsed.candidates &&
          parsed.candidates[0]?.finishReason &&
          parsed.candidates[0]?.content?.parts?.[0]
        ) {
          // This is a complete non-streaming response
          for (const part of parsed.candidates[0].content.parts) {
            if (part.text) {
              if (part.thought) {
                result.thinking.push(part.text);
              } else {
                result.content.push(part.text);
              }
            }
            const image = this.processInlineImage(part);
            if (image) {
              // Skip interim "thought images" - only show the final image
              if (part.thought !== true) {
                result.images.push(image);
              }
            }
            if (part.functionCall) {
              result.tool_calls.push({
                index: 0,
                id: 'tool_call_1',
                function: {
                  name: part.functionCall.name,
                  arguments: JSON.stringify(part.functionCall.args || {})
                }
              });
              if (!result.finishReason) result.finishReason = 'tool_calls';
            }
            // Collect thought signatures for multi-turn conversations
            if (part.thoughtSignature) {
              result.thoughtSignatures.push(part.thoughtSignature);
            }
          }
          result.complete = true;
          const fr = parsed.candidates[0].finishReason;
          // Only set finishReason from Gemini if we don't already have tool_calls
          if (result.finishReason !== 'tool_calls') {
            if (fr === 'STOP') {
              result.finishReason = 'stop';
            } else if (fr === 'MAX_TOKENS') {
              result.finishReason = 'length';
            } else if (fr === 'SAFETY' || fr === 'RECITATION') {
              result.finishReason = 'content_filter';
            } else {
              result.finishReason = fr;
            }
          }
        }
        // Handle streaming response chunks - process content parts
        else if (parsed.candidates && parsed.candidates[0]?.content?.parts) {
          let idx = result.tool_calls.length;
          for (const part of parsed.candidates[0].content.parts) {
            if (part.text) {
              if (part.thought) {
                result.thinking.push(part.text);
              } else {
                result.content.push(part.text);
              }
            }
            const image = this.processInlineImage(part);
            if (image) {
              // Skip interim "thought images" - only show the final image
              if (part.thought !== true) {
                result.images.push(image);
              }
            }
            if (part.functionCall) {
              result.tool_calls.push({
                index: idx++,
                id: `tool_call_${idx}`,
                function: {
                  name: part.functionCall.name,
                  arguments: JSON.stringify(part.functionCall.args || {})
                }
              });
              if (!result.finishReason) result.finishReason = 'tool_calls';
            }
            // Collect thought signatures for multi-turn conversations
            if (part.thoughtSignature) {
              result.thoughtSignatures.push(part.thoughtSignature);
            }
          }
        }

        // Extract grounding metadata if present (for Google Search grounding)
        if (parsed.groundingMetadata) {
          result.groundingMetadata = parsed.groundingMetadata;
        }

        // TODO we should make use of the candidate metadata
        // if (parsed.candidates && parsed.candidates[0]?.safetyRatings) {
        //   result.thinking.push({ type: 'safety', info: parsed.candidates[0].safetyRatings });
        // }
        // if (parsed.candidates && parsed.candidates[0]?.citationMetadata) {
        //   result.thinking.push({ type: 'citation', info: parsed.candidates[0].citationMetadata });
        // }
        // if (parsed.promptFeedback) {
        //   result.thinking.push({ type: 'feedback', info: parsed.promptFeedback });
        // }

        if (parsed.candidates && parsed.candidates[0]?.finishReason) {
          const fr = parsed.candidates[0].finishReason;
          // Map Gemini finish reasons to normalized values used by the client
          // Documented reasons include STOP, MAX_TOKENS, SAFETY, RECITATION and OTHER
          // Only set finishReason from Gemini if we don't already have tool_calls
          if (result.finishReason !== 'tool_calls') {
            if (fr === 'STOP') {
              result.finishReason = 'stop';
              result.complete = true;
            } else if (fr === 'MAX_TOKENS') {
              result.finishReason = 'length';
              result.complete = true;
            } else if (fr === 'SAFETY' || fr === 'RECITATION') {
              result.finishReason = 'content_filter';
              result.complete = true;
            } else {
              result.finishReason = fr;
            }
          } else {
            // If we have tool_calls, mark as complete but preserve the tool_calls finish reason
            result.complete = true;
          }
        }
      } catch (jsonError) {
        console.error('Failed to parse Google response as JSON:', jsonError.message);
        console.error('Raw response data that failed to parse:', data);

        // Check if this is an error response from Google API
        if (data.includes('callbacks') && data.includes('function')) {
          console.error(
            'Google API returned a callbacks-related error. This suggests an issue with the request format.'
          );
          result.error = true;
          result.errorMessage = data.includes('`callbacks`')
            ? data
            : 'Google API error related to callbacks parameter';
          return result;
        }

        // Fallback to regex if JSON parsing fails
        const textMatches = data.match(/"text":\s*"([^"]*)"/g);
        if (textMatches) {
          for (const match of textMatches) {
            const textContent = match.replace(/"text":\s*"/, '').replace(/"$/, '');
            result.content.push(textContent);
          }
        }

        if (data.includes('"finishReason": "STOP"') || data.includes('"finishReason":"STOP"')) {
          result.finishReason = 'stop';
          result.complete = true;
        } else if (data.includes('"finishReason": "MAX_TOKENS"')) {
          result.finishReason = 'length';
          result.complete = true;
        } else if (
          data.includes('"finishReason": "SAFETY"') ||
          data.includes('"finishReason": "RECITATION"')
        ) {
          result.finishReason = 'content_filter';
          result.complete = true;
        }
      }

      return result;
    } catch (error) {
      console.error('Error processing Gemini response:', error);
      console.error('Error stack:', error.stack);
      console.error('Raw data that caused the error:', data);
      return {
        content: [],
        complete: true,
        error: true,
        errorMessage: `Error processing model response: ${error.message}`
      };
    }
  }
}

const GoogleAdapter = new GoogleAdapterClass();
export default GoogleAdapter;
