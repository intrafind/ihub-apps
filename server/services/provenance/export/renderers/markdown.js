/**
 * Markdown handling shared by the renderers.
 *
 * - `lexMarkdown` turns message content into `marked` block tokens, which the
 *   PDF, DOCX and PPTX renderers walk to build their own layout.
 * - `inlineSegments` flattens inline tokens into styled text segments.
 * - `renderMarkdownToSafeHtml` produces the HTML body of the HTML export.
 *
 * Both `marked` instances use GFM with `breaks: true`, like the former
 * browser export (`client/src/api/endpoints/apps.js`), so single newlines
 * stay line breaks.
 *
 * @module services/provenance/export/renderers/markdown
 */
import { Marked } from 'marked';
import { decodeHtmlEntities, escapeHtml, isSafeLinkTarget } from './common.js';

/**
 * A run of inline text with one style.
 *
 * @typedef {Object} InlineSegment
 * @property {string} text - the text ('' for a line break)
 * @property {boolean} [br] - a hard line break
 * @property {boolean} [bold]
 * @property {boolean} [italic]
 * @property {boolean} [code] - inline code
 * @property {boolean} [strike]
 * @property {string} [link] - link target
 */

const lexerInstance = new Marked({ gfm: true, breaks: true });

/**
 * Split markdown into block tokens.
 *
 * @param {string} content - markdown source
 * @returns {Array<Object>} marked block tokens; a lexer failure yields one plain paragraph
 */
export function lexMarkdown(content) {
  const source = typeof content === 'string' ? content.replace(/\r\n?/g, '\n') : '';
  if (!source.trim()) return [];
  try {
    return lexerInstance.lexer(source);
  } catch {
    return [
      {
        type: 'paragraph',
        raw: source,
        text: source,
        tokens: [{ type: 'text', raw: source, text: source }]
      }
    ];
  }
}

const BR_TAG = /^<br\s*\/?>$/i;

/**
 * Strip HTML tags from raw HTML found in markdown, keeping the text.
 *
 * @param {string} html - raw HTML
 * @returns {string} the text content
 */
export function stripHtmlTags(html) {
  return decodeHtmlEntities(
    String(html || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
      .replace(/<[^>]*>/g, '')
  ).trim();
}

/**
 * Flatten inline tokens into styled segments.
 *
 * Raw inline HTML is not interpreted: `<br>` becomes a line break and other
 * tags are dropped, keeping their text. Images become "[Image: alt]".
 *
 * @param {Array<Object>} tokens - marked inline tokens
 * @param {{imageLabel?: string}} [options] - localised word for "Image"
 * @param {Object} [style] - style inherited from enclosing tokens (internal)
 * @returns {InlineSegment[]} the segments in reading order
 */
export function inlineSegments(tokens, options = {}, style = {}) {
  const out = [];
  const push = (text, extra = {}) => {
    if (text) out.push({ ...style, ...extra, text });
  };
  for (const token of Array.isArray(tokens) ? tokens : []) {
    switch (token.type) {
      case 'text':
        if (Array.isArray(token.tokens) && token.tokens.length > 0) {
          out.push(...inlineSegments(token.tokens, options, style));
        } else {
          push(decodeHtmlEntities(token.text));
        }
        break;
      case 'escape':
        push(token.text);
        break;
      case 'strong':
        out.push(...inlineSegments(token.tokens, options, { ...style, bold: true }));
        break;
      case 'em':
        out.push(...inlineSegments(token.tokens, options, { ...style, italic: true }));
        break;
      case 'del':
        out.push(...inlineSegments(token.tokens, options, { ...style, strike: true }));
        break;
      case 'codespan':
        push(token.text, { code: true });
        break;
      case 'link':
        out.push(...inlineSegments(token.tokens, options, { ...style, link: token.href }));
        break;
      case 'image': {
        const alt = decodeHtmlEntities(token.text || '').trim();
        const word = options.imageLabel || 'Image';
        push(alt ? `[${word}: ${alt}]` : `[${word}]`, { italic: true });
        break;
      }
      case 'br':
        out.push({ text: '', br: true });
        break;
      case 'html':
        if (BR_TAG.test(String(token.text || '').trim())) out.push({ text: '', br: true });
        break;
      case 'checkbox':
        break;
      default:
        if (Array.isArray(token.tokens)) out.push(...inlineSegments(token.tokens, options, style));
        else if (typeof token.text === 'string') push(decodeHtmlEntities(token.text));
    }
  }
  return out;
}

/**
 * Plain text of a segment list; line breaks become "\n".
 *
 * @param {InlineSegment[]} segments - inline segments
 * @returns {string} the text
 */
export function segmentsToPlainText(segments) {
  return segments.map(segment => (segment.br ? '\n' : segment.text)).join('');
}

/**
 * Inline segments of a block token that carries inline content (paragraph,
 * heading, block-level text, table cell).
 *
 * @param {Object} token - block token or table cell
 * @param {{imageLabel?: string}} [options] - see `inlineSegments`
 * @returns {InlineSegment[]} the segments
 */
export function blockSegments(token, options = {}) {
  if (Array.isArray(token.tokens) && token.tokens.length > 0) {
    return inlineSegments(token.tokens, options);
  }
  const text = decodeHtmlEntities(token.text || '');
  return text ? [{ text }] : [];
}

// ── HTML export ────────────────────────────────────────────────────────

const SAFE_IMAGE_SRC = /^(https?:\/\/|data:image\/(png|jpe?g|gif|webp);base64,)/i;

const htmlInstance = new Marked({ gfm: true, breaks: true });
htmlInstance.use({
  renderer: {
    /**
     * Raw HTML in message content is shown as text, never interpreted.
     * @param {{text: string, block?: boolean}} token
     * @returns {string}
     */
    html(token) {
      const raw = String(token.text || '');
      if (!token.block && BR_TAG.test(raw.trim())) return '<br>';
      return token.block ? `<p>${escapeHtml(raw.trim())}</p>\n` : escapeHtml(raw);
    },
    /**
     * Links with unsafe schemes (javascript:, data:, ...) lose their href.
     * @param {{href: string, tokens: Array}} token
     * @returns {string|false} false keeps marked's default rendering
     */
    link(token) {
      if (isSafeLinkTarget(token.href, { allowRelative: true })) return false;
      return this.parser.parseInline(token.tokens);
    },
    /**
     * Only http(s) and raster data-URI images are kept.
     * @param {{href: string, text: string}} token
     * @returns {string|false} false keeps marked's default rendering
     */
    image(token) {
      if (typeof token.href === 'string' && SAFE_IMAGE_SRC.test(token.href.trim())) return false;
      return escapeHtml(token.text ? `[${token.text}]` : '');
    }
  }
});

/**
 * Render markdown to HTML for the self-contained HTML export. Raw HTML is
 * escaped and unsafe link/image targets are dropped, so user- or
 * model-supplied content cannot inject markup or script.
 *
 * @param {string} content - markdown source
 * @returns {string} HTML fragment
 */
export function renderMarkdownToSafeHtml(content) {
  const source = typeof content === 'string' ? content.replace(/\r\n?/g, '\n') : '';
  if (!source.trim()) return '';
  try {
    return htmlInstance.parse(source);
  } catch {
    return `<p>${escapeHtml(source).replace(/\n/g, '<br>')}</p>`;
  }
}
