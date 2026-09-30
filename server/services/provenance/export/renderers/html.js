/**
 * HTML export renderer: one self-contained file with inline CSS.
 *
 * Ports the former browser export (`generatePDFHTML` / `getTemplateStyles`
 * in `client/src/api/endpoints/apps.js`), including the default,
 * professional and minimal templates, and adds the visible AI label banner
 * (an "AI" badge drawn in CSS with the "AI GENERATED" caption, the label
 * text, human-review / canvas notes) and the verification markers.
 *
 * Message markdown is rendered by `renderMarkdownToSafeHtml`: raw HTML is
 * escaped and unsafe link/image targets are dropped. The document has no
 * scripts and loads nothing external except images the content links to.
 * `ExportSigner` adds its `<meta>`/JSON-LD tags before `</head>`.
 *
 * @module services/provenance/export/renderers/html
 */
import { renderMarkdownToSafeHtml } from './markdown.js';
import {
  AI_BADGE_LETTERS,
  escapeHtml,
  formatDateTime,
  getDocumentMarker,
  getVerificationMarker,
  isTranscript,
  prepareCommon,
  roleLabel
} from './common.js';

const BASE_STYLES = `
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      line-height: 1.6;
      color: #333;
      background-color: #fff;
    }
    .container { max-width: 800px; margin: 0 auto; padding: 20px; }
    .header { border-bottom: 2px solid #e1e5e9; padding-bottom: 20px; margin-bottom: 24px; }
    .header h1 { color: #1a202c; font-size: 28px; font-weight: 700; margin-bottom: 5px; }
    .header h2 { color: #4a5568; font-size: 20px; font-weight: 500; margin-bottom: 10px; }
    .export-date { color: #718096; font-size: 14px; }
    .ai-label {
      display: flex; align-items: center; gap: 16px;
      background-color: #eef2ff; border: 1px solid #c7d2fe; border-radius: 10px;
      padding: 14px 18px; margin-bottom: 30px; color: #1e1b4b;
    }
    .ai-badge { display: flex; flex-direction: column; align-items: center; flex-shrink: 0; gap: 3px; }
    .ai-badge-mark {
      display: inline-flex; align-items: center; justify-content: center;
      min-width: 44px; height: 28px; padding: 0 8px; border-radius: 7px;
      background-color: #1e3a8a; color: #fff; font-weight: 700; font-size: 15px; letter-spacing: 0.5px;
    }
    .ai-badge-caption { font-size: 8px; font-weight: 700; letter-spacing: 0.4px; color: #1e3a8a; white-space: nowrap; }
    .ai-label-main { font-weight: 600; font-size: 15px; }
    .ai-label-detail { font-size: 13px; color: #3730a3; margin-top: 2px; }
    .metadata { background-color: #f7fafc; border-radius: 8px; padding: 20px; margin-bottom: 30px; }
    .metadata h3 { color: #2d3748; font-size: 16px; margin-bottom: 15px; }
    .metadata-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .metadata-grid div { font-size: 14px; color: #4a5568; overflow-wrap: anywhere; }
    .message {
      margin-bottom: 25px; padding: 20px; border-radius: 12px; border: 1px solid #e2e8f0;
      page-break-inside: avoid;
    }
    .user-message { background-color: #ebf8ff; border-left: 4px solid #3182ce; }
    .assistant-message { background-color: #f0fff4; border-left: 4px solid #38a169; }
    .system-message { background-color: #faf5ff; border-left: 4px solid #805ad5; }
    .message-header {
      display: flex; justify-content: space-between; align-items: center; gap: 12px;
      margin-bottom: 10px; font-size: 14px;
    }
    .role { font-weight: 600; color: #2d3748; }
    .model { color: #718096; font-weight: 400; margin-left: 6px; }
    .timestamp { color: #718096; white-space: nowrap; }
    .document-meta { color: #718096; font-size: 13px; margin-bottom: 8px; }
    .verification { font-size: 12px; font-style: italic; margin-bottom: 10px; }
    .verification-warning { color: #b7791f; }
    .verification-verified { color: #718096; }
    .message-content { color: #2d3748; overflow-wrap: anywhere; }
    .message-content p { margin-bottom: 10px; }
    .message-content p:last-child { margin-bottom: 0; }
    .message-content strong { font-weight: 600; }
    .message-content em { font-style: italic; }
    .message-content code {
      background-color: #edf2f7; padding: 2px 4px; border-radius: 3px;
      font-family: 'Monaco', 'Consolas', 'Courier New', monospace; font-size: 13px;
    }
    .message-content h1, .message-content h2, .message-content h3,
    .message-content h4, .message-content h5, .message-content h6 {
      margin-top: 15px; margin-bottom: 10px; font-weight: 600; color: #1a202c; line-height: 1.3;
    }
    .message-content h1 { font-size: 24px; }
    .message-content h2 { font-size: 20px; }
    .message-content h3 { font-size: 18px; }
    .message-content h4 { font-size: 16px; }
    .message-content h5 { font-size: 14px; }
    .message-content h6 { font-size: 13px; }
    .message-content h1:first-child, .message-content h2:first-child,
    .message-content h3:first-child, .message-content h4:first-child,
    .message-content h5:first-child, .message-content h6:first-child { margin-top: 0; }
    .message-content hr { border: none; border-top: 2px solid #e2e8f0; margin: 15px 0; }
    .message-content ul, .message-content ol { margin: 10px 0; padding-left: 24px; }
    .message-content ul { list-style-type: disc; }
    .message-content ol { list-style-type: decimal; }
    .message-content li { margin-bottom: 5px; }
    .message-content pre {
      background-color: #1a202c; color: #f7fafc; padding: 12px 16px; border-radius: 6px;
      overflow-x: auto; margin: 12px 0; font-size: 13px; line-height: 1.5;
    }
    .message-content pre code { background-color: transparent; padding: 0; color: inherit; font-size: inherit; }
    .message-content blockquote { border-left: 4px solid #cbd5e0; padding-left: 12px; margin: 12px 0; color: #4a5568; }
    .message-content table { border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 14px; }
    .message-content th, .message-content td {
      border: 1px solid #e2e8f0; padding: 8px 12px; text-align: left; vertical-align: top;
    }
    .message-content th { background-color: #f7fafc; font-weight: 600; }
    .message-content [align="center"] { text-align: center; }
    .message-content [align="right"] { text-align: right; }
    .message-content tr:nth-child(even) td { background-color: #fafbfc; }
    .message-content a { color: #3182ce; text-decoration: underline; }
    .message-content img { max-width: 100%; height: auto; }
    @media print {
      .container { max-width: none; margin: 0; padding: 20px; }
      .message { page-break-inside: avoid; }
      .ai-label, .ai-badge-mark { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    }
`;

const TEMPLATE_STYLES = Object.freeze({
  default: '',
  professional: `
    .user-message { background-color: #f8f9fa; border-left-color: #495057; }
    .assistant-message { background-color: #f8f9fa; border-left-color: #6c757d; }
    .system-message { background-color: #f8f9fa; border-left-color: #adb5bd; }
    .header h1 { color: #212529; }
    .ai-label { background-color: #f8f9fa; border-color: #ced4da; color: #212529; }
    .ai-badge-mark { background-color: #343a40; }
    .ai-badge-caption { color: #343a40; }
    .ai-label-detail { color: #495057; }
  `,
  minimal: `
    .message {
      border: none; border-radius: 0; border-bottom: 1px solid #e2e8f0;
      background-color: transparent; padding: 15px 0;
    }
    .user-message, .assistant-message, .system-message { border-left: none; background-color: transparent; }
    .metadata { background-color: transparent; border: 1px solid #e2e8f0; }
    .ai-label { background-color: transparent; border-color: #cbd5e0; color: #1a202c; }
    .ai-badge-mark { background-color: #111827; }
    .ai-badge-caption { color: #111827; }
    .ai-label-detail { color: #4a5568; }
  `
});

/**
 * The visible AI label banner.
 * @param {Object} label - see `getLabelInfo`
 * @param {Function} t - translate function
 * @returns {string} HTML
 */
function labelBanner(label, t) {
  if (!label.show) return '';
  const badge = label.euIcon
    ? `<div class="ai-badge" role="img" aria-label="${escapeHtml(t('export.label.badgeAlt'))}">` +
      `<span class="ai-badge-mark" aria-hidden="true">${AI_BADGE_LETTERS}</span>` +
      `<span class="ai-badge-caption" aria-hidden="true">${escapeHtml(label.badgeCaption)}</span>` +
      '</div>'
    : '';
  const details = label.details
    .map(detail => `<p class="ai-label-detail">${escapeHtml(detail)}</p>`)
    .join('');
  return `
    <aside class="ai-label" role="note" aria-label="${escapeHtml(t('export.label.heading'))}">
      ${badge}
      <div class="ai-label-text"><p class="ai-label-main">${escapeHtml(label.text)}</p>${details}</div>
    </aside>`;
}

/**
 * @param {{kind: string, text: string}|null} marker
 * @returns {string} HTML
 */
function markerHtml(marker) {
  if (!marker) return '';
  return `<p class="verification verification-${marker.kind}">${escapeHtml(marker.text)}</p>`;
}

/**
 * Render the export as a self-contained HTML document.
 *
 * @param {Object} doc - normalised export document (see `renderExport`)
 * @returns {Promise<Buffer>} UTF-8 HTML
 */
export async function renderHtml(doc) {
  const { t, label, settingsRows, exportedOn } = prepareCommon(doc);
  const transcript = isTranscript(doc);

  const settingsHtml = settingsRows.length
    ? `
    <section class="metadata">
      <h3>${escapeHtml(doc.source === 'chat' ? t('export.settings.chatTitle') : t('export.settings.title'))}</h3>
      <div class="metadata-grid">
        ${settingsRows
          .map(
            ([name, value]) =>
              `<div><strong>${escapeHtml(name)}:</strong> ${escapeHtml(value)}</div>`
          )
          .join('\n        ')}
      </div>
    </section>`
    : '';

  const messagesHtml = doc.messages
    .map(message => {
      const timestamp = formatDateTime(message.timestamp, doc.language);
      if (transcript) {
        return `
      <article class="message ${message.role}-message">
        <div class="message-header">
          <span class="role">${escapeHtml(roleLabel(message.role, t))}${
            message.model ? `<span class="model">· ${escapeHtml(message.model)}</span>` : ''
          }</span>
          ${timestamp ? `<span class="timestamp">${escapeHtml(timestamp)}</span>` : ''}
        </div>
        ${markerHtml(getVerificationMarker(message, t))}
        <div class="message-content">
          ${renderMarkdownToSafeHtml(message.content)}
        </div>
      </article>`;
      }
      const meta = [timestamp, message.model].filter(Boolean).join(' · ');
      return `
      <article class="document">
        ${meta ? `<p class="document-meta">${escapeHtml(meta)}</p>` : ''}
        ${markerHtml(getDocumentMarker(doc, message, t))}
        <div class="message-content">
          ${renderMarkdownToSafeHtml(message.content)}
        </div>
      </article>`;
    })
    .join('\n');

  const html = `<!DOCTYPE html>
<html lang="${doc.language}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(doc.title)}</title>
  <style>${BASE_STYLES}${TEMPLATE_STYLES[doc.template] || ''}
  </style>
</head>
<body>
  <div class="container">
    <header class="header">
      <h1>${escapeHtml(doc.title)}</h1>
      ${doc.appName && doc.appName !== doc.title ? `<h2>${escapeHtml(doc.appName)}</h2>` : ''}
      <p class="export-date">${escapeHtml(exportedOn)}</p>
    </header>
    ${labelBanner(label, t)}
    ${settingsHtml}
    <main class="messages">
      ${messagesHtml}
    </main>
  </div>
</body>
</html>
`;
  return Buffer.from(html, 'utf8');
}
