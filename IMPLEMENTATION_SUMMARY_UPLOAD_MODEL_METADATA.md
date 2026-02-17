# Implementation Summary: Fix Audio/Image Upload Using Model Metadata

**Date**: 2026-02-17
**Status**: ✅ Completed

## Problem

Audio and image files could not be selected in the file upload dialog even when explicitly enabled in the app configuration. The root cause was fragile model name string matching in `useFileUploadHandler.js` that overrode app config settings.

### Root Cause

The `createUploadConfig()` function used hardcoded name patterns to determine vision/audio support:
- Vision models: checked for `'gpt-4'`, `'claude-3'`, `'gemini'`, `'4o'` in model name
- Audio models: checked for `'gemini-2'`, `'gemini-3'` in model name

This caused issues with:
- Models with non-standard names (e.g., `claude-4`, `mistral`, custom models)
- Models that support vision/audio but don't match the name patterns
- App configurations being ignored when model names didn't match

## Solution

Replaced fragile name heuristics with proper model metadata checks while maintaining backward compatibility.

### Changes

#### 1. `client/src/shared/hooks/useFileUploadHandler.js`

**Before** (lines 53-70):
```javascript
const isVisionModel =
  selectedModel &&
  (selectedModel.includes('vision') ||
    selectedModel.includes('gpt-4') ||
    selectedModel.includes('claude-3') ||
    selectedModel.includes('gemini') ||
    selectedModel.includes('4o'));

const isAudioModel =
  selectedModel && (selectedModel.includes('gemini-2') || selectedModel.includes('gemini-3'));
```

**After**:
```javascript
const modelId = selectedModel?.id || '';
const isVisionModel =
  selectedModel?.supportsVision ??
  selectedModel?.supportsImages ??
  (modelId &&
    (modelId.includes('vision') ||
      modelId.includes('gpt-4') ||
      modelId.includes('claude-3') ||
      modelId.includes('gemini') ||
      modelId.includes('4o')));

const isAudioModel =
  selectedModel?.supportsAudio ??
  (modelId && (modelId.includes('gemini-2') || modelId.includes('gemini-3')));
```

**Key improvements**:
- Uses `??` (nullish coalescing) so explicit `supportsVision: true/false` takes priority
- Falls back to old name heuristics only when fields are `undefined`
- Checks both `supportsVision` and `supportsImages` (two field names in use)
- Backward compatible with models that don't have metadata fields

#### 2. `client/src/features/apps/pages/AppChat.jsx`

**Before** (line 1227):
```javascript
uploadConfig: fileUploadHandler.createUploadConfig(app, selectedModel),
```

**After**:
```javascript
uploadConfig: fileUploadHandler.createUploadConfig(app, currentModel),
```

**Rationale**: Passes the full model object (with metadata fields) instead of just the string ID.

## Verification Steps

1. ✅ Configure an app with `upload.imageUpload.enabled: true` and `upload.audioUpload.enabled: true`
2. ✅ Select a model with `supportsVision: true` / `supportsAudio: true` → image/audio files selectable
3. ✅ Select a model without metadata but with matching name (e.g., `gemini-2.0-flash`) → still works (fallback)
4. ✅ Select a model with `supportsVision: false` → image files correctly not selectable
5. ✅ Run `npm run lint:fix && npm run format:fix` → no new errors

## Model Metadata Fields

Models can declare their capabilities in their JSON config files:

```json
{
  "id": "model-id",
  "supportsVision": true,    // Enables image upload
  "supportsImages": true,    // Alternative field name
  "supportsAudio": true      // Enables audio upload
}
```

These fields are:
- Already defined in `server/validators/modelConfigSchema.js` (lines 87-89)
- Served to the frontend via `/api/models` endpoint
- Used by several default model configs (e.g., `gemini-2.0-flash-exp.json`)

## Benefits

1. **Explicit model capabilities**: Model configs explicitly declare what they support
2. **No more fragile patterns**: No need to update code when new models are added
3. **Backward compatible**: Existing models without metadata still work via fallback
4. **App config respected**: Upload settings in app config are properly honored
5. **Future-proof**: New models just need metadata fields, no code changes

## Files Modified

- `client/src/shared/hooks/useFileUploadHandler.js` - Updated capability detection logic
- `client/src/features/apps/pages/AppChat.jsx` - Pass model object instead of ID

## Related Documentation

- Model config schema: `server/validators/modelConfigSchema.js`
- Model endpoint: `server/routes/modelRoutes.js`
- Example model configs: `contents/models/*.json`
