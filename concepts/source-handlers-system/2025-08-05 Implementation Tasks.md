# Source Handlers System - Implementation Tasks Breakdown

**Date**: 2025-08-05  
**Purpose**: Detailed task breakdown for fixing source handlers system  
**Target**: Coder agent and implementation team

## Task Execution Order

### 🚨 CRITICAL TASKS (Execute First)

#### Task 1: Fix URLHandler Import Error
**Priority**: CRITICAL  
**Effort**: 30 minutes  
**Blocker**: Prevents URLHandler from loading

**Files to Modify**:
- `/server/sources/URLHandler.js` (line 72)

**Specific Changes**:
1. **Replace CommonJS require with ES import**:
   ```javascript
   // BEFORE (Line 72):
   const webTools = require('../tools/web');
   
   // AFTER:
   const webContentExtractor = await import('../tools/webContentExtractor.js');
   ```

2. **Update getWebContentExtractor method**:
   ```javascript
   async getWebContentExtractor() {
     try {
       const webContentExtractor = await import('../tools/webContentExtractor.js');
       return webContentExtractor.default || webContentExtractor.webContentExtractor || webContentExtractor;
     } catch (error) {
       console.warn(`webContentExtractor not available: ${error.message}`);
       return this.createFallbackExtractor();
     }
   }
   ```

**Validation Steps**:
1. Start server: `npm run dev`
2. Check for import errors in console
3. Test URL source loading manually

**Success Criteria**:
- [ ] No import errors on server start
- [ ] URLHandler registers successfully
- [ ] URL content can be loaded without errors

#### Task 2: Verify Handler Registration
**Priority**: CRITICAL  
**Effort**: 15 minutes  
**Purpose**: Ensure all handlers register after import fix

**Files to Check**:
- `/server/sources/SourceManager.js` (lines 24-33)

**Validation Actions**:
1. Add logging to `initializeHandlers()`:
   ```javascript
   initializeHandlers() {
     try {
       this.registerHandler('filesystem', new FileSystemHandler(this.config.filesystem || {}));
       console.log('✅ FileSystemHandler registered');
     } catch (error) {
       console.error('❌ FileSystemHandler failed:', error.message);
     }
     
     try {
       this.registerHandler('url', new URLHandler(this.config.url || {}));
       console.log('✅ URLHandler registered');
     } catch (error) {
       console.error('❌ URLHandler failed:', error.message);
     }
     
     try {
       this.registerHandler('ifinder', new IFinderHandler(this.config.ifinder || {}));
       console.log('✅ IFinderHandler registered');
     } catch (error) {
       console.error('❌ IFinderHandler failed:', error.message);
     }
   }
   ```

2. Restart server and check console output

**Success Criteria**:
- [ ] All three handlers show "registered" messages
- [ ] No registration error messages
- [ ] SourceManager.handlers.size === 3

### 🔧 HIGH PRIORITY TASKS

#### Task 3: Create Handler Test Script
**Priority**: HIGH  
**Effort**: 45 minutes  
**Purpose**: Validate all handlers work with real content

**Create New File**: `/server/sources/test-handlers.js`

**Implementation**:
```javascript
#!/usr/bin/env node
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
  console.log('🧪 Testing Source Handlers...\n');
  
  const sourceManager = createSourceManager();
  
  // Test handler registration
  for (const handlerType of ['filesystem', 'url', 'ifinder']) {
    try {
      const handler = sourceManager.getHandler(handlerType);
      console.log(`✅ ${handlerType}: ${handler.constructor.name}`);
    } catch (error) {
      console.log(`❌ ${handlerType}: ${error.message}`);
    }
  }
  
  console.log('\n📁 Testing Content Loading...');
  
  // Test content loading
  for (const [type, config] of Object.entries(testConfigs)) {
    try {
      const result = await sourceManager.loadSources([config]);
      console.log(`✅ ${type}: Loaded ${result.content.length} characters`);
    } catch (error) {
      console.log(`❌ ${type}: ${error.message}`);
    }
  }
}

runTests().catch(console.error);
```

**Execution**:
```bash
cd /Users/danielmanzke/Workspaces/github.intrafind/ai-hub-apps
node server/sources/test-handlers.js
```

**Success Criteria**:
- [ ] All handlers register without errors
- [ ] Filesystem content loads successfully
- [ ] URL content loads successfully
- [ ] iFinder shows appropriate error (requires auth)

#### Task 4: Test Integration with PromptService
**Priority**: HIGH  
**Effort**: 30 minutes  
**Purpose**: Ensure existing integration still works

**Test Steps**:
1. **Create test app configuration** with sources:
   ```json
   {
     "id": "test-source-app",
     "name": { "en": "Test Source App" },
     "sources": [
       {
         "type": "filesystem",
         "config": {
           "basePath": "./configs/backup/sources",
           "pattern": "*.md"
         }
       }
     ],
     "system": {
       "en": "Use the following sources: {{sources}}"
     }
   }
   ```

2. **Test through API endpoint**:
   ```bash
   curl -X POST http://localhost:3001/api/chat \
     -H "Content-Type: application/json" \
     -d '{
       "appId": "test-source-app",
       "message": "What information do you have?",
       "model": "gpt-4"
     }'
   ```

**Success Criteria**:
- [ ] Sources load in PromptService.js
- [ ] {{sources}} template gets replaced with content
- [ ] No errors in chat processing
- [ ] Response includes source-based information

### 🚀 MEDIUM PRIORITY TASKS

#### Task 5: Implement Tool Registration Pipeline
**Priority**: MEDIUM  
**Effort**: 2 hours  
**Purpose**: Make handlers available as LLM tools

**Files to Modify**:
1. `/server/sources/SourceManager.js` - Add tool generation
2. `/server/services/chat/ToolExecutor.js` - Register tools

**Implementation Steps**:

1. **Add to SourceManager.js**:
   ```javascript
   /**
    * Generate tool definitions for LLM consumption
    */
   generateToolDefinitions() {
     const tools = [];
     
     // Skip iFinder for general tool use (requires auth)
     const publicHandlers = ['filesystem', 'url'];
     
     for (const type of publicHandlers) {
       if (this.handlers.has(type)) {
         tools.push({
           name: `load_${type}_source`,
           description: `Load content from ${type} source`,
           parameters: {
             type: 'object',
             properties: this.getParameterSchema(type),
             required: this.getRequiredParams(type)
           },
           handler: async (params) => {
             try {
               const handler = this.getHandler(type);
               const result = await handler.getCachedContent(params);
               return { success: true, content: result.content, metadata: result.metadata };
             } catch (error) {
               return { success: false, error: error.message };
             }
           }
         });
       }
     }
     
     return tools;
   }
   
   getParameterSchema(type) {
     switch (type) {
       case 'filesystem':
         return {
           basePath: { type: 'string', description: 'Directory path to search' },
           pattern: { type: 'string', description: 'File pattern (*.md, *.txt)', default: '*' }
         };
       case 'url':
         return {
           url: { type: 'string', description: 'HTTP/HTTPS URL to load' },
           maxContentLength: { type: 'number', default: 50000 }
         };
       default:
         return {};
     }
   }
   
   getRequiredParams(type) {
     switch (type) {
       case 'filesystem': return ['basePath'];
       case 'url': return ['url'];
       default: return [];
     }
   }
   ```

2. **Update ToolExecutor.js** to register source tools:
   ```javascript
   async initializeSourceTools() {
     try {
       const { createSourceManager } = await import('../../sources/index.js');
       const sourceManager = createSourceManager();
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

**Success Criteria**:
- [ ] Tools generate without errors
- [ ] Tools register in ToolExecutor
- [ ] LLM can call load_filesystem_source tool
- [ ] LLM can call load_url_source tool

#### Task 6: Enhanced Error Handling
**Priority**: MEDIUM  
**Effort**: 1.5 hours  
**Purpose**: Better error reporting and recovery

**Create New File**: `/server/sources/SourceError.js`

**Implementation**:
```javascript
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
  
  toJSON() {
    return {
      name: this.name,
      message: this.message,
      type: this.type,
      timestamp: this.timestamp,
      sourceConfig: this.sourceConfig
    };
  }
}
```

**Update Handlers** to use SourceError:
```javascript
// In each handler's loadContent method
catch (error) {
  let errorType = SourceError.types.UNKNOWN;
  
  if (error.code === 'ENOTFOUND') errorType = SourceError.types.NETWORK_ERROR;
  if (error.message.includes('404')) errorType = SourceError.types.NOT_FOUND;
  if (error.message.includes('timeout')) errorType = SourceError.types.TIMEOUT;
  
  throw new SourceError(
    `Failed to load content: ${error.message}`,
    errorType,
    sourceConfig,
    error
  );
}
```

**Success Criteria**:
- [ ] Structured error reporting
- [ ] Error classification working
- [ ] Better debugging information
- [ ] Graceful error recovery

### 📚 LOW PRIORITY TASKS

#### Task 7: Configuration Documentation
**Priority**: LOW  
**Effort**: 2 hours  
**Purpose**: User guidance and examples

**Create**: `/concepts/source-handlers-system/2025-08-05 Configuration Guide.md`

**Include**:
- Complete configuration examples
- Troubleshooting guide
- Performance tuning tips
- Security considerations
- Integration examples

#### Task 8: Performance Monitoring
**Priority**: LOW  
**Effort**: 1.5 hours  
**Purpose**: Monitor system health

**Add to SourceManager**:
```javascript
// Add metrics collection
generateHealthReport() {
  return {
    handlers: {
      registered: this.handlers.size,
      types: Array.from(this.handlers.keys())
    },
    cache: {
      // Cache statistics if available
    },
    lastError: this.lastError,
    uptime: Date.now() - this.startTime
  };
}
```

## Execution Workflow

### Phase 1: Critical Fixes (30-45 minutes)
```bash
# 1. Fix URLHandler import
# Edit: server/sources/URLHandler.js (line 72)

# 2. Test handler registration
npm run dev
# Check console for registration messages

# 3. Create and run test script
node server/sources/test-handlers.js
```

### Phase 2: Validation (30 minutes)
```bash
# 4. Test PromptService integration
# Create test app config
# Test via API endpoint

# 5. Verify caching works
# Run test script multiple times
# Check for cached responses
```

### Phase 3: Enhancement (3-4 hours)
```bash
# 6. Implement tool registration
# Edit: server/sources/SourceManager.js
# Edit: server/services/chat/ToolExecutor.js

# 7. Add error handling
# Create: server/sources/SourceError.js
# Update all handlers

# 8. Test tool calling
# Use LLM to call source tools
```

### Phase 4: Documentation (2 hours)
```bash
# 9. Create configuration guide
# 10. Add troubleshooting docs
# 11. Update README if needed
```

## Validation Checklist

### After Each Task
- [ ] No new console errors
- [ ] Existing functionality still works
- [ ] Test script passes
- [ ] Integration tests pass

### Final Validation
- [ ] All three handlers register successfully
- [ ] Content loading works for filesystem and URL
- [ ] iFinder shows appropriate auth error
- [ ] Tool registration pipeline functional
- [ ] Error handling provides useful information
- [ ] PromptService integration works
- [ ] Performance is acceptable
- [ ] Documentation is complete

## Rollback Plan

If any task causes issues:

1. **Identify the failing component**
2. **Revert specific changes**:
   ```bash
   git checkout HEAD -- server/sources/URLHandler.js
   git checkout HEAD -- server/sources/SourceManager.js
   ```
3. **Test basic functionality**
4. **Re-implement more carefully**

## Common Issues and Solutions

### Import Errors
- **Issue**: ES module import fails
- **Solution**: Check file exists, verify export syntax
- **Debug**: Add try-catch around imports

### Handler Registration Fails
- **Issue**: Handler constructor throws error
- **Solution**: Check dependencies are available
- **Debug**: Test handler creation in isolation

### Content Loading Fails
- **Issue**: Source content not accessible
- **Solution**: Verify paths/URLs exist and are accessible
- **Debug**: Test with minimal configuration first

### Tool Registration Issues
- **Issue**: Tools don't appear in LLM
- **Solution**: Check ToolExecutor registration
- **Debug**: Log tool definitions and registration

This task breakdown provides a clear execution path for fixing the source handlers system while maintaining system stability and allowing for rollback if needed.