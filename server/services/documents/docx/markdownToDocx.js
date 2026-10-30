// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { Lexer } from 'marked';
import {
  AlignmentType,
  BorderStyle,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
  PageBreak,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType
} from 'docx';
import {
  comparable,
  decodeEntities,
  isPageBreakParagraph,
  PAGE_BREAK_HTML,
  PAGE_BREAK_MARKERS,
  plainText,
  stripTags
} from '../pdf/markdownToPdfmake.js';
import { checkImageDataUri, imagePixelSize, LIMITS, safeLink } from '../pdf/validators.js';

/**
 * Convert Markdown to Word content (paragraphs and tables of the `docx`
 * library).
 *
 * Formatting comes from named styles wherever Word has one — headings,
 * Title, Subtitle, List Paragraph, Quote, Caption, Hyperlink — so a Word
 * template's styles take over when the document is merged into it (see
 * `wordTemplate.js`). Only what Word has no built-in style for (code, table
 * header shading, callouts) is formatted directly, from the document colours.
 *
 * Supported: headings, paragraphs, bold/italic/strikethrough/code, links,
 * nested and task lists, GFM tables with alignment, code blocks, quotes,
 * GitHub alerts (`> [!NOTE]` … `[!CAUTION]`) as callouts, rules, page breaks
 * (`\pagebreak`), `<sub>`/`<sup>`/`<u>`/`<mark>`/`<br>`, and PNG/JPEG images
 * as `data:` URIs.
 */

export const STYLE_IDS = Object.freeze({
  title: 'Title',
  subtitle: 'Subtitle',
  quote: 'Quote',
  caption: 'Caption',
  code: 'IhubCode',
  inlineCode: 'IhubInlineCode',
  hyperlink: 'Hyperlink',
  listParagraph: 'ListParagraph'
});

export const NUMBERING = Object.freeze({ bullet: 'ihub-bullet', ordered: 'ihub-ordered' });

const HEADINGS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6
];

const ALERTS = {
  note: { label: { en: 'Note', de: 'Hinweis' }, color: '2563EB', fill: 'EFF6FF' },
  tip: { label: { en: 'Tip', de: 'Tipp' }, color: '16A34A', fill: 'F0FDF4' },
  important: { label: { en: 'Important', de: 'Wichtig' }, color: '7C3AED', fill: 'F5F3FF' },
  warning: { label: { en: 'Warning', de: 'Warnung' }, color: 'D97706', fill: 'FFFBEB' },
  caution: { label: { en: 'Caution', de: 'Vorsicht' }, color: 'DC2626', fill: 'FEF2F2' }
};

const INLINE_HTML = {
  sub: { subScript: true },
  sup: { superScript: true },
  u: { underline: {} },
  ins: { underline: {} },
  s: { strike: true },
  strike: { strike: true },
  del: { strike: true },
  b: { bold: true },
  strong: { bold: true },
  i: { italics: true },
  em: { italics: true },
  mark: { highlight: 'yellow' },
  code: { code: true },
  kbd: { code: true }
};

/** Pixels per inch Word assumes for image sizes. */
const PX_PER_INCH = 96;

export function warn(ctx, message) {
  if (!ctx.warnings.includes(message) && ctx.warnings.length < 50) ctx.warnings.push(message);
}

function count(ctx) {
  ctx.nodeCount = (ctx.nodeCount || 0) + 1;
  if (ctx.nodeCount > LIMITS.maxNodes) {
    throw new Error(
      `The document is too large (more than ${LIMITS.maxNodes} elements). Split it into smaller documents.`
    );
  }
}

function hex(color) {
  return String(color || '').replace(/^#/, '');
}

function textRun(ctx, text, style) {
  const options = { text };
  if (style.bold) options.bold = true;
  if (style.italics) options.italics = true;
  if (style.strike) options.strike = true;
  if (style.underline) options.underline = {};
  if (style.subScript) options.subScript = true;
  if (style.superScript) options.superScript = true;
  if (style.highlight) options.highlight = style.highlight;
  if (style.code) options.style = STYLE_IDS.inlineCode;
  if (style.link) options.style = STYLE_IDS.hyperlink;
  if (style.color) options.color = style.color;
  return new TextRun(options);
}

/**
 * Inline tokens → runs (text runs and hyperlinks).
 *
 * @param {Array} tokens
 * @param {Object} ctx
 * @param {Object} [style] - Inherited run style.
 * @returns {Array}
 */
export function inlineRuns(tokens, ctx, style = {}) {
  const runs = [];
  const htmlStack = [];
  const effective = () => htmlStack.reduce((acc, s) => ({ ...acc, ...s }), style);
  const push = (text, extra = {}) => {
    if (text === '' || text === undefined || text === null) return;
    const parts = String(text).split('\n');
    parts.forEach((part, index) => {
      if (index > 0) runs.push(new TextRun({ break: 1 }));
      if (part) runs.push(textRun(ctx, part, { ...effective(), ...extra }));
    });
  };
  for (const token of tokens || []) {
    switch (token.type) {
      case 'text':
      case 'escape':
        if (token.tokens?.length) runs.push(...inlineRuns(token.tokens, ctx, effective()));
        else push(decodeEntities(token.text));
        break;
      case 'strong':
        runs.push(...inlineRuns(token.tokens, ctx, { ...effective(), bold: true }));
        break;
      case 'em':
        runs.push(...inlineRuns(token.tokens, ctx, { ...effective(), italics: true }));
        break;
      case 'del':
        runs.push(...inlineRuns(token.tokens, ctx, { ...effective(), strike: true }));
        break;
      case 'codespan':
        push(decodeEntities(token.text), { code: true });
        break;
      case 'br':
        push('\n');
        break;
      case 'link': {
        const href = safeLink(token.href);
        const children = inlineRuns(token.tokens, ctx, href ? { ...effective(), link: true } : {});
        if (href && children.length) {
          runs.push(new ExternalHyperlink({ link: href, children }));
        } else runs.push(...children);
        break;
      }
      case 'image':
        push(token.text ? `[${token.text}]` : '', { italics: true });
        break;
      case 'html': {
        const raw = String(token.raw || token.text || '').trim();
        const open = /^<([a-z]+)\b[^>]*>$/i.exec(raw);
        const close = /^<\/([a-z]+)\s*>$/i.exec(raw);
        if (/^<br\s*\/?>$/i.test(raw)) push('\n');
        else if (open && INLINE_HTML[open[1].toLowerCase()]) {
          htmlStack.push(INLINE_HTML[open[1].toLowerCase()]);
        } else if (close && INLINE_HTML[close[1].toLowerCase()]) {
          htmlStack.pop();
        } else if (!raw.startsWith('<!--')) {
          push(stripTags(raw));
        }
        break;
      }
      default:
        if (token.tokens?.length) runs.push(...inlineRuns(token.tokens, ctx, effective()));
        else if (typeof token.text === 'string') push(decodeEntities(token.text));
    }
  }
  return runs;
}

/**
 * A picture paragraph: natural size at 96 dpi, scaled down to the text width
 * and to 60 % of the text height.
 */
function imageParagraphs(ctx, token) {
  const label = token.text ? `image "${token.text}"` : 'image';
  const check = checkImageDataUri(token.href);
  if (!check.ok) {
    warn(ctx, `Skipped ${label}: ${check.reason}.`);
    return token.text
      ? [new Paragraph({ style: STYLE_IDS.caption, children: [new TextRun(`[${token.text}]`)] })]
      : [];
  }
  ctx.imageBytes = (ctx.imageBytes || 0) + check.bytes;
  if (ctx.imageBytes > LIMITS.maxTotalImageBytes) {
    warn(ctx, 'Skipped images beyond the 15 MB total image budget.');
    return [];
  }
  const pixels = imagePixelSize(check.dataUri) || { width: 400, height: 300 };
  const maxWidth = ctx.contentWidthPx;
  const maxHeight = ctx.contentHeightPx * 0.6;
  const scale = Math.min(1, maxWidth / pixels.width, maxHeight / pixels.height);
  const width = Math.max(1, Math.round(pixels.width * scale));
  const height = Math.max(1, Math.round(pixels.height * scale));
  const data = Buffer.from(check.dataUri.slice(check.dataUri.indexOf(',') + 1), 'base64');
  const paragraphs = [
    new Paragraph({
      keepNext: Boolean(token.text),
      children: [
        new ImageRun({
          type: check.dataUri.startsWith('data:image/png') ? 'png' : 'jpg',
          data,
          transformation: { width, height },
          altText: { name: token.text || 'image', description: token.text || '', title: '' }
        })
      ]
    })
  ];
  if (token.text) {
    paragraphs.push(
      new Paragraph({ style: STYLE_IDS.caption, children: [new TextRun(token.text)] })
    );
  }
  count(ctx);
  return paragraphs;
}

function codeParagraphs(ctx, token) {
  const lines = String(token.text || '')
    .replaceAll('\t', '    ')
    .split('\n');
  const runs = [];
  lines.forEach((line, index) => {
    if (index > 0) runs.push(new TextRun({ break: 1 }));
    runs.push(new TextRun({ text: line || ' ' }));
  });
  return [new Paragraph({ style: STYLE_IDS.code, children: runs })];
}

function columnWidths(token, totalTwips) {
  const columns = token.header.length;
  const lengths = new Array(columns).fill(4);
  const measure = cell => Math.min(String(cell?.text || '').length, 60);
  token.header.forEach((cell, i) => {
    lengths[i] = Math.max(lengths[i], measure(cell));
  });
  for (const row of token.rows.slice(0, 200)) {
    row.forEach((cell, i) => {
      if (i < columns) lengths[i] = Math.max(lengths[i], measure(cell));
    });
  }
  const weights = lengths.map(len => Math.sqrt(len));
  const sum = weights.reduce((a, b) => a + b, 0);
  return weights.map(w => Math.max(500, Math.floor((totalTwips * w) / sum)));
}

function alignmentOf(value) {
  if (value === 'right') return AlignmentType.RIGHT;
  if (value === 'center') return AlignmentType.CENTER;
  return AlignmentType.LEFT;
}

function tableOf(ctx, token) {
  if (token.rows.length > LIMITS.maxTableRows) {
    warn(ctx, `Table truncated to ${LIMITS.maxTableRows} rows.`);
  }
  const columns = token.header.length;
  const widths = columnWidths(token, ctx.contentWidthTwips);
  const border = { style: BorderStyle.SINGLE, size: 4, color: ctx.colors.border };
  const cell = (c, i, header, rowIndex) => {
    count(ctx);
    const runs = inlineRuns(
      c?.tokens || [],
      ctx,
      header ? { bold: true, color: ctx.colors.tableHeaderText } : {}
    );
    const fill = header
      ? ctx.colors.tableHeaderFill
      : rowIndex % 2 === 1
        ? ctx.colors.tableStripeFill
        : null;
    return new TableCell({
      width: { size: widths[i], type: WidthType.DXA },
      margins: { top: 60, bottom: 60, left: 100, right: 100 },
      ...(fill ? { shading: { type: ShadingType.CLEAR, color: 'auto', fill } } : {}),
      children: [
        new Paragraph({
          alignment: alignmentOf(token.align?.[i]),
          spacing: { before: 0, after: 0 },
          children: runs
        })
      ]
    });
  };
  const rows = [
    new TableRow({
      tableHeader: true,
      cantSplit: true,
      children: token.header.map((c, i) => cell(c, i, true, 0))
    })
  ];
  token.rows.slice(0, LIMITS.maxTableRows).forEach((row, rowIndex) => {
    const cells = [];
    for (let i = 0; i < columns; i += 1) cells.push(cell(row[i], i, false, rowIndex));
    rows.push(new TableRow({ cantSplit: true, children: cells }));
  });
  return new Table({
    rows,
    width: { size: ctx.contentWidthTwips, type: WidthType.DXA },
    columnWidths: widths,
    borders: {
      top: border,
      bottom: border,
      left: border,
      right: border,
      insideHorizontal: border,
      insideVertical: border
    }
  });
}

/** A one-cell table with a coloured left border: callouts and alerts. */
function callout(ctx, { title, color, fill, children }) {
  const none = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
  const content = [];
  if (title) {
    content.push(
      new Paragraph({
        spacing: { before: 0, after: 60 },
        children: [new TextRun({ text: title, bold: true, color })]
      })
    );
  }
  content.push(...(children.length ? children : [new Paragraph('')]));
  return new Table({
    width: { size: ctx.contentWidthTwips, type: WidthType.DXA },
    columnWidths: [ctx.contentWidthTwips],
    borders: {
      top: none,
      bottom: none,
      right: none,
      insideHorizontal: none,
      insideVertical: none,
      left: { style: BorderStyle.SINGLE, size: 24, color }
    },
    rows: [
      new TableRow({
        cantSplit: true,
        children: [
          new TableCell({
            width: { size: ctx.contentWidthTwips, type: WidthType.DXA },
            margins: { top: 100, bottom: 100, left: 180, right: 140 },
            shading: { type: ShadingType.CLEAR, color: 'auto', fill },
            children: content
          })
        ]
      })
    ]
  });
}

function alertOf(token) {
  const first = token.tokens?.[0];
  if (first?.type !== 'paragraph') return null;
  const match = /^\s*\[!(note|tip|important|warning|caution)\]\s*/i.exec(first.text || '');
  if (!match) return null;
  const rest = (first.raw || first.text).replace(/^\s*\[![a-z]+\]\s*/i, '');
  const tokens = new Lexer({ gfm: true }).lex(rest);
  return { kind: match[1].toLowerCase(), tokens: [...tokens, ...token.tokens.slice(1)] };
}

function listParagraphs(ctx, token, depth) {
  const out = [];
  const level = Math.min(depth, 8);
  let instance;
  if (token.ordered) {
    ctx.listInstance = (ctx.listInstance || 0) + 1;
    instance = ctx.listInstance;
  }
  for (const item of token.items) {
    count(ctx);
    let firstParagraph = true;
    for (const child of item.tokens || []) {
      if (child.type === 'list') {
        out.push(...listParagraphs(ctx, child, depth + 1));
        continue;
      }
      if (child.type === 'space') continue;
      if (!['text', 'paragraph'].includes(child.type)) {
        out.push(...blockElements([child], ctx, depth + 1));
        continue;
      }
      const runs = child.tokens ? inlineRuns(child.tokens, ctx) : [new TextRun(child.text || '')];
      if (item.task && firstParagraph) runs.unshift(new TextRun(item.checked ? '☑ ' : '☐ '));
      const numbering = firstParagraph
        ? item.task
          ? undefined
          : token.ordered
            ? { reference: NUMBERING.ordered, level, instance }
            : { reference: NUMBERING.bullet, level }
        : undefined;
      out.push(
        new Paragraph({
          style: STYLE_IDS.listParagraph,
          ...(numbering ? { numbering } : { indent: { left: 360 * (level + 1) } }),
          spacing: { before: 0, after: 60 },
          children: runs
        })
      );
      firstParagraph = false;
    }
  }
  return out;
}

function horizontalRule(ctx) {
  return new Paragraph({
    spacing: { before: 120, after: 120 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: ctx.colors.border, space: 1 } },
    children: []
  });
}

/**
 * Block tokens → paragraphs and tables.
 *
 * @param {Array} tokens
 * @param {Object} ctx
 * @param {number} [depth]
 * @returns {Array}
 */
export function blockElements(tokens, ctx, depth = 0) {
  if (depth > LIMITS.maxDepth) {
    warn(ctx, 'Deeply nested content was flattened.');
    return [];
  }
  const out = [];
  for (const token of tokens || []) {
    count(ctx);
    switch (token.type) {
      case 'space':
      case 'def':
        break;
      case 'heading': {
        const level = Math.min(Math.max(token.depth, 1), 6);
        out.push(
          new Paragraph({
            heading: HEADINGS[level - 1],
            keepNext: true,
            children: inlineRuns(token.tokens, ctx)
          })
        );
        break;
      }
      case 'paragraph': {
        if (isPageBreakParagraph(token)) {
          out.push(new Paragraph({ children: [new PageBreak()] }));
          break;
        }
        const inline = token.tokens || [];
        const images = inline.filter(t => t.type === 'image');
        const onlyImages =
          images.length > 0 &&
          inline.every(t => t.type === 'image' || (t.type === 'text' && !t.text.trim()));
        if (onlyImages) {
          for (const image of images) out.push(...imageParagraphs(ctx, image));
          break;
        }
        const runs = inlineRuns(inline, ctx);
        if (runs.length) out.push(new Paragraph({ children: runs }));
        break;
      }
      case 'text': {
        const runs = token.tokens ? inlineRuns(token.tokens, ctx) : [new TextRun(token.text)];
        if (runs.length) out.push(new Paragraph({ children: runs }));
        break;
      }
      case 'list':
        out.push(...listParagraphs(ctx, token, depth));
        break;
      case 'table':
        out.push(tableOf(ctx, token), new Paragraph({ spacing: { after: 60 }, children: [] }));
        break;
      case 'code':
        out.push(...codeParagraphs(ctx, token));
        break;
      case 'blockquote': {
        const alert = alertOf(token);
        if (alert) {
          const spec = ALERTS[alert.kind];
          out.push(
            callout(ctx, {
              title: spec.label[ctx.language] || spec.label.en,
              color: spec.color,
              fill: spec.fill,
              children: blockElements(alert.tokens, ctx, depth + 1)
            }),
            new Paragraph({ spacing: { after: 60 }, children: [] })
          );
          break;
        }
        for (const child of token.tokens || []) {
          if (child.type === 'paragraph' || child.type === 'text') {
            out.push(
              new Paragraph({
                style: STYLE_IDS.quote,
                children: child.tokens ? inlineRuns(child.tokens, ctx) : [new TextRun(child.text)]
              })
            );
          } else out.push(...blockElements([child], ctx, depth + 1));
        }
        break;
      }
      case 'hr':
        out.push(horizontalRule(ctx));
        break;
      case 'html': {
        const raw = String(token.raw || token.text || '').trim();
        if (PAGE_BREAK_MARKERS.has(raw) || PAGE_BREAK_HTML.test(raw)) {
          out.push(new Paragraph({ children: [new PageBreak()] }));
          break;
        }
        const text = stripTags(raw).trim();
        if (text) out.push(new Paragraph({ children: [new TextRun(text)] }));
        break;
      }
      default:
        if (token.tokens?.length) {
          const runs = inlineRuns(token.tokens, ctx);
          if (runs.length) out.push(new Paragraph({ children: runs }));
        } else if (typeof token.text === 'string' && token.text.trim()) {
          out.push(new Paragraph({ children: [new TextRun(decodeEntities(token.text))] }));
        }
    }
  }
  return out;
}

/**
 * Tidy a document body: leave out a first heading that repeats the title
 * printed above it, and rules at the start, the end or after another rule.
 */
function tidy(tokens, title) {
  const blocks = tokens.filter(token => token.type !== 'space');
  const first = blocks.find(token => token.type !== 'hr');
  if (
    title &&
    first?.type === 'heading' &&
    first.depth <= 2 &&
    comparable(plainText(first.tokens)) === comparable(title)
  ) {
    blocks.splice(blocks.indexOf(first), 1);
  }
  const out = [];
  for (const token of blocks) {
    if (token.type === 'hr' && (!out.length || out.at(-1).type === 'hr')) continue;
    out.push(token);
  }
  while (out.at(-1)?.type === 'hr') out.pop();
  return out;
}

/**
 * Convert a Markdown document body.
 *
 * @param {string} markdown
 * @param {Object} ctx - `colors`, `contentWidthTwips`, `contentWidthPx`,
 *   `contentHeightPx`, `language`, `breaks`, `warnings`.
 * @param {Object} [options]
 * @param {string} [options.title] - The title printed above the body.
 * @returns {Array} Paragraphs and tables.
 */
export function markdownToDocx(markdown, ctx, { title } = {}) {
  const text = String(markdown ?? '');
  if (text.length > LIMITS.maxMarkdownChars) {
    throw new Error('The Markdown content is too long for one document.');
  }
  const tokens = new Lexer({ gfm: true, breaks: Boolean(ctx.breaks) }).lex(text);
  return blockElements(tidy(tokens, title), ctx);
}

export { hex, PX_PER_INCH };
