# Source Handlers System - Technical Specifications

**Date**: 2025-08-05  
**Purpose**: Detailed technical specifications for fixing critical source handler issues  
**Target Audience**: Implementation developers and junior developers continuing this work

## 1. URLHandler Import Fix - Critical Issue

### Problem Analysis
**File**: `/server/sources/URLHandler.js`  
**Line**: 72  
**Issue**: CommonJS `require()` used in ES module context

```javascript
// BROKEN: CommonJS syntax in ES module
const webTools = require('../tools/web');
```

**Error**: `ReferenceError: require is not defined`

### Solution Specification

#### 1.1 Replace CommonJS Import
**Location**: `URLHandler.js`, method `getWebContentExtractor()`

**Current Code (Lines 69-78)**:
```javascript
async getWebContentExtractor() {
  try {
    // Try to load the existing web content extraction functionality
    const webTools = require('../tools/web');
    return webTools.webContentExtractor;
  } catch {
    // Fallback implementation if tool not available
    return this.createFallbackExtractor();
  }
}
```

**Fixed Code**:
```javascript
async getWebContentExtractor() {
  try {
    // Use ES module dynamic import for webContentExtractor
    const webContentExtractor = await import('../tools/webContentExtractor.js');
    
    // Handle both default and named exports
    if (webContentExtractor.default) {
      return webContentExtractor.default;
    } else if (webContentExtractor.webContentExtractor) {
      return webContentExtractor.webContentExtractor;
    } else {
      // If export structure is different, return the whole module
      return webContentExtractor;
    }
  } catch (error) {
    console.warn(`webContentExtractor tool not available (${error.message}), using fallback`);
    return this.createFallbackExtractor();
  }
}
```

#### 1.2 Verification Steps
1. **Import Test**: Verify webContentExtractor.js exists and is importable
2. **Export Structure**: Confirm export format (default vs named export)
3. **Method Interface**: Ensure extract() method exists and matches expected signature
4. **Error Handling**: Test fallback when webContentExtractor unavailable

#### 1.3 Acceptance Criteria
- ✅ URLHandler imports without errors
- ✅ webContentExtractor integration works
- ✅ Fallback extractor handles missing dependency
- ✅ No breaking changes to existing API

## 2. Handler Registration and Testing

### 2.1 SourceManager Handler Registration
**File**: `/server/sources/SourceManager.js`  
**Lines**: 24-33

**Current State**: All handlers attempt to register, but URLHandler fails during import

**Required Verification**:
```javascript
// In initializeHandlers() method
initializeHandlers() {
  try {
    // Register filesystem handler (currently working)
    this.registerHandler('filesystem', new FileSystemHandler(this.config.filesystem || {}));
    console.log('✅ FileSystemHandler registered successfully');
  } catch (error) {
    console.error('❌ Failed to register FileSystemHandler:', error.message);
  }

  try {
    // Register URL handler (currently failing)
    this.registerHandler('url', new URLHandler(this.config.url || {}));
    console.log('✅ URLHandler registered successfully');
  } catch (error) {
    console.error('❌ Failed to register URLHandler:', error.message);
  }

  try {
    // Register iFinder handler (dependency on iFinder tool)
    this.registerHandler('ifinder', new IFinderHandler(this.config.ifinder || {}));
    console.log('✅ IFinderHandler registered successfully');
  } catch (error) {
    console.error('❌ Failed to register IFinderHandler:', error.message);
  }
}
```

### 2.2 Handler Testing Specifications

#### Test Configuration Objects
```javascript
// Test configurations for each handler type
const testConfigurations = {
  filesystem: {
    type: 'filesystem',
    config: {
      basePath: './configs/backup/sources',
      pattern: '*.md',
      recursive: false,
      allowedExtensions: ['.md', '.txt']
    }
  },
  
  url: {
    type: 'url',
    config: {
      url: 'https://httpbin.org/html',
      options: {
        maxContentLength: 10000,
        cleanContent: true,
        followRedirects: true
      }
    }
  },
  
  ifinder: {
    type: 'ifinder',
    config: {
      query: 'test document',
      searchProfile: 'default',
      maxResults: 1,
      user: {
        id: 'test-user-123',
        email: 'test@example.com',
        groups: ['users']
      },
      chatId: 'test-chat-session-456'
    }
  }
};
```

#### Test Execution Script
```javascript
// Create a test script to validate all handlers
async function testAllHandlers() {
  const { createSourceManager } = await import('./sources/index.js');
  const sourceManager = createSourceManager();
  
  console.log('🧪 Testing Source Handlers...\n');
  
  for (const [handlerType, testConfig] of Object.entries(testConfigurations)) {
    console.log(`Testing ${handlerType} handler...`);
    
    try {
      // Test individual handler
      const handler = sourceManager.getHandler(handlerType);
      console.log(`  ✅ Handler retrieved: ${handler.constructor.name}`);
      
      // Test configuration validation
      const isValid = handler.validateConfig(testConfig.config);
      console.log(`  ✅ Config validation: ${isValid}`);
      
      // Test content loading (skip iFinder for anonymous testing)
      if (handlerType !== 'ifinder') {
        const result = await handler.getCachedContent(testConfig.config);
        console.log(`  ✅ Content loaded: ${result.content.length} characters`);
        console.log(`  ✅ Metadata: ${JSON.stringify(result.metadata, null, 2)}`);
      } else {
        console.log(`  ⏭️  Skipped content loading (requires authenticated user)`);
      }
      
    } catch (error) {
      console.error(`  ❌ ${handlerType} handler failed:`, error.message);
    }
    
    console.log(''); // Empty line for readability
  }
}
```

## 3. Tool Registration Pipeline

### 3.1 Tool Integration Architecture

**Goal**: Make source handlers available as LLM-callable tools

**Implementation Location**: 
- `SourceManager.js` - Add tool generation methods
- `services/chat/ToolExecutor.js` - Register generated tools

#### 3.2 SourceManager Tool Generation
**Add to SourceManager class**:

```javascript
/**
 * Generate tool definitions for LLM tool calling
 * @returns {Array} Array of tool definitions compatible with ToolExecutor
 */
generateToolDefinitions() {
  const tools = [];
  
  for (const [type, handler] of this.handlers) {
    // Skip handlers that require authentication for general tool use
    if (type === 'ifinder') {
      continue; // iFinder requires user context, handle separately
    }
    
    tools.push({
      name: `load_${type}_source`,
      description: `Load content from ${type} source for use in responses`,
      parameters: {
        type: 'object',
        properties: this.getHandlerParameterSchema(type),
        required: this.getHandlerRequiredParameters(type)
      },
      handler: async (params, context) => {
        try {
          const result = await handler.getCachedContent(params);
          return {
            success: true,
            content: result.content,
            metadata: result.metadata
          };
        } catch (error) {
          return {
            success: false,
            error: error.message,
            type: 'source_loading_error'
          };
        }
      }
    });
  }
  
  return tools;
}

/**
 * Get parameter schema for specific handler type
 */
getHandlerParameterSchema(type) {
  switch (type) {
    case 'filesystem':
      return {
        basePath: {
          type: 'string',
          description: 'Base directory path to search for files'
        },
        pattern: {
          type: 'string',
          description: 'File pattern to match (e.g., *.md, *.txt)',
          default: '*'
        },
        recursive: {
          type: 'boolean',
          description: 'Search subdirectories recursively',
          default: false
        }
      };
      
    case 'url':
      return {
        url: {
          type: 'string',
          description: 'HTTP/HTTPS URL to load content from'
        },
        maxContentLength: {
          type: 'number',
          description: 'Maximum content length to extract',
          default: 50000
        },
        cleanContent: {
          type: 'boolean',
          description: 'Clean HTML and extract text content',
          default: true
        }
      };
      
    default:
      return {};
  }
}

/**
 * Get required parameters for handler type
 */
getHandlerRequiredParameters(type) {
  switch (type) {
    case 'filesystem':
      return ['basePath'];
    case 'url':
      return ['url'];
    default:
      return [];
  }
}
```

#### 3.3 ToolExecutor Integration
**Location**: `services/chat/ToolExecutor.js`

**Add source tools registration**:
```javascript
// In ToolExecutor constructor or initialization method
async initializeSourceTools() {
  try {
    const { createSourceManager } = await import('../../sources/index.js');
    const sourceManager = createSourceManager();
    
    // Generate and register source tools
    const sourceTools = sourceManager.generateToolDefinitions();
    
    for (const tool of sourceTools) {
      this.registerTool(tool.name, tool);
      console.log(`🔧 Registered source tool: ${tool.name}`);
    }
    
  } catch (error) {
    console.error('Failed to initialize source tools:', error);
  }
}
```

## 4. Error Handling Enhancement

### 4.1 Centralized Error Classification
**Create**: `/server/sources/SourceError.js`

```javascript
/**
 * Centralized error handling for source operations
 */
export class SourceError extends Error {
  constructor(message, type, sourceConfig = null, originalError = null) {
    super(message);
    this.name = 'SourceError';
    this.type = type;
    this.sourceConfig = sourceConfig;
    this.originalError = originalError;
    this.timestamp = new Date().toISOString();
  }
  
  static types = {
    IMPORT_ERROR: 'import_error',
    CONFIG_ERROR: 'config_error', 
    NETWORK_ERROR: 'network_error',
    AUTH_ERROR: 'auth_error',
    NOT_FOUND: 'not_found',
    TIMEOUT: 'timeout',
    UNKNOWN: 'unknown'
  };
  
  /**
   * Create error from caught exception
   */
  static fromError(error, type = SourceError.types.UNKNOWN, sourceConfig = null) {
    return new SourceError(
      error.message || 'Unknown error occurred',
      type,
      sourceConfig,
      error
    );
  }
  
  /**
   * Convert to JSON for logging/monitoring
   */
  toJSON() {
    return {
      name: this.name,
      message: this.message,
      type: this.type,
      sourceConfig: this.sourceConfig,
      timestamp: this.timestamp,
      stack: this.stack,
      originalError: this.originalError?.message
    };
  }
}
```

### 4.2 Enhanced Error Handling in Handlers
**Update each handler's loadContent method**:

```javascript
// Example for URLHandler
async loadContent(sourceConfig) {
  try {
    // ... existing implementation
  } catch (error) {
    // Classify error type
    let errorType = SourceError.types.UNKNOWN;
    
    if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
      errorType = SourceError.types.NETWORK_ERROR;
    } else if (error.message.includes('timeout')) {
      errorType = SourceError.types.TIMEOUT;
    } else if (error.message.includes('404')) {
      errorType = SourceError.types.NOT_FOUND;
    }
    
    throw new SourceError(
      `Failed to load URL content: ${error.message}`,
      errorType,
      sourceConfig,
      error
    );
  }
}
```

## 5. Testing and Validation

### 5.1 Test Script Creation
**Create**: `/server/sources/test-handlers.js`

```javascript
#!/usr/bin/env node

/**
 * Test script for source handlers system
 * Run with: node server/sources/test-handlers.js
 */

import { createSourceManager } from './index.js';

const testConfigs = {
  filesystem: {
    type: 'filesystem',
    config: {
      basePath: './configs/backup/sources',
      pattern: '*.md'
    }
  },
  url: {
    type: 'url',
    config: {
      url: 'https://httpbin.org/html'
    }
  }
};

async function runTests() {
  console.log('🧪 Source Handlers Test Suite\n');
  
  const sourceManager = createSourceManager();
  let passedTests = 0;
  let totalTests = 0;
  
  // Test 1: Handler Registration
  console.log('Test 1: Handler Registration');
  totalTests += 3;
  
  for (const handlerType of ['filesystem', 'url', 'ifinder']) {
    try {
      const handler = sourceManager.getHandler(handlerType);
      console.log(`  ✅ ${handlerType} handler registered`);
      passedTests++;
    } catch (error) {
      console.log(`  ❌ ${handlerType} handler failed: ${error.message}`);
    }
  }
  
  // Test 2: Content Loading
  console.log('\nTest 2: Content Loading');
  totalTests += 2;
  
  for (const [type, config] of Object.entries(testConfigs)) {
    try {
      const result = await sourceManager.loadSources([config]);
      if (result.content && result.content.length > 0) {
        console.log(`  ✅ ${type} content loaded (${result.content.length} chars)`);
        passedTests++;
      } else {
        console.log(`  ❌ ${type} returned empty content`);
      }
    } catch (error) {
      console.log(`  ❌ ${type} loading failed: ${error.message}`);
    }
  }
  
  // Test 3: Tool Generation
  console.log('\nTest 3: Tool Generation');
  totalTests += 1;
  
  try {
    const tools = sourceManager.generateToolDefinitions();
    if (tools && tools.length > 0) {
      console.log(`  ✅ Generated ${tools.length} tools: ${tools.map(t => t.name).join(', ')}`);
      passedTests++;
    } else {
      console.log(`  ❌ No tools generated`);
    }
  } catch (error) {
    console.log(`  ❌ Tool generation failed: ${error.message}`);
  }
  
  // Summary
  console.log(`\n📊 Test Results: ${passedTests}/${totalTests} passed`);
  
  if (passedTests === totalTests) {
    console.log('🎉 All tests passed! Source handlers system is working correctly.');
    process.exit(0);
  } else {
    console.log('⚠️  Some tests failed. Please review the errors above.');
    process.exit(1);
  }
}

// Handle unhandled errors
process.on('unhandledRejection', (error) => {
  console.error('❌ Unhandled error:', error);
  process.exit(1);
});

runTests().catch(console.error);
```

### 5.2 Validation Checklist

#### Pre-Implementation Validation
- [ ] Verify `/server/tools/webContentExtractor.js` exists
- [ ] Confirm webContentExtractor export structure
- [ ] Check iFinder.js tool availability
- [ ] Validate test content directories exist

#### Post-Implementation Validation  
- [ ] URLHandler imports without errors
- [ ] All three handlers register successfully
- [ ] Content loading works for filesystem and URL sources
- [ ] Caching behavior functions correctly
- [ ] Error handling provides meaningful messages
- [ ] Tool generation pipeline works
- [ ] Integration with PromptService.js remains functional

## 6. Performance Considerations

### 6.1 Caching Strategy Validation
**Verify caching configuration**:
```javascript
// Handler cache configs should be optimized
const cacheConfigs = {
  filesystem: { ttl: 3600, strategy: 'content-based' }, // 1 hour
  url: { ttl: 7200, strategy: 'static' },              // 2 hours  
  ifinder: { ttl: 1800, strategy: 'user-based' }       // 30 minutes
};
```

### 6.2 Memory Management
- Monitor memory usage during batch operations
- Implement content size limits (already in place)
- Consider streaming for large content sources

### 6.3 Error Recovery
- Implement exponential backoff for failed requests
- Cache error states to avoid repeated failures
- Provide circuit breaker pattern for unreliable sources

## Implementation Notes for Junior Developers

### Getting Started
1. **Read the main implementation plan first** - understand the overall context
2. **Start with the URLHandler fix** - it's the most critical and straightforward
3. **Test each change immediately** - don't stack multiple changes without testing
4. **Use the provided test script** - it will catch integration issues early

### Common Pitfalls to Avoid
- Don't change the public API of existing handlers
- Always handle async operations with try-catch
- Maintain backward compatibility with existing app configurations
- Test with real source content, not just mocked data

### Debug Tips
- Use `console.log()` liberally during development
- Check file paths are absolute, not relative
- Verify network connectivity for URL testing
- Ensure test user has proper permissions for iFinder testing

This technical specification provides the detailed implementation guidance needed to fix the critical source handlers issues while maintaining the excellent architectural foundation already in place.