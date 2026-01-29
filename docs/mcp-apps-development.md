# MCP Apps Development Guide

This guide walks you through creating MCP Apps for the iHub Apps platform. MCP Apps allow your tools to return interactive HTML interfaces that render directly in chat conversations.

## Prerequisites

- Basic knowledge of HTML, CSS, and JavaScript
- Understanding of JSON-RPC messaging
- Familiarity with the iHub Apps tool system

## Quick Start

### 1. Create the Tool Implementation

First, create a tool that returns data with UI metadata:

```javascript
// server/tools/myTool.js
export default async function myTool(params) {
  const result = await doSomeWork(params);
  
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(result)
      }
    ],
    _meta: {
      ui: {
        resourceUri: 'ui://myTool/app.html'
      }
    }
  };
}
```

### 2. Create the UI HTML

Create the app interface at `server/mcp-apps/myTool/app.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>My Tool App</title>
  <style>
    body {
      font-family: sans-serif;
      padding: 20px;
    }
  </style>
</head>
<body>
  <div id="app">
    <p>Loading...</p>
  </div>

  <script type="module">
    // MCP App Bridge (simplified)
    class MCPAppBridge {
      constructor() {
        window.addEventListener('message', this.handleMessage.bind(this));
        this.ready();
      }

      ready() {
        window.parent.postMessage({ type: 'mcp-app-ready' }, '*');
      }

      async callTool(name, args) {
        const id = Date.now();
        return new Promise((resolve) => {
          this.pendingRequests = this.pendingRequests || new Map();
          this.pendingRequests.set(id, resolve);
          
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
          this.onInitialize(msg.params.toolResult);
        } else if (msg.id && this.pendingRequests?.has(msg.id)) {
          const resolve = this.pendingRequests.get(msg.id);
          this.pendingRequests.delete(msg.id);
          resolve(msg.result);
        }
      }

      onInitialize(toolResult) {
        // Override this
      }
    }

    const bridge = new MCPAppBridge();

    bridge.onInitialize = (toolResult) => {
      const data = JSON.parse(toolResult.content[0].text);
      document.getElementById('app').innerHTML = `
        <h1>Result: ${data}</h1>
      `;
    };
  </script>
</body>
</html>
```

### 3. Configure the Tool

Add the tool configuration to `server/defaults/config/tools.json`:

```json
{
  "id": "myTool",
  "name": {
    "en": "My Tool",
    "de": "Mein Tool"
  },
  "description": {
    "en": "An example MCP App tool",
    "de": "Ein Beispiel-MCP-App-Tool"
  },
  "script": "myTool.js",
  "parameters": {
    "type": "object",
    "properties": {
      "input": {
        "type": "string",
        "description": { "en": "Input data", "de": "Eingabedaten" }
      }
    }
  },
  "_meta": {
    "ui": {
      "resourceUri": "ui://myTool/app.html",
      "displayHints": {
        "width": "normal",
        "height": "normal"
      }
    }
  }
}
```

### 4. Test Your App

1. Restart the server
2. Call your tool from the chat interface
3. The app should render inline in the conversation

## MCP App Bridge API

The bridge handles communication between your app and the host. Here's a complete example:

```javascript
class MCPAppBridge {
  constructor() {
    this.pendingRequests = new Map();
    this.requestId = 0;
    
    window.addEventListener('message', this.handleMessage.bind(this));
    this.sendReady();
  }

  sendReady() {
    window.parent.postMessage({ type: 'mcp-app-ready' }, '*');
  }

  async callTool(name, args = {}) {
    const id = String(++this.requestId);
    
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error('Request timeout'));
      }, 30000);

      this.pendingRequests.set(id, { resolve, reject, timeout });

      window.parent.postMessage({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name, arguments: args }
      }, '*');
    });
  }

  log(level, message, data = null) {
    window.parent.postMessage({
      jsonrpc: '2.0',
      method: 'ui/log',
      params: { level, message, data }
    }, '*');
  }

  handleMessage(event) {
    const msg = event.data;

    if (msg.method === 'ui/initialize') {
      if (msg.params?.toolResult) {
        this.onInitialize(msg.params.toolResult);
      }
    } else if (msg.jsonrpc === '2.0' && msg.id) {
      const pending = this.pendingRequests.get(String(msg.id));
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(String(msg.id));

        if (msg.error) {
          pending.reject(new Error(msg.error.message));
        } else {
          pending.resolve(msg.result);
        }
      }
    }
  }

  onInitialize(toolResult) {
    // Override this method
  }
}
```

## Advanced Features

### Calling Multiple Tools

```javascript
// Call multiple tools in sequence
const result1 = await bridge.callTool('searchData', { query: 'test' });
const result2 = await bridge.callTool('processData', { data: result1 });

// Call tools in parallel
const [result1, result2] = await Promise.all([
  bridge.callTool('getTool1Data', {}),
  bridge.callTool('getTool2Data', {})
]);
```

### Error Handling

```javascript
try {
  const result = await bridge.callTool('riskyOperation', {});
  displaySuccess(result);
} catch (error) {
  displayError(error.message);
  bridge.log('error', 'Operation failed', error.message);
}
```

### Logging

```javascript
// Log messages appear in the browser console
bridge.log('info', 'User clicked button');
bridge.log('warn', 'Data may be outdated');
bridge.log('error', 'Failed to load resource', errorDetails);
```

### Using External Libraries

You can use external libraries via CDN:

```html
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
<script type="module">
  const bridge = new MCPAppBridge();
  
  bridge.onInitialize = (toolResult) => {
    const data = JSON.parse(toolResult.content[0].text);
    
    // Use Chart.js to visualize data
    new Chart(document.getElementById('chart'), {
      type: 'bar',
      data: data
    });
  };
</script>
```

**Note**: Make sure to configure CSP to allow the CDN:

```json
"csp": {
  "script-src": ["'self'", "https://cdn.jsdelivr.net"]
}
```

## UI Best Practices

### Styling

1. **Use inline styles or `<style>` tags**: Avoid external CSS files for simplicity
2. **Responsive design**: Support different screen sizes
3. **Dark mode**: Consider dark mode compatibility
4. **Accessibility**: Use semantic HTML and ARIA labels

```css
/* Example: Dark mode support */
@media (prefers-color-scheme: dark) {
  body {
    background: #1a1a1a;
    color: #e0e0e0;
  }
}
```

### Loading States

Always show loading indicators while waiting for data:

```javascript
bridge.onInitialize = async (toolResult) => {
  const container = document.getElementById('app');
  container.innerHTML = '<div class="loading">Loading...</div>';
  
  try {
    const data = await processData(toolResult);
    container.innerHTML = renderData(data);
  } catch (error) {
    container.innerHTML = `<div class="error">${error.message}</div>`;
  }
};
```

### User Feedback

Provide clear feedback for user actions:

```javascript
button.addEventListener('click', async () => {
  button.disabled = true;
  button.textContent = 'Refreshing...';
  
  try {
    const result = await bridge.callTool('refresh', {});
    updateDisplay(result);
    showSuccess('Refreshed successfully');
  } catch (error) {
    showError(error.message);
  } finally {
    button.disabled = false;
    button.textContent = 'Refresh';
  }
});
```

## Security Considerations

### Sandbox Restrictions

Your app runs in a sandboxed iframe with these restrictions:

- No access to parent window
- No access to cookies or localStorage (except same-origin)
- Limited form submission
- No top-level navigation

### Content Security Policy

Configure CSP to control what resources your app can load:

```json
"csp": {
  "default-src": ["'self'"],
  "script-src": ["'self'", "https://trusted-cdn.com"],
  "style-src": ["'self'", "'unsafe-inline'"],
  "img-src": ["'self'", "data:", "https:"],
  "connect-src": ["'self'"]
}
```

### Input Validation

Always validate user input:

```javascript
function validateInput(value) {
  // Remove potentially dangerous characters
  return value.replace(/<script>/gi, '')
              .replace(/javascript:/gi, '')
              .trim();
}
```

### Rate Limiting

The platform rate-limits tool calls to prevent abuse (10 calls per second by default).

## Debugging

### Browser Console

Use `bridge.log()` to send messages to the browser console:

```javascript
bridge.log('debug', 'Current state', { data: currentState });
```

### Development Mode

In development, add debug info to your UI:

```javascript
if (process.env.NODE_ENV === 'development') {
  console.log('Initializing with:', toolResult);
}
```

### Testing

Test your app by:

1. Calling the tool from the chat interface
2. Checking browser console for errors
3. Verifying tool calls work correctly
4. Testing in different browsers (Chrome, Firefox, Safari)

## Examples

See complete working examples in `server/mcp-apps/`:

### Get Time App

A simple app that displays server time with refresh functionality.

Location: `server/mcp-apps/getTime/app.html`

Key features:
- Initial tool result display
- Interactive refresh button
- Toggle between ISO and local time
- Error handling
- Loading states

## Common Patterns

### Form Input

```html
<form id="myForm">
  <input type="text" id="query" placeholder="Enter search query">
  <button type="submit">Search</button>
</form>

<div id="results"></div>

<script type="module">
  const bridge = new MCPAppBridge();
  
  document.getElementById('myForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const query = document.getElementById('query').value;
    
    const results = await bridge.callTool('search', { query });
    document.getElementById('results').innerHTML = renderResults(results);
  });
</script>
```

### Data Visualization

```javascript
bridge.onInitialize = (toolResult) => {
  const data = JSON.parse(toolResult.content[0].text);
  
  // Create a simple bar chart
  const chart = document.getElementById('chart');
  data.items.forEach(item => {
    const bar = document.createElement('div');
    bar.style.width = `${item.value}%`;
    bar.textContent = item.label;
    chart.appendChild(bar);
  });
};
```

### Real-time Updates

```javascript
// Poll for updates
async function pollUpdates() {
  try {
    const status = await bridge.callTool('getStatus', {});
    updateDisplay(status);
  } catch (error) {
    console.error('Poll failed:', error);
  }
  
  // Poll every 5 seconds
  setTimeout(pollUpdates, 5000);
}

bridge.onInitialize = () => {
  pollUpdates();
};
```

## Troubleshooting

### App doesn't initialize

- Check that `sendReady()` is called
- Verify `onInitialize` is set before initialization
- Check browser console for errors

### Tool calls fail

- Verify tool name is correct
- Check tool parameters match schema
- Review server logs for execution errors
- Ensure user has permissions

### CSP violations

- Check browser console for CSP errors
- Add required domains to CSP configuration
- Use `'unsafe-inline'` for inline styles (if needed)

### Performance issues

- Minimize DOM updates
- Use `requestAnimationFrame` for animations
- Debounce user input handlers
- Consider pagination for large datasets

## Next Steps

1. Review the [Get Time example](../server/mcp-apps/getTime/app.html)
2. Create your first MCP App
3. Test thoroughly in the chat interface
4. Share with users and gather feedback

## Resources

- [MCP Apps User Guide](mcp-apps.md)
- [MCP Specification](https://modelcontextprotocol.io/docs/extensions/apps)
- [Concept Document](../concepts/2026-01-29%20MCP%20Apps%20Support.md)
