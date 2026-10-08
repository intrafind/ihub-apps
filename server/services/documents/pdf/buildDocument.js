import { DEFAULT_FONT } from './fonts.js';
import { makePrintable, printableString } from './glyphs.js';
import { markdownToContent } from './markdownToPdfmake.js';
import { sanitizeBlocks, sanitizeImageMap, sanitizeStyles } from './sanitizeBlocks.js';
import { isColor, resolveTheme, themeStyles } from './themes.js';
import { clampNumber, sanitizeMargin } from './validators.js';

/**
 * Build a pdfmake document definition from a document spec.
 *
 * A spec is plain JSON — what the `create_pdf` tool, the export endpoint and
 * any future caller send. Everything pdfmake needs as a function (table
 * layouts, header, footer, the orphan-heading rule) is created here, which is
 * why building runs inside the render worker together with rendering.
 *
 * @typedef {Object} PdfSpec
 * @property {string} [title]
 * @property {string} [subtitle]
 * @property {string} [author]
 * @property {string} [subject]
 * @property {string} [keywords]
 * @property {string} [language] - e.g. `en`, `de`; labels and PDF metadata.
 * @property {string} [date] - Shown on the cover page.
 * @property {string} [markdown] - Body in Markdown.
 * @property {Array} [blocks] - Layout blocks (see `sanitizeBlocks.js`), after the Markdown.
 * @property {Object} [styles] - Named text styles for blocks.
 * @property {Object} [images] - Named `data:` images for blocks.
 * @property {string} [theme] - `default` | `professional` | `minimal`.
 * @property {Object} [themeOptions] - `primaryColor`, `accentColor`, `font`, `fontSize`.
 * @property {Object} [page] - `size`, `orientation`, `margins`.
 * @property {string|false} [header] - Text with `{page}`, `{pages}`, `{title}`, `{date}`.
 * @property {string|false} [footer]
 * @property {boolean} [pageNumbers] - Default true.
 * @property {boolean|Object} [coverPage]
 * @property {boolean|Object} [toc] - `{ title, depth }`.
 * @property {string|Object} [watermark] - Text, or `{ text, opacity, color, angle, position }`;
 *   `position` `bottom-left|bottom-center|bottom-right` draws a small label
 *   above the footer instead of the diagonal stamp.
 * @property {boolean} [markdownBreaks] - Single newlines break lines (chat text).
 */

export const PAGE_SIZES = Object.freeze({
  A3: [841.89, 1190.55],
  A4: [595.28, 841.89],
  A5: [419.53, 595.28],
  LETTER: [612, 792],
  LEGAL: [612, 1008],
  TABLOID: [792, 1224]
});

export const MAX_PAGES = 500;

/** Watermark positions drawn as a small label rather than diagonally. */
const CORNER_WATERMARKS = {
  'bottom-left': 'left',
  'bottom-center': 'center',
  'bottom-right': 'right'
};

/**
 * Work the orphan-heading rule may add, in layout nodes times extra layout
 * passes. pdfmake lays the whole document out again for every break the rule
 * asks for, so a long document gets fewer breaks (a very long one none),
 * which keeps the extra time to a few seconds.
 */
const ORPHAN_RULE_BUDGET = 16000;

/**
 * Style name of everything drawn around the text (header, footer, corner
 * watermark), so the orphan-heading rule can tell it from the content.
 */
const DECORATION_STYLE = 'pageDecoration';

/** Lines of the following block a heading needs below it on its page. */
const KEEP_WITH_HEADING_LINES = 2;

const LABELS = {
  en: { page: 'Page {page} of {pages}', contents: 'Contents' },
  de: { page: 'Seite {page} von {pages}', contents: 'Inhalt' },
  fr: { page: 'Page {page} sur {pages}', contents: 'Sommaire' },
  es: { page: 'Página {page} de {pages}', contents: 'Índice' },
  it: { page: 'Pagina {page} di {pages}', contents: 'Indice' },
  nl: { page: 'Pagina {page} van {pages}', contents: 'Inhoud' }
};

function labelsFor(language) {
  const key = typeof language === 'string' ? language.slice(0, 2).toLowerCase() : 'en';
  return LABELS[key] || LABELS.en;
}

function str(value, max = 500) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
}

function pageSetup(page = {}) {
  const sizeName = typeof page.size === 'string' ? page.size.toUpperCase() : 'A4';
  const size = PAGE_SIZES[sizeName] ? sizeName : 'A4';
  const orientation = page.orientation === 'landscape' ? 'landscape' : 'portrait';
  let [width, height] = PAGE_SIZES[size];
  if (orientation === 'landscape') [width, height] = [height, width];
  let margins = sanitizeMargin(page.margins, 150);
  if (margins === undefined) margins = [50, 62, 50, 62];
  if (typeof margins === 'number') margins = [margins, margins, margins, margins];
  if (margins.length === 2) margins = [margins[0], margins[1], margins[0], margins[1]];
  // Header and footer live in the top and bottom margins.
  margins = margins.map((m, i) => (i % 2 === 1 ? Math.max(m, 36) : Math.max(m, 18)));
  return {
    size,
    orientation,
    width,
    height,
    margins,
    contentWidth: width - margins[0] - margins[2],
    contentHeight: height - margins[1] - margins[3]
  };
}

function fillTemplate(template, values) {
  return template.replace(/\{(page|pages|title|date)\}/g, (_, key) => String(values[key] ?? ''));
}

function isDecoration(nodeInfo) {
  const style = nodeInfo?.style;
  return Array.isArray(style) ? style.includes(DECORATION_STYLE) : style === DECORATION_STYLE;
}

/**
 * pdfmake's `pageBreakBefore`: never leave a heading at the bottom of a page
 * without at least the start of what it introduces.
 *
 * A heading moves to the next page when nothing but headings follows it on
 * its page, or when the block after it starts so low that fewer than
 * {@link KEEP_WITH_HEADING_LINES} lines of it stay with the heading. A
 * heading drawn with a rule is a table holding the heading text; both carry
 * `headlineLevel`, so headings are skipped when looking around one and the
 * two always decide alike.
 *
 * @param {Object} theme
 * @param {number} [maxBreaks] - Breaks to ask for at most (each one costs a
 *   layout pass); later headings stay where they are.
 * @returns {Function}
 */
export function keepHeadingsWithContent(theme, maxBreaks = Infinity) {
  // pdfkit draws a DejaVu line at about 1.17 em, times the line height.
  const minKeep = KEEP_WITH_HEADING_LINES * theme.baseFontSize * theme.lineHeight * 1.2;
  const isContent = nodeInfo => !isDecoration(nodeInfo) && !nodeInfo.headlineLevel;
  let breaks = 0;
  const strandedAtPageEnd = nodes => {
    const next = nodes.getFollowingNodesOnPage().find(isContent);
    if (!next) return nodes.getNodesOnNextPage().some(isContent);
    const start = next.startPosition;
    if (next.pageNumbers?.length < 2 || !start?.pageInnerHeight) return false;
    return start.pageInnerHeight * (1 - start.verticalRatio) < minKeep;
  };
  return (currentNode, nodes) => {
    if (breaks >= maxBreaks) return false;
    if (!currentNode.headlineLevel || currentNode.pageNumbers?.length !== 1) return false;
    if (!strandedAtPageEnd(nodes)) return false;
    // A heading that already starts its page stays there; moving it would
    // only leave an empty page behind.
    if (!nodes.getPreviousNodesOnPage().some(isContent)) return false;
    breaks += 1;
    return true;
  };
}

/** Table layouts shared by every document, in pdfmake's function form. */
export function tableLayouts(theme) {
  const light = theme.border;
  const stripe = (i, headerRows) =>
    i >= headerRows && theme.tableStripeFill && (i - headerRows) % 2 === 1
      ? theme.tableStripeFill
      : null;
  return {
    ihubTable: {
      fillColor: (i, node) =>
        i < (node.table.headerRows || 0)
          ? theme.tableHeaderFill
          : stripe(i, node.table.headerRows || 0),
      hLineWidth: (i, node) =>
        theme.tableLines === 'horizontal'
          ? i === 0 || i === node.table.body.length
            ? 0.8
            : i === (node.table.headerRows || 0)
              ? 0.8
              : 0.4
          : 0.5,
      vLineWidth: () => (theme.tableLines === 'horizontal' ? 0 : 0.5),
      hLineColor: (i, node) =>
        theme.tableLines === 'horizontal' && (i === 0 || i === node.table.body.length)
          ? theme.text
          : light,
      vLineColor: () => light,
      paddingLeft: () => 6,
      paddingRight: () => 6,
      paddingTop: () => 4,
      paddingBottom: () => 4
    },
    ihubGrid: {
      hLineWidth: () => 0.5,
      vLineWidth: () => 0.5,
      hLineColor: () => light,
      vLineColor: () => light,
      paddingLeft: () => 6,
      paddingRight: () => 6,
      paddingTop: () => 4,
      paddingBottom: () => 4
    },
    ihubPlain: {
      hLineWidth: () => 0,
      vLineWidth: () => 0,
      paddingLeft: () => 0,
      paddingRight: () => 8,
      paddingTop: () => 2,
      paddingBottom: () => 2
    },
    ihubCode: {
      fillColor: () => theme.codeBackground,
      hLineWidth: () => (theme.codeBackground ? 0 : 0.5),
      vLineWidth: () => (theme.codeBackground ? 0 : 0.5),
      hLineColor: () => light,
      vLineColor: () => light,
      paddingLeft: () => 9,
      paddingRight: () => 9,
      paddingTop: () => 7,
      paddingBottom: () => 7
    },
    ihubQuote: {
      hLineWidth: () => 0,
      vLineWidth: i => (i === 0 ? 3 : 0),
      vLineColor: () => theme.quoteBorder,
      paddingLeft: () => 11,
      paddingRight: () => 4,
      paddingTop: () => 2,
      paddingBottom: () => 2
    }
  };
}

/**
 * Turn a declarative layout (from `sanitizeBlocks.js`) into pdfmake's
 * function-based layout.
 */
function declarativeLayout(spec, theme) {
  if (spec.ruleColor !== undefined) {
    // A rule: only the bottom border of a one-cell table.
    return {
      hLineWidth: (i, node) => (i === node.table.body.length ? (spec.ruleWidth ?? 0.75) : 0),
      vLineWidth: () => 0,
      hLineColor: () => spec.ruleColor,
      paddingLeft: () => 0,
      paddingRight: () => 0,
      paddingTop: () => 0,
      paddingBottom: () => spec.paddingBottom ?? 0
    };
  }
  if (spec.boxBorder !== undefined) {
    const width = spec.boxBorderWidth ?? 3;
    const border = spec.boxBorder;
    return {
      fillColor: () => spec.boxFill || null,
      hLineWidth: () => (spec.boxFullBorder && border ? width : 0),
      vLineWidth: i => (!border ? 0 : spec.boxFullBorder ? width : i === 0 ? width : 0),
      hLineColor: () => border,
      vLineColor: () => border,
      paddingLeft: () => spec.paddingLeft ?? 10,
      paddingRight: () => spec.paddingRight ?? 10,
      paddingTop: () => spec.paddingTop ?? 8,
      paddingBottom: () => spec.paddingBottom ?? 8
    };
  }
  const hWidth = spec.hLineWidth ?? 0.5;
  const vWidth = spec.vLineWidth ?? 0.5;
  return {
    hLineWidth: (i, node) =>
      spec.outerBorderOnly ? (i === 0 || i === node.table.body.length ? hWidth : 0) : hWidth,
    vLineWidth: (i, node) =>
      spec.outerBorderOnly ? (i === 0 || i === node.table.widths.length ? vWidth : 0) : vWidth,
    hLineColor: () => spec.hLineColor || theme.border,
    vLineColor: () => spec.vLineColor || theme.border,
    fillColor: (i, node) => {
      const headerRows = node.table.headerRows || 0;
      if (i < headerRows) return spec.headerFill || null;
      return spec.stripeFill && (i - headerRows) % 2 === 1 ? spec.stripeFill : null;
    },
    paddingLeft: () => spec.paddingLeft ?? 6,
    paddingRight: () => spec.paddingRight ?? 6,
    paddingTop: () => spec.paddingTop ?? 4,
    paddingBottom: () => spec.paddingBottom ?? 4
  };
}

function resolveLayouts(node, theme, imageCallback, font) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) resolveLayouts(child, theme, imageCallback, font);
    return;
  }
  if (node.layout && typeof node.layout === 'object' && node.layout.declarative) {
    node.layout = declarativeLayout(node.layout.declarative, theme);
  }
  if (node.svg !== undefined) {
    // svg-to-pdfkit would otherwise open <image> targets with pdfkit, which
    // reads local files for anything that is not a data: URI.
    node.options = { imageCallback, warningCallback: () => {} };
    node.font = font;
  }
  for (const key of ['stack', 'columns', 'ul', 'ol']) {
    if (Array.isArray(node[key])) resolveLayouts(node[key], theme, imageCallback, font);
  }
  if (Array.isArray(node.text)) resolveLayouts(node.text, theme, imageCallback, font);
  if (node.table && Array.isArray(node.table.body)) {
    for (const row of node.table.body) resolveLayouts(row, theme, imageCallback, font);
  }
}

function coverPage(spec, theme, setup) {
  const cover = spec.coverPage && typeof spec.coverPage === 'object' ? spec.coverPage : {};
  const title = str(cover.title) || str(spec.title) || '';
  const subtitle = str(cover.subtitle) || str(spec.subtitle);
  const author = str(cover.author) || str(spec.author);
  const date = str(cover.date) || str(spec.date);
  const note = str(cover.note, 2000);
  const nodes = [
    { text: '', margin: [0, setup.contentHeight * 0.28, 0, 0] },
    {
      canvas: [
        {
          type: 'rect',
          x: 0,
          y: 0,
          w: 60,
          h: 5,
          color: theme.primary
        }
      ],
      margin: [0, 0, 0, 18]
    },
    { text: title, style: 'title', margin: [0, 0, 0, 10] }
  ];
  if (subtitle) nodes.push({ text: subtitle, style: 'subtitle', margin: [0, 0, 0, 28] });
  const meta = [author, date].filter(Boolean);
  if (meta.length) nodes.push({ text: meta.join('  ·  '), style: 'muted', margin: [0, 8, 0, 0] });
  if (note) nodes.push({ text: note, style: 'small', margin: [0, 40, 0, 0] });
  nodes.push({ text: '', pageBreak: 'after' });
  return nodes;
}

/**
 * Build the document definition.
 *
 * @param {PdfSpec} spec
 * @param {Object} [options]
 * @param {Function} [options.svgImageCallback] - See `validators.js`.
 * @returns {{ docDefinition: Object, tableLayouts: Object, warnings: string[], setup: Object, pageInfo: { total: number } }}
 */
export function buildDocument(spec, { svgImageCallback } = {}) {
  if (!spec || typeof spec !== 'object') throw new Error('A document spec is required.');
  const theme = resolveTheme(spec.theme, spec.themeOptions || {});
  const setup = pageSetup(spec.page || {});
  const labels = labelsFor(spec.language);
  const warnings = [];
  const tocRequested = Boolean(spec.toc);
  const tocDepth = tocRequested
    ? clampNumber(spec.toc?.depth, 1, 6) || 3
    : Array.isArray(spec.blocks) && spec.blocks.some(b => b && typeof b === 'object' && b.toc)
      ? 3
      : 0;
  const ctx = {
    theme,
    contentWidth: setup.contentWidth,
    contentHeight: setup.contentHeight,
    tocDepth,
    breaks: Boolean(spec.markdownBreaks),
    warnings,
    nodeCount: 0,
    imageBytes: 0
  };

  const images = sanitizeImageMap(spec.images, ctx);
  ctx.imageNames = new Map(Object.entries(images));
  const styles = { ...themeStyles(theme), ...sanitizeStyles(spec.styles, ctx) };

  const hasCover = Boolean(spec.coverPage);
  // The title is printed right above the body (no cover page, no contents).
  const titleOnTop = !hasCover && !tocRequested && str(spec.title) && spec.showTitle !== false;

  const body = [];
  if (typeof spec.markdown === 'string' && spec.markdown.trim()) {
    body.push(
      ...markdownToContent(spec.markdown, ctx, {
        body: true,
        title: titleOnTop ? str(spec.title) : undefined
      })
    );
  }
  if (spec.blocks !== undefined) body.push(...sanitizeBlocks(spec.blocks, ctx));
  if (!body.length) {
    throw new Error('The document has no content. Provide markdown and/or blocks.');
  }

  const content = [];
  if (hasCover) content.push(...coverPage(spec, theme, setup));
  if (tocRequested) {
    const tocTitle = str(spec.toc?.title, 200) || labels.contents;
    content.push({ toc: { title: { text: tocTitle, style: 'tocTitle' } } });
    content.push({ text: '', pageBreak: 'after' });
  } else if (titleOnTop) {
    content.push({
      text: str(spec.title),
      style: 'title',
      fontSize: theme.baseFontSize * 2.1,
      margin: [0, 0, 0, 4]
    });
    if (str(spec.subtitle)) {
      content.push({ text: str(spec.subtitle), style: 'subtitle', margin: [0, 0, 0, 14] });
    } else {
      content.push({ text: '', margin: [0, 0, 0, 8] });
    }
  }
  content.push(...body);

  resolveLayouts(content, theme, svgImageCallback, theme.font);
  makePrintable(content, { font: theme.font, styles }, ctx);

  const title = str(spec.title) || 'Document';
  const date = str(spec.date) || new Date().toISOString().slice(0, 10);
  const pageInfo = { total: 0 };
  const firstDecoratedPage = hasCover ? 2 : 1;
  const headerText =
    spec.header === false || spec.header === undefined || spec.header === null
      ? null
      : printableString(str(spec.header, 300) || '', theme.font);
  const footerText =
    spec.footer === false || spec.footer === undefined || spec.footer === null
      ? null
      : printableString(str(spec.footer, 300) || '', theme.font);
  const pageNumbers = spec.pageNumbers !== false;
  const orphanBreaks = Math.floor(ORPHAN_RULE_BUDGET / Math.max(ctx.nodeCount, 1));
  const decoColor = theme.muted;
  const decoSize = Math.max(7, theme.baseFontSize - 2.5);

  const docDefinition = {
    pageSize: setup.size,
    pageOrientation: setup.orientation,
    pageMargins: setup.margins,
    info: {
      title,
      ...(str(spec.author) ? { author: str(spec.author) } : {}),
      ...(str(spec.subject) ? { subject: str(spec.subject) } : {}),
      ...(str(spec.keywords) ? { keywords: str(spec.keywords) } : {}),
      creator: 'iHub Apps',
      producer: 'iHub Apps'
    },
    ...(str(spec.language, 20) ? { language: str(spec.language, 20) } : {}),
    defaultStyle: {
      font: theme.font,
      fontSize: theme.baseFontSize,
      lineHeight: theme.lineHeight,
      color: theme.text
    },
    styles: { ...styles, [DECORATION_STYLE]: { fontSize: decoSize, color: decoColor } },
    images,
    content,
    maxPagesNumber: MAX_PAGES,
    // Never leave a heading alone at the bottom of a page, within the
    // budget for the layout passes that costs.
    ...(orphanBreaks > 0 ? { pageBreakBefore: keepHeadingsWithContent(theme, orphanBreaks) } : {}),
    header: headerText
      ? (currentPage, pageCount) =>
          currentPage < firstDecoratedPage
            ? null
            : {
                text: fillTemplate(headerText, {
                  page: currentPage,
                  pages: pageCount,
                  title,
                  date
                }),
                alignment: 'left',
                style: DECORATION_STYLE,
                margin: [
                  setup.margins[0],
                  Math.max(14, setup.margins[1] / 2 - 6),
                  setup.margins[2],
                  0
                ]
              }
      : undefined,
    footer: (currentPage, pageCount) => {
      pageInfo.total = pageCount;
      if (currentPage < firstDecoratedPage || (!footerText && !pageNumbers)) return null;
      const values = { page: currentPage, pages: pageCount, title, date };
      return {
        columns: [
          footerText
            ? { text: fillTemplate(footerText, values), alignment: 'left', style: DECORATION_STYLE }
            : { text: '' },
          pageNumbers
            ? {
                text: fillTemplate(labels.page, values),
                alignment: 'right',
                width: 'auto',
                style: DECORATION_STYLE
              }
            : { text: '', width: 'auto' }
        ],
        style: DECORATION_STYLE,
        margin: [setup.margins[0], Math.max(12, setup.margins[3] / 2 - 4), setup.margins[2], 0]
      };
    }
  };

  const watermark = typeof spec.watermark === 'string' ? { text: spec.watermark } : spec.watermark;
  const cornerPosition = CORNER_WATERMARKS[watermark?.position];
  if (watermark && typeof watermark === 'object' && str(watermark.text, 80) && cornerPosition) {
    // A small label on every page, between the text and the footer — the
    // chat export's "watermark" (bottom left, centre or right).
    const text = printableString(str(watermark.text, 80), DEFAULT_FONT);
    const opacity = clampNumber(watermark.opacity, 0.05, 1) ?? 0.5;
    docDefinition.background = (currentPage, pageSize) => ({
      text,
      style: DECORATION_STYLE,
      font: DEFAULT_FONT,
      fontSize: decoSize,
      color: isColor(watermark.color) ? watermark.color : theme.muted,
      opacity,
      alignment: cornerPosition,
      margin: [setup.margins[0], pageSize.height - setup.margins[3] + 6, setup.margins[2], 0]
    });
  } else if (watermark && typeof watermark === 'object' && str(watermark.text, 80)) {
    docDefinition.watermark = {
      text: printableString(str(watermark.text, 80), DEFAULT_FONT),
      font: DEFAULT_FONT,
      color: isColor(watermark.color) ? watermark.color : '#9ca3af',
      opacity: clampNumber(watermark.opacity, 0.02, 1) ?? 0.12,
      bold: true,
      ...(clampNumber(watermark.angle, -90, 90) !== undefined
        ? { angle: clampNumber(watermark.angle, -90, 90) }
        : {})
    };
  }

  if (ctx.hasToc && !tocRequested) {
    // A toc block in the layout: headings become entries automatically.
    for (const node of content) {
      if (node?.toc && !node.toc.title)
        node.toc.title = { text: labels.contents, style: 'tocTitle' };
    }
  }
  return { docDefinition, tableLayouts: tableLayouts(theme), warnings, setup, pageInfo };
}
