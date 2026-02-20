# Copy and Download Mechanism Fix

## Problem
When copying or downloading chat messages in HTML format, the code block toolbars (language labels, Copy button, Download button) were being included in the exported content.

## Solution
Implemented a `cleanHtmlForExport` function that removes interactive UI elements before copying or downloading content.

### Changes Made

1. **Added HTML Cleaning Utility** (`client/src/utils/markdownUtils.js`)
   - New function `cleanHtmlForExport()` that removes:
     - Code block toolbars (`.code-block-toolbar`)
     - Mermaid diagram controls (`.mermaid-diagram-controls`)
     - All button elements

2. **Updated Copy Functionality** (`client/src/features/chat/components/ChatMessage.jsx`)
   - Modified `handleCopy()` to clean HTML before copying when format is 'html'
   - HTML is converted from markdown, then cleaned before being copied

3. **Added Download Functionality** (`client/src/features/chat/components/ChatMessage.jsx`)
   - New function `handleDownload()` with support for text, markdown, and html formats
   - Added download button and menu UI (similar to copy button)
   - Downloads cleaned HTML for html format
   - State management for download menu (showDownloadMenu, downloaded)

4. **Updated Export API** (`client/src/api/endpoints/apps.js`)
   - Added `cleanHtmlForExport()` function to the export utilities
   - Updated `generateHTML()` to clean HTML before exporting

5. **Translation Keys** (`shared/i18n/en.json`, `shared/i18n/de.json`)
   - Added `chatMessage.downloadMessage`, `chatMessage.downloadOptions`, `chatMessage.deleteMessage`
   - Added `canvas.export.downloadText`, `canvas.export.downloadMarkdown`, `canvas.export.downloadHTML`
   - Added `canvas.insertIntoDocument`

## How It Works

### Copy Flow (HTML Format)
1. User clicks "Copy" → "as HTML"
2. Content is converted to HTML using `markdownToHtml()`
3. HTML is cleaned with `cleanHtmlForExport()` to remove UI elements
4. Cleaned HTML is copied to clipboard
5. Both text/html and text/plain formats are stored in clipboard

### Download Flow
1. User clicks "Download" button → selects format
2. Content is processed based on format:
   - **Text**: Original raw content
   - **Markdown**: Raw markdown or converted from HTML
   - **HTML**: Converted to HTML and cleaned
3. Content is downloaded as a file with appropriate extension and timestamp

### Cleaning Process
The `cleanHtmlForExport()` function:
1. Creates a temporary DOM element
2. Parses the HTML string into DOM
3. Removes toolbar elements (`.code-block-toolbar`)
4. Removes diagram controls (`.mermaid-diagram-controls`)
5. Removes all button elements
6. Returns cleaned HTML string

## Testing
To test the fix:
1. Start a chat with code blocks
2. Try copying the message as HTML - verify no buttons/toolbars in copied content
3. Try downloading the message as HTML - verify no buttons/toolbars in downloaded file
4. Verify text and markdown formats work correctly

## Example
Before fix:
```html
<pre>console.log('hello')</pre>
<div class="code-block-toolbar">
  <span>TYPESCRIPT</span>
  <button>Copy</button>
  <button>Download</button>
</div>
```

After fix:
```html
<pre>console.log('hello')</pre>
```
