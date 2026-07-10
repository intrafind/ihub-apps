import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import { apiClient, streamingApiClient } from '../client';
import { handleApiResponse } from '../utils/requestHandler';
import { buildChatExportFilename, buildChatExportTitle } from '../../utils/exportNaming';

// Isolated marked instance for static exports (PDF/HTML). It intentionally does
// NOT use the shared interactive markdown renderer, which injects toolbar
// buttons and mermaid placeholders that don't work in downloaded documents.
// GFM is enabled so tables, lists, and code blocks render correctly.
const exportMarked = new Marked({
  gfm: true,
  breaks: true,
  pedantic: false
});

// Convert message markdown to sanitized HTML for export documents.
const renderMarkdownForExport = content => {
  if (!content) return '';
  const html = exportMarked.parse(String(content));
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
};

// HTML-escape arbitrary text for safe interpolation into the export
// document's <title>/<h1>. The doc title now includes the first user
// message (via buildChatExportTitle), which is attacker-controlled and
// must not be rendered as raw HTML.
const escapeHtml = s =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

// Apps
export const fetchApps = async (options = {}) => {
  const { language = null } = options;

  return handleApiResponse(
    () => apiClient.get('/apps', { params: { language } }),
    null, // no client-side caching for apps list
    null
  );
};

export const fetchAppDetails = async (appId, options = {}) => {
  const { language = null } = options;

  return handleApiResponse(
    () => apiClient.get(`/apps/${appId}`, { params: { language } }),
    null, // no client-side caching for app details
    null
  );
};

export const sendAppChatMessage = async (appId, chatId, messages, options = {}) => {
  if (!appId || !chatId || !messages) {
    throw new Error('Missing required parameters');
  }

  return handleApiResponse(
    () =>
      streamingApiClient.post(`/apps/${appId}/chat/${chatId}`, {
        messages,
        ...options
      }),
    null, // No caching for chat messages
    null,
    false // Don't deduplicate chat requests
  );
};

export const stopAppChatStream = async (appId, chatId) => {
  return handleApiResponse(
    () => apiClient.post(`/apps/${appId}/chat/${chatId}/stop`),
    null, // No caching
    null,
    false // Don't deduplicate
  );
};

/**
 * Get conversation messages from iAssistant Conversation API
 * @param {string} appId - App ID
 * @param {string} conversationId - Conversation ID
 * @param {Object} [options] - Pagination options
 * @param {number} [options.size] - Page size
 * @param {string} [options.nextCursor] - Cursor for pagination
 */
export const getConversationMessages = async (appId, conversationId, options = {}) => {
  const params = {};
  if (options.size) params.size = options.size;
  if (options.nextCursor) params.next_cursor = options.nextCursor;

  return handleApiResponse(
    () =>
      apiClient.get(`/apps/${appId}/conversations/${conversationId}/messages`, {
        params
      }),
    null,
    null,
    false
  );
};

/**
 * Delete a conversation
 */
export const deleteConversation = async (appId, conversationId) => {
  return handleApiResponse(
    () => apiClient.delete(`/apps/${appId}/conversations/${conversationId}`),
    null,
    null,
    false
  );
};

export const checkAppChatStatus = async (appId, chatId) => {
  return handleApiResponse(
    () => apiClient.get(`/apps/${appId}/chat/${chatId}/status`),
    null, // Don't cache status checks
    null,
    false // Don't deduplicate status checks
  );
};

// Print an HTML document via a hidden, same-origin iframe.
//
// We deliberately avoid `window.open()` here: inside sandboxed/embedded hosts
// such as the Outlook taskpane and the browser-extension side panel, popups
// are blocked and `window.open()` returns `null`. The previous implementation
// then accessed `printWindow.document`, which crashed the whole export with
// "null is not an object (evaluating '...document')". An offscreen iframe
// prints the document in-place and works across those hosts.
const printHtmlDocument = htmlContent =>
  new Promise((resolve, reject) => {
    const iframe = document.createElement('iframe');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.position = 'fixed';
    iframe.style.left = '-9999px';
    iframe.style.width = '0';
    iframe.style.height = '0';
    iframe.style.border = '0';

    let settled = false;
    const removeFrame = () => setTimeout(() => iframe.remove(), 1000);

    const triggerPrint = () => {
      if (settled) return;
      try {
        const frameWindow = iframe.contentWindow;
        if (!frameWindow) throw new Error('Print frame is unavailable');
        settled = true;
        frameWindow.focus();
        frameWindow.print();
        removeFrame();
        resolve();
      } catch (err) {
        settled = true;
        removeFrame();
        reject(err);
      }
    };

    iframe.onload = triggerPrint;
    // Safety net in case `onload` never fires for the generated document.
    setTimeout(triggerPrint, 1500);

    document.body.appendChild(iframe);

    // Prefer `srcdoc`; fall back to document.write for engines that ignore it.
    try {
      iframe.srcdoc = htmlContent;
    } catch {
      const doc = iframe.contentWindow?.document;
      if (!doc) {
        settled = true;
        iframe.remove();
        reject(new Error('Unable to initialise print frame'));
        return;
      }
      doc.open();
      doc.write(htmlContent);
      doc.close();
    }
  });

// Client-side PDF generation using browser print functionality
export const exportChatToPDF = async (
  messages,
  settings,
  template = 'default',
  watermark = {},
  appName = 'iHub Apps',
  appId = null,
  chatId = null,
  isSingleMessage = false
) => {
  if (!messages) {
    throw new Error('Missing required parameters');
  }

  // Generate HTML content for PDF
  const htmlContent = generatePDFHTML(
    messages,
    settings,
    template,
    watermark,
    appName,
    isSingleMessage
  );

  const filename = buildChatExportFilename({
    format: 'pdf',
    appName,
    appId,
    messages,
    isSingleMessage
  });

  try {
    await printHtmlDocument(htmlContent);
    return { success: true, filename };
  } catch (err) {
    // Printing is unavailable in this host (e.g. a locked-down embedded
    // sandbox). Fall back to downloading the rendered HTML so the user can
    // still open and print it themselves, instead of hitting a hard crash.
    console.warn('PDF print unavailable, falling back to HTML download:', err);
    const htmlFilename = buildChatExportFilename({
      format: 'html',
      appName,
      appId,
      messages,
      isSingleMessage
    });
    downloadFile(htmlContent, htmlFilename, 'text/html');
    return { success: true, filename: htmlFilename, fallback: 'html' };
  }
};

// Generate HTML content for PDF
const generatePDFHTML = (
  messages,
  settings,
  template,
  watermark,
  appName,
  isSingleMessage = false
) => {
  const docTitle = buildChatExportTitle({ appName, messages, isSingleMessage });
  const styles = getTemplateStyles(template);
  const watermarkStyle = getWatermarkStyle(watermark);

  const formatTimestamp = timestamp => {
    try {
      return new Date(timestamp).toLocaleString();
    } catch {
      return new Date().toLocaleString();
    }
  };

  const formatContent = renderMarkdownForExport;

  const messagesHTML = messages
    .filter(msg => !msg.isGreeting) // Exclude greeting messages
    .map(message => {
      const roleClass = message.role === 'user' ? 'user-message' : 'assistant-message';
      const roleLabel = message.role === 'user' ? 'User' : 'Assistant';

      return `
        <div class="message ${roleClass}">
          <div class="message-header">
            <span class="role">${roleLabel}</span>
            <span class="timestamp">${formatTimestamp(message.timestamp || Date.now())}</span>
          </div>
          <div class="message-content">
            ${formatContent(message.content)}
          </div>
        </div>
      `;
    })
    .join('');

  const metadataHTML = settings
    ? `
    <div class="metadata">
      <h3>Chat Settings</h3>
      <div class="metadata-grid">
        ${settings.model ? `<div><strong>Model:</strong> ${settings.model}</div>` : ''}
        ${settings.temperature !== undefined ? `<div><strong>Temperature:</strong> ${settings.temperature}</div>` : ''}
        ${settings.style ? `<div><strong>Style:</strong> ${settings.style}</div>` : ''}
        ${settings.outputFormat ? `<div><strong>Output Format:</strong> ${settings.outputFormat}</div>` : ''}
        ${
          settings.variables && Object.keys(settings.variables).length > 0
            ? `
          <div><strong>Variables:</strong> ${Object.entries(settings.variables)
            .map(([k, v]) => `${k}: ${v}`)
            .join(', ')}</div>
        `
            : ''
        }
      </div>
    </div>
  `
    : '';

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(docTitle)}</title>
  <style>
    ${styles}
    ${watermarkStyle}
  </style>
</head>
<body>
  <div class="container">
    <header class="header">
      <h1>${escapeHtml(docTitle)}</h1>
      ${appName ? `<h2>${appName}</h2>` : ''}
      <p class="export-date">Exported on ${new Date().toLocaleString()}</p>
    </header>
    
    ${metadataHTML}
    
    <main class="messages">
      ${messagesHTML}
    </main>
    
    ${watermark.text ? `<div class="watermark">${watermark.text}</div>` : ''}
  </div>
</body>
</html>
  `;
};

// Template styles
const getTemplateStyles = template => {
  const baseStyles = `
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      line-height: 1.6;
      color: #333;
      background-color: #fff;
    }
    
    .container {
      max-width: 800px;
      margin: 0 auto;
      padding: 20px;
    }
    
    .header {
      border-bottom: 2px solid #e1e5e9;
      padding-bottom: 20px;
      margin-bottom: 30px;
    }
    
    .header h1 {
      color: #1a202c;
      font-size: 28px;
      font-weight: 700;
      margin-bottom: 5px;
    }
    
    .header h2 {
      color: #4a5568;
      font-size: 20px;
      font-weight: 500;
      margin-bottom: 10px;
    }
    
    .export-date {
      color: #718096;
      font-size: 14px;
    }
    
    .metadata {
      background-color: #f7fafc;
      border-radius: 8px;
      padding: 20px;
      margin-bottom: 30px;
    }
    
    .metadata h3 {
      color: #2d3748;
      font-size: 16px;
      margin-bottom: 15px;
    }
    
    .metadata-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }
    
    .metadata-grid div {
      font-size: 14px;
      color: #4a5568;
    }
    
    .message {
      margin-bottom: 25px;
      padding: 20px;
      border-radius: 12px;
      border: 1px solid #e2e8f0;
      page-break-inside: avoid;
    }
    
    .user-message {
      background-color: #ebf8ff;
      border-left: 4px solid #3182ce;
    }
    
    .assistant-message {
      background-color: #f0fff4;
      border-left: 4px solid #38a169;
    }
    
    .message-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 10px;
      font-size: 14px;
    }
    
    .role {
      font-weight: 600;
      color: #2d3748;
    }
    
    .timestamp {
      color: #718096;
    }
    
    .message-content {
      color: #2d3748;
    }
    
    .message-content p {
      margin-bottom: 10px;
    }
    
    .message-content p:last-child {
      margin-bottom: 0;
    }
    
    .message-content strong {
      font-weight: 600;
    }
    
    .message-content em {
      font-style: italic;
    }
    
    .message-content code {
      background-color: #edf2f7;
      padding: 2px 4px;
      border-radius: 3px;
      font-family: 'Monaco', 'Consolas', 'Courier New', monospace;
      font-size: 13px;
    }
    
    .message-content h1, .message-content h2, .message-content h3,
    .message-content h4, .message-content h5, .message-content h6 {
      margin-top: 15px;
      margin-bottom: 10px;
      font-weight: 600;
      color: #1a202c;
      line-height: 1.3;
    }
    
    .message-content h1 { font-size: 24px; }
    .message-content h2 { font-size: 20px; }
    .message-content h3 { font-size: 18px; }
    .message-content h4 { font-size: 16px; }
    .message-content h5 { font-size: 14px; }
    .message-content h6 { font-size: 13px; }
    
    .message-content h1:first-child, .message-content h2:first-child,
    .message-content h3:first-child, .message-content h4:first-child,
    .message-content h5:first-child, .message-content h6:first-child {
      margin-top: 0;
    }
    
    .message-content hr {
      border: none;
      border-top: 2px solid #e2e8f0;
      margin: 15px 0;
    }
    
    .message-content ul,
    .message-content ol {
      margin: 10px 0;
      padding-left: 24px;
    }

    .message-content ul {
      list-style-type: disc;
    }

    .message-content ol {
      list-style-type: decimal;
    }

    .message-content li {
      margin-bottom: 5px;
    }

    .message-content pre {
      background-color: #1a202c;
      color: #f7fafc;
      padding: 12px 16px;
      border-radius: 6px;
      overflow-x: auto;
      margin: 12px 0;
      font-size: 13px;
      line-height: 1.5;
    }

    .message-content pre code {
      background-color: transparent;
      padding: 0;
      color: inherit;
      font-size: inherit;
    }

    .message-content blockquote {
      border-left: 4px solid #cbd5e0;
      padding-left: 12px;
      margin: 12px 0;
      color: #4a5568;
    }

    .message-content table {
      border-collapse: collapse;
      width: 100%;
      margin: 12px 0;
      font-size: 14px;
    }

    .message-content th,
    .message-content td {
      border: 1px solid #e2e8f0;
      padding: 8px 12px;
      text-align: left;
      vertical-align: top;
    }

    .message-content th {
      background-color: #f7fafc;
      font-weight: 600;
    }

    .message-content tr:nth-child(even) td {
      background-color: #fafbfc;
    }

    .message-content a {
      color: #3182ce;
      text-decoration: underline;
    }

    .message-content img {
      max-width: 100%;
      height: auto;
    }

    @media print {
      .container {
        max-width: none;
        margin: 0;
        padding: 20px;
      }
      
      .message {
        page-break-inside: avoid;
      }
    }
  `;

  switch (template) {
    case 'professional':
      return (
        baseStyles +
        `
        .user-message {
          background-color: #f8f9fa;
          border-left-color: #495057;
        }
        
        .assistant-message {
          background-color: #f8f9fa;
          border-left-color: #6c757d;
        }
        
        .header h1 {
          color: #212529;
        }
      `
      );

    case 'minimal':
      return (
        baseStyles +
        `
        .message {
          border: none;
          border-radius: 0;
          border-bottom: 1px solid #e2e8f0;
          background-color: transparent;
          padding: 15px 0;
        }
        
        .user-message {
          border-left: none;
        }
        
        .assistant-message {
          border-left: none;
        }
        
        .metadata {
          background-color: transparent;
          border: 1px solid #e2e8f0;
        }
      `
      );

    default:
      return baseStyles;
  }
};

// Watermark positioning
const getWatermarkStyle = watermark => {
  const positions = {
    'bottom-right': 'bottom: 30px; right: 30px;',
    'bottom-left': 'bottom: 30px; left: 30px;',
    'bottom-center': 'bottom: 30px; left: 50%; transform: translateX(-50%);'
  };

  return `
    .watermark {
      position: fixed;
      ${positions[watermark.position] || positions['bottom-right']}
      font-size: 12px;
      color: rgba(0, 0, 0, ${watermark.opacity || 0.5});
      pointer-events: none;
      font-weight: 500;
    }
    
    @media print {
      .watermark {
        position: fixed !important;
        ${positions[watermark.position] || positions['bottom-right']}
      }
    }
  `;
};

// Client-side export utility functions
const downloadFile = (content, filename, mimeType) => {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
};

// Helper functions for generating export content
const generateJSON = (messages, settings) => {
  const buildMetadata = () => ({
    model: settings?.model,
    style: settings?.style,
    outputFormat: settings?.outputFormat,
    temperature: settings?.temperature,
    variables: settings?.variables
  });

  return JSON.stringify({ ...buildMetadata(), messages }, null, 2);
};

const generateJSONL = (messages, settings) => {
  const buildMetadata = () => ({
    model: settings?.model,
    style: settings?.style,
    outputFormat: settings?.outputFormat,
    temperature: settings?.temperature,
    variables: settings?.variables
  });

  const lines = [JSON.stringify({ meta: buildMetadata() })];
  messages.forEach(m => lines.push(JSON.stringify(m)));
  return lines.join('\n');
};

const isMarkdown = content => {
  if (!content) return false;
  // Simple check for markdown patterns
  return /[*_`#\[\]]\w/.test(content) || /\n\s*[-*+]\s/.test(content);
};

const htmlToMarkdown = content => {
  if (!content) return '';
  // Simple HTML to markdown conversion
  return content
    .replace(/<strong>(.*?)<\/strong>/g, '**$1**')
    .replace(/<em>(.*?)<\/em>/g, '*$1*')
    .replace(/<code>(.*?)<\/code>/g, '`$1`')
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<\/p><p>/g, '\n\n')
    .replace(/<\/?p>/g, '')
    .replace(/<\/?div>/g, '')
    .trim();
};

const markdownToHtml = content => {
  if (!content) return '';
  // Simple markdown to HTML conversion
  return content
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/`(.*?)`/g, '<code>$1</code>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br>');
};

const cleanHtmlForExport = html => {
  if (!html || typeof html !== 'string') {
    return '';
  }

  // Create a temporary DOM element to parse HTML
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = html;

  // Remove code block toolbars (contains buttons and language labels)
  const toolbars = tempDiv.querySelectorAll('.code-block-toolbar');
  toolbars.forEach(toolbar => toolbar.remove());

  // Remove mermaid diagram controls if any
  const diagramControls = tempDiv.querySelectorAll('.mermaid-diagram-controls');
  diagramControls.forEach(control => control.remove());

  // Remove any button elements that might be left
  const buttons = tempDiv.querySelectorAll('button');
  buttons.forEach(button => button.remove());

  // Return the cleaned HTML
  return tempDiv.innerHTML;
};

const generateMarkdown = messages => {
  return messages
    .filter(m => !m.isGreeting)
    .map(
      m => `**${m.role}**: ${isMarkdown(m.content) ? m.content : htmlToMarkdown(m.content || '')}`
    )
    .join('\n\n');
};

const generateHTML = (messages, settings, appName, isSingleMessage = false) => {
  // Use the same high-quality HTML generation as PDF export
  // This ensures consistent styling and proper markdown rendering
  const htmlContent = generatePDFHTML(
    messages,
    settings,
    'default',
    {},
    appName || 'iHub Apps',
    isSingleMessage
  );

  // Return the full HTML document
  return htmlContent;
};

// Client-side export functions
export const exportChatToJSON = async (
  messages,
  settings,
  appId = null,
  chatId = null,
  appName = null,
  isSingleMessage = false
) => {
  const filtered = messages.filter(m => !m.isGreeting);
  const content = generateJSON(filtered, settings);
  const filename = buildChatExportFilename({
    format: 'json',
    appName,
    appId,
    messages: filtered,
    isSingleMessage
  });

  downloadFile(content, filename, 'application/json');
  return { success: true, filename };
};

export const exportChatToJSONL = async (
  messages,
  settings,
  appId = null,
  chatId = null,
  appName = null,
  isSingleMessage = false
) => {
  const filtered = messages.filter(m => !m.isGreeting);
  const content = generateJSONL(filtered, settings);
  const filename = buildChatExportFilename({
    format: 'jsonl',
    appName,
    appId,
    messages: filtered,
    isSingleMessage
  });

  downloadFile(content, filename, 'application/json');
  return { success: true, filename };
};

export const exportChatToMarkdown = async (
  messages,
  settings,
  appId = null,
  chatId = null,
  appName = null,
  isSingleMessage = false
) => {
  const content = generateMarkdown(messages);
  const filename = buildChatExportFilename({
    format: 'md',
    appName,
    appId,
    messages,
    isSingleMessage
  });

  downloadFile(content, filename, 'text/markdown');
  return { success: true, filename };
};

export const exportChatToHTML = async (
  messages,
  settings,
  appId = null,
  chatId = null,
  appName = 'iHub Apps',
  isSingleMessage = false
) => {
  const content = generateHTML(messages, settings, appName, isSingleMessage);
  const filename = buildChatExportFilename({
    format: 'html',
    appName,
    appId,
    messages,
    isSingleMessage
  });

  downloadFile(content, filename, 'text/html');
  return { success: true, filename };
};

// Generic export function that handles all formats including PDF
export const exportChatToFormat = async (messages, settings, format, options = {}) => {
  const {
    appId = null,
    chatId = null,
    appName = 'iHub Apps',
    template = 'default',
    watermark = {},
    isSingleMessage = false
  } = options;

  switch (format) {
    case 'pdf':
      return exportChatToPDF(
        messages,
        settings,
        template,
        watermark,
        appName,
        appId,
        chatId,
        isSingleMessage
      );
    case 'json':
      return exportChatToJSON(messages, settings, appId, chatId, appName, isSingleMessage);
    case 'jsonl':
      return exportChatToJSONL(messages, settings, appId, chatId, appName, isSingleMessage);
    case 'markdown':
      return exportChatToMarkdown(messages, settings, appId, chatId, appName, isSingleMessage);
    case 'html':
      return exportChatToHTML(messages, settings, appId, chatId, appName, isSingleMessage);
    default:
      throw new Error(`Unsupported export format: ${format}`);
  }
};
