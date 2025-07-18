/**
 * Anthropic API adapter
 */
import { formatToolsForAnthropic } from './toolFormatter.js';

const AnthropicAdapter = {
  /**
   * Format messages for Anthropic API, including handling image data
   */
  formatMessages(messages) {
    // Extract system message and filter it out from the messages array
    // Anthropic expects system messages as a separate parameter
    const systemMessage = messages.find(msg => msg.role === 'system');
    const filteredMessages = messages.filter(msg => msg.role !== 'system');

    const processedMessages = [];
    for (const msg of filteredMessages) {
      if (msg.role === 'tool') {
        // let toolContent;
        // try {
        //   toolContent = JSON.parse(msg.content);
        // } catch {
        //   toolContent = msg.content;
        // }
        processedMessages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: msg.tool_call_id,
              //content: toolContent
              content: msg.content, // Pass the content directly as a string
              is_error: msg.is_error || false
            }
          ]
        });
      } else if (msg.role === 'assistant' && msg.tool_calls) {
        const content = [];
        if (msg.content) {
          content.push({ type: 'text', text: msg.content });
        }
        for (const toolCall of msg.tool_calls) {
          let args = {};
          try {
            args = JSON.parse(toolCall.function.arguments);
          } catch (e) {
            // ignore if already an object
            if (typeof toolCall.function.arguments === 'object') {
              args = toolCall.function.arguments;
            }
          }
          content.push({
            type: 'tool_use',
            id: toolCall.id,
            name: toolCall.function.name,
            input: args
          });
        }
        processedMessages.push({ role: 'assistant', content });
      } else if (msg.imageData) {
        const contentArray = [];
        if (msg.content && msg.content.trim()) {
          contentArray.push({
            type: 'text',
            text: msg.content
          });
        }
        contentArray.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: msg.imageData.fileType || 'image/jpeg',
            data: msg.imageData.base64.replace(/^data:image\/[a-z]+;base64,/, '')
          }
        });
        processedMessages.push({
          role: msg.role,
          content: contentArray
        });
      } else {
        processedMessages.push({
          role: msg.role,
          content: msg.content
        });
      }
    }

    // Debug logs
    console.log(
      'Original messages:',
      JSON.stringify(messages.map(m => ({ role: m.role, hasImage: !!m.imageData })))
    );
    console.log(
      'Processed Anthropic messages:',
      JSON.stringify(
        processedMessages.map(m => ({
          role: m.role,
          contentType: Array.isArray(m.content) ? 'array' : 'string',
          contentItems: Array.isArray(m.content) ? m.content.map(c => c.type) : null
        }))
      )
    );

    return {
      messages: processedMessages,
      systemPrompt: systemMessage?.content || ''
    };
  },

  /**
   * Create a completion request for Anthropic
   */
  createCompletionRequest(model, messages, apiKey, options = {}) {
    const {
      temperature = 0.7,
      stream = true,
      maxTokens = 1024,
      tools = null,
      responseFormat = null,
      responseSchema = null
    } = options;

    // Format messages and extract system prompt
    let { messages: formattedMessages, systemPrompt } = this.formatMessages(messages);

    // Note: We don't throw an error here for missing API keys
    // Instead we let the server's verifyApiKey function handle this consistently
    // This ensures proper localization of error messages

    const requestBody = {
      model: model.modelId,
      messages: formattedMessages,
      stream,
      temperature: parseFloat(temperature),
      max_tokens: maxTokens
    };

    let finalTools = tools ? [...tools] : [];
    if (responseSchema) {
      finalTools.push({
        name: 'json',
        description: 'Respond with a JSON object.',
        parameters: responseSchema
      });
      requestBody.tool_choice = { type: 'tool', name: 'json' };
    }

    if (finalTools.length > 0) {
      requestBody.tools = formatToolsForAnthropic(finalTools);
      // // Anthropic-specific instruction to encourage tool use, especially in multi-turn scenarios.
      // const toolInstruction =
      //   "If you need to use a tool to answer, please do so. After using the tools, provide a final answer to the user's question.";
      // if (systemPrompt) {
        //   if (!systemPrompt.includes(toolInstruction)) {
          //     systemPrompt += `\n\n${toolInstruction}`;
          //   }
          // } else {
            // systemPrompt = toolInstruction;
      // }
    }

    // if (responseSchema) {
    //   // When using a tool for structured output, omit response_format
    // } else if (responseFormat && responseFormat === 'json') {
    //   requestBody.response_format = 'json';
    // }

    // Only add system parameter if we have a system message
    if (systemPrompt) {
      requestBody.system = systemPrompt;
    }

    console.log('Anthropic request body:', requestBody);

    return {
      url: model.url,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey || '', // Provide empty string to avoid undefined
        'anthropic-version': '2023-06-01' // TODO check if still accurate
      },
      body: requestBody
    };
  },

  /**
   * Process streaming response from Anthropic
   */
  processResponseBuffer(data) {
    const result = {
      content: [],
      tool_calls: [],
      complete: false,
      error: false,
      errorMessage: null,
      finishReason: null
    };

    if (!data) return result;
    try {
      const parsed = JSON.parse(data);
      console.log('--- Anthropic Raw Chunk ---');
      console.log(JSON.stringify(parsed, null, 2));
      console.log('--------------------------');

      // Handle full response object (non-streaming)
      if (parsed.content && Array.isArray(parsed.content) && parsed.content[0]?.text) {
        result.content.push(parsed.content[0].text);
        result.complete = true;
        if (parsed.stop_reason) {
          result.finishReason = parsed.stop_reason === 'end_turn' ? 'stop' : parsed.stop_reason;
        }
      }
      // Handle streaming content deltas
      else if (parsed.type === 'content_block_delta' && parsed.delta && parsed.delta.text) {
        result.content.push(parsed.delta.text);
      } else if (parsed.type === 'message_delta' && parsed.delta) {
        if (parsed.delta.content) {
          result.content.push(parsed.delta.content);
        }
        if (parsed.delta.stop_reason) {
          result.finishReason =
            parsed.delta.stop_reason === 'tool_use' ? 'tool_calls' : parsed.delta.stop_reason;
        }
      }

      // Tool streaming events
      if (parsed.type === 'content_block_start' && parsed.content_block?.type === 'tool_use') {
        result.tool_calls.push({
          index: parsed.index,
          id: parsed.content_block.id,
          type: 'function',
          function: {
            name: parsed.content_block.name,
            arguments: ''
          }
        });
      } else if (
        parsed.type === 'content_block_delta' &&
        parsed.delta?.type === 'input_json_delta'
      ) {
        // Pass partial tool call chunks to ToolExecutor for merging
        result.tool_calls.push({
          index: parsed.index,
          function: {
            arguments: parsed.delta.partial_json || ''
          }
        });
      }

      if (parsed.type === 'message_stop') {
        result.complete = true;
        // The finishReason is provided in the 'message_delta' event, not here.
        // By not setting a finishReason, we avoid overwriting the correct 'tool_calls' reason
        // that was already processed by the ToolExecutor.
      }
    } catch (parseError) {
      console.error('Error parsing Claude response chunk:', parseError);
      result.error = true;
      result.errorMessage = `Error parsing Claude response: ${parseError.message}`;
    }

    return result;
  }
};

export default AnthropicAdapter;
