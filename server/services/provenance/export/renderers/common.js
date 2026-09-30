/**
 * Helpers shared by every export renderer: input normalisation, the visible
 * AI label (EU AI Act Art. 50, CoP Measure 1.4), per-message verification
 * markers, settings rows, date formatting and the escaping guards each
 * container format needs.
 *
 * Nothing here signs or embeds provenance: that is `ExportSigner`'s job. The
 * renderers only produce a clean document with a visible label.
 *
 * @module services/provenance/export/renderers/common
 */
import { createTranslator, resolveLanguage } from './strings.js';

/** Roles a message may have. */
export const MESSAGE_ROLES = Object.freeze(['user', 'assistant', 'system']);

/** Verification states `ExportService` assigns to each message. */
export const VERIFICATION_STATES = Object.freeze(['verified', 'asserted', 'human', 'edited']);

/** Where the exported content comes from. */
export const EXPORT_SOURCES = Object.freeze(['chat', 'canvas', 'markdown', 'workflow', 'artifact']);

/** PDF looks. The other formats ignore the template unless noted. */
export const EXPORT_TEMPLATES = Object.freeze(['default', 'professional', 'minimal']);

/** Product name used as PDF creator/producer and as fallback app name. */
export const PRODUCT_NAME = 'iHub Apps';

/** The letters inside the drawn AI badge (the EU "AI" mark is not translated). */
export const AI_BADGE_LETTERS = 'AI';

const nonEmptyString = value => (typeof value === 'string' && value.trim() ? value.trim() : null);

/**
 * Normalise the message content to a string. `ExportService` already sends
 * strings; anything else is stringified so a renderer never crashes on it.
 *
 * @param {*} content - message content
 * @returns {string} the content as text
 */
function contentToString(content) {
  if (typeof content === 'string') return content;
  if (content === null || content === undefined) return '';
  if (typeof content === 'object') {
    try {
      return JSON.stringify(content, null, 2);
    } catch {
      return String(content);
    }
  }
  return String(content);
}

/**
 * Validate and fill in defaults on the document `ExportService` prepared.
 *
 * Unknown values fall back to the most conservative choice: an assistant
 * message without a known verification state is treated as `asserted`, so
 * no renderer claims more than the server could prove.
 *
 * @param {Object} doc - the prepared export document (see `renderExport`)
 * @returns {Object} a normalised copy; the input is not modified
 */
export function normalizeDoc(doc) {
  const input = doc && typeof doc === 'object' ? doc : {};
  const language = resolveLanguage(input.language);
  const t = createTranslator(language);
  const appName = nonEmptyString(input.appName) || PRODUCT_NAME;
  const rawLabel = input.label && typeof input.label === 'object' ? input.label : {};

  const messages = (Array.isArray(input.messages) ? input.messages : [])
    .filter(message => message && typeof message === 'object')
    .map((message, position) => {
      const role = MESSAGE_ROLES.includes(message.role) ? message.role : 'assistant';
      const fallbackVerification = role === 'assistant' ? 'asserted' : 'human';
      return {
        index: Number.isInteger(message.index) ? message.index : position,
        role,
        content: contentToString(message.content),
        timestamp: nonEmptyString(message.timestamp),
        model: nonEmptyString(message.model),
        verification: VERIFICATION_STATES.includes(message.verification)
          ? message.verification
          : fallbackVerification,
        contentId: nonEmptyString(message.contentId)
      };
    });

  const exportedAt = nonEmptyString(input.exportedAt) || new Date().toISOString();

  return {
    title: nonEmptyString(input.title) || appName,
    appName,
    exportedAt,
    language,
    settings: input.settings && typeof input.settings === 'object' ? input.settings : null,
    messages,
    source: EXPORT_SOURCES.includes(input.source) ? input.source : 'chat',
    label: {
      show: rawLabel.show === true,
      text: nonEmptyString(rawLabel.text) || t('export.label.default'),
      euIcon: rawLabel.euIcon === true,
      humanReviewed: rawLabel.humanReviewed === true,
      editorialContact: nonEmptyString(rawLabel.editorialContact),
      provider: nonEmptyString(rawLabel.provider)
    },
    template: EXPORT_TEMPLATES.includes(input.template) ? input.template : 'default',
    single: input.single === true
  };
}

/**
 * Whether the export is a chat transcript with "User / Assistant" framing.
 * Single-message exports and one-document sources (canvas, markdown,
 * workflow, artifact) render the body only.
 *
 * @param {Object} doc - normalised export document
 * @returns {boolean} true for a multi-message chat transcript
 */
export function isTranscript(doc) {
  return doc.source === 'chat' && !doc.single;
}

/**
 * Localised role name ("User", "Assistant", "System").
 *
 * @param {string} role - message role
 * @param {Function} t - translate function
 * @returns {string} the display name
 */
export function roleLabel(role, t) {
  if (role === 'user') return t('export.role.user');
  if (role === 'system') return t('export.role.system');
  return t('export.role.assistant');
}

const dateFormatters = new Map();

/**
 * Cached UTC date/time formatter per export language.
 * @param {'en'|'de'} language
 * @returns {Intl.DateTimeFormat}
 */
function dateFormatter(language) {
  let formatter = dateFormatters.get(language);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(language === 'de' ? 'de-DE' : 'en-GB', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'UTC'
    });
    dateFormatters.set(language, formatter);
  }
  return formatter;
}

/**
 * Format an ISO timestamp for display. Exports are generated on the server,
 * which does not know the reader's time zone, so times are printed in UTC
 * and say so.
 *
 * @param {string|null} value - ISO timestamp
 * @param {'en'|'de'} language - export language
 * @returns {string} e.g. "29 Sept 2026, 14:03 UTC", or '' when missing/invalid
 */
export function formatDateTime(value, language) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return `${dateFormatter(language).format(date)} UTC`;
}

/**
 * Stringify one settings value for display.
 *
 * @param {*} value - a settings or variable value
 * @returns {string} display text
 */
function settingValueToString(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/**
 * The rows of the "Settings" section, in a fixed order. Returns an empty
 * list when no setting has a value, so no empty section is emitted.
 *
 * @param {Object|null} settings - `{ model, temperature, style, outputFormat, variables }`
 * @param {Function} t - translate function
 * @returns {Array<[string, string]>} `[label, value]` pairs
 */
export function getSettingsRows(settings, t) {
  if (!settings || typeof settings !== 'object') return [];
  const rows = [];
  if (settings.model) rows.push([t('export.settings.model'), settingValueToString(settings.model)]);
  if (settings.temperature !== undefined && settings.temperature !== null) {
    rows.push([t('export.settings.temperature'), settingValueToString(settings.temperature)]);
  }
  if (settings.style) rows.push([t('export.settings.style'), settingValueToString(settings.style)]);
  if (settings.outputFormat) {
    rows.push([t('export.settings.outputFormat'), settingValueToString(settings.outputFormat)]);
  }
  const variables =
    settings.variables && typeof settings.variables === 'object' ? settings.variables : null;
  const variableEntries = variables
    ? Object.entries(variables).filter(([, v]) => v !== undefined && v !== null && v !== '')
    : [];
  if (variableEntries.length > 0) {
    rows.push([
      t('export.settings.variables'),
      variableEntries.map(([k, v]) => `${k}: ${settingValueToString(v)}`).join(', ')
    ]);
  }
  return rows;
}

/**
 * The visible AI label for one export (Art. 50, CoP Measure 1.4).
 *
 * @param {Object} doc - normalised export document
 * @param {Function} t - translate function
 * @returns {{show: boolean, text: string, euIcon: boolean, badgeCaption: string, details: string[]}}
 *   `details` are the extra lines under the label text: the human-review
 *   statement and, for canvas exports, the "edited by user" note.
 */
export function getLabelInfo(doc, t) {
  const { label } = doc;
  const details = [];
  if (label.show) {
    if (label.humanReviewed) {
      const contact = label.editorialContact || label.provider;
      details.push(
        contact
          ? t('export.label.humanReviewed', { contact })
          : t('export.label.humanReviewedNoContact')
      );
    }
    if (doc.source === 'canvas') details.push(t('export.label.canvasEdited'));
  }
  return {
    show: label.show,
    text: label.text,
    euIcon: label.show && label.euIcon,
    badgeCaption: t('export.label.badgeCaption'),
    details
  };
}

/**
 * The small per-message verification marker. Only assistant messages get
 * one: `asserted`/`edited` say the text changed after generation or could not
 * be matched to a generation record; `verified` is shown subtly.
 *
 * @param {Object} message - normalised message
 * @param {Function} t - translate function
 * @returns {{kind: 'warning'|'verified', text: string}|null} the marker, or null
 */
export function getVerificationMarker(message, t) {
  if (message.role !== 'assistant') return null;
  if (message.verification === 'asserted' || message.verification === 'edited') {
    return { kind: 'warning', text: t('export.verification.notVerified') };
  }
  if (message.verification === 'verified') {
    return { kind: 'verified', text: t('export.verification.verified') };
  }
  return null;
}

/**
 * The marker to print in the meta line of a one-document export. A canvas
 * export whose label already says "AI-assisted, edited by user" does not
 * repeat the "edited after generation" marker.
 *
 * @param {Object} doc - normalised export document
 * @param {Object} message - the message being rendered
 * @param {Function} t - translate function
 * @returns {{kind: 'warning'|'verified', text: string}|null} the marker, or null
 */
export function getDocumentMarker(doc, message, t) {
  const marker = getVerificationMarker(message, t);
  if (marker && marker.kind === 'warning' && doc.source === 'canvas' && doc.label.show) return null;
  return marker;
}

/**
 * Human-readable verification state for spreadsheet cells.
 *
 * @param {string} verification - verification state
 * @param {Function} t - translate function
 * @returns {string} display text
 */
export function verificationLabel(verification, t) {
  switch (verification) {
    case 'verified':
      return t('export.verification.verified');
    case 'edited':
      return t('export.verification.edited');
    case 'human':
      return t('export.verification.human');
    default:
      return t('export.verification.asserted');
  }
}

/**
 * Neutralise spreadsheet formula injection (OWASP CSV injection guidance).
 * Values starting with =, +, -, @, tab or CR are run as formulas by
 * Excel/LibreOffice; a leading single quote makes them plain text. Same
 * rule as the former browser export (`client/src/utils/exportFormats.js`).
 *
 * @param {*} value - cell value
 * @returns {string} the value, safe to put in a cell
 */
export function sanitizeForSpreadsheet(value) {
  if (value === null || value === undefined) return '';
  const stringValue = String(value);
  return /^[=+\-@\t\r]/.test(stringValue) ? `'${stringValue}` : stringValue;
}

/**
 * Remove characters XML 1.0 cannot carry (C0 controls other than tab/LF/CR,
 * U+FFFE/U+FFFF and lone surrogates). OOXML parts are XML, and one such
 * character makes Word/PowerPoint/Excel refuse the whole file.
 *
 * @param {*} value - text for an OOXML part
 * @returns {string} XML-safe text
 */
export function stripXmlInvalidChars(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    ''
  );
}

/**
 * HTML-escape text for element content and attribute values.
 *
 * @param {*} value - text
 * @returns {string} escaped text
 */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const NAMED_ENTITIES = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  shy: '­',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  laquo: '«',
  raquo: '»',
  copy: '©',
  reg: '®',
  trade: '™',
  euro: '€',
  auml: 'ä',
  ouml: 'ö',
  uuml: 'ü',
  Auml: 'Ä',
  Ouml: 'Ö',
  Uuml: 'Ü',
  szlig: 'ß'
});

/**
 * Decode the HTML entities markdown text may contain (`&amp;`, `&#8364;`,
 * ...). Markdown renders them as characters, so the non-HTML formats must
 * too. Unknown entities are kept as written.
 *
 * @param {string} text - markdown text
 * @returns {string} decoded text
 */
export function decodeHtmlEntities(text) {
  if (!text || text.indexOf('&') === -1) return text || '';
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const codePoint =
        entity[1] === 'x' || entity[1] === 'X'
          ? parseInt(entity.slice(2), 16)
          : parseInt(entity.slice(1), 10);
      if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) return match;
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return match;
      }
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, entity)
      ? NAMED_ENTITIES[entity]
      : match;
  });
}

/**
 * Whether a link target is safe to make clickable in an exported document:
 * http(s), mailto, tel, in-page anchors and relative paths. `javascript:`,
 * `data:`, `vbscript:`, `file:` and other schemes are rejected.
 *
 * @param {string} href - link target
 * @param {{allowRelative?: boolean}} [options] - relative links make sense in HTML only
 * @returns {boolean} true when the link may be emitted
 */
export function isSafeLinkTarget(href, { allowRelative = false } = {}) {
  if (typeof href !== 'string') return false;
  // Browsers ignore control characters and whitespace inside a scheme
  // ("java\tscript:"), so they must not hide one from this check either.
  const compact = href.replace(/[\u0000- \u007F]/g, '').toLowerCase();
  if (!compact) return false;
  if (/^(https?:|mailto:|tel:)/.test(compact)) return true;
  const hasScheme = /^[a-z][a-z0-9+.-]*:/.test(compact);
  return allowRelative && !hasScheme && !compact.startsWith('//');
}

/**
 * Split the available width between table columns: tables fill the width;
 * when the natural widths do not fit, every column first gets up to an equal
 * share and the rest goes to the columns that want more.
 *
 * @param {number[]} natural - preferred column widths
 * @param {number} total - available width
 * @returns {number[]} column widths summing to `total`
 */
export function distributeColumnWidths(natural, total) {
  const sum = natural.reduce((a, b) => a + b, 0);
  if (sum <= 0) return natural.map(() => total / natural.length);
  if (sum <= total) return natural.map(width => (width * total) / sum);
  const fair = total / natural.length;
  const base = natural.map(width => Math.min(width, fair));
  const remaining = total - base.reduce((a, b) => a + b, 0);
  const wants = natural.map((width, i) => width - base[i]);
  const totalWants = wants.reduce((a, b) => a + b, 0);
  return base.map((width, i) => width + (totalWants > 0 ? (remaining * wants[i]) / totalWants : 0));
}

/**
 * Create the translate function and label for a normalised document; used
 * by every renderer as its first step.
 *
 * @param {Object} doc - normalised export document
 * @returns {{t: Function, label: ReturnType<typeof getLabelInfo>, settingsRows: Array<[string, string]>, exportedOn: string}}
 *   the shared pieces every renderer prints
 */
export function prepareCommon(doc) {
  const t = createTranslator(doc.language);
  return {
    t,
    label: getLabelInfo(doc, t),
    settingsRows: getSettingsRows(doc.settings, t),
    exportedOn: t('export.header.exportedOn', {
      date: formatDateTime(doc.exportedAt, doc.language)
    })
  };
}
