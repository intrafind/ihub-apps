/**
 * Citation badges in a rendered answer.
 *
 * A citation is anything in the answer that points at one of its sources (see
 * `shared/sources/citations.js`): a Markdown link to a source's URL, or a
 * provider marker such as iAssistant's `<cite type="r">2</cite>`. After the
 * Markdown is rendered, each one becomes the same numbered superscript badge —
 * the number is the source's position in the answer's "Cited" list, whatever
 * the text wrote. A link whose text is only a marker (`1`, `[1]`, the site's
 * host, the URL) is replaced by the badge; a link with its own wording
 * (`[the release notes](…)`) stays and gets the badge after it. Links to
 * anything the answer's sources do not include are left alone.
 *
 * A badge for a source with a link stays a real link (middle-click and copy
 * work); one for a source without is a button. A plain click opens the
 * sources panel instead (`StreamingMarkdown`).
 *
 * @module utils/sourceCitationTransformer
 */
import { citeMarker, hostOf, urlKey } from '../../../shared/sources/index.js';

/** Block elements a citation's passage is highlighted by. */
export const PASSAGE_SELECTOR = 'p, li, td, th, blockquote, h1, h2, h3, h4, h5, h6, dd, dt';

const NUMBER_LABEL = /^\[?\s*\d{1,3}\s*\]?$/;

/** Whether the node is a citation badge this transformer created. */
function isBadge(node) {
  return node?.nodeType === 1 && node.classList?.contains('source-citation-ref');
}

/** Whether the node is a text node. */
function isText(node) {
  return node?.nodeType === 3;
}

/**
 * Whether a link's text only marks a citation (a number, the host, the URL),
 * so the badge can take its place.
 */
function isMarkerLabel(label, href, source) {
  const text = String(label || '')
    .trim()
    .toLowerCase();
  if (!text || NUMBER_LABEL.test(text)) return true;
  const bare = text
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/$/, '');
  const host = hostOf(href).toLowerCase();
  if (bare === host) return true;
  if (
    source?.site &&
    bare ===
      String(source.site)
        .toLowerCase()
        .replace(/^www\./, '')
  ) {
    return true;
  }
  const labelKey = urlKey(String(label).trim());
  return Boolean(labelKey) && labelKey === urlKey(href);
}

/** The badge for citation `n`: a link when the source has one, else a keyboard-operable button. */
function createBadge(doc, n, href, source) {
  const sup = doc.createElement('sup');
  sup.className = 'source-citation-ref';
  const link = doc.createElement('a');
  link.className = 'source-citation';
  if (href) {
    link.setAttribute('href', href);
  } else {
    // Nothing to open in a new tab: a button onto the sources panel.
    link.setAttribute('role', 'button');
    link.setAttribute('tabindex', '0');
  }
  link.setAttribute('data-source-citation', String(n));
  const site = source?.site || (source?.url || href ? hostOf(source?.url || href) : '');
  const title = source?.title || site;
  link.setAttribute(
    'title',
    title && site && title !== site ? `${title} — ${site}` : title || href || String(n)
  );
  link.setAttribute('aria-label', `${n}: ${title || site || href || n}`);
  link.textContent = String(n);
  sup.appendChild(link);
  return sup;
}

/**
 * Tidy a run of badges that replaced `([a](…), [b](…))`: drop the separators
 * between them and the parentheses around them, so the run reads as badges.
 */
function tidyBadgeRuns(root) {
  const parents = new Set();
  root.querySelectorAll('sup.source-citation-ref').forEach(badge => parents.add(badge.parentNode));
  for (const parent of parents) {
    const nodes = Array.from(parent.childNodes);
    for (let i = 0; i < nodes.length; i++) {
      if (!isBadge(nodes[i])) continue;
      // Extend the run over separator text and further badges.
      let end = i;
      for (let j = i + 1; j < nodes.length; j++) {
        if (isBadge(nodes[j])) {
          end = j;
        } else if (!(isText(nodes[j]) && /^[\s,;]*$/.test(nodes[j].data))) {
          break;
        }
      }
      for (let j = i + 1; j < end; j++) {
        if (isText(nodes[j])) nodes[j].data = '';
      }
      const before = nodes[i - 1];
      const after = nodes[end + 1];
      if (
        isText(before) &&
        isText(after) &&
        /\(\s*$/.test(before.data) &&
        /^\s*\)/.test(after.data)
      ) {
        before.data = before.data.replace(/\s*\(\s*$/, '');
        after.data = after.data.replace(/^\s*\)/, '');
      }
      // A superscript sits right after the word it marks: `place [1](…)` has
      // no gap before its badge.
      if (isText(before)) before.data = before.data.replace(/\s+$/, '');
      i = end;
    }
  }
}

/**
 * Turn every citation of a source the answer cites into its numbered badge.
 *
 * @param {string} html - Rendered (not yet sanitized) answer HTML
 * @param {{numberOfUrl: Function, numberOfMarker: Function, byNumber: Map<number, Object>}|null} citations -
 *   from `resolveCitations`, with the cited sources by number
 * @returns {string}
 */
export function transformSourceCitations(html, citations) {
  if (!html || typeof html !== 'string' || !citations?.byNumber?.size) return html;
  if (typeof document === 'undefined') return html;
  const template = document.createElement('template');
  template.innerHTML = html;
  const doc = template.ownerDocument;
  let changed = false;
  for (const anchor of Array.from(template.content.querySelectorAll('a[href]'))) {
    if (anchor.closest('pre, code')) continue;
    const href = anchor.getAttribute('href');
    const n = citations.numberOfUrl(href);
    if (!n) continue;
    const source = citations.byNumber.get(n);
    const badge = createBadge(doc, n, href, source);
    if (isMarkerLabel(anchor.textContent, href, source)) anchor.replaceWith(badge);
    else anchor.after(badge);
    changed = true;
  }
  for (const cite of Array.from(template.content.querySelectorAll('cite[type]'))) {
    if (cite.closest('pre, code')) continue;
    const type = String(cite.getAttribute('type') || '').toLowerCase();
    const num = cite.textContent.trim();
    if (!/^[rs]$/.test(type) || !/^\d+$/.test(num)) continue;
    const n = citations.numberOfMarker(citeMarker(type, num));
    if (!n) continue;
    const source = citations.byNumber.get(n);
    cite.replaceWith(createBadge(doc, n, source?.url || null, source));
    changed = true;
  }
  if (!changed) return html;
  tidyBadgeRuns(template.content);
  return template.innerHTML;
}

/**
 * Highlight citation `n` in a rendered answer: its badges, and the passages
 * (paragraph, list item, table cell) they sit in. `null` clears it.
 *
 * @param {HTMLElement} container
 * @param {number|null} n
 */
export function applyCitationHighlight(container, n) {
  if (!container) return;
  container
    .querySelectorAll('.source-citation-active')
    .forEach(el => el.classList.remove('source-citation-active'));
  container
    .querySelectorAll('.source-citation-passage')
    .forEach(el => el.classList.remove('source-citation-passage'));
  if (!n) return;
  container.querySelectorAll(`[data-source-citation="${Number(n)}"]`).forEach(badge => {
    badge.classList.add('source-citation-active');
    const passage = badge.closest(PASSAGE_SELECTOR);
    if (passage && container.contains(passage)) passage.classList.add('source-citation-passage');
  });
}
