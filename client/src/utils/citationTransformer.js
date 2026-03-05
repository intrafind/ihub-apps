/**
 * Citation Transformer
 * Post-processes rendered HTML to make <cite type="s">N</cite> and <cite type="r">N</cite>
 * interactive inline citation badges.
 *
 * - type="s" -> source passage citation (scrolls to passage in CitationPanel)
 * - type="r" -> result item/document citation (scrolls to document tile in CitationPanel)
 */

/**
 * Transform cite tags in HTML string into interactive citation badges.
 * @param {string} html - Rendered HTML string
 * @returns {string} Transformed HTML with interactive citation badges
 */
export function transformCitations(html) {
  if (!html || typeof html !== 'string') return html;

  // Replace <cite type="s">N</cite> with source citation badges
  let result = html.replace(
    /<cite\s+type="s"\s*>(\d+)<\/cite>/gi,
    (_, num) =>
      `<span class="citation-badge citation-source" data-citation-type="s" data-citation-num="${num}" role="button" tabindex="0" title="Source ${num}">${num}</span>`
  );

  // Replace <cite type="r">N</cite> with result item citation badges
  result = result.replace(
    /<cite\s+type="r"\s*>(\d+)<\/cite>/gi,
    (_, num) =>
      `<span class="citation-badge citation-result" data-citation-type="r" data-citation-num="${num}" role="button" tabindex="0" title="Document ${num}">${num}</span>`
  );

  return result;
}

/**
 * Attach click handlers to citation badges within a container element.
 * @param {HTMLElement} container - The DOM element containing citation badges
 * @param {Function} onCitationClick - Callback: (type, num) => void
 */
export function attachCitationHandlers(container, onCitationClick) {
  if (!container || !onCitationClick) return;

  const badges = container.querySelectorAll('.citation-badge');
  badges.forEach(badge => {
    const type = badge.dataset.citationType;
    const num = badge.dataset.citationNum;

    const handler = () => onCitationClick(type, parseInt(num, 10));
    badge.addEventListener('click', handler);
    badge.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handler();
      }
    });
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
