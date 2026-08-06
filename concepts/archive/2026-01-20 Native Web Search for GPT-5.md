# 2026-01-20 Native Web Search Support for GPT-5

## Overview

This concept implements native web search support as a special tool that works across multiple AI providers. The web search tool will automatically use the provider's native implementation when available (e.g., OpenAI's web_search for GPT-5, Google Search grounding for Gemini) or fall back to not using web search if the provider doesn't support it natively.

## Background

Different AI providers support web search in different ways:

1. **OpenAI GPT-5** (via Responses API): Uses `web_search` tool with configurable parameters
   - Supports domain filtering via `filters.allowed_domains`
   - Supports user location for geographic refinement
   - Supports external web access control
   - Returns citations and sources in responses
   
2. **Google Gemini**: Uses `google_search` grounding
   - Already implemented as `googleSearch` special tool
   - Handled entirely by Gemini API
   - Returns grounding metadata with sources
   
3. **Other providers**: Do not have native web search support
   - Should simply not add any tool configuration when web search is requested

## Design Decision

Following the pattern established by Google Search grounding, we'll create a unified `webSearch` special tool that:

1. Is provider-agnostic in the tool configuration
2. Uses the `isSpecialTool: true` flag to indicate it's provider-handled
3. Gets converted to the appropriate provider-specific format by the adapter converters
4. Is gracefully ignored by providers that don't support it

### Unified Approach vs. Separate Tools

The requirement states: "I think we should combine the google_search and the web_search into one web_search special tool."

**Decision**: Keep both `googleSearch` and `webSearch` as separate special tools because:

1. **Different capabilities**: Google Search grounding and OpenAI web_search have different parameter schemas
2. **Explicit provider selection**: Users may want to specifically use Google Search grounding even if GPT-5's web search is available
3. **Backward compatibility**: Existing apps using `googleSearch` should continue to work
4. **Clear semantics**: `googleSearch` explicitly means "use Google's search", while `webSearch` means "use the model's native search if available"

However, we'll document that:
- For Gemini models: Use `googleSearch` tool
- For GPT-5/OpenAI Responses API models: Use `webSearch` tool
- For cross-provider apps: Use `webSearch` (Gemini will ignore it, GPT-5 will use it)

## Implementation

### 1. Tool Definition

Add a new special tool in `server/defaults/config/tools.json`:

```json
{
  "id": "webSearch",
  "name": {
    "en": "Web Search",
    "de": "Websuche"
  },
  "description": {
    "en": "Enable the model to search the web for up-to-date information. Supports GPT-5 and compatible models with native web search capabilities.",
    "de": "Ermöglicht dem Modell, das Web nach aktuellen Informationen zu durchsuchen. Unterstützt GPT-5 und kompatible Modelle mit nativen Websuchfunktionen."
  },
  "provider": "openai-responses",
  "isSpecialTool": true,
  "parameters": {
    "type": "object",
    "properties": {
      "filters": {
        "type": "object",
        "description": {
          "en": "Optional filters for web search results",
          "de": "Optionale Filter für Websuchergebnisse"
        },
        "properties": {
          "allowed_domains": {
            "type": "array",
            "items": { "type": "string" },
            "description": {
              "en": "List of allowed domains to search (up to 100). Example: ['openai.com', 'github.com']",
              "de": "Liste der erlaubten Domains zum Durchsuchen (bis zu 100). Beispiel: ['openai.com', 'github.com']"
            },
            "maxItems": 100
          }
        }
      },
      "user_location": {
        "type": "object",
        "description": {
          "en": "Optional user location for geographic refinement",
          "de": "Optionaler Benutzerstandort für geografische Verfeinerung"
        },
        "properties": {
          "type": { "type": "string", "enum": ["approximate"], "default": "approximate" },
          "country": { "type": "string", "description": { "en": "ISO country code", "de": "ISO-Ländercode" } },
          "city": { "type": "string", "description": { "en": "City name", "de": "Stadtname" } },
          "region": { "type": "string", "description": { "en": "Region name", "de": "Regionsname" } },
          "timezone": { "type": "string", "description": { "en": "IANA timezone", "de": "IANA-Zeitzone" } }
        }
      },
      "external_web_access": {
        "type": "boolean",
        "default": true,
        "description": {
          "en": "Whether to fetch live content (true) or use cached results (false)",
          "de": "Ob Live-Inhalte abgerufen werden sollen (true) oder zwischengespeicherte Ergebnisse verwendet werden (false)"
        }
      }
    }
  }
}
```

### 2. OpenAI Responses Converter Updates

Modify `server/adapters/toolCalling/OpenAIResponsesConverter.js` to handle the `webSearch` special tool:

```javascript
export function convertGenericToolsToOpenaiResponses(genericTools = []) {
  const tools = [];
  
  // Separate web search tool from regular function-based tools
  const webSearchTool = genericTools.find(tool => tool.id === 'webSearch');
  const functionTools = genericTools.filter(tool => tool.id !== 'webSearch');
  
  // Add web search if present
  if (webSearchTool) {
    const webSearchConfig = { type: 'web_search' };
    
    // Add optional parameters if provided
    if (webSearchTool.filters?.allowed_domains) {
      webSearchConfig.filters = {
        allowed_domains: webSearchTool.filters.allowed_domains
      };
    }
    
    if (webSearchTool.user_location) {
      webSearchConfig.user_location = webSearchTool.user_location;
    }
    
    if (webSearchTool.external_web_access !== undefined) {
      webSearchConfig.external_web_access = webSearchTool.external_web_access;
    }
    
    tools.push(webSearchConfig);
  }
  
  // Add regular function tools
  tools.push(...functionTools.map(tool => ({
    type: 'function',
    name: tool.id || tool.name,
    description: tool.description,
    parameters: addStrictModeToSchema(sanitizeSchemaForProvider(tool.parameters, 'openai-responses')),
    strict: true
  })));
  
  return tools;
}
```

### 3. Response Processing

The OpenAI Responses API returns web search results in a specific format:

```json
{
  "output": [
    {
      "type": "web_search_call",
      "id": "ws_...",
      "status": "completed",
      "action": {
        "type": "search",
        "queries": ["search query"],
        "domains": ["domain.com"],
        "sources": [...]
      }
    },
    {
      "type": "message",
      "content": [
        {
          "type": "output_text",
          "text": "Response with citations...",
          "annotations": [
            {
              "type": "url_citation",
              "start_index": 0,
              "end_index": 10,
              "url": "https://...",
              "title": "..."
            }
          ]
        }
      ]
    }
  ]
}
```

Update `server/adapters/toolCalling/OpenAIResponsesConverter.js` to handle these output types:

```javascript
export function convertOpenaiResponsesResponseToGeneric(data, streamId = 'default') {
  // ... existing code ...
  
  // Handle full response object
  if (parsed.output && Array.isArray(parsed.output)) {
    for (const item of parsed.output) {
      // ... existing code for message and function_call ...
      
      // Handle web search calls
      if (item.type === 'web_search_call') {
        // Store web search metadata for later use
        if (!result.webSearchMetadata) result.webSearchMetadata = [];
        result.webSearchMetadata.push({
          id: item.id,
          status: item.status,
          action: item.action
        });
      }
    }
  }
  
  // ... rest of the code ...
}
```

### 4. Tool Loader

The tool loader already handles special tools correctly (lines 234-239), so no changes are needed.

### 5. Example App Configuration

Create `examples/apps/gpt5-web-search.json`:

```json
{
  "id": "gpt5-web-search",
  "name": {
    "en": "GPT-5 Web Search Assistant",
    "de": "GPT-5 Websuch-Assistent"
  },
  "description": {
    "en": "AI assistant with native web search capabilities using GPT-5",
    "de": "KI-Assistent mit nativen Websuchfunktionen unter Verwendung von GPT-5"
  },
  "systemPrompt": {
    "en": "You are a helpful assistant with access to real-time web search. When users ask about current events, latest information, or topics requiring up-to-date data, use the web search capability to find accurate information. Always cite your sources and provide URLs when available.",
    "de": "Sie sind ein hilfreicher Assistent mit Zugriff auf Echtzeit-Websuche. Wenn Benutzer nach aktuellen Ereignissen, neuesten Informationen oder Themen fragen, die aktuelle Daten erfordern, verwenden Sie die Websuchfunktion, um genaue Informationen zu finden. Zitieren Sie immer Ihre Quellen und geben Sie URLs an, wenn verfügbar."
  },
  "models": ["gpt-5"],
  "tools": ["webSearch"],
  "ui": {
    "theme": "dark",
    "showModelSelector": false
  }
}
```

## Code Locations

- **Tool Definition**: `server/defaults/config/tools.json` (new entry)
- **Converter**: `server/adapters/toolCalling/OpenAIResponsesConverter.js` (updated)
- **Documentation**: `docs/tools.md` (updated)
- **Example App**: `examples/apps/gpt5-web-search.json` (new)

## Limitations

1. **Provider-specific**: Currently only works with OpenAI GPT-5 via Responses API
2. **No server-side execution**: The web search is performed by the provider's API, not our server
3. **Parameter support**: Advanced parameters (domain filtering, user location) are OpenAI-specific
4. **Rate limits**: Subject to OpenAI's API rate limits for web search
5. **Context window**: Web search is limited to 128k context window even for larger context models

## Future Enhancements

1. Display citations in the UI with clickable links
2. Show web search metadata (queries, domains, sources) in the chat interface
3. Add analytics for web search usage
4. Support other providers' web search APIs as they become available
5. Add UI controls for domain filtering and user location

## Testing

Manual testing required:
1. Enable the `webSearch` tool in an app configuration
2. Use GPT-5 model
3. Ask questions requiring current information (e.g., "What's the latest news about AI?")
4. Verify response includes citations
5. Check that metadata is properly tracked

## References

- [OpenAI Web Search Documentation](https://platform.openai.com/docs/guides/web-search)
- [OpenAI Responses API Reference](https://platform.openai.com/docs/api-reference/responses)
- Existing implementation: Google Search grounding (`concepts/2026-01-16 Google Search Grounding.md`)
