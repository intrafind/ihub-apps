import { resolveFontFamily } from './fonts.js';
import { isColor } from './themes.js';
import { acceptImage, markdownToContent, naturalImageSize, warn } from './markdownToPdfmake.js';
import {
  LIMITS,
  clampNumber,
  fitWithin,
  safeLink,
  sanitizeMargin,
  sanitizeSvg,
  svgSize
} from './validators.js';

/**
 * Turn layout blocks from an untrusted caller (the model, an API client) into
 * pdfmake content.
 *
 * Layout blocks are a JSON subset of pdfmake's document definition, plus a
 * few conveniences (`markdown`, `callout`, `box`). The sanitiser is an
 * allowlist: every node kind and every property is checked and anything else
 * is dropped with a warning. In particular:
 *
 * - images are only PNG/JPEG `data:` URIs (or names from the document's
 *   `images` map, which obey the same rule); never a path or URL
 * - SVG loses scripts, foreign objects and external images
 * - fonts are limited to the registered families
 * - links are `http(s):` or `mailto:` only
 * - document-level keys that reach files (`attachments`, `files`, `patterns`)
 *   are not part of a block at all
 */

const ALIGNMENTS = new Set(['left', 'center', 'right', 'justify']);
const DECORATIONS = new Set(['underline', 'lineThrough', 'overline']);
const DECORATION_STYLES = new Set(['dashed', 'dotted', 'double', 'wavy']);
const PAGE_BREAKS = new Set([
  'before',
  'after',
  'beforeOdd',
  'afterOdd',
  'beforeEven',
  'afterEven'
]);
const LIST_TYPES = new Set([
  'disc',
  'circle',
  'square',
  'none',
  'decimal',
  'lower-alpha',
  'upper-alpha',
  'lower-roman',
  'upper-roman'
]);
const TABLE_LAYOUTS = new Set([
  'noBorders',
  'headerLineOnly',
  'lightHorizontalLines',
  'ihubTable',
  'ihubGrid',
  'ihubPlain'
]);
const CALLOUT_TONES = new Set(['info', 'success', 'warning', 'danger', 'note']);
const CANVAS_TYPES = new Set(['rect', 'line', 'ellipse', 'polyline']);
const STYLE_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,40}$/;

const bool = v => (typeof v === 'boolean' ? v : undefined);
const color = v => (isColor(v) ? v : undefined);
const oneOf = set => v => (typeof v === 'string' && set.has(v) ? v : undefined);
const num = (min, max) => v => clampNumber(v, min, max);
const shortString = max => v => (typeof v === 'string' ? v.slice(0, max) : undefined);

/** Text styling allowed on any node that holds or inherits text. */
const TEXT_PROPS = {
  bold: bool,
  italics: bool,
  fontSize: num(3, 144),
  color,
  background: color,
  decoration: oneOf(DECORATIONS),
  decorationStyle: oneOf(DECORATION_STYLES),
  decorationColor: color,
  lineHeight: num(0.5, 4),
  characterSpacing: num(-5, 40),
  alignment: oneOf(ALIGNMENTS),
  sup: bool,
  sub: bool,
  noWrap: bool,
  preserveLeadingSpaces: bool,
  opacity: num(0, 1),
  leadingIndent: num(0, 200),
  markerColor: color
};

/** Placement allowed on any node. */
const LAYOUT_PROPS = {
  margin: v => sanitizeMargin(v),
  pageBreak: oneOf(PAGE_BREAKS),
  unbreakable: bool,
  headlineLevel: num(1, 6),
  tocItem: bool,
  tocMargin: v => sanitizeMargin(v),
  id: shortString(80),
  width: v => (v === '*' || v === 'auto' ? v : (pct(v) ?? num(0, 5000)(v))),
  relativePosition: point,
  absolutePosition: point
};

function pct(value) {
  return typeof value === 'string' && /^\d{1,3}(\.\d+)?%$/.test(value) ? value : undefined;
}

function point(value) {
  if (!value || typeof value !== 'object') return undefined;
  const x = clampNumber(value.x, -5000, 5000);
  const y = clampNumber(value.y, -5000, 5000);
  return x === undefined || y === undefined ? undefined : { x, y };
}

function copyProps(source, target, spec, ctx, kind) {
  for (const [key, check] of Object.entries(spec)) {
    if (source[key] === undefined) continue;
    const value = check(source[key]);
    if (value === undefined) warn(ctx, `Ignored invalid "${key}" on a ${kind} block.`);
    else target[key] = value;
  }
}

function applyCommon(source, target, ctx, kind) {
  copyProps(source, target, TEXT_PROPS, ctx, kind);
  copyProps(source, target, LAYOUT_PROPS, ctx, kind);
  if (source.font !== undefined) target.font = resolveFontFamily(source.font, ctx.theme.font);
  const link = source.link !== undefined ? safeLink(source.link) : undefined;
  if (link) target.link = link;
  else if (source.link !== undefined) warn(ctx, 'Removed a link that is not http(s) or mailto.');
  if (Number.isInteger(source.linkToPage) && source.linkToPage > 0) {
    target.linkToPage = source.linkToPage;
  }
  if (source.style !== undefined) {
    const names = (Array.isArray(source.style) ? source.style : [source.style]).filter(
      s => typeof s === 'string' && STYLE_NAME.test(s)
    );
    if (names.length) target.style = names.length === 1 ? names[0] : names;
  }
  return target;
}

/** Run `fn` with the context marked as inside a container (column, box, cell). */
function inContainer(ctx, fn) {
  ctx.containerDepth = (ctx.containerDepth || 0) + 1;
  try {
    return fn();
  } finally {
    ctx.containerDepth -= 1;
  }
}

function countNode(ctx) {
  ctx.nodeCount = (ctx.nodeCount || 0) + 1;
  if (ctx.nodeCount > LIMITS.maxNodes) {
    throw new Error(
      `Document is too large (more than ${LIMITS.maxNodes} layout elements). Split it into smaller documents.`
    );
  }
}

function sanitizeText(value, ctx, depth) {
  if (typeof value === 'string' || typeof value === 'number') {
    const text = String(value);
    if (text.length > LIMITS.maxTextChars) {
      warn(ctx, `Text longer than ${LIMITS.maxTextChars} characters was truncated.`);
      return text.slice(0, LIMITS.maxTextChars);
    }
    return text;
  }
  if (Array.isArray(value)) {
    return value
      .map(part => {
        if (typeof part === 'string' || typeof part === 'number') return sanitizeText(part, ctx);
        if (part && typeof part === 'object' && part.text !== undefined) {
          countNode(ctx);
          return applyCommon(part, { text: sanitizeText(part.text, ctx, depth + 1) }, ctx, 'text');
        }
        return null;
      })
      .filter(part => part !== null);
  }
  return '';
}

function sanitizeImage(source, ctx) {
  const ref = source.image;
  const named = typeof ref === 'string' && ctx.imageNames?.has(ref);
  const src = named ? ref : acceptImage(ctx, ref, 'an image block');
  if (!src) return null;
  const node = { image: src };
  const width = num(1, 5000)(source.width);
  const height = num(1, 5000)(source.height);
  if (width !== undefined) node.width = width;
  if (height !== undefined) node.height = height;
  if (Array.isArray(source.fit) && source.fit.length === 2) {
    const fit = source.fit.map(v => num(1, 5000)(v));
    if (fit.every(v => v !== undefined)) node.fit = fit;
  }
  if (width === undefined && height === undefined && !node.fit) {
    // pdfmake draws an image at one point per pixel by default, which
    // overflows the page for anything larger than a logo.
    Object.assign(node, naturalImageSize(named ? ctx.imageNames.get(ref) : src, ctx));
  }
  if (source.alignment && ALIGNMENTS.has(source.alignment)) node.alignment = source.alignment;
  return node;
}

function sanitizeSvgNode(source, ctx) {
  if (typeof source.svg !== 'string' || !source.svg.includes('<svg')) {
    warn(ctx, 'Skipped an svg block without <svg> markup.');
    return null;
  }
  if (source.svg.length > LIMITS.maxSvgChars) {
    warn(ctx, 'Skipped an SVG larger than 500 KB.');
    return null;
  }
  const node = { svg: sanitizeSvg(source.svg) };
  const width = num(1, 5000)(source.width);
  const height = num(1, 5000)(source.height);
  if (width !== undefined) node.width = width;
  if (height !== undefined) node.height = height;
  if (Array.isArray(source.fit) && source.fit.length === 2) {
    const fit = source.fit.map(v => num(1, 5000)(v));
    if (fit.every(v => v !== undefined)) node.fit = fit;
  }
  if (width === undefined && !node.fit) {
    Object.assign(node, fitWithin(svgSize(node.svg), ctx.contentWidth, ctx.contentHeight));
  }
  if (source.alignment && ALIGNMENTS.has(source.alignment)) node.alignment = source.alignment;
  return node;
}

function sanitizeCanvas(items, ctx) {
  if (!Array.isArray(items)) return null;
  const out = [];
  for (const item of items.slice(0, 500)) {
    if (!item || typeof item !== 'object' || !CANVAS_TYPES.has(item.type)) continue;
    countNode(ctx);
    const shape = { type: item.type };
    for (const key of ['x', 'y', 'x1', 'y1', 'x2', 'y2', 'w', 'h', 'r', 'r1', 'r2']) {
      const v = clampNumber(item[key], -5000, 5000);
      if (v !== undefined) shape[key] = v;
    }
    const lineWidth = clampNumber(item.lineWidth, 0, 50);
    if (lineWidth !== undefined) shape.lineWidth = lineWidth;
    for (const key of ['color', 'lineColor']) if (isColor(item[key])) shape[key] = item[key];
    for (const key of ['fillOpacity', 'strokeOpacity']) {
      const v = clampNumber(item[key], 0, 1);
      if (v !== undefined) shape[key] = v;
    }
    if (item.dash && typeof item.dash === 'object') {
      const length = clampNumber(item.dash.length, 0.5, 100);
      const space = clampNumber(item.dash.space, 0, 100);
      if (length !== undefined) shape.dash = { length, ...(space !== undefined ? { space } : {}) };
    }
    if (typeof item.lineCap === 'string' && ['butt', 'round', 'square'].includes(item.lineCap)) {
      shape.lineCap = item.lineCap;
    }
    if (item.type === 'polyline' && Array.isArray(item.points)) {
      shape.points = item.points.slice(0, 2000).map(point).filter(Boolean);
      if (item.closePath === true) shape.closePath = true;
    }
    if (
      Array.isArray(item.linearGradient) &&
      item.linearGradient.length >= 2 &&
      item.linearGradient.every(isColor)
    ) {
      shape.linearGradient = item.linearGradient.slice(0, 8);
    }
    out.push(shape);
  }
  return out;
}

function sanitizeTableLayout(layout, ctx) {
  if (layout === undefined) return 'ihubTable';
  if (typeof layout === 'string') {
    if (TABLE_LAYOUTS.has(layout)) return layout;
    warn(ctx, `Unknown table layout "${String(layout).slice(0, 40)}"; used the theme layout.`);
    return 'ihubTable';
  }
  if (layout && typeof layout === 'object') {
    // A declarative layout; `buildDocument.js` turns it into pdfmake's
    // function-based layout inside the render worker.
    const spec = {};
    for (const key of [
      'hLineWidth',
      'vLineWidth',
      'paddingLeft',
      'paddingRight',
      'paddingTop',
      'paddingBottom'
    ]) {
      const v = clampNumber(layout[key], 0, 40);
      if (v !== undefined) spec[key] = v;
    }
    for (const key of ['hLineColor', 'vLineColor', 'headerFill', 'stripeFill', 'headerColor']) {
      if (isColor(layout[key])) spec[key] = layout[key];
    }
    if (typeof layout.outerBorderOnly === 'boolean') spec.outerBorderOnly = layout.outerBorderOnly;
    return { declarative: spec };
  }
  return 'ihubTable';
}

function sanitizeTable(source, ctx, depth) {
  const table = source.table;
  if (!table || typeof table !== 'object' || !Array.isArray(table.body) || !table.body.length) {
    warn(ctx, 'Skipped a table without a body.');
    return null;
  }
  let rows = table.body.filter(Array.isArray);
  if (rows.length > LIMITS.maxTableRows) {
    warn(ctx, `Table truncated to ${LIMITS.maxTableRows} rows.`);
    rows = rows.slice(0, LIMITS.maxTableRows);
  }
  const columns = Math.max(...rows.map(r => r.length), 1);
  const headerCount = Math.floor(clampNumber(table.headerRows, 0, rows.length) ?? 0);
  const body = rows.map((row, rowIndex) => {
    const cells = row.slice(0, columns).map(cell => {
      const node = inContainer(ctx, () => sanitizeCell(cell, ctx, depth + 1));
      // Unstyled cells take the theme's table text styles.
      if (node.text !== undefined && node.style === undefined && node.bold === undefined) {
        node.style = rowIndex < headerCount ? 'tableHeader' : 'tableCell';
      }
      return node;
    });
    while (cells.length < columns) cells.push({ text: '' });
    return cells;
  });
  const out = { body };
  if (Array.isArray(table.widths) && table.widths.length === columns) {
    out.widths = table.widths.map(w =>
      w === '*' || w === 'auto' ? w : (pct(w) ?? num(1, 5000)(w) ?? '*')
    );
  } else {
    out.widths = new Array(columns).fill(table.widths === 'auto' ? 'auto' : '*');
  }
  if (Array.isArray(table.heights) && table.heights.length === rows.length) {
    out.heights = table.heights.map(h => num(0, 2000)(h) ?? 'auto');
  } else if (clampNumber(table.heights, 0, 2000) !== undefined) {
    out.heights = clampNumber(table.heights, 0, 2000);
  }
  const headerRows = clampNumber(table.headerRows, 0, rows.length);
  if (headerRows !== undefined) out.headerRows = Math.floor(headerRows);
  if (typeof table.dontBreakRows === 'boolean') out.dontBreakRows = table.dontBreakRows;
  const keep = clampNumber(table.keepWithHeaderRows, 0, 50);
  if (keep !== undefined) out.keepWithHeaderRows = Math.floor(keep);
  const node = applyCommon(source, { table: out }, ctx, 'table');
  node.layout = sanitizeTableLayout(source.layout, ctx);
  return node;
}

function sanitizeCell(cell, ctx, depth) {
  if (cell === null || cell === undefined || cell === '') return { text: '' };
  if (typeof cell === 'object' && !Array.isArray(cell) && Object.keys(cell).length === 0) {
    // pdfmake's placeholder for a cell covered by a col/row span.
    return {};
  }
  const node = sanitizeNode(cell, ctx, depth) || { text: '' };
  if (cell && typeof cell === 'object' && !Array.isArray(cell)) {
    const colSpan = clampNumber(cell.colSpan, 1, 100);
    const rowSpan = clampNumber(cell.rowSpan, 1, 1000);
    if (colSpan !== undefined) node.colSpan = Math.floor(colSpan);
    if (rowSpan !== undefined) node.rowSpan = Math.floor(rowSpan);
    if (isColor(cell.fillColor)) node.fillColor = cell.fillColor;
    const fillOpacity = clampNumber(cell.fillOpacity, 0, 1);
    if (fillOpacity !== undefined) node.fillOpacity = fillOpacity;
    if (Array.isArray(cell.border) && cell.border.length === 4) {
      node.border = cell.border.map(Boolean);
    }
    if (Array.isArray(cell.borderColor) && cell.borderColor.length === 4) {
      node.borderColor = cell.borderColor.map(c => (isColor(c) ? c : '#000000'));
    }
  }
  return node;
}

function sanitizeList(source, key, ctx, depth) {
  const items = source[key];
  if (!Array.isArray(items)) return null;
  const list = items
    .slice(0, 5000)
    .map(item => {
      const node = sanitizeNode(item, ctx, depth + 1);
      if (node && item && typeof item === 'object' && LIST_TYPES.has(item.listType)) {
        node.listType = item.listType;
      }
      return node;
    })
    .filter(Boolean);
  const node = applyCommon(source, { [key]: list }, ctx, key);
  if (LIST_TYPES.has(source.type)) node.type = source.type;
  if (key === 'ol') {
    const start = clampNumber(source.start, -100000, 100000);
    if (start !== undefined) node.start = Math.floor(start);
    if (typeof source.reversed === 'boolean') node.reversed = source.reversed;
    if (typeof source.separator === 'string') node.separator = source.separator.slice(0, 5);
  }
  return node;
}

const CALLOUT_COLORS = {
  info: { fill: '#eff6ff', border: '#3b82f6' },
  note: { fill: '#f9fafb', border: '#9ca3af' },
  success: { fill: '#f0fdf4', border: '#22c55e' },
  warning: { fill: '#fffbeb', border: '#f59e0b' },
  danger: { fill: '#fef2f2', border: '#ef4444' }
};

/**
 * A shaded box with a coloured left edge: the "styled container" pattern,
 * built from a one-cell table so its content still flows and breaks across
 * pages.
 */
function boxNode(content, { fill, border, borderWidth = 3, padding = 10, fullBorder = false }) {
  return {
    // The fill goes on the layout, not the cell: a cell's `fillColor` is
    // inherited by tables inside it (code blocks, Markdown tables) and would
    // paint over their own shading.
    table: { widths: ['*'], body: [[{ stack: content }]] },
    layout: {
      declarative: {
        boxFill: fill || null,
        boxBorder: border || null,
        boxBorderWidth: borderWidth,
        boxFullBorder: fullBorder,
        paddingLeft: padding,
        paddingRight: padding,
        paddingTop: padding * 0.8,
        paddingBottom: padding * 0.8
      }
    },
    margin: [0, 4, 0, 10]
  };
}

function contentOf(source, ctx, depth) {
  return inContainer(ctx, () => containerContent(source, ctx, depth));
}

function containerContent(source, ctx, depth) {
  if (typeof source.markdown === 'string') return markdownToContent(source.markdown, ctx);
  if (source.content !== undefined) {
    const inner = sanitizeNode(source.content, ctx, depth + 1);
    return inner ? [inner] : [];
  }
  if (source.text !== undefined) return [{ text: sanitizeText(source.text, ctx, depth + 1) }];
  return [];
}

function sanitizeCallout(source, ctx, depth) {
  const spec = source.callout && typeof source.callout === 'object' ? source.callout : source;
  const tone = CALLOUT_TONES.has(spec.tone) ? spec.tone : 'info';
  const colors = CALLOUT_COLORS[tone];
  const content = [];
  if (typeof spec.title === 'string' && spec.title.trim()) {
    content.push({
      text: spec.title.slice(0, 500),
      bold: true,
      color: colors.border,
      margin: [0, 0, 0, 3]
    });
  }
  content.push(...contentOf(spec, ctx, depth));
  const node = boxNode(content, {
    fill: isColor(spec.fillColor) ? spec.fillColor : colors.fill,
    border: isColor(spec.borderColor) ? spec.borderColor : colors.border
  });
  const margin = sanitizeMargin(source.margin);
  if (margin !== undefined) node.margin = margin;
  return node;
}

function sanitizeBox(source, ctx, depth) {
  const spec =
    source.box && typeof source.box === 'object' && !Array.isArray(source.box)
      ? source.box
      : { content: source.box };
  const content = contentOf(spec, ctx, depth);
  const node = boxNode(content, {
    fill: isColor(spec.fillColor) ? spec.fillColor : null,
    border: isColor(spec.borderColor) ? spec.borderColor : ctx.theme.border,
    borderWidth: clampNumber(spec.borderWidth, 0, 10) ?? 0.75,
    padding: clampNumber(spec.padding, 0, 40) ?? 10,
    fullBorder: true
  });
  const margin = sanitizeMargin(source.margin);
  if (margin !== undefined) node.margin = margin;
  return node;
}

/**
 * Sanitise one layout block.
 *
 * @param {unknown} source
 * @param {Object} ctx - Conversion context (see `markdownToContent`), plus
 *   `imageNames`: the names defined in the document's `images` map.
 * @param {number} [depth]
 * @returns {Object|null}
 */
export function sanitizeNode(source, ctx, depth = 0) {
  if (depth > LIMITS.maxDepth) {
    warn(ctx, 'Deeply nested blocks were dropped.');
    return null;
  }
  countNode(ctx);
  if (typeof source === 'string' || typeof source === 'number') {
    return { text: sanitizeText(source, ctx, depth) };
  }
  if (Array.isArray(source)) {
    return { stack: source.map(child => sanitizeNode(child, ctx, depth + 1)).filter(Boolean) };
  }
  if (!source || typeof source !== 'object') return null;

  if (
    typeof source.markdown === 'string' &&
    source.callout === undefined &&
    source.box === undefined
  ) {
    return applyCommon(source, { stack: markdownToContent(source.markdown, ctx) }, ctx, 'markdown');
  }
  if (source.callout !== undefined) return sanitizeCallout(source, ctx, depth);
  if (source.box !== undefined) return sanitizeBox(source, ctx, depth);
  if (source.pageBreak !== undefined && Object.keys(source).length === 1) {
    return { text: '', pageBreak: PAGE_BREAKS.has(source.pageBreak) ? source.pageBreak : 'after' };
  }
  if (source.text !== undefined) {
    return applyCommon(source, { text: sanitizeText(source.text, ctx, depth) }, ctx, 'text');
  }
  if (source.stack !== undefined) {
    const stack = Array.isArray(source.stack) ? source.stack : [source.stack];
    return applyCommon(
      source,
      { stack: stack.map(child => sanitizeNode(child, ctx, depth + 1)).filter(Boolean) },
      ctx,
      'stack'
    );
  }
  if (source.columns !== undefined) {
    if (!Array.isArray(source.columns)) return null;
    const node = applyCommon(
      source,
      {
        columns: source.columns
          .slice(0, 20)
          .map(child => {
            const column = inContainer(ctx, () => sanitizeNode(child, ctx, depth + 1));
            if (column && child && typeof child === 'object' && child.width !== undefined) {
              const width = LAYOUT_PROPS.width(child.width);
              if (width !== undefined) column.width = width;
            }
            return column;
          })
          .filter(Boolean)
      },
      ctx,
      'columns'
    );
    const gap = clampNumber(source.columnGap, 0, 200);
    if (gap !== undefined) node.columnGap = gap;
    return node;
  }
  if (source.table !== undefined) return sanitizeTable(source, ctx, depth);
  if (source.ul !== undefined) return sanitizeList(source, 'ul', ctx, depth);
  if (source.ol !== undefined) return sanitizeList(source, 'ol', ctx, depth);
  if (source.image !== undefined) {
    const image = sanitizeImage(source, ctx);
    return image ? applyCommon(source, image, ctx, 'image') : null;
  }
  if (source.svg !== undefined) {
    const svg = sanitizeSvgNode(source, ctx);
    return svg ? applyCommon(source, svg, ctx, 'svg') : null;
  }
  if (source.canvas !== undefined) {
    const canvas = sanitizeCanvas(source.canvas, ctx);
    return canvas ? applyCommon(source, { canvas }, ctx, 'canvas') : null;
  }
  if (source.qr !== undefined) {
    if (typeof source.qr !== 'string' || !source.qr || source.qr.length > 2000) return null;
    const node = applyCommon(source, { qr: source.qr }, ctx, 'qr');
    const fit = clampNumber(source.fit, 20, 1000);
    if (fit !== undefined) node.fit = fit;
    if (isColor(source.foreground)) node.foreground = source.foreground;
    if (isColor(source.background)) node.background = source.background;
    if (['L', 'M', 'Q', 'H'].includes(source.eccLevel)) node.eccLevel = source.eccLevel;
    return node;
  }
  if (source.toc !== undefined) {
    ctx.hasToc = true;
    const title = typeof source.toc?.title === 'string' ? source.toc.title.slice(0, 200) : null;
    return { toc: { ...(title ? { title: { text: title, style: 'tocTitle' } } : {}) } };
  }
  warn(
    ctx,
    `Skipped a block without a known content key (${Object.keys(source).slice(0, 5).join(', ')}).`
  );
  return null;
}

/**
 * Sanitise a list of layout blocks.
 *
 * @param {unknown} blocks
 * @param {Object} ctx
 * @returns {Array<Object>}
 */
export function sanitizeBlocks(blocks, ctx) {
  if (blocks === undefined || blocks === null) return [];
  const list = Array.isArray(blocks) ? blocks : [blocks];
  return list.map(block => sanitizeNode(block, ctx, 0)).filter(Boolean);
}

/**
 * Sanitise user-defined paragraph styles (`styles` on the document).
 *
 * @param {unknown} styles
 * @param {Object} ctx
 * @returns {Object<string, Object>}
 */
export function sanitizeStyles(styles, ctx) {
  const out = {};
  if (!styles || typeof styles !== 'object' || Array.isArray(styles)) return out;
  for (const [name, style] of Object.entries(styles).slice(0, 100)) {
    if (!STYLE_NAME.test(name) || !style || typeof style !== 'object') continue;
    const clean = {};
    copyProps(style, clean, TEXT_PROPS, ctx, `style "${name}"`);
    const margin = sanitizeMargin(style.margin);
    if (margin !== undefined) clean.margin = margin;
    if (style.font !== undefined) clean.font = resolveFontFamily(style.font, ctx.theme.font);
    out[name] = clean;
  }
  return out;
}

/**
 * Sanitise the document's named image map. Only accepted images keep their
 * name, so a block referring to a refused image falls back to its warning.
 *
 * @param {unknown} images
 * @param {Object} ctx
 * @returns {Object<string, string>}
 */
export function sanitizeImageMap(images, ctx) {
  const out = {};
  if (!images || typeof images !== 'object' || Array.isArray(images)) return out;
  for (const [name, src] of Object.entries(images).slice(0, 50)) {
    if (!STYLE_NAME.test(name)) continue;
    const accepted = acceptImage(ctx, src, `image "${name}"`);
    if (accepted) out[name] = accepted;
  }
  return out;
}
