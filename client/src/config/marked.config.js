import DOMPurify from 'dompurify';
import { Marked, Renderer } from 'marked';
import {
  escapeHtml,
  getLanguageDisplayName,
  isMermaidLanguage,
  hashString,
  detectDiagramType
} from '../utils/markdownHelpers';

// Occurrence counter for the parse currently in progress. Diagram IDs are
// derived from the diagram source so that re-parsing the same markdown yields
// the same IDs; the counter only disambiguates identical diagrams that appear
// more than once in the same document. `marked.parse()` is synchronous, so a
// single module-level scope is safe.
let mermaidIdScope = new Map();

const nextMermaidId = code => {
  const base = hashString(code);
  const occurrence = mermaidIdScope.get(base) || 0;
  mermaidIdScope.set(base, occurrence + 1);
  return occurrence === 0 ? `mermaid-${base}` : `mermaid-${base}-${occurrence}`;
};

const renderMermaidPlaceholder = (code, language) => {
  const diagramId = nextMermaidId(code);
  const detectedType = detectDiagramType(code);

  return `
    <div class="mermaid-diagram-container" id="${diagramId}" data-code="${encodeURIComponent(code)}" data-language="${language || 'mermaid'}" data-diagram-type="${detectedType}">
      <div class="mermaid-diagram-placeholder">
        <div class="flex items-center justify-center p-8 bg-gray-50 border border-gray-200 rounded-lg">
          <div class="flex items-center gap-2 text-gray-600">
            <svg class="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
              <path class="opacity-75" fill="currentColor" d="m4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            <span class="text-sm">Loading diagram...</span>
          </div>
        </div>
      </div>
    </div>
  `;
};

const highlightCode = (code, lang) => {
  if (
    typeof window !== 'undefined' &&
    lang &&
    window.hljs &&
    typeof window.hljs.getLanguage === 'function' &&
    window.hljs.getLanguage(lang)
  ) {
    try {
      return window.hljs.highlight(code, {
        language: lang,
        ignoreIllegals: true
      }).value;
    } catch (e) {
      console.error('Highlight.js error:', e);
    }
  }

  return escapeHtml(code);
};

/** Longest destination shown in a link tooltip; longer URLs are cut with an ellipsis. */
const LINK_TOOLTIP_MAX_CHARS = 200;
const ENTITY_CHARS = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };

/**
 * Escape a value for an HTML attribute the way marked's own renderer does:
 * `<`, `>`, quotes and bare `&` are encoded, an entity that is already there
 * (`&quot;`, `&#39;`) is kept, so a title written with entities still reads
 * as its characters in the tooltip.
 */
const escapeAttribute = value =>
  String(value).replace(/[<>"']|&(?!(?:#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g, char => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });

/**
 * The tooltip for a link that carries no title: its destination, percent-decoded
 * so a SharePoint or file-share URL reads as the file it opens rather than as
 * `%7B…%7D&file=…`. Empty for a link whose visible text already is the URL,
 * and for fragments and other non-navigating hrefs.
 *
 * @param {string} href - The link's destination.
 * @param {string} text - The link's source text.
 * @returns {string} The tooltip, or '' when none is useful.
 */
export const linkDestinationTooltip = (href, text) => {
  if (typeof href !== 'string' || !href || href.startsWith('#')) return '';
  let shown = href;
  try {
    shown = decodeURIComponent(href);
  } catch {
    // Malformed escapes: show the URL as written.
  }
  // `text` is the link's source text. marked entity-escapes the text of a bare
  // URL (`<https://…?a=1&b=2>` reads `&amp;`), so undo that before comparing it
  // with the href; the result is only compared, never rendered.
  const plainText = String(text ?? '')
    .replace(/&(amp|lt|gt|quot|#39);/g, (_, entity) => ENTITY_CHARS[entity])
    .trim();
  if (plainText === href || plainText === shown) return '';
  return shown.length > LINK_TOOLTIP_MAX_CHARS
    ? `${shown.slice(0, LINK_TOOLTIP_MAX_CHARS - 1)}…`
    : shown;
};

const createRenderer = t => {
  const renderer = new Renderer();

  // --- Code Renderer ---
  renderer.code = (code, language) => {
    // Extract actual code string and language from the parameters
    let actualCode = code;
    let actualLanguage = language;

    // Handle different parameter structures (marked.js versions may vary)
    if (typeof code === 'object' && code !== null) {
      actualCode = code.text || code.raw || code.code || code;
      actualLanguage = language || code.lang || code.language;
    }

    // Ensure we have strings
    if (typeof actualCode !== 'string') {
      actualCode = String(actualCode);
    }

    const lang = (actualLanguage || 'text').toLowerCase();

    if (isMermaidLanguage(lang)) {
      return renderMermaidPlaceholder(actualCode, lang);
    }

    // Fallback for regular code blocks
    const displayLanguage = getLanguageDisplayName(lang);

    // Use the original highlighted code from marked
    const highlightedCode = highlightCode(actualCode, lang);

    return `
      <div class="code-block-container relative group my-4 border border-gray-200 rounded-lg shadow-xs">
        <pre class="bg-gray-900 text-gray-100 rounded-t-lg p-4 overflow-x-auto"><code class="language-${lang}">${highlightedCode}</code></pre>
        <div class="code-block-toolbar flex items-center justify-between bg-gray-50 border-t border-gray-200 px-3 py-2 rounded-b-lg">
          <span class="text-xs font-medium text-gray-600">${displayLanguage}</span>
          <div class="flex flex-row items-center gap-2">
            <button
              class="code-copy-btn p-1.5 rounded-sm text-xs text-gray-600 hover:bg-gray-200 flex flex-row items-center gap-1"
              data-code-content="${encodeURIComponent(actualCode)}"
              type="button"
              title="${t ? t('common.copyCode', 'Copy code') : 'Copy code'}"
            >
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"></path></svg>
              <span class="hidden sm:inline">${t ? t('common.copy', 'Copy') : 'Copy'}</span>
            </button>
            <button
              class="code-download-btn p-1.5 rounded-sm text-xs text-gray-600 hover:bg-gray-200 flex flex-row items-center gap-1"
              data-code-content="${encodeURIComponent(actualCode)}"
              data-code-language="${lang}"
              type="button"
              title="${t ? t('common.downloadCode', 'Download code') : 'Download code'}"
            >
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path></svg>
              <span class="hidden sm:inline">${t ? t('common.download', 'Download') : 'Download'}</span>
            </button>
          </div>
        </div>
      </div>
    `;
  };

  // --- Link Renderer ---
  renderer.link = function (token) {
    // In marked v5+, the renderer receives a token object instead of separate parameters
    // Extract href, title, and text from the token
    let actualHref = token.href;
    let actualTitle = token.title;
    let text = token.text;

    // Handle legacy case where individual parameters might be passed (for backward compatibility)
    if (typeof token === 'string') {
      actualHref = token;
      actualTitle = arguments[1];
      text = arguments[2];
    }

    // Handle cases where href might be a stringified JSON object
    if (typeof actualHref === 'string' && actualHref.startsWith('{') && actualHref.endsWith('}')) {
      try {
        const parsed = JSON.parse(actualHref);
        actualHref = parsed.href || parsed.url || actualHref;
        if (!actualTitle) {
          actualTitle = parsed.title || null;
        }
      } catch {
        console.warn('Failed to parse href JSON');
      }
    }

    // Ensure we have valid values
    actualHref = actualHref || '';
    text = text || actualHref; // Fallback to href if text is missing

    const currentDomain = typeof window !== 'undefined' ? window.location.hostname : '';
    let isExternal = false;
    try {
      const url = new URL(actualHref, window.location.href);
      if (url.hostname !== currentDomain) {
        isExternal = true;
      }
    } catch {
      // If URL parsing fails, assume it's a relative path or invalid
    }
    const targetAttr = isExternal ? ' target="_blank" rel="noopener noreferrer"' : '';
    // A link without a title of its own gets its destination as the tooltip,
    // so a reader hovering "Quarterly report" sees where it would take them
    // before clicking. A link whose text already is the URL needs none.
    const tooltip = actualTitle || linkDestinationTooltip(actualHref, text);
    const titleAttr = tooltip ? ` title="${escapeAttribute(tooltip)}"` : '';
    return `<a href="${escapeAttribute(actualHref)}"${titleAttr}${targetAttr}>${text}</a>`;
  };

  return renderer;
};

const createMarked = (t, { breaks = true } = {}) =>
  new Marked({
    gfm: true,
    breaks,
    headerIds: true,
    mangle: false,
    pedantic: false,
    smartLists: true,
    smartypants: false,
    xhtml: false,
    renderer: createRenderer(t)
  });

const markedInstanceByTranslator = new WeakMap();
const defaultMarkedInstances = {};

// Cache parser instances by translation function (and line-break mode) so repeated renders
// avoid rebuilding renderers. WeakMap ensures stale translator functions can be GC'd.
// `defaultMarkedInstances` serves call sites that don't pass `t`.
const getMarkedInstance = (t, { breaks = true } = {}) => {
  const variant = breaks ? 'breaks' : 'noBreaks';

  if (typeof t === 'function') {
    let variants = markedInstanceByTranslator.get(t);
    if (!variants) {
      variants = {};
      markedInstanceByTranslator.set(t, variants);
    }
    if (!variants[variant]) {
      variants[variant] = createMarked(t, { breaks });
    }
    return variants[variant];
  }

  if (!defaultMarkedInstances[variant]) {
    defaultMarkedInstances[variant] = createMarked(undefined, { breaks });
  }
  return defaultMarkedInstances[variant];
};

/**
 * Render markdown to sanitized HTML using an isolated Marked instance.
 *
 * @param {string} markdown - Markdown source string.
 * @param {Object} [options] - Optional rendering behavior.
 * @param {Function} [options.t] - Translation function for renderer labels.
 * @param {Function} [options.transformHtml] - Optional post-parse HTML transform.
 *   The transformed HTML is still sanitized by DOMPurify afterwards.
 * @param {Object} [options.sanitizeOptions] - DOMPurify sanitize options.
 * @param {boolean} [options.breaks=true] - Turn single newlines into `<br>` (chat-style text).
 *   Pass `false` for hand-written, hard-wrapped Markdown such as release notes, where a line
 *   break inside a paragraph is just wrapping.
 * @returns {string} Sanitized HTML string.
 */
export const renderMarkdown = (markdown, options = {}) => {
  const { t, transformHtml, sanitizeOptions, breaks = true } = options;
  const source = String(markdown ?? '');

  try {
    const marked = getMarkedInstance(t, { breaks });
    // Reset the per-document occurrence counter so diagram IDs depend only on
    // the document being parsed, never on how many parses happened before.
    mermaidIdScope = new Map();
    const html = marked.parse(source);
    const transformedHtml = typeof transformHtml === 'function' ? transformHtml(html) : html;
    return DOMPurify.sanitize(transformedHtml, sanitizeOptions);
  } catch (error) {
    console.error('Error rendering markdown:', error);
    return DOMPurify.sanitize(`<pre>${escapeHtml(source)}</pre>`, sanitizeOptions);
  }
};

/**
 * Render a single line of Markdown — a heading, a table cell — to sanitized inline HTML: bold,
 * italics, inline code and links, but no block wrapper (`<p>`) around the result.
 *
 * @param {string} markdown - Markdown source string, expected to be one line.
 * @param {Object} [options] - Optional rendering behavior.
 * @param {Function} [options.t] - Translation function for renderer labels.
 * @param {Object} [options.sanitizeOptions] - DOMPurify sanitize options.
 * @returns {string} Sanitized HTML string.
 */
export const renderInlineMarkdown = (markdown, options = {}) => {
  const { t, sanitizeOptions } = options;
  const source = String(markdown ?? '');

  try {
    const marked = getMarkedInstance(t);
    return DOMPurify.sanitize(marked.parseInline(source), sanitizeOptions);
  } catch (error) {
    console.error('Error rendering inline markdown:', error);
    return DOMPurify.sanitize(escapeHtml(source), sanitizeOptions);
  }
};

// Backward-compatible no-op: markdown rendering no longer mutates global marked state.
export const configureMarked = () => {};
