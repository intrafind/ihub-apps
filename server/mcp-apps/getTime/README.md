# Get Time MCP App

This is a simple example MCP App that demonstrates the core concepts of creating interactive UIs for iHub Apps tools.

## What It Does

The Get Time app:
- Displays the current server time in ISO 8601 format
- Allows users to refresh the time with a button click
- Lets users toggle between ISO format and local time format
- Demonstrates the full MCP App lifecycle

## File Structure

```
server/mcp-apps/getTime/
├── app.html          # The interactive UI (this file renders in chat)
└── README.md         # This file

server/tools/
└── getTime.js        # Tool implementation that returns UI metadata

server/defaults/config/tools.json
                      # Tool configuration with UI metadata
```

## How It Works

### 1. Tool Execution

When the `getTime` tool is called:

```javascript
// server/tools/getTime.js
export default async function getTime(params) {
  return {
    content: [{ type: 'text', text: new Date().toISOString() }],
    _meta: {
      ui: { resourceUri: 'ui://getTime/app.html' }
    }
  };
}
```

The `_meta.ui.resourceUri` tells the chat interface to render the interactive UI.

### 2. UI Rendering

The chat interface:
1. Detects the UI metadata in the tool result
2. Loads `app.html` in a sandboxed iframe
3. Sends an initialization message with the tool result

### 3. App Initialization

The app receives the initial tool result:

```javascript
bridge.onInitialize = (toolResult) => {
  const timeStr = toolResult.content?.[0]?.text;
  displayTime(timeStr);
};
```

### 4. Interactive Features

Users can:
- Click "Refresh Time" to call the tool again
- Toggle between ISO and local time formats
- See loading states during operations

## Key Concepts Demonstrated

### Message Bridge

The `MCPAppBridge` class handles communication:

```javascript
class MCPAppBridge {
  // Sends tool call requests to the host
  async callTool(name, args) { ... }
  
  // Receives initialization message
  onInitialize(toolResult) { ... }
  
  // Handles responses from the host
  handleMessage(event) { ... }
}
```

### Bidirectional Communication

- **Host → App**: Initialization with tool result
- **App → Host**: Tool call requests
- **Host → App**: Tool call responses

### Security

The app runs in a sandboxed iframe with:
- No access to parent window
- No access to cookies or local storage
- Isolated execution context

## Customization

### Styling

Modify the `<style>` section in `app.html`:

```css
body {
  font-family: -apple-system, BlinkMacSystemFont, ...;
  padding: 20px;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
}
```

### Display Hints

Control app sizing in `tools.json`:

```json
"displayHints": {
  "width": "normal",    // compact, normal, wide, full
  "height": "compact",  // compact, normal, tall, auto
  "resizable": false
}
```

### Permissions

Request additional capabilities:

```json
"permissions": ["microphone", "camera", "geolocation"]
```

## Testing

1. Start the server: `npm run dev`
2. Navigate to the chat interface
3. Send a message that triggers the `getTime` tool
4. The interactive time display should appear
5. Click "Refresh Time" to test tool calls from the app

## Learning Points

This example teaches:

1. **Tool-to-UI Integration**: How tools return UI metadata
2. **Message Protocol**: JSON-RPC communication patterns
3. **Lifecycle Management**: Initialization, updates, cleanup
4. **Error Handling**: Graceful degradation on failures
5. **User Feedback**: Loading states and visual feedback

## Extending This Example

Ideas for enhancements:

1. **Time Zones**: Add dropdown to show time in different zones
2. **History**: Display a log of refreshed times
3. **Alarm**: Allow setting reminders at specific times
4. **Format Options**: More date/time format choices
5. **Animation**: Animate the time update

## Related Documentation

- [MCP Apps User Guide](../../../docs/mcp-apps.md)
- [MCP Apps Development Guide](../../../docs/mcp-apps-development.md)
- [Concept Document](../../../concepts/2026-01-29%20MCP%20Apps%20Support.md)

## Technical Details

### Dependencies

- No external dependencies
- Pure JavaScript (ES modules)
- Native browser APIs only

### Browser Support

- Modern browsers with ES6+ support
- postMessage API
- EventSource (for future enhancements)

### Performance

- Minimal DOM updates
- Efficient message handling
- Lightweight (<10KB total)

## Troubleshooting

**App doesn't load**:
- Check browser console for errors
- Verify resource URI matches file path
- Ensure server is running

**Refresh button doesn't work**:
- Check network tab for tool call requests
- Review server logs for execution errors
- Verify user has tool permissions

**Time doesn't display**:
- Check toolResult format in browser console
- Verify content structure matches expected format
- Review initialization message payload
