# Web Tools Documentation

This document describes the web tools available in the iHub Apps platform for searching the web and extracting web content.

## Overview

iHub Apps provides a unified web search system that automatically selects the best search provider based on the active model. Web search is configured per-app through the `websearch` configuration object rather than through individual tool IDs.

### Search Providers

| Provider | Type | Best For |
|----------|------|----------|
| **Google Search** | Native (Gemini models) | Grounded answers with Google Search citations |
| **OpenAI Web Search** | Native (GPT models via Responses API) | Web-augmented responses with inline citations |
| **Brave Search** | Server-side | Privacy-focused search, any model |
| **Tavily Search** | Server-side | AI-optimized search, any model |

### Additional Web Tools

| Tool | Purpose |
|------|---------|
| **webContentExtractor** | Extract clean content from web pages |
| **playwrightScreenshot** | Capture screenshots or PDFs using Playwright |
| **seleniumScreenshot** | Capture screenshots or PDFs using Selenium |
| **deepResearch** | Iterative multi-round web research |
| **researchPlanner** | Decompose research topics into subtasks |
| **evaluator** | Evaluate draft answers for quality |
| **answerReducer** | Merge multiple texts into one article |
| **queryRewriter** | Rewrite search queries for better results |

## Unified Web Search Configuration

> **Changed in v5.2.11**: Web search is now configured through a unified `websearch` object on each app instead of adding individual tool IDs (like `braveSearch`, `tavilySearch`, or `enhancedWebSearch`) to the `tools` array. Existing apps are automatically migrated.

### App-Level Configuration

Add a `websearch` object to your app configuration:

```json
{
  "id": "research-assistant",
  "name": { "en": "Research Assistant" },
  "system": { "en": "You are a research assistant with web search capabilities." },
  "tokenLimit": 8000,
  "websearch": {
    "enabled": true,
    "provider": "auto",
    "useNativeSearch": true,
    "maxResults": 5,
    "extractContent": true,
    "contentMaxLength": 3000,
    "enabledByDefault": false
  }
}
```

### Configuration Properties

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `enabled` | Boolean | `false` | Enable web search for this app |
| `provider` | String | `"auto"` | Search provider: `"auto"`, `"brave"`, or `"tavily"` |
| `useNativeSearch` | Boolean | `true` | Prefer native search (Google Search for Gemini, OpenAI Web Search for GPT) when available |
| `maxResults` | Number | `5` | Maximum number of search results (1-20) |
| `extractContent` | Boolean | `true` | Extract full page content from search results |
| `contentMaxLength` | Number | `3000` | Maximum extracted content length per page (500-50,000 characters) |
| `enabledByDefault` | Boolean | `false` | Whether web search is active by default (users can toggle it in the chat) |

### How Provider Resolution Works

The system automatically selects the best search tool at runtime based on the model and configuration:

```
┌─────────────────────────────────────────────────┐
│              app.websearch.enabled?              │
│                                                  │
│  No  → No web search                            │
│  Yes ↓                                           │
│                                                  │
│  useNativeSearch + Gemini model?                 │
│    → Google Search (grounding)                   │
│                                                  │
│  useNativeSearch + OpenAI Responses model?       │
│    → OpenAI Web Search                           │
│                                                  │
│  provider = "tavily"?                            │
│    → Tavily Search                               │
│                                                  │
│  Otherwise (provider = "auto" or "brave")        │
│    → Brave Search                                │
└─────────────────────────────────────────────────┘
```

### Admin UI Configuration

Web search settings can be configured through the admin panel:

1. Navigate to **Admin → Apps → Edit App**
2. Scroll to the **Web Search Configuration** section
3. Toggle **Enable Web Search** to activate
4. Configure provider, result limits, and content extraction settings
5. Save changes — no server restart required

### User Toggle

When web search is enabled for an app, users see a toggle in the chat input area to enable/disable web search per conversation. The `enabledByDefault` setting controls whether this toggle starts in the on or off state.

### Migration from Legacy Tool Configuration

Apps that previously used websearch tool IDs in their `tools` array are automatically migrated on server startup (Migration V025). The migration:

- Detects apps with `braveSearch`, `enhancedWebSearch`, `tavilySearch`, `googleSearch`, `webSearch`, or `webContentExtractor` in their `tools` array
- Infers the provider and content extraction settings from the tools used
- Creates a unified `websearch` configuration object
- Removes the deprecated tool IDs from the `tools` array

No manual action is required — the migration runs automatically.

## Answer Source Attribution

> **Added in v5.2.12**: Each AI response now displays a badge indicating the information source used.

When web search or other external sources are used, an **Answer Source Badge** appears on each message showing where the information came from:

| Badge | Color | Description |
|-------|-------|-------------|
| LLM Only | Gray | Response generated purely from the model's knowledge |
| Web Search | Green | Response includes information from web search results |
| Sources | Purple | Response uses configured knowledge base sources |
| iAssistant | Indigo | Response includes information from iFinder iAssistant |
| Grounding | Teal | Response uses Google Search grounding (Gemini) |
| Mixed | Blue | Response combines multiple information sources |

When multiple sources are used, a tooltip lists all contributing sources.

## Search Provider Configuration

### API Key Setup

Search providers require API keys, which can be configured in two ways:

#### Admin Panel (Recommended)

1. Navigate to **Admin → Providers**
2. Find your provider under **Web Search Providers**:
   - **Brave Search**: Click "Configure" and enter your Brave API key
   - **Tavily Search**: Click "Configure" and enter your Tavily API key
3. Save changes — no server restart required

API keys are encrypted at rest using AES-256-GCM.

#### Environment Variables (Fallback)

Add to your `config.env` file:

```env
BRAVE_SEARCH_API_KEY=your_brave_api_key_here
TAVILY_SEARCH_API_KEY=your_tavily_search_api_key_here
```

The system checks admin panel configuration first, then falls back to environment variables.

### Native Search Providers

Native search providers (Google Search and OpenAI Web Search) use the API keys already configured for the respective LLM providers. No additional API key setup is needed.

## Tools Reference

### Brave Search (`braveSearch`)

**Purpose**: Search the web using Brave Search API for up-to-date information.

**Parameters**:

- `query` (string, required): Search query
- `extractContent` (boolean, optional): Extract full content from top results (default: configured by app)
- `maxResults` (number, optional): Maximum results to return (default: configured by app, max: 10)
- `contentMaxLength` (number, optional): Maximum content length per page (default: configured by app)

**Returns**: Array of search results with titles, URLs, descriptions, and optionally extracted page content.

### Tavily Search (`tavilySearch`)

**Purpose**: Search the web using the Tavily API, optimized for AI agents.

**Parameters**:

- `query` (string, required): Search query
- `search_depth` (string, optional): `"basic"` or `"advanced"` (default: `"basic"`)
- `max_results` (integer, optional): Number of results to return (default: configured by app, max: 10)
- `extractContent` (boolean, optional): Extract full content from results (default: configured by app)
- `contentMaxLength` (number, optional): Maximum content length per page (default: configured by app)

**Returns**: Array of search results with titles, URLs, content snippets, and optionally extracted page content.

### Google Search (`googleSearch`)

**Purpose**: Ground Gemini model responses with real-time Google Search results.

- **Provider**: Google Gemini models only
- **Type**: Provider-handled (native)
- **Parameters**: None — automatically enabled
- **Authentication**: Uses configured Gemini API key

### OpenAI Web Search (`webSearch`)

**Purpose**: Enable web search for OpenAI models via the Responses API.

- **Provider**: OpenAI GPT models only
- **Type**: Provider-handled (native)
- **Parameters**: None — automatically enabled
- **Authentication**: Uses configured OpenAI API key

### Web Content Extractor (`webContentExtractor`)

**Purpose**: Extract clean, readable content from any webpage URL, automatically removing headers, footers, navigation, ads, and other non-content elements.

**Parameters**:

- `url` (string, required): The URL of the webpage to extract content from
- `maxLength` (integer, optional): Maximum length of extracted content in characters (default: 5000)
- `ignoreSSL` (boolean, optional, admin only): Ignore invalid HTTPS certificates. If omitted, the value configured in `tools.json` is used.

**Returns**:

- Clean text content
- Page metadata (title, description, author)
- Word count and extraction timestamp
- If an error occurs, an exception is thrown with a `code` property for translation

**Features**:

- Removes ads, navigation menus, headers, footers
- Extracts main article content intelligently
- Handles various webpage structures
- Provides metadata extraction
- Error handling for invalid URLs or failed requests
- Optional `ignoreSSL` flag to bypass invalid HTTPS certificates (value can be preset in `tools.json`)
- Detects missing pages or authentication requirements and reports them clearly
- Returned errors include a `code` field so applications can translate messages and the UI automatically shows a localized error when possible
- **SSRF protection**: Blocks access to private/internal IP addresses. Domains listed in the SSL whitelist configuration bypass this check (added in v5.2.12)

### Playwright Screenshot (`playwrightScreenshot`)

**Purpose**: Capture a screenshot or PDF of any webpage using the Playwright browser automation library. If a PDF is captured, the text is extracted and returned.

**Parameters**:

- `url` (string, required): Page URL to capture
- `format` (string, optional): `"png"` or `"pdf"` (default: `"png"`)
- `fullPage` (boolean, optional): Capture the full page height (default: `true`)

**Returns**: Attachment information with a download URL and extracted text for PDFs.

### Selenium Screenshot (`seleniumScreenshot`)

**Purpose**: Capture screenshots or PDFs using Selenium and Chrome DevTools.

**Parameters**:

- `url` (string, required): Page URL to capture
- `format` (string, optional): `"png"` or `"pdf"` (default: `"png"`)
- `fullPage` (boolean, optional): Capture the full page height (default: `true`)

**Returns**: Attachment information with a download URL and extracted text for PDFs.

### Answer Evaluator (`evaluator`)

**Purpose**: Check a draft answer for definitiveness, freshness and completeness.

**Parameters**:

- `question` (string, required): Original user question
- `answer` (string, required): Draft answer to evaluate
- `model` (string, optional): Model ID used for the evaluation (default `gemini-1.5-flash`)

**Returns**: Array `evaluation` with one entry per check containing `type`, `pass`, and `think` fields.

### Answer Reducer (`answerReducer`)

**Purpose**: Compress multiple text excerpts into a single well-structured article.

**Usage**: Pass an array of strings under the `answers` parameter.

```json
{
  "answers": ["text from source 1", "text from source 2"]
}
```

### Query Rewriter (`queryRewriter`)

**Purpose**: Generate optimized variations of a user search query.

**Parameters**:

- `query` (string, required): The original search query
- `think` (string, optional): Additional motivation or notes
- `context` (string, optional): Optional contextual text

**Returns**: An array of rewritten queries.

### Deep Research (`deepResearch`)

**Purpose**: Perform iterative web searches and content extraction while sending progress events to the frontend.

**Usage**: Include the `chatId` parameter when called from a chat session so the tool can emit progress updates.

```json
{
  "query": "renewable energy market analysis",
  "maxRounds": 2,
  "chatId": "{currentChatId}"
}
```

### Research Planner (`researchPlanner`)

**Purpose**: Decompose a research topic into distinct tasks for a team of researchers.

**Parameters**:

- `question` (string, required): Research topic to analyze
- `teamSize` (integer, optional): Number of tasks to create (default: 3)
- `soundBites` (string, optional): Additional context or quotes

**Returns**: JSON containing the `subproblems` array and internal reasoning in `think`.

## Installation Requirements

Run `npx playwright install` after installing dependencies. Selenium tools require a local Chrome or Chromium executable available in your `PATH`.

## Complete Example

Here is a complete app configuration with web search enabled:

```json
{
  "id": "web-chat",
  "name": {
    "en": "Web Chat",
    "de": "Web Chat"
  },
  "description": {
    "en": "General chat assistant with web search",
    "de": "Allgemeiner Chat-Assistent mit Websuche"
  },
  "color": "#4F46E5",
  "icon": "chat-bubbles",
  "system": {
    "en": "You are a helpful AI assistant with access to web search. When the user asks a question that requires current information, use the web search tool to find relevant content. Always cite your sources with URLs.",
    "de": "Du bist ein hilfreicher KI-Assistent mit Zugriff auf Websuche. Wenn der Benutzer eine Frage stellt, die aktuelle Informationen erfordert, nutze das Websuch-Tool. Zitiere immer deine Quellen mit URLs."
  },
  "tokenLimit": 8000,
  "preferredModel": "gemini-2.5-flash-preview-05-20",
  "preferredOutputFormat": "markdown",
  "websearch": {
    "enabled": true,
    "provider": "auto",
    "useNativeSearch": true,
    "maxResults": 5,
    "extractContent": true,
    "contentMaxLength": 3000,
    "enabledByDefault": false
  }
}
```

## Technical Implementation

### Content Extraction Algorithm

The web content extractor uses the following approach:

1. **Fetch webpage** with appropriate headers and timeout
2. **Parse HTML** using JSDOM
3. **Remove unwanted elements** (ads, navigation, etc.)
4. **Identify main content** using semantic selectors
5. **Clean and format text** for readability
6. **Extract metadata** (title, description, author)
7. **Apply length limits** and return structured result

### SSRF Protection

The web content extractor includes protection against Server-Side Request Forgery (SSRF):

- Blocks requests to private and internal IP addresses
- Blocks access to cloud metadata services (169.254.x.x, etc.)
- Only allows HTTP/HTTPS protocols
- **SSL-whitelisted domains** bypass the private IP check, allowing access to internal services that have been explicitly approved by the administrator (added in v5.2.12)

### Error Handling

- Invalid URLs are caught and reported
- Network timeouts are handled gracefully
- Failed content extractions don't break the search flow
- Detailed error messages help with debugging

### Performance Considerations

- Parallel processing of multiple URLs
- Configurable timeouts and content limits
- Efficient DOM parsing and text extraction
- Graceful degradation when extraction fails
- Parameter defaults are overridden by admin-configured websearch values at runtime

## Security Considerations

- URL validation prevents malicious requests
- Only HTTP/HTTPS protocols are supported
- Request timeouts prevent hanging connections
- Content length limits prevent memory issues
- User-Agent headers for responsible web crawling
- SSRF protection blocks access to internal networks
- API keys encrypted at rest in the admin panel

## Troubleshooting

### Common Issues

1. **"BRAVE_SEARCH_API_KEY is not set"**
   - Configure the key via Admin → Providers → Brave Search (recommended)
   - Or set the API key in your `config.env` file and restart the server

2. **"TAVILY_SEARCH_API_KEY is not set"**
   - Configure the key via Admin → Providers → Tavily Search (recommended)
   - Or set the API key in your `config.env` file and restart the server

3. **"Failed to extract content"**
   - Check if the URL is accessible
   - Some websites may block automated requests
   - Try with a different URL to test functionality

4. **"Request timeout"**
   - The webpage is taking too long to load
   - Consider increasing timeout or trying a different URL

5. **Web search not working after upgrade**
   - Migration V025 automatically converts old tool-based configs to the new `websearch` format
   - Check server logs for migration output
   - Verify the app has `websearch.enabled: true` in its configuration

6. **Native search not activating for Gemini/GPT models**
   - Ensure `useNativeSearch` is `true` (default)
   - Verify the model's provider is correctly identified as `google` or `openai-responses`

### Debugging

Enable detailed logging by checking the console output when running the tools. The server logs include information about which websearch tool was selected and why.
