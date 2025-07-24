import puppeteer from 'puppeteer';
import configCache from '../../configCache.js';
import { authRequired, chatAuthRequired } from '../../middleware/authRequired.js';
import validate from '../../validators/validate.js';

// Validation schema for PDF export
const pdfExportSchema = {
  type: 'object',
  properties: {
    messages: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          role: { type: 'string', enum: ['user', 'assistant', 'system'] },
          content: { type: 'string' },
          meta: { type: 'object' }
        },
        required: ['id', 'role', 'content']
      }
    },
    settings: {
      type: 'object',
      properties: {
        model: { type: 'string' },
        style: { type: 'string' },
        outputFormat: { type: 'string' },
        temperature: { type: 'number' },
        variables: { type: 'object' }
      }
    },
    template: { type: 'string', enum: ['default', 'professional', 'minimal'] },
    watermark: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        position: { type: 'string', enum: ['bottom-right', 'bottom-left', 'bottom-center'] },
        opacity: { type: 'number', minimum: 0.1, maximum: 1.0 }
      }
    }
  },
  required: ['messages']
};

// Validation schema for other export formats
const basicExportSchema = {
  type: 'object',
  properties: {
    messages: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          role: { type: 'string', enum: ['user', 'assistant', 'system'] },
          content: { type: 'string' },
          meta: { type: 'object' }
        },
        required: ['id', 'role', 'content']
      }
    },
    settings: {
      type: 'object',
      properties: {
        model: { type: 'string' },
        style: { type: 'string' },
        outputFormat: { type: 'string' },
        temperature: { type: 'number' },
        variables: { type: 'object' }
      }
    }
  },
  required: ['messages']
};

// Default PDF export configuration
const getDefaultConfig = () => {
  const platformConfig = configCache.getPlatform() || {};
  return {
    watermark: {
      enabled: platformConfig.pdfExport?.watermark?.enabled !== false,
      text: platformConfig.pdfExport?.watermark?.text || 'AI Hub Apps',
      position: platformConfig.pdfExport?.watermark?.position || 'bottom-right',
      opacity: platformConfig.pdfExport?.watermark?.opacity || 0.5
    },
    template: platformConfig.pdfExport?.defaultTemplate || 'default',
    enableExportTracking: platformConfig.pdfExport?.enableExportTracking !== false
  };
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
  <title>Chat Export - ${appName || 'AI Hub Apps'}</title>
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
    
    ${watermark.enabled && watermark.text ? `<div class="watermark">${watermark.text}</div>` : ''}
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

// Helper functions for other export formats
const logExportActivity = (user, appId, chatId, format) => {
  const defaultConfig = getDefaultConfig();
  if (defaultConfig.enableExportTracking) {
    console.log(
      `[EXPORT] ${format.toUpperCase()} export by user ${user?.username || 'anonymous'} for app ${appId}, chat ${chatId}, timestamp: ${new Date().toISOString()}`
    );
  }
};

const buildMetadata = (settings = {}) => ({
  model: settings.model,
  style: settings.style,
  outputFormat: settings.outputFormat,
  temperature: settings.temperature,
  variables: settings.variables
});

const generateJSON = (messages, settings) => {
  return JSON.stringify({ ...buildMetadata(settings), messages }, null, 2);
};

const generateJSONL = (messages, settings) => {
  const lines = [JSON.stringify({ meta: buildMetadata(settings) })];
  messages.forEach(m => lines.push(JSON.stringify(m)));
  return lines.join('\n');
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

const isMarkdown = content => {
  if (!content) return false;
  // Simple check for markdown patterns
  return /[*_`#\[\]]\w/.test(content) || /\n\s*[-*+]\s/.test(content);
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

export default function registerExportRoutes(app) {
  // PDF Export endpoint
  app.post(
    '/api/apps/:appId/chat/:chatId/export/pdf',
    chatAuthRequired,
    validate(pdfExportSchema),
    async (req, res) => {
      let browser = null;

      try {
        const { appId, chatId } = req.params;
        const { messages, settings, template, watermark } = req.body;

        // Get default configuration and merge with request
        const defaultConfig = getDefaultConfig();
        const finalTemplate = template || defaultConfig.template;
        const finalWatermark = { ...defaultConfig.watermark, ...watermark };

        // Log export activity for security tracking
        if (defaultConfig.enableExportTracking) {
          console.log(
            `[EXPORT] PDF export by user ${req.user?.username || 'anonymous'} for app ${appId}, chat ${chatId}, template: ${finalTemplate}, timestamp: ${new Date().toISOString()}`
          );
        }

        // Get app information for better context
        const { data: apps = [] } = configCache.getApps();
        const app = apps.find(a => a.id === appId);
        const appName = app?.name?.en || app?.name || `App ${appId}`;

        // Generate HTML content
        const htmlContent = generatePDFHTML(
          messages,
          settings,
          finalTemplate,
          finalWatermark,
          appName
        );

        // Launch Puppeteer
        browser = await puppeteer.launch({
          headless: true,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-gpu',
            '--disable-software-rasterizer'
          ]
        });

        const page = await browser.newPage();

        // Set content and generate PDF
        await page.setContent(htmlContent, {
          waitUntil: 'networkidle0'
        });

        const pdfBuffer = await page.pdf({
          format: 'A4',
          margin: {
            top: '20px',
            right: '20px',
            bottom: '40px',
            left: '20px'
          },
          printBackground: true
        });

        // Set response headers
        const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
        const filename = `chat-${appName.replace(/[^a-z0-9]/gi, '-').toLowerCase()}-${timestamp}.pdf`;

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Length', pdfBuffer.length);

        res.send(pdfBuffer);
      } catch (error) {
        console.error('PDF export error:', error);
        res.status(500).json({
          error: 'Failed to generate PDF export',
          details: error.message
        });
      } finally {
        if (browser) {
          await browser.close();
        }
      }
    }
  );

  // JSON Export endpoint
  app.post(
    '/api/apps/:appId/chat/:chatId/export/json',
    chatAuthRequired,
    validate(basicExportSchema),
    async (req, res) => {
      try {
        const { appId, chatId } = req.params;
        const { messages, settings } = req.body;

        logExportActivity(req.user, appId, chatId, 'json');

        const jsonData = generateJSON(
          messages.filter(m => !m.isGreeting),
          settings
        );
        const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
        const filename = `chat-${appId}-${timestamp}.json`;

        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(jsonData);
      } catch (error) {
        console.error('JSON export error:', error);
        res.status(500).json({
          error: 'Failed to generate JSON export',
          details: error.message
        });
      }
    }
  );

  // JSONL Export endpoint
  app.post(
    '/api/apps/:appId/chat/:chatId/export/jsonl',
    chatAuthRequired,
    validate(basicExportSchema),
    async (req, res) => {
      try {
        const { appId, chatId } = req.params;
        const { messages, settings } = req.body;

        logExportActivity(req.user, appId, chatId, 'jsonl');

        const jsonlData = generateJSONL(
          messages.filter(m => !m.isGreeting),
          settings
        );
        const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
        const filename = `chat-${appId}-${timestamp}.jsonl`;

        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(jsonlData);
      } catch (error) {
        console.error('JSONL export error:', error);
        res.status(500).json({
          error: 'Failed to generate JSONL export',
          details: error.message
        });
      }
    }
  );

  // Markdown Export endpoint
  app.post(
    '/api/apps/:appId/chat/:chatId/export/markdown',
    chatAuthRequired,
    validate(basicExportSchema),
    async (req, res) => {
      try {
        const { appId, chatId } = req.params;
        const { messages, settings } = req.body;

        logExportActivity(req.user, appId, chatId, 'markdown');

        const markdownData = generateMarkdown(messages.filter(m => !m.isGreeting));
        const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
        const filename = `chat-${appId}-${timestamp}.md`;

        res.setHeader('Content-Type', 'text/markdown');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(markdownData);
      } catch (error) {
        console.error('Markdown export error:', error);
        res.status(500).json({
          error: 'Failed to generate Markdown export',
          details: error.message
        });
      }
    }
  );

  // HTML Export endpoint
  app.post(
    '/api/apps/:appId/chat/:chatId/export/html',
    chatAuthRequired,
    validate(basicExportSchema),
    async (req, res) => {
      try {
        const { appId, chatId } = req.params;
        const { messages, settings } = req.body;

        logExportActivity(req.user, appId, chatId, 'html');

        const htmlData = generateHTML(messages.filter(m => !m.isGreeting));
        const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
        const filename = `chat-${appId}-${timestamp}.html`;

        res.setHeader('Content-Type', 'text/html');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(htmlData);
      } catch (error) {
        console.error('HTML export error:', error);
        res.status(500).json({
          error: 'Failed to generate HTML export',
          details: error.message
        });
      }
    }
  );
}
