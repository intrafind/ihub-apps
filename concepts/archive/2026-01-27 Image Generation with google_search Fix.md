# Image Generation with google_search Fix

## Issue Description

When using the `gemini-3-pro-image` model together with the `google_search` tool, images were not being returned to the client despite the request being successfully sent to the Google API.

## Root Cause Analysis

The problem occurred due to the flow of requests when tools are enabled:

1. When `tools` are present (including `google_search`), the request goes through `ToolExecutor.processChatWithTools()`
2. `google_search` is a special grounding tool that enhances the model's knowledge but doesn't trigger function calls
3. The streaming response includes:
   - Text content
   - Generated images (from image generation models)
   - Grounding metadata (from google_search)
   - **NO tool calls** (because google_search is not invoked as a function)

4. The `ToolExecutor` streaming loop was collecting:
   - ✅ Text content
   - ✅ Tool calls
   - ❌ **Images** (missing)
   - ❌ **Thinking content** (missing)
   - ❌ **Grounding metadata** (missing)

5. When `finishReason !== 'tool_calls'` (which is the case with google_search), the method returned early without the images being processed

## Solution

Added processing of images, thinking content, and grounding metadata in the `ToolExecutor.processChatWithTools()` streaming loop:

```javascript
// Process images (important for image generation with tools like google_search)
this.streamingHandler.processImages(result, chatId);

// Process thinking content
this.streamingHandler.processThinking(result, chatId);

// Process grounding metadata (for Google Search grounding)
this.streamingHandler.processGroundingMetadata(result, chatId);
```

These calls are made for **every chunk** in the streaming response, ensuring that:
- Images are tracked and emitted via `actionTracker.trackImage()`
- Thinking content is tracked via `actionTracker.trackThinking()`
- Grounding metadata is tracked via `actionTracker.trackAction()`

Since these methods are called during the streaming loop (before the early return), the data is sent to the client regardless of whether tool calls are present.

## Files Modified

### `/server/services/chat/ToolExecutor.js`
- Added image processing in streaming loop (line ~462)
- Added thinking processing in streaming loop (line ~465)
- Added grounding metadata processing in streaming loop (line ~468)

## Test Coverage

Created comprehensive test file: `/server/tests/googleImageGenerationWithSearch.test.js`

Tests cover:
1. ✅ Image extraction from response with google_search
2. ✅ Thought images are filtered out (only final images shown)
3. ✅ Streaming image responses work correctly
4. ✅ Text-only response with google_search works correctly

## Validation

- ✅ New tests pass (4/4)
- ✅ Existing gemini3-tool-calling tests pass
- ✅ Google search function calling conflict tests pass
- ✅ Server starts successfully
- ✅ No linting errors

## Impact

This fix ensures that:
- Image generation works correctly with any grounding tools (not just google_search)
- Thinking content from models like Gemini is properly displayed
- Grounding metadata is available for citation and search result display
- Regular tool calling functionality remains unaffected

## Related Issues

- Google API limitation: `google_search` cannot be combined with `functionDeclarations`
- When both are present, `google_search` takes priority (handled by `GoogleConverter.js`)
