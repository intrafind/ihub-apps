import { encoding_for_model, get_encoding } from "tiktoken";

/**
 * TokenCounter - Accurate token counting service for different LLM model families
 * Replaces word-count estimation with proper tokenization
 */
export class TokenCounter {
  static encodingCache = new Map();
  static modelTokenLimits = new Map();
  
  /**
   * Get the appropriate tokenizer encoding for a model family
   * @param {string} modelFamily - Model family (gpt-4, claude, gemini, etc.)
   * @returns {Encoding} Tiktoken encoding object
   */
  static getEncoding(modelFamily) {
    if (this.encodingCache.has(modelFamily)) {
      return this.encodingCache.get(modelFamily);
    }
    
    let encoding;
    try {
      switch (modelFamily?.toLowerCase()) {
        case 'gpt-4':
        case 'gpt-4-turbo':
        case 'gpt-4o':
          encoding = encoding_for_model('gpt-4');
          break;
        case 'gpt-3.5':
        case 'gpt-3.5-turbo':
          encoding = encoding_for_model('gpt-3.5-turbo');
          break;
        case 'claude':
        case 'claude-3':
        case 'claude-3-sonnet':
        case 'claude-3-opus':
        case 'claude-3-haiku':
          // Claude uses a similar tokenizer to GPT-4, use cl100k_base as approximation
          encoding = get_encoding('cl100k_base');
          break;
        case 'gemini':
        case 'gemini-pro':
        case 'gemini-1.5':
          // Gemini tokenization approximated with cl100k_base
          encoding = get_encoding('cl100k_base');
          break;
        case 'mistral':
        case 'mixtral':
          // Mistral approximated with cl100k_base
          encoding = get_encoding('cl100k_base');
          break;
        default:
          // Default to cl100k_base for unknown models
          encoding = get_encoding('cl100k_base');
      }
      
      this.encodingCache.set(modelFamily, encoding);
      return encoding;
    } catch (error) {
      console.warn(`Failed to get encoding for ${modelFamily}, using default:`, error.message);
      // Fallback to cl100k_base
      encoding = get_encoding('cl100k_base');
      this.encodingCache.set(modelFamily, encoding);
      return encoding;
    }
  }
  
  /**
   * Count tokens in a text string
   * @param {string} text - Text to count tokens for
   * @param {string} modelFamily - Model family for tokenizer selection
   * @returns {number} Number of tokens
   */
  static countTokens(text, modelFamily) {
    if (!text || typeof text !== 'string') {
      return 0;
    }
    
    try {
      const encoding = this.getEncoding(modelFamily);
      return encoding.encode(text).length;
    } catch (error) {
      console.warn(`Token counting failed for ${modelFamily}:`, error.message);
      // Fallback to word count estimation (multiply by 1.3 for safety)
      return Math.ceil(text.split(/\s+/).length * 1.3);
    }
  }
  
  /**
   * Estimate total context tokens including system prompt, messages, and tool outputs
   * @param {Array} messages - Chat messages array
   * @param {string} systemPrompt - System prompt text
   * @param {string} modelFamily - Model family for tokenizer selection
   * @returns {Object} Token breakdown and totals
   */
  static estimateContextTokens(messages, systemPrompt, modelFamily) {
    let systemTokens = 0;
    let messageTokens = 0;
    let toolOutputTokens = 0;
    
    // Count system prompt tokens
    if (systemPrompt) {
      systemTokens = this.countTokens(systemPrompt, modelFamily);
    }
    
    // Count message tokens
    if (messages && Array.isArray(messages)) {
      for (const message of messages) {
        if (message.role === 'tool') {
          // Separate tool output tokens for monitoring
          toolOutputTokens += this.countTokens(this.messageToString(message), modelFamily);
        } else {
          messageTokens += this.countTokens(this.messageToString(message), modelFamily);
        }
      }
    }
    
    const totalTokens = systemTokens + messageTokens + toolOutputTokens;
    
    return {
      totalTokens,
      systemTokens,
      messageTokens,
      toolOutputTokens,
      breakdown: {
        systemPrompt: systemTokens,
        chatHistory: messageTokens,
        toolOutputs: toolOutputTokens
      }
    };
  }
  
  /**
   * Convert message object to string for token counting
   * @param {Object} message - Message object
   * @returns {string} String representation of message
   */
  static messageToString(message) {
    if (!message) return '';
    
    if (typeof message === 'string') {
      return message;
    }
    
    // Handle different message formats
    if (message.content) {
      if (typeof message.content === 'string') {
        return message.content;
      }
      // Handle multi-part content (images, etc.)
      if (Array.isArray(message.content)) {
        return message.content
          .filter(part => part.type === 'text')
          .map(part => part.text)
          .join(' ');
      }
    }
    
    // Fallback to JSON string
    return JSON.stringify(message);
  }
  
  /**
   * Calculate context usage percentage
   * @param {number} usedTokens - Currently used tokens
   * @param {number} contextLimit - Model's context limit
   * @param {number} safetyMargin - Safety margin (default 0.9)
   * @returns {Object} Usage statistics
   */
  static calculateUsage(usedTokens, contextLimit, safetyMargin = 0.9) {
    const effectiveLimit = Math.floor(contextLimit * safetyMargin);
    const usagePercentage = (usedTokens / effectiveLimit) * 100;
    
    return {
      usedTokens,
      effectiveLimit,
      contextLimit,
      safetyMargin,
      usagePercentage: Math.round(usagePercentage * 10) / 10, // Round to 1 decimal
      remainingTokens: Math.max(0, effectiveLimit - usedTokens),
      exceedsLimit: usedTokens > effectiveLimit,
      needsOptimization: usagePercentage > 80,
      isNearLimit: usagePercentage > 90
    };
  }
  
  /**
   * Validate if a request fits within context limits
   * @param {Array} messages - Chat messages
   * @param {string} systemPrompt - System prompt
   * @param {Object} modelConfig - Model configuration
   * @param {string} additionalInput - Additional input to add
   * @returns {Object} Validation result
   */
  static validateContextWindow(messages, systemPrompt, modelConfig, additionalInput = '') {
    const tokenEstimate = this.estimateContextTokens(messages, systemPrompt, modelConfig.tokenFamily);
    
    // Add additional input tokens
    if (additionalInput) {
      tokenEstimate.totalTokens += this.countTokens(additionalInput, modelConfig.tokenFamily);
      tokenEstimate.breakdown.additionalInput = this.countTokens(additionalInput, modelConfig.tokenFamily);
    }
    
    // Reserve space for output tokens
    const outputTokenReserve = modelConfig.maxOutputTokens || 4096;
    const availableForInput = modelConfig.contextLimit - outputTokenReserve;
    
    const usage = this.calculateUsage(tokenEstimate.totalTokens, availableForInput, modelConfig.safetyMargin);
    
    return {
      ...tokenEstimate,
      ...usage,
      outputTokenReserve,
      availableForInput,
      modelFamily: modelConfig.tokenFamily,
      modelId: modelConfig.id,
      valid: !usage.exceedsLimit,
      warnings: this.generateWarnings(usage, tokenEstimate)
    };
  }
  
  /**
   * Generate context usage warnings
   * @param {Object} usage - Usage statistics
   * @param {Object} tokenEstimate - Token breakdown
   * @returns {Array} Array of warning messages
   */
  static generateWarnings(usage, tokenEstimate) {
    const warnings = [];
    
    if (usage.exceedsLimit) {
      warnings.push({
        type: 'error',
        message: `Context limit exceeded: ${usage.usedTokens} tokens used, ${usage.effectiveLimit} available`
      });
    } else if (usage.isNearLimit) {
      warnings.push({
        type: 'warning',
        message: `Context usage critical: ${usage.usagePercentage}% used`
      });
    } else if (usage.needsOptimization) {
      warnings.push({
        type: 'info',
        message: `Context usage high: ${usage.usagePercentage}% used, optimization recommended`
      });
    }
    
    // Specific warnings for large components
    if (tokenEstimate.toolOutputTokens > tokenEstimate.totalTokens * 0.3) {
      warnings.push({
        type: 'info',
        message: `Tool outputs use ${Math.round((tokenEstimate.toolOutputTokens / tokenEstimate.totalTokens) * 100)}% of context`
      });
    }
    
    if (tokenEstimate.messageTokens > tokenEstimate.totalTokens * 0.5) {
      warnings.push({
        type: 'info',
        message: `Chat history uses ${Math.round((tokenEstimate.messageTokens / tokenEstimate.totalTokens) * 100)}% of context`
      });
    }
    
    return warnings;
  }
  
  /**
   * Clean up cached encodings (for memory management)
   */
  static clearCache() {
    // Free encoding objects
    for (const [key, encoding] of this.encodingCache) {
      try {
        encoding.free();
      } catch (error) {
        // Ignore cleanup errors
      }
    }
    this.encodingCache.clear();
  }
}

export default TokenCounter;