/**
 * Clipboard utilities with iframe support
 *
 * When running in an iframe, the Clipboard API may be blocked due to security restrictions.
 * This utility provides a fallback mechanism using postMessage to communicate with the parent window.
 *
 * Parent window integration:
 * ```javascript
 * window.addEventListener('message', (event) => {
 *   // Verify origin for security
 *   if (event.origin !== 'https://your-iframe-origin.com') return;
 *
 *   if (event.data.type === 'copyToClipboard') {
 *     const { content, format } = event.data;
 *
 *     if (format === 'html') {
 *       // Copy as HTML with both formats
 *       const item = new ClipboardItem({
 *         'text/html': new Blob([content], { type: 'text/html' }),
 *         'text/plain': new Blob([content], { type: 'text/plain' })
 *       });
 *       navigator.clipboard.write([item]);
 *     } else {
 *       // Copy as plain text
 *       navigator.clipboard.writeText(content);
 *     }
 *   }
 * });
 * ```
 */

/**
 * Detect if the application is running inside an iframe
 * @returns {boolean} True if running in iframe
 */
export function isInIframe() {
  try {
    return window.self !== window.top;
  } catch (e) {
    // If accessing window.top throws an error, we're definitely in an iframe with different origin
    return true;
  }
}

/**
 * Copy text to clipboard with iframe support
 * @param {string} content - Content to copy
 * @param {Object} options - Options
 * @param {string} options.format - Format type: 'text', 'html', 'markdown', 'json'
 * @param {Object} options.htmlData - For HTML format: { html: string, plain: string }
 * @returns {Promise<{success: boolean, error?: Error, method?: string}>}
 */
export async function copyToClipboard(content, options = {}) {
  const { format = 'text', htmlData } = options;

  // Try native clipboard API first
  try {
    if (format === 'html' && htmlData) {
      const hasClipboardWrite = navigator.clipboard && navigator.clipboard.write;

      if (hasClipboardWrite) {
        const item = new ClipboardItem({
          'text/html': new Blob([htmlData.html], { type: 'text/html' }),
          'text/plain': new Blob([htmlData.plain], { type: 'text/plain' })
        });
        await navigator.clipboard.write([item]);
      } else {
        await navigator.clipboard.writeText(htmlData.plain);
      }
    } else {
      await navigator.clipboard.writeText(content);
    }

    return { success: true, method: 'clipboard-api' };
  } catch (error) {
    console.warn('Clipboard API failed, trying iframe fallback:', error);

    // If in iframe, try postMessage fallback
    if (isInIframe()) {
      try {
        // Send message to parent window
        const messageData = {
          type: 'copyToClipboard',
          content: format === 'html' && htmlData ? htmlData.html : content,
          plainContent: format === 'html' && htmlData ? htmlData.plain : content,
          format: format
        };

        window.parent.postMessage(messageData, '*');

        console.log('✅ Copy request sent to parent window via postMessage');
        return {
          success: true,
          method: 'postMessage',
          note: 'Copy request sent to parent window. The parent must handle the copyToClipboard message.'
        };
      } catch (postMessageError) {
        console.error('postMessage fallback also failed:', postMessageError);
        return {
          success: false,
          error: postMessageError,
          originalError: error
        };
      }
    }

    // Not in iframe, return original error
    return { success: false, error };
  }
}

/**
 * Copy text content to clipboard
 * @param {string} text - Text to copy
 * @returns {Promise<{success: boolean, error?: Error, method?: string}>}
 */
export async function copyText(text) {
  return copyToClipboard(text, { format: 'text' });
}

/**
 * Copy HTML content to clipboard with both HTML and plain text formats
 * @param {string} html - HTML content
 * @param {string} plain - Plain text fallback
 * @returns {Promise<{success: boolean, error?: Error, method?: string}>}
 */
export async function copyHTML(html, plain) {
  return copyToClipboard(html, {
    format: 'html',
    htmlData: { html, plain }
  });
}

/**
 * Copy markdown content to clipboard
 * @param {string} markdown - Markdown content
 * @returns {Promise<{success: boolean, error?: Error, method?: string}>}
 */
export async function copyMarkdown(markdown) {
  return copyToClipboard(markdown, { format: 'markdown' });
}

/**
 * Copy JSON content to clipboard
 * @param {Object|string} data - JSON data (will be stringified if object)
 * @returns {Promise<{success: boolean, error?: Error, method?: string}>}
 */
export async function copyJSON(data) {
  const jsonString = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  return copyToClipboard(jsonString, { format: 'json' });
}
