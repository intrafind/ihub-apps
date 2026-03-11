/**
 * ContextSummarizer
 *
 * Reduces accumulated workflow context when it gets too large, preventing LLM
 * token limit errors for long-running agentic workflows.
 *
 * When the total estimated tokens across all node outputs exceed the configured
 * threshold, this service summarizes older node outputs using an LLM call and
 * replaces them with a single compact summary entry.
 *
 * @module services/workflow/ContextSummarizer
 */

import WorkflowLLMHelper from './WorkflowLLMHelper.js';
import configCache from '../../configCache.js';
import logger from '../../utils/logger.js';

/**
 * Service for summarizing accumulated workflow context to prevent token overflows.
 *
 * @example
 * // Used inside AgentNodeExecutor when config.autoSummarize is true
 * const summarizer = new ContextSummarizer({ thresholdTokens: 50000, keepRecentCount: 3 });
 * if (summarizer.needsSummarization(state)) {
 *   state = await summarizer.summarizeContext(state, context);
 * }
 */
export class ContextSummarizer {
  /**
   * Create a new ContextSummarizer.
   *
   * @param {Object} [options={}] - Configuration options
   * @param {number} [options.thresholdTokens=50000] - Token count above which summarization is triggered
   * @param {number} [options.keepRecentCount=3] - Number of most-recent node outputs to keep in full
   * @param {string|null} [options.summaryModelId=null] - Model ID to use for summarization; if null uses fastest available
   */
  constructor(options = {}) {
    this.thresholdTokens = options.thresholdTokens || 50000;
    this.keepRecentCount = options.keepRecentCount || 3;
    this.summaryModelId = options.summaryModelId || null;
    this.llmHelper = options.llmHelper || new WorkflowLLMHelper();
  }

  /**
   * Estimate tokens from text using a simple heuristic (chars / 4).
   *
   * @param {string} text - Text to estimate
   * @returns {number} Estimated token count
   */
  estimateTokens(text) {
    if (!text || typeof text !== 'string') return 0;
    return Math.ceil(text.length / 4);
  }

  /**
   * Estimate the total tokens across all node results in the workflow state.
   *
   * @param {Object} state - Workflow state
   * @returns {number} Total estimated token count
   */
  estimateStateTokens(state) {
    const nodeOutputs = state.data?.nodeResults || {};
    let total = 0;
    for (const output of Object.values(nodeOutputs)) {
      const text = typeof output === 'string' ? output : JSON.stringify(output);
      total += this.estimateTokens(text);
    }
    return total;
  }

  /**
   * Check whether context summarization is needed based on the token threshold.
   *
   * @param {Object} state - Workflow state
   * @returns {boolean} True if summarization should be performed
   */
  needsSummarization(state) {
    return this.estimateStateTokens(state) > this.thresholdTokens;
  }

  /**
   * Summarize older node outputs using an LLM and return updated state.
   *
   * Keeps the most-recent `keepRecentCount` node outputs intact and replaces
   * all older outputs with a single `_context_summary` entry. On failure,
   * returns the original state unchanged (graceful degradation).
   *
   * @param {Object} state - Current workflow state
   * @param {Object} context - Execution context (user, language, workflow, etc.)
   * @returns {Promise<Object>} Updated state (or original state if summarization fails)
   */
  async summarizeContext(state, context) {
    const nodeResults = state.data?.nodeResults || {};
    const nodeIds = Object.keys(nodeResults);

    if (nodeIds.length <= this.keepRecentCount) {
      return state;
    }

    const olderNodeIds = nodeIds.slice(0, nodeIds.length - this.keepRecentCount);
    const recentNodeIds = nodeIds.slice(-this.keepRecentCount);

    logger.debug({
      component: 'ContextSummarizer',
      message: 'Summarizing older node outputs',
      olderCount: olderNodeIds.length,
      keepingCount: recentNodeIds.length
    });

    const textToSummarize = olderNodeIds
      .map(id => {
        const output = nodeResults[id];
        const text = typeof output === 'string' ? output : JSON.stringify(output);
        return `[${id}]: ${text}`;
      })
      .join('\n\n');

    if (!textToSummarize.trim()) return state;

    try {
      const summary = await this.callSummaryLLM(textToSummarize, context);

      const updatedNodeResults = { ...nodeResults };
      for (const id of olderNodeIds) {
        delete updatedNodeResults[id];
      }
      updatedNodeResults['_context_summary'] = summary;

      logger.info({
        component: 'ContextSummarizer',
        message: 'Context summarization completed',
        summarizedNodeCount: olderNodeIds.length
      });

      return {
        ...state,
        data: {
          ...state.data,
          nodeResults: updatedNodeResults,
          _contextSummarizedAt: new Date().toISOString()
        }
      };
    } catch (error) {
      logger.warn({
        component: 'ContextSummarizer',
        message: 'Context summarization failed, continuing with full context',
        error: error.message
      });
      return state;
    }
  }

  /**
   * Resolve a model configuration for summarization.
   *
   * Uses `summaryModelId` if configured, otherwise falls back to the context
   * model, the default model, or the first available model.
   *
   * @param {Object} context - Execution context
   * @returns {Promise<Object|null>} Model configuration or null if none found
   */
  async getModel(context) {
    const { data: models } = configCache.getModels();
    if (!models || models.length === 0) return null;

    if (this.summaryModelId) {
      const specified = models.find(m => m.id === this.summaryModelId);
      if (specified) return specified;
    }

    if (context.modelId) {
      const contextModel = models.find(m => m.id === context.modelId);
      if (contextModel) return contextModel;
    }

    return models.find(m => m.default) || models[0];
  }

  /**
   * Call the LLM to produce a concise summary of the provided workflow outputs.
   *
   * @param {string} text - Concatenated older node outputs to summarize
   * @param {Object} context - Execution context
   * @returns {Promise<string>} Summary text
   * @throws {Error} If no model is available or the LLM call fails
   */
  async callSummaryLLM(text, context) {
    const messages = [
      {
        role: 'system',
        content:
          'You are a context summarizer. Summarize the following workflow execution outputs into a concise summary that preserves key facts, decisions, and data. Be thorough but concise.'
      },
      {
        role: 'user',
        content: `Summarize these workflow execution outputs:\n\n${text}`
      }
    ];

    const model = await this.getModel(context);
    if (!model) {
      throw new Error('No model available for summarization');
    }

    const apiKeyResult = await this.llmHelper.verifyApiKey(model, context.language || 'en');
    if (!apiKeyResult.success) {
      throw new Error(apiKeyResult.error?.message || 'API key verification failed');
    }

    const response = await this.llmHelper.executeStreamingRequest({
      model,
      messages,
      apiKey: apiKeyResult.apiKey,
      options: {
        maxTokens: 2000,
        temperature: 0
      },
      language: context.language || 'en'
    });

    return response.content;
  }
}

export default ContextSummarizer;
