# iFrame Clipboard Integration

When iHub Apps runs inside an iframe, the browser's Clipboard API may be blocked due to security restrictions. To enable copy to clipboard functionality in iframe contexts, iHub Apps uses a fallback mechanism that communicates with the parent window via `postMessage`.

## How It Works

1. **Automatic Detection**: iHub Apps automatically detects when it's running in an iframe
2. **Clipboard API First**: It first attempts to use the native browser Clipboard API
3. **postMessage Fallback**: If the Clipboard API fails (common in iframes), it sends a message to the parent window
4. **Parent Handles Copy**: The parent window receives the message and copies the content to clipboard

## Parent Window Integration

To enable clipboard functionality when embedding iHub Apps in an iframe, add the following message listener to your parent window:

```javascript
window.addEventListener('message', (event) => {
  // IMPORTANT: Verify the origin for security
  // Replace with your actual iHub Apps origin
  const allowedOrigin = 'https://your-ihub-domain.com';

  if (event.origin !== allowedOrigin) {
    console.warn('Received message from untrusted origin:', event.origin);
    return;
  }

  // Handle copyToClipboard messages
  if (event.data.type === 'copyToClipboard') {
    const { content, plainContent, format } = event.data;

    try {
      if (format === 'html' && navigator.clipboard && navigator.clipboard.write) {
        // Copy as HTML with both formats
        const item = new ClipboardItem({
          'text/html': new Blob([content], { type: 'text/html' }),
          'text/plain': new Blob([plainContent], { type: 'text/plain' })
        });
        navigator.clipboard.write([item])
          .then(() => console.log('✅ Content copied to clipboard (HTML)'))
          .catch(err => console.error('❌ Failed to copy HTML:', err));
      } else {
        // Copy as plain text
        navigator.clipboard.writeText(plainContent || content)
          .then(() => console.log('✅ Content copied to clipboard (text)'))
          .catch(err => console.error('❌ Failed to copy text:', err));
      }
    } catch (error) {
      console.error('❌ Clipboard operation failed:', error);
    }
  }
});
```

## Message Format

The `postMessage` sent from iHub Apps contains the following data:

```typescript
{
  type: 'copyToClipboard',       // Message type identifier
  content: string,                // Content to copy (HTML or text)
  plainContent: string,           // Plain text fallback
  format: 'text' | 'html' | 'markdown' | 'json'  // Content format
}
```

## Security Considerations

**CRITICAL**: Always verify the origin of incoming messages to prevent security vulnerabilities:

```javascript
// ✅ CORRECT - Verify origin
if (event.origin !== 'https://your-trusted-domain.com') {
  return;
}

// ❌ WRONG - Accept all origins (security risk!)
window.addEventListener('message', (event) => {
  // No origin check - vulnerable to XSS attacks
});
```

## Example: Complete Integration

```html
<!DOCTYPE html>
<html>
<head>
  <title>iHub Apps Embedded</title>
</head>
<body>
  <iframe
    id="ihub-frame"
    src="https://your-ihub-domain.com/apps/chat"
    width="100%"
    height="600"
    allow="clipboard-write"
  ></iframe>

  <script>
    // iHub Apps clipboard integration
    const IHUB_ORIGIN = 'https://your-ihub-domain.com';

    window.addEventListener('message', (event) => {
      // Security: Verify origin
      if (event.origin !== IHUB_ORIGIN) {
        return;
      }

      // Handle clipboard messages
      if (event.data.type === 'copyToClipboard') {
        handleClipboardCopy(event.data);
      }
    });

    async function handleClipboardCopy(data) {
      const { content, plainContent, format } = data;

      try {
        if (format === 'html' && navigator.clipboard?.write) {
          const item = new ClipboardItem({
            'text/html': new Blob([content], { type: 'text/html' }),
            'text/plain': new Blob([plainContent], { type: 'text/plain' })
          });
          await navigator.clipboard.write([item]);
        } else {
          await navigator.clipboard.writeText(plainContent || content);
        }

        // Optional: Show user feedback
        console.log('✅ Copied to clipboard');
        showNotification('Content copied to clipboard!');
      } catch (error) {
        console.error('❌ Clipboard copy failed:', error);
        showNotification('Failed to copy to clipboard', 'error');
      }
    }

    function showNotification(message, type = 'success') {
      // Implement your notification logic
      console.log(`[${type}] ${message}`);
    }
  </script>
</body>
</html>
```

## Supported Content Formats

iHub Apps supports copying content in multiple formats:

- **`text`**: Plain text content
- **`html`**: Rich HTML content with both HTML and plain text fallbacks
- **`markdown`**: Markdown formatted text
- **`json`**: JSON formatted data

## Browser Compatibility

This solution works in all modern browsers that support:

- `postMessage` API (all modern browsers)
- `Clipboard API` (Chrome 63+, Firefox 53+, Safari 13.1+, Edge 79+)

For browsers without Clipboard API support, the fallback will also fail, but this is increasingly rare.

## Testing

To test the integration:

1. Embed iHub Apps in an iframe on your site
2. Add the message listener code to your parent window
3. Try copying content from a chat message or code block
4. Check the browser console for success/error messages
5. Verify content is copied to clipboard

## Troubleshooting

### Copy doesn't work in iframe

**Cause**: Parent window is not handling the `copyToClipboard` message

**Solution**: Add the message listener code to your parent window (see examples above)

### Security/Origin errors

**Cause**: Origin mismatch between iframe and parent window

**Solution**:
- Ensure `event.origin` check matches your iHub Apps domain exactly
- Check browser console for CORS or origin-related errors
- Verify iframe `src` URL matches the origin check

### HTML format not working

**Cause**: Browser doesn't support `ClipboardItem` API

**Solution**: The code automatically falls back to plain text. No action needed.

## Related Documentation

- [CORS Configuration](./cors.md)
- [Embedding iHub Apps](./embedding.md)
- [Security Best Practices](./security.md)
