# Model Filtering and Fallback Logic

**Date:** 2026-01-27  
**Status:** Implemented  
**Related Files:**
- `server/services/chat/RequestBuilder.js`
- `client/src/features/chat/components/ModelSelector.jsx`
- `server/defaults/apps/image-generator.json`

## Problem Statement

When an app has model filtering requirements (e.g., `supportsImageGeneration: true`), the frontend `ModelSelector` component correctly filters the available models. However, the backend did not apply the same filtering logic when processing chat requests. This caused two critical issues:

1. **Incompatible Model Fallback**: If a user's selected model wasn't available or didn't match requirements, the backend would fall back to the global default model (e.g., `gemini-2.5-flash`) even if that model didn't meet the app's requirements.

2. **Capability Mismatch**: Apps requiring specific capabilities (like image generation) would receive responses from models that don't support those capabilities, resulting in errors or unexpected behavior.

### Real-World Example

**Scenario:** Image generator app with Google Search enabled
- Frontend shows only `gemini-3-pro-image` (the only model with `supportsImageGeneration: true`)
- User submits image generation request
- Backend receives request, but if model isn't available, falls back to `gemini-2.5-flash`
- `gemini-2.5-flash` doesn't support image generation
- Request fails with capability error

## Solution

Implemented backend model filtering that mirrors the frontend logic, ensuring consistent model selection across the entire application.

### Key Components

#### 1. Model Filtering Function

Added `filterModelsForApp()` function in `RequestBuilder.js`:

```javascript
function filterModelsForApp(models, app) {
  let availableModels = models;

  // Filter by allowedModels if specified
  if (app?.allowedModels && app.allowedModels.length > 0) {
    availableModels = availableModels.filter(model => 
      app.allowedModels.includes(model.id)
    );
  }

  // Filter by tools requirement
  if (app?.tools && app.tools.length > 0) {
    availableModels = availableModels.filter(model => 
      model.supportsTools
    );
  }

  // Apply model settings filter (e.g., supportsImageGeneration)
  if (app?.settings?.model?.filter) {
    const filter = app.settings.model.filter;
    availableModels = availableModels.filter(model => {
      for (const [key, value] of Object.entries(filter)) {
        if (model[key] !== value) {
          return false;
        }
      }
      return true;
    });
  }

  return availableModels;
}
```

#### 2. Intelligent Fallback Logic

When a selected model doesn't meet requirements, the system tries fallbacks in this order:

1. **App's Preferred Model** - If specified in `app.preferredModel` and compatible
2. **Default from Filtered List** - A model marked as default that meets requirements
3. **First Compatible Model** - The first available model from the filtered list
4. **Error** - If no compatible models exist, return clear error message

```javascript
// Check if the resolved model is in the filtered list
const isModelInFilteredList = filteredModels.some(m => m.id === resolvedModelId);

if (!isModelInFilteredList) {
  console.log(`Model ${resolvedModelId} is not compatible with app ${app.id} requirements.`);
  
  let fallbackModel = null;
  
  // Try app's preferred model first
  if (app.preferredModel && filteredModels.some(m => m.id === app.preferredModel)) {
    fallbackModel = app.preferredModel;
  }
  // Try default from filtered list
  else if (defaultModelFromFiltered) {
    fallbackModel = defaultModelFromFiltered;
  }
  // Try first available compatible model
  else if (filteredModels.length > 0) {
    fallbackModel = filteredModels[0].id;
  }
  
  if (fallbackModel) {
    resolvedModelId = fallbackModel;
  } else {
    return { 
      success: false, 
      error: new Error('No compatible models available for this app')
    };
  }
}
```

#### 3. Logging and Debugging

Added comprehensive logging for troubleshooting:

```javascript
console.log(
  `App ${app.id}: Filtered ${filteredModels.length} compatible models from ${models.length} total models`
);

console.log(`Using app's preferred model as fallback: ${fallbackModel}`);
```

## App Configuration

Apps can specify model filtering requirements in their configuration:

### Example: Image Generator App

```json
{
  "id": "image-generator",
  "preferredModel": "gemini-3-pro-image",
  "settings": {
    "model": {
      "enabled": true,
      "filter": {
        "supportsImageGeneration": true
      }
    }
  }
}
```

### Supported Filter Types

1. **allowedModels**: Explicit list of allowed model IDs
   ```json
   "allowedModels": ["gpt-4", "claude-opus"]
   ```

2. **tools**: Requires models that support tool calling
   ```json
   "tools": ["web-search", "calculator"]
   ```

3. **settings.model.filter**: Custom capability filters
   ```json
   "settings": {
     "model": {
       "filter": {
         "supportsImageGeneration": true,
         "supportsVision": true
       }
     }
   }
   ```

## Model Configuration

Models declare their capabilities in their configuration files:

```json
{
  "id": "gemini-3-pro-image",
  "modelId": "gemini-3-pro-image-preview",
  "provider": "google",
  "supportsTools": true,
  "supportsImages": true,
  "supportsImageGeneration": true,
  "imageGeneration": {
    "aspectRatio": "1:1",
    "imageSize": "1K",
    "maxReferenceImages": 14
  }
}
```

## Testing

Created manual test (`tests/manual-test-model-filtering.js`) to validate:

1. **Compatible Model**: Directly using a compatible model works
2. **Incompatible Fallback**: Incompatible model triggers fallback to compatible one
3. **No Filter Apps**: Apps without filters work with any model
4. **No Model Specified**: Correctly selects preferred/default compatible model

### Test Results

```
Test 2: Image generator app with incompatible model
Input: gemini-2.5-flash (no image generation)
Output:
  - Filtered 2 compatible models from 9 total
  - Detected incompatibility  
  - Fell back to gemini-3-pro-image (preferred model)
  ✅ SUCCESS
```

## Impact

### Before Fix
- ❌ Backend could use incompatible models
- ❌ Image generation failed with generic models
- ❌ Tools-requiring apps could get models without tool support
- ❌ Inconsistent behavior between frontend and backend

### After Fix
- ✅ Backend enforces same model requirements as frontend
- ✅ Intelligent fallback to compatible models
- ✅ Clear error messages when no compatible models exist
- ✅ Consistent model selection across the application
- ✅ Logging for troubleshooting

## Future Enhancements

Potential improvements for consideration:

1. **User Notification**: When fallback occurs, notify user which model was actually used
2. **Admin Warning**: Alert admins when apps have no compatible models configured
3. **Filter Validation**: Validate filter keys against known model capabilities
4. **Performance**: Cache filtered model lists per app to reduce computation

## Related Code Locations

### Backend
- Model filtering: `server/services/chat/RequestBuilder.js` (lines 43-71)
- Model selection: `server/services/chat/RequestBuilder.js` (lines 121-173)
- Error handling: `server/utils/ErrorHandler.js`

### Frontend
- Model selector: `client/src/features/chat/components/ModelSelector.jsx`
- Model filtering: `client/src/features/chat/components/ModelSelector.jsx` (lines 23-48)

### Configuration
- App config schema: `server/validators/appConfigSchema.js`
- Model config schema: `server/validators/modelConfigSchema.js`
- Default apps: `server/defaults/apps/`
- Default models: `server/defaults/models/`

## Migration Notes

For existing deployments:

1. **No Breaking Changes**: Existing apps without filters continue to work
2. **Model ID Fix**: Updated `preferredModel` in image-generator to use `id` instead of `modelId`
3. **Backwards Compatible**: Apps without filter settings use all available models

## Summary

This implementation ensures that backend model selection respects app-level requirements and filtering, matching the frontend behavior. It provides intelligent fallback logic and clear error messages, resulting in a more robust and predictable model selection system.
