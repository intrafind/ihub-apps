/**
 * Anthropic Tool Calling Converter
 *
 * Handles bidirectional conversion between Anthropic's tool calling format
 * and the generic tool calling format.
 */

import {
  createGenericTool,
  createGenericToolCall,
  createGenericStreamingResponse,
  normalizeFinishReason,
  sanitizeSchemaForProvider
} from './GenericToolCalling.js';
import { validateProviderToolName } from './toolNameValidator.js';
import logger from '../../utils/logger.js';
import { parseJsonAsync } from '../../utils/asyncJson.js';

/**
 * Convert generic tools to Anthropic format
 * Anthropic requires tool names to match pattern ^[a-zA-Z0-9_-]{1,128}$
 * Filters out provider-specific special tools (googleSearch, webSearch, etc.) —
 * Anthropic's own native web search tool is injected directly by the adapter
 * (see anthropic.js), not routed through this generic tool-calling pipeline.
 * @param {import('./GenericToolCalling.js').GenericTool[]} genericTools - Generic tools
 * @returns {Object[]} Anthropic formatted tools
 */
export function convertGenericToolsToAnthropic(genericTools = []) {
  const filteredTools = genericTools.filter(tool => {
    // If tool specifies this provider, always include it
    if (tool.provider === 'anthropic') {
      return true;
    }
    // If tool specifies a different provider, exclude it
    if (tool.provider) {
      logger.info('Filtering out provider-specific tool', {
        component: 'AnthropicConverter',
        toolId: tool.id || tool.name,
        provider: tool.provider
      });
      return false;
    }
    // If tool is marked as special but has no matching provider, exclude it
    if (tool.isSpecialTool) {
      logger.info('Filtering out special tool', {
        component: 'AnthropicConverter',
        toolId: tool.id || tool.name
      });
      return false;
    }
    // Universal tool - include it
    return true;
  });

  return filteredTools.map(tool => ({
    name: tool.id || tool.name,
    description: tool.description,
    input_schema: sanitizeSchemaForProvider(tool.parameters, 'anthropic')
  }));
}

/**
 * Convert Anthropic tools to generic format
 * @param {Object[]} anthropicTools - Anthropic formatted tools
 * @returns {import('./GenericToolCalling.js').GenericTool[]} Generic tools
 */
export function convertAnthropicToolsToGeneric(anthropicTools = []) {
  return anthropicTools.map(tool =>
    createGenericTool(
      tool.name, // Use name as ID
      tool.name,
      tool.description || '',
      tool.input_schema || { type: 'object', properties: {} },
      { originalFormat: 'anthropic' }
    )
  );
}

/**
 * Convert generic tool calls to Anthropic format (for message content)
 * @param {import('./GenericToolCalling.js').GenericToolCall[]} genericToolCalls - Generic tool calls
 * @returns {Object[]} Anthropic formatted tool use content blocks
 */
export function convertGenericToolCallsToAnthropic(genericToolCalls = []) {
  return genericToolCalls.map(toolCall => ({
    type: 'tool_use',
    id: toolCall.id,
    name: toolCall.name,
    input: toolCall.arguments
  }));
}

/**
 * Convert Anthropic tool use blocks to generic format
 * @param {Object[]} anthropicToolUse - Anthropic tool use content blocks
 * @returns {import('./GenericToolCalling.js').GenericToolCall[]} Generic tool calls
 */
export function convertAnthropicToolUseToGeneric(anthropicToolUse = []) {
  return anthropicToolUse
    .map((toolUse, index) => {
      if (!validateProviderToolName({ name: toolUse.name, provider: 'Anthropic', log: logger })) {
        return null;
      }
      return createGenericToolCall(toolUse.id, toolUse.name, toolUse.input || {}, index, {
        originalFormat: 'anthropic',
        type: 'tool_use'
      });
    })
    .filter(Boolean);
}

/**
 * Convert generic tool result to Anthropic format
 * @param {import('./GenericToolCalling.js').GenericToolResult} genericResult - Generic tool result
 * @returns {Object} Anthropic formatted tool result content block
 */
export function convertGenericToolResultToAnthropic(genericResult) {
  return {
    type: 'tool_result',
    tool_use_id: genericResult.tool_call_id,
    content:
      typeof genericResult.content === 'string'
        ? genericResult.content
        : JSON.stringify(genericResult.content),
    is_error: genericResult.is_error || false
  };
}

/**
 * Convert Anthropic tool result to generic format
 * @param {Object} anthropicResult - Anthropic tool result content block
 * @returns {import('./GenericToolCalling.js').GenericToolResult} Generic tool result
 */
export function convertAnthropicToolResultToGeneric(anthropicResult) {
  let content = anthropicResult.content;

  // Try to parse JSON content
  if (typeof content === 'string' && !anthropicResult.is_error) {
    try {
      content = JSON.parse(content);
    } catch {
      // Keep as string if not valid JSON
    }
  }

  return {
    tool_call_id: anthropicResult.tool_use_id,
    name: anthropicResult.name || 'unknown',
    content,
    is_error: anthropicResult.is_error || false,
    metadata: { originalFormat: 'anthropic' }
  };
}

/**
 * Convert Anthropic streaming response to generic format
 * @param {string} data - Raw Anthropic response data
 * @returns {import('./GenericToolCalling.js').GenericStreamingResponse} Generic streaming response
 */
// Store state across streaming chunks for proper handling
const streamingState = new Map();

/**
 * Record native web search results/citations on the generic result object.
 * Mirrors the groundingMetadata convention used for Google Search grounding
 * so the chat pipeline surfaces a 'grounding' knowledge source badge.
 * @param {import('./GenericToolCalling.js').GenericStreamingResponse} result
 * @returns {{searchResults: Object[], citations: Object[]}}
 */
function ensureWebSearchMetadata(result) {
  if (!result.groundingMetadata) {
    result.groundingMetadata = { searchResults: [], citations: [] };
  }
  return result.groundingMetadata;
}

/**
 * Handle a web_search_tool_result content block's `content` field, which is
 * either an array of web_search_result items or a single
 * web_search_tool_result_error object.
 */
function addWebSearchResult(result, content) {
  const metadata = ensureWebSearchMetadata(result);
  if (Array.isArray(content)) {
    metadata.searchResults.push(...content);
  } else if (content?.type === 'web_search_tool_result_error') {
    logger.warn('Anthropic web search returned an error', {
      component: 'AnthropicConverter',
      errorCode: content.error_code
    });
  }
}

function addWebSearchCitations(result, citations) {
  ensureWebSearchMetadata(result).citations.push(...citations);
}

/**
 * Map Anthropic's usage object onto the generic shape.
 * `server_tool_use.web_search_requests` is the billable search count of the
 * response (cumulative on streaming `message_delta` frames).
 */
function toGenericUsage(usage, { includeInput = true } = {}) {
  const promptTokens = includeInput ? usage.input_tokens || 0 : 0;
  const completionTokens = usage.output_tokens || 0;
  const generic = { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
  const searches = usage.server_tool_use?.web_search_requests;
  if (Number.isInteger(searches) && searches >= 0) generic.webSearchRequests = searches;
  return generic;
}

/**
 * Mirror the assistant content blocks of a streamed message, block by block,
 * so a turn the API pauses (`stop_reason: pause_turn`) can be replayed
 * verbatim — server_tool_use / web_search_tool_result blocks and their
 * encrypted payloads included — on the continuation request.
 */
function trackRawBlock(state, parsed) {
  const index = parsed.index;
  if (parsed.type === 'content_block_start' && parsed.content_block) {
    const block = JSON.parse(JSON.stringify(parsed.content_block));
    if (block.type === 'text' && typeof block.text !== 'string') block.text = '';
    if (block.type === 'tool_use' || block.type === 'server_tool_use') {
      block.input = block.input || {};
      state.rawJson[index] = '';
    }
    state.rawBlocks[index] = block;
    return;
  }
  const block = state.rawBlocks[index];
  if (!block) return;
  if (parsed.type === 'content_block_delta' && parsed.delta) {
    const delta = parsed.delta;
    switch (delta.type) {
      case 'text_delta':
        block.text = (block.text || '') + (delta.text || '');
        break;
      case 'citations_delta':
        if (delta.citation) block.citations = [...(block.citations || []), delta.citation];
        break;
      case 'input_json_delta':
        state.rawJson[index] = (state.rawJson[index] || '') + (delta.partial_json || '');
        break;
      case 'thinking_delta':
        block.thinking = (block.thinking || '') + (delta.thinking || '');
        break;
      case 'signature_delta':
        block.signature = delta.signature;
        break;
      default:
        break;
    }
    return;
  }
  if (parsed.type === 'content_block_stop') {
    const json = state.rawJson[index];
    if (typeof json === 'string' && json.length > 0) {
      try {
        block.input = JSON.parse(json);
      } catch {
        // keep the input the block started with
      }
    }
    delete state.rawJson[index];
  }
}

/** Blocks the API accepts back: drops gaps and text blocks that stayed empty. */
function replayableBlocks(blocks) {
  return (Array.isArray(blocks) ? blocks : []).filter(
    block => block && !(block.type === 'text' && !block.text)
  );
}

export async function convertAnthropicResponseToGeneric(data, streamId = 'default') {
  const result = createGenericStreamingResponse();

  // Get or create state for this stream
  if (!streamingState.has(streamId)) {
    streamingState.set(streamId, {
      finishReason: null,
      pendingToolCall: null,
      toolCallIndex: 0,
      // Verbatim copy of the message's content blocks, for pause_turn replay.
      rawBlocks: [],
      rawJson: {}
    });
  }
  const state = streamingState.get(streamId);

  if (!data) return result;

  try {
    const parsed = await parseJsonAsync(data);

    if (typeof parsed.type === 'string' && parsed.type.startsWith('content_block')) {
      trackRawBlock(state, parsed);
    }

    // Extract usage from message_start (input tokens)
    if (parsed.type === 'message_start' && parsed.message?.usage) {
      result.metadata.usage = toGenericUsage(parsed.message.usage);
    }

    // Extract usage from message_delta (final output token count plus the
    // cumulative server-tool counters)
    if (parsed.type === 'message_delta' && parsed.usage) {
      result.metadata.usage = toGenericUsage(parsed.usage, { includeInput: false });
    }

    // Extract usage from non-streaming full response
    if (parsed.usage && (!parsed.type || parsed.type === 'message')) {
      result.metadata.usage = toGenericUsage(parsed.usage);
    }

    // Handle full response object (non-streaming)
    if (parsed.content && Array.isArray(parsed.content)) {
      for (const contentBlock of parsed.content) {
        if (contentBlock.type === 'text' && contentBlock.text) {
          result.content.push(contentBlock.text);
          if (Array.isArray(contentBlock.citations) && contentBlock.citations.length > 0) {
            addWebSearchCitations(result, contentBlock.citations);
          }
        } else if (contentBlock.type === 'tool_use') {
          if (
            validateProviderToolName({
              name: contentBlock.name,
              provider: 'Anthropic',
              log: logger,
              result
            })
          ) {
            result.tool_calls.push(
              createGenericToolCall(
                contentBlock.id,
                contentBlock.name,
                contentBlock.input || {},
                result.tool_calls.length,
                { originalFormat: 'anthropic', type: 'tool_use' }
              )
            );
          }
        } else if (contentBlock.type === 'web_search_tool_result') {
          addWebSearchResult(result, contentBlock.content);
        }
        // 'server_tool_use' blocks just record the search query Claude issued
        // server-side; there is nothing for the client to execute.
      }
      result.complete = true;
      if (parsed.stop_reason) {
        result.finishReason = normalizeFinishReason(parsed.stop_reason, 'anthropic');
      }
      if (parsed.stop_reason === 'pause_turn') {
        result.metadata.pausedAssistantContent = replayableBlocks(parsed.content);
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
        // Store the finish reason in state so we can use it when message_stop arrives
        state.finishReason = normalizeFinishReason(parsed.delta.stop_reason, 'anthropic');
        result.finishReason = state.finishReason;
      }
    }

    // Tool streaming events
    if (parsed.type === 'content_block_start' && parsed.content_block?.type === 'tool_use') {
      // Store the tool call info in state for later when we have complete arguments
      state.pendingToolCall = {
        id: parsed.content_block.id,
        name: parsed.content_block.name,
        index: parsed.index,
        arguments: ''
      };
      // Track if this is the first tool call
      if (!state.toolCallIndex) {
        state.toolCallIndex = 0;
      }
    } else if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'input_json_delta') {
      // Accumulate arguments in state
      if (state.pendingToolCall && parsed.delta.partial_json) {
        state.pendingToolCall.arguments += parsed.delta.partial_json;
      }
    } else if (parsed.type === 'content_block_stop' && state.pendingToolCall) {
      // Now we have the complete tool call with all arguments
      const toolCall = state.pendingToolCall;
      let parsedArgs = {};
      try {
        parsedArgs = JSON.parse(toolCall.arguments);
      } catch (error) {
        logger.warn('Failed to parse tool arguments', {
          component: 'AnthropicConverter',
          error
        });
        parsedArgs = { __raw_arguments: toolCall.arguments };
      }

      if (
        validateProviderToolName({
          name: toolCall.name,
          provider: 'Anthropic',
          log: logger,
          result
        })
      ) {
        result.tool_calls.push(
          createGenericToolCall(
            toolCall.id,
            toolCall.name,
            parsedArgs,
            state.toolCallIndex++, // Use our own index counter starting at 0
            {
              originalFormat: 'anthropic',
              type: 'tool_use'
            }
          )
        );
      }

      // Clear the pending tool call from state
      state.pendingToolCall = null;
    } else if (
      parsed.type === 'content_block_start' &&
      parsed.content_block?.type === 'web_search_tool_result'
    ) {
      // The full result set (or error) arrives in one shot at content_block_start,
      // not via deltas.
      addWebSearchResult(result, parsed.content_block.content);
    } else if (
      parsed.type === 'content_block_delta' &&
      parsed.delta?.type === 'citations_delta' &&
      parsed.delta.citation
    ) {
      addWebSearchCitations(result, [parsed.delta.citation]);
    }

    if (parsed.type === 'message_stop') {
      result.complete = true;
      // Use the finish reason from state (set by message_delta)
      result.finishReason = state.finishReason || 'stop';
      if (result.finishReason === 'pause_turn') {
        // Hand the mirrored assistant blocks to LLMClient so it can replay the
        // paused turn verbatim on the continuation request.
        result.metadata.pausedAssistantContent = replayableBlocks(state.rawBlocks);
      }

      // Clean up the state for this stream
      streamingState.delete(streamId);
    }
  } catch (parseError) {
    logger.error('Error parsing Anthropic response chunk', {
      component: 'AnthropicConverter',
      error: parseError
    });
    result.error = true;
    result.errorMessage = `Error parsing Anthropic response: ${parseError.message}`;
  }

  return result;
}

/**
 * Discard accumulated streaming state for a stream that errored or was aborted,
 * so a stale pending tool call can't leak into a later, unrelated stream.
 * @param {string} streamId - Stream identifier to clear
 */
export function clearAnthropicStreamingState(streamId = 'default') {
  streamingState.delete(streamId);
}

/**
 * Convert generic streaming response to Anthropic format
 * Note: This is primarily for testing/debugging as we typically don't need to convert back to Anthropic format
 * @param {import('./GenericToolCalling.js').GenericStreamingResponse} genericResponse - Generic response
 * @returns {Object} Anthropic formatted response (simplified)
 */
export function convertGenericResponseToAnthropic(genericResponse) {
  const content = [];

  // Add text content
  if (genericResponse.content && genericResponse.content.length > 0) {
    const textContent = genericResponse.content.join('');
    if (textContent) {
      content.push({
        type: 'text',
        text: textContent
      });
    }
  }

  // Add tool use blocks
  if (genericResponse.tool_calls && genericResponse.tool_calls.length > 0) {
    for (const toolCall of genericResponse.tool_calls) {
      content.push({
        type: 'tool_use',
        id: toolCall.id,
        name: toolCall.name,
        input: toolCall.arguments
      });
    }
  }

  const response = {
    id: `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content,
    model: 'claude',
    stop_reason:
      genericResponse.finishReason === 'tool_calls'
        ? 'tool_use'
        : genericResponse.finishReason === 'stop'
          ? 'end_turn'
          : genericResponse.finishReason,
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0
    }
  };

  return response;
}

/**
 * Process message content for Anthropic format, handling tool calls and results
 * @param {Object} message - Message with potential tool calls or results
 * @returns {Object} Processed message for Anthropic API
 */
export function processMessageForAnthropic(message) {
  if (message.role === 'tool') {
    // Convert tool result to Anthropic format
    return {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: message.tool_call_id,
          content:
            typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
          is_error: message.is_error || false
        }
      ]
    };
  } else if (message.role === 'assistant' && message.tool_calls) {
    // Convert assistant message with tool calls
    const content = [];

    if (message.content) {
      content.push({ type: 'text', text: message.content });
    }

    for (const toolCall of message.tool_calls) {
      let args = {};
      try {
        args =
          typeof toolCall.function.arguments === 'string'
            ? JSON.parse(toolCall.function.arguments)
            : toolCall.function.arguments;
      } catch (error) {
        logger.warn('Failed to parse tool call arguments', {
          component: 'AnthropicConverter',
          error
        });
        args = {};
      }

      content.push({
        type: 'tool_use',
        id: toolCall.id,
        name: toolCall.function.name,
        input: args
      });
    }

    return { role: 'assistant', content };
  }

  // Return message as-is for other cases
  return message;
}
