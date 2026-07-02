/**
 * Context Summarizer for workflow execution state.
 *
 * When a workflow accumulates large amounts of node results (exceeding a
 * configurable token threshold), this service uses an LLM to summarize
 * older results while keeping the most recent ones intact. This prevents
 * context window overflow in long-running, multi-step workflows.
 *
 * Design principles:
 * - Graceful degradation: on any failure, returns the original state unchanged
 * - Preserves recent results: always keeps the N most recent node results as-is
 * - Token estimation: uses a simple character-based heuristic (chars / 4)
 *
 * @module services/workflow/ContextSummarizer
 */

import WorkflowLLMHelper from './WorkflowLLMHelper.js';
import configCache from '../../configCache.js';
import logger from '../../utils/logger.js';

/**
 * Summarizes accumulated workflow context to stay within LLM token limits.
 *
 * When workflow node results grow beyond a threshold, older results are
 * condensed into a summary while recent results are preserved verbatim.
 *
 * @example
 * const summarizer = new ContextSummarizer({ thresholdTokens: 40000 });
 * if (summarizer.needsSummarization(state)) {
 *   state = await summarizer.summarizeContext(state, context);
 * }
 */
export class ContextSummarizer {
  /**
   * Create a new ContextSummarizer.
   *
   * @param {Object} options - Configuration options
   * @param {number} [options.thresholdTokens=50000] - Token count threshold that triggers summarization
   * @param {number} [options.keepRecentCount=3] - Number of most recent node results to preserve unchanged
   * @param {WorkflowLLMHelper} [options.llmHelper] - LLM helper instance (created automatically if omitted)
   */
  constructor(options = {}) {
    this.thresholdTokens = options.thresholdTokens || 50000;
    this.keepRecentCount = options.keepRecentCount || 3;
    this.llmHelper = options.llmHelper || new WorkflowLLMHelper();
  }

  /**
   * Estimate token count from text using a character-based heuristic.
   *
   * Uses the common approximation of ~4 characters per token, which works
   * reasonably well across most LLM tokenizers for English text.
   *
   * @param {string} text - Text to estimate tokens for
   * @returns {number} Estimated token count
   */
  estimateTokens(text) {
    return Math.ceil(String(text).length / 4);
  }

  /**
   * Detect whether an LLM error is a context-window-overflow / prompt-too-long
   * error (the trigger for reactive recovery — Claude Code's reactive-compact
   * analog). Heuristic across providers: HTTP 413, or a 4xx whose message
   * mentions context length / token limits.
   *
   * @param {Error|Object} err - Error thrown by the LLM helper
   * @returns {boolean}
   */
  static isContextOverflowError(err) {
    if (!err) return false;
    const status = err.status || err.httpStatus;
    if (status === 413) return true;
    const haystack = `${err.message || ''} ${err.details || ''} ${err.code || ''}`.toLowerCase();
    const overflowSignals = [
      'context length',
      'context window',
      'maximum context',
      'too long',
      'prompt is too long',
      'context_length_exceeded',
      'reduce the length',
      'too many tokens',
      'exceeds the maximum'
    ];
    const looksLikeOverflow = overflowSignals.some(s => haystack.includes(s));
    // Only treat 4xx (client-side / request-shape) overflows as recoverable.
    if (looksLikeOverflow && (status === undefined || (status >= 400 && status < 500))) {
      return true;
    }
    return false;
  }

  /**
   * Compute a summarization threshold from a model's context window when
   * known, so the trigger scales with the model instead of a flat constant.
   * Falls back to the configured `thresholdTokens`.
   *
   * @param {Object} [model] - Model config (may carry tokens/contextWindow)
   * @returns {number} threshold in tokens
   */
  thresholdForModel(model) {
    const window =
      model?.tokens ||
      model?.contextWindow ||
      model?.context_window ||
      model?.maxInputTokens ||
      model?.maxTokens;
    if (typeof window === 'number' && window > 0) {
      // Trigger at ~65% of the window — leaves headroom for the response and
      // the summarization call itself.
      return Math.floor(window * 0.65);
    }
    return this.thresholdTokens;
  }

  /**
   * Microcompact a message array (Claude Code's microcompact analog): collapse
   * the *content* of large, old `tool` results and oversized assistant turns
   * into short reference placeholders, while preserving the last `keepRecent`
   * messages verbatim and never touching system/user prompts. This is the
   * cheapest way to recover from context overflow in a tool-heavy loop without
   * an extra LLM call.
   *
   * @param {Array<Object>} messages - Chat messages (role/content)
   * @param {Object} [opts]
   * @param {number} [opts.keepRecent=4] - Trailing messages to keep verbatim
   * @param {number} [opts.maxChars=2000] - Collapse contents longer than this
   * @returns {{ messages: Array<Object>, freedChars: number, collapsed: number }}
   */
  microcompactMessages(messages, opts = {}) {
    const keepRecent = opts.keepRecent ?? 4;
    const maxChars = opts.maxChars ?? 2000;
    if (!Array.isArray(messages) || messages.length <= keepRecent) {
      return { messages, freedChars: 0, collapsed: 0 };
    }
    const cutoff = messages.length - keepRecent;
    let freedChars = 0;
    let collapsed = 0;
    const out = messages.map((msg, i) => {
      if (i >= cutoff) return msg; // keep recent verbatim
      if (!msg || typeof msg.content !== 'string') return msg;
      // Only compact bulky tool results / oversized assistant content.
      const isCompactable = msg.role === 'tool' || msg.role === 'assistant';
      if (!isCompactable || msg.content.length <= maxChars) return msg;
      freedChars += msg.content.length;
      collapsed += 1;
      const head = msg.content.slice(0, 200).replace(/\s+/g, ' ');
      return {
        ...msg,
        content: `[older ${msg.role} output elided to save context — ${msg.content.length} chars. Preview: ${head}…]`
      };
    });
    return { messages: out, freedChars, collapsed };
  }

  /**
   * Proactively microcompact a message array WHEN it exceeds a token
   * threshold — the cure for O(N²) prompt growth in a tool-heavy loop on
   * large-window models (where the reactive overflow path never fires).
   *
   * Pure: estimates the current size, and only when it exceeds
   * `thresholdTokens` does it collapse old bulky tool/assistant bodies via
   * `microcompactMessages`. Under the threshold it returns the original array
   * untouched (referential identity preserved) so callers can cheaply detect
   * the no-op. Idempotent: already-collapsed placeholders are below `maxChars`
   * and won't be touched again.
   *
   * @param {Array<Object>} messages
   * @param {Object} [opts]
   * @param {number} [opts.thresholdTokens=16000] - compact only above this size
   * @param {number} [opts.keepRecent=6] - trailing messages kept verbatim
   * @param {number} [opts.maxChars=2000] - collapse bodies longer than this
   * @returns {{ messages: Array<Object>, freedChars: number, collapsed: number, compacted: boolean }}
   */
  compactIfOversized(messages, opts = {}) {
    const thresholdTokens = opts.thresholdTokens ?? 16000;
    const keepRecent = opts.keepRecent ?? 6;
    const maxChars = opts.maxChars ?? 2000;
    if (!Array.isArray(messages) || messages.length === 0) {
      return { messages, freedChars: 0, collapsed: 0, compacted: false };
    }
    const totalText = messages
      .map(m => (typeof m?.content === 'string' ? m.content : ''))
      .join(' ');
    if (this.estimateTokens(totalText) <= thresholdTokens) {
      return { messages, freedChars: 0, collapsed: 0, compacted: false };
    }
    const result = this.microcompactMessages(messages, { keepRecent, maxChars });
    return { ...result, compacted: result.collapsed > 0 };
  }

  /**
   * Check whether the current workflow state has accumulated enough
   * node results to warrant summarization.
   *
   * @param {Object} state - Current workflow state
   * @param {Object} state.data - State data container
   * @param {Object} [state.data.nodeResults] - Map of node ID to result objects
   * @returns {boolean} True if total estimated tokens exceed the threshold
   */
  needsSummarization(state) {
    const nodeResults = state.data?.nodeResults;
    if (!nodeResults) return false;
    const totalText = Object.values(nodeResults)
      .map(r => JSON.stringify(r))
      .join('');
    return this.estimateTokens(totalText) > this.thresholdTokens;
  }

  /**
   * Summarize older node results using an LLM while preserving recent ones.
   *
   * The method splits node results into "older" and "recent" groups. The older
   * results are sent to an LLM for summarization, and the result is stored
   * under the `_context_summary` key. Recent results remain unchanged.
   *
   * On any failure (no model available, API key issues, LLM errors), the
   * original state is returned unchanged -- the workflow continues without
   * summarization rather than failing.
   *
   * @param {Object} state - Current workflow state with nodeResults
   * @param {Object} context - Execution context
   * @param {string} [context.language='en'] - Language for LLM interaction
   * @returns {Promise<Object>} Updated state with summarized context, or original state on failure
   */
  async summarizeContext(state, context) {
    try {
      const entries = Object.entries(state.data.nodeResults);
      const recent = entries.slice(-this.keepRecentCount);
      const older = entries.slice(0, -this.keepRecentCount);

      if (older.length === 0) return state;

      const olderText = older.map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n');

      // Get model for summarization
      const { data: models } = configCache.getModels();
      const model = models?.find(m => m.default) || models?.[0];

      if (!model) {
        logger.warn({
          component: 'ContextSummarizer',
          message: 'No model available for summarization, returning original state'
        });
        return state;
      }

      const apiKeyResult = await this.llmHelper.verifyApiKey(model, context.language || 'en');
      if (!apiKeyResult.success) {
        logger.warn({
          component: 'ContextSummarizer',
          message: 'API key verification failed, returning original state'
        });
        return state;
      }

      const messages = [
        {
          role: 'system',
          content:
            'You are a context summarizer. Summarize the following workflow node results concisely while preserving all key information, findings, and data points. Keep important details, numbers, and conclusions.'
        },
        {
          role: 'user',
          content: `Summarize these workflow results:\n\n${olderText}`
        }
      ];

      const response = await this.llmHelper.executeStreamingRequest({
        model,
        messages,
        apiKey: apiKeyResult.apiKey,
        options: { temperature: 0.3 },
        language: context.language || 'en'
      });

      const summary = response.content || '';

      // Replace older results with summary, keep recent results intact
      const newNodeResults = { _context_summary: summary };
      recent.forEach(([k, v]) => {
        newNodeResults[k] = v;
      });

      logger.info({
        component: 'ContextSummarizer',
        message: `Summarized ${older.length} node results into context summary`,
        originalEntries: older.length,
        keptRecent: recent.length
      });

      return {
        ...state,
        data: {
          ...state.data,
          nodeResults: newNodeResults
        }
      };
    } catch (error) {
      // Graceful degradation: return original state on failure
      logger.warn({
        component: 'ContextSummarizer',
        message: `Summarization failed, returning original state: ${error.message}`
      });
      return state;
    }
  }
}

export default ContextSummarizer;
