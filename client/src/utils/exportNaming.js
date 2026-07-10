/**
 * Filename- and title-building helpers shared by all chat export formats.
 *
 * Goal: replace generic "chat-export-2026-06-09T15-30-00.xlsx" filenames
 * and "Chat Export - iHub Apps" document titles with something meaningful
 * — the app name, a topic slug derived from the first user message, and a
 * readable date.
 *
 * Kept in its own module (no heavy export-library deps) so callers that only
 * need filenames/titles — e.g. the PDF/JSON/HTML export helpers in
 * api/endpoints/apps.js — don't pull docx/pptxgenjs/write-excel-file into
 * their dependency graph.
 */

/**
 * Neutralize spreadsheet formula injection (OWASP CSV injection guidance).
 * Values starting with =, +, -, @, tab, or CR are interpreted as formulas by
 * Excel/LibreOffice; prefixing with a single quote forces them to render as
 * plain text instead of executing.
 */
export const sanitizeForSpreadsheet = value => {
  if (value === null || value === undefined) return '';
  const stringValue = String(value);
  return /^[=+\-@\t\r]/.test(stringValue) ? `'${stringValue}` : stringValue;
};

/** Strip markdown noise, collapse whitespace, ASCII-kebab-case, cap length. */
export const slugifyForFilename = (text, maxChars = 40) => {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/```[\s\S]*?```/g, ' ') // drop fenced code
    .replace(/`[^`]*`/g, ' ') // drop inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // drop images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // unwrap links
    .replace(/[*_~#>]/g, ' ') // drop markdown markers
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip accents
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, maxChars)
    .replace(/-+$/, '');
};

/**
 * Derive a short topic slug from the first non-greeting user message.
 * Returns '' when the chat has no user content to summarize from.
 */
export const getChatTopicSlug = messages => {
  if (!Array.isArray(messages)) return '';
  const firstUser = messages.find(m => m && m.role === 'user' && !m.isGreeting && m.content);
  if (!firstUser) return '';
  return slugifyForFilename(firstUser.content, 40);
};

const pad2 = n => String(n).padStart(2, '0');

/** `2026-06-09_1530` — filesystem-safe, sortable. */
export const formatDateTimeForFilename = (date = new Date()) =>
  `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}_` +
  `${pad2(date.getHours())}${pad2(date.getMinutes())}`;

/** `2026-06-09 15:30` — human-readable, used in document titles. */
export const formatDateTimeForTitle = (date = new Date()) =>
  `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
  `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;

/**
 * Build a descriptive download filename.
 *
 *   Full chat with topic:  `sales-assistant-pricing-discussion-2026-06-09_1530.docx`
 *   Full chat, no topic:   `sales-assistant-chat-2026-06-09_1530.docx`
 *   Single message:        `sales-assistant-message-2026-06-09_1530.docx`
 *   No app context:        `chat-2026-06-09_1530.docx`
 */
export const buildChatExportFilename = ({
  format,
  appName,
  appId,
  messages,
  isSingleMessage = false,
  date = new Date()
}) => {
  const ext = (format || '').toLowerCase();
  const appSlug = slugifyForFilename(appId || appName || '', 30);
  const dateStr = formatDateTimeForFilename(date);

  let middle;
  if (isSingleMessage) {
    middle = 'message';
  } else {
    const topic = getChatTopicSlug(messages);
    middle = topic || 'chat';
  }

  const parts = [appSlug, middle, dateStr].filter(Boolean);
  return `${parts.join('-')}.${ext}`;
};

/**
 * Build a descriptive in-document title.
 *
 *   `Sales Assistant — Pricing Discussion (2026-06-09 15:30)`
 *   `Sales Assistant — Message (2026-06-09 15:30)`
 *   `Sales Assistant — Chat (2026-06-09 15:30)`
 */
export const buildChatExportTitle = ({
  appName,
  messages,
  isSingleMessage = false,
  date = new Date()
}) => {
  const dateStr = formatDateTimeForTitle(date);
  const app = appName || 'iHub Apps';

  if (isSingleMessage) return `${app} — Message (${dateStr})`;

  // Use the first user message as a short topic — capitalize words, cap length.
  const firstUser = Array.isArray(messages)
    ? messages.find(m => m && m.role === 'user' && !m.isGreeting && m.content)
    : null;
  if (firstUser?.content) {
    const topic = firstUser.content
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`[^`]*`/g, ' ')
      .replace(/[*_~#>]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60);
    if (topic) return `${app} — ${topic} (${dateStr})`;
  }
  return `${app} — Chat (${dateStr})`;
};
