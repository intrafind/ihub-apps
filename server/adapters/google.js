/**
 * Google Gemini API adapter
 */
import { parseSSEBuffer } from './streamUtils.js';
import { formatToolsForGoogle, normalizeName } from './toolFormatter.js';

const GoogleAdapter = {
  /**
   * Format messages for Google Gemini API, including handling image data and file data
   */
  formatMessages(messages) {
    // Extract system message for separate handling
    let systemInstruction = '';
    const geminiContents = [];
    
    // First pass - extract system messages and handle image data and file data
    for (const message of messages) {
      if (message.role === 'system') {
        // Collect system messages - ideally there should be only one
        systemInstruction += (systemInstruction ? '\n\n' : '') + message.content;
      } else if (message.role === 'tool') {
        // Convert tool outputs to Gemini functionResponse format
        let responseObj;
        try {
          responseObj = JSON.parse(message.content);
        } catch {
          responseObj = message.content;
        }

        geminiContents.push({
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: normalizeName(message.name || message.tool_call_id || 'tool'),
                response: responseObj
              }
            }
          ]
        });
      } else {
        // Handle assistant messages with tool calls
        if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
          const parts = [];
          if (message.content) {
            parts.push({ text: message.content });
          }
          for (const call of message.tool_calls) {
            let argsObj;
            try {
              argsObj = JSON.parse(call.function.arguments || '{}');
            } catch {
              argsObj = {};
            }
            parts.push({
              functionCall: {
                name: normalizeName(call.function.name),
                args: argsObj
              }
            });
          }

          geminiContents.push({ role: 'model', parts });
          continue;
        }

        // Convert OpenAI roles to Gemini roles
        const geminiRole = message.role === 'assistant' ? 'model' : 'user';
        
        let textContent = message.content;
        
        // If there's file data, prepend it to the content
        if (message.fileData && message.fileData.content) {
          const fileInfo = `[File: ${message.fileData.name} (${message.fileData.type})]\n\n${message.fileData.content}\n\n`;
          textContent = fileInfo + (textContent || '');
        }
        
        // Check if this message contains image data
        if (message.imageData && message.imageData.base64) {
          // For image messages, we need to create a parts array with both text and image
          const parts = [];
          
          // Add text part if content exists (possibly including file content)
          if (textContent) {
            parts.push({ text: textContent });
          }
          
          // Add image part
          parts.push({
            inlineData: {
              mimeType: message.imageData.fileType || 'image/jpeg',
              data: message.imageData.base64.replace(/^data:image\/[a-z]+;base64,/, '') // Remove data URL prefix if present
            }
          });
          
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
    
    // Debug logs to trace message transformation
    console.log('Original messages:', JSON.stringify(messages.map(m => ({ role: m.role, hasImage: !!m.imageData }))));
    console.log('Transformed Gemini contents:', JSON.stringify(geminiContents.map(c => ({ role: c.role, partTypes: c.parts.map(p => Object.keys(p)[0]) }))));
    console.log('System instruction:', systemInstruction);
    
    // Return both regular messages and the system instruction
    return {
      contents: geminiContents,
      systemInstruction
    };
  },

  /**
   * Create a completion request for Gemini
   */
  createCompletionRequest(model, messages, apiKey, options = {}) {
    const { temperature = 0.7, stream = true, tools = null } = options;
    
    // Format messages and extract system instruction
    const { contents, systemInstruction } = this.formatMessages(messages);
    
    // Build Gemini API URL with API key
    let url;
    if (stream) {
      url = `${model.url}?alt=sse&key=${apiKey}`;
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
      requestBody.tools = formatToolsForGoogle(tools);
    }
    
    // Add system instruction if present
    if (systemInstruction) {
      requestBody.systemInstruction = { parts: [{ text: systemInstruction }] };
    }
    
    console.log('Request URL:', url.replace(apiKey, '[REDACTED]'));
    console.log('Request body:', JSON.stringify(requestBody, null, 2));
    
    return {
      url,
      headers: {
        'Content-Type': 'application/json'
      },
      body: requestBody
    };
  },

  /**
   * Process streaming response from Gemini
   */
  processResponseBuffer(buffer) {
    try {
      const result = {
        content: [],
        complete: false,
        error: false,
        errorMessage: null,
        finishReason: null
      };

      const { events, done } = parseSSEBuffer(buffer);
      if (done) result.complete = true;

      for (const evt of events) {
        try {
          const data = JSON.parse(evt);

          if (data.candidates && data.candidates[0]?.content?.parts) {
            for (const part of data.candidates[0].content.parts) {
              if (part.text) {
                result.content.push(part.text);
              }
            }
          }

          if (data.candidates && data.candidates[0]?.finishReason) {
            const fr = data.candidates[0].finishReason;
            // Map Gemini finish reasons to normalized values used by the client
            // Documented reasons include STOP, MAX_TOKENS, SAFETY, RECITATION and OTHER
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
          }
        } catch (jsonError) {
          // Fallback to regex if JSON parsing fails
          const textMatches = evt.match(/"text":\s*"([^"]*)"/g);
          if (textMatches) {
            for (const match of textMatches) {
              const textContent = match.replace(/"text":\s*"/, '').replace(/"$/, '');
              result.content.push(textContent);
            }
          }

          if (evt.includes('"finishReason": "STOP"') || evt.includes('"finishReason":"STOP"')) {
            result.finishReason = 'stop';
            result.complete = true;
          } else if (evt.includes('"finishReason": "MAX_TOKENS"')) {
            result.finishReason = 'length';
            result.complete = true;
          } else if (evt.includes('"finishReason": "SAFETY"') || evt.includes('"finishReason": "RECITATION"')) {
            result.finishReason = 'content_filter';
            result.complete = true;
          }
        }
      }

      return result;
    } catch (error) {
      console.error('Error processing Gemini response:', error);
      return {
        content: [],
        complete: true,
        error: true,
        errorMessage: `Error processing model response: ${error.message}`
      };
    }
  }
};

export default GoogleAdapter;