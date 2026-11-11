// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The main text of a crawled page, as the website corpus sizer counts it.
 *
 * Not the page reader's extraction (`services/pageReader/pageContent.js`): that one finds
 * the *article* with Readability and shortens a page to fit a model call. A
 * corpus size needs everything a retrieval index or a long prompt would get, so
 * this keeps the text of `<main>` (`<body>` when there is none) and removes
 * only what is never content: scripts, styles, forms, buttons, iframes, svg,
 * `<nav>` and the selectors the caller names for the site's own furniture
 * (breadcrumbs, cookie banners, teaser sliders). Headings and list items keep
 * their markers, blocks end a line, and consecutive identical lines are
 * dropped (sliders and repeated teasers).
 *
 * Pure: HTML in, text out, no network.
 *
 * @module services/websiteCorpus/extract
 */
import { JSDOM } from 'jsdom';
import { dropRawTextElements } from '../pageReader/pageContent.js';

/** Elements that are never page content. */
const NEVER_CONTENT = ['script', 'style', 'noscript', 'form', 'svg', 'iframe', 'button', 'nav'];

/** Elements that end a line before and after their text. */
const BLOCKS = [
  'div',
  'p',
  'section',
  'article',
  'ul',
  'ol',
  'table',
  'tr',
  'td',
  'th',
  'blockquote',
  'figcaption',
  'dt',
  'dd',
  'header',
  'footer'
];

const HEADINGS = ['h1', 'h2', 'h3', 'h4', 'h5'];

/** Longest selector list a caller may pass. */
export const MAX_SELECTOR_CHARS = 1000;

/** Longest outline an `outlinePage` call returns, in lines. */
const MAX_OUTLINE_LINES = 70;

/**
 * Class and id names that mark page furniture, for the outline's "drop?" hint.
 * A hint only: the caller decides what to drop.
 */
const FURNITURE =
  /breadcrumb|cookie|consent|banner|teaser|slider|carousel|share|social|related|newsletter|sidebar|toc|subnav|submenu|menu|skip|pagination|print|toolbar|modal|popup|widget|recommend|more-|weitere|crumb/i;

const OUTLINE_TAGS = new Set([
  'section',
  'article',
  'aside',
  'header',
  'footer',
  'ul',
  'ol',
  'table',
  'form',
  'h1',
  'h2',
  'h3'
]);

function parse(html) {
  // Scripts and styles carry no text, are where JSDOM is slowest, and its CSS
  // parser throws on some real-world stylesheets.
  return new JSDOM(dropRawTextElements(html, ['script', 'style']));
}

/**
 * Check a CSS selector list before it is used on thousands of pages.
 *
 * @param {string} selector - Comma-separated CSS selectors, or empty
 * @returns {string} The trimmed selector
 * @throws {Error & {code: 'INVALID_SELECTOR'}}
 */
export function validateSelector(selector) {
  const text = String(selector || '').trim();
  if (!text) return '';
  const fail = reason => {
    const error = new Error(`The selector is not valid: ${reason}`);
    error.code = 'INVALID_SELECTOR';
    return error;
  };
  if (text.length > MAX_SELECTOR_CHARS) {
    throw fail(`at most ${MAX_SELECTOR_CHARS} characters`);
  }
  const dom = new JSDOM('<main></main>');
  try {
    dom.window.document.querySelector(text);
  } catch (error) {
    throw fail(error.message);
  } finally {
    dom.window.close();
  }
  return text;
}

/** The text of one `<main>`, with the corpus' line rules applied. */
function toText(document, main, dropSelector) {
  for (const tag of main.querySelectorAll(NEVER_CONTENT.join(','))) tag.remove();
  if (dropSelector) {
    for (const tag of main.querySelectorAll(dropSelector)) tag.remove();
  }
  const text = value => document.createTextNode(value);
  for (const br of main.querySelectorAll('br')) br.replaceWith(text('\n'));
  for (const heading of main.querySelectorAll(HEADINGS.join(','))) {
    const level = Number(heading.tagName[1]);
    heading.prepend(text(`\n\n${'#'.repeat(level)} `));
    heading.append(text('\n'));
  }
  for (const item of main.querySelectorAll('li')) item.prepend(text('\n- '));
  for (const block of main.querySelectorAll(BLOCKS.join(','))) {
    block.prepend(text('\n'));
    block.append(text('\n'));
  }
  const lines = main.textContent
    .split('\n')
    .map(line => line.replace(/[ \t ]+/g, ' ').trim())
    .filter(line => line && !['-', '#', '##', '###'].includes(line));
  const kept = [];
  for (const line of lines) {
    if (kept.length === 0 || kept[kept.length - 1] !== line) kept.push(line);
  }
  return kept.join('\n').trim();
}

/**
 * The main text of a page.
 *
 * @param {string} html
 * @param {Object} [options]
 * @param {string} [options.dropSelector] - CSS selectors of blocks inside `<main>` to remove
 * @returns {{title: string, date: string|null, text: string}|null} `null` for a page with neither `<main>` nor `<body>`
 */
export function extractPage(html, { dropSelector = '' } = {}) {
  const dom = parse(html);
  try {
    const { document } = dom.window;
    const main = document.querySelector('main') || document.body;
    if (!main) return null;
    const title = (document.querySelector('title')?.textContent || '').replace(/\s+/g, ' ').trim();
    // The date is read before the removals below take `<time>` elements with them.
    const time = main.querySelector('time');
    const date = time ? time.getAttribute('datetime') || time.textContent.trim() || null : null;
    return { title, date, text: toText(document, main, dropSelector) };
  } finally {
    dom.window.close();
  }
}

/** A short label such as `div#teaser.slider.big`. */
function labelOf(element) {
  let label = element.tagName.toLowerCase();
  if (element.id) label += `#${element.id}`;
  const classes = [...element.classList].slice(0, 3);
  if (classes.length) label += `.${classes.join('.')}`;
  return label;
}

/**
 * The structure of a page's `<main>`: the elements that carry a class or an id
 * (and sections, lists, tables and headings), nested by depth, with the
 * characters of text each one holds. Elements whose class or id looks like page
 * furniture are marked, so a caller can build the `dropSelector` for
 * {@link extractPage} from them.
 *
 * @param {string} html
 * @param {Object} [options]
 * @param {number} [options.depth=4] - How deep to look
 * @returns {{mainChars: number, lines: string[], candidates: string[], truncated: boolean}|null}
 */
export function outlinePage(html, { depth = 4 } = {}) {
  const dom = parse(html);
  try {
    const { document } = dom.window;
    const main = document.querySelector('main') || document.body;
    if (!main) return null;
    const lines = [];
    const candidates = [];
    let truncated = false;
    const walk = (element, level) => {
      for (const child of element.children) {
        if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG'].includes(child.tagName.toUpperCase())) continue;
        const interesting =
          child.id || child.classList.length || OUTLINE_TAGS.has(child.tagName.toLowerCase());
        if (interesting) {
          if (lines.length >= MAX_OUTLINE_LINES) {
            truncated = true;
            return;
          }
          const text = child.textContent.replace(/\s+/g, ' ').trim();
          const furniture = FURNITURE.test([child.id, ...child.classList].join(' '));
          const label = labelOf(child);
          if (furniture) candidates.push(label);
          lines.push(
            `${'  '.repeat(level)}${label}  [${text.length} chars] ${JSON.stringify(text.slice(0, 50))}${
              furniture ? '  <- drop?' : ''
            }`
          );
        }
        if (level < depth) walk(child, level + 1);
        if (truncated) return;
      }
    };
    walk(main, 1);
    return {
      mainChars: main.textContent.replace(/\s+/g, ' ').trim().length,
      lines,
      candidates: [...new Set(candidates)],
      truncated
    };
  } finally {
    dom.window.close();
  }
}
