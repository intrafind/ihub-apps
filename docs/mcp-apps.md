# MCP Apps

MCP Apps (Model Context Protocol Apps) allow tools to return interactive HTML interfaces that render directly in your chat conversations. Instead of just receiving text responses, tools can provide rich, interactive experiences like data visualizations, forms, dashboards, and real-time monitoring.

## What are MCP Apps?

MCP Apps extend the traditional text-based chat experience by allowing tools to return interactive UIs that:

- **Stay in context**: Apps render inline within the conversation, so you never lose your place
- **Communicate bidirectionally**: Apps can call other tools and receive real-time updates
- **Provide rich interactions**: Use buttons, forms, visualizations, and other UI components
- **Run securely**: Apps execute in sandboxed iframes with strict security policies

## Using MCP Apps

### Discovering MCP Apps

MCP Apps are provided by tools that have been configured with UI capabilities. When you call a tool that supports MCP Apps, the chat interface will automatically detect and render the interactive UI instead of just showing text.

Look for tools that have interactive features in their descriptions. For example:
- **Get Server Time**: Shows current time with interactive refresh buttons
- **Data Visualizations**: Display charts and graphs you can interact with
- **Forms and Configurators**: Fill out forms with validation and previews

### Example: Get Server Time

The "Get Server Time" tool demonstrates a simple MCP App:

1. Call the tool (either directly or through natural conversation)
2. An interactive time display appears in the chat
3. Click "Refresh Time" to get the current time without calling the tool again
4. Toggle between ISO format and local time format

### Interacting with MCP Apps

Once an app renders in your chat:

- **Use interactive controls**: Buttons, forms, and other UI elements work as expected
- **Apps can call tools**: When you interact with an app, it may call other tools behind the scenes
- **State persists**: App state remains intact as long as the chat session is active
- **Multiple apps**: You can have multiple apps running in the same conversation

## Security

MCP Apps run in sandboxed environments with strict security policies:

- **Isolated execution**: Apps cannot access your data, cookies, or local storage
- **Limited permissions**: Apps can only access the specific capabilities they request
- **Content Security Policy**: Strict CSP prevents malicious code execution
- **No parent access**: Apps cannot manipulate the main application or access other tabs

## For Administrators

### Configuring Tools with MCP Apps

To enable a tool to return MCP Apps, add UI metadata to the tool configuration:

```json
{
  "id": "example-tool",
  "name": {
    "en": "Example Tool",
    "de": "Beispiel-Tool"
  },
  "description": {
    "en": "A tool that returns an interactive UI",
    "de": "Ein Tool mit interaktiver UI"
  },
  "script": "exampleTool.js",
  "parameters": {
    "type": "object",
    "properties": {
      "query": {
        "type": "string",
        "description": { "en": "Search query", "de": "Suchanfrage" }
      }
    }
  },
  "_meta": {
    "ui": {
      "resourceUri": "ui://example-tool/app.html",
      "displayHints": {
        "width": "normal",
        "height": "normal"
      },
      "permissions": []
    }
  }
}
```

### Creating MCP Apps

See the [MCP Apps Development Guide](mcp-apps-development.md) for detailed instructions on creating your own MCP Apps.

### Security Configuration

MCP Apps support Content Security Policy (CSP) configuration:

```json
"_meta": {
  "ui": {
    "resourceUri": "ui://example-tool/app.html",
    "csp": {
      "default-src": ["'self'"],
      "script-src": ["'self'", "https://cdn.example.com"],
      "style-src": ["'self'", "'unsafe-inline'"]
    }
  }
}
```

### Display Hints

Control how apps are sized in the chat:

- **Width**: `compact`, `normal`, `wide`, `full`
- **Height**: `compact`, `normal`, `tall`, `auto`
- **Resizable**: `true` or `false`

Example:

```json
"displayHints": {
  "width": "wide",
  "height": "tall",
  "resizable": true
}
```

## Troubleshooting

### App doesn't load

- Check that the resource URI is correct
- Verify the HTML file exists at `server/mcp-apps/{tool-id}/app.html`
- Check browser console for errors
- Ensure CSP settings allow required resources

### App can't call tools

- Verify the app sends proper JSON-RPC messages
- Check that tool names are correct
- Review server logs for tool execution errors
- Ensure user has permissions for the requested tools

### Performance issues

- Apps with heavy JavaScript may impact browser performance
- Use Web Workers for intensive computations
- Optimize DOM updates and re-renders
- Consider pagination for large datasets

## Best Practices

### For Users

1. **Trust the source**: Only use apps from trusted tool providers
2. **Monitor permissions**: Pay attention to what permissions apps request
3. **Report issues**: If an app behaves unexpectedly, report it to administrators
4. **Stay updated**: Apps may be updated to fix bugs or add features

### For Administrators

1. **Review apps**: Audit app code before deploying to users
2. **Minimize permissions**: Only grant necessary permissions
3. **Use CSP**: Configure strict Content Security Policies
4. **Monitor usage**: Track app usage and performance
5. **Test thoroughly**: Test apps in different browsers and scenarios

## Examples

See the `server/mcp-apps/` directory for example implementations:

- `getTime/` - Simple time display with refresh functionality
- More examples coming soon

## Learn More

- [MCP Apps Development Guide](mcp-apps-development.md) - Create your own MCP Apps
- [MCP Specification](https://modelcontextprotocol.io/docs/extensions/apps) - Official MCP Apps specification
- [Concept Document](../concepts/2026-01-29%20MCP%20Apps%20Support.md) - Architecture and design decisions
