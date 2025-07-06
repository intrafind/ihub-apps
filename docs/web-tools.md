# Web Tools Documentation

This document describes the web tools available in the AI Hub Apps platform for extracting and searching web content.

## Overview

The platform now includes several web-related tools:

1. **braveSearch** - Basic web search using Brave Search API
2. **webContentExtractor** - Extract clean content from web pages
3. **enhancedWebSearch** - Combined web search with automatic content extraction
4. **playwrightScreenshot** - Capture screenshots or PDFs using Playwright
5. **seleniumScreenshot** - Capture screenshots or PDFs using Selenium
6. **evaluator** - Evaluate draft answers for definitiveness, freshness and completeness
7. **answerReducer** - Merge multiple texts into one concise article
7. **queryRewriter** - Rewrite search queries for deeper results

## Tools Description

### 1. Brave Search (`braveSearch`)

**Purpose**: Search the web using Brave Search API for up-to-date information.

**Parameters**:
- `query` (string, required): Search query

**Returns**: List of search results with titles, URLs, descriptions, and language information.

**Example Usage**:
```javascript
{
  "query": "latest AI developments 2024"
}
```

### 2. Web Content Extractor (`webContentExtractor`)

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

**Example Usage**:
```javascript
{
  "url": "https://example.com/article",
  "maxLength": 3000
}
```

**Features**:
- Removes ads, navigation menus, headers, footers
- Extracts main article content intelligently
- Handles various webpage structures
- Provides metadata extraction
- Error handling for invalid URLs or failed requests
- Optional `ignoreSSL` flag to bypass invalid HTTPS certificates (value can be preset in `tools.json`)
- Detects missing pages or authentication requirements and reports them clearly
- Returned errors include a `code` field so applications can translate messages
  and the UI automatically shows a localized error when possible

### 3. Enhanced Web Search (`enhancedWebSearch`)

**Purpose**: Performs web search and automatically extracts full content from the top results. Perfect for comprehensive information gathering and "chat with web" functionality.

**Parameters**:
- `query` (string, required): Search query
- `extractContent` (boolean, optional): Whether to extract full content from search results (default: true)
- `maxResults` (integer, optional): Maximum number of search results to process (default: 3)
- `contentMaxLength` (integer, optional): Maximum length of extracted content per page (default: 3000)

**Returns**:
- Original search results
- Extracted content from each result
- Success/failure statistics
- Summary of the operation

**Example Usage**:
```javascript
{
  "query": "artificial intelligence news 2024",
  "extractContent": true,
  "maxResults": 5,
  "contentMaxLength": 2000
}
```

### 4. Playwright Screenshot (`playwrightScreenshot`)

**Purpose**: Capture a screenshot or PDF of any webpage using the Playwright browser automation library. If a PDF is captured, the text is extracted and returned.

**Parameters**:
- `url` (string, required): Page URL to capture
- `format` (string, optional): `"png"` or `"pdf"` (default: `"png"`)
- `fullPage` (boolean, optional): Capture the full page height (default: `true`)

**Returns**: Attachment information with a download URL and extracted text for PDFs.

**Example Usage**:
```javascript
{
  "url": "https://example.com",
  "format": "pdf"
}
```

### 5. Selenium Screenshot (`seleniumScreenshot`)

**Purpose**: Capture screenshots or PDFs using Selenium and Chrome DevTools.

**Parameters**:
- `url` (string, required): Page URL to capture
- `format` (string, optional): `"png"` or `"pdf"` (default: `"png"`)
- `fullPage` (boolean, optional): Capture the full page height (default: `true`)

**Returns**: Attachment information with a download URL and extracted text for PDFs.

**Example Usage**:
```javascript
{
  "url": "https://example.com",
  "format": "png"
}
```
### 6. Answer Evaluator (`evaluator`)

**Purpose**: Check a draft answer for definitiveness, freshness and completeness.

**Parameters**:
- `question` (string, required): Original user question
- `answer` (string, required): Draft answer to evaluate
- `model` (string, optional): Model ID used for the evaluation (default `gemini-1.5-flash`)

**Returns**: Array `evaluation` with one entry per check containing `type`, `pass`, and `think` fields.

**Example Usage**:
```javascript
{
  "question": "What are the latest AI trends?",
  "answer": "AI is progressing rapidly..."
}
```

### 7. Answer Reducer (`answerReducer`)

**Purpose**: Compress multiple text excerpts into a single well-structured article.

**Usage**: Pass an array of strings under the `answers` parameter.

```json
{
  "answers": ["text from source 1", "text from source 2"]
}
```

### 8. Query Rewriter (`queryRewriter`)

**Purpose**: Generate optimized variations of a user search query.

**Parameters**:
- `query` (string, required): The original search query
- `think` (string, optional): Additional motivation or notes
- `context` (string, optional): Optional contextual text

**Returns**: An array of rewritten queries.

**Example Usage**:
```javascript
{
  "query": "best renewable energy sources"
}
```

## Configuration

### Environment Variables

Set the following environment variable in your `config.env` file:

```env
BRAVE_SEARCH_API_KEY=your_brave_api_key_here
```

### Installation Requirements

Run `npx playwright install` after installing dependencies. Selenium tools require a local Chrome or Chromium executable available in your `PATH`.

### App Configuration

To enable these tools in an app, add them to the `tools` array in your app configuration:

```json
{
  "id": "your-app-id",
  "tools": ["enhancedWebSearch", "webContentExtractor"],
  "system": "You are an AI assistant with web search capabilities..."
}
```

## Usage Examples

### Chat with Web App

The "Chat with Web" app has been updated to use the enhanced web search functionality:

- **Tool**: `enhancedWebSearch` and `webContentExtractor`
- **Capability**: Automatically searches the web and extracts full content for comprehensive answers. If your question contains a direct URL, the assistant loads that page using `webContentExtractor` and incorporates the contents into the response.
- **Use Case**: Ask questions that require current information or provide a URL to analyze, and get detailed answers with source citations

### Example Queries for Enhanced Web Search

1. **News and Current Events**:
   - "What are the latest developments in AI technology?"
   - "Current stock market trends"
   - "Recent climate change research findings"

2. **Research and Analysis**:
   - "Best practices for sustainable energy"
   - "Comparison of different programming frameworks"
   - "Latest medical breakthroughs in cancer treatment"

3. **Product Information**:
   - "Reviews of latest smartphone models"
   - "Comparison of electric vehicle features"
   - "Software pricing and features comparison"

### 4. Deep Research (`deepResearch`)

**Purpose**: Perform iterative web searches and content extraction while sending progress events to the frontend.

**Usage**: Include the `chatId` parameter when called from a chat session so the tool can emit progress updates.

**Example**:

```json
{
  "query": "renewable energy market analysis",
  "maxRounds": 2,
  "chatId": "{currentChatId}"
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

## Testing

Use the test script to verify functionality:

```bash
cd server/tools
node test-web-tools.js
```

This will test:
- Basic content extraction
- Error handling
- Different webpage structures

## Security Considerations

- URL validation prevents malicious requests
- Only HTTP/HTTPS protocols are supported
- Request timeouts prevent hanging connections
- Content length limits prevent memory issues
- User-Agent headers for responsible web crawling

## Troubleshooting

### Common Issues

1. **"BRAVE_SEARCH_API_KEY is not set"**
   - Set the API key in your `config.env` file
   - Restart the server after setting the key

2. **"Failed to extract content"**
   - Check if the URL is accessible
   - Some websites may block automated requests
   - Try with a different URL to test functionality

3. **"Request timeout"**
   - The webpage is taking too long to load
   - Consider increasing timeout or trying a different URL

### Debugging

Enable detailed logging by checking the console output when running the tools. The enhanced web search tool provides comprehensive statistics about success/failure rates.
