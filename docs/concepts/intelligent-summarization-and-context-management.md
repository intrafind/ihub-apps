# Intelligent Summarization and Context Management Concept

## Overview

This document outlines the implementation strategy for intelligent summarization support and context window management in AI Hub Apps. The solution addresses the critical challenge of handling long documents and preventing context window overflow while maintaining conversation quality.

## Problem Statement

### Current Issues
- **Context Window Overflow**: Long documents can exceed LLM context limits, causing request failures
- **Inaccurate Token Counting**: Current word-count estimation doesn't match actual tokenization
- **No Context Awareness**: System doesn't track or manage context window usage
- **Tool Output Bloat**: Large tool responses can consume excessive context space
- **Poor User Experience**: No feedback when requests fail due to context limits

### Impact
- Failed requests when processing large documents
- Suboptimal summarization capabilities
- No visibility into context window usage
- Poor user experience with unclear error messages

## Solution Architecture

### Core Components

#### 1. Token Counting Service (`/server/utils/TokenCounter.js`)
**Purpose**: Accurate, model-specific token counting to replace word-count estimation.

```javascript
class TokenCounter {
  static getEncoding(modelFamily) // Get tokenizer for model family
  static countTokens(text, modelFamily) // Count tokens accurately
  static estimateTokens(messages, systemPrompt, modelFamily) // Full context estimation
}
```

**Features**:
- Model-specific tokenizers (GPT-4, Claude, Gemini)
- Accurate token counting using `tiktoken` library
- Context calculation including system prompts, history, and tool outputs
- Performance optimized with caching

#### 2. Summarization Tool (`/server/tools/summarizer.js`)
**Purpose**: Universal summarization tool available to all apps.

```javascript
// Tool Configuration
{
  "id": "summarizer",
  "name": "Content Summarizer",
  "description": "Intelligently summarizes long content while preserving key information",
  "parameters": {
    "content": { "type": "string", "description": "Content to summarize" },
    "targetLength": { "type": "number", "default": 500, "description": "Target summary length in tokens" },
    "style": { "type": "string", "enum": ["bullet", "paragraph", "detailed"], "default": "paragraph" },
    "focus": { "type": "string", "description": "Specific aspect to focus on (optional)" }
  }
}
```

**Capabilities**:
- Hierarchical summarization for very large content
- Query-guided summarization with focus areas
- Multiple output formats (bullets, paragraphs, detailed analysis)
- Token-aware output sizing
- Preservation of critical information and context

#### 3. Context Manager (`/server/services/ContextManager.js`)
**Purpose**: Intelligent context window management with automatic optimization.

```javascript
class ContextManager {
  validateContextWindow(messages, systemPrompt, modelConfig) // Pre-request validation
  optimizeContext(messages, targetTokens, modelFamily) // Intelligent context reduction
  compactMessages(messages, compressionRatio) // Message compaction
  summarizeToolOutputs(toolOutputs, maxTokens) // Tool output summarization
  calculateTokenBudget(totalTokens, modelLimit) // Budget allocation
}
```

**Features**:
- Pre-request context validation
- Automatic message compaction at 80% usage threshold
- Tool output summarization for large responses
- Intelligent message prioritization
- User notification for context limitations

#### 4. Enhanced Usage Tracking (`/server/utils/usageTracker.js`)
**Purpose**: Real-time context window monitoring and analytics.

**New Metrics**:
```javascript
{
  contextUsage: {
    totalTokens: 15420,
    contextLimit: 20000,
    usagePercentage: 77.1,
    breakdown: {
      systemPrompt: 850,
      chatHistory: 8200,
      currentInput: 2370,
      toolOutputs: 4000
    },
    compactionApplied: false,
    toolOutputsSummarized: true
  }
}
```

**Logging Features**:
- Real-time context window usage tracking
- Breakdown by context components
- Context optimization events logging
- Performance impact monitoring
- User notification logging

### Implementation Strategy

#### Phase 1: Foundation (Week 1)
**Token Counting Infrastructure**

1. **Install Dependencies**
   ```bash
   npm install tiktoken
   ```

2. **Create TokenCounter Service**
   - Implement model-specific tokenizers
   - Add context calculation methods
   - Create token budget allocation logic

3. **Update Model Configurations**
   ```json
   {
     "models": [
       {
         "id": "gpt-4-turbo",
         "contextLimit": 128000,
         "maxOutputTokens": 4096,
         "tokenFamily": "gpt-4",
         "safetyMargin": 0.9
       }
     ]
   }
   ```

#### Phase 2: Context Management (Week 2)
**Intelligent Context Window Handling**

1. **Create ContextManager Service**
   - Pre-request context validation
   - Context optimization algorithms
   - Message compaction strategies

2. **Update ChatService Integration**
   ```javascript
   // In ChatService.processChat()
   const contextValidation = await ContextManager.validateContextWindow(
     messages, systemPrompt, modelConfig
   );
   
   if (contextValidation.exceedsLimit || contextValidation.usagePercentage > 80) {
     messages = await ContextManager.optimizeContext(messages, modelConfig);
   }
   ```

3. **Enhance Usage Tracking**
   - Add context window metrics
   - Real-time usage percentage calculation
   - Context optimization event logging

#### Phase 3: Summarization Tool (Week 3)
**Universal Summarization Capability**

1. **Implement Summarizer Tool**
   - Token-aware summarization
   - Multiple output formats
   - Hierarchical processing for large content

2. **Add Tool Configuration**
   ```json
   {
     "id": "summarizer",
     "script": "summarizer.js",
     "parameters": { /* schema */ },
     "autoAvailable": true // Available to all apps
   }
   ```

3. **Integration with Context Manager**
   - Automatic tool output summarization
   - Context-aware target lengths
   - Quality preservation algorithms

#### Phase 4: User Experience (Week 4)
**Enhanced Feedback and Notifications**

1. **Context Usage Display**
   ```javascript
   // Client-side context indicator
   <ContextUsageIndicator 
     usage={contextUsage.usagePercentage}
     limit={contextUsage.contextLimit}
     optimized={contextUsage.compactionApplied}
   />
   ```

2. **User Notifications**
   - Context limit warnings at 80% usage
   - Automatic optimization notifications
   - Failed request context explanations

3. **Enhanced Error Messages**
   - Context-specific error descriptions
   - Suggested optimizations
   - Retry options with summarization

### Technical Implementation Details

#### Token Counting Implementation
```javascript
// /server/utils/TokenCounter.js
import { encoding_for_model, get_encoding } from "tiktoken";

export class TokenCounter {
  static encodingCache = new Map();
  
  static getEncoding(modelFamily) {
    if (this.encodingCache.has(modelFamily)) {
      return this.encodingCache.get(modelFamily);
    }
    
    let encoding;
    switch (modelFamily) {
      case 'gpt-4':
      case 'gpt-3.5':
        encoding = encoding_for_model('gpt-4');
        break;
      case 'claude':
        encoding = get_encoding('cl100k_base'); // Approximation
        break;
      case 'gemini':
        encoding = get_encoding('cl100k_base'); // Approximation
        break;
      default:
        encoding = get_encoding('cl100k_base');
    }
    
    this.encodingCache.set(modelFamily, encoding);
    return encoding;
  }
  
  static countTokens(text, modelFamily) {
    const encoding = this.getEncoding(modelFamily);
    return encoding.encode(text).length;
  }
  
  static estimateContextTokens(messages, systemPrompt, modelFamily) {
    let totalTokens = 0;
    
    // System prompt tokens
    if (systemPrompt) {
      totalTokens += this.countTokens(systemPrompt, modelFamily);
    }
    
    // Message tokens
    for (const message of messages) {
      totalTokens += this.countTokens(JSON.stringify(message), modelFamily);
    }
    
    return totalTokens;
  }
}
```

#### Context Manager Implementation
```javascript
// /server/services/ContextManager.js
import { TokenCounter } from '../utils/TokenCounter.js';

export class ContextManager {
  static async validateContextWindow(messages, systemPrompt, modelConfig) {
    const totalTokens = TokenCounter.estimateContextTokens(
      messages, systemPrompt, modelConfig.tokenFamily
    );
    
    const contextLimit = modelConfig.contextLimit * (modelConfig.safetyMargin || 0.9);
    const usagePercentage = (totalTokens / contextLimit) * 100;
    
    return {
      totalTokens,
      contextLimit: modelConfig.contextLimit,
      usagePercentage,
      exceedsLimit: totalTokens > contextLimit,
      needsOptimization: usagePercentage > 80,
      breakdown: this.calculateTokenBreakdown(messages, systemPrompt, modelConfig.tokenFamily)
    };
  }
  
  static async optimizeContext(messages, modelConfig) {
    // Strategy 1: Summarize tool outputs
    messages = await this.summarizeToolOutputs(messages, modelConfig);
    
    // Strategy 2: Compact older messages
    if (this.stillExceedsLimit(messages, modelConfig)) {
      messages = await this.compactMessages(messages, 0.7, modelConfig);
    }
    
    // Strategy 3: Remove oldest messages (keeping recent context)
    if (this.stillExceedsLimit(messages, modelConfig)) {
      messages = this.truncateOldMessages(messages, modelConfig);
    }
    
    return messages;
  }
  
  static async summarizeToolOutputs(messages, modelConfig) {
    const maxToolOutputTokens = Math.floor(modelConfig.contextLimit * 0.1); // 10% budget
    
    for (let message of messages) {
      if (message.role === 'tool') {
        const tokens = TokenCounter.countTokens(message.content, modelConfig.tokenFamily);
        if (tokens > maxToolOutputTokens) {
          // Use summarizer tool to compress output
          message.content = await this.summarizeContent(
            message.content, 
            maxToolOutputTokens, 
            modelConfig
          );
          message.summarized = true;
        }
      }
    }
    
    return messages;
  }
}
```

#### Summarizer Tool Implementation
```javascript
// /server/tools/summarizer.js
import { TokenCounter } from '../utils/TokenCounter.js';

export default async function summarizer(params, context) {
  const { 
    content, 
    targetLength = 500, 
    style = 'paragraph', 
    focus 
  } = params;
  
  const { actionTracker, appConfig } = context;
  
  try {
    actionTracker?.reportProgress('Analyzing content for summarization...');
    
    // Check if content needs summarization
    const tokenCount = TokenCounter.countTokens(content, 'gpt-4');
    if (tokenCount <= targetLength) {
      return {
        summary: content,
        originalTokens: tokenCount,
        summaryTokens: tokenCount,
        compressionRatio: 1.0,
        summarized: false
      };
    }
    
    actionTracker?.reportProgress('Generating intelligent summary...');
    
    // Build summarization prompt based on style and focus
    const prompt = this.buildSummarizationPrompt(content, targetLength, style, focus);
    
    // Use the same LLM adapter that the current app is using
    const summary = await this.callLLMForSummarization(prompt, context);
    
    const summaryTokens = TokenCounter.countTokens(summary, 'gpt-4');
    const compressionRatio = summaryTokens / tokenCount;
    
    actionTracker?.reportProgress('Summarization complete');
    
    return {
      summary,
      originalTokens: tokenCount,
      summaryTokens,
      compressionRatio,
      summarized: true,
      style,
      focus: focus || 'general'
    };
    
  } catch (error) {
    throw new Error(`Summarization failed: ${error.message}`);
  }
}
```

### Context Usage Monitoring

#### Enhanced Usage Tracking
```javascript
// Enhanced usageTracker.js additions
export function recordContextUsage(usage) {
  const timestamp = new Date().toISOString();
  
  // Log context usage for monitoring
  console.log(`[CONTEXT] ${timestamp} - Usage: ${usage.usagePercentage.toFixed(1)}% (${usage.totalTokens}/${usage.contextLimit} tokens)`);
  
  if (usage.usagePercentage > 80) {
    console.warn(`[CONTEXT] High context usage detected - optimization may be applied`);
  }
  
  if (usage.compactionApplied) {
    console.info(`[CONTEXT] Context compaction applied - ${usage.compactionRatio}x compression`);
  }
  
  if (usage.toolOutputsSummarized) {
    console.info(`[CONTEXT] Tool outputs summarized to prevent overflow`);
  }
  
  // Store in usage data for analytics
  const usageData = loadUsageData();
  usageData.contextUsage = usageData.contextUsage || [];
  usageData.contextUsage.push({
    timestamp,
    ...usage
  });
  
  // Keep only last 1000 context usage records
  if (usageData.contextUsage.length > 1000) {
    usageData.contextUsage = usageData.contextUsage.slice(-1000);
  }
  
  saveUsageData(usageData);
}
```

#### User Notifications
```javascript
// Context-aware error handling in ChatService
if (contextValidation.exceedsLimit) {
  return {
    error: true,
    code: 'CONTEXT_LIMIT_EXCEEDED',
    message: `Request exceeds context window limit (${contextValidation.totalTokens} > ${contextValidation.contextLimit} tokens)`,
    details: {
      totalTokens: contextValidation.totalTokens,
      contextLimit: contextValidation.contextLimit,
      breakdown: contextValidation.breakdown,
      suggestions: [
        'Try summarizing your input or uploaded documents',
        'Use shorter conversation history',
        'Break down complex requests into smaller parts'
      ]
    }
  };
}

if (contextValidation.needsOptimization) {
  // Apply optimization and notify user
  messages = await ContextManager.optimizeContext(messages, modelConfig);
  
  // Include optimization notice in response
  response.contextOptimization = {
    applied: true,
    originalTokens: contextValidation.totalTokens,
    optimizedTokens: newTokenCount,
    optimizations: ['tool_output_summarization', 'message_compaction']
  };
}
```

### Configuration Updates

#### Tool Configuration (`/contents/config/tools.json`)
```json
{
  "tools": [
    {
      "id": "summarizer",
      "name": {
        "en": "Content Summarizer",
        "de": "Inhaltszusammenfassung"
      },
      "description": {
        "en": "Intelligently summarizes long content while preserving key information",
        "de": "Fasst lange Inhalte intelligent zusammen und bewahrt wichtige Informationen"
      },
      "script": "summarizer.js",
      "parameters": {
        "type": "object",
        "properties": {
          "content": {
            "type": "string",
            "description": "Content to summarize"
          },
          "targetLength": {
            "type": "number",
            "default": 500,
            "minimum": 100,
            "maximum": 2000,
            "description": "Target summary length in tokens"
          },
          "style": {
            "type": "string",
            "enum": ["bullet", "paragraph", "detailed"],
            "default": "paragraph",
            "description": "Summary format style"
          },
          "focus": {
            "type": "string",
            "description": "Specific aspect to focus on (optional)"
          }
        },
        "required": ["content"]
      },
      "autoAvailable": true,
      "category": "content"
    }
  ]
}
```

#### Model Configuration Updates (`/contents/config/models.json`)
```json
{
  "models": [
    {
      "id": "gpt-4-turbo",
      "name": "GPT-4 Turbo",
      "contextLimit": 128000,
      "maxOutputTokens": 4096,
      "tokenFamily": "gpt-4",
      "safetyMargin": 0.9,
      "contextManagement": {
        "enabled": true,
        "optimizationThreshold": 80,
        "maxToolOutputTokens": 5000,
        "compactionRatio": 0.7
      }
    },
    {
      "id": "claude-3-sonnet",
      "name": "Claude 3 Sonnet",
      "contextLimit": 200000,
      "maxOutputTokens": 4096,
      "tokenFamily": "claude",
      "safetyMargin": 0.9,
      "contextManagement": {
        "enabled": true,
        "optimizationThreshold": 85,
        "maxToolOutputTokens": 8000,
        "compactionRatio": 0.6
      }
    }
  ]
}
```

## Benefits

### For Users
- **Reliable Large Document Processing**: No more failed requests due to context limits
- **Transparent Context Usage**: Clear visibility into context window consumption
- **Intelligent Optimization**: Automatic optimization without losing important information
- **Better Error Handling**: Clear explanations and suggestions when limits are reached
- **Universal Summarization**: Access to summarization capabilities across all apps

### For Developers
- **Accurate Token Counting**: Proper tokenization instead of word-count estimation
- **Context Awareness**: Real-time monitoring of context window usage
- **Automated Optimization**: Intelligent context management without manual intervention
- **Enhanced Analytics**: Detailed metrics for optimization and troubleshooting
- **Extensible Architecture**: Framework for future context management features

### For Operations
- **Proactive Monitoring**: Early detection of context window issues
- **Performance Optimization**: Reduced failed requests and improved user experience
- **Cost Management**: More efficient token usage through intelligent optimization
- **Troubleshooting**: Detailed logging for debugging context-related issues

## Success Metrics

### Technical Metrics
- **Context Window Utilization**: Average usage percentage across requests
- **Optimization Frequency**: How often automatic optimization is applied
- **Failed Request Reduction**: Decrease in context-limit-related failures
- **Token Accuracy**: Improvement in token counting precision
- **Response Time Impact**: Performance impact of context management

### User Experience Metrics
- **Request Success Rate**: Percentage of requests that complete successfully
- **User Satisfaction**: Feedback on summarization quality and context handling
- **Feature Adoption**: Usage of summarization tool across apps
- **Error Resolution**: Time to resolve context-related issues

### Operational Metrics
- **Support Ticket Reduction**: Fewer context-limit-related support requests
- **System Reliability**: Improved overall system stability
- **Resource Utilization**: More efficient use of LLM tokens and API calls

## Implementation Timeline

### Week 1: Foundation
- [ ] Install tiktoken dependency
- [ ] Implement TokenCounter service
- [ ] Update model configurations with accurate limits
- [ ] Add basic context validation to ChatService

### Week 2: Context Management
- [ ] Create ContextManager service
- [ ] Implement context optimization strategies
- [ ] Enhance usage tracking with context metrics
- [ ] Add context-aware error handling

### Week 3: Summarization Tool
- [ ] Implement summarizer tool
- [ ] Add tool configuration and registration
- [ ] Integrate automatic tool output summarization
- [ ] Test summarization quality and performance

### Week 4: User Experience
- [ ] Add client-side context usage indicators
- [ ] Implement user notifications for context optimization
- [ ] Enhance error messages with context information
- [ ] Create documentation and user guides

### Week 5: Testing & Optimization
- [ ] Comprehensive testing with large documents
- [ ] Performance optimization and caching
- [ ] Analytics and monitoring setup
- [ ] User acceptance testing

## Conclusion

This comprehensive approach to intelligent summarization and context management addresses the core challenges of handling large documents while maintaining conversation quality. By implementing accurate token counting, intelligent context optimization, and universal summarization capabilities, AI Hub Apps will provide a more reliable and user-friendly experience for processing long-form content.

The phased implementation approach ensures minimal disruption to existing functionality while providing immediate benefits. The extensible architecture also supports future enhancements and additional context management features.