/**
 * Google Gemini API adapter
 */
import { sendSSE } from '../utils.js';

const GoogleAdapter = {
  /**
   * Format messages for Google Gemini API
   */
  formatMessages(messages) {
    // Extract system message for separate handling
    let systemInstruction = '';
    const geminiContents = [];
    
    // First pass - extract system messages
    for (const message of messages) {
      if (message.role === 'system') {
        // Collect system messages - ideally there should be only one
        systemInstruction += (systemInstruction ? '\n\n' : '') + message.content;
      } else {
        // Convert OpenAI roles to Gemini roles
        const geminiRole = message.role === 'assistant' ? 'model' : 'user';
        
        geminiContents.push({
          role: geminiRole,
          parts: [{ text: message.content }]
        });
      }
    }
    
    // Debug logs to trace message transformation
    console.log('Original messages:', JSON.stringify(messages));
    console.log('Transformed Gemini contents:', JSON.stringify(geminiContents));
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
    const { temperature = 0.7, stream = true } = options;
    
    // Format messages and extract system instruction
    const { contents, systemInstruction } = this.formatMessages(messages);
    
    // Build Gemini API URL with API key
    const url = stream 
      ? `${model.url}?alt=sse&key=${apiKey}`
      : `https://generativelanguage.googleapis.com/v1beta/models/${model.modelId}:streamGenerateContent?alt=sse&key=${apiKey}`;
    
    // Build request body
    const requestBody = {
      contents,
      generationConfig: {
        temperature: parseFloat(temperature),
        maxOutputTokens: options.maxTokens || 2048
      }
    };
    
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
    console.log('Processing buffer:', buffer);
    try {
      // Initialize result object
      const result = {
        content: [],
        complete: false,
        error: false,
        errorMessage: null
      };
      
      // If the buffer is just whitespace, opening/closing bracket or a comma, ignore it
      if (!buffer.trim() || buffer.trim() === '[' || buffer.trim() === ']' || buffer.trim() === ',') {
        // If it's a closing bracket, signal completion
        if (buffer.trim() === ']') {
          console.log('End of Gemini response detected (closing bracket)');
          result.complete = true;
        }
        return result;
      }
      
      // Extract text content from JSON response
      if (buffer.includes('"text"')) {
        try {
          // Parse the JSON to extract the text directly
          const data = JSON.parse(buffer.replace('data: ', ''));
          if (data.candidates && data.candidates[0]?.content?.parts) {
            for (const part of data.candidates[0].content.parts) {
              if (part.text) {
                console.log('Extracted text:', part.text);
                result.content.push(part.text);
              }
            }
          }
        } catch (jsonError) {
          // Fallback to regex if JSON parsing fails
          const textMatches = buffer.match(/"text":\s*"([^"]*)"/g);
          if (textMatches) {
            for (const match of textMatches) {
              // Extract the actual text content from the match
              const textContent = match.replace(/"text":\s*"/, '').replace(/"$/, '');
              console.log('Extracted text (regex fallback):', textContent);
              result.content.push(textContent);
            }
          }
        }
      }
      
      // Check if we have a finishReason in this buffer, which indicates completion
      const isComplete = buffer.includes('"finishReason": "STOP"') || buffer.includes('"finishReason":"STOP"');
      if (isComplete) {
        result.complete = true;
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