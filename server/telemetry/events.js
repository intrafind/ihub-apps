/**
 * OpenTelemetry Gen-AI Event Emission
 * Implements https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-events/
 */

import { sanitizeContent } from './attributes.js';

/**
 * Emit gen_ai.content.prompt event
 * @param {Object} span - Active span
 * @param {Array|string} messages - Prompt messages or content
 * @param {Object} config - Telemetry configuration
 */
export function emitPromptEvent(span, messages, config = {}) {
  if (!span || !config.events?.enabled) return;
  if (!config.events?.includePrompts) return;

  try {
    // Extract prompt content
    let promptContent = messages;

    // Handle array of messages (chat format)
    if (Array.isArray(messages)) {
      promptContent = messages
        .map(msg => {
          if (typeof msg === 'string') return msg;
          if (msg.content) return `${msg.role}: ${msg.content}`;
          return JSON.stringify(msg);
        })
        .join('\n');
    }

    // Sanitize content
    const sanitized = sanitizeContent(promptContent, config.events);

    // Emit event
    span.addEvent('gen_ai.content.prompt', {
      'gen_ai.prompt': sanitized
    });
  } catch (error) {
    console.warn('Failed to emit prompt event:', error.message);
  }
}

/**
 * Emit gen_ai.content.completion event
 * @param {Object} span - Active span
 * @param {Object|string} response - Completion response
 * @param {Object} config - Telemetry configuration
 */
export function emitCompletionEvent(span, response, config = {}) {
  if (!span || !config.events?.enabled) return;
  if (!config.events?.includeCompletions) return;

  try {
    // Extract completion content
    let completionContent = response;

    // Handle response object
    if (typeof response === 'object') {
      if (response.content) {
        completionContent = response.content;
      } else if (response.choices && response.choices.length > 0) {
        completionContent = response.choices
          .map(choice => choice.message?.content || choice.text)
          .filter(Boolean)
          .join('\n');
      } else if (response.text) {
        completionContent = response.text;
      }
    }

    // Sanitize content
    const sanitized = sanitizeContent(completionContent, config.events);

    // Emit event with finish reason if available
    const eventAttributes = {
      'gen_ai.completion': sanitized
    };

    if (response.finishReason) {
      eventAttributes['finish_reason'] = response.finishReason;
    }

    span.addEvent('gen_ai.content.completion', eventAttributes);
  } catch (error) {
    console.warn('Failed to emit completion event:', error.message);
  }
}

/**
 * Emit gen_ai.choice event for tool calls
 * @param {Object} span - Active span
 * @param {Object} choice - Choice object with tool calls
 * @param {number} index - Choice index
 * @param {Object} config - Telemetry configuration
 */
export function emitChoiceEvent(span, choice, index, config = {}) {
  if (!span || !config.events?.enabled) return;

  try {
    const eventAttributes = {
      index: index || 0
    };

    // Include tool calls if present
    if (choice.tool_calls && choice.tool_calls.length > 0) {
      const toolCallsInfo = choice.tool_calls.map(tc => ({
        id: tc.id,
        type: tc.type,
        name: tc.function?.name,
        // Don't include arguments by default (may contain sensitive data)
        hasArguments: !!tc.function?.arguments
      }));

      eventAttributes['tool_calls'] = JSON.stringify(toolCallsInfo);
    }

    // Include finish reason
    if (choice.finish_reason) {
      eventAttributes['finish_reason'] = choice.finish_reason;
    }

    span.addEvent('gen_ai.choice', eventAttributes);
  } catch (error) {
    console.warn('Failed to emit choice event:', error.message);
  }
}

/**
 * Emit streaming progress event
 * @param {Object} span - Active span
 * @param {Object} progress - Progress information
 */
export function emitStreamingProgressEvent(span, progress) {
  if (!span) return;

  try {
    span.addEvent('streaming.progress', {
      'tokens.received': progress.tokensReceived || 0,
      'chunks.received': progress.chunksReceived || 0,
      'duration.ms': progress.durationMs || 0
    });
  } catch (error) {
    console.warn('Failed to emit streaming progress event:', error.message);
  }
}

/**
 * Emit tool execution event
 * @param {Object} span - Active span
 * @param {string} toolName - Tool name
 * @param {Object} result - Tool execution result
 * @param {number} duration - Execution duration in ms
 */
export function emitToolExecutionEvent(span, toolName, result, duration) {
  if (!span) return;

  try {
    span.addEvent('tool.execution', {
      'tool.name': toolName,
      'tool.success': !result.error,
      'tool.duration.ms': duration,
      'tool.result.size': result.output ? JSON.stringify(result.output).length : 0
    });
  } catch (error) {
    console.warn('Failed to emit tool execution event:', error.message);
  }
}

/**
 * Emit error event
 * @param {Object} span - Active span
 * @param {Error} error - Error object
 * @param {string} context - Error context
 */
export function emitErrorEvent(span, error, context = 'unknown') {
  if (!span || !error) return;

  try {
    span.addEvent('error', {
      'error.type': error.name || 'Error',
      'error.message': error.message,
      'error.context': context,
      'error.stack': error.stack ? error.stack.substring(0, 500) : undefined
    });
  } catch (err) {
    console.warn('Failed to emit error event:', err.message);
  }
}
