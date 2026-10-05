import { resolveTheme } from './pdf/themes.js';
import { createPdf } from './pdf/PdfService.js';
import { LIMITS } from './pdf/validators.js';

/**
 * Server-side document exports.
 *
 * Exports used to be built in the browser, and the PDF went through the print
 * dialog, which printed blank pages in several hosts (#2062). Here they are
 * real files, rendered by the same engine as the `pdf` skill. This service is
 * also where signing of exports (EU AI Act, #2571) hooks in later.
 */

export const EXPORT_LIMITS = Object.freeze({
  maxMessages: 2000,
  maxMessageChars: 1_000_000,
  maxTotalChars: 8_000_000,
  // What the renderer converts in one piece: a longer export is refused here,
  // with a 413, rather than after it reached the worker.
  maxMarkdownChars: LIMITS.maxMarkdownChars
});

const EXPORT_TIMEOUT_MS = 90_000;

const LABELS = {
  en: {
    user: 'User',
    assistant: 'Assistant',
    exportedOn: 'Exported on {date}',
    settings: 'Chat settings',
    model: 'Model',
    temperature: 'Temperature',
    style: 'Style',
    outputFormat: 'Output format',
    variables: 'Variables'
  },
  de: {
    user: 'Benutzer',
    assistant: 'Assistent',
    exportedOn: 'Exportiert am {date}',
    settings: 'Chat-Einstellungen',
    model: 'Modell',
    temperature: 'Temperatur',
    style: 'Stil',
    outputFormat: 'Ausgabeformat',
    variables: 'Variablen'
  }
};

function labelsFor(language) {
  const key = typeof language === 'string' ? language.slice(0, 2).toLowerCase() : 'en';
  return LABELS[key] || LABELS.en;
}

/**
 * Format a timestamp in the viewer's language and time zone. An unknown time
 * zone falls back to the server's.
 */
export function formatTimestamp(value, language, timeZone) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return '';
  const options = { dateStyle: 'medium', timeStyle: 'short' };
  try {
    return date.toLocaleString(language || 'en', { ...options, timeZone: timeZone || undefined });
  } catch {
    try {
      return date.toLocaleString(language || 'en', options);
    } catch {
      return date.toISOString();
    }
  }
}

function text(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

/**
 * Check a chat export request and throw a message the client can show.
 *
 * @param {Array} messages
 */
function assertMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw Object.assign(new Error('There are no messages to export.'), { status: 400 });
  }
  if (messages.length > EXPORT_LIMITS.maxMessages) {
    throw Object.assign(
      new Error(`A PDF export holds at most ${EXPORT_LIMITS.maxMessages} messages.`),
      { status: 413 }
    );
  }
  let total = 0;
  for (const message of messages) {
    const length = typeof message?.content === 'string' ? message.content.length : 0;
    if (length > EXPORT_LIMITS.maxMessageChars) {
      throw Object.assign(new Error('A message is too long to export.'), { status: 413 });
    }
    total += length;
  }
  if (total > EXPORT_LIMITS.maxTotalChars) {
    throw Object.assign(new Error('The conversation is too long to export as one PDF.'), {
      status: 413
    });
  }
}

function settingsBlock(settings, labels) {
  if (!settings || typeof settings !== 'object') return null;
  const rows = [];
  const add = (label, value) => {
    if (value === undefined || value === null || value === '') return;
    rows.push([{ text: label, bold: true }, { text: String(value).slice(0, 500) }]);
  };
  add(labels.model, settings.model);
  add(labels.temperature, settings.temperature);
  add(labels.style, settings.style);
  add(labels.outputFormat, settings.outputFormat);
  if (settings.variables && typeof settings.variables === 'object') {
    const entries = Object.entries(settings.variables)
      .slice(0, 50)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
    if (entries.length) add(labels.variables, entries.join(', '));
  }
  if (!rows.length) return null;
  return {
    box: {
      content: {
        stack: [
          { text: labels.settings, bold: true, margin: [0, 0, 0, 4] },
          {
            table: { widths: ['auto', '*'], body: rows },
            layout: 'ihubPlain',
            style: 'small'
          }
        ]
      },
      padding: 8
    },
    margin: [0, 0, 0, 12]
  };
}

/**
 * The document spec for a chat export.
 *
 * @param {Object} params
 * @param {Array<{ role: string, content: string, timestamp?: string|number }>} params.messages
 * @param {Object} [params.settings] - model, temperature, style, outputFormat, variables
 * @param {string} [params.title]
 * @param {string} [params.appName]
 * @param {string} [params.template] - default | professional | minimal
 * @param {{ text?: string, position?: string, opacity?: number }} [params.watermark]
 * @param {string} [params.language]
 * @param {string} [params.timeZone]
 * @returns {import('./pdf/buildDocument.js').PdfSpec}
 */
export function buildChatExportSpec({
  messages,
  settings,
  title,
  appName,
  template,
  watermark,
  language,
  timeZone
}) {
  assertMessages(messages);
  const theme = resolveTheme(template);
  const labels = labelsFor(language);
  const blocks = [];
  const settingsNode = settingsBlock(settings, labels);
  if (settingsNode) blocks.push(settingsNode);

  for (const message of messages) {
    if (!message || typeof message !== 'object' || message.isGreeting) continue;
    const isUser = message.role === 'user';
    const content = typeof message.content === 'string' ? message.content : '';
    blocks.push({
      callout: {
        fillColor: (isUser ? theme.userFill : theme.assistantFill) || undefined,
        borderColor: isUser ? theme.userBorder : theme.assistantBorder,
        content: {
          stack: [
            {
              columns: [
                {
                  text: isUser ? labels.user : labels.assistant,
                  bold: true,
                  color: isUser ? theme.userBorder : theme.heading
                },
                {
                  text: formatTimestamp(message.timestamp, language, timeZone),
                  alignment: 'right',
                  style: 'small',
                  width: 'auto'
                }
              ],
              margin: [0, 0, 0, 4]
            },
            content.trim() ? { markdown: content } : { text: '—', style: 'muted' }
          ]
        }
      },
      margin: [0, 0, 0, 10]
    });
  }

  const exportedOn = labels.exportedOn.replace(
    '{date}',
    formatTimestamp(Date.now(), language, timeZone)
  );
  const cleanTitle = text(title, 300).trim() || text(appName, 200).trim() || 'Chat';
  const cleanApp = text(appName, 200).trim();
  const wm = watermark && typeof watermark === 'object' ? watermark : null;
  return {
    title: cleanTitle,
    subtitle: [cleanApp && cleanApp !== cleanTitle ? cleanApp : null, exportedOn]
      .filter(Boolean)
      .join(' · '),
    language: typeof language === 'string' ? language.slice(0, 10) : undefined,
    theme: theme.name,
    markdownBreaks: true,
    blocks,
    pageNumbers: true,
    ...(wm && text(wm.text, 80).trim()
      ? {
          watermark: {
            text: text(wm.text, 80).trim(),
            position: ['bottom-left', 'bottom-center', 'bottom-right'].includes(wm.position)
              ? wm.position
              : 'bottom-right',
            opacity: Number(wm.opacity)
          }
        }
      : {})
  };
}

/**
 * The document spec for a Markdown export (workflow output, agent artifact,
 * any Markdown the UI shows with a download menu).
 *
 * @param {Object} params
 * @param {string} params.markdown
 * @param {string} [params.title]
 * @param {string} [params.template]
 * @param {string} [params.language]
 * @returns {import('./pdf/buildDocument.js').PdfSpec}
 */
export function buildMarkdownExportSpec({ markdown, title, template, language }) {
  if (typeof markdown !== 'string' || !markdown.trim()) {
    throw Object.assign(new Error('There is no content to export.'), { status: 400 });
  }
  if (markdown.length > EXPORT_LIMITS.maxMarkdownChars) {
    throw Object.assign(new Error('The content is too long to export as one PDF.'), {
      status: 413
    });
  }
  return {
    title: text(title, 300).trim() || undefined,
    // Content that opens with its own top-level heading already has a title
    // on the page; the given title then only goes into the metadata.
    showTitle: !/^\s*#\s/.test(markdown),
    language: typeof language === 'string' ? language.slice(0, 10) : undefined,
    theme: template,
    markdown,
    pageNumbers: true
  };
}

/**
 * Render an export spec.
 *
 * @param {import('./pdf/buildDocument.js').PdfSpec} spec
 * @returns {Promise<{ buffer: Buffer, pages: number, warnings: string[] }>}
 */
export function renderExport(spec) {
  return createPdf(spec, { timeoutMs: EXPORT_TIMEOUT_MS });
}
