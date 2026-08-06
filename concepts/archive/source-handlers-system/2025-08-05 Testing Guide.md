# Source Handlers System - Testing and Validation Guide

**Date**: 2025-08-05  
**Purpose**: Quick reference for testing the source handlers fixes  
**Audience**: Developers implementing and validating the fixes

## Quick Test Commands

### 1. Server Startup Test
```bash
cd /Users/danielmanzke/Workspaces/github.intrafind/ihub-apps
npm run dev
```

**Look for in console**:
```
✅ FileSystemHandler registered
✅ URLHandler registered  
✅ IFinderHandler registered
```

**Red flags**:
```
❌ Failed to register URLHandler: require is not defined
❌ ReferenceError: require is not defined
```

### 2. Handler Registration Test
```bash
# In server console or browser console
node -e "
import('./server/sources/index.js').then(async ({ createSourceManager }) => {
  const sm = createSourceManager();
  console.log('Registered handlers:', Array.from(sm.handlers.keys()));
  console.log('Handler count:', sm.handlers.size);
});
"
```

**Expected output**:
```
Registered handlers: [ 'filesystem', 'url', 'ifinder' ]
Handler count: 3
```

### 3. Content Loading Test
Create test script: `/server/sources/quick-test.js`
```javascript
import { createSourceManager } from './index.js';

const tests = [
  {
    name: 'Filesystem Test',
    config: {
      type: 'filesystem',
      config: { basePath: './configs/backup/sources', pattern: '*.md' }
    }
  },
  {
    name: 'URL Test', 
    config: {
      type: 'url',
      config: { url: 'https://httpbin.org/html' }
    }
  }
];

async function quickTest() {
  const sm = createSourceManager();
  
  for (const test of tests) {
    try {
      console.log(`\n🧪 ${test.name}:`);
      const result = await sm.loadSources([test.config]);
      console.log(`✅ Success: ${result.content.length} characters loaded`);
    } catch (error) {
      console.log(`❌ Failed: ${error.message}`);
    }
  }
}

quickTest();
```

Run with: `node server/sources/quick-test.js`

### 4. Integration Test with PromptService
```bash
# Test via API endpoint
curl -X POST http://localhost:3001/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "appId": "faq-bot",
    "message": "What information do you have?",
    "model": "gpt-4o"
  }'
```

## Validation Checklist

### ✅ Phase 1: Basic Functionality
- [ ] Server starts without import errors
- [ ] All three handlers register (filesystem, url, ifinder)
- [ ] SourceManager.handlers.size === 3
- [ ] No "require is not defined" errors

### ✅ Phase 2: Content Loading
- [ ] Filesystem sources load successfully
- [ ] URL sources load successfully  
- [ ] iFinder shows auth error (expected for anonymous)
- [ ] Cache system works (repeat requests faster)

### ✅ Phase 3: Integration
- [ ] PromptService loads sources correctly
- [ ] {{sources}} template replacement works
- [ ] Chat API responses include source content
- [ ] No regression in existing apps

### ✅ Phase 4: Tool Registration (if implemented)
- [ ] Tools generate without errors
- [ ] Tools register in ToolExecutor
- [ ] LLM can call load_filesystem_source
- [ ] LLM can call load_url_source

## Test Configurations

### Filesystem Test Config
```json
{
  "type": "filesystem",
  "config": {
    "basePath": "./configs/backup/sources",
    "pattern": "*.md",
    "recursive": false
  }
}
```

### URL Test Config
```json
{
  "type": "url", 
  "config": {
    "url": "https://httpbin.org/html",
    "options": {
      "maxContentLength": 10000,
      "cleanContent": true
    }
  }
}
```

### iFinder Test Config (requires auth)
```json
{
  "type": "ifinder",
  "config": {
    "query": "test document",
    "user": {
      "id": "test-user",
      "email": "test@example.com"
    },
    "chatId": "test-chat-123"
  }
}
```

## Error Scenarios to Test

### 1. Import Errors
**Test**: Try to import URLHandler directly
```javascript
import URLHandler from './server/sources/URLHandler.js';
const handler = new URLHandler();
```

**Expected**: No errors, handler creates successfully

### 2. Invalid Configurations
**Test**: Invalid filesystem path
```javascript
const invalidConfig = {
  type: 'filesystem',
  config: { basePath: '/nonexistent/path' }
};
```

**Expected**: Graceful error, not system crash

### 3. Network Failures
**Test**: Invalid URL
```javascript
const invalidUrl = {
  type: 'url',
  config: { url: 'https://nonexistent-domain-12345.com' }
};
```

**Expected**: Network error, proper error classification

### 4. Authentication Issues
**Test**: iFinder without user
```javascript
const noAuthConfig = {
  type: 'ifinder', 
  config: { query: 'test' }
};
```

**Expected**: Authentication error, clear message

## Performance Tests

### Cache Performance
```javascript
// Test cache hit vs miss
const config = { 
  type: 'url', 
  config: { url: 'https://httpbin.org/html' } 
};

console.time('First load (cache miss)');
const result1 = await sm.loadSources([config]);
console.timeEnd('First load (cache miss)');

console.time('Second load (cache hit)');
const result2 = await sm.loadSources([config]);
console.timeEnd('Second load (cache hit)');
```

**Expected**: Second load significantly faster

### Memory Usage
```javascript
// Monitor memory during batch loading
const urls = [
  'https://httpbin.org/html',
  'https://httpbin.org/json',
  'https://httpbin.org/xml'
];

console.log('Memory before:', process.memoryUsage());

for (const url of urls) {
  await sm.loadSources([{ type: 'url', config: { url } }]);
}

console.log('Memory after:', process.memoryUsage());
```

## Debugging Commands

### Check Handler Status
```javascript
import { createSourceManager } from './server/sources/index.js';

const sm = createSourceManager();
console.log('Handlers:', sm.handlers);

for (const [type, handler] of sm.handlers) {
  console.log(`${type}:`, {
    name: handler.constructor.name,
    type: handler.getType(),
    cacheConfig: handler.cacheConfig
  });
}
```

### Inspect Cache State
```javascript
// If cache is accessible
const handler = sm.getHandler('url');
console.log('Cache size:', handler.cache?.size || 'No cache info');
```

### Test Individual Handler
```javascript
const handler = sm.getHandler('filesystem');
const config = { basePath: './configs', pattern: '*.json' };

console.log('Valid config:', handler.validateConfig(config));

try {
  const result = await handler.loadContent(config);
  console.log('Content loaded:', result.content.length);
} catch (error) {
  console.log('Error:', error.message);
}
```

## Common Issues and Quick Fixes

### Issue: "require is not defined"
**Fix**: Replace `require()` with `import()`
**File**: `server/sources/URLHandler.js` line 72

### Issue: Handler not registered
**Debug**: Check handler constructor doesn't throw
**Fix**: Add try-catch around handler registration

### Issue: Content not loading
**Debug**: Test handler validation and config
**Fix**: Verify paths/URLs exist and are accessible

### Issue: Cache not working
**Debug**: Check cache key generation
**Fix**: Ensure getCacheKey() returns consistent keys

### Issue: Tool registration fails  
**Debug**: Check tool definition structure
**Fix**: Verify parameter schemas are valid

## Success Indicators

### Green Lights ✅
- Server starts clean (no red error messages)
- All handlers show registered
- Content loads from filesystem and URLs
- Caching works (faster repeat requests)
- Integration tests pass
- No memory leaks during testing

### Red Flags ❌
- Import/require errors on startup
- Handler registration failures
- Empty content from valid sources
- Slow performance on cached requests
- Memory usage growing during tests
- Integration tests failing

This testing guide provides a systematic approach to validating the source handlers fixes and ensuring the system works correctly after implementation.