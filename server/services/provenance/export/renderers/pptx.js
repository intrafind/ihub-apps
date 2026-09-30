/**
 * PPTX export renderer (`pptxgenjs`, 16:9).
 *
 * Follows the former browser export (`exportToPPTX` in
 * `client/src/utils/exportFormats.js`): a coloured title slide, one slide
 * per message and a settings slide. Additionally:
 *
 * - the title slide carries the AI label panel (rounded "AI" badge,
 *   "AI GENERATED" caption, label text, human-review / canvas notes), content
 *   slides a small "AI" badge, and every slide a footer with the label text
 *   and "n / N";
 * - long messages continue on further slides ("Assistant (continued)"):
 *   paragraph heights are estimated with Arial-compatible font metrics and
 *   tables are split by rows with the header repeated;
 * - markdown from `marked` tokens: headings, paragraphs with bold / italic /
 *   code / links, bulleted, numbered and task lists, code, quotes, tables.
 *
 * `pptxgenjs` 4 writes a paragraph-properties element before every run of a
 * multi-run paragraph, which the schema does not allow; `repairParagraphProperties`
 * keeps only the leading one so PowerPoint opens the file without a repair.
 *
 * @module services/provenance/export/renderers/pptx
 */
import PptxGenJS from 'pptxgenjs';
import JSZip from 'jszip';
import { measureText } from './fontMetrics.js';
import { blockSegments, lexMarkdown, segmentsToPlainText, stripHtmlTags } from './markdown.js';
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
  roleLabel,
  stripXmlInvalidChars
} from './common.js';

// ── Slide geometry (inches, LAYOUT_16x9 = 10 × 5.625) ───────────────────

const MARGIN_X = 0.5;
const CONTENT_W = 9;
const BODY_TOP = 1.1;
const BODY_BOTTOM = 4.95;
const BODY_HEIGHT_PT = (BODY_BOTTOM - BODY_TOP) * 72;
/** Usable text width in points: box width minus PowerPoint's default insets, with slack. */
const TEXT_WIDTH_PT = CONTENT_W * 72 - 24;
const FONT = 'Arial';
const MONO_FONT = 'Courier New';
const BODY_SIZE = 14;
const CODE_SIZE = 11;
const TABLE_SIZE = 11;
const HEADING_SIZES = [22, 19, 17, 15, 14, 14];
const LINE_FACTOR = 1.2;
/** Left margin PowerPoint adds per bullet level (pptxgenjs default), in points. */
const BULLET_INDENT_PT = 27;

const TEXT_COLOR = '111827';
const MUTED_COLOR = '6B7280';
const WARNING_COLOR = 'B45309';
const QUOTE_COLOR = '4B5563';
const CODE_COLOR = '1F2937';

const TITLE_THEMES = Object.freeze({
  default: {
    background: '4F46E5',
    text: 'FFFFFF',
    panelFill: 'FFFFFF',
    panelTransparency: 86,
    panelLine: 'C7D2FE',
    badgeFill: 'FFFFFF',
    badgeText: '4F46E5'
  },
  professional: {
    background: '343A40',
    text: 'FFFFFF',
    panelFill: 'FFFFFF',
    panelTransparency: 88,
    panelLine: 'ADB5BD',
    badgeFill: 'FFFFFF',
    badgeText: '343A40'
  },
  minimal: {
    background: 'FFFFFF',
    text: '1F2937',
    panelFill: 'F3F4F6',
    panelTransparency: 0,
    panelLine: 'D1D5DB',
    badgeFill: '111827',
    badgeText: 'FFFFFF'
  }
});

const CONTENT_BADGE_FILL = '1E3A8A';

/**
 * Keep only the leading `<a:pPr>` of each paragraph (see module docs).
 *
 * @param {Buffer} buffer - PPTX written by pptxgenjs
 * @returns {Promise<Buffer>} the repaired PPTX
 */
export async function repairParagraphProperties(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const pPr = /<a:pPr\b[^>]*?(?:\/>|>[\s\S]*?<\/a:pPr>)/g;
  const slideNames = Object.keys(zip.files).filter(name =>
    /^ppt\/slides\/slide\d+\.xml$/.test(name)
  );
  for (const name of slideNames) {
    const xml = await zip.file(name).async('string');
    const fixed = xml.replace(
      /<a:p>(<a:pPr\b[^>]*?(?:\/>|>[\s\S]*?<\/a:pPr>))?([\s\S]*?)<\/a:p>/g,
      (match, first, rest) => `<a:p>${first || ''}${rest.replace(pPr, '')}</a:p>`
    );
    if (fixed !== xml) zip.file(name, fixed);
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/**
 * Width of a run in points, for wrap estimates.
 * @param {string} text
 * @param {{fontSize: number, bold?: boolean, fontFace?: string}} options
 * @returns {number}
 */
function runWidth(text, { fontSize, bold, fontFace }) {
  if (fontFace === MONO_FONT) return Array.from(text).length * fontSize * 0.6;
  return measureText(text, fontSize) * (bold ? 1.07 : 1);
}

/**
 * Split a paragraph's runs into words (each keeps its run options).
 * @param {Object} para
 * @returns {Array<{text: string, options: Object, width: number, space: number}>}
 */
function paragraphWords(para) {
  const words = [];
  for (const run of para.runs) {
    const options = { fontSize: para.size, fontFace: para.font, ...run.options };
    for (const part of run.text.split(/(?<= )/)) {
      if (!part) continue;
      const word = part.replace(/ +$/, '');
      words.push({
        text: part,
        options: run.options,
        width: runWidth(word, options),
        space: part.length > word.length ? runWidth(' ', options) : 0
      });
    }
  }
  return words;
}

/**
 * Greedy word wrap; returns the index of the first word of every line.
 * @param {Array} words - from `paragraphWords`
 * @param {number} width - available width in points
 * @returns {number[]}
 */
function lineStarts(words, width) {
  const starts = [0];
  let lineWidth = 0;
  words.forEach((word, index) => {
    if (lineWidth > 0 && lineWidth + word.width > width) {
      starts.push(index);
      lineWidth = 0;
    }
    if (word.width > width) {
      // A word wider than the line wraps by itself over several lines.
      const extraLines = Math.ceil(word.width / width) - 1;
      for (let k = 0; k < extraLines; k++) starts.push(index);
      lineWidth = word.width - extraLines * width + word.space;
    } else {
      lineWidth += word.width + word.space;
    }
  });
  return starts;
}

/**
 * Rebuild runs from a slice of words (neighbouring words of one run merge).
 * @param {Array} words
 * @returns {Array<{text: string, options: Object}>}
 */
function wordsToRuns(words) {
  const runs = [];
  for (const word of words) {
    const last = runs[runs.length - 1];
    if (last && last.options === word.options) last.text += word.text;
    else runs.push({ text: word.text, options: word.options });
  }
  return runs;
}

/**
 * Walks markdown tokens and produces slide elements: paragraphs (with runs
 * and paragraph options) and tables.
 */
class ElementBuilder {
  /**
   * @param {Function} t - translate function
   */
  constructor(t) {
    this.segmentOptions = { imageLabel: t('export.content.image') };
    this.listCounter = 0;
  }

  /**
   * pptxgenjs runs for inline segments; line breaks split the paragraph.
   * @param {Array} segments
   * @param {Object} [base] - run options applied to every run
   * @returns {Array<Array<{text: string, options: Object}>>} one run list per line
   */
  runLines(segments, base = {}) {
    const lines = [[]];
    for (const segment of segments) {
      if (segment.br) {
        lines.push([]);
        continue;
      }
      const text = stripXmlInvalidChars(segment.text).replace(/[\r\n\t]+/g, ' ');
      if (!text) continue;
      const options = {
        ...base,
        ...(segment.bold ? { bold: true } : {}),
        ...(segment.italic ? { italic: true } : {}),
        ...(segment.strike ? { strike: 'sngStrike' } : {}),
        ...(segment.code ? { fontFace: MONO_FONT, color: CODE_COLOR } : {}),
        ...(segment.link && isSafeLinkTarget(segment.link)
          ? { hyperlink: { url: segment.link } }
          : {})
      };
      lines[lines.length - 1].push({ text, options });
    }
    return lines;
  }

  /**
   * @param {Array<{text: string, options: Object}>} runs
   * @param {Object} props - size, font, color, indent, bullet, list, spaceAfter
   * @returns {Object} a paragraph element
   */
  para(runs, props) {
    return {
      kind: 'para',
      runs: runs.length ? runs : [{ text: '', options: {} }],
      size: props.size || BODY_SIZE,
      font: props.font || FONT,
      color: props.color || TEXT_COLOR,
      indentLevel: props.indentLevel || 0,
      bullet: props.bullet || null,
      list: props.list || null,
      spaceAfter: props.spaceAfter ?? 4
    };
  }

  /**
   * Paragraphs for inline content, one per hard line break.
   * @param {Array} segments
   * @param {Object} props - see `para`
   * @param {Object} [base] - run options
   * @returns {Object[]}
   */
  inlineParas(segments, props, base = {}) {
    const lines = this.runLines(segments, base);
    return lines.map((runs, index) =>
      this.para(runs, {
        ...props,
        ...(index > 0 ? { bullet: null, list: null } : {}),
        spaceAfter: index === lines.length - 1 ? props.spaceAfter : 0
      })
    );
  }

  /**
   * @param {Array<Object>} tokens - marked block tokens
   * @param {{listDepth?: number, quote?: boolean}} [ctx]
   * @returns {Object[]} slide elements
   */
  elements(tokens, ctx = {}) {
    const out = [];
    for (const token of tokens || []) out.push(...this.element(token, ctx));
    return out;
  }

  /**
   * @param {Object} token
   * @param {Object} ctx
   * @returns {Object[]}
   */
  element(token, ctx) {
    const base = ctx.quote ? { italic: true, color: QUOTE_COLOR } : {};
    const color = ctx.quote ? QUOTE_COLOR : TEXT_COLOR;
    switch (token.type) {
      case 'space':
      case 'def':
      case 'hr':
        return [];
      case 'heading': {
        const size = HEADING_SIZES[Math.min(Math.max(token.depth || 1, 1), 6) - 1];
        return this.inlineParas(
          blockSegments(token, this.segmentOptions),
          { size, color, spaceAfter: 6 },
          { ...base, bold: true }
        );
      }
      case 'paragraph':
      case 'text':
        return this.inlineParas(
          blockSegments(token, this.segmentOptions),
          { color, spaceAfter: token.type === 'paragraph' ? 8 : 2 },
          base
        );
      case 'list':
        return this.list(token, ctx);
      case 'code': {
        const lines = String(token.text || '')
          .replace(/\t/g, '    ')
          .split('\n');
        return lines.map((line, index) =>
          this.para([{ text: stripXmlInvalidChars(line), options: {} }], {
            size: CODE_SIZE,
            font: MONO_FONT,
            color: CODE_COLOR,
            spaceAfter: index === lines.length - 1 ? 8 : 0
          })
        );
      }
      case 'blockquote':
        return this.elements(token.tokens, { ...ctx, quote: true });
      case 'table':
        return [this.table(token)];
      case 'html': {
        const text = stripHtmlTags(token.text);
        return text
          ? this.inlineParas([{ text }], { color: MUTED_COLOR, spaceAfter: 8 }, base)
          : [];
      }
      default:
        if (Array.isArray(token.tokens) && token.type !== 'text') {
          return this.elements(token.tokens, ctx);
        }
        return typeof token.text === 'string' && token.text.trim()
          ? this.inlineParas(blockSegments(token, this.segmentOptions), { color }, base)
          : [];
    }
  }

  /**
   * Lists become bulleted / auto-numbered paragraphs by indent level.
   * @param {Object} token
   * @param {Object} ctx
   * @returns {Object[]}
   */
  list(token, ctx) {
    const depth = Math.min(ctx.listDepth || 0, 8);
    const listId = ++this.listCounter;
    const start =
      token.ordered && token.start !== '' && Number.isInteger(Number(token.start))
        ? Number(token.start)
        : 1;
    const out = [];
    (token.items || []).forEach((item, index) => {
      const children = (item.tokens || []).filter(child => child.type !== 'checkbox');
      const [first, ...rest] = children;
      const firstIsText = first && (first.type === 'text' || first.type === 'paragraph');
      const segments = [
        ...(item.task ? [{ text: item.checked ? '☑ ' : '☐ ' }] : []),
        ...(firstIsText ? blockSegments(first, this.segmentOptions) : [])
      ];
      out.push(
        ...this.inlineParas(
          segments,
          {
            color: ctx.quote ? QUOTE_COLOR : TEXT_COLOR,
            indentLevel: depth,
            // A task item's checkbox is its marker.
            bullet: item.task ? null : token.ordered ? { type: 'number' } : true,
            list: token.ordered && !item.task ? { id: listId, number: start + index } : null,
            spaceAfter: 2
          },
          ctx.quote ? { italic: true, color: QUOTE_COLOR } : {}
        )
      );
      for (const child of firstIsText ? rest : children) {
        out.push(...this.element(child, { ...ctx, listDepth: depth + 1 }));
      }
    });
    if (out.length && depth === 0) out[out.length - 1].spaceAfter = 8;
    return out;
  }

  /**
   * @param {Object} token - marked table token
   * @returns {Object} table element with estimated row heights
   */
  table(token) {
    const header = token.header || [];
    const columnCount = Math.max(1, header.length);
    const cellText = cell =>
      stripXmlInvalidChars(
        segmentsToPlainText(cell ? blockSegments(cell, this.segmentOptions) : [])
      ).replace(/\t/g, ' ');
    const headerTexts = Array.from({ length: columnCount }, (_, c) => cellText(header[c]));
    const bodyTexts = (token.rows || []).map(row =>
      Array.from({ length: columnCount }, (_, c) => cellText(row[c]))
    );
    const natural = Array(columnCount).fill(40);
    [headerTexts, ...bodyTexts].forEach((row, rowIndex) =>
      row.forEach((text, c) => {
        const widest = Math.max(
          0,
          ...text
            .split('\n')
            .map(line => runWidth(line, { fontSize: TABLE_SIZE, bold: rowIndex === 0 }))
        );
        natural[c] = Math.max(natural[c], widest + 16);
      })
    );
    const widthsPt = distributeColumnWidths(natural, CONTENT_W * 72);
    const rowHeight = (texts, bold) => {
      const lines = texts.map((text, c) =>
        text.split('\n').reduce((sum, line) => {
          const para = { runs: [{ text: line, options: bold ? { bold: true } : {} }] };
          para.size = TABLE_SIZE;
          para.font = FONT;
          return sum + lineStarts(paragraphWords(para), Math.max(20, widthsPt[c] - 16)).length;
        }, 0)
      );
      return Math.max(1, ...lines) * TABLE_SIZE * LINE_FACTOR + 10;
    };
    return {
      kind: 'table',
      header: headerTexts,
      rows: bodyTexts.map(texts => ({ texts, height: rowHeight(texts, false) })),
      headerHeight: rowHeight(headerTexts, true),
      aligns: Array.from({ length: columnCount }, (_, c) => token.align?.[c] || 'left'),
      colW: widthsPt.map(width => width / 72)
    };
  }
}

/**
 * Estimated height of a paragraph in points.
 * @param {Object} para
 * @returns {number}
 */
function paraHeight(para) {
  return paraLineCount(para) * para.size * LINE_FACTOR + para.spaceAfter;
}

function paraWidth(para) {
  return (
    TEXT_WIDTH_PT -
    (para.bullet || para.indentLevel ? BULLET_INDENT_PT * (para.indentLevel + 1) : 0)
  );
}

function paraLineCount(para) {
  return lineStarts(paragraphWords(para), paraWidth(para)).length;
}

/**
 * Split a paragraph after `maxLines` lines.
 * @param {Object} para
 * @param {number} maxLines
 * @returns {[Object|null, Object|null]} the part that fits and the rest
 */
function splitPara(para, maxLines) {
  const words = paragraphWords(para);
  const starts = lineStarts(words, paraWidth(para));
  if (starts.length <= maxLines) return [para, null];
  const cut = starts[maxLines];
  // No word boundary to cut at (one huge word): keep it whole so the flow advances.
  if (cut <= 0) return [para, null];
  return [
    { ...para, runs: wordsToRuns(words.slice(0, cut)), spaceAfter: 0 },
    { ...para, runs: wordsToRuns(words.slice(cut)), bullet: null, list: null }
  ];
}

/**
 * Builds the deck; remembers every slide so footers can say "n / N".
 */
class DeckBuilder {
  /**
   * @param {Object} params
   * @param {PptxGenJS} params.pres
   * @param {Function} params.t
   * @param {Object} params.doc - normalised export document
   * @param {Object} params.label - see `getLabelInfo`
   */
  constructor({ pres, t, doc, label }) {
    this.pres = pres;
    this.t = t;
    this.doc = doc;
    this.label = label;
    this.slides = [];
    this.titleTheme = TITLE_THEMES[doc.template] || TITLE_THEMES.default;
  }

  /**
   * Rounded "AI" badge shape with text.
   * @param {Object} slide
   * @param {{x: number, y: number, w: number, h: number, fontSize: number, fill: string, color: string}} box
   */
  badge(slide, { x, y, w, h, fontSize, fill, color }) {
    slide.addText(AI_BADGE_LETTERS, {
      shape: this.pres.ShapeType.roundRect,
      x,
      y,
      w,
      h,
      rectRadius: Math.min(w, h) * 0.22,
      fill: { color: fill },
      line: { color: fill, width: 0 },
      color,
      bold: true,
      fontSize,
      fontFace: FONT,
      align: 'center',
      valign: 'middle',
      margin: 0,
      altText: this.t('export.label.badgeAlt')
    });
  }

  /** Title slide with the AI label panel. */
  titleSlide(exportedOn) {
    const { doc, label, titleTheme: theme } = this;
    const slide = this.pres.addSlide();
    this.slides.push(slide);
    slide.background = { color: theme.background };
    slide.addText(stripXmlInvalidChars(doc.title), {
      x: MARGIN_X,
      y: 0.55,
      w: CONTENT_W,
      h: 1.35,
      fontSize: 32,
      bold: true,
      color: theme.text,
      fontFace: FONT,
      align: 'center',
      valign: 'middle',
      fit: 'shrink'
    });
    slide.addText(stripXmlInvalidChars(doc.appName), {
      x: MARGIN_X,
      y: 1.95,
      w: CONTENT_W,
      h: 0.45,
      fontSize: 18,
      color: theme.text,
      fontFace: FONT,
      align: 'center'
    });
    slide.addText(exportedOn, {
      x: MARGIN_X,
      y: 2.4,
      w: CONTENT_W,
      h: 0.4,
      fontSize: 13,
      color: theme.text,
      fontFace: FONT,
      align: 'center'
    });
    if (!label.show) return;
    slide.addShape(this.pres.ShapeType.roundRect, {
      x: 1,
      y: 3.1,
      w: 8,
      h: 1.5,
      rectRadius: 0.12,
      fill: { color: theme.panelFill, transparency: theme.panelTransparency },
      line: { color: theme.panelLine, width: 0.75 }
    });
    if (label.euIcon) {
      this.badge(slide, {
        x: 1.3,
        y: 3.35,
        w: 0.8,
        h: 0.52,
        fontSize: 18,
        fill: theme.badgeFill,
        color: theme.badgeText
      });
      slide.addText(stripXmlInvalidChars(label.badgeCaption), {
        x: 1.1,
        y: 3.9,
        w: 1.2,
        h: 0.25,
        fontSize: 7,
        bold: true,
        color: theme.text,
        fontFace: FONT,
        align: 'center',
        margin: 0
      });
    }
    const lines = [label.text, ...label.details];
    slide.addText(
      lines.map((line, index) => ({
        text: stripXmlInvalidChars(line),
        options: {
          bold: index === 0,
          fontSize: index === 0 ? 15 : 11,
          align: 'left',
          breakLine: index < lines.length - 1
        }
      })),
      {
        x: label.euIcon ? 2.5 : 1.3,
        y: 3.2,
        w: label.euIcon ? 6.3 : 7.5,
        h: 1.3,
        color: theme.text,
        fontFace: FONT,
        valign: 'middle'
      }
    );
  }

  /**
   * A content slide with its title, meta line and badge.
   * @param {{title: string, meta?: string, marker?: Object|null, background?: string}} header
   * @returns {Object} the slide
   */
  contentSlide({ title, meta, marker, background }) {
    const slide = this.pres.addSlide();
    this.slides.push(slide);
    slide.background = { color: background || 'FFFFFF' };
    const titleWidth = this.label.euIcon ? CONTENT_W - 0.8 : CONTENT_W;
    slide.addText(stripXmlInvalidChars(title), {
      x: MARGIN_X,
      y: 0.22,
      w: titleWidth,
      h: 0.5,
      fontSize: 22,
      bold: true,
      color: '1F2937',
      fontFace: FONT,
      fit: 'shrink'
    });
    if (this.label.euIcon) {
      this.badge(slide, {
        x: MARGIN_X + CONTENT_W - 0.55,
        y: 0.3,
        w: 0.55,
        h: 0.34,
        fontSize: 11,
        fill: CONTENT_BADGE_FILL,
        color: 'FFFFFF'
      });
    }
    const metaRuns = [];
    if (meta) metaRuns.push({ text: stripXmlInvalidChars(meta), options: { color: MUTED_COLOR } });
    if (marker) {
      metaRuns.push({
        text: `${meta ? '  ·  ' : ''}${marker.text}`,
        options: { color: marker.kind === 'warning' ? WARNING_COLOR : MUTED_COLOR }
      });
    }
    if (metaRuns.length) {
      slide.addText(
        metaRuns.map(run => ({ ...run, options: { ...run.options, align: 'left' } })),
        { x: MARGIN_X, y: 0.7, w: CONTENT_W, h: 0.3, fontSize: 11, italic: true, fontFace: FONT }
      );
    }
    return slide;
  }

  /**
   * Lay out elements over as many slides as needed.
   * @param {Object[]} elements - from `ElementBuilder`
   * @param {{title: string, meta?: string, marker?: Object|null, background?: string}} header
   */
  flow(elements, header) {
    const continued = {
      ...header,
      title: this.t('export.role.continued', { label: header.title })
    };
    let slide = this.contentSlide(header);
    let used = 0;
    let buffer = [];
    const flushText = () => {
      if (!buffer.length) return;
      const height = buffer.reduce((sum, para) => sum + paraHeight(para), 0);
      slide.addText(textObjects(buffer), {
        x: MARGIN_X,
        y: BODY_TOP + (used - height) / 72,
        w: CONTENT_W,
        h: Math.min(BODY_HEIGHT_PT, height + 6) / 72,
        valign: 'top',
        fontFace: FONT,
        fontSize: BODY_SIZE,
        color: TEXT_COLOR
      });
      buffer = [];
    };
    const nextSlide = () => {
      flushText();
      slide = this.contentSlide({ ...continued, meta: undefined, marker: null });
      used = 0;
    };

    const queue = [...elements];
    while (queue.length) {
      const element = queue.shift();
      const remaining = BODY_HEIGHT_PT - used;
      if (element.kind === 'para') {
        const height = paraHeight(element);
        if (height <= remaining) {
          buffer.push(element);
          used += height;
          continue;
        }
        const lineHeight = element.size * LINE_FACTOR;
        const linesLeft = Math.floor(remaining / lineHeight);
        if (linesLeft >= 2 || used === 0) {
          const [head, tail] = splitPara(element, Math.max(1, linesLeft));
          if (head) {
            buffer.push(head);
            used += paraHeight(head);
          }
          if (tail) queue.unshift(tail);
        } else {
          queue.unshift(element);
        }
        nextSlide();
        continue;
      }
      // table
      flushText();
      const rows = [];
      let height = element.headerHeight;
      while (element.rows.length && height + element.rows[0].height <= remaining) {
        height += element.rows[0].height;
        rows.push(element.rows.shift());
      }
      if (!rows.length && used > 0) {
        queue.unshift(element);
        nextSlide();
        continue;
      }
      if (!rows.length && element.rows.length) {
        const row = element.rows.shift();
        rows.push(row);
        height += row.height;
      }
      this.addTable(slide, element, rows, BODY_TOP + used / 72, height);
      used += height + 8;
      if (element.rows.length) {
        queue.unshift(element);
        nextSlide();
      }
    }
    flushText();
  }

  /**
   * @param {Object} slide
   * @param {Object} table - table element
   * @param {Array} rows - the rows for this slide
   * @param {number} y - inches
   * @param {number} height - points
   */
  addTable(slide, table, rows, y, height) {
    const headerRow = table.header.map((text, c) => ({
      text,
      options: { bold: true, fill: { color: 'E5E7EB' }, color: '111827', align: table.aligns[c] }
    }));
    const bodyRows = rows.map(row =>
      row.texts.map((text, c) => ({ text, options: { align: table.aligns[c] } }))
    );
    slide.addTable([headerRow, ...bodyRows], {
      x: MARGIN_X,
      y,
      w: CONTENT_W,
      colW: table.colW,
      rowH: [table.headerHeight, ...rows.map(row => row.height)].map(pt => pt / 72),
      h: Math.min(BODY_HEIGHT_PT, height) / 72,
      fontSize: TABLE_SIZE,
      fontFace: FONT,
      color: TEXT_COLOR,
      valign: 'top',
      border: { type: 'solid', pt: 0.75, color: 'CBD5E0' },
      autoPage: false
    });
  }

  /**
   * Settings slide (like the browser export).
   * @param {Array<[string, string]>} rows
   */
  settingsSlide(rows) {
    if (!rows.length) return;
    const slide = this.contentSlide({
      title: this.t('export.settings.title'),
      background: 'F9FAFB'
    });
    slide.addText(
      rows.flatMap(([name, value], index) => [
        { text: `${name}: `, options: { bold: true, align: 'left' } },
        {
          text: stripXmlInvalidChars(value),
          options: { align: 'left', breakLine: index < rows.length - 1 }
        }
      ]),
      {
        x: MARGIN_X,
        y: BODY_TOP,
        w: CONTENT_W,
        h: BODY_BOTTOM - BODY_TOP,
        fontSize: 16,
        color: '374151',
        fontFace: FONT,
        valign: 'top'
      }
    );
  }

  /** Footer with the label text and "n / N" on every slide. */
  footers() {
    const total = this.slides.length;
    const footerText = stripXmlInvalidChars(this.label.show ? this.label.text : this.doc.appName);
    this.slides.forEach((slide, index) => {
      const onTitle = index === 0;
      const color = onTitle ? this.titleTheme.text : '9CA3AF';
      slide.addText(footerText, {
        x: MARGIN_X,
        y: 5.2,
        w: CONTENT_W - 1.2,
        h: 0.3,
        fontSize: 9,
        color,
        fontFace: FONT
      });
      slide.addText(this.t('export.footer.page', { current: index + 1, total }), {
        x: MARGIN_X + CONTENT_W - 1,
        y: 5.2,
        w: 1,
        h: 0.3,
        fontSize: 9,
        color,
        fontFace: FONT,
        align: 'right'
      });
    });
  }
}

/**
 * pptxgenjs text objects for buffered paragraphs. Every run carries
 * `align` and its paragraph's options, so paragraphs are split only by
 * `breakLine` (pptxgenjs otherwise also starts one at every bullet run).
 * Consecutive items of one numbered list start at the first item's number.
 * @param {Object[]} paras
 * @returns {Array<{text: string, options: Object}>}
 */
function textObjects(paras) {
  const firstNumber = new Map();
  for (const para of paras) {
    if (para.list && !firstNumber.has(para.list.id))
      firstNumber.set(para.list.id, para.list.number);
  }
  return paras.flatMap((para, paraIndex) => {
    const bullet = para.bullet
      ? para.list
        ? { type: 'number', numberStartAt: firstNumber.get(para.list.id) }
        : true
      : false;
    const paragraphOptions = {
      align: 'left',
      bullet,
      ...(para.indentLevel ? { indentLevel: para.indentLevel } : {}),
      ...(para.spaceAfter ? { paraSpaceAfter: para.spaceAfter } : {})
    };
    return para.runs.map((run, runIndex) => ({
      text: run.text,
      options: {
        fontSize: para.size,
        fontFace: para.font,
        color: para.color,
        ...run.options,
        ...paragraphOptions,
        breakLine: runIndex === para.runs.length - 1 && paraIndex < paras.length - 1
      }
    }));
  });
}

/**
 * Render the export as PPTX.
 *
 * @param {Object} doc - normalised export document (see `renderExport`)
 * @returns {Promise<Buffer>} the PPTX bytes
 */
export async function renderPptx(doc) {
  const { t, label, settingsRows, exportedOn } = prepareCommon(doc);
  const pres = new PptxGenJS();
  pres.layout = 'LAYOUT_16x9';
  pres.title = stripXmlInvalidChars(doc.title);
  pres.author = stripXmlInvalidChars(doc.appName);
  pres.company = stripXmlInvalidChars(doc.label.provider || PRODUCT_NAME);
  pres.subject = stripXmlInvalidChars(label.show ? label.text : doc.appName);
  pres.theme = { headFontFace: FONT, bodyFontFace: FONT };

  const deck = new DeckBuilder({ pres, t, doc, label });
  const elements = new ElementBuilder(t);
  deck.titleSlide(exportedOn);

  if (isTranscript(doc)) {
    for (const message of doc.messages) {
      deck.flow(elements.elements(lexMarkdown(message.content)), {
        title: roleLabel(message.role, t),
        meta: [formatDateTime(message.timestamp, doc.language), message.model]
          .filter(Boolean)
          .join(' · '),
        marker: getVerificationMarker(message, t),
        background: message.role === 'user' && doc.template !== 'minimal' ? 'F3F4F6' : 'FFFFFF'
      });
    }
  } else {
    for (const message of doc.messages) {
      deck.flow(elements.elements(lexMarkdown(message.content)), {
        title: doc.title,
        meta: [formatDateTime(message.timestamp, doc.language), message.model]
          .filter(Boolean)
          .join(' · '),
        marker: getDocumentMarker(doc, message, t)
      });
    }
  }
  deck.settingsSlide(settingsRows);
  deck.footers();

  const written = await pres.write({ outputType: 'nodebuffer' });
  return repairParagraphProperties(Buffer.from(written));
}
