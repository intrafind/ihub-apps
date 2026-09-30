/**
 * PDF export renderer (A4, pdf-lib + fontkit).
 *
 * Ports the look of the former browser print export
 * (`client/src/api/endpoints/apps.js`, templates default / professional /
 * minimal) to real PDF generation on the server:
 *
 * - first page: title, app name, "Exported on", the AI label box (EU "AI"
 *   badge, label text, human-review and canvas notes) and the settings block;
 * - chat transcripts: one card per message with a coloured role band, the
 *   verification marker and the markdown body; one-document sources render
 *   the body only;
 * - pages 2+: running header (title, small "AI" badge); every page: footer
 *   with the label text and "n / N".
 *
 * Markdown comes from `marked.lexer` tokens: headings, paragraphs with
 * bold / italic / code / links, nested lists, code blocks, blockquotes,
 * tables (with repeated header rows) and rules. There is only one font
 * (Liberation Sans Regular), so bold is drawn as fill+stroke text and italic
 * as skewed text; both stay extractable as normal text.
 *
 * The file is saved without object streams because `ExportSigner`
 * post-processes it.
 *
 * @module services/provenance/export/renderers/pdf
 */
import {
  PDFDocument,
  PDFString,
  PageSizes,
  TextRenderingMode,
  degrees,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  setLineWidth,
  setStrokingColor,
  setTextRenderingMode
} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { getFontBytes, toFontSafeText } from './fontMetrics.js';
import { blockSegments, lexMarkdown, stripHtmlTags } from './markdown.js';
import {
  AI_BADGE_LETTERS,
  PRODUCT_NAME,
  distributeColumnWidths,
  formatDateTime,
  getDocumentMarker,
  getVerificationMarker,
  isSafeLinkTarget,
  isTranscript,
  prepareCommon,
  roleLabel
} from './common.js';

// ── Page geometry (points) ─────────────────────────────────────────────

const [PAGE_WIDTH, PAGE_HEIGHT] = PageSizes.A4;
const MARGIN_X = 56;
const MARGIN_TOP = 60;
const MARGIN_BOTTOM = 62;
const CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN_X;
const CONTENT_TOP = PAGE_HEIGHT - MARGIN_TOP;
const CONTENT_HEIGHT = CONTENT_TOP - MARGIN_BOTTOM;

const BODY_SIZE = 10.5;
const LINE_FACTOR = 1.42;
const HEADING_SIZES = [17, 14.5, 12.5, 11.5, 10.5, 10.5];
const LIST_BULLETS = ['•', '◦', '▪'];
/** Stroke width of faux-bold text, relative to the font size. */
const BOLD_STROKE = 0.028;
const ITALIC_SKEW = degrees(11);
const ELLIPSIS = '…';

// ── Templates ──────────────────────────────────────────────────────────

const DEFAULT_THEME = {
  title: '#1A202C',
  subtitle: '#4A5568',
  muted: '#718096',
  text: '#2D3748',
  heading: '#1A202C',
  link: '#2B6CB0',
  rule: '#E2E8F0',
  codeBg: '#EDF2F7',
  codeText: '#2D3748',
  codeBlockBg: '#F7FAFC',
  codeBlockBorder: '#E2E8F0',
  codeBlockText: '#1A202C',
  quoteBar: '#CBD5E0',
  quoteText: '#4A5568',
  tableBorder: '#CBD5E0',
  tableHeaderBg: '#EDF2F7',
  tableStripeBg: '#F9FAFB',
  warning: '#B7791F',
  verified: '#718096',
  labelBg: '#EEF2FF',
  labelBorder: '#C7D2FE',
  labelText: '#1E1B4B',
  labelDetail: '#3730A3',
  badgeFill: '#1E3A8A',
  badgeText: '#FFFFFF',
  badgeCaption: '#1E3A8A',
  settingsBg: '#F7FAFC',
  settingsBorder: null,
  messageRule: null,
  roles: {
    user: { band: '#EBF8FF', accent: '#3182CE', text: '#2C5282' },
    assistant: { band: '#F0FFF4', accent: '#38A169', text: '#276749' },
    system: { band: '#FAF5FF', accent: '#805AD5', text: '#553C9A' }
  }
};

const THEME_OVERRIDES = {
  default: {},
  professional: {
    title: '#212529',
    heading: '#212529',
    text: '#343A40',
    link: '#1F4E79',
    labelBg: '#F8F9FA',
    labelBorder: '#CED4DA',
    labelText: '#212529',
    labelDetail: '#495057',
    badgeFill: '#343A40',
    badgeCaption: '#343A40',
    settingsBg: '#F8F9FA',
    warning: '#8A6D3B',
    roles: {
      user: { band: '#F1F3F5', accent: '#495057', text: '#212529' },
      assistant: { band: '#F8F9FA', accent: '#6C757D', text: '#212529' },
      system: { band: '#F8F9FA', accent: '#ADB5BD', text: '#212529' }
    }
  },
  minimal: {
    labelBg: null,
    labelBorder: '#CBD5E0',
    labelText: '#1A202C',
    labelDetail: '#4A5568',
    badgeFill: '#111827',
    badgeCaption: '#111827',
    settingsBg: null,
    settingsBorder: '#E2E8F0',
    messageRule: '#E2E8F0',
    roles: {
      user: { band: null, accent: null, text: '#1A202C' },
      assistant: { band: null, accent: null, text: '#1A202C' },
      system: { band: null, accent: null, text: '#4A5568' }
    }
  }
};

/**
 * Convert "#RRGGBB" into a pdf-lib colour; null stays null ("none").
 * @param {string|null} value
 * @returns {import('pdf-lib').RGB|null}
 */
function hexColor(value) {
  if (!value) return null;
  const n = parseInt(value.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

/**
 * Resolve the colour theme of a template.
 * @param {string} template - default | professional | minimal
 * @returns {Object} theme with pdf-lib colours
 */
function buildTheme(template) {
  const merged = { ...DEFAULT_THEME, ...(THEME_OVERRIDES[template] || {}) };
  const theme = {};
  for (const [key, value] of Object.entries(merged)) {
    if (key === 'roles') continue;
    theme[key] = hexColor(value);
  }
  theme.roles = {};
  for (const [role, colors] of Object.entries(merged.roles)) {
    theme.roles[role] = {
      band: hexColor(colors.band),
      accent: hexColor(colors.accent),
      text: hexColor(colors.text)
    };
  }
  return theme;
}

/**
 * SVG path of a rounded rectangle with its top-left corner at the origin.
 * @param {number} width
 * @param {number} height
 * @param {number} radius
 * @returns {string} SVG path data
 */
function roundedRectPath(width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  return [
    `M ${r} 0`,
    `H ${width - r}`,
    `Q ${width} 0 ${width} ${r}`,
    `V ${height - r}`,
    `Q ${width} ${height} ${width - r} ${height}`,
    `H ${r}`,
    `Q 0 ${height} 0 ${height - r}`,
    `V ${r}`,
    `Q 0 0 ${r} 0`,
    'Z'
  ].join(' ');
}

const styleKey = style =>
  `${style.bold ? 'b' : ''}${style.italic ? 'i' : ''}${style.code ? 'c' : ''}${style.strike ? 's' : ''}|${style.link || ''}`;

const PLAIN_STYLE = Object.freeze({});

/**
 * Lays out and draws the document page by page. Coordinates follow pdf-lib
 * (origin bottom-left); `y` is the top of the next free line.
 */
class PdfWriter {
  /**
   * @param {Object} params
   * @param {PDFDocument} params.pdf
   * @param {import('pdf-lib').PDFFont} params.font
   * @param {Object} params.theme - see `buildTheme`
   * @param {Function} params.t - translate function
   * @param {Object} params.doc - normalised export document
   * @param {Object} params.label - see `getLabelInfo`
   */
  constructor({ pdf, font, theme, t, doc, label }) {
    this.pdf = pdf;
    this.font = font;
    this.theme = theme;
    this.t = t;
    this.doc = doc;
    this.label = label;
    this.pages = [];
    this.page = null;
    this.y = CONTENT_TOP;
    this.trailingGap = 0;
    this.widthCache = new Map();
    this.segmentOptions = { imageLabel: t('export.content.image') };
    this.addPage();
  }

  // ── Page flow ─────────────────────────────────────────────────────────

  /** Start a new page; pages after the first get the running header. */
  addPage() {
    this.page = this.pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    this.pages.push(this.page);
    this.y = CONTENT_TOP;
    this.trailingGap = 0;
    if (this.pages.length > 1) this.drawRunningHeader();
  }

  /**
   * Move to a new page unless `height` still fits on this one.
   * @param {number} height
   */
  ensure(height) {
    if (this.y - height < MARGIN_BOTTOM) this.addPage();
  }

  /**
   * Vertical space after a block. Skipped at the top of a page, and
   * remembered so side bars can end at the text instead of the gap.
   * @param {number} amount
   */
  gap(amount) {
    if (this.y >= CONTENT_TOP - 0.01) return;
    this.y -= amount;
    this.trailingGap = amount;
  }

  /** @returns {{page: number, y: number}} where the next block starts */
  startPosition() {
    return { page: this.pages.length - 1, y: this.y };
  }

  /** @returns {{page: number, y: number}} where the last block's text ended */
  endPosition() {
    return {
      page: this.pages.length - 1,
      y: Math.min(CONTENT_TOP, this.y + this.trailingGap)
    };
  }

  // ── Primitives ────────────────────────────────────────────────────────

  /**
   * Width of font-safe text, cached per size.
   * @param {string} text
   * @param {number} size
   * @returns {number}
   */
  width(text, size) {
    const key = `${size}|${text}`;
    let width = this.widthCache.get(key);
    if (width === undefined) {
      width = this.font.widthOfTextAtSize(text, size);
      if (this.widthCache.size < 20000) this.widthCache.set(key, width);
    }
    return width;
  }

  /**
   * Draw one run of font-safe text.
   * @param {string} text
   * @param {{x: number, y: number, size: number, color: Object, bold?: boolean, italic?: boolean, page?: Object}} options
   */
  drawText(text, { x, y, size, color, bold = false, italic = false, page = this.page }) {
    if (!text) return;
    if (bold) {
      page.pushOperators(
        pushGraphicsState(),
        setTextRenderingMode(TextRenderingMode.FillAndOutline),
        setLineWidth(size * BOLD_STROKE),
        setStrokingColor(color)
      );
    }
    page.drawText(text, {
      x,
      y,
      size,
      font: this.font,
      color,
      ...(italic ? { ySkew: ITALIC_SKEW } : {})
    });
    if (bold) page.pushOperators(popGraphicsState());
    this.trailingGap = 0;
  }

  /**
   * Shorten font-safe text with "…" until it fits.
   * @param {string} text
   * @param {number} maxWidth
   * @param {number} size
   * @returns {string}
   */
  truncate(text, maxWidth, size) {
    if (this.width(text, size) <= maxWidth) return text;
    const chars = Array.from(text);
    let low = 0;
    let high = chars.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (this.width(chars.slice(0, mid).join('') + ELLIPSIS, size) <= maxWidth) low = mid;
      else high = mid - 1;
    }
    return chars.slice(0, low).join('').trimEnd() + ELLIPSIS;
  }

  /**
   * Add a clickable URI annotation over a link run.
   * @param {Object} page
   * @param {number} x
   * @param {number} y - bottom
   * @param {number} width
   * @param {number} height
   * @param {string} href
   */
  addLinkAnnotation(page, x, y, width, height, href) {
    const annotation = this.pdf.context.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [x, y, x + width, y + height],
      Border: [0, 0, 0],
      A: { Type: 'Action', S: 'URI', URI: PDFString.of(href) }
    });
    page.node.addAnnot(this.pdf.context.register(annotation));
  }

  /**
   * Fill a vertical bar next to content that may span several pages
   * (message accent, blockquote bar).
   * @param {{page: number, y: number}} start
   * @param {{page: number, y: number}} end
   * @param {number} x
   * @param {number} width
   * @param {Object} color
   */
  drawSpanBar(start, end, x, width, color) {
    if (!color) return;
    for (let index = start.page; index <= end.page; index++) {
      const top = index === start.page ? start.y : CONTENT_TOP;
      const bottom = index === end.page ? end.y : MARGIN_BOTTOM;
      if (top - bottom > 0.5) {
        this.pages[index].drawRectangle({ x, y: bottom, width, height: top - bottom, color });
      }
    }
  }

  /**
   * Draw the rounded "AI" badge with its caption underneath.
   * @param {Object} page
   * @param {number} x - left
   * @param {number} top - top edge of the badge
   * @param {{width: number, height: number, letterSize: number, caption?: string, captionSize?: number}} metrics
   */
  drawBadge(page, x, top, metrics) {
    const { width, height, letterSize } = metrics;
    page.drawSvgPath(roundedRectPath(width, height, height * 0.26), {
      x,
      y: top,
      color: this.theme.badgeFill
    });
    const letterWidth = this.width(AI_BADGE_LETTERS, letterSize);
    this.drawText(AI_BADGE_LETTERS, {
      page,
      x: x + (width - letterWidth) / 2,
      y: top - height / 2 - letterSize * 0.35,
      size: letterSize,
      color: this.theme.badgeText,
      bold: true
    });
    if (metrics.caption) {
      const captionWidth = this.width(metrics.caption, metrics.captionSize);
      this.drawText(metrics.caption, {
        page,
        x: x + (width - captionWidth) / 2,
        y: top - height - metrics.captionSize - 1.5,
        size: metrics.captionSize,
        color: this.theme.badgeCaption,
        bold: true
      });
    }
  }

  /**
   * Size of the full badge (with caption) for the label box.
   * @returns {{width: number, height: number, letterSize: number, caption: string, captionSize: number, totalHeight: number}}
   */
  badgeMetrics() {
    const caption = toFontSafeText(this.label.badgeCaption);
    const captionSize = 5.6;
    const width = Math.max(34, this.width(caption, captionSize) + 4);
    const height = 21;
    return {
      width,
      height,
      letterSize: 11.5,
      caption,
      captionSize,
      totalHeight: height + captionSize + 4
    };
  }

  // ── Inline layout ─────────────────────────────────────────────────────

  /**
   * Word-wrap styled segments into lines.
   *
   * @param {Array<Object>} segments - see `markdown.inlineSegments`
   * @param {{width: number, size: number, baseStyle?: Object}} options
   * @returns {Array<{pieces: Array<{text: string, width: number, style: Object}>, width: number}>}
   */
  layoutInline(segments, { width, size, baseStyle = {} }) {
    const words = [];
    let current = null;
    let pendingSpace = false;
    for (const segment of segments) {
      if (segment.br) {
        if (current) words.push(current);
        current = null;
        pendingSpace = false;
        words.push({ br: true });
        continue;
      }
      const style = {
        bold: Boolean(segment.bold || baseStyle.bold),
        italic: Boolean(segment.italic || baseStyle.italic),
        code: Boolean(segment.code),
        strike: Boolean(segment.strike),
        link: segment.link && isSafeLinkTarget(segment.link) ? segment.link : ''
      };
      const text = toFontSafeText(String(segment.text || '').replace(/[\t\r\n]+/g, ' '));
      for (const part of text.split(/( +)/)) {
        if (!part) continue;
        if (part[0] === ' ') {
          if (current) words.push(current);
          current = null;
          pendingSpace = true;
          continue;
        }
        if (!current) {
          current = { parts: [], spaceBefore: pendingSpace };
          pendingSpace = false;
        }
        current.parts.push({ text: part, style });
      }
    }
    if (current) words.push(current);

    const spaceWidth = this.width(' ', size);
    const lines = [];
    let line = { pieces: [], width: 0 };
    const pushLine = () => {
      lines.push(line);
      line = { pieces: [], width: 0 };
    };
    const appendChar = (char, charWidth, style) => {
      const last = line.pieces[line.pieces.length - 1];
      if (last && last.text !== ' ' && styleKey(last.style) === styleKey(style)) {
        last.text += char;
        last.width += charWidth;
      } else {
        line.pieces.push({ text: char, width: charWidth, style });
      }
      line.width += charWidth;
    };

    for (const word of words) {
      if (word.br) {
        pushLine();
        continue;
      }
      const parts = word.parts.map(part => ({ ...part, width: this.width(part.text, size) }));
      const wordWidth = parts.reduce((sum, part) => sum + part.width, 0);
      const spaceNeeded = word.spaceBefore && line.pieces.length > 0 ? spaceWidth : 0;
      if (line.pieces.length > 0 && line.width + spaceNeeded + wordWidth > width) pushLine();
      if (word.spaceBefore && line.pieces.length > 0) {
        const previous = line.pieces[line.pieces.length - 1];
        const sameStyle = styleKey(previous.style) === styleKey(parts[0].style);
        line.pieces.push({
          text: ' ',
          width: spaceWidth,
          style: sameStyle ? previous.style : PLAIN_STYLE
        });
        line.width += spaceWidth;
      }
      if (wordWidth <= width - line.width) {
        line.pieces.push(...parts);
        line.width += wordWidth;
        continue;
      }
      // A word longer than the line (URL, hash, ...) is broken anywhere.
      for (const part of parts) {
        for (const char of part.text) {
          const charWidth = this.width(char, size);
          if (line.pieces.length > 0 && line.width + charWidth > width) pushLine();
          appendChar(char, charWidth, part.style);
        }
      }
    }
    if (line.pieces.length > 0) lines.push(line);
    return lines.map(mergePieces);
  }

  /**
   * Draw one laid-out line at a baseline.
   * @param {{pieces: Array, width: number}} line
   * @param {{x: number, width: number, baseline: number, size: number, color: Object, align?: string}} options
   */
  drawLineAt(line, { x, width, baseline, size, color, align = 'left' }) {
    let cursor = x;
    if (align === 'center') cursor += Math.max(0, (width - line.width) / 2);
    else if (align === 'right') cursor += Math.max(0, width - line.width);
    for (const piece of line.pieces) {
      const { style } = piece;
      const pieceColor = style.code ? this.theme.codeText : style.link ? this.theme.link : color;
      if (style.code && piece.text.trim()) {
        this.page.drawRectangle({
          x: cursor - 1,
          y: baseline - size * 0.26,
          width: piece.width + 2,
          height: size * 1.14,
          color: this.theme.codeBg
        });
      }
      this.drawText(piece.text, {
        x: cursor,
        y: baseline,
        size,
        color: pieceColor,
        bold: style.bold,
        italic: style.italic
      });
      if (style.link) {
        this.page.drawLine({
          start: { x: cursor, y: baseline - size * 0.13 },
          end: { x: cursor + piece.width, y: baseline - size * 0.13 },
          thickness: 0.5,
          color: pieceColor
        });
        this.addLinkAnnotation(
          this.page,
          cursor,
          baseline - size * 0.28,
          piece.width,
          size * 1.2,
          style.link
        );
      }
      if (style.strike) {
        this.page.drawLine({
          start: { x: cursor, y: baseline + size * 0.3 },
          end: { x: cursor + piece.width, y: baseline + size * 0.3 },
          thickness: 0.6,
          color: pieceColor
        });
      }
      cursor += piece.width;
    }
  }

  /**
   * Draw laid-out lines from the current position, breaking pages as needed.
   * @param {Array} lines - from `layoutInline`
   * @param {{x: number, width: number, size: number, color: Object, align?: string, lineHeight?: number}} options
   */
  drawLines(lines, { x, width, size, color, align = 'left', lineHeight = size * LINE_FACTOR }) {
    for (const line of lines) {
      this.ensure(lineHeight);
      const baseline = this.y - lineHeight / 2 - size * 0.3;
      this.drawLineAt(line, { x, width, baseline, size, color, align });
      this.y -= lineHeight;
      this.trailingGap = 0;
    }
  }

  /**
   * Lay out and draw plain text in one style.
   * @param {string} text
   * @param {{x: number, width: number, size: number, color: Object, bold?: boolean, italic?: boolean, lineHeight?: number}} options
   */
  drawParagraphText(text, options) {
    const lines = this.layoutInline(
      [{ text, bold: options.bold, italic: options.italic }],
      options
    );
    this.drawLines(lines, options);
  }

  // ── Document furniture ────────────────────────────────────────────────

  /** Title, app name, "Exported on …" and a rule; first page only. */
  renderDocumentHeader(exportedOn) {
    const { doc, theme } = this;
    this.drawParagraphText(doc.title, {
      x: MARGIN_X,
      width: CONTENT_WIDTH,
      size: 18,
      color: theme.title,
      bold: true,
      lineHeight: 18 * 1.25
    });
    if (doc.appName && doc.appName !== doc.title) {
      this.y -= 2;
      this.drawParagraphText(doc.appName, {
        x: MARGIN_X,
        width: CONTENT_WIDTH,
        size: 11.5,
        color: theme.subtitle
      });
    }
    this.drawParagraphText(exportedOn, {
      x: MARGIN_X,
      width: CONTENT_WIDTH,
      size: 9,
      color: theme.muted
    });
    this.y -= 8;
    this.page.drawLine({
      start: { x: MARGIN_X, y: this.y },
      end: { x: MARGIN_X + CONTENT_WIDTH, y: this.y },
      thickness: 1.2,
      color: theme.rule
    });
    this.y -= 16;
  }

  /** The visible AI label: badge, label text, human-review / canvas notes. */
  renderLabelBox() {
    const { label, theme } = this;
    if (!label.show) return;
    const pad = 10;
    const badge = label.euIcon ? this.badgeMetrics() : null;
    const textX = MARGIN_X + pad + (badge ? badge.width + 12 : 0);
    const textWidth = MARGIN_X + CONTENT_WIDTH - pad - textX;
    const mainSize = 10.5;
    const detailSize = 9;
    const mainLines = this.layoutInline([{ text: label.text }], {
      width: textWidth,
      size: mainSize,
      baseStyle: { bold: true }
    });
    const detailLines = label.details.flatMap(detail =>
      this.layoutInline([{ text: detail }], { width: textWidth, size: detailSize })
    );
    const mainHeight = mainLines.length * mainSize * 1.35;
    const detailHeight = detailLines.length ? 3 + detailLines.length * detailSize * 1.35 : 0;
    const textHeight = mainHeight + detailHeight;
    const innerHeight = Math.max(textHeight, badge ? badge.totalHeight : 0);
    const boxHeight = innerHeight + 2 * pad;
    this.ensure(boxHeight);
    const top = this.y;
    this.page.drawRectangle({
      x: MARGIN_X,
      y: top - boxHeight,
      width: CONTENT_WIDTH,
      height: boxHeight,
      ...(theme.labelBg ? { color: theme.labelBg } : {}),
      ...(theme.labelBorder ? { borderColor: theme.labelBorder, borderWidth: 0.75 } : {})
    });
    if (badge) {
      this.drawBadge(
        this.page,
        MARGIN_X + pad,
        top - pad - (innerHeight - badge.totalHeight) / 2,
        badge
      );
    }
    this.y = top - pad - (innerHeight - textHeight) / 2;
    this.drawLines(mainLines, {
      x: textX,
      width: textWidth,
      size: mainSize,
      color: theme.labelText,
      lineHeight: mainSize * 1.35
    });
    if (detailLines.length) {
      this.y -= 3;
      this.drawLines(detailLines, {
        x: textX,
        width: textWidth,
        size: detailSize,
        color: theme.labelDetail,
        lineHeight: detailSize * 1.35
      });
    }
    this.y = top - boxHeight;
    this.trailingGap = 0;
    this.y -= 14;
  }

  /**
   * The settings block (model, temperature, style, output format, variables).
   * @param {Array<[string, string]>} rows
   * @param {string} heading
   */
  renderSettings(rows, heading) {
    if (!rows.length) return;
    const { theme } = this;
    const pad = 10;
    const size = 9.5;
    const lineHeight = size * 1.4;
    const headingSize = 11;
    const innerWidth = CONTENT_WIDTH - 2 * pad;
    const lines = rows.flatMap(([name, value]) =>
      this.layoutInline([{ text: `${name}: `, bold: true }, { text: value }], {
        width: innerWidth,
        size
      })
    );
    const boxHeight = headingSize * 1.4 + 4 + lines.length * lineHeight + 2 * pad;
    const fitsOnPage = boxHeight <= CONTENT_HEIGHT;
    if (fitsOnPage) this.ensure(boxHeight);
    const top = this.y;
    if (fitsOnPage && (theme.settingsBg || theme.settingsBorder)) {
      this.page.drawRectangle({
        x: MARGIN_X,
        y: top - boxHeight,
        width: CONTENT_WIDTH,
        height: boxHeight,
        ...(theme.settingsBg ? { color: theme.settingsBg } : {}),
        ...(theme.settingsBorder ? { borderColor: theme.settingsBorder, borderWidth: 0.75 } : {})
      });
    }
    this.y -= pad;
    this.drawParagraphText(heading, {
      x: MARGIN_X + pad,
      width: innerWidth,
      size: headingSize,
      color: theme.heading,
      bold: true,
      lineHeight: headingSize * 1.4
    });
    this.y -= 4;
    this.drawLines(lines, {
      x: MARGIN_X + pad,
      width: innerWidth,
      size,
      color: theme.subtitle,
      lineHeight
    });
    if (fitsOnPage) this.y = top - boxHeight;
    this.trailingGap = 0;
    this.y -= 16;
  }

  /** Title and a small "AI" badge at the top of pages 2+. */
  drawRunningHeader() {
    const { theme, label } = this;
    const size = 8;
    const baseline = PAGE_HEIGHT - 34;
    let right = MARGIN_X + CONTENT_WIDTH;
    if (label.euIcon) {
      const metrics = { width: 20, height: 12, letterSize: 7 };
      this.drawBadge(this.page, right - metrics.width, baseline + 9, metrics);
      right -= metrics.width + 8;
    }
    const title = this.truncate(toFontSafeText(this.doc.title), right - MARGIN_X, size);
    this.drawText(title, { x: MARGIN_X, y: baseline, size, color: theme.muted });
    this.page.drawLine({
      start: { x: MARGIN_X, y: PAGE_HEIGHT - 42 },
      end: { x: MARGIN_X + CONTENT_WIDTH, y: PAGE_HEIGHT - 42 },
      thickness: 0.5,
      color: theme.rule
    });
  }

  /** Footer on every page: label text (or app name) and "n / N". */
  drawFooters() {
    const { theme, label, t } = this;
    const size = 7.5;
    const baseline = 30;
    const total = this.pages.length;
    const leftText = toFontSafeText(label.show ? label.text : this.doc.appName);
    this.pages.forEach((page, index) => {
      page.drawLine({
        start: { x: MARGIN_X, y: 44 },
        end: { x: MARGIN_X + CONTENT_WIDTH, y: 44 },
        thickness: 0.5,
        color: theme.rule
      });
      const pageText = toFontSafeText(t('export.footer.page', { current: index + 1, total }));
      const pageWidth = this.width(pageText, size);
      this.drawText(pageText, {
        page,
        x: MARGIN_X + CONTENT_WIDTH - pageWidth,
        y: baseline,
        size,
        color: theme.muted
      });
      const left = this.truncate(leftText, CONTENT_WIDTH - pageWidth - 16, size);
      this.drawText(left, { page, x: MARGIN_X, y: baseline, size, color: theme.muted });
    });
  }

  // ── Messages ──────────────────────────────────────────────────────────

  /**
   * One chat message: role band, verification marker, markdown body.
   * @param {Object} message - normalised message
   */
  renderMessage(message) {
    const { theme, t, doc } = this;
    const roleTheme = theme.roles[message.role] || theme.roles.assistant;
    const bandHeight = 20;
    const roleSize = 10;
    const metaSize = 8.5;
    this.ensure(bandHeight + BODY_SIZE * LINE_FACTOR * 2);
    const start = this.startPosition();
    const innerX = MARGIN_X + (roleTheme.accent ? 12 : 0);
    const innerRight = MARGIN_X + CONTENT_WIDTH - (roleTheme.band ? 8 : 0);
    const innerWidth = innerRight - innerX;
    if (roleTheme.band) {
      this.page.drawRectangle({
        x: MARGIN_X,
        y: this.y - bandHeight,
        width: CONTENT_WIDTH,
        height: bandHeight,
        color: roleTheme.band
      });
    }
    const baseline = this.y - bandHeight / 2 - roleSize * 0.35;
    const role = toFontSafeText(roleLabel(message.role, t));
    this.drawText(role, {
      x: innerX,
      y: baseline,
      size: roleSize,
      color: roleTheme.text,
      bold: true
    });
    const timestamp = toFontSafeText(formatDateTime(message.timestamp, doc.language));
    const timestampWidth = timestamp ? this.width(timestamp, metaSize) : 0;
    if (timestamp) {
      this.drawText(timestamp, {
        x: innerRight - timestampWidth,
        y: baseline,
        size: metaSize,
        color: theme.muted
      });
    }
    if (message.model) {
      const modelX = innerX + this.width(role, roleSize) + 6;
      const available = innerRight - timestampWidth - 12 - modelX;
      if (available > 20) {
        const model = this.truncate(toFontSafeText(`· ${message.model}`), available, metaSize);
        this.drawText(model, { x: modelX, y: baseline, size: metaSize, color: theme.muted });
      }
    }
    this.y -= bandHeight;
    const marker = getVerificationMarker(message, t);
    if (marker) {
      this.y -= 4;
      this.drawParagraphText(marker.text, {
        x: innerX,
        width: innerWidth,
        size: 8,
        italic: true,
        color: marker.kind === 'warning' ? theme.warning : theme.verified,
        lineHeight: 8 * 1.4
      });
    }
    this.y -= 8;
    this.renderBlocks(lexMarkdown(message.content), {
      x: innerX,
      width: innerWidth,
      size: BODY_SIZE,
      color: theme.text,
      listDepth: 0
    });
    const end = this.endPosition();
    end.y -= 2;
    if (roleTheme.accent) this.drawSpanBar(start, end, MARGIN_X, 3, roleTheme.accent);
    // `end` is on the current page: continue right below the text.
    this.y = end.y;
    this.trailingGap = 0;
    if (theme.messageRule && this.y - 6 > MARGIN_BOTTOM) {
      this.y -= 6;
      this.page.drawLine({
        start: { x: MARGIN_X, y: this.y },
        end: { x: MARGIN_X + CONTENT_WIDTH, y: this.y },
        thickness: 0.75,
        color: theme.messageRule
      });
    }
    this.gap(18);
  }

  /**
   * One-document sources and single-message exports: meta line and body
   * without "User / Assistant" framing.
   * @param {Array<Object>} messages - normalised messages
   */
  renderDocumentBody(messages) {
    const { theme, t, doc } = this;
    messages.forEach((message, position) => {
      if (position > 0) {
        this.ensure(20);
        this.y -= 6;
        this.page.drawLine({
          start: { x: MARGIN_X, y: this.y },
          end: { x: MARGIN_X + CONTENT_WIDTH, y: this.y },
          thickness: 0.75,
          color: theme.rule
        });
        this.y -= 14;
      }
      const meta = [formatDateTime(message.timestamp, doc.language), message.model]
        .filter(Boolean)
        .join(' · ');
      if (meta) {
        this.drawParagraphText(meta, {
          x: MARGIN_X,
          width: CONTENT_WIDTH,
          size: 8.5,
          color: theme.muted
        });
      }
      const marker = getDocumentMarker(doc, message, t);
      if (marker) {
        this.drawParagraphText(marker.text, {
          x: MARGIN_X,
          width: CONTENT_WIDTH,
          size: 8,
          italic: true,
          color: marker.kind === 'warning' ? theme.warning : theme.verified,
          lineHeight: 8 * 1.4
        });
      }
      if (meta || marker) this.y -= 8;
      this.renderBlocks(lexMarkdown(message.content), {
        x: MARGIN_X,
        width: CONTENT_WIDTH,
        size: BODY_SIZE,
        color: theme.text,
        listDepth: 0
      });
    });
  }

  // ── Markdown blocks ───────────────────────────────────────────────────

  /**
   * @param {Array<Object>} tokens - marked block tokens
   * @param {{x: number, width: number, size: number, color: Object, listDepth: number}} ctx
   */
  renderBlocks(tokens, ctx) {
    for (const token of tokens || []) this.renderBlock(token, ctx);
  }

  /**
   * @param {Object} token - one marked block token
   * @param {Object} ctx - see `renderBlocks`
   */
  renderBlock(token, ctx) {
    const { theme } = this;
    switch (token.type) {
      case 'space':
      case 'def':
        return;
      case 'heading': {
        const size = HEADING_SIZES[Math.min(Math.max(token.depth || 1, 1), 6) - 1];
        const lineHeight = size * 1.3;
        const lines = this.layoutInline(blockSegments(token, this.segmentOptions), {
          width: ctx.width,
          size,
          baseStyle: { bold: true }
        });
        this.gap(size * 0.7);
        // Keep the heading together with the first line that follows it.
        this.ensure(lines.length * lineHeight + ctx.size * LINE_FACTOR * 1.5);
        this.drawLines(lines, {
          x: ctx.x,
          width: ctx.width,
          size,
          color: theme.heading,
          lineHeight
        });
        this.gap(size * 0.35);
        return;
      }
      case 'paragraph': {
        const lines = this.layoutInline(blockSegments(token, this.segmentOptions), ctx);
        this.drawLines(lines, ctx);
        this.gap(ctx.size * 0.65);
        return;
      }
      case 'text': {
        const lines = this.layoutInline(blockSegments(token, this.segmentOptions), ctx);
        this.drawLines(lines, ctx);
        return;
      }
      case 'list':
        this.renderList(token, ctx);
        return;
      case 'code':
        this.renderCode(token, ctx);
        return;
      case 'blockquote':
        this.renderQuote(token, ctx);
        return;
      case 'table':
        this.renderTable(token, ctx);
        return;
      case 'hr': {
        this.ensure(14);
        this.y -= 6;
        this.page.drawLine({
          start: { x: ctx.x, y: this.y },
          end: { x: ctx.x + ctx.width, y: this.y },
          thickness: 1,
          color: theme.rule
        });
        this.y -= 8;
        this.trailingGap = 0;
        return;
      }
      case 'html': {
        const text = stripHtmlTags(token.text);
        if (!text) return;
        const segments = [];
        text.split('\n').forEach((part, index) => {
          if (index > 0) segments.push({ text: '', br: true });
          segments.push({ text: part });
        });
        this.drawLines(this.layoutInline(segments, ctx), { ...ctx, color: theme.muted });
        this.gap(ctx.size * 0.65);
        return;
      }
      default:
        if (Array.isArray(token.tokens) && token.type !== 'text') {
          this.renderBlocks(token.tokens, ctx);
        } else if (typeof token.text === 'string' && token.text.trim()) {
          this.drawLines(this.layoutInline(blockSegments(token, this.segmentOptions), ctx), ctx);
          this.gap(ctx.size * 0.65);
        }
    }
  }

  /**
   * Bulleted, numbered and task lists, nested by indentation.
   * @param {Object} token - marked list token
   * @param {Object} ctx
   */
  renderList(token, ctx) {
    const depth = ctx.listDepth || 0;
    const startNumber =
      token.ordered && token.start !== '' && Number.isFinite(Number(token.start))
        ? Number(token.start)
        : 1;
    const markers = (token.items || []).map((item, index) => {
      if (item.task) return item.checked ? '[x]' : '[ ]';
      return token.ordered ? `${startNumber + index}.` : LIST_BULLETS[depth % LIST_BULLETS.length];
    });
    const markerWidth = Math.max(0, ...markers.map(marker => this.width(marker, ctx.size)));
    const indent = Math.max(14, markerWidth + 7);
    const lineHeight = ctx.size * LINE_FACTOR;
    (token.items || []).forEach((item, index) => {
      this.ensure(lineHeight);
      const top = this.y;
      const pageIndex = this.pages.length - 1;
      const marker = markers[index];
      this.drawText(marker, {
        x: ctx.x + indent - 5 - this.width(marker, ctx.size),
        y: top - lineHeight / 2 - ctx.size * 0.3,
        size: ctx.size,
        color: ctx.color
      });
      const itemTokens = (item.tokens || []).filter(child => child.type !== 'checkbox');
      this.renderBlocks(itemTokens, {
        ...ctx,
        x: ctx.x + indent,
        width: ctx.width - indent,
        listDepth: depth + 1
      });
      if (this.y === top && this.pages.length - 1 === pageIndex) {
        this.y -= lineHeight;
        this.trailingGap = 0;
      }
    });
    this.gap(depth === 0 ? ctx.size * 0.65 : ctx.size * 0.15);
  }

  /**
   * Break a line anywhere so it fits (code is not word-wrapped).
   * @param {string} text - font-safe text
   * @param {number} maxWidth
   * @param {number} size
   * @returns {string[]}
   */
  wrapChars(text, maxWidth, size) {
    if (!text || this.width(text, size) <= maxWidth) return [text];
    const out = [];
    let current = '';
    let currentWidth = 0;
    for (const char of text) {
      const charWidth = this.width(char, size);
      if (current && currentWidth + charWidth > maxWidth) {
        out.push(current);
        current = '';
        currentWidth = 0;
      }
      current += char;
      currentWidth += charWidth;
    }
    if (current) out.push(current);
    return out;
  }

  /**
   * Fenced / indented code in a shaded box, split across pages.
   * @param {Object} token - marked code token
   * @param {Object} ctx
   */
  renderCode(token, ctx) {
    const { theme } = this;
    const size = Math.max(7.5, ctx.size - 1.5);
    const lineHeight = size * 1.38;
    const pad = 6;
    const innerWidth = ctx.width - 2 * pad;
    const lines = [];
    for (const raw of String(token.text || '')
      .replace(/\t/g, '    ')
      .split('\n')) {
      lines.push(...this.wrapChars(toFontSafeText(raw), innerWidth, size));
    }
    let index = 0;
    while (index < lines.length) {
      this.ensure(lineHeight + 2 * pad);
      const available = this.y - MARGIN_BOTTOM - 2 * pad;
      const count = Math.max(1, Math.min(lines.length - index, Math.floor(available / lineHeight)));
      const boxHeight = count * lineHeight + 2 * pad;
      this.page.drawRectangle({
        x: ctx.x,
        y: this.y - boxHeight,
        width: ctx.width,
        height: boxHeight,
        color: theme.codeBlockBg,
        borderColor: theme.codeBlockBorder,
        borderWidth: 0.5
      });
      let lineTop = this.y - pad;
      for (let k = 0; k < count; k++) {
        const text = lines[index + k];
        if (text && text.trim()) {
          this.drawText(text, {
            x: ctx.x + pad,
            y: lineTop - lineHeight / 2 - size * 0.3,
            size,
            color: theme.codeBlockText
          });
        }
        lineTop -= lineHeight;
      }
      this.y -= boxHeight;
      this.trailingGap = 0;
      index += count;
      if (index < lines.length) this.addPage();
    }
    this.gap(ctx.size * 0.65);
  }

  /**
   * Blockquote: indented, muted text with a bar on the left.
   * @param {Object} token - marked blockquote token
   * @param {Object} ctx
   */
  renderQuote(token, ctx) {
    const start = this.startPosition();
    this.renderBlocks(token.tokens || [], {
      ...ctx,
      x: ctx.x + 12,
      width: ctx.width - 12,
      color: this.theme.quoteText
    });
    this.drawSpanBar(start, this.endPosition(), ctx.x + 1, 2.5, this.theme.quoteBar);
  }

  /**
   * Table as a grid; the header row repeats on every page the table spans.
   * @param {Object} token - marked table token
   * @param {Object} ctx
   */
  renderTable(token, ctx) {
    const { theme } = this;
    const header = token.header || [];
    const columnCount = header.length;
    if (!columnCount) return;
    const size = Math.max(7.5, ctx.size - 1.5);
    const lineHeight = size * 1.35;
    const pad = 4;
    const headerSegments = header.map(cell => blockSegments(cell, this.segmentOptions));
    const bodySegments = (token.rows || []).map(row =>
      Array.from({ length: columnCount }, (_, c) =>
        row[c] ? blockSegments(row[c], this.segmentOptions) : []
      )
    );
    const aligns = Array.from({ length: columnCount }, (_, c) => token.align?.[c] || 'left');

    const naturalWidth = (segments, bold) => {
      let widest = 0;
      let lineText = '';
      const flush = () => {
        widest = Math.max(widest, this.width(toFontSafeText(lineText), size) * (bold ? 1.05 : 1));
        lineText = '';
      };
      for (const segment of segments) {
        if (segment.br) flush();
        else lineText += segment.text;
      }
      flush();
      return widest;
    };
    const natural = Array(columnCount).fill(24);
    [headerSegments, ...bodySegments].forEach((row, rowIndex) =>
      row.forEach((segments, c) => {
        natural[c] = Math.max(natural[c], naturalWidth(segments, rowIndex === 0) + 2 * pad);
      })
    );
    const widths = distributeColumnWidths(natural, ctx.width);
    const layoutRow = (row, isHeader) =>
      row.map((segments, c) =>
        this.layoutInline(segments, {
          width: widths[c] - 2 * pad,
          size,
          baseStyle: isHeader ? { bold: true } : {}
        })
      );
    const rowHeight = cells =>
      Math.max(1, ...cells.map(lines => lines.length)) * lineHeight + 2 * pad;
    const drawRow = (cells, height, fill) => {
      let x = ctx.x;
      const top = this.y;
      cells.forEach((lines, c) => {
        this.page.drawRectangle({
          x,
          y: top - height,
          width: widths[c],
          height,
          borderColor: theme.tableBorder,
          borderWidth: 0.5,
          ...(fill ? { color: fill } : {})
        });
        let lineTop = top - pad;
        for (const line of lines) {
          this.drawLineAt(line, {
            x: x + pad,
            width: widths[c] - 2 * pad,
            baseline: lineTop - lineHeight / 2 - size * 0.3,
            size,
            color: ctx.color,
            align: aligns[c]
          });
          lineTop -= lineHeight;
        }
        x += widths[c];
      });
      this.y = top - height;
      this.trailingGap = 0;
    };

    const headerLines = layoutRow(headerSegments, true);
    const headerHeight = rowHeight(headerLines);
    const maxRowHeight = CONTENT_HEIGHT - headerHeight - 4;
    const firstRows = bodySegments.length ? layoutRow(bodySegments[0], false) : [];
    const firstHeight = firstRows.length ? Math.min(rowHeight(firstRows), maxRowHeight) : 0;
    this.gap(2);
    this.ensure(headerHeight + firstHeight);
    drawRow(headerLines, headerHeight, theme.tableHeaderBg);
    let headerNeeded = false;
    bodySegments.forEach((row, rowIndex) => {
      const cells = rowIndex === 0 ? firstRows : layoutRow(row, false);
      const height = rowHeight(cells);
      if (height > maxRowHeight) {
        // A row taller than a page: print it as "Header: value" paragraphs.
        this.renderOversizedRow(headerSegments, row, ctx);
        headerNeeded = true;
        return;
      }
      if (this.y - height - (headerNeeded ? headerHeight : 0) < MARGIN_BOTTOM) {
        this.addPage();
        headerNeeded = true;
      }
      if (headerNeeded) {
        drawRow(headerLines, headerHeight, theme.tableHeaderBg);
        headerNeeded = false;
      }
      drawRow(cells, height, rowIndex % 2 === 1 ? theme.tableStripeBg : null);
    });
    this.gap(ctx.size * 0.8);
  }

  /**
   * Fallback for a table row that cannot fit on one page.
   * @param {Array} headerSegments
   * @param {Array} row
   * @param {Object} ctx
   */
  renderOversizedRow(headerSegments, row, ctx) {
    this.gap(4);
    row.forEach((segments, c) => {
      const label = (headerSegments[c] || []).map(segment => ({ ...segment, bold: true }));
      const lines = this.layoutInline([...label, { text: ': ', bold: true }, ...segments], ctx);
      this.drawLines(lines, ctx);
    });
    this.gap(ctx.size * 0.65);
  }
}

/**
 * Merge neighbouring pieces with the same style, so each line is drawn with
 * as few text operations as possible (and extracts as clean text).
 * @param {{pieces: Array, width: number}} line
 * @returns {{pieces: Array, width: number}}
 */
function mergePieces(line) {
  const pieces = [];
  for (const piece of line.pieces) {
    const last = pieces[pieces.length - 1];
    if (last && styleKey(last.style) === styleKey(piece.style)) {
      last.text += piece.text;
      last.width += piece.width;
    } else {
      pieces.push({ ...piece });
    }
  }
  return { pieces, width: line.width };
}

/**
 * Render the export as PDF.
 *
 * @param {Object} doc - normalised export document (see `renderExport`)
 * @returns {Promise<Buffer>} the PDF bytes
 */
export async function renderPdf(doc) {
  const { t, label, settingsRows, exportedOn } = prepareCommon(doc);
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(getFontBytes(), { subset: true });
  const writer = new PdfWriter({ pdf, font, theme: buildTheme(doc.template), t, doc, label });

  writer.renderDocumentHeader(exportedOn);
  writer.renderLabelBox();
  writer.renderSettings(
    settingsRows,
    doc.source === 'chat' ? t('export.settings.chatTitle') : t('export.settings.title')
  );
  if (isTranscript(doc)) {
    for (const message of doc.messages) writer.renderMessage(message);
  } else {
    writer.renderDocumentBody(doc.messages);
  }
  writer.drawFooters();

  const exportedAt = new Date(doc.exportedAt);
  const date = Number.isNaN(exportedAt.getTime()) ? new Date() : exportedAt;
  pdf.setTitle(doc.title, { showInWindowTitleBar: true });
  pdf.setAuthor(doc.appName);
  if (label.show) pdf.setSubject(label.text);
  pdf.setCreator(PRODUCT_NAME);
  pdf.setProducer(PRODUCT_NAME);
  pdf.setLanguage(doc.language);
  pdf.setCreationDate(date);
  pdf.setModificationDate(date);

  const bytes = await pdf.save({ useObjectStreams: false });
  return Buffer.from(bytes);
}
