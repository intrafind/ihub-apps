import { ResponseChunk, ResponseChoiceDelta, ResponseDelta, Usage } from '../core/Response.js';
import { ToolCall } from '../core/Message.js';
import { ProviderError } from '../utils/ErrorHandler.js';

/**
 * Streaming parser for different provider formats
 */
export class StreamingParser {
  constructor(logger) {
    this.logger = logger;
  }

  /**
   * Parse streaming chunk for OpenAI-compatible providers (OpenAI, VLLM)
   * @param {Object} chunk - Raw chunk data
   * @param {Object} originalRequest - Original request context
   * @returns {ResponseChunk|null} Parsed response chunk
   */
  parseOpenAIChunk(chunk, originalRequest) {
    if (!chunk.choices || chunk.choices.length === 0) return null;

    const choice = chunk.choices[0];
    const delta = choice.delta || {};

    const responseDelta = new ResponseDelta(
      delta.content || '',
      delta.tool_calls ? this.parseOpenAIStreamToolCalls(delta.tool_calls) : null,
      delta.role
    );

    const choiceDelta = new ResponseChoiceDelta(
      choice.index || 0,
      responseDelta,
      this.normalizeFinishReason(choice.finish_reason)
    );

    const usage = chunk.usage
      ? new Usage(
          chunk.usage.prompt_tokens,
          chunk.usage.completion_tokens,
          chunk.usage.total_tokens
        )
      : null;

    return new ResponseChunk({
      id: chunk.id,
      model: originalRequest.model,
      provider: originalRequest.provider || 'openai',
      choices: [choiceDelta],
      usage,
      done: !!choice.finish_reason,
      metadata: {
        created: chunk.created,
        systemFingerprint: chunk.system_fingerprint
      }
    });
  }

  /**
   * Parse streaming chunk for Anthropic Claude
   * @param {Object} chunk - Raw chunk data
   * @param {Object} originalRequest - Original request context
   * @returns {ResponseChunk|null} Parsed response chunk
   */
  parseAnthropicChunk(chunk, originalRequest) {
    // Handle different Anthropic streaming event types
    if (chunk.type === 'message_start') {
      return new ResponseChunk({
        id: chunk.message?.id,
        model: originalRequest.model,
        provider: 'anthropic',
        choices: [],
        usage: chunk.message?.usage
          ? new Usage(
              chunk.message.usage.input_tokens,
              chunk.message.usage.output_tokens,
              (chunk.message.usage.input_tokens || 0) + (chunk.message.usage.output_tokens || 0)
            )
          : null,
        done: false,
        metadata: { type: 'message_start' }
      });
    }

    if (chunk.type === 'content_block_delta' && chunk.delta) {
      const delta = chunk.delta;
      let content = '';
      let toolCalls = null;

      if (delta.type === 'text_delta') {
        content = delta.text || '';
      } else if (delta.type === 'tool_use_delta') {
        // Handle tool use deltas
        toolCalls = [
          {
            id: chunk.id || '',
            name: delta.name || '',
            arguments: delta.partial_json ? { _partial: delta.partial_json } : {}
          }
        ].map(tc => new ToolCall(tc.id, tc.name, tc.arguments));
      }

      const responseDelta = new ResponseDelta(content, toolCalls);
      const choiceDelta = new ResponseChoiceDelta(chunk.index || 0, responseDelta);

      return new ResponseChunk({
        id: chunk.id,
        model: originalRequest.model,
        provider: 'anthropic',
        choices: [choiceDelta],
        usage: null,
        done: false,
        metadata: { type: 'content_block_delta' }
      });
    }

    if (chunk.type === 'message_delta' && chunk.delta) {
      const finishReason = chunk.delta.stop_reason;
      const usage = chunk.usage
        ? new Usage(
            chunk.usage.input_tokens,
            chunk.usage.output_tokens,
            (chunk.usage.input_tokens || 0) + (chunk.usage.output_tokens || 0)
          )
        : null;

      return new ResponseChunk({
        id: chunk.id,
        model: originalRequest.model,
        provider: 'anthropic',
        choices: [
          new ResponseChoiceDelta(
            0,
            new ResponseDelta(''),
            this.normalizeFinishReason(finishReason)
          )
        ],
        usage,
        done: !!finishReason,
        metadata: { type: 'message_delta' }
      });
    }

    return null;
  }

  /**
   * Parse streaming chunk for Mistral
   * @param {Object} chunk - Raw chunk data
   * @param {Object} originalRequest - Original request context
   * @returns {ResponseChunk|null} Parsed response chunk
   */
  parseMistralChunk(chunk, originalRequest) {
    if (!chunk.choices || chunk.choices.length === 0) return null;

    const choice = chunk.choices[0];
    const delta = choice.delta || {};

    // Handle complex delta content format from Mistral
    let deltaContent = '';
    if (delta.content) {
      if (Array.isArray(delta.content)) {
        deltaContent = delta.content
          .filter(part => part.type === 'text' || typeof part === 'string')
          .map(part => (typeof part === 'string' ? part : part.text))
          .join('');
      } else if (typeof delta.content === 'object' && delta.content.type === 'text') {
        deltaContent = delta.content.text;
      } else {
        deltaContent = delta.content || '';
      }
    }

    const responseDelta = new ResponseDelta(
      deltaContent,
      delta.tool_calls ? this.parseMistralStreamToolCalls(delta.tool_calls) : null,
      delta.role
    );

    const choiceDelta = new ResponseChoiceDelta(
      choice.index || 0,
      responseDelta,
      this.normalizeFinishReason(choice.finish_reason)
    );

    const usage = chunk.usage
      ? new Usage(
          chunk.usage.prompt_tokens,
          chunk.usage.completion_tokens,
          chunk.usage.total_tokens
        )
      : null;

    return new ResponseChunk({
      id: chunk.id,
      model: originalRequest.model,
      provider: 'mistral',
      choices: [choiceDelta],
      usage,
      done: !!choice.finish_reason,
      metadata: {
        created: chunk.created,
        object: chunk.object
      }
    });
  }

  /**
   * Parse streaming chunk for Google Gemini
   * @param {Object} chunk - Raw chunk data
   * @param {Object} originalRequest - Original request context
   * @returns {ResponseChunk|null} Parsed response chunk
   */
  parseGoogleChunk(chunk, originalRequest) {
    // Google Gemini has a different streaming format
    if (chunk.candidates && chunk.candidates.length > 0) {
      const candidate = chunk.candidates[0];
      const content = candidate.content;

      let text = '';
      let toolCalls = null;

      if (content && content.parts) {
        for (const part of content.parts) {
          if (part.text) {
            text += part.text;
          } else if (part.functionCall) {
            if (!toolCalls) toolCalls = [];
            toolCalls.push(
              new ToolCall(
                part.functionCall.name + '_' + Date.now(),
                part.functionCall.name,
                part.functionCall.args || {}
              )
            );
          }
        }
      }

      const responseDelta = new ResponseDelta(text, toolCalls, content?.role);
      const choiceDelta = new ResponseChoiceDelta(
        0,
        responseDelta,
        this.normalizeGoogleFinishReason(candidate.finishReason)
      );

      const usage = chunk.usageMetadata
        ? new Usage(
            chunk.usageMetadata.promptTokenCount,
            chunk.usageMetadata.candidatesTokenCount,
            chunk.usageMetadata.totalTokenCount
          )
        : null;

      return new ResponseChunk({
        id: chunk.id || 'google-' + Date.now(),
        model: originalRequest.model,
        provider: 'google',
        choices: [choiceDelta],
        usage,
        done: !!candidate.finishReason,
        metadata: {
          safetyRatings: candidate.safetyRatings,
          citationMetadata: candidate.citationMetadata
        }
      });
    }

    return null;
  }

  /**
   * Parse streaming tool calls for OpenAI format
   * @param {Array} toolCalls - Tool calls from stream
   * @returns {Array<ToolCall>} Parsed tool calls
   */
  parseOpenAIStreamToolCalls(toolCalls) {
    return toolCalls.map(tc => {
      let args = {};
      if (tc.function && tc.function.arguments) {
        try {
          args = JSON.parse(tc.function.arguments);
        } catch {
          args = { _partial: tc.function.arguments };
        }
      }

      return new ToolCall(tc.id || '', tc.function?.name || '', args);
    });
  }

  /**
   * Parse streaming tool calls for Mistral format
   * @param {Array} toolCalls - Tool calls from stream
   * @returns {Array<ToolCall>} Parsed tool calls
   */
  parseMistralStreamToolCalls(toolCalls) {
    return toolCalls.map(tc => {
      let args = {};
      if (tc.function && tc.function.arguments) {
        try {
          args = JSON.parse(tc.function.arguments);
        } catch {
          args = { _partial: tc.function.arguments };
        }
      }

      return new ToolCall(tc.id || '', tc.function?.name || '', args);
    });
  }

  /**
   * Normalize finish reasons to standard format
   * @param {string} reason - Provider-specific finish reason
   * @returns {string|null} Normalized finish reason
   */
  normalizeFinishReason(reason) {
    if (!reason) return null;

    const mapping = {
      stop: 'stop',
      length: 'length',
      tool_calls: 'tool_calls',
      content_filter: 'content_filter',
      function_call: 'tool_calls', // Legacy OpenAI
      end_turn: 'stop', // Anthropic
      max_tokens: 'length', // Anthropic
      stop_sequence: 'stop' // Anthropic
    };

    return mapping[reason] || reason;
  }

  /**
   * Normalize Google Gemini finish reasons
   * @param {string} reason - Google finish reason
   * @returns {string|null} Normalized finish reason
   */
  normalizeGoogleFinishReason(reason) {
    if (!reason) return null;

    const mapping = {
      FINISH_REASON_STOP: 'stop',
      FINISH_REASON_MAX_TOKENS: 'length',
      FINISH_REASON_SAFETY: 'content_filter',
      FINISH_REASON_RECITATION: 'content_filter',
      FINISH_REASON_OTHER: 'stop'
    };

    return mapping[reason] || reason;
  }

  /**
   * Get appropriate chunk parser for provider
   * @param {string} provider - Provider name
   * @returns {Function} Chunk parser function
   */
  getChunkParser(provider) {
    const parsers = {
      openai: this.parseOpenAIChunk.bind(this),
      anthropic: this.parseAnthropicChunk.bind(this),
      mistral: this.parseMistralChunk.bind(this),
      google: this.parseGoogleChunk.bind(this),
      vllm: this.parseOpenAIChunk.bind(this) // VLLM uses OpenAI format
    };

    const parser = parsers[provider.toLowerCase()];
    if (!parser) {
      throw new ProviderError(
        `No streaming parser available for provider: ${provider}`,
        provider,
        'UNSUPPORTED_PROVIDER'
      );
    }

    return parser;
  }

  /**
   * Parse any streaming chunk automatically detecting format
   * @param {Object} chunk - Raw chunk data
   * @param {Object} originalRequest - Original request context
   * @returns {ResponseChunk|null} Parsed response chunk
   */
  parseChunk(chunk, originalRequest) {
    const provider = originalRequest.provider?.toLowerCase() || 'openai';
    const parser = this.getChunkParser(provider);

    try {
      return parser(chunk, originalRequest);
    } catch (error) {
      this.logger?.error?.('Failed to parse streaming chunk:', {
        provider,
        chunk,
        error: error.message
      });

      // Return error chunk
      return new ResponseChunk({
        id: 'error-' + Date.now(),
        model: originalRequest.model,
        provider,
        choices: [],
        usage: null,
        done: true,
        error: error.message
      });
    }
  }
}
