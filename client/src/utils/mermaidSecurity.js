// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import {
  UNTRUSTED_FORBID_ATTR,
  UNTRUSTED_FORBID_TAGS,
  cssLoadsResource,
  isLocalResourceUrl,
  sanitizeUntrustedSvg
} from './untrustedHtml';

/**
 * Shared trust and sanitization rules for Mermaid diagrams.
 *
 * Diagram containers are created by the Markdown renderer
 * (`config/marked.config.js`) and turned into diagrams by
 * `hooks/useMermaidRenderer.js`. Rendered Markdown keeps `class` and `data-*`
 * attributes through DOMPurify, so content (model output, user messages, page
 * content) can produce an element that looks exactly like a diagram container.
 * The helpers below let the hook tell the two apart and keep whatever Mermaid
 * returns free of active content.
 */

/**
 * Attribute the Markdown renderer puts on every diagram container it creates.
 * It is a `data-*` attribute so the default DOMPurify pass in `renderMarkdown`
 * keeps it.
 *
 * @type {string}
 */
export const MERMAID_CONTAINER_TOKEN_ATTRIBUTE = 'data-mermaid-token';

/**
 * Number of random bytes in the container token (128 bits).
 *
 * @type {number}
 */
const TOKEN_BYTES = 16;

/**
 * Create a random hex token with the platform CSPRNG.
 *
 * @returns {string} 32 lowercase hex characters.
 */
const createContainerToken = () => {
  const bytes = new Uint8Array(TOKEN_BYTES);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
};

/**
 * Per-page-load token that marks diagram containers created by the Markdown
 * renderer. It is generated once when this module loads and never derived from
 * content, so content cannot reproduce it. It stays the same for the lifetime
 * of the page, which keeps re-parsing the same Markdown byte-identical (React
 * then leaves already rendered diagrams alone).
 *
 * @type {string}
 */
export const MERMAID_CONTAINER_TOKEN = createContainerToken();

/**
 * Whether an element is a diagram container created by the Markdown renderer
 * during this page load.
 *
 * @param {Element|null|undefined} element - Candidate container.
 * @returns {boolean} True only when the element carries the current token.
 *
 * @example
 * const container = button.closest('.mermaid-diagram-container');
 * if (!isTrustedMermaidContainer(container)) return;
 */
export const isTrustedMermaidContainer = element =>
  Boolean(element) &&
  typeof element.getAttribute === 'function' &&
  element.getAttribute(MERMAID_CONTAINER_TOKEN_ATTRIBUTE) === MERMAID_CONTAINER_TOKEN;

/**
 * DOMPurify options for the SVG markup returned by `mermaid.render()`.
 *
 * They match what Mermaid itself applies at its non-"loose" security levels,
 * so every diagram type keeps rendering:
 * - `foreignObject` is not in DOMPurify's SVG allow-list but carries the HTML
 *   node labels (`htmlLabels`), so it is added back, and it is declared an
 *   HTML integration point so the HTML inside it (`div`, `span`, `p`, ...) is
 *   kept rather than dropped as being in the wrong namespace.
 * - `dominant-baseline` is used for text alignment and is not in DOMPurify's
 *   SVG attribute list.
 * - The MathML profile keeps math labels, which Mermaid renders as MathML.
 *
 * DOMPurify still removes scripts, event handler attributes and `javascript:`
 * URLs with these options; {@link sanitizeMermaidSvg} adds the resource rules of
 * `utils/untrustedHtml`.
 *
 * @type {Readonly<Object>}
 */
export const MERMAID_SVG_SANITIZE_OPTIONS = Object.freeze({
  USE_PROFILES: { html: true, svg: true, svgFilters: true, mathMl: true },
  ADD_TAGS: ['foreignObject'],
  ADD_ATTR: ['dominant-baseline'],
  HTML_INTEGRATION_POINTS: { foreignobject: true }
});

/**
 * Sanitize SVG markup produced by Mermaid before it is put into the page, with the resource
 * rules for untrusted content (`utils/untrustedHtml`): nothing that loads from another origin
 * survives, also not in a `<style>` element or `style` attribute.
 *
 * @param {string} svg - SVG markup from `mermaid.render()`.
 * @returns {string} Sanitized markup, safe to assign to `innerHTML`.
 *
 * @example
 * const { svg } = await mermaid.render(id, code);
 * host.innerHTML = sanitizeMermaidSvg(svg);
 */
export const sanitizeMermaidSvg = svg =>
  sanitizeUntrustedSvg(String(svg ?? ''), MERMAID_SVG_SANITIZE_OPTIONS);

/**
 * DOMPurify options Mermaid applies to the HTML inside node and edge labels (its
 * `dompurifyConfig`). Labels are drawn in the page while Mermaid measures them, before
 * {@link sanitizeMermaidSvg} sees the result, so an `<img>` there would already have been
 * fetched: everything that loads or styles is removed up front.
 *
 * @type {Readonly<Object>}
 */
export const MERMAID_LABEL_SANITIZE_OPTIONS = Object.freeze({
  FORBID_TAGS: [...UNTRUSTED_FORBID_TAGS, 'img', 'image', 'feimage', 'input'],
  FORBID_ATTR: [...UNTRUSTED_FORBID_ATTR, 'src', 'class', 'id']
});

/**
 * Configuration keys a diagram may not change with an `%%{init}%%` directive or front matter.
 * Mermaid's own defaults stay secure as well; these add the label sanitizing options and the
 * values Mermaid writes into the diagram's stylesheet unchecked.
 *
 * @type {ReadonlyArray<string>}
 */
export const MERMAID_SECURE_CONFIG_KEYS = Object.freeze([
  'secure',
  'securityLevel',
  'startOnLoad',
  'maxTextSize',
  'suppressErrorRendering',
  'maxEdges',
  'dompurifyConfig',
  'themeCSS',
  'fontFamily',
  'altFontFamily'
]);

/** HTML tags that load or style something; none of them belongs in diagram source. */
const LOADING_TAG =
  /<\s*\/?\s*(img|image|svg|video|audio|source|picture|input|iframe|frame|object|embed|link|style|use|feimage|track|base|meta|form)\b/;
/** HTML attributes that load something. */
const LOADING_ATTRIBUTE = /\b(srcset|background|poster|lowsrc|dynsrc)\s*=/;

const NAMED_ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", colon: ':', sol: '/' };

/**
 * Character references as HTML (`&#60;`, `&lt;`) and Mermaid (`#60;`, `#lt;`) write them.
 */
const decodeEntities = text =>
  text.replace(/(?:&#|#)(x[0-9a-f]+|\d+);|(?:&|#)([a-z]+);/gi, (match, numeric, name) => {
    if (name) return NAMED_ENTITIES[name.toLowerCase()] ?? match;
    const value = /^x/i.test(numeric) ? parseInt(numeric.slice(1), 16) : Number(numeric);
    return String.fromCodePoint(Math.min(value, 0x10ffff));
  });

/** Escapes as JSON (`%%{init}%%`) and YAML (front matter, `@{…}`) strings read them. */
const decodeStringEscapes = text =>
  text.replace(
    /\\(x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|[\s\S])/g,
    (_, esc) => {
      if (/^x/.test(esc)) return String.fromCodePoint(parseInt(esc.slice(1), 16));
      if (/^u\{/.test(esc))
        return String.fromCodePoint(Math.min(parseInt(esc.slice(2, -1), 16), 0x10ffff));
      if (/^[uU][0-9a-fA-F]/.test(esc)) {
        return String.fromCodePoint(Math.min(parseInt(esc.slice(1), 16), 0x10ffff));
      }
      return esc;
    }
  );

/**
 * The `@{ … }` metadata blocks of a diagram (shapes, images, icons), each from its opening
 * brace to the matching closing one, quoted strings skipped.
 */
const metadataBlocks = code => {
  const blocks = [];
  const opener = /@\s*\{/g;
  let match;
  while ((match = opener.exec(code)) !== null) {
    let depth = 0;
    let quote = null;
    let end = code.length;
    for (let i = match.index + match[0].length - 1; i < code.length; i += 1) {
      const ch = code[i];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '{') {
        depth += 1;
      } else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    blocks.push(code.slice(match.index, end));
    opener.lastIndex = end;
  }
  return blocks;
};

/** Whether a metadata block names an image Mermaid would fetch from another origin. */
const metadataLoadsForeignImage = block => {
  // Escapes, anchors and aliases could spell a key or a value this check does not see.
  if (block.includes('\\')) return true;
  const unquoted = block.replace(/"[^"]*"|'[^']*'/g, '""');
  if (/[&*]/.test(unquoted) || /<</.test(unquoted)) return true;
  const imagePattern = /(^|[\s{,])["']?img["']?\s*:\s*("([^"]*)"|'([^']*)'|[^,}\s]*)/g;
  let match;
  while ((match = imagePattern.exec(block)) !== null) {
    const value = (match[3] ?? match[4] ?? match[2] ?? '').trim();
    if (!value || value.startsWith('//') || !isLocalResourceUrl(value)) return true;
  }
  return false;
};

/**
 * Why a diagram must not be drawn, or `''` when it may. Mermaid draws a diagram inside the page
 * to measure it, so a diagram that names an image or a stylesheet on another host would make
 * the browser fetch it before any sanitizing of the result: an `@{ img: … }` shape on another
 * origin, HTML tags that load something, or CSS (`style`, `classDef`, `themeCSS`, …) with
 * `url()`, `image-set()` or `@import`. The source is checked as written and with its HTML,
 * JSON/YAML and CSS escapes resolved.
 *
 * Text that only mentions such a thing in a label ("use url(…)") is refused as well; the reader
 * still gets the diagram source.
 *
 * @param {string} code - Diagram source.
 * @returns {string} The reason, or `''`.
 */
export const mermaidExternalResourceReason = code => {
  const source = String(code ?? '');
  if (metadataBlocks(source).some(metadataLoadsForeignImage)) {
    return 'It shows an image from another site.';
  }
  const entities = decodeEntities(source);
  const variants = new Set([
    source,
    entities,
    decodeStringEscapes(source),
    decodeStringEscapes(entities),
    decodeEntities(decodeStringEscapes(source))
  ]);
  for (const variant of variants) {
    const lower = variant.toLowerCase();
    if (LOADING_TAG.test(lower) || LOADING_ATTRIBUTE.test(lower)) {
      return 'It contains HTML that loads content.';
    }
    if (cssLoadsResource(variant, { foreignOnly: true })) {
      return 'Its styles load content from another site.';
    }
  }
  return '';
};
