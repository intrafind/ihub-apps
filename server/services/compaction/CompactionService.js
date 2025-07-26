import { createCompletionRequest } from '../../adapters/index.js';
import { throttledFetch } from '../../requestThrottler.js';
import configCache from '../../configCache.js';

/**
 * Service for compacting chat history to manage token limits and maintain conversation context
 * Supports multiple compaction strategies: LLM-powered summarization, importance filtering, sliding window
 */
class CompactionService {
  constructor() {
    this.defaultCompactionModel = 'gpt-4o-mini'; // Fast, cheap model for summarization
    this.maxRetries = 2;
  }

  /**
   * Estimate token count for messages based on the model provider
   * @param {Array} messages - Array of message objects
   * @param {Object} model - Model configuration object
   * @returns {number} Estimated token count
   */
  estimateTokenCount(messages, model) {
    if (!messages || !Array.isArray(messages)) return 0;

    const provider = model?.provider?.toLowerCase() || 'openai';
    let totalTokens = 0;

    for (const message of messages) {
      const content = message.content || '';
      let messageTokens = 0;

      switch (provider) {
        case 'openai':
          // GPT models: roughly 1 token per 4 characters for English
          messageTokens = Math.ceil(content.length / 4);
          // Add overhead for role, formatting
          messageTokens += 4;
          break;

        case 'anthropic':
          // Claude models: roughly 1 token per 3.5 characters
          messageTokens = Math.ceil(content.length / 3.5);
          messageTokens += 6; // Higher overhead for Claude's format
          break;

        case 'google':
          // Gemini models: roughly 1 token per 4 characters
          messageTokens = Math.ceil(content.length / 4);
          messageTokens += 3;
          break;

        case 'mistral':
          // Mistral models: roughly 1 token per 4.2 characters
          messageTokens = Math.ceil(content.length / 4.2);
          messageTokens += 3;
          break;

        default:
          // Generic estimation: 1 token per 4 characters
          messageTokens = Math.ceil(content.length / 4) + 4;
      }

      // Add tokens for image/file attachments
      if (message.imageData) {
        messageTokens += 255; // Approximate tokens for vision processing
      }
      if (message.fileData) {
        messageTokens += Math.ceil((message.fileData.content?.length || 0) / 4);
      }

      totalTokens += messageTokens;
    }

    return totalTokens;
  }

  /**
   * Get compaction thresholds based on model's token limit
   * @param {Object} model - Model configuration
   * @param {Object} app - App configuration
   * @returns {Object} Thresholds for compaction triggers
   */
  getCompactionThresholds(model, app) {
    // Use app's tokenLimit, or fall back to model's limit, or default
    const maxTokens = app?.tokenLimit || model?.maxTokens || 4096;
    
    return {
      maxTokens,
      warningThreshold: Math.floor(maxTokens * 0.7), // 70% - start warning
      autoCompactThreshold: Math.floor(maxTokens * 0.8), // 80% - suggest compaction
      forceCompactThreshold: Math.floor(maxTokens * 0.9), // 90% - force compaction
      reserveTokens: Math.min(1000, Math.floor(maxTokens * 0.2)) // Reserve for response
    };
  }

  /**
   * Analyze messages to determine importance scores
   * @param {Array} messages - Array of message objects
   * @returns {Array} Messages with importance scores (0-1)
   */
  analyzeMessageImportance(messages) {
    return messages.map((message, index) => {
      let importance = 0.3; // Base importance

      const content = (message.content || '').toLowerCase();
      const length = content.length;

      // Recency bonus (more recent = more important)
      const recencyBonus = (index / Math.max(messages.length - 1, 1)) * 0.3;
      importance += recencyBonus;

      // Content-based importance
      if (content.includes('code') || content.includes('function') || content.includes('class')) {
        importance += 0.2; // Code is often important
      }
      if (content.includes('error') || content.includes('issue') || content.includes('problem')) {
        importance += 0.15; // Error discussions are important
      }
      if (content.includes('important') || content.includes('remember') || content.includes('note')) {
        importance += 0.15; // Explicitly marked as important
      }
      if (content.includes('?')) {
        importance += 0.1; // Questions are often important
      }

      // Length bonus (longer messages often contain more information)
      if (length > 500) importance += 0.1;
      if (length > 1000) importance += 0.1;

      // File/image attachments are important
      if (message.imageData || message.fileData) {
        importance += 0.2;
      }

      // User messages slightly more important than assistant messages
      if (message.role === 'user') {
        importance += 0.05;
      }

      return {
        ...message,
        importance: Math.min(1, importance)
      };
    });
  }

  /**
   * Compact messages using sliding window strategy
   * @param {Array} messages - Messages to compact
   * @param {number} targetTokens - Target token count after compaction
   * @param {Object} model - Model configuration
   * @returns {Object} Compaction result
   */
  compactSlidingWindow(messages, targetTokens, model) {
    if (messages.length <= 2) {
      return { compactedMessages: messages, summary: null, removedCount: 0 };
    }

    // Always keep the first message (system/context) and last few messages
    const systemMessages = messages.filter(m => m.role === 'system');
    const nonSystemMessages = messages.filter(m => m.role !== 'system');
    
    // Keep last N messages that fit within target
    let keptMessages = [];
    let currentTokens = 0;
    
    // Add system messages first
    for (const msg of systemMessages) {
      const tokens = this.estimateTokenCount([msg], model);
      if (currentTokens + tokens <= targetTokens) {
        keptMessages.push(msg);
        currentTokens += tokens;
      }
    }

    // Add recent messages from the end
    for (let i = nonSystemMessages.length - 1; i >= 0; i--) {
      const msg = nonSystemMessages[i];
      const tokens = this.estimateTokenCount([msg], model);
      
      if (currentTokens + tokens <= targetTokens) {
        keptMessages.unshift(msg);
        currentTokens += tokens;
      } else {
        break;
      }
    }

    const removedCount = messages.length - keptMessages.length;
    const summary = removedCount > 0 
      ? `[Removed ${removedCount} earlier messages to manage conversation length]`
      : null;

    return {
      compactedMessages: keptMessages,
      summary,
      removedCount,
      tokensAfter: currentTokens
    };
  }

  /**
   * Compact messages using importance-based filtering
   * @param {Array} messages - Messages to compact
   * @param {number} targetTokens - Target token count after compaction
   * @param {Object} model - Model configuration
   * @returns {Object} Compaction result
   */
  compactByImportance(messages, targetTokens, model) {
    const analyzedMessages = this.analyzeMessageImportance(messages);
    
    // Always keep system messages and recent messages
    const systemMessages = analyzedMessages.filter(m => m.role === 'system');
    const recentMessages = analyzedMessages.slice(-4); // Keep last 4 messages
    const middleMessages = analyzedMessages.slice(systemMessages.length, -4);

    // Sort middle messages by importance
    const sortedMiddle = middleMessages.sort((a, b) => b.importance - a.importance);

    let compactedMessages = [...systemMessages];
    let currentTokens = this.estimateTokenCount(systemMessages, model);

    // Add important middle messages
    for (const msg of sortedMiddle) {
      const tokens = this.estimateTokenCount([msg], model);
      if (currentTokens + tokens <= targetTokens - this.estimateTokenCount(recentMessages, model)) {
        compactedMessages.push(msg);
        currentTokens += tokens;
      }
    }

    // Add recent messages
    compactedMessages.push(...recentMessages);
    currentTokens += this.estimateTokenCount(recentMessages, model);

    // Sort back to chronological order
    compactedMessages.sort((a, b) => {
      const aIndex = messages.findIndex(m => m.id === a.id);
      const bIndex = messages.findIndex(m => m.id === b.id);
      return aIndex - bIndex;
    });

    const removedCount = messages.length - compactedMessages.length;
    const summary = removedCount > 0 
      ? `[Removed ${removedCount} less important messages to focus on key conversation points]`
      : null;

    return {
      compactedMessages,
      summary,
      removedCount,
      tokensAfter: currentTokens
    };
  }

  /**
   * Compact messages using LLM-powered summarization
   * @param {Array} messages - Messages to compact
   * @param {number} targetTokens - Target token count after compaction
   * @param {Object} model - Model configuration
   * @param {string} apiKey - API key for the compaction model
   * @returns {Object} Compaction result
   */
  async compactWithLLM(messages, targetTokens, model, apiKey) {
    if (messages.length <= 3) {
      return { compactedMessages: messages, summary: null, removedCount: 0 };
    }

    try {
      // Use a fast, cheap model for summarization
      const models = configCache.getModels().data || [];
      const compactionModel = models.find(m => m.id === this.defaultCompactionModel) || models[0];
      
      if (!compactionModel) {
        throw new Error('No compaction model available');
      }

      // Always keep system messages and last 2 messages
      const systemMessages = messages.filter(m => m.role === 'system');
      const recentMessages = messages.slice(-2);
      const messagesToSummarize = messages.slice(
        systemMessages.length, 
        messages.length - 2
      );

      if (messagesToSummarize.length === 0) {
        return { compactedMessages: messages, summary: null, removedCount: 0 };
      }

      // Prepare conversation for summarization
      let conversationText = '';
      for (const msg of messagesToSummarize) {
        const role = msg.role === 'user' ? 'User' : 'Assistant';
        conversationText += `${role}: ${msg.content || ''}\n\n`;
      }

      const summarizationPrompt = `Please create a concise summary of this conversation that preserves the key points, decisions, and context needed to continue the discussion. Focus on:
- Main topics discussed
- Important decisions or conclusions reached
- Key technical details or code mentioned
- Any specific requests or requirements

Conversation to summarize:
${conversationText}

Summary:`;

      const summarizationMessages = [
        { role: 'user', content: summarizationPrompt }
      ];

      const request = createCompletionRequest(compactionModel, summarizationMessages, apiKey, {
        stream: false,
        maxTokens: Math.min(500, Math.floor(targetTokens * 0.3)) // Use up to 30% of target for summary
      });

      const response = await throttledFetch(compactionModel.id, request.url, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(request.body)
      });

      if (!response.ok) {
        throw new Error(`Summarization failed: ${response.status}`);
      }

      const responseData = await response.json();
      const summary = this.extractCompletionContent(responseData, compactionModel.provider);

      // Create compacted conversation
      const summaryMessage = {
        id: `summary-${Date.now()}`,
        role: 'assistant',
        content: `**[Conversation Summary]**\n\n${summary}`,
        isCompactionSummary: true
      };

      const compactedMessages = [
        ...systemMessages,
        summaryMessage,
        ...recentMessages
      ];

      return {
        compactedMessages,
        summary: `Summarized ${messagesToSummarize.length} messages into context-preserving summary`,
        removedCount: messagesToSummarize.length,
        tokensAfter: this.estimateTokenCount(compactedMessages, model)
      };

    } catch (error) {
      console.error('LLM compaction failed, falling back to sliding window:', error);
      // Fallback to sliding window compaction
      return this.compactSlidingWindow(messages, targetTokens, model);
    }
  }

  /**
   * Extract completion content from different provider responses
   * @param {Object} responseData - Raw response from LLM provider
   * @param {string} provider - Provider name
   * @returns {string} Extracted content
   */
  extractCompletionContent(responseData, provider) {
    switch (provider?.toLowerCase()) {
      case 'openai':
        return responseData.choices?.[0]?.message?.content || '';
      case 'anthropic':
        return responseData.content?.[0]?.text || '';
      case 'google':
        return responseData.candidates?.[0]?.content?.parts?.[0]?.text || '';
      case 'mistral':
        return responseData.choices?.[0]?.message?.content || '';
      default:
        return responseData.choices?.[0]?.message?.content || 
               responseData.content?.[0]?.text || 
               '';
    }
  }

  /**
   * Perform automatic compaction based on strategy and thresholds
   * @param {Array} messages - Messages to potentially compact
   * @param {Object} model - Model configuration
   * @param {Object} app - App configuration
   * @param {string} strategy - Compaction strategy ('llm', 'importance', 'sliding')
   * @param {string} apiKey - API key for LLM compaction
   * @returns {Object} Compaction result or null if no compaction needed
   */
  async performAutoCompaction(messages, model, app, strategy = 'sliding', apiKey = null) {
    const currentTokens = this.estimateTokenCount(messages, model);
    const thresholds = this.getCompactionThresholds(model, app);
    
    // Only compact if we're above the auto-compact threshold
    if (currentTokens < thresholds.autoCompactThreshold) {
      return null;
    }

    const targetTokens = Math.floor(thresholds.maxTokens * 0.6); // Compact to 60% of limit
    
    console.log(`Auto-compacting chat: ${currentTokens} tokens -> target ${targetTokens} tokens (${strategy} strategy)`);

    switch (strategy) {
      case 'llm':
        return await this.compactWithLLM(messages, targetTokens, model, apiKey);
      case 'importance':
        return this.compactByImportance(messages, targetTokens, model);
      default:
        return this.compactSlidingWindow(messages, targetTokens, model);
    }
  }

  /**
   * Perform manual compaction with specified parameters
   * @param {Array} messages - Messages to compact
   * @param {Object} options - Compaction options
   * @returns {Object} Compaction result
   */
  async performManualCompaction(messages, options = {}) {
    const {
      strategy = 'sliding',
      targetPercentage = 50,
      model,
      app,
      apiKey
    } = options;

    const thresholds = this.getCompactionThresholds(model, app);
    const targetTokens = Math.floor(thresholds.maxTokens * (targetPercentage / 100));

    console.log(`Manual compaction: target ${targetTokens} tokens (${strategy} strategy)`);

    switch (strategy) {
      case 'llm':
        return await this.compactWithLLM(messages, targetTokens, model, apiKey);
      case 'importance':
        return this.compactByImportance(messages, targetTokens, model);
      default:
        return this.compactSlidingWindow(messages, targetTokens, model);
    }
  }

  /**
   * Get compaction status and recommendations for a conversation
   * @param {Array} messages - Current messages
   * @param {Object} model - Model configuration
   * @param {Object} app - App configuration
   * @returns {Object} Status information
   */
  getCompactionStatus(messages, model, app) {
    const currentTokens = this.estimateTokenCount(messages, model);
    const thresholds = this.getCompactionThresholds(model, app);
    
    let status = 'ok';
    let recommendation = null;
    
    if (currentTokens >= thresholds.forceCompactThreshold) {
      status = 'critical';
      recommendation = 'Immediate compaction recommended - approaching token limit';
    } else if (currentTokens >= thresholds.autoCompactThreshold) {
      status = 'warning';
      recommendation = 'Consider compacting conversation to maintain performance';
    } else if (currentTokens >= thresholds.warningThreshold) {
      status = 'notice';
      recommendation = 'Conversation is getting long - compaction may be beneficial';
    }

    return {
      currentTokens,
      maxTokens: thresholds.maxTokens,
      percentage: Math.round((currentTokens / thresholds.maxTokens) * 100),
      status,
      recommendation,
      thresholds
    };
  }
}

export default CompactionService;