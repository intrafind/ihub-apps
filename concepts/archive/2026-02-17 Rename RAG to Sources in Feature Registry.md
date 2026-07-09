# Rename "RAG" to "Sources" in Feature Registry

**Date:** 2026-02-17  
**Status:** ✅ Completed  
**Related Issue:** Rename "RAG" in features to Sources

## Summary

Renamed the "Sources" feature in the feature registry from misleading "Knowledge Sources (RAG)" terminology to simply "Sources" with a more accurate description.

## Problem

The "sources" feature was labeled as "Knowledge Sources (RAG)" with a description mentioning "Retrieval-augmented generation with custom knowledge bases". This was misleading because the system doesn't actually implement RAG (Retrieval-Augmented Generation). Instead, it simply adds sources directly into the prompt context.

## Solution

Updated the feature registry (`server/featureRegistry.js`) to use more accurate naming and descriptions:

### Changes Made

**English:**
- **Name:** "Knowledge Sources (RAG)" → "Sources"
- **Description:** "Retrieval-augmented generation with custom knowledge bases" → "Add custom knowledge sources directly to prompts"

**German:**
- **Name:** "Wissensquellen (RAG)" → "Quellen"
- **Description:** "Retrieval-augmentierte Generierung mit benutzerdefinierten Wissensbasen" → "Benutzerdefinierte Wissensquellen direkt zu Prompts hinzufügen"

## Implementation Details

### File Modified
- `server/featureRegistry.js` (lines 54-62)

### Code Changes
```javascript
{
  id: 'sources',
  name: { en: 'Sources', de: 'Quellen' },
  description: {
    en: 'Add custom knowledge sources directly to prompts',
    de: 'Benutzerdefinierte Wissensquellen direkt zu Prompts hinzufügen'
  },
  category: 'ai',
  default: true
}
```

## Testing

- ✅ Linting passed with no errors
- ✅ Server startup successful
- ✅ Configuration cache loads correctly
- ✅ No breaking changes to existing functionality

## Impact

This change affects:
1. **Admin Features Page:** The feature name and description displayed in the admin panel
2. **User Understanding:** Clearer communication about what the feature actually does
3. **No Code Changes:** The feature ID (`sources`) remains unchanged, so no other code modifications were needed

## Notes

- The feature ID remains `sources` to maintain backward compatibility
- This is a display-only change - no functional changes were made
- The feature's behavior (adding sources to prompts) remains exactly the same
