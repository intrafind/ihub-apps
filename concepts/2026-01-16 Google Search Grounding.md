# 2026-01-16 Google Search Grounding for Gemini

## Overview

This concept implements support for Google Search grounding as a tool in the iHub Apps platform. Google Search grounding is a Gemini-specific feature that allows the AI to access real-time information from Google Search and provide verifiable, up-to-date answers with citations.

## Background

Gemini models support a special type of tool called "grounding with Google Search" that enables the AI to:
- Perform real-time Google searches based on user queries
- Synthesize information from multiple sources
- Provide answers with inline citations
- Return grounding metadata including search queries and source URLs

This is different from regular function-calling tools because:
1. It's handled entirely by the Gemini API (not executed server-side)
2. It uses a special `google_search` configuration instead of `functionDeclarations`
3. It requires no parameters to be defined
4. It's only available for Gemini models

## Implementation

### 1. Tool Definition

Added a new tool definition in `server/defaults/config/tools.json`:

```json
{
  "id": "googleSearch",
  "name": {
    "en": "Google Search Grounding",
    "de": "Google-Suche-Grounding"
  },
  "description": {
    "en": "Ground Gemini's responses with real-time information from Google Search...",
    "de": "Grundiert Geminis Antworten mit Echtzeitinformationen..."
  },
  "provider": "google",
  "isSpecialTool": true,
  "parameters": {
    "type": "object",
    "properties": {}
  }
}
```

Key fields:
- `provider: "google"` - Indicates this is Google/Gemini-specific
- `isSpecialTool: true` - Marks it as provider-handled (not server-executed)
- Empty parameters - No configuration needed

### 2. Google Converter Updates

Modified `server/adapters/toolCalling/GoogleConverter.js` to handle the special format:

```javascript
export function convertGenericToolsToGoogle(genericTools = []) {
  const tools = [];
  
  // Separate Google Search tool from regular function-based tools
  const googleSearchTool = genericTools.find(tool => tool.id === 'googleSearch');
  const functionTools = genericTools.filter(tool => tool.id !== 'googleSearch');
  
  // Add Google Search grounding if present
  if (googleSearchTool) {
    tools.push({ google_search: {} });
  }
  
  // Add regular function declarations if present
  if (functionTools.length > 0) {
    tools.push({
      functionDeclarations: functionTools.map(tool => ({...}))
    });
  }
  
  return tools;
}
```

This ensures Google Search is formatted as `{ google_search: {} }` while other tools use `functionDeclarations`.

### 3. Tool Loader Updates

Modified `server/toolLoader.js` to skip execution for special tools:

```javascript
// Check if this is a special tool (like Google Search) that doesn't have a script
if (tool.isSpecialTool) {
  console.log(`Special tool ${toolId} is handled by provider, skipping execution`);
  return { handled_by_provider: true };
}
```

This prevents the server from trying to execute provider-handled tools.

### 4. Grounding Metadata Handling

The existing code in `server/services/chat/StreamingHandler.js` already handles grounding metadata:

```javascript
processGroundingMetadata(result, chatId) {
  if (result && result.groundingMetadata) {
    actionTracker.trackAction(chatId, {
      event: 'grounding',
      metadata: result.groundingMetadata
    });
  }
}
```

This tracks grounding events and metadata for analytics.

## Usage

### In App Configuration

To enable Google Search grounding in an app:

```json
{
  "id": "my-app",
  "name": {"en": "My App"},
  "models": ["gemini-2.5-flash"],
  "tools": ["googleSearch"],
  "systemPrompt": {
    "en": "Use Google Search to provide accurate, up-to-date information..."
  }
}
```

### Example App

Created `examples/apps/google-search-grounding-test.json` as a reference implementation demonstrating how to use the feature.

### Response Format

When grounding is used, the Gemini API returns additional metadata:

```json
{
  "groundingMetadata": {
    "webSearchQueries": ["search query 1", "search query 2"],
    "groundingChunks": [
      {"web": {"uri": "https://example.com", "title": "Example"}}
    ],
    "groundingSupports": [
      {
        "segment": {"text": "Spain won Euro 2024..."},
        "groundingChunkIndices": [0]
      }
    ]
  }
}
```

## Code Locations

- **Tool Definition**: `server/defaults/config/tools.json` (line 2-17)
- **Google Converter**: `server/adapters/toolCalling/GoogleConverter.js` (line 22-47)
- **Tool Loader**: `server/toolLoader.js` (line 233-238)
- **Metadata Handling**: `server/services/chat/StreamingHandler.js` (line 46-52)
- **Documentation**: `docs/tools.md` (line 19-30)
- **Example App**: `examples/apps/google-search-grounding-test.json`

## Limitations

1. **Gemini-only**: This feature only works with Gemini models
2. **No parameters**: Unlike regular tools, grounding has no configurable parameters
3. **API availability**: Requires Gemini models that support grounding (2.0+, 2.5+, 3.0+)
4. **Rate limits**: Subject to Google's API rate limits

## Future Enhancements

1. Add UI indicators for grounded responses with citations
2. Display grounding metadata (sources, search queries) in the chat interface
3. Allow users to click on citations to view source URLs
4. Add analytics dashboard for grounding usage
5. Support other grounding sources (custom search APIs) if Google adds support

## Testing

- Created test app configuration in `examples/apps/google-search-grounding-test.json`
- Verified server startup successfully
- Linting and formatting checks pass
- Tool appears in admin interface when configured

Manual testing required:
1. Enable the tool in an app configuration
2. Ask questions requiring current information (e.g., "Who won the latest Super Bowl?")
3. Verify response includes grounding metadata
4. Check action tracker logs for grounding events

## References

- [Google Gemini Grounding Documentation](https://ai.google.dev/gemini-api/docs/google-search)
- [Gemini Cookbook - Search Grounding](https://github.com/google-gemini/cookbook/blob/main/quickstarts/Search_Grounding.ipynb)
