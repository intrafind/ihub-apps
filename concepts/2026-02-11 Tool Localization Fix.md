# 2026-02-11 Tool Localization Fix for Google Gemini API

## Problem Statement

When users deselected all tools in the web-chat app (or when no language parameter was provided), the Google Gemini API returned an error:

```json
{
  "error": {
    "code": 400,
    "message": "Invalid value at 'tools[0].function_declarations[0].parameters.properties[1].value' (description), Starting an object on a scalar field"
  }
}
```

## Root Cause

The issue was in `server/toolLoader.js` in the `loadConfiguredTools` function:

```javascript
// BEFORE (buggy code)
export async function loadConfiguredTools(language = null) {
  const { data: tools } = configCache.getTools();
  if (!tools) {
    logger.warn('Tools could not be loaded');
    return [];
  }

  // If language is specified, localize the tools
  if (language) {  // ❌ Bug: Only localizes when language is truthy
    return localizeTools(tools, language);
  }

  return tools;  // ❌ Returns un-localized tools when language is null/undefined/empty
}
```

When `language` was `null`, `undefined`, or empty string `''`, the condition `if (language)` evaluated to `false`, causing the function to return **un-localized tools** directly from the cache.

### Why This Caused Google API Errors

Tool definitions in `server/defaults/config/tools.json` contain multilingual descriptions:

```json
{
  "id": "enhancedWebSearch",
  "description": {
    "en": "Performs web search...",
    "de": "Führt eine Websuche durch..."
  },
  "parameters": {
    "type": "object",
    "properties": {
      "query": {
        "type": "string",
        "description": {           // ❌ Nested object description
          "en": "The search query...",
          "de": "Die Suchanfrage..."
        }
      }
    }
  }
}
```

When these tools were sent to the Google adapter without localization:
1. The `description` fields remained as objects `{en: "...", de: "..."}`
2. Google's API expects `description` to be a string, not an object
3. Google rejected the request with the "Starting an object on a scalar field" error

The error path `tools[0].function_declarations[0].parameters.properties[1].value` pointed to deeply nested parameter descriptions that were still objects instead of strings.

## Solution

Modified `loadConfiguredTools` to **always localize tools**, using a fallback chain:
1. Use provided language if available
2. Fall back to platform default language
3. Fall back to 'en' as final fallback

```javascript
// AFTER (fixed code)
export async function loadConfiguredTools(language = null) {
  const { data: tools } = configCache.getTools();
  if (!tools) {
    logger.warn('Tools could not be loaded');
    return [];
  }

  // Always localize tools to ensure nested multilingual fields are converted to strings
  const platformConfig = configCache.getPlatform() || {};
  const effectiveLanguage = language || platformConfig?.defaultLanguage || 'en';
  return localizeTools(tools, effectiveLanguage);  // ✅ Always localizes
}
```

## How Localization Works

The `localizeTools` function calls `extractLanguageFromObject` which recursively processes all tool properties:

```javascript
function extractLanguageFromObject(obj, language = 'en', fallbackLanguage = null) {
  if (obj && typeof obj === 'object') {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      if (
        (key === 'description' || key === 'title' || key === 'name') &&
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.keys(value).some(k => k.length === 2 && typeof value[k] === 'string')
      ) {
        // Convert multilingual object to string
        result[key] = extractLanguageValue(value, language, fallbackLanguage);
      } else {
        result[key] = extractLanguageFromObject(value, language, fallbackLanguage);
      }
    }
    return result;
  }
  return obj;
}
```

This ensures that ALL nested descriptions (at any depth) are converted from objects to strings:

**Before localization:**
```json
{
  "query": {
    "description": { "en": "The search query...", "de": "Die Suchanfrage..." }
  }
}
```

**After localization (en):**
```json
{
  "query": {
    "description": "The search query..."
  }
}
```

## Impact

- **Fixes**: Google Gemini API errors when no language is provided
- **Scope**: All LLM providers benefit from always having properly localized tool schemas
- **Breaking Changes**: None - this is a bug fix that makes the system more robust
- **Performance**: Negligible - localization is lightweight and cached

## Testing

Added two comprehensive test suites:

### 1. toolLoader-localization.test.js (5 tests)
Tests that tools are always localized regardless of language parameter:
- With explicit language ('en', 'de')
- With null language
- With undefined language
- With empty string language

### 2. google-tool-schema-validation.test.js (4 integration tests)
Integration tests that verify Google-formatted tools never contain object descriptions:
- Validates with null language
- Validates with undefined language
- Validates with empty string language
- Validates deeply nested schemas (ask_user tool)

All 9 tests pass successfully.

## Files Modified

- `server/toolLoader.js` - Fixed `loadConfiguredTools` to always localize
- `server/tests/toolLoader-localization.test.js` - New test suite
- `server/tests/google-tool-schema-validation.test.js` - New integration test suite

## Related Code Locations

- Tool definitions: `server/defaults/config/tools.json`
- Google adapter: `server/adapters/google.js` (line 305-307)
- Tool conversion: `server/adapters/toolCalling/GoogleConverter.js`
- Schema sanitization: `server/adapters/toolCalling/GenericToolCalling.js` (sanitizeSchemaForProvider)

## Lessons Learned

1. **Always validate edge cases**: The code assumed `language` would always be provided, but didn't handle null/undefined/empty
2. **Multilingual data requires careful handling**: Nested multilingual objects must be localized at ALL levels, not just top-level
3. **Provider-specific requirements**: Google's strict schema validation caught this issue - other providers might be more lenient
4. **Test with minimal data**: Empty arrays and null values are common edge cases that expose bugs
