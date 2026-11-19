// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import DOMPurify from 'dompurify';

/**
 * The HTML policy for content iHub did not write: model answers, tool and integration results,
 * uploaded documents, artifacts, marketplace texts. Any of them can carry text a third party
 * planted (a project document, a fetched web page, an MCP result), and that text can make the
 * model write markup. Rendered with DOMPurify's default profile such markup could still make the
 * browser fetch from another host without a click — an image whose URL carries the chat — or
 * restyle the app. This profile closes those paths:
 *
 * - No element or attribute that loads a resource from another origin by itself: `<img>` keeps
 *   only same-origin, relative and `data:image/` sources, and an image from elsewhere
 *   becomes a plain link the reader can follow ({@link EXTERNAL_IMAGE_LINK_CLASS}). Media,
 *   `srcset`, `background`, `poster`, SVG `<use>`/`<image>` references to other documents, CSS
 *   `url()` in SVG presentation attributes and the like are removed.
 * - No CSS: `<style>` elements and `style` attributes are removed.
 * - `class` and `id` only on the elements iHub's own renderers create (marked with
 *   {@link RENDERED_BY_IHUB_ATTRIBUTE}), so content cannot borrow the app's utility classes to
 *   lay a fake dialog over the page.
 * - No forms, dialogs or popovers.
 *
 * Links stay: they only load something when the reader clicks one, and `marked.config` pins
 * external ones to a new tab without opener or referrer.
 *
 * Admin-written content (pages, usage guides, the shipped documentation) is not rendered with
 * this profile; see `renderMarkdown`'s `trusted` option.
 *
 * @module utils/untrustedHtml
 */

/**
 * Attribute iHub's renderers put on the elements they create, so `class` and `id` survive on
 * them and only on them.
 *
 * @type {string}
 */
export const RENDERED_BY_IHUB_ATTRIBUTE = 'data-ihub-rendered';

const createToken = () => {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
};

/**
 * Per-page-load value of {@link RENDERED_BY_IHUB_ATTRIBUTE}. It is random and never derived from
 * content, so content cannot forge it; it stays the same for the life of the page, so rendering
 * the same Markdown twice gives the same HTML.
 *
 * @type {string}
 */
export const RENDERED_BY_IHUB_TOKEN = createToken();

/** The marker as an attribute string, for renderers that build HTML as text. */
export const RENDERED_BY_IHUB_MARKUP = `${RENDERED_BY_IHUB_ATTRIBUTE}="${RENDERED_BY_IHUB_TOKEN}"`;

/**
 * Mark an element as created by an iHub renderer.
 *
 * @param {Element} element
 * @returns {Element} The element.
 */
export const markRenderedByIhub = element => {
  element.setAttribute(RENDERED_BY_IHUB_ATTRIBUTE, RENDERED_BY_IHUB_TOKEN);
  return element;
};

const isRenderedByIhub = node =>
  typeof node?.closest === 'function' &&
  Boolean(node.closest(`[${RENDERED_BY_IHUB_ATTRIBUTE}="${RENDERED_BY_IHUB_TOKEN}"]`));

/** Class of the link an image from another origin is turned into. */
export const EXTERNAL_IMAGE_LINK_CLASS = 'external-image-link';

/**
 * Elements removed from untrusted HTML: they load resources by themselves (media, frames,
 * plugins, stylesheets), apply CSS, or open UI of their own (forms, dialogs).
 */
export const UNTRUSTED_FORBID_TAGS = Object.freeze([
  'style',
  'link',
  'meta',
  'base',
  'video',
  'audio',
  'source',
  'track',
  'picture',
  'bgsound',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'portal',
  'fencedframe',
  'form',
  'dialog'
]);

/**
 * Attributes removed from untrusted HTML: each loads a resource, applies CSS, submits
 * somewhere, sends a request on its own (`ping`, `attributionsrc`) or opens UI (popovers).
 */
export const UNTRUSTED_FORBID_ATTR = Object.freeze([
  'style',
  'srcset',
  'imagesrcset',
  'background',
  'poster',
  'lowsrc',
  'dynsrc',
  'longdesc',
  'ping',
  'attributionsrc',
  'action',
  'formaction',
  'form',
  'data',
  'codebase',
  'manifest',
  'icon',
  'archive',
  'classid',
  'profile',
  'xml:base',
  'popover',
  'popovertarget',
  'popovertargetaction'
]);

const CSS_ESCAPE = /\\(?:(\r\n|[\n\r\f])|([0-9a-fA-F]{1,6})[ \t\n\r\f]?|([\s\S]))/g;

const codePoint = hex => {
  const value = parseInt(hex, 16);
  return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : '�';
};

/**
 * CSS text with its escapes (`\75 rl(`, `\(`) resolved, as the CSS parser reads it.
 *
 * @param {string} text
 * @returns {string}
 */
export const decodeCssEscapes = text =>
  String(text ?? '').replace(CSS_ESCAPE, (_, newline, hex, char) =>
    newline !== undefined ? '' : hex !== undefined ? codePoint(hex) : char
  );

/**
 * Whether CSS text (a stylesheet, a `style` attribute, an SVG presentation attribute) can make
 * the browser load something: `@import`, `image-set()`, `src()`, or a `url()` that does not
 * point into the same document (`#id`) or at inline `data:`.
 *
 * @param {string} text
 * @param {object} [options]
 * @param {boolean} [options.foreignOnly=false] - Count a `url()` only when it can reach another
 *   origin (it names a scheme or starts with `//`), not a relative one. For text that is not
 *   only CSS, such as diagram source, where `url(Start page)` can be a node.
 * @returns {boolean}
 */
export const cssLoadsResource = (text, { foreignOnly = false } = {}) => {
  const css = decodeCssEscapes(String(text ?? '').replace(/\/\*[\s\S]*?\*\//g, '')).toLowerCase();
  if (css.includes('@import')) return true;
  if (/image-set\s*\(/.test(css)) return true;
  if (/(^|[^a-z0-9_-])src\s*\(/.test(css)) return true;
  const urlPattern = /url\s*\(\s*(["']?)\s*([^"')]*)/g;
  let match;
  while ((match = urlPattern.exec(css)) !== null) {
    const target = match[2].trim();
    if (target.startsWith('#') || target.startsWith('data:')) continue;
    if (!foreignOnly) return true;
    if (target.includes(':') || /^[\\/]{2}/.test(target)) return true;
  }
  return false;
};

const pageLocation = () =>
  typeof window !== 'undefined' && window.location ? window.location : null;

/**
 * Whether loading `value` stays on this iHub: a relative or same-origin URL, a `blob:` URL of
 * this origin, or an inline `data:image/` URL.
 *
 * @param {string} value
 * @returns {boolean}
 */
export const isLocalResourceUrl = value => {
  const location = pageLocation();
  const raw = String(value ?? '').trim();
  if (!raw || !location) return false;
  if (/^data:image\//i.test(raw)) return true;
  try {
    const url = new URL(raw, location.href);
    if (url.protocol === 'blob:') return url.origin === location.origin;
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return url.origin === location.origin;
  } catch {
    return false;
  }
};

const httpUrl = value => {
  const location = pageLocation();
  try {
    const url = new URL(String(value ?? '').trim(), location?.href);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
};

/** Elements whose `href` is followed only on a click. */
const LINK_ELEMENTS = new Set(['a', 'area']);
/** SVG elements whose `href` draws a picture; the same rule as `<img src>`. */
const PICTURE_ELEMENTS = new Set(['image', 'feimage']);
/** Attributes whose value is plain text, never CSS. */
const TEXT_ATTRIBUTES = new Set(['alt', 'title', 'href', 'xlink:href', 'src']);

/**
 * Replace an `<img>` whose source is on another origin with a link to it (`alt (host)`), or,
 * inside a link already, with that text. Anything else that is not loadable here is removed.
 */
const replaceForeignImage = img => {
  const url = httpUrl(img.getAttribute('src'));
  const alt = (img.getAttribute('alt') || '').trim();
  const doc = img.ownerDocument;
  if (!url) {
    if (alt) img.replaceWith(doc.createTextNode(alt));
    else img.remove();
    return;
  }
  const label = alt ? `${alt} (${url.host})` : url.host;
  const replacement = img.parentNode?.closest?.('a')
    ? doc.createElement('span')
    : doc.createElement('a');
  if (replacement.localName === 'a') replacement.setAttribute('href', url.href);
  replacement.className = EXTERNAL_IMAGE_LINK_CLASS;
  markRenderedByIhub(replacement);
  replacement.textContent = label;
  img.replaceWith(replacement);
};

const imageSourceOk = img => isLocalResourceUrl(img.getAttribute('src'));

/**
 * Hooks shared by every untrusted profile.
 *
 * @param {object} purifier - A DOMPurify instance.
 * @param {object} options
 * @param {boolean} options.restrictClassAndId - Keep `class` and `id` only on elements iHub's
 *   renderers marked.
 */
const addUntrustedHooks = (purifier, { restrictClassAndId }) => {
  purifier.addHook('uponSanitizeElement', (node, data) => {
    if (data.tagName === 'img' && !imageSourceOk(node)) {
      replaceForeignImage(node);
      return;
    }
    if (data.tagName === 'style' && cssLoadsResource(node.textContent)) {
      node.remove();
      return;
    }
    // Task lists render as disabled checkboxes; any other input (an image button, a text
    // field asking for a password) has no place in an answer.
    if (
      data.tagName === 'input' &&
      String(node.getAttribute('type')).toLowerCase() !== 'checkbox'
    ) {
      node.remove();
    }
  });

  purifier.addHook('uponSanitizeAttribute', (node, data) => {
    const name = data.attrName;
    const value = data.attrValue ?? '';
    const element = String(node.localName || node.nodeName || '').toLowerCase();

    if (name === 'class' || name === 'id') {
      if (restrictClassAndId && !isRenderedByIhub(node)) data.keepAttr = false;
      return;
    }
    if (name === 'href' || name === 'xlink:href') {
      if (LINK_ELEMENTS.has(element)) return;
      if (PICTURE_ELEMENTS.has(element) && isLocalResourceUrl(value)) return;
      if (!value.trim().startsWith('#')) data.keepAttr = false;
      return;
    }
    if (name === 'src') {
      if (element === 'img' && isLocalResourceUrl(value)) return;
      data.keepAttr = false;
      return;
    }
    if (TEXT_ATTRIBUTES.has(name) || name.startsWith('aria-') || name.startsWith('data-')) return;
    if (cssLoadsResource(value)) data.keepAttr = false;
  });
};

let answerPurifier = null;
let svgPurifier = null;

const newPurifier = () => (typeof window === 'undefined' ? null : DOMPurify(window));

/**
 * A DOMPurify instance of its own for untrusted HTML, so its hooks never run for other callers
 * (admin content, Mermaid's label sanitizing).
 */
const getAnswerPurifier = () => {
  if (!answerPurifier) {
    answerPurifier = newPurifier();
    if (answerPurifier) addUntrustedHooks(answerPurifier, { restrictClassAndId: true });
  }
  return answerPurifier;
};

const getSvgPurifier = () => {
  if (!svgPurifier) {
    svgPurifier = newPurifier();
    if (svgPurifier) addUntrustedHooks(svgPurifier, { restrictClassAndId: false });
  }
  return svgPurifier;
};

/**
 * Sanitize HTML that came from a model, a tool or another source iHub does not control, with
 * the profile described in this module.
 *
 * @param {string} html
 * @param {object} [options]
 * @param {Function} [options.afterSanitizeAttributes] - Extra hook for this call (link targets).
 * @param {string[]} [options.addAttr] - Further attributes to allow (for example `target`).
 * @returns {string} Sanitized HTML.
 */
export const sanitizeUntrustedHtml = (html, { afterSanitizeAttributes, addAttr = [] } = {}) => {
  const purifier = getAnswerPurifier();
  if (!purifier) return '';
  if (afterSanitizeAttributes) purifier.addHook('afterSanitizeAttributes', afterSanitizeAttributes);
  try {
    return purifier.sanitize(String(html ?? ''), {
      FORBID_TAGS: [...UNTRUSTED_FORBID_TAGS],
      FORBID_ATTR: [...UNTRUSTED_FORBID_ATTR],
      ADD_ATTR: addAttr
    });
  } finally {
    if (afterSanitizeAttributes) {
      purifier.removeHook('afterSanitizeAttributes', afterSanitizeAttributes);
    }
  }
};

/**
 * Sanitize SVG markup iHub did not write (Mermaid's output for a model's diagram) with the
 * resource rules of this module. `<style>` elements and `style` attributes stay unless they
 * load something, because Mermaid draws with them; `class` and `id` stay.
 *
 * @param {string} svg
 * @param {object} config - DOMPurify options of the caller (profiles, added tags).
 * @returns {string} Sanitized markup.
 */
export const sanitizeUntrustedSvg = (svg, config) => {
  const purifier = getSvgPurifier();
  if (!purifier) return '';
  const forbidTags = UNTRUSTED_FORBID_TAGS.filter(tag => tag !== 'style');
  const forbidAttr = UNTRUSTED_FORBID_ATTR.filter(attr => attr !== 'style');
  return purifier.sanitize(String(svg ?? ''), {
    ...config,
    FORBID_TAGS: [...forbidTags, ...(config?.FORBID_TAGS || [])],
    FORBID_ATTR: [...forbidAttr, ...(config?.FORBID_ATTR || [])]
  });
};
