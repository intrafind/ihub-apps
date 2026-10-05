import DOMPurify from 'dompurify';

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
 * URLs with these options.
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
 * Sanitize SVG markup produced by Mermaid before it is put into the page.
 *
 * @param {string} svg - SVG markup from `mermaid.render()`.
 * @returns {string} Sanitized markup, safe to assign to `innerHTML`.
 *
 * @example
 * const { svg } = await mermaid.render(id, code);
 * host.innerHTML = sanitizeMermaidSvg(svg);
 */
export const sanitizeMermaidSvg = svg =>
  DOMPurify.sanitize(String(svg ?? ''), MERMAID_SVG_SANITIZE_OPTIONS);
