# Model Auto-Discovery for Local LLM Providers

**Date:** 2026-05-11
**Issue:** #1137
**Status:** Implemented

## Problem Statement

When using local LLM providers (vLLM, LM Studio, Jan.ai), the active model can change frequently. vLLM only supports one model at a time, so when operators switch models, the application would fail with unclear 404 errors.

### Issues Identified

1. **Unclear Error Messages**: When a model wasn't available, users received generic HTTP 404 errors without understanding that the model configuration was incorrect or that the model had changed
2. **No Automatic Adaptation**: The system couldn't automatically detect when the active model changed on the local provider
3. **Manual Configuration Required**: Users had to manually update the model configuration every time they changed the model in vLLM

### Example Error
```json
{
  "component": "StreamingHandler",
  "level": "error",
  "timestamp": "2026-05-11T07:46:42.424Z",
  "message": "HTTP error from LLM provider",
  "provider": "local",
  "httpStatus": 404,
  "statusText": "Not Found",
  "url": "https://mygpu.dummy/v1/chat/completions",
  "details": "{\"error\":{\"message\":\"The model `default` does not exist.\",\"type\":\"NotFoundError\",\"param\":\"model\",\"code\":404}}",
  "code": "404"
}
```

## Solution Design

### 1. Model Discovery Service

Created a new service (`server/services/ModelDiscoveryService.js`) that:

- Queries the `/v1/models` endpoint to discover available models
- Caches discovery results for 5 minutes (configurable) to minimize API calls
- Prevents duplicate simultaneous discovery requests
- Falls back to configured `modelId` if discovery fails
- Supports OpenAI-compatible endpoints (OpenAI, local providers)

**Key Features:**
- **Caching**: Results cached for 5 minutes by default
- **Request Deduplication**: Prevents multiple concurrent requests for the same model
- **Graceful Fallback**: Uses configured modelId if discovery fails
- **Provider Support**: Works with `openai` and `local` providers

### 2. Enhanced Error Messages

Updated `ErrorHandler.js` to:

- Detect 404 errors specifically for model not found
- Extract model name from error response
- Provide actionable error messages suggesting auto-discovery
- Support both English and German translations

**New Error Message:**
```
Model '{modelId}' is not available on {provider}. The configured model '{configuredModel}' could not be found. If you're using a local LLM provider (vLLM, LM Studio, Jan.ai), please check that the model is loaded and running. You can enable 'Auto Discovery' in the model settings to automatically detect the active model.
```

### 3. Model Configuration Schema

Extended `modelConfigSchema.js` with:

```javascript
// Model auto-discovery - automatically detect model ID from /v1/models endpoint
// Useful for local LLM providers (vLLM, LM Studio, Jan.ai) where the active model can change
autoDiscovery: z.boolean().optional().default(false)
```

### 4. OpenAI Adapter Integration

Modified `server/adapters/openai.js` to:

- Import `ModelDiscoveryService`
- Make `createCompletionRequest` async
- Call `modelDiscoveryService.getEffectiveModelId()` before making requests
- Use discovered model ID instead of configured modelId when auto-discovery is enabled

### 5. Admin UI Enhancement

Updated `ModelFormEditor.jsx` to:

- Add checkbox for `autoDiscovery` field
- Disable checkbox for non-OpenAI-compatible providers
- Show helpful hint text explaining the feature
- Conditional styling based on provider compatibility

## Implementation Details

### Model Discovery Process

1. **Check Cache**: First check if a valid cached result exists (within TTL)
2. **Pending Request Check**: If a discovery is already in progress, wait for it
3. **Discover**: Query `/v1/models` endpoint
4. **Parse Response**: Extract first available model from OpenAI-compatible response
5. **Cache Result**: Store discovered model ID with timestamp
6. **Return**: Return discovered model ID or fall back to configured modelId

### Cache Management

- **TTL**: 5 minutes by default (300,000 ms)
- **Structure**: `Map<modelConfigId, {modelId: string, timestamp: number}>`
- **Manual Clear**: `clearCache(modelConfigId)` method available
- **Stats**: `getCacheStats()` for monitoring

### Discovery Request Format

```javascript
GET /v1/models
Authorization: Bearer {apiKey}  // If provided and not placeholder
```

**Expected Response:**
```json
{
  "object": "list",
  "data": [
    {
      "id": "actual-model-name",
      "object": "model",
      ...
    }
  ]
}
```

### Error Handling

- **Network Errors**: Logged as warnings, fallback to configured modelId
- **Timeout**: 10-second timeout on discovery requests
- **Invalid Responses**: Logged as warnings, fallback to configured modelId
- **404 on /v1/models**: Logged as warnings, fallback to configured modelId

## Files Modified

### Server Files
- `server/services/ModelDiscoveryService.js` - NEW: Model discovery service
- `server/adapters/openai.js` - Integrated discovery service
- `server/utils/ErrorHandler.js` - Enhanced 404 error messages
- `server/validators/modelConfigSchema.js` - Added autoDiscovery field
- `server/defaults/models/local-vllm.json` - Added autoDiscovery: true
- `examples/models/local-vllm.json` - Added autoDiscovery: true

### Client Files
- `client/src/features/admin/components/ModelFormEditor.jsx` - Added autoDiscovery checkbox

### Translations
- `shared/i18n/en.json` - Added modelNotAvailable error message
- `shared/i18n/de.json` - Added modelNotAvailable error message (German)

## Usage

### Enabling Auto-Discovery

1. Navigate to Admin → Models
2. Edit a local model configuration (e.g., "Local vLLM")
3. Ensure provider is set to `openai` or `local`
4. Check the "Auto Discovery" checkbox
5. Save the model configuration

### Example Configuration

```json
{
  "id": "local-vllm",
  "modelId": "mistral-small",
  "name": {"en": "Local vLLM"},
  "description": {"en": "Local vLLM instance"},
  "url": "http://localhost:8080/v1/chat/completions",
  "provider": "openai",
  "tokenLimit": 8192,
  "autoDiscovery": true,
  "enabled": true
}
```

## Benefits

1. **Automatic Adaptation**: System automatically adapts when the local model changes
2. **Reduced Configuration**: No need to manually update modelId when switching models
3. **Clear Error Messages**: Users understand what's wrong and how to fix it
4. **Performance**: 5-minute cache minimizes overhead
5. **Compatibility**: Works with any OpenAI-compatible local provider

## Testing

### Manual Testing Scenarios

1. **vLLM Model Change**:
   - Start vLLM with model A
   - Configure iHub with autoDiscovery enabled
   - Send a chat request → Should work
   - Switch vLLM to model B
   - Wait for cache expiry (5 min) or clear cache
   - Send a chat request → Should work with new model

2. **Discovery Failure**:
   - Configure model with autoDiscovery enabled
   - Stop local LLM provider
   - Send a chat request → Should show clear error message
   - Should suggest enabling auto-discovery (if not already enabled)

3. **Provider Compatibility**:
   - Try enabling autoDiscovery on Anthropic model → Should be disabled in UI
   - Try enabling autoDiscovery on Google model → Should be disabled in UI
   - Try enabling autoDiscovery on OpenAI model → Should work
   - Try enabling autoDiscovery on local model → Should work

## Future Enhancements

1. **Configurable Cache TTL**: Allow per-model cache TTL configuration
2. **Admin API**: Expose cache stats and clear cache endpoint
3. **Model List UI**: Show all discovered models in admin interface
4. **Multi-Model Support**: Support providers serving multiple models simultaneously
5. **Health Checks**: Periodic background discovery to detect model availability
6. **Metrics**: Track discovery success/failure rates for monitoring

## Related Documentation

- `docs/local-llm-providers.md` - Documentation on local LLM provider setup
- `docs/models.md` - General model configuration documentation
- `server/services/ModelDiscoveryService.js` - Service implementation with detailed comments

## Migration Notes

### Existing Installations

No migration required. The `autoDiscovery` field is optional and defaults to `false`, maintaining backward compatibility.

### Recommended Actions

For installations using local LLM providers (vLLM, LM Studio, Jan.ai):

1. Update model configurations to include `"autoDiscovery": true`
2. Test discovery by changing the active model
3. Monitor logs for discovery success/failures
4. Adjust cache TTL if needed based on model change frequency

## Security Considerations

1. **API Key Exposure**: Discovery requests use the same authentication as chat requests
2. **Cache Poisoning**: Cache is per-model and time-limited, minimal risk
3. **Request Amplification**: Deduplication prevents excessive requests
4. **Fallback Safety**: Always falls back to configured modelId on failure
