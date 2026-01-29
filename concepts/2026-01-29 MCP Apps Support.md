# MCP Apps Support

## Summary

This concept implements support for MCP Apps (Model Context Protocol Apps) in the iHub Apps platform. MCP Apps allow tools to return interactive HTML interfaces that render directly in chat conversations, providing rich user experiences for data visualization, forms, monitoring dashboards, and multi-step workflows.

## Goals

- Enable tools to declare and serve interactive UI resources
- Render MCP Apps in sandboxed iframes within chat messages
- Implement bidirectional communication between apps and the host
- Maintain security through iframe sandboxing and message validation
- Provide developer-friendly API for creating MCP Apps

## Background

MCP Apps extend the Model Context Protocol by allowing tools to return interactive HTML interfaces instead of just text or structured data. This enables:

- **Context preservation**: Apps live inside the conversation, no tab switching
- **Bidirectional data flow**: Apps can call tools, host can push updates
- **Integration with host capabilities**: Apps can delegate actions to connected tools
- **Security guarantees**: Sandboxed iframes prevent malicious code execution

## Architecture

### Tool Configuration Enhancement

Tools can declare UI resources in their configuration:

```json
{
  "id": "example-tool",
  "name": { "en": "Example Tool", "de": "Beispiel-Tool" },
  "description": { "en": "A tool with UI", "de": "Ein Tool mit UI" },
  "script": "exampleTool.js",
  "_meta": {
    "ui": {
      "resourceUri": "ui://example-tool/app.html",
      "permissions": ["microphone", "camera"],
      "csp": {
        "default-src": ["'self'"],
        "script-src": ["'self'", "https://cdn.example.com"],
        "style-src": ["'self'", "'unsafe-inline'"]
      }
    }
  },
  "parameters": {
    "type": "object",
    "properties": {
      "query": { "type": "string" }
    }
  }
}
```

### UI Resource Serving

New route handler serves UI resources:

- Endpoint: `/api/mcp/resources/:resourceUri`
- Supports `ui://` scheme for app resources
- Returns HTML with embedded or external JS/CSS
- Applies CSP headers based on tool configuration

### Message Protocol

Apps communicate with the host via postMessage:

**Initialization (Host → App):**
```javascript
{
  "jsonrpc": "2.0",
  "method": "ui/initialize",
  "params": {
    "toolResult": { /* tool execution result */ },
    "capabilities": ["tools/call", "messages/send"]
  }
}
```

**Tool Call (App → Host):**
```javascript
{
  "jsonrpc": "2.0",
  "id": "1",
  "method": "tools/call",
  "params": {
    "name": "example-tool",
    "arguments": { "query": "test" }
  }
}
```

**Tool Result (Host → App):**
```javascript
{
  "jsonrpc": "2.0",
  "id": "1",
  "result": {
    "content": [{ "type": "text", "text": "Result" }]
  }
}
```

### Frontend Integration

**MCPAppRenderer Component:**
- Renders apps in sandboxed iframe
- Handles message routing via postMessage
- Manages app lifecycle (initialization, cleanup)
- Enforces security policies

**Chat Message Integration:**
- Detects tool results with `_meta.ui.resourceUri`
- Renders MCPAppRenderer component inline
- Maintains app state during conversation
- Supports multiple apps per chat session

## Security Model

### Iframe Sandbox

Apps run with strict sandbox attributes:

```html
<iframe
  sandbox="allow-scripts allow-same-origin"
  src="/api/mcp/resources/ui://example-tool/app.html"
></iframe>
```

Restrictions:
- No access to parent window
- No cookie/localStorage access to parent
- No form submission to external sites
- No top-level navigation
- No popups without user gesture

### Content Security Policy

CSP headers control resource loading:
- Prevent inline script execution (except allowlisted)
- Restrict external resource origins
- Block unsafe eval/inline styles
- Allow only configured CDN domains

### Message Validation

All postMessage communication is validated:
- Verify message origin matches app URL
- Validate JSON-RPC message structure
- Sanitize all user inputs
- Rate limit tool calls from apps

## Implementation Details

### Backend Components

**`server/routes/mcpAppRoutes.js`**
- Serves UI resources from file system or bundled HTML
- Applies CSP headers based on tool configuration
- Handles resource caching and compression

**`server/utils/mcpAppBridge.js`**
- Implements JSON-RPC message protocol
- Routes tool calls to execution engine
- Manages app sessions and state
- Validates messages and enforces security

**`server/validators/mcpAppSchema.js`**
- Zod schema for `_meta.ui` configuration
- Validates resource URIs and permissions
- Validates CSP configurations

### Frontend Components

**`client/src/features/mcpApps/components/MCPAppRenderer.jsx`**
- Renders sandboxed iframe
- Initializes postMessage bridge
- Handles app lifecycle events
- Displays loading/error states

**`client/src/features/mcpApps/hooks/useMCPAppBridge.js`**
- Custom hook for message handling
- Manages request/response correlation
- Implements timeout and retry logic
- Provides type-safe API for apps

**`client/src/features/mcpApps/utils/mcpAppSecurity.js`**
- Message origin validation
- Input sanitization utilities
- CSP header generation
- Security policy enforcement

### Tool Configuration Extension

Modified `server/toolLoader.js`:
- Parse `_meta.ui` from tool definitions
- Validate UI resource URIs
- Attach UI metadata to tool objects
- Support dynamic resource loading

## Usage Example

### Tool Definition

```json
{
  "id": "getTime",
  "name": { "en": "Get Server Time", "de": "Serverzeit abrufen" },
  "description": { "en": "Returns current time", "de": "Gibt aktuelle Zeit zurück" },
  "script": "getTime.js",
  "_meta": {
    "ui": {
      "resourceUri": "ui://get-time/app.html"
    }
  },
  "parameters": {
    "type": "object",
    "properties": {}
  }
}
```

### Tool Implementation (getTime.js)

```javascript
export default async function getTime(params) {
  return {
    content: [
      {
        type: "text",
        text: new Date().toISOString()
      }
    ],
    _meta: {
      ui: {
        resourceUri: "ui://get-time/app.html"
      }
    }
  };
}
```

### App HTML (app.html)

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Get Time</title>
  <style>
    body { font-family: sans-serif; padding: 20px; }
    code { background: #f4f4f4; padding: 2px 6px; border-radius: 3px; }
  </style>
</head>
<body>
  <p><strong>Server Time:</strong> <code id="time">Loading...</code></p>
  <button id="refresh">Refresh Time</button>
  
  <script type="module">
    // Simplified bridge (actual implementation in SDK)
    class MCPAppBridge {
      constructor() {
        this.pendingRequests = new Map();
        this.requestId = 0;
        window.addEventListener('message', this.handleMessage.bind(this));
      }

      async callTool(name, args) {
        const id = String(++this.requestId);
        return new Promise((resolve, reject) => {
          this.pendingRequests.set(id, { resolve, reject });
          window.parent.postMessage({
            jsonrpc: '2.0',
            id,
            method: 'tools/call',
            params: { name, arguments: args }
          }, '*');
        });
      }

      handleMessage(event) {
        const msg = event.data;
        if (msg.method === 'ui/initialize') {
          this.initialize(msg.params);
        } else if (msg.id && this.pendingRequests.has(msg.id)) {
          const { resolve } = this.pendingRequests.get(msg.id);
          this.pendingRequests.delete(msg.id);
          resolve(msg.result);
        }
      }

      initialize(params) {
        if (params.toolResult) {
          const time = params.toolResult.content?.[0]?.text;
          document.getElementById('time').textContent = time || 'N/A';
        }
      }
    }

    const bridge = new MCPAppBridge();

    document.getElementById('refresh').addEventListener('click', async () => {
      const result = await bridge.callTool('getTime', {});
      const time = result.content?.[0]?.text;
      document.getElementById('time').textContent = time || 'N/A';
    });
  </script>
</body>
</html>
```

## Developer Experience

### Creating an MCP App

1. **Define the tool** in `tools.json` with `_meta.ui` configuration
2. **Implement tool logic** in `server/tools/{toolId}.js`
3. **Create UI HTML** in `server/mcp-apps/{toolId}/app.html`
4. **Use bridge API** for communication between app and host
5. **Test locally** using the chat interface

### SDK Support (Future)

Consider providing an SDK for easier app development:

```javascript
import { MCPApp } from '@ihub-apps/mcp-sdk';

const app = new MCPApp({
  name: 'My App',
  version: '1.0.0'
});

// Initialize
app.connect();

// Handle initial result
app.onToolResult((result) => {
  console.log('Initial result:', result);
});

// Call tools
const result = await app.callTool('getTime', {});

// Send messages to chat
await app.sendMessage('Time retrieved successfully');
```

## Testing Strategy

### Unit Tests
- Message protocol validation
- Security header generation
- Resource URI parsing
- Tool metadata extraction

### Integration Tests
- End-to-end tool execution with UI
- Message bridge communication
- Multiple apps in single conversation
- App state persistence

### Security Tests
- Iframe escape attempts
- XSS injection prevention
- CSRF protection
- Message origin validation

### Browser Compatibility
- Test in Chrome, Firefox, Safari, Edge
- Verify iframe sandboxing works correctly
- Test postMessage compatibility
- Mobile browser testing

## Future Enhancements

### Phase 2 Features
- App state persistence across sessions
- Streaming tool results to apps
- File upload/download from apps
- Fullscreen app mode
- App-to-app communication

### Advanced Capabilities
- WebSocket support for real-time updates
- App marketplace for sharing apps
- App versioning and updates
- Analytics and usage tracking
- App permission management UI

### Developer Tools
- MCP App debugger
- Template gallery
- Visual app builder
- Local development server
- Hot reload for app development

## Migration Path

This is a new feature with no breaking changes:
1. Existing tools continue to work without UI metadata
2. Tools can opt-in to UI support via `_meta.ui` field
3. Chat interface gracefully handles both UI and non-UI tools
4. No changes required to existing tool implementations

## Code Locations

**Backend:**
- `/server/routes/mcpAppRoutes.js` - Resource serving
- `/server/utils/mcpAppBridge.js` - Message protocol
- `/server/validators/mcpAppSchema.js` - Validation
- `/server/toolLoader.js` - Tool metadata parsing
- `/server/mcp-apps/` - App HTML files

**Frontend:**
- `/client/src/features/mcpApps/` - MCP App feature module
- `/client/src/features/mcpApps/components/MCPAppRenderer.jsx` - App renderer
- `/client/src/features/mcpApps/hooks/useMCPAppBridge.js` - Message bridge hook
- `/client/src/features/mcpApps/utils/mcpAppSecurity.js` - Security utilities
- `/client/src/features/chat/components/ChatMessageList.jsx` - Integration point

**Configuration:**
- `/server/defaults/config/tools.json` - Example tool with UI
- `/examples/mcp-apps/` - Example app implementations

**Documentation:**
- `/docs/mcp-apps.md` - User guide
- `/docs/mcp-apps-development.md` - Developer guide
- `/concepts/2026-01-29 MCP Apps Support.md` - This document

## Success Metrics

- Developers can create and deploy MCP Apps without friction
- Apps render correctly in all supported browsers
- No security vulnerabilities in sandboxed execution
- App communication latency < 100ms for tool calls
- Zero XSS or injection vulnerabilities
- Documentation enables self-service app development
