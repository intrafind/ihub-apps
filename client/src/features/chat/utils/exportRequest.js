/**
 * What the chat export dialog sends to `POST /api/exports` (EU AI Act
 * Art. 50(2); issues #2571, #2576) — pure functions, no React, no network, so
 * the message selection and the stored/unstored decision are unit-testable
 * (`tests/unit/client/chat-export-request.test.jsx`).
 *
 * Two request shapes (concept `concepts/2026-09-27 EU AI Act Content
 * Marking.md` §8.3):
 *
 * - **Stored chat** — the chat is server-backed and every selected message
 *   carries the store's id on `serverId` (set by `transformStoredMessage` when
 *   the transcript is hydrated): `{ chatId, messageIds }`. The server loads the
 *   content itself, so the signed manifest vouches for exactly what it stored.
 * - **Unstored chat** (no chat persistence, incognito, or a turn made in this
 *   session that has no `serverId` yet): the selected messages themselves,
 *   `messages: [{ id, role, content, timestamp, model }]`. The server compares
 *   each assistant message with its provenance record and marks the ones it
 *   cannot match as edited.
 *
 * @module features/chat/utils/exportRequest
 */

/** Formats `POST /api/exports` renders, in the order the dialog lists them. */
export const EXPORT_FORMATS = Object.freeze([
  'pdf',
  'docx',
  'pptx',
  'xlsx',
  'csv',
  'txt',
  'markdown',
  'html',
  'json',
  'jsonl'
]);

/** Text formats whose export can be put on the clipboard instead of downloaded. */
export const COPYABLE_EXPORT_FORMATS = Object.freeze(['txt', 'markdown', 'json', 'jsonl']);

/** Text formats that may carry the invisible C2PA text signpost. */
export const SIGNPOST_TEXT_FORMATS = Object.freeze(['txt', 'markdown']);

/** PDF looks the server offers. */
export const PDF_TEMPLATES = Object.freeze(['default', 'professional', 'minimal']);

/** Server-side limits (`server/routes/exports.js`). */
export const MAX_EXPORT_MESSAGE_CHARS = 500000;
export const MAX_EXPORT_TITLE_CHARS = 300;
const MAX_ID_CHARS = 200;

const EXPORTABLE_ROLES = new Set(['user', 'assistant', 'system']);

/**
 * The message text as the chat shows it (markdown). Structured output that
 * arrived as an object is exported as pretty-printed JSON.
 *
 * @param {Object} message - Chat message
 * @returns {string}
 */
export function getMessageText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (content === null || content === undefined) return '';
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}

/**
 * Whether a chat message belongs in an export.
 *
 * Left out: the app greeting, a turn still streaming, failed turns and error
 * notices, UI-only system notices (e.g. "transcription failed" — a system
 * message from the stored transcript is kept), and messages without text
 * (the auto-start turn of a start form).
 *
 * @param {Object} message - Chat message
 * @returns {boolean}
 * @example
 * isExportableMessage({ role: 'assistant', content: 'Hi', isGreeting: true }); // → false
 */
export function isExportableMessage(message) {
  if (!message || typeof message !== 'object') return false;
  if (!EXPORTABLE_ROLES.has(message.role)) return false;
  if (message.isGreeting || message.loading) return false;
  if (message.error === true || message.isErrorMessage) return false;
  if (message.role === 'system' && !message.fromServer) return false;
  return getMessageText(message).trim().length > 0;
}

/**
 * The messages the dialog offers for selection, in transcript order.
 *
 * @param {Object[]} messages - The conversation as the chat renders it
 * @returns {Object[]}
 */
export function getExportableMessages(messages) {
  return Array.isArray(messages) ? messages.filter(isExportableMessage) : [];
}

/**
 * A one-line plain-text preview of a message for the selection list.
 *
 * @param {Object} message - Chat message
 * @param {number} [maxChars=140]
 * @returns {string}
 */
export function getMessagePreview(message, maxChars = 140) {
  const text = getMessageText(message)
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[*_~`#>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > maxChars ? `${text.slice(0, maxChars - 1).trimEnd()}…` : text;
}

/**
 * A stable selection key per message: its id, or its position for the rare
 * message without one.
 *
 * @param {Object} message
 * @param {number} index - Position in the exportable list
 * @returns {string}
 */
export function getMessageKey(message, index) {
  return typeof message?.id === 'string' && message.id ? message.id : `index-${index}`;
}

/**
 * Toggle one message, or — with `range` (shift-click) — set every message
 * between the previously clicked one and this one to this message's new state.
 *
 * @param {Object} params
 * @param {string[]} params.keys - All selectable keys in list order
 * @param {Set<string>} params.selected - Currently selected keys
 * @param {string} params.key - Clicked key
 * @param {string|null} [params.anchorKey] - Key clicked before (range start)
 * @param {boolean} [params.range=false] - Shift held
 * @returns {Set<string>} The new selection (a new Set; the input is not changed)
 */
export function toggleMessageSelection({ keys, selected, key, anchorKey = null, range = false }) {
  const next = new Set(selected);
  const select = !selected.has(key);
  const from = range && anchorKey ? keys.indexOf(anchorKey) : -1;
  const to = keys.indexOf(key);
  if (from === -1 || to === -1) {
    if (select) next.add(key);
    else next.delete(key);
    return next;
  }
  const [start, end] = from <= to ? [from, to] : [to, from];
  for (let i = start; i <= end; i += 1) {
    if (select) next.add(keys[i]);
    else next.delete(keys[i]);
  }
  return next;
}

/**
 * An ISO timestamp from whatever the message carries (`ts` from the store,
 * `timestamp`/`createdAt` elsewhere), or null.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function toIsoTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * One message as the server's unstored-export shape.
 *
 * @param {Object} message - Chat message
 * @returns {{id?: string, role: string, content: string, timestamp?: string, model?: string}}
 */
export function toExportMessage(message) {
  const out = {
    role: message.role,
    content: getMessageText(message).slice(0, MAX_EXPORT_MESSAGE_CHARS)
  };
  const id = message.serverId || message.id;
  if (typeof id === 'string' && id) out.id = id.slice(0, MAX_ID_CHARS);
  const timestamp = toIsoTimestamp(message.ts ?? message.timestamp ?? message.createdAt);
  if (timestamp) out.timestamp = timestamp;
  const model =
    (typeof message.model === 'string' && message.model) ||
    (typeof message.modelId === 'string' && message.modelId) ||
    (typeof message.provenance?.model?.id === 'string' && message.provenance.model.id) ||
    null;
  if (model) out.model = model.slice(0, MAX_ID_CHARS);
  return out;
}

/**
 * The chat settings printed in the export's settings section. Empty values
 * are dropped so the server does not render an empty "Settings" block.
 *
 * @param {Object} [settings] - `{ model, style, outputFormat, temperature, variables }`
 * @returns {Object}
 */
export function buildExportSettings(settings) {
  const out = {};
  if (!settings || typeof settings !== 'object') return out;
  for (const key of ['model', 'style', 'outputFormat']) {
    if (typeof settings[key] === 'string' && settings[key]) out[key] = settings[key];
  }
  const { temperature, variables } = settings;
  if (typeof temperature === 'number' && Number.isFinite(temperature)) {
    out.temperature = temperature;
  } else if (typeof temperature === 'string' && temperature.trim()) {
    out.temperature = temperature.trim();
  }
  if (
    variables &&
    typeof variables === 'object' &&
    !Array.isArray(variables) &&
    Object.keys(variables).length
  ) {
    out.variables = variables;
  }
  return out;
}

/**
 * Whether the selection can be exported by id from the chat store.
 *
 * @param {Object[]} messages - Selected, exportable messages
 * @param {Object} params
 * @param {boolean} params.serverBacked - The chat is stored server-side
 * @param {string|null} params.chatId
 * @returns {boolean}
 */
export function canExportByIds(messages, { serverBacked, chatId }) {
  return Boolean(
    serverBacked &&
    typeof chatId === 'string' &&
    chatId &&
    messages.length > 0 &&
    messages.every(m => typeof m.serverId === 'string' && m.serverId)
  );
}

/**
 * A document title for the export when the conversation has none: the app
 * name plus the first user message as the topic (no date — the server adds
 * the export date to the document and the filename).
 *
 * @param {Object} params
 * @param {string} [params.appName]
 * @param {Object[]} [params.messages] - Selected messages
 * @param {boolean} [params.single=false] - Single-message export
 * @param {{message: string, chat: string}} [params.labels] - Translated words
 * @returns {string} e.g. `Sales Assistant — Pricing for Q3`
 */
export function buildExportTitle({
  appName,
  messages = [],
  single = false,
  labels = { message: 'Message', chat: 'Chat' }
}) {
  const app = (appName || 'iHub Apps').trim();
  if (single) return `${app} — ${labels.message}`;
  const firstUser = messages.find(m => m?.role === 'user' && getMessageText(m).trim());
  const topic = firstUser
    ? getMessageText(firstUser)
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`[^`]*`/g, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/[*_~#>]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 60)
        .trim()
    : '';
  return `${app} — ${topic || labels.chat}`;
}

/**
 * The EU AI icon option for the dialog: hidden (`off`), a checkbox
 * (`optional`) or checked and locked (`always`).
 *
 * @param {Object|null|undefined} aiConfig - `platformConfig.aiTransparency`
 * @returns {'off'|'optional'|'always'}
 */
export function getEuIconMode(aiConfig) {
  if (aiConfig?.enabled !== true) return 'off';
  const mode = aiConfig?.labels?.euIcon;
  return mode === 'optional' || mode === 'always' ? mode : 'off';
}

/**
 * Whether the "Reviewed by a human (editorial responsibility)" option is
 * offered — it only changes the label and manifest while AI transparency is on.
 *
 * @param {Object|null|undefined} aiConfig - `platformConfig.aiTransparency`
 * @returns {boolean}
 */
export function isHumanReviewOptionAvailable(aiConfig) {
  return aiConfig?.enabled === true;
}

/**
 * Build the `POST /api/exports` body for a chat export.
 *
 * @param {Object} params
 * @param {string} params.format - One of {@link EXPORT_FORMATS}
 * @param {Object[]} params.messages - The selected messages (non-exportable ones are dropped)
 * @param {boolean} [params.serverBacked=false] - The chat is stored server-side
 * @param {string|null} [params.chatId]
 * @param {string|null} [params.appId]
 * @param {string|null} [params.title] - Explicit title (e.g. the conversation title)
 * @param {string|null} [params.fallbackTitle] - Title for an unstored export without one;
 *   a stored export without an explicit title leaves it to the server, which uses the
 *   stored chat's own title
 * @param {Object} [params.settings] - Chat settings (see {@link buildExportSettings})
 * @param {string} [params.template='default'] - PDF template
 * @param {boolean} [params.euIcon=false] - Add the EU AI icon
 * @param {boolean} [params.humanReviewed=false] - Editorial responsibility declared
 * @param {boolean} [params.single=false] - Single-message export
 * @returns {Object} The request body
 * @throws {Error} `code: 'UNSUPPORTED_FORMAT'` or `code: 'NO_MESSAGES'`
 * @example
 * buildChatExportRequest({
 *   format: 'pdf', serverBacked: true, chatId: 'c1', appId: 'chat',
 *   messages: [{ id: 'm1', serverId: 'm1', role: 'user', content: 'Hi' }]
 * });
 * // → { format: 'pdf', source: 'chat', appId: 'chat', chatId: 'c1', messageIds: ['m1'],
 * //     settings: {}, options: { template: 'default' } }
 */
export function buildChatExportRequest({
  format,
  messages,
  serverBacked = false,
  chatId = null,
  appId = null,
  title = null,
  fallbackTitle = null,
  settings = null,
  template = 'default',
  euIcon = false,
  humanReviewed = false,
  single = false
}) {
  if (!EXPORT_FORMATS.includes(format)) {
    throw Object.assign(new Error(`Unsupported export format: ${format}`), {
      code: 'UNSUPPORTED_FORMAT'
    });
  }
  const selected = getExportableMessages(messages);
  if (selected.length === 0) {
    throw Object.assign(new Error('No messages selected for export'), { code: 'NO_MESSAGES' });
  }

  const stored = canExportByIds(selected, { serverBacked, chatId });
  const body = { format, source: 'chat' };
  if (appId) body.appId = appId;
  if (stored) {
    body.chatId = chatId;
    body.messageIds = selected.map(m => m.serverId);
  } else {
    body.messages = selected.map(toExportMessage);
  }

  const resolvedTitle =
    (typeof title === 'string' && title.trim()) ||
    (!stored && typeof fallbackTitle === 'string' && fallbackTitle.trim()) ||
    '';
  if (resolvedTitle) body.title = resolvedTitle.slice(0, MAX_EXPORT_TITLE_CHARS);

  body.settings = buildExportSettings(settings);

  const options = {};
  if (format === 'pdf') options.template = PDF_TEMPLATES.includes(template) ? template : 'default';
  if (euIcon) options.euIcon = true;
  if (humanReviewed) options.humanReviewed = true;
  if (Object.keys(options).length > 0) body.options = options;

  if (single) body.single = true;
  return body;
}

/**
 * Whether a text already carries a C2PA text signpost (U+FEFF followed by
 * variation selectors, C2PA 2.4 Appendix A.8) — the export of a text format
 * has one when the admin switched the signpost on for exports.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function hasTextSignpost(text) {
  return typeof text === 'string' && /﻿[\u{E0100}-\u{E01EF}]/u.test(text);
}

/**
 * Whether the clipboard signpost is switched on — the app's override wins
 * over the platform setting (`server/services/provenance/text/signpost.js`).
 *
 * @param {Object|null|undefined} aiConfig - `platformConfig.aiTransparency`
 * @param {Object|null|undefined} app - App as the chat client receives it
 * @returns {boolean}
 */
export function isClipboardSignpostEnabled(aiConfig, app) {
  if (aiConfig?.enabled !== true) return false;
  const appValue = app?.aiTransparency?.signpost?.clipboard;
  if (typeof appValue === 'boolean') return appValue;
  return aiConfig?.text?.signpost?.clipboard === true;
}

/**
 * Whether a copied export text still needs the clipboard signpost from
 * `POST /api/provenance/signpost`. Only plain text and markdown carry one
 * (JSON would no longer parse), and never twice.
 *
 * @param {Object} params
 * @param {string} params.format - Export format that was copied
 * @param {string} params.text - The export text
 * @param {Object} [params.aiConfig] - `platformConfig.aiTransparency`
 * @param {Object} [params.app] - App as the chat client receives it
 * @returns {boolean}
 */
export function shouldSignClipboardCopy({ format, text, aiConfig, app }) {
  return (
    SIGNPOST_TEXT_FORMATS.includes(format) &&
    isClipboardSignpostEnabled(aiConfig, app) &&
    !hasTextSignpost(text)
  );
}

/**
 * i18n key and English fallback for a failed export, by HTTP status/code.
 *
 * @param {{status?: (number|null), code?: (string|null), message?: string}} error
 * @returns {{key: string, fallback: string, params?: Object}}
 */
export function describeExportError(error) {
  if (error?.code === 'NO_MESSAGES') {
    return {
      key: 'pages.appChat.export.messages.noneSelected',
      fallback: 'Select at least one message.'
    };
  }
  if (error?.code === 'DOWNLOAD_BLOCKED') {
    return {
      key: 'pages.appChat.export.errors.downloadBlocked',
      fallback: 'The download could not be started.'
    };
  }
  if (error?.status === 403) {
    return {
      key: 'pages.appChat.export.errors.disabled',
      fallback: 'Exports are disabled on this installation.'
    };
  }
  if (error?.status === 404) {
    return {
      key: 'pages.appChat.export.errors.chatNotFound',
      fallback: 'The conversation could not be found on the server.'
    };
  }
  if (error?.message) {
    return {
      key: 'pages.appChat.export.errors.failed',
      fallback: 'The export failed: {{message}}',
      params: { message: error.message }
    };
  }
  return {
    key: 'pages.appChat.export.errors.generic',
    fallback: 'The export failed. Please try again.'
  };
}
