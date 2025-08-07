import { apiClient, streamingApiClient } from '../client';
import { handleApiResponse } from '../utils/requestHandler';

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

export const checkAppChatStatus = async (appId, chatId) => {
  return handleApiResponse(
    () => apiClient.get(`/apps/${appId}/chat/${chatId}/status`),
    null, // Don't cache status checks
    null,
    false // Don't deduplicate status checks
  );
};

// Client-side PDF generation using browser print functionality
export const exportChatToPDF = async (
  messages,
  settings,
  template = 'default',
  watermark = {},
  appName = 'iHub Apps'
) => {
  if (!messages) {
    throw new Error('Missing required parameters');
  }

  // Generate HTML content for PDF
  const htmlContent = generatePDFHTML(messages, settings, template, watermark, appName);

  // Create a new window for printing
  const printWindow = window.open('', '_blank');
  printWindow.document.write(htmlContent);
  printWindow.document.close();

  // Wait for content to load
  await new Promise(resolve => {
    printWindow.onload = resolve;
    setTimeout(resolve, 1000); // Fallback timeout
  });

  // Focus and print
  printWindow.focus();
  printWindow.print();

  // Close after a delay
  setTimeout(() => {
    printWindow.close();
  }, 1000);

  const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
  const filename = `chat-${appName.replace(/[^a-z0-9]/gi, '-').toLowerCase()}-${timestamp}.pdf`;

  return { success: true, filename };
};

// Generate HTML content for PDF
const generatePDFHTML = (messages, settings, template, watermark, appName) => {
  const styles = getTemplateStyles(template);
  const watermarkStyle = getWatermarkStyle(watermark);

  const formatTimestamp = timestamp => {
    try {
      return new Date(timestamp).toLocaleString();
    } catch {
      return new Date().toLocaleString();
    }
  };

  const formatContent = content => {
    if (!content) return '';
    // Basic markdown-like formatting for PDF
    return content
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/`(.*?)`/g, '<code>$1</code>')
      .replace(/\n\n/g, '</p><p>')
      .replace(/\n/g, '<br>');
  };

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
            <p>${formatContent(message.content)}</p>
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
  <title>Chat Export - ${appName || 'iHub Apps'}</title>
  <style>
    ${styles}
    ${watermarkStyle}
  </style>
</head>
<body>
  <div class="container">
    <header class="header">
      <h1>Chat Conversation Export</h1>
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

const generateMarkdown = messages => {
  return messages
    .filter(m => !m.isGreeting)
    .map(
      m => `**${m.role}**: ${isMarkdown(m.content) ? m.content : htmlToMarkdown(m.content || '')}`
    )
    .join('\n\n');
};

const generateHTML = messages => {
  return messages
    .filter(m => !m.isGreeting)
    .map(m => `<p><strong>${m.role}:</strong> ${markdownToHtml(m.content)}</p>`)
    .join('');
};

// Client-side export functions
export const exportChatToJSON = async (messages, settings, appId = null) => {
  const content = generateJSON(
    messages.filter(m => !m.isGreeting),
    settings
  );
  const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
  const filename = `chat-${appId || 'export'}-${timestamp}.json`;

  downloadFile(content, filename, 'application/json');
  return { success: true, filename };
};

export const exportChatToJSONL = async (messages, settings, appId = null) => {
  const content = generateJSONL(
    messages.filter(m => !m.isGreeting),
    settings
  );
  const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
  const filename = `chat-${appId || 'export'}-${timestamp}.jsonl`;

  downloadFile(content, filename, 'application/json');
  return { success: true, filename };
};

export const exportChatToMarkdown = async (messages, appId = null) => {
  const content = generateMarkdown(messages);
  const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
  const filename = `chat-${appId || 'export'}-${timestamp}.md`;

  downloadFile(content, filename, 'text/markdown');
  return { success: true, filename };
};

export const exportChatToHTML = async (messages, appId = null) => {
  const content = generateHTML(messages);
  const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
  const filename = `chat-${appId || 'export'}-${timestamp}.html`;

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
    watermark = {}
  } = options;

  switch (format) {
    case 'pdf':
      return exportChatToPDF(messages, settings, template, watermark, appName, appId, chatId);
    case 'json':
      return exportChatToJSON(messages, settings, appId, chatId);
    case 'jsonl':
      return exportChatToJSONL(messages, settings, appId, chatId);
    case 'markdown':
      return exportChatToMarkdown(messages, settings, appId, chatId);
    case 'html':
      return exportChatToHTML(messages, settings, appId, chatId);
    default:
      throw new Error(`Unsupported export format: ${format}`);
  }
};
