/**
 * Citation Transformer
 * Post-processes rendered HTML to make <cite type="s">N</cite> and <cite type="r">N</cite>
 * interactive inline citation badges.
 *
 * - type="s" -> source passage citation (scrolls to passage in CitationPanel)
 * - type="r" -> result item/document citation (scrolls to document tile in CitationPanel)
 */

const PREVIEW_MAX_LENGTH = 160;

function escapeHtmlAttribute(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function truncatePreview(text) {
  if (!text || typeof text !== 'string') return '';
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > PREVIEW_MAX_LENGTH ? `${clean.slice(0, PREVIEW_MAX_LENGTH)}…` : clean;
}

/**
 * Build lookup maps from a message's citations object so badges can carry a
 * short excerpt for the hover/focus preview.
 * @param {Object} [citations] - { references: [], resultItems: [] }
 */
function buildCitationPreviewMaps(citations) {
  const sourceMap = new Map();
  const resultMap = new Map();

  const references = citations?.references || [];
  for (const ref of references) {
    if (ref?.index != null && ref.content) {
      sourceMap.set(Number(ref.index), ref.content);
    }
  }

  const resultItems = citations?.resultItems || [];
  resultItems.forEach((item, i) => {
    const title = item?.title || item?.additional_document_metadata?.title;
    const text = Array.isArray(title) ? title[0] : title;
    if (text) resultMap.set(i + 1, text);
  });

  return { sourceMap, resultMap };
}

function renderCitationBadge(type, num, rawPreview) {
  const label = type === 's' ? 'Source' : 'Document';
  const preview = truncatePreview(rawPreview);
  const ariaLabel = preview ? `${label} ${num}: ${preview}` : `${label} ${num}`;
  const cssClass = type === 's' ? 'citation-source' : 'citation-result';
  const previewAttr = preview ? ` data-citation-preview="${escapeHtmlAttribute(preview)}"` : '';

  return (
    `<span class="citation-badge ${cssClass}" data-citation-type="${type}" data-citation-num="${num}" ` +
    `role="button" tabindex="0" aria-label="${escapeHtmlAttribute(ariaLabel)}"${previewAttr}>${num}</span>`
  );
}

/**
 * Transform cite tags in HTML string into interactive citation badges.
 * @param {string} html - Rendered HTML string
 * @param {Object} [citations] - Message citations ({ references: [], resultItems: [] })
 *   used to embed a short excerpt on each badge for the hover/focus preview.
 * @returns {string} Transformed HTML with interactive citation badges
 */
export function transformCitations(html, citations) {
  if (!html || typeof html !== 'string') return html;

  const { sourceMap, resultMap } = buildCitationPreviewMaps(citations);

  // Replace <cite type="s">N</cite> with source citation badges
  let result = html.replace(/<cite\s+type="s"\s*>(\d+)<\/cite>/gi, (_, num) =>
    renderCitationBadge('s', num, sourceMap.get(Number(num)))
  );

  // Replace <cite type="r">N</cite> with result item citation badges
  result = result.replace(/<cite\s+type="r"\s*>(\d+)<\/cite>/gi, (_, num) =>
    renderCitationBadge('r', num, resultMap.get(Number(num)))
  );

  return result;
}

let citationTooltipEl = null;

function getCitationTooltipElement() {
  if (citationTooltipEl && document.body.contains(citationTooltipEl)) return citationTooltipEl;
  citationTooltipEl = document.createElement('div');
  citationTooltipEl.className = 'citation-tooltip';
  citationTooltipEl.setAttribute('role', 'tooltip');
  document.body.appendChild(citationTooltipEl);
  return citationTooltipEl;
}

function showCitationTooltip(badge, text) {
  if (!text) return;
  const tooltip = getCitationTooltipElement();
  tooltip.textContent = text;
  tooltip.style.visibility = 'hidden';
  tooltip.style.display = 'block';

  const badgeRect = badge.getBoundingClientRect();
  const tooltipRect = tooltip.getBoundingClientRect();

  let top = badgeRect.top - tooltipRect.height - 8;
  if (top < 8) top = badgeRect.bottom + 8;

  let left = badgeRect.left + badgeRect.width / 2 - tooltipRect.width / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - tooltipRect.width - 8));

  tooltip.style.top = `${top + window.scrollY}px`;
  tooltip.style.left = `${left + window.scrollX}px`;
  tooltip.style.visibility = 'visible';
}

function hideCitationTooltip() {
  if (citationTooltipEl) {
    citationTooltipEl.style.display = 'none';
  }
}

/**
 * Briefly highlight a citation's target in the CitationPanel without scrolling
 * to it — used for hover/focus preview so it doesn't yank the viewport around.
 * A no-op when the target isn't currently rendered (e.g. a passage whose
 * parent document is collapsed).
 */
function setCitationPeek(type, num, active) {
  const el = document.getElementById(`citation-${type}-${num}`);
  if (!el) return;
  el.classList.toggle('ring-2', active);
  el.classList.toggle('ring-indigo-400', active);
}

/**
 * Attach click and hover/focus preview handlers to citation badges within a
 * container element.
 * @param {HTMLElement} container - The DOM element containing citation badges
 * @param {Function} onCitationClick - Callback: (type, num) => void
 */
export function attachCitationHandlers(container, onCitationClick) {
  if (!container || !onCitationClick) return;

  const badges = container.querySelectorAll('.citation-badge');
  badges.forEach(badge => {
    const type = badge.dataset.citationType;
    const num = parseInt(badge.dataset.citationNum, 10);
    const preview = badge.dataset.citationPreview;

    const handler = () => onCitationClick(type, num);
    badge.addEventListener('click', handler);
    badge.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handler();
      }
    });

    const showPeek = () => {
      showCitationTooltip(badge, preview);
      setCitationPeek(type, num, true);
    };
    const hidePeek = () => {
      hideCitationTooltip();
      setCitationPeek(type, num, false);
    };

    badge.addEventListener('mouseenter', showPeek);
    badge.addEventListener('mouseleave', hidePeek);
    badge.addEventListener('focus', showPeek);
    badge.addEventListener('blur', hidePeek);
  });
}

/**
 * Scroll to and highlight a citation target in the CitationPanel.
 * For source passages (type="s"), dispatches a custom event so CitationPanel
 * can auto-expand the parent document before scrolling.
 * For result documents (type="r"), scrolls directly to the document card.
 *
 * @param {string} type - 's' for source passage, 'r' for result document
 * @param {number} num - Citation number (1-based)
 */
export function scrollToCitation(type, num) {
  const elementId = `citation-${type}-${num}`;

  // For passages, dispatch event so CitationPanel can expand the parent document first
  if (type === 's') {
    window.dispatchEvent(
      new CustomEvent('citation-navigate', { detail: { type, num, elementId } })
    );
    return;
  }

  // For documents, scroll directly
  scrollToElement(elementId);
}

/**
 * Scroll to an element by ID and apply a flash highlight.
 * @param {string} elementId - DOM element ID to scroll to
 */
export function scrollToElement(elementId) {
  const element = document.getElementById(elementId);
  if (element) {
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    element.classList.add('ring-2', 'ring-indigo-400');
    setTimeout(() => {
      element.classList.remove('ring-2', 'ring-indigo-400');
    }, 2000);
  }
}

/**
 * CSS styles for citation badges (should be included in the app's styles or a CSS file).
 * Exported as a string for convenience.
 */
export const citationBadgeStyles = `
.citation-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 1.25rem;
  height: 1.25rem;
  padding: 0 0.25rem;
  margin: 0 0.125rem;
  font-size: 0.65rem;
  font-weight: 600;
  line-height: 1;
  border-radius: 0.375rem;
  cursor: pointer;
  vertical-align: super;
  transition: background-color 0.15s, transform 0.1s;
}

.citation-badge:hover {
  transform: scale(1.1);
}

.citation-badge:focus-visible {
  outline: 2px solid rgb(99, 102, 241);
  outline-offset: 1px;
}

.citation-source {
  background-color: rgb(224, 231, 255);
  color: rgb(67, 56, 202);
}

.dark .citation-source {
  background-color: rgba(67, 56, 202, 0.3);
  color: rgb(165, 180, 252);
}

.citation-result {
  background-color: rgb(209, 250, 229);
  color: rgb(4, 120, 87);
}

.dark .citation-result {
  background-color: rgba(4, 120, 87, 0.3);
  color: rgb(110, 231, 183);
}
`;
