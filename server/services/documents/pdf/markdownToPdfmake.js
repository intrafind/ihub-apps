import { Lexer } from 'marked';
import { checkImageDataUri, fitWithin, imagePixelSize, safeLink, LIMITS } from './validators.js';

/**
 * Convert Markdown to pdfmake content.
 *
 * The `marked` lexer turns the text into tokens (GFM: tables, task lists,
 * strikethrough), and each token maps to a pdfmake node styled from the
 * document's theme. Nothing is rendered to HTML on the way.
 *
 * Supported beyond plain Markdown:
 * - `<sub>`/`<sup>` (H<sub>2</sub>O), `<u>`, `<mark>`, `<br>` inline HTML
 * - a page break: a line with `\pagebreak`, `\newpage` or `<!-- pagebreak -->`
 * - images as `data:image/png|jpeg;base64,…` URIs (others become their alt text)
 */

const PAGE_BREAK_MARKERS = new Set([
  String.raw`\pagebreak`,
  String.raw`\newpage`,
  '<!-- pagebreak -->'
]);
const PAGE_BREAK_HTML = /^<!--\s*page-?break\s*-->$|page-break-(before|after)\s*:\s*always/i;

/**
 * Record a warning once.
 *
 * @param {Object} ctx
 * @param {string} message
 */
export function warn(ctx, message) {
  if (!ctx.warnings) return;
  if (!ctx.warnings.includes(message) && ctx.warnings.length < 50) ctx.warnings.push(message);
}

function countNode(ctx) {
  ctx.nodeCount = (ctx.nodeCount || 0) + 1;
  if (ctx.nodeCount > LIMITS.maxNodes) {
    throw new Error(
      `Document is too large (more than ${LIMITS.maxNodes} layout elements). Split it into smaller documents.`
    );
  }
}

/**
 * Account an image against the document's image budget.
 *
 * @returns {string|null} The normalised data URI, or null when refused.
 */
export function acceptImage(ctx, src, label = 'image') {
  const check = checkImageDataUri(src);
  if (!check.ok) {
    warn(ctx, `Skipped ${label}: ${check.reason}.`);
    return null;
  }
  ctx.imageBytes = (ctx.imageBytes || 0) + check.bytes;
  if (ctx.imageBytes > LIMITS.maxTotalImageBytes) {
    warn(ctx, 'Skipped images beyond the 15 MB total image budget.');
    return null;
  }
  return check.dataUri;
}

function decodeEntities(text) {
  return String(text)
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll(/&#39;|&apos;/g, "'")
    .replaceAll('&nbsp;', ' ')
    .replaceAll(/&#(\d+);/g, (_, n) => safeFromCodePoint(Number(n)))
    .replaceAll(/&#x([0-9a-f]+);/gi, (_, n) => safeFromCodePoint(parseInt(n, 16)))
    .replaceAll('&amp;', '&');
}

function safeFromCodePoint(n) {
  try {
    return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
  } catch {
    return '';
  }
}

/**
 * The text of an HTML fragment. The result is drawn as PDF text, never
 * interpreted as markup; tags are removed until none are left (a single pass
 * would leave `<scr<b>ipt>` behind as `<script>`), then entities are decoded.
 */
function stripTags(html) {
  let text = String(html).replaceAll(/<br\s*\/?>/gi, '\n');
  let previous;
  do {
    previous = text;
    text = text.replaceAll(/<[^<>]*>/g, '');
  } while (text !== previous);
  return decodeEntities(text.replaceAll(/[<>]/g, ''));
}

const INLINE_HTML_TAGS = {
  sub: { sub: true },
  sup: { sup: true },
  u: { decoration: 'underline' },
  ins: { decoration: 'underline' },
  s: { decoration: 'lineThrough' },
  strike: { decoration: 'lineThrough' },
  del: { decoration: 'lineThrough' },
  b: { bold: true },
  strong: { bold: true },
  i: { italics: true },
  em: { italics: true },
  mark: { background: '#fef08a' },
  small: { fontSize: 'small' },
  code: { code: true },
  kbd: { code: true }
};

function runStyle(ctx, style) {
  const run = {};
  if (style.bold) run.bold = true;
  if (style.italics) run.italics = true;
  if (style.decoration) run.decoration = style.decoration;
  if (style.sub) run.sub = true;
  if (style.sup) run.sup = true;
  if (style.background) run.background = style.background;
  if (style.fontSize === 'small') run.fontSize = ctx.theme.baseFontSize - 1.5;
  if (style.code) {
    run.font = 'Mono';
    run.fontSize = ctx.theme.baseFontSize - 1;
    if (ctx.theme.inlineCodeBackground) run.background = ctx.theme.inlineCodeBackground;
  }
  if (style.link) {
    run.link = style.link;
    run.color = ctx.theme.link;
    run.decoration = 'underline';
  }
  return run;
}

/**
 * Inline tokens → pdfmake text runs.
 *
 * @param {Array} tokens
 * @param {Object} ctx
 * @param {Object} [style] - Inherited inline style.
 * @returns {Array<Object>}
 */
export function inlineRuns(tokens, ctx, style = {}) {
  const runs = [];
  // Inline HTML arrives as separate open/close tokens (`<sub>`, `2`, `</sub>`),
  // so the styles they switch on are tracked as a stack across siblings.
  const htmlStack = [];
  const effective = () => htmlStack.reduce((acc, s) => ({ ...acc, ...s }), style);
  const push = (text, extra = {}) => {
    if (text === '' || text === undefined || text === null) return;
    runs.push({ text: String(text), ...runStyle(ctx, { ...effective(), ...extra }) });
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
        runs.push(...inlineRuns(token.tokens, ctx, { ...effective(), decoration: 'lineThrough' }));
        break;
      case 'codespan':
        push(decodeEntities(token.text), { code: true });
        break;
      case 'br':
        push('\n');
        break;
      case 'link': {
        const href = safeLink(token.href);
        runs.push(
          ...inlineRuns(token.tokens, ctx, href ? { ...effective(), link: href } : effective())
        );
        break;
      }
      case 'image':
        // An image inside running text cannot be a pdfmake image; paragraphs
        // made only of images are handled a level up.
        push(token.text ? `[${token.text}]` : '', { italics: true });
        break;
      case 'html': {
        const raw = String(token.raw || token.text || '').trim();
        const open = /^<([a-z]+)\b[^>]*>$/i.exec(raw);
        const close = /^<\/([a-z]+)\s*>$/i.exec(raw);
        if (/^<br\s*\/?>$/i.test(raw)) push('\n');
        else if (open && INLINE_HTML_TAGS[open[1].toLowerCase()]) {
          htmlStack.push(INLINE_HTML_TAGS[open[1].toLowerCase()]);
        } else if (close && INLINE_HTML_TAGS[close[1].toLowerCase()]) {
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

function textNode(runs, extra = {}) {
  if (runs.length === 1 && Object.keys(runs[0]).length === 1)
    return { text: runs[0].text, ...extra };
  return { text: runs, ...extra };
}

function imageNode(ctx, token) {
  const src = acceptImage(ctx, token.href, token.text ? `image "${token.text}"` : 'image');
  if (!src) {
    return token.text ? { text: `[${token.text}]`, italics: true, style: 'caption' } : null;
  }
  countNode(ctx);
  const node = { image: src, ...naturalImageSize(src, ctx), margin: [0, 4, 0, 4] };
  if (!token.text) return node;
  return { stack: [node, { text: token.text, style: 'caption', margin: [0, 2, 0, 8] }] };
}

/**
 * pdfmake sizing for an image at its natural size (pixels at 96 dpi), scaled
 * down to fit the page. pdfmake would otherwise draw it at one point per
 * pixel, or — with `fit` alone — stretch small images to the full width.
 *
 * @param {string} dataUri
 * @param {Object} ctx
 * @returns {{ width: number } | { fit: [number, number] }}
 */
export function naturalImageSize(dataUri, ctx) {
  const pixels = imagePixelSize(dataUri);
  const natural = pixels ? { width: pixels.width * 0.75, height: pixels.height * 0.75 } : null;
  return fitWithin(natural, ctx.contentWidth, ctx.contentHeight);
}

function isPageBreakParagraph(token) {
  const text = String(token.text || '').trim();
  return PAGE_BREAK_MARKERS.has(text);
}

function codeBlock(ctx, token) {
  const code = String(token.text || '').replaceAll('\t', '    ');
  const lines = code.split('\n');
  return {
    table: {
      widths: ['*'],
      body: [
        [
          {
            text: lines.join('\n'),
            style: 'code',
            preserveLeadingSpaces: true
          }
        ]
      ]
    },
    layout: 'ihubCode',
    margin: [0, 2, 0, 9]
  };
}

function tableWidths(token) {
  const columns = token.header.length;
  const lengths = new Array(columns).fill(0);
  const measure = cell => String(cell?.text || '').length;
  token.header.forEach((cell, i) => {
    lengths[i] = Math.max(lengths[i], Math.min(measure(cell), 60));
  });
  for (const row of token.rows) {
    row.forEach((cell, i) => {
      if (i < columns) lengths[i] = Math.max(lengths[i], Math.min(measure(cell), 60));
    });
  }
  const total = lengths.reduce((a, b) => a + b, 0);
  // Narrow tables size to their content; anything that could overflow the
  // line shares the width, short columns keep their natural size.
  if (total <= 60) return lengths.map(() => 'auto');
  return lengths.map(len => (len <= 12 ? 'auto' : '*'));
}

function tableNode(ctx, token) {
  if (token.rows.length > LIMITS.maxTableRows) {
    warn(ctx, `Table truncated to ${LIMITS.maxTableRows} rows.`);
  }
  const columns = token.header.length;
  const alignment = i => (token.align?.[i] ? token.align[i] : undefined);
  const cell = (c, i, header) => {
    countNode(ctx);
    const runs = inlineRuns(c.tokens, ctx);
    const node = textNode(runs.length ? runs : [{ text: '' }], {
      style: header ? 'tableHeader' : 'tableCell'
    });
    if (alignment(i)) node.alignment = alignment(i);
    return node;
  };
  const body = [token.header.map((c, i) => cell(c, i, true))];
  for (const row of token.rows.slice(0, LIMITS.maxTableRows)) {
    const cells = row.slice(0, columns).map((c, i) => cell(c, i, false));
    while (cells.length < columns) cells.push({ text: '' });
    body.push(cells);
  }
  return {
    table: { headerRows: 1, widths: tableWidths(token), body, dontBreakRows: true },
    layout: 'ihubTable',
    margin: [0, 2, 0, 10]
  };
}

function listNode(ctx, token, depth) {
  const items = token.items.map(item => {
    countNode(ctx);
    const content = blockNodes(item.tokens, ctx, depth + 1, { tight: true });
    let node = content.length === 1 ? content[0] : { stack: content };
    if (item.task) {
      // A task item replaces its bullet with a box.
      const box = { text: item.checked ? '☑ ' : '☐ ', font: 'Sans' };
      node =
        content.length === 1 && content[0].text !== undefined
          ? { text: [box, ...(Array.isArray(content[0].text) ? content[0].text : [content[0]])] }
          : { stack: [{ text: [box] }, ...content] };
      node.listType = 'none';
    }
    return node;
  });
  const node = token.ordered ? { ol: items } : { ul: items };
  if (token.ordered && Number.isInteger(token.start) && token.start !== 1) node.start = token.start;
  node.markerColor = ctx.theme.primary;
  node.margin = depth === 0 ? [0, 0, 0, 7] : [0, 1, 0, 1];
  return node;
}

function quoteNode(ctx, token, depth) {
  const content = blockNodes(token.tokens, ctx, depth + 1, { tight: true });
  return {
    table: { widths: ['*'], body: [[{ stack: content, style: 'quote' }]] },
    layout: 'ihubQuote',
    margin: [0, 2, 0, 9]
  };
}

/** Whether a heading is drawn with a rule under it (see `headingNode`). */
function hasHeadingRule(ctx, level) {
  return Boolean(ctx.theme.headingRule) && level <= 2 && !(ctx.containerDepth > 0);
}

function headingNode(ctx, token, depth = 0) {
  const runs = inlineRuns(token.tokens, ctx);
  const level = Math.min(Math.max(token.depth, 1), 6);
  // `headlineLevel` drives the rule that keeps a heading with what follows it
  // (see `buildDocument.js`). It is only set in the document flow: a page
  // break inside a list item, a quote or a table cell would tear that apart.
  const inFlow = depth === 0 && !(ctx.containerDepth > 0);
  const node = textNode(runs.length ? runs : [{ text: '' }], {
    style: `h${level}`,
    ...(inFlow ? { headlineLevel: level } : {})
  });
  if (ctx.tocDepth && level <= ctx.tocDepth) {
    node.tocItem = true;
    node.tocStyle = level === 1 ? { bold: true } : undefined;
    node.tocMargin = [(level - 1) * 12, level === 1 ? 4 : 1, 0, 0];
  }
  // Inside columns, boxes and table cells a rule would only add noise.
  if (!hasHeadingRule(ctx, level)) return node;
  // A rule under the two top heading levels: the bottom border of a one-cell
  // table, so it is exactly as wide as whatever holds the heading.
  return {
    table: { widths: ['*'], body: [[{ ...node, margin: [0, 0, 0, 0] }]] },
    layout: {
      declarative: {
        ruleColor: level === 1 ? ctx.theme.primary : ctx.theme.border,
        ruleWidth: level === 1 ? 1.2 : 0.6,
        paddingBottom: 3
      }
    },
    ...(inFlow ? { headlineLevel: level } : {}),
    margin: level === 1 ? [0, 14, 0, 8] : [0, 12, 0, 6]
  };
}

function hrNode(ctx) {
  return {
    table: { widths: ['*'], body: [[{ text: '', fontSize: 1 }]] },
    layout: { declarative: { ruleColor: ctx.theme.border, ruleWidth: 0.75, paddingBottom: 0 } },
    margin: [0, 6, 0, 10]
  };
}

/**
 * Block tokens → pdfmake nodes.
 *
 * @param {Array} tokens
 * @param {Object} ctx
 * @param {number} [depth]
 * @param {{ tight?: boolean }} [options] - Inside a list item or quote: no
 *   paragraph spacing after the last paragraph.
 * @returns {Array<Object>}
 */
export function blockNodes(tokens, ctx, depth = 0, options = {}) {
  if (depth > LIMITS.maxDepth) {
    warn(ctx, 'Deeply nested content was flattened.');
    return [];
  }
  const nodes = [];
  for (const token of tokens || []) {
    countNode(ctx);
    switch (token.type) {
      case 'space':
      case 'def':
        break;
      case 'heading':
        nodes.push(headingNode(ctx, token, depth));
        break;
      case 'paragraph': {
        if (isPageBreakParagraph(token)) {
          nodes.push({ text: '', pageBreak: 'after' });
          break;
        }
        const inline = token.tokens || [];
        const images = inline.filter(t => t.type === 'image');
        const onlyImages =
          images.length > 0 &&
          inline.every(t => t.type === 'image' || (t.type === 'text' && !t.text.trim()));
        if (onlyImages) {
          for (const image of images) {
            const node = imageNode(ctx, image);
            if (node) nodes.push(node);
          }
          break;
        }
        const runs = inlineRuns(inline, ctx);
        if (runs.length) {
          nodes.push(
            textNode(runs, options.tight ? { margin: [0, 0, 0, 3] } : { style: 'paragraph' })
          );
        }
        break;
      }
      case 'text': {
        // Loose text inside a list item.
        const runs = token.tokens ? inlineRuns(token.tokens, ctx) : [{ text: token.text }];
        if (runs.length) nodes.push(textNode(runs));
        break;
      }
      case 'list':
        nodes.push(listNode(ctx, token, depth));
        break;
      case 'table':
        nodes.push(tableNode(ctx, token));
        break;
      case 'code':
        nodes.push(codeBlock(ctx, token));
        break;
      case 'blockquote':
        nodes.push(quoteNode(ctx, token, depth));
        break;
      case 'hr':
        nodes.push(hrNode(ctx));
        break;
      case 'html': {
        const raw = String(token.raw || token.text || '').trim();
        if (PAGE_BREAK_MARKERS.has(raw) || PAGE_BREAK_HTML.test(raw)) {
          nodes.push({ text: '', pageBreak: 'after' });
          break;
        }
        const text = stripTags(raw).trim();
        if (text) nodes.push({ text, style: 'paragraph' });
        break;
      }
      default:
        if (token.tokens?.length) {
          const runs = inlineRuns(token.tokens, ctx);
          if (runs.length) nodes.push(textNode(runs, { style: 'paragraph' }));
        } else if (typeof token.text === 'string' && token.text.trim()) {
          nodes.push({ text: decodeEntities(token.text), style: 'paragraph' });
        }
    }
  }
  return nodes;
}

/** The plain text of inline tokens, without any formatting. */
function plainText(tokens) {
  return (tokens || [])
    .map(token => {
      if (token.tokens?.length) return plainText(token.tokens);
      if (token.type === 'html') return '';
      return decodeEntities(token.text ?? '');
    })
    .join('');
}

/** Text compared without case, punctuation, symbols or extra spaces. */
function comparable(text) {
  return String(text)
    .normalize('NFKC')
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Tidy the top level of a document body for print.
 *
 * - A first heading that only repeats the title printed above it is left
 *   out. Markdown written for the screen (and the models) usually opens with
 *   `# <title>`, which would put the title on the page twice.
 * - A rule (`---`) at the start or the end, after another rule, or next to a
 *   heading that draws its own rule is left out. Screen Markdown separates
 *   its sections with rules; on paper they double the heading rules.
 *
 * @param {Array} tokens - Top-level tokens from the lexer.
 * @param {Object} ctx
 * @param {string} [title] - The title printed above the body, if any.
 * @returns {Array}
 */
function tidyBody(tokens, ctx, title) {
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
  const ruledHeading = token => token?.type === 'heading' && hasHeadingRule(ctx, token.depth);
  const out = [];
  for (const token of blocks) {
    const previous = out.at(-1);
    if (token.type === 'hr' && (!previous || previous.type === 'hr' || ruledHeading(previous))) {
      continue;
    }
    if (ruledHeading(token) && previous?.type === 'hr') out.pop();
    out.push(token);
  }
  while (out.at(-1)?.type === 'hr') out.pop();
  return out;
}

/**
 * Convert a Markdown string to pdfmake content.
 *
 * @param {string} markdown
 * @param {Object} ctx - Conversion context: `theme`, `contentWidth`,
 *   `contentHeight`, optional `tocDepth`, `breaks` (single newlines are line
 *   breaks, as in chat) and a `warnings` array.
 * @param {Object} [options]
 * @param {boolean} [options.body] - The Markdown is the document body (not a
 *   layout block): tidy it for print (see `tidyBody`).
 * @param {string} [options.title] - With `body`: the title printed above it.
 * @returns {Array<Object>}
 */
export function markdownToContent(markdown, ctx, { body = false, title } = {}) {
  const text = String(markdown ?? '');
  if (text.length > LIMITS.maxMarkdownChars) {
    throw new Error('Markdown content is too long to render as one document.');
  }
  const tokens = new Lexer({ gfm: true, breaks: Boolean(ctx.breaks) }).lex(text);
  return blockNodes(body ? tidyBody(tokens, ctx, title) : tokens, ctx);
}
