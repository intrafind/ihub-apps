/**
 * Anthropic API adapter
 */
import { convertToolsFromGeneric } from './toolCalling/index.js';
import { BaseAdapter } from './BaseAdapter.js';
import logger from '../utils/logger.js';

/** Basic web search — accepted by every Claude model and by Vertex AI / Foundry. */
export const ANTHROPIC_WEB_SEARCH_DEFAULT_VERSION = 'web_search_20250305';
export const ANTHROPIC_WEB_SEARCH_VERSIONS = [
  'web_search_20250305',
  'web_search_20260209',
  'web_search_20260318'
];

/**
 * Build Anthropic's server-side web search tool block for one request.
 *
 * The tool version comes from the model config (`nativeWebSearch.toolVersion`,
 * default basic). `web_search_20260209` and later default `allowed_callers` to
 * code execution (dynamic filtering) — a 400 on models without programmatic
 * tool calling and on Vertex AI / Azure-hosted Foundry — so the block pins
 * direct calls unless the admin opted into dynamic filtering for the model.
 * `max_uses` caps the billable searches for the call.
 * See https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
 *
 * @param {Object} model - model config
 * @param {{maxUses?: number}|null} directive - native web search directive
 * @returns {Object} Anthropic tool block
 */
export function buildAnthropicWebSearchTool(model, directive) {
  const config = model?.nativeWebSearch || {};
  const type = ANTHROPIC_WEB_SEARCH_VERSIONS.includes(config.toolVersion)
    ? config.toolVersion
    : ANTHROPIC_WEB_SEARCH_DEFAULT_VERSION;
  const tool = { type, name: 'web_search' };
  if (Number.isInteger(directive?.maxUses) && directive.maxUses > 0) {
    tool.max_uses = directive.maxUses;
  }
  if (type !== ANTHROPIC_WEB_SEARCH_DEFAULT_VERSION && config.dynamicFiltering !== true) {
    tool.allowed_callers = ['direct'];
  }
  return tool;
}

class AnthropicAdapterClass extends BaseAdapter {
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
        const toolContent = [];

        // If tool message contains imageData, prioritize the image for vision analysis
        if (this.hasImageData(msg)) {
          logger.info('Processing image from tool message', {
            component: 'AnthropicAdapter'
          });

          // Add simple tool result acknowledgment
          toolContent.push({
            type: 'tool_result',
            tool_use_id: msg.tool_call_id,
            content: msg.content, // Already simplified by the tool loop
            is_error: msg.is_error || false
          });

          // Handle multiple images
          if (Array.isArray(msg.imageData)) {
            msg.imageData
              .filter(img => img && img.base64)
              .forEach(img => {
                toolContent.push({
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: img.format || img.fileType || 'image/jpeg',
                    data: this.cleanBase64Data(img.base64)
                  }
                });
              });
          } else {
            // Handle single image (legacy behavior)
            toolContent.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: msg.imageData.format || 'image/jpeg',
                data: this.cleanBase64Data(msg.imageData.base64)
              }
            });
          }
        } else {
          // Regular tool result without images
          toolContent.push({
            type: 'tool_result',
            tool_use_id: msg.tool_call_id,
            content: msg.content,
            is_error: msg.is_error || false
          });
        }

        processedMessages.push({
          role: 'user',
          content: toolContent
        });
      } else if (
        msg.role === 'assistant' &&
        msg.providerContent?.provider === 'anthropic' &&
        Array.isArray(msg.providerContent.blocks)
      ) {
        // A turn Anthropic paused (`stop_reason: pause_turn`) is continued by
        // replaying the assistant content blocks exactly as received —
        // server_tool_use / web_search_tool_result blocks and their encrypted
        // payloads included. Flattened text would be an assistant prefill,
        // which current models reject.
        processedMessages.push({ role: 'assistant', content: msg.providerContent.blocks });
      } else if (msg.role === 'assistant' && msg.tool_calls) {
        const content = [];
        if (msg.content) {
          content.push({ type: 'text', text: msg.content });
        }
        for (const toolCall of msg.tool_calls) {
          let args = {};
          args = this.safeJsonParse(toolCall.function.arguments, {});
          content.push({
            type: 'tool_use',
            id: toolCall.id,
            name: toolCall.function.name,
            input: args
          });
        }
        processedMessages.push({ role: 'assistant', content });
      } else if (this.hasImageData(msg)) {
        const contentArray = [];
        if (msg.content && msg.content.trim()) {
          contentArray.push({
            type: 'text',
            text: msg.content
          });
        }

        // Handle multiple images
        if (Array.isArray(msg.imageData)) {
          msg.imageData
            .filter(img => img && img.base64)
            .forEach(img => {
              contentArray.push({
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: img.fileType || 'image/jpeg',
                  data: this.cleanBase64Data(img.base64)
                }
              });
            });
        } else {
          // Handle single image (legacy behavior)
          contentArray.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: msg.imageData.fileType || 'image/jpeg',
              data: this.cleanBase64Data(msg.imageData.base64)
            }
          });
        }

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
    this.debugLogMessages(messages, processedMessages, 'Anthropic');

    return {
      messages: processedMessages,
      systemPrompt: systemMessage?.content || ''
    };
  }

  /**
   * Create a completion request for Anthropic
   */
  async createCompletionRequest(model, messages, apiKey, options = {}) {
    const { temperature, stream, maxTokens, tools, responseSchema, nativeWebSearch } =
      this.extractRequestOptions(options);

    // Format messages and extract system prompt
    let { messages: formattedMessages, systemPrompt } = this.formatMessages(messages);

    // Note: We don't throw an error here for missing API keys
    // Instead we let the server's verifyApiKey function handle this consistently
    // This ensures proper localization of error messages

    const requestBody = {
      model: model.modelId,
      messages: formattedMessages,
      stream,
      max_tokens: maxTokens
    };

    // Sampling parameters were removed from Anthropic's newer reasoning models
    // (Claude Opus 5, Sonnet 5, Fable 5.x, Opus 4.7/4.8): sending `temperature`
    // returns a 400 and the whole request fails. Model configs opt out with
    // `supportsTemperature: false`; everything else keeps sending it.
    if (model.supportsTemperature !== false) {
      const parsedTemperature = parseFloat(temperature);
      if (Number.isFinite(parsedTemperature)) {
        requestBody.temperature = parsedTemperature;
      }
    }

    let finalTools = tools ? [...tools] : [];
    if (responseSchema) {
      finalTools.push({
        id: 'json',
        name: 'json',
        description: 'Respond with a JSON object.',
        parameters: responseSchema
      });
      requestBody.tool_choice = { type: 'tool', name: 'json' };
    }

    const anthropicTools =
      finalTools.length > 0 ? convertToolsFromGeneric(finalTools, 'anthropic') : [];

    // Anthropic's server-side web search tool. Unlike Google, Anthropic allows
    // combining it with client-defined function tools in the same request, so
    // it's simply prepended rather than gated on finalTools being empty.
    if (nativeWebSearch?.provider === 'anthropic') {
      anthropicTools.unshift(buildAnthropicWebSearchTool(model, nativeWebSearch));
    }

    if (anthropicTools.length > 0) {
      requestBody.tools = anthropicTools;
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

    if (options.promptCache) applyCacheBreakpoints(requestBody);

    // Note: Request body logging disabled to prevent exposing sensitive data in logs
    // logger.info('Anthropic request body:', JSON.stringify(requestBody, null, 2));

    return {
      url: model.url,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey || '', // Anthropic uses x-api-key instead of Authorization
        'anthropic-version': '2023-06-01' // TODO check if still accurate
      },
      body: requestBody
    };
  }
}

/** 5-minute cache (Anthropic's default TTL); writes cost 1.25x input, reads 0.1x. */
const EPHEMERAL = Object.freeze({ type: 'ephemeral' });

/** Content blocks that accept `cache_control` in a user message. */
const CACHEABLE_BLOCKS = new Set(['text', 'image', 'document', 'tool_result', 'tool_use']);

/**
 * Mark what Anthropic may cache, in prompt order (tools → system → messages),
 * with three of the four breakpoints a request may carry:
 *
 * 1. the last tool definition — caches every tool;
 * 2. the end of the system prompt — survives changes further down;
 * 3. the last block of the latest user message — a moving breakpoint: the next
 *    turn of the conversation finds this one within Anthropic's look-back and
 *    reads everything before it from the cache.
 *
 * A prefix below the model's minimum cacheable length is simply not cached;
 * Anthropic neither fails the request nor charges a write for it.
 *
 * @param {Object} body - Messages API request body (mutated)
 */
export function applyCacheBreakpoints(body) {
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    const last = body.tools.length - 1;
    body.tools[last] = { ...body.tools[last], cache_control: EPHEMERAL };
  }

  if (typeof body.system === 'string' && body.system.trim()) {
    body.system = [{ type: 'text', text: body.system, cache_control: EPHEMERAL }];
  }

  const lastMessage = body.messages?.[body.messages.length - 1];
  if (lastMessage?.role !== 'user') return;
  if (typeof lastMessage.content === 'string') {
    if (lastMessage.content.trim()) {
      body.messages[body.messages.length - 1] = {
        ...lastMessage,
        content: [{ type: 'text', text: lastMessage.content, cache_control: EPHEMERAL }]
      };
    }
    return;
  }
  if (Array.isArray(lastMessage.content) && lastMessage.content.length > 0) {
    const blocks = [...lastMessage.content];
    const i = blocks.length - 1;
    const block = blocks[i];
    if (!CACHEABLE_BLOCKS.has(block?.type)) return;
    if (block.type === 'text' && !block.text?.trim()) return;
    blocks[i] = { ...block, cache_control: EPHEMERAL };
    body.messages[body.messages.length - 1] = { ...lastMessage, content: blocks };
  }
}

const AnthropicAdapter = new AnthropicAdapterClass();
export default AnthropicAdapter;
