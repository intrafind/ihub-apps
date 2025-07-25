import { TokenCounter } from '../utils/TokenCounter.js';

/**
 * ContextManager - Intelligent context window management
 * Handles context validation, optimization, and user notifications
 */
export class ContextManager {
  /**
   * Validate if request fits within context window
   * @param {Array} messages - Chat messages
   * @param {string} systemPrompt - System prompt
   * @param {Object} modelConfig - Model configuration
   * @param {string} additionalInput - Additional input to be added
   * @returns {Object} Validation result with recommendations
   */
  static async validateContextWindow(messages, systemPrompt, modelConfig, additionalInput = '') {
    const validation = TokenCounter.validateContextWindow(
      messages,
      systemPrompt,
      modelConfig,
      additionalInput
    );

    // Add context-specific recommendations
    validation.recommendations = this.generateRecommendations(validation);
    validation.canOptimize = this.assessOptimizationPotential(validation);

    return validation;
  }

  /**
   * Optimize context to fit within limits using intelligent strategies
   * @param {Array} messages - Chat messages to optimize
   * @param {Object} modelConfig - Model configuration
   * @param {string} systemPrompt - System prompt
   * @returns {Object} Optimization result
   */
  static async optimizeContext(messages, modelConfig, systemPrompt = '') {
    const originalValidation = await this.validateContextWindow(
      messages,
      systemPrompt,
      modelConfig
    );

    if (!originalValidation.needsOptimization && !originalValidation.exceedsLimit) {
      return {
        messages,
        applied: false,
        reason: 'No optimization needed',
        originalTokens: originalValidation.totalTokens,
        optimizedTokens: originalValidation.totalTokens,
        strategies: []
      };
    }

    console.log(`[CONTEXT] Starting optimization - ${originalValidation.usagePercentage}% usage`);

    let optimizedMessages = [...messages];
    const appliedStrategies = [];

    // Strategy 1: Summarize large tool outputs
    if (originalValidation.toolOutputTokens > originalValidation.totalTokens * 0.2) {
      console.log('[CONTEXT] Applying tool output summarization...');
      optimizedMessages = await this.summarizeToolOutputs(optimizedMessages, modelConfig);
      appliedStrategies.push('tool_output_summarization');
    }

    // Strategy 2: Compact older messages if still needed
    const midValidation = await this.validateContextWindow(
      optimizedMessages,
      systemPrompt,
      modelConfig
    );
    if (midValidation.needsOptimization || midValidation.exceedsLimit) {
      console.log('[CONTEXT] Applying message compaction...');
      optimizedMessages = await this.compactMessages(optimizedMessages, modelConfig, 0.7);
      appliedStrategies.push('message_compaction');
    }

    // Strategy 3: Truncate oldest messages as last resort
    const finalValidation = await this.validateContextWindow(
      optimizedMessages,
      systemPrompt,
      modelConfig
    );
    if (finalValidation.exceedsLimit) {
      console.log('[CONTEXT] Applying message truncation...');
      optimizedMessages = this.truncateOldMessages(optimizedMessages, modelConfig, systemPrompt);
      appliedStrategies.push('message_truncation');
    }

    const finalTokens = TokenCounter.estimateContextTokens(
      optimizedMessages,
      systemPrompt,
      modelConfig.tokenFamily
    ).totalTokens;
    const tokensSaved = originalValidation.totalTokens - finalTokens;
    const compressionRatio = finalTokens / originalValidation.totalTokens;

    console.log(
      `[CONTEXT] Optimization complete - saved ${tokensSaved} tokens (${Math.round((1 - compressionRatio) * 100)}% reduction)`
    );

    return {
      messages: optimizedMessages,
      applied: appliedStrategies.length > 0,
      strategies: appliedStrategies,
      originalTokens: originalValidation.totalTokens,
      optimizedTokens: finalTokens,
      tokensSaved,
      compressionRatio: Math.round(compressionRatio * 100) / 100,
      finalUsage: await this.validateContextWindow(optimizedMessages, systemPrompt, modelConfig)
    };
  }

  /**
   * Summarize large tool outputs to reduce context usage
   * @param {Array} messages - Messages array
   * @param {Object} modelConfig - Model configuration
   * @returns {Array} Messages with summarized tool outputs
   */
  static async summarizeToolOutputs(messages, modelConfig) {
    const maxToolOutputTokens = Math.floor(modelConfig.contextLimit * 0.1); // 10% budget for tool outputs
    const optimizedMessages = [];

    for (const message of messages) {
      if (message.role === 'tool') {
        const contentStr =
          typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
        const tokens = TokenCounter.countTokens(contentStr, modelConfig.tokenFamily);

        if (tokens > maxToolOutputTokens) {
          console.log(
            `[CONTEXT] Summarizing tool output: ${tokens} -> ~${maxToolOutputTokens} tokens`
          );

          // Create a summarized version
          const summarized = await this.summarizeContent(
            contentStr,
            maxToolOutputTokens,
            modelConfig,
            `tool output from ${message.tool_call_id || 'unknown tool'}`
          );

          optimizedMessages.push({
            ...message,
            content: summarized,
            original_token_count: tokens,
            summarized: true,
            summarized_at: new Date().toISOString()
          });
        } else {
          optimizedMessages.push(message);
        }
      } else {
        optimizedMessages.push(message);
      }
    }

    return optimizedMessages;
  }

  /**
   * Compact older messages using simple concatenation approach
   * Simplified approach that combines multiple consecutive messages from the same role
   * @param {Array} messages - Messages to compact
   * @param {Object} modelConfig - Model configuration
   * @param {number} compressionRatio - Target compression ratio
   * @returns {Array} Compacted messages
   */
  static async compactMessages(messages, modelConfig, compressionRatio = 0.7) {
    if (messages.length <= 4) {
      return messages; // Keep at least recent context
    }

    // Keep the most recent messages intact (last 2-3 messages)
    const recentCount = Math.min(3, Math.ceil(messages.length * 0.25));
    const recentMessages = messages.slice(-recentCount);
    const olderMessages = messages.slice(0, -recentCount);

    if (olderMessages.length === 0) {
      return messages;
    }

    console.log(`[CONTEXT] Compacting ${olderMessages.length} older messages`);

    // Simple approach: combine consecutive messages from same role
    const compactedMessages = [];
    let currentGroup = null;

    for (const message of olderMessages) {
      // Skip system messages - they should be preserved
      if (message.role === 'system') {
        if (currentGroup) {
          compactedMessages.push(this.createCompactedMessage(currentGroup));
          currentGroup = null;
        }
        compactedMessages.push(message);
        continue;
      }

      // Start new group or add to existing group
      if (!currentGroup || currentGroup.role !== message.role) {
        if (currentGroup) {
          compactedMessages.push(this.createCompactedMessage(currentGroup));
        }
        currentGroup = {
          role: message.role,
          messages: [message],
          totalTokens: TokenCounter.countTokens(
            typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
            modelConfig.tokenFamily
          )
        };
      } else {
        // Add to current group
        currentGroup.messages.push(message);
        currentGroup.totalTokens += TokenCounter.countTokens(
          typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
          modelConfig.tokenFamily
        );
      }
    }

    // Add the last group
    if (currentGroup) {
      compactedMessages.push(this.createCompactedMessage(currentGroup));
    }

    return [...compactedMessages, ...recentMessages];
  }

  /**
   * Create a compacted message from a group of messages
   * @param {Object} group - Group of messages with same role
   * @returns {Object} Compacted message
   */
  static createCompactedMessage(group) {
    if (group.messages.length === 1) {
      return group.messages[0];
    }

    // Combine content from multiple messages
    const combinedContent = group.messages
      .map(msg => (typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)))
      .join('\n\n---\n\n'); // Separator between combined messages

    return {
      role: group.role,
      content: combinedContent,
      compacted: true,
      original_message_count: group.messages.length,
      compacted_at: new Date().toISOString()
    };
  }

  /**
   * Truncate oldest messages as last resort
   * @param {Array} messages - Messages array
   * @param {Object} modelConfig - Model configuration
   * @param {string} systemPrompt - System prompt
   * @returns {Array} Truncated messages
   */
  static truncateOldMessages(messages, modelConfig, systemPrompt) {
    const targetTokens = Math.floor(modelConfig.contextLimit * (modelConfig.safetyMargin || 0.9));
    const reserveForOutput = modelConfig.maxOutputTokens || 4096;
    const availableTokens = targetTokens - reserveForOutput;

    // Always preserve the most recent message and system prompt
    let currentTokens = TokenCounter.countTokens(systemPrompt, modelConfig.tokenFamily);
    const preservedMessages = [];

    // Add messages from most recent backwards until we hit the limit
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      const messageTokens = TokenCounter.countTokens(
        TokenCounter.messageToString(message),
        modelConfig.tokenFamily
      );

      if (currentTokens + messageTokens <= availableTokens) {
        preservedMessages.unshift(message);
        currentTokens += messageTokens;
      } else {
        console.log(`[CONTEXT] Truncated ${i + 1} oldest messages`);
        break;
      }
    }

    // Add truncation notice if messages were removed
    if (preservedMessages.length < messages.length) {
      const removedCount = messages.length - preservedMessages.length;
      preservedMessages.unshift({
        role: 'system',
        content: `[Note: ${removedCount} older messages were removed due to context length limits]`,
        truncation_notice: true,
        removed_count: removedCount,
        truncated_at: new Date().toISOString()
      });
    }

    return preservedMessages;
  }

  /**
   * Group messages for efficient compaction
   * @param {Array} messages - Messages to group
   * @returns {Array} Array of message groups
   */
  static groupMessagesForCompaction(messages) {
    const groups = [];
    let currentGroup = [];
    let currentGroupTokens = 0;
    const maxGroupTokens = 2000; // Target group size

    for (const message of messages) {
      const messageTokens = TokenCounter.countTokens(
        TokenCounter.messageToString(message),
        'gpt-4' // Use default for grouping
      );

      if (currentGroupTokens + messageTokens > maxGroupTokens && currentGroup.length > 0) {
        groups.push(currentGroup);
        currentGroup = [message];
        currentGroupTokens = messageTokens;
      } else {
        currentGroup.push(message);
        currentGroupTokens += messageTokens;
      }
    }

    if (currentGroup.length > 0) {
      groups.push(currentGroup);
    }

    return groups;
  }

  /**
   * Summarize content using a simple truncation approach
   * Removes the overengineered keyword detection system that doesn't work with internationalization
   * @param {string} content - Content to summarize
   * @param {number} targetTokens - Target token count
   * @param {Object} modelConfig - Model configuration
   * @param {string} contentType - Type of content being summarized
   * @returns {string} Summarized content
   */
  static async summarizeContent(content, targetTokens, modelConfig, contentType = 'content') {
    const sentences = content.split(/[.!?]+/).filter(s => s.trim().length > 10);

    if (sentences.length <= 2) {
      return content; // Too short to summarize
    }

    // Simple approach: take first and last sentences, then fill middle based on position
    let selectedSentences = [];
    let currentTokens = 0;

    // Always include first sentence if it fits
    if (sentences.length > 0) {
      const firstTokens = TokenCounter.countTokens(sentences[0].trim(), modelConfig.tokenFamily);
      if (firstTokens <= targetTokens) {
        selectedSentences.push({ sentence: sentences[0].trim(), index: 0 });
        currentTokens += firstTokens;
      }
    }

    // Always include last sentence if it fits and we have room
    if (sentences.length > 1) {
      const lastSentence = sentences[sentences.length - 1].trim();
      const lastTokens = TokenCounter.countTokens(lastSentence, modelConfig.tokenFamily);
      if (currentTokens + lastTokens <= targetTokens) {
        selectedSentences.push({ sentence: lastSentence, index: sentences.length - 1 });
        currentTokens += lastTokens;
      }
    }

    // Fill remaining space with middle sentences in order
    for (let i = 1; i < sentences.length - 1; i++) {
      const sentence = sentences[i].trim();
      const sentenceTokens = TokenCounter.countTokens(sentence, modelConfig.tokenFamily);

      if (currentTokens + sentenceTokens <= targetTokens) {
        selectedSentences.push({ sentence, index: i });
        currentTokens += sentenceTokens;
      }
    }

    // Sort back to original order and join
    selectedSentences.sort((a, b) => a.index - b.index);
    const summary = selectedSentences.map(item => item.sentence).join('. ');

    return summary + (summary.endsWith('.') ? '' : '.');
  }

  /**
   * Generate context optimization recommendations
   * @param {Object} validation - Context validation result
   * @returns {Array} Array of recommendations
   */
  static generateRecommendations(validation) {
    const recommendations = [];

    if (validation.exceedsLimit) {
      recommendations.push({
        type: 'error',
        action: 'required',
        title: 'Context Limit Exceeded',
        description: 'Request cannot be processed - exceeds model context window',
        suggestions: [
          'Summarize your input or uploaded documents',
          'Break down the request into smaller parts',
          'Use a model with larger context window'
        ]
      });
    } else if (validation.isNearLimit) {
      recommendations.push({
        type: 'warning',
        action: 'recommended',
        title: 'Context Near Limit',
        description: `Context usage at ${validation.usagePercentage}% - optimization recommended`,
        suggestions: [
          'Consider summarizing long inputs',
          'Clear conversation history if not needed'
        ]
      });
    } else if (validation.needsOptimization) {
      recommendations.push({
        type: 'info',
        action: 'optional',
        title: 'Context Optimization Available',
        description: `Context usage at ${validation.usagePercentage}% - automatic optimization can be applied`,
        suggestions: [
          'Allow automatic context optimization',
          'Manually summarize large tool outputs'
        ]
      });
    }

    // Component-specific recommendations
    if (validation.toolOutputTokens > validation.totalTokens * 0.3) {
      recommendations.push({
        type: 'info',
        action: 'optional',
        title: 'Large Tool Outputs',
        description: `Tool outputs use ${Math.round((validation.toolOutputTokens / validation.totalTokens) * 100)}% of context`,
        suggestions: [
          'Summarize tool outputs before continuing',
          'Process large data in smaller chunks'
        ]
      });
    }

    if (validation.messageTokens > validation.totalTokens * 0.5) {
      recommendations.push({
        type: 'info',
        action: 'optional',
        title: 'Long Conversation History',
        description: `Chat history uses ${Math.round((validation.messageTokens / validation.totalTokens) * 100)}% of context`,
        suggestions: ['Clear old conversation history', 'Start a new conversation for new topics']
      });
    }

    return recommendations;
  }

  /**
   * Assess potential for context optimization
   * @param {Object} validation - Context validation result
   * @returns {Object} Optimization potential assessment
   */
  static assessOptimizationPotential(validation) {
    let potentialSavings = 0;
    const strategies = [];

    // Tool output optimization potential
    if (validation.toolOutputTokens > 0) {
      const toolOptimizationSavings = Math.max(
        0,
        validation.toolOutputTokens - validation.totalTokens * 0.1
      );
      potentialSavings += toolOptimizationSavings;
      if (toolOptimizationSavings > 0) {
        strategies.push('tool_output_summarization');
      }
    }

    // Message compaction potential
    if (validation.messageTokens > validation.totalTokens * 0.3) {
      const messageOptimizationSavings = validation.messageTokens * 0.3; // 30% potential reduction
      potentialSavings += messageOptimizationSavings;
      strategies.push('message_compaction');
    }

    const potentialUsageAfterOptimization =
      ((validation.totalTokens - potentialSavings) / validation.effectiveLimit) * 100;

    return {
      canOptimize: potentialSavings > 0,
      potentialSavings: Math.round(potentialSavings),
      potentialUsageReduction:
        Math.round((potentialSavings / validation.totalTokens) * 100 * 10) / 10,
      estimatedUsageAfterOptimization: Math.max(
        0,
        Math.round(potentialUsageAfterOptimization * 10) / 10
      ),
      availableStrategies: strategies,
      worthwhile: potentialSavings > validation.totalTokens * 0.1 // Only if >10% savings
    };
  }

  /**
   * Create context usage notification for user
   * @param {Object} validation - Context validation result
   * @param {Object} optimization - Optimization result (optional)
   * @returns {Object} User notification
   */
  static createUserNotification(validation, optimization = null) {
    const notification = {
      contextUsage: {
        percentage: validation.usagePercentage,
        tokensUsed: validation.totalTokens,
        tokenLimit: validation.contextLimit,
        breakdown: validation.breakdown
      }
    };

    if (optimization && optimization.applied) {
      notification.optimization = {
        applied: true,
        strategies: optimization.strategies,
        tokensSaved: optimization.tokensSaved,
        compressionRatio: optimization.compressionRatio,
        message: `Context optimized: ${optimization.tokensSaved} tokens saved using ${optimization.strategies.join(', ')}`
      };
    }

    if (validation.warnings && validation.warnings.length > 0) {
      notification.warnings = validation.warnings;
    }

    if (validation.recommendations && validation.recommendations.length > 0) {
      notification.recommendations = validation.recommendations;
    }

    return notification;
  }
}

export default ContextManager;
