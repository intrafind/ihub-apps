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
      ? `${model.url}?key=${apiKey}`
      : `https://generativelanguage.googleapis.com/v1beta/models/${model.modelId}:generateContent?key=${apiKey}`;
    
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
    
    console.log('Request URL:', url);
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
  processResponseBuffer(buffer, res) {
    console.log('Processing buffer:', buffer);
    try {
      // The Gemini response format in stream mode is a JSON array with multiple objects
      
      // Skip processing empty buffers or just commas (array separators)
      if (!buffer.trim() || buffer.trim() === ',') {
        return;
      }
      
      // Clean up the buffer - handle the specific format Gemini returns
      let cleanBuffer = buffer;
      
      // Handle the case where we get the opening bracket of the array
      if (cleanBuffer.trim() === '[') {
        return; // Skip just the array opening
      }
      
      // Handle the case where we get the closing bracket of the array
      if (cleanBuffer.trim() === ']') {
        // This is the end of the response, send the done event
        console.log('End of Gemini response (closing bracket found)');
        sendSSE(res, 'done', {});
        return;
      }
      
      // Try to parse the buffer as JSON
      let jsonObject;
      try {
        // Strip trailing commas which would make the JSON invalid
        if (cleanBuffer.trim().endsWith(',')) {
          cleanBuffer = cleanBuffer.trim().slice(0, -1);
        }
        
        jsonObject = JSON.parse(cleanBuffer);
      } catch (parseError) {
        console.log(`JSON parse error: ${parseError.message}`);
        // If we can't parse as JSON, check if it might be part of a chunked response
        return;
      }
      
      // Process the JSON object to extract any content
      if (jsonObject && jsonObject.candidates && jsonObject.candidates.length > 0) {
        const candidate = jsonObject.candidates[0];
        
        if (candidate.content && candidate.content.parts && candidate.content.parts.length > 0) {
          // Extract the text from each part
          for (const part of candidate.content.parts) {
            if (part.text) {
              console.log('Sending chunk to client:', part.text);
              sendSSE(res, 'chunk', { content: part.text });
            }
          }
          
          // If we have a finish reason, this is the last chunk
          if (candidate.finishReason === 'STOP') {
            console.log('Response complete, finishReason:', candidate.finishReason);
            // Don't send the done event here, as we'll get the closing bracket later
          }
        }
      }
    } catch (error) {
      console.error('Error processing Gemini response:', error);
      // Send error to client so they know something went wrong
      sendSSE(res, 'error', { message: `Error processing model response: ${error.message}` });
    }
  }
};

export default GoogleAdapter;