# Model Testing with Provider-Specific API Keys - Test Documentation

## Issue Description

**Problem**: Model testing in the admin panel fails when a provider-specific API key is configured in `providers.json`. The test button throws a 400 error about invalid API key, even though the same model works correctly in apps.

**Error Message**:

```
Model test failed
LLM API request failed with status 400: {
  "error": {
    "code": 400,
    "message": "API key not valid. Please pass a valid API key.",
    ...
  }
}
```

## Root Cause

The `simpleCompletion` function in `server/utils.js` was directly accessing environment variables for API keys:

```javascript
const apiKey = config[`${modelConfig.provider.toUpperCase()}_API_KEY`];
```

This approach skipped the proper API key resolution chain that checks:

1. Model-specific encrypted API keys
2. **Provider-specific encrypted API keys** (stored in `providers.json`)
3. Environment variables

## Solution

Modified `simpleCompletion` to:

1. Accept an optional `apiKey` parameter
2. Use the provided API key when available
3. Fallback to `getApiKeyForModel()` which properly checks all sources

Modified the model test endpoint in `server/routes/admin/models.js` to:

1. Verify the API key using `verifyApiKey()`
2. Pass the verified key to `simpleCompletion()`

## Testing Instructions

### Automated Test

Run the manual test script:

```bash
node tests/manual-test-model-with-provider-key.js
```

This test validates:

- ✅ `simpleCompletion` works with explicit API key (existing behavior)
- ✅ `simpleCompletion` works without explicit API key (new fallback behavior)

### Manual Testing via Admin UI

1. **Setup**: Configure a provider-specific API key

   Edit `contents/config/providers.json`:

   ```json
   {
     "providers": [
       {
         "id": "google",
         "name": "Google",
         "apiKey": "YOUR_GOOGLE_API_KEY_HERE"
       }
     ]
   }
   ```

2. **Ensure Model Has No API Key**

   In `contents/models/gemini-2.5-flash.json`, ensure there's no `apiKey` field:

   ```json
   {
     "id": "gemini-2.5-flash",
     "modelId": "gemini-2.0-flash-exp",
     "name": { "en": "Gemini 2.5 Flash" },
     "provider": "google",
     "enabled": true
     // No apiKey field here
   }
   ```

3. **Test in Admin Panel**
   - Navigate to Admin → Models
   - Find the Gemini model
   - Click the "Test" button
   - **Expected Result**: Test should succeed with provider-specific API key

4. **Verify in Apps**
   - Navigate to an app that uses the Gemini model
   - Send a test message
   - **Expected Result**: Should work with provider-specific API key

## API Key Resolution Chain

The fix ensures that API keys are resolved in the following order:

1. **Model-specific encrypted key** (highest priority)
   - Stored in: `contents/models/{model-id}.json`
   - Field: `apiKey` (encrypted)

2. **Provider-specific encrypted key** ⭐ **(THIS WAS THE MISSING PIECE)**
   - Stored in: `contents/config/providers.json`
   - Field: `providers[].apiKey` (encrypted)

3. **Model-specific environment variable**
   - Format: `{MODEL_ID}_API_KEY` (e.g., `GPT_4_AZURE1_API_KEY`)

4. **Provider-specific environment variable** (lowest priority)
   - Format: `{PROVIDER}_API_KEY` (e.g., `GOOGLE_API_KEY`)

## Files Modified

### `server/utils.js`

- Added `apiKey` parameter to `simpleCompletion` function
- Changed from direct environment variable access to using `getApiKeyForModel()`
- Maintains backward compatibility with explicit API key parameter

### `server/routes/admin/models.js`

- Updated model test endpoint to pass verified API key to `simpleCompletion()`
- Ensures consistency with how apps use API keys

## Verification Checklist

- [ ] Manual test script runs successfully
- [ ] Model testing works with provider-specific API key in admin panel
- [ ] Model testing still works with environment variable API keys
- [ ] Model testing works with model-specific API keys
- [ ] Apps continue to work with all API key configurations
- [ ] No regression in existing functionality

## Related Code

### Key Functions

- `getApiKeyForModel()` - in `server/utils.js` (lines 42-174)
- `simpleCompletion()` - in `server/utils.js` (lines 477-548)
- `verifyApiKey()` - in `server/serverHelpers.js` (lines 19-22)
- Model test endpoint - in `server/routes/admin/models.js` (lines 409-504)

### Key Concepts

- Provider configuration: `contents/config/providers.json`
- API key encryption: `server/services/TokenStorageService.js`
- API key verification: `server/utils/ApiKeyVerifier.js`
