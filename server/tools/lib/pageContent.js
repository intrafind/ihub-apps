import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';

/**
 * What the page reader (`webContentExtractor`) makes of a fetched page: the
 * main content as Markdown, the page's metadata, and one window of the text
 * at a time.
 *
 * Everything here is pure — HTML or PDF bytes in, text out — so the extraction
 * rules are testable without a network. `webContentExtractor.js` owns the
 * fetching, the SSRF guard and the cache.
 *
 * ## Why Markdown
 *
 * The reader used to hand the model `textContent` with every run of whitespace
 * collapsed to one space: headings, lists, tables and links all came back as
 * one line. Markdown keeps that structure at a small cost in characters, and a
 * model reads it natively.
 *
 * ## Main-content detection
 *
 * Mozilla's Readability (the Firefox reader view) finds the article on a page.
 * It works well on articles and documentation and gives up on pages that have
 * no single article (listings, landing pages, search pages), so the reader's
 * older selector rules stay as the fallback: strip navigation, ads and chrome,
 * then take `main` / `article` / the first known content container, or `body`.
 *
 * @module tools/lib/pageContent
 */

/**
 * Most characters of one document the reader keeps. A window of it is what the
 * model receives per call (`maxLength`, 50 000 at most); this bounds how far
 * `offset` can reach, and what one page may cost in memory and in the cache.
 */
export const MAX_DOCUMENT_CHARS = 400_000;

/** Most PDF pages read. Past it, a PDF is reported as cut at this page. */
export const MAX_PDF_PAGES = 500;

/**
 * Readability's result is taken when it holds at least this much text;
 * below it, the selector fallback is compared and the longer one wins.
 */
const MIN_ARTICLE_CHARS = 250;

/** Content shorter than this is flagged: the page probably needs JavaScript. */
const THIN_CONTENT_CHARS = 200;

/** Elements removed before the selector fallback picks a content area. */
const UNWANTED_SELECTORS = [
  'script',
  'style',
  'noscript',
  'iframe',
  'embed',
  'object',
  'template',
  'svg',
  'canvas',
  'form',
  'button',
  'header',
  'footer',
  'nav',
  'aside',
  'menu',
  '.advertisement',
  '.ad',
  '.ads',
  '.sidebar',
  '.popup',
  '.cookie-banner',
  '.newsletter',
  '.social-share',
  '.related-articles',
  '.comments',
  '.pagination',
  '[role="banner"]',
  '[role="navigation"]',
  '[role="complementary"]',
  '[aria-hidden="true"]',
  '.header',
  '.footer',
  '.nav',
  '.navbar',
  '.menu',
  '.ad-container',
  '.advertisement-container',
  '.sponsored',
  '.cookie-notice',
  '.gdpr-banner',
  '.privacy-notice'
];

/** Content containers tried in order by the selector fallback. */
const CONTENT_SELECTORS = [
  'main',
  'article',
  '[role="main"]',
  '.content',
  '.main-content',
  '.article-content',
  '.post-content',
  '.entry-content',
  '.page-content',
  '.body-content',
  '#content',
  '#main-content',
  '#article-content'
];

/** Removed as well when the fallback has to use `body`. */
const BODY_ONLY_UNWANTED = [
  '.breadcrumb',
  '.breadcrumbs',
  '.tags',
  '.categories',
  '.meta',
  '.metadata',
  '.author-info',
  '.share-buttons',
  '.social-buttons',
  '.widget',
  '.promo',
  '.promotion',
  '.banner',
  '.alert'
];

/**
 * One cell of a Markdown table: its content on one line, pipes escaped.
 * @param {TurndownService} service
 * @param {Element} cell
 */
function tableCell(service, cell) {
  return service
    .turndown(cell.innerHTML || '')
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();
}

/**
 * Turndown with the rules the reader needs: ATX headings, fenced code, GFM
 * tables, and no images (an image URL is noise to a model; its alt text is
 * kept).
 * @returns {TurndownService}
 */
export function createMarkdownConverter() {
  const service = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*',
    hr: '---'
  });

  service.remove(['script', 'style', 'noscript', 'iframe', 'svg', 'canvas', 'form', 'button']);

  service.addRule('image', {
    filter: 'img',
    replacement: (_content, node) => {
      const alt = (node.getAttribute('alt') || '').replace(/\s+/g, ' ').trim();
      return alt ? `[Image: ${alt}]` : '';
    }
  });

  // Links keep their text and target, not their tooltip. A link inside the
  // page (`#section`) is only its text — heading anchors, "back to top" — and a
  // link without text (an icon, an image) is dropped.
  service.addRule('link', {
    filter: node => node.nodeName === 'A' && Boolean(node.getAttribute('href')),
    replacement: (content, node) => {
      const text = content.replace(/\s+/g, ' ').trim();
      if (!text) return '';
      const href = node.getAttribute('href').trim();
      if (href.startsWith('#') || /^javascript:/i.test(href)) return content;
      return `[${content}](${href.replace(/([()])/g, '\\$1')})`;
    }
  });

  // Footnote markers that only point further down the page (`[1]` → #cite_note-1).
  service.addRule('inPageFootnote', {
    filter: node => {
      if (node.nodeName !== 'SUP') return false;
      const links = Array.from(node.querySelectorAll('a'));
      return (
        links.length > 0 && links.every(link => (link.getAttribute('href') || '').startsWith('#'))
      );
    },
    replacement: () => ''
  });

  // One space after the list marker instead of Turndown's three: the same
  // Markdown, fewer characters of the page's budget spent on indentation.
  service.addRule('listItem', {
    filter: 'li',
    replacement: (content, node, options) => {
      const text = content.replace(/^\n+/, '').replace(/\n+$/, '\n').replace(/\n/gm, '\n  ');
      const parent = node.parentNode;
      let prefix = `${options.bulletListMarker} `;
      if (parent?.nodeName === 'OL') {
        const start = Number(parent.getAttribute('start')) || 1;
        const index = Array.prototype.indexOf.call(parent.children, node);
        prefix = `${start + index}. `;
      }
      return prefix + text + (node.nextSibling && !/\n$/.test(text) ? '\n' : '');
    }
  });

  service.addRule('table', {
    filter: 'table',
    replacement: (_content, node) => {
      const rows = Array.from(node.querySelectorAll('tr')).filter(
        // Rows of a nested table belong to that table's own cell.
        row => row.closest('table') === node
      );
      const cells = rows
        .map(row =>
          Array.from(row.children)
            .filter(cell => cell.nodeName === 'TD' || cell.nodeName === 'TH')
            .map(cell => tableCell(service, cell))
        )
        .filter(row => row.length > 0);
      if (cells.length === 0) return '';
      const width = Math.max(...cells.map(row => row.length));
      const line = row =>
        `| ${Array.from({ length: width }, (_, i) => row[i] || '').join(' | ')} |`;
      const [header, ...body] = cells;
      const separator = `| ${Array.from({ length: width }, () => '---').join(' | ')} |`;
      return `\n\n${[line(header), separator, ...body.map(line)].join('\n')}\n\n`;
    }
  });

  return service;
}

const converter = createMarkdownConverter();

/**
 * Tidy converted Markdown: no trailing spaces, at most one blank line in a row.
 * @param {string} markdown
 * @returns {string}
 */
export function normalizeMarkdown(markdown) {
  return String(markdown || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function metaContent(document, selectors) {
  for (const selector of selectors) {
    const value = document.querySelector(selector)?.getAttribute('content');
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/**
 * The page reader's selector rules: strip chrome, then take the first known
 * content container, or `body` with more removed.
 * @param {Document} document - mutated
 * @returns {Element|null}
 */
function selectContentElement(document) {
  for (const selector of UNWANTED_SELECTORS) {
    document.querySelectorAll(selector).forEach(el => el.remove());
  }
  for (const selector of CONTENT_SELECTORS) {
    const element = document.querySelector(selector);
    if (element) return element;
  }
  const body = document.body;
  if (!body) return null;
  for (const selector of BODY_ONLY_UNWANTED) {
    body.querySelectorAll(selector).forEach(el => el.remove());
  }
  return body;
}

/** Characters of readable text in Markdown: link targets and markup do not count. */
function textLength(markdown) {
  return markdown
    .replace(/\]\([^)]*\)/g, ']')
    .replace(/[#*_`>|\-[\]()!]/g, '')
    .replace(/\s+/g, ' ')
    .trim().length;
}

/**
 * Point every link and image of `element` at its absolute URL (the DOM
 * resolves them against the page's URL), so the Markdown carries links the
 * model can open. Readability does this for its own output.
 * @param {Element} element - mutated
 */
function absolutizeLinks(element) {
  for (const link of element.querySelectorAll('a[href]')) {
    if (link.href) link.setAttribute('href', link.href);
  }
  for (const image of element.querySelectorAll('img[src]')) {
    if (image.src) image.setAttribute('src', image.src);
  }
}

/**
 * Extract the main content of an HTML page as Markdown.
 *
 * @param {string} html - The page's HTML
 * @param {Object} [options]
 * @param {string} [options.url] - The page's URL; relative links are resolved against it
 * @returns {{
 *   title: string, description: string, author: string, siteName: string,
 *   publishedDate: string, language: string, markdown: string,
 *   extractor: 'readability'|'selectors', thin: boolean
 * }}
 */
export function extractHtmlPage(html, { url } = {}) {
  // Style blocks are dropped before parsing: JSDOM's CSS parser throws on some
  // real-world stylesheets, and nothing in them is content. Looped so nested or
  // overlapping blocks a single pass would miss go too.
  let source = String(html || '');
  let previous;
  do {
    previous = source;
    source = source.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
  } while (source !== previous);

  const dom = new JSDOM(source, url ? { url } : undefined);
  const document = dom.window.document;

  const title =
    document.querySelector('title')?.textContent?.trim() ||
    metaContent(document, ['meta[property="og:title"]', 'meta[name="twitter:title"]']);
  const description = metaContent(document, [
    'meta[name="description"]',
    'meta[property="og:description"]',
    'meta[name="twitter:description"]'
  ]);
  const metaAuthor = metaContent(document, ['meta[name="author"]']);
  const metaPublished = metaContent(document, [
    'meta[property="article:published_time"]',
    'meta[name="date"]',
    'meta[name="publish-date"]',
    'meta[itemprop="datePublished"]'
  ]);
  const metaSiteName = metaContent(document, ['meta[property="og:site_name"]']);
  const language = document.documentElement?.getAttribute('lang') || '';

  let article = null;
  try {
    article = new Readability(document.cloneNode(true)).parse();
  } catch {
    article = null;
  }
  const articleMarkdown = article?.content
    ? normalizeMarkdown(converter.turndown(article.content))
    : '';

  let markdown = articleMarkdown;
  let extractor = 'readability';
  if (textLength(articleMarkdown) < MIN_ARTICLE_CHARS) {
    const element = selectContentElement(document);
    if (element) absolutizeLinks(element);
    const fallback = element ? normalizeMarkdown(converter.turndown(element.innerHTML)) : '';
    // The fallback has navigation and chrome stripped by name, which
    // Readability does not do once it finds no article, so on a short page it
    // wins unless it kept less than half of the text.
    if (fallback && textLength(fallback) >= textLength(articleMarkdown) * 0.5) {
      markdown = fallback;
      extractor = 'selectors';
    }
  }

  return {
    title: title || article?.title?.trim() || '',
    description: description || article?.excerpt?.trim() || '',
    author: metaAuthor || article?.byline?.trim() || '',
    siteName: metaSiteName || article?.siteName?.trim() || '',
    publishedDate: article?.publishedTime || metaPublished || '',
    language: language || article?.lang || '',
    markdown: markdown.slice(0, MAX_DOCUMENT_CHARS),
    extractor,
    thin: textLength(markdown) < THIN_CONTENT_CHARS
  };
}

/**
 * Where to end a window of `text` that starts at `start` and may hold `max`
 * characters: at a paragraph break when there is one in the last fifth of the
 * window, else a line break, else a space, so a window does not end mid-word.
 */
function windowEnd(text, start, max) {
  const hardEnd = start + max;
  if (hardEnd >= text.length) return text.length;
  const floor = start + Math.floor(max * 0.8);
  for (const boundary of ['\n\n', '\n', ' ']) {
    const at = text.lastIndexOf(boundary, hardEnd);
    if (at >= floor) return at + boundary.length;
  }
  return hardEnd;
}

/**
 * One window of a document, and where the next one starts.
 *
 * @param {string} text - The whole document
 * @param {Object} options
 * @param {number} [options.offset=0] - Character offset to start at
 * @param {number} options.maxLength - Most characters to return
 * @returns {{content: string, offset: number, nextOffset: number|null,
 *   truncated: boolean, totalLength: number}}
 */
export function sliceDocument(text, { offset = 0, maxLength }) {
  const source = String(text || '');
  const totalLength = source.length;
  const start = Math.min(Math.max(0, Math.floor(Number(offset) || 0)), totalLength);
  const max = Math.max(1, Math.floor(Number(maxLength) || totalLength || 1));
  const end = windowEnd(source, start, max);
  const truncated = end < totalLength;
  return {
    content: source.slice(start, end).trim(),
    offset: start,
    nextOffset: truncated ? end : null,
    truncated,
    totalLength
  };
}

/**
 * Words in a text, for the "words read" the chat shows.
 * @param {string} text
 * @returns {number}
 */
export function countWords(text) {
  const words = String(text || '').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu);
  return words ? words.length : 0;
}

/**
 * The file name of a URL, for a PDF without a title of its own.
 * @param {string} url
 * @returns {string}
 */
function fileNameOf(url) {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    return name || url;
  } catch {
    return (
      String(url || '')
        .split('/')
        .pop() || ''
    );
  }
}

/**
 * Text of a PDF, page by page, up to {@link MAX_DOCUMENT_CHARS} or
 * {@link MAX_PDF_PAGES}, with its title and author from the document
 * information dictionary (the file name when it has no title).
 *
 * @param {Object} pdfjs - The pdfjs-dist module
 * @param {ArrayBuffer|Uint8Array} data - The PDF bytes
 * @param {Object} [options]
 * @param {string} [options.url] - Where the PDF came from (title fallback)
 * @returns {Promise<{title: string, author: string, publishedDate: string,
 *   text: string, pageCount: number, pagesRead: number}>}
 */
export async function extractPdf(pdfjs, data, { url } = {}) {
  const pdf = await pdfjs.getDocument({
    data: data instanceof Uint8Array ? data : new Uint8Array(data),
    verbosity: 0
  }).promise;

  let info = {};
  try {
    const metadata = await pdf.getMetadata();
    info = metadata?.info || {};
  } catch {
    info = {};
  }

  const pages = [];
  let length = 0;
  const last = Math.min(pdf.numPages, MAX_PDF_PAGES);
  let pagesRead = 0;
  for (let pageNum = 1; pageNum <= last && length < MAX_DOCUMENT_CHARS; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();
    // `hasEOL` marks the end of a line in the page's own layout; without it the
    // items of one page run together into a single line.
    const pageText = textContent.items
      .map(item => (item.str || '') + (item.hasEOL ? '\n' : ''))
      .join('')
      .replace(/[ \t]+\n/g, '\n')
      .trim();
    if (pageText) pages.push(pageText);
    length += pageText.length + 2;
    pagesRead = pageNum;
  }

  const title = typeof info.Title === 'string' && info.Title.trim() ? info.Title.trim() : '';
  return {
    title: title || fileNameOf(url),
    author: typeof info.Author === 'string' ? info.Author.trim() : '',
    publishedDate: pdfDate(info.CreationDate),
    text: pages.join('\n\n').slice(0, MAX_DOCUMENT_CHARS),
    pageCount: pdf.numPages,
    pagesRead
  };
}

/**
 * A PDF date (`D:20240131120000+01'00'`) as ISO 8601, or '' when absent.
 * @param {unknown} value
 * @returns {string}
 */
export function pdfDate(value) {
  if (typeof value !== 'string') return '';
  const match = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(value.trim());
  if (!match) return '';
  const [, y, mo = '01', d = '01', h = '00', mi = '00', s = '00'] = match;
  const date = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

/**
 * `Accept-Language` for a request made on behalf of a user reading in
 * `language`: the tag itself, its base language, then English as a fallback
 * most sites serve.
 *
 * @param {string} [language] - e.g. `de`, `de-CH`, `en_GB`
 * @returns {string}
 */
export function acceptLanguageFor(language) {
  const tag = typeof language === 'string' ? language.trim().replace(/_/g, '-') : '';
  if (!/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(tag)) return 'en-US,en;q=0.9';
  const base = tag.split('-')[0].toLowerCase();
  const parts = [tag];
  if (base !== tag.toLowerCase()) parts.push(`${base};q=0.9`);
  if (base !== 'en') parts.push('en;q=0.8');
  return parts.join(',');
}
