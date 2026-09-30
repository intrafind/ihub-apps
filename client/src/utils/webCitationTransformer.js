/**
 * Web citation badges in a rendered answer.
 *
 * A citation is a Markdown link to one of the turn's web sources (see
 * `shared/webCitations.js`). After the Markdown is rendered, each such link
 * becomes a numbered superscript badge — the number is the source's position
 * in the answer's "Cited" list, whatever the model wrote. A link whose text is
 * only a marker (`1`, `[1]`, the site's host, the URL) is replaced by the
 * badge; a link with its own wording (`[the release notes](…)`) stays and gets
 * the badge after it. Links to anything the turn did not return are left alone.
 *
 * The badge stays a real link to the page (middle-click and copy work); a
 * plain click opens the sources view instead (`StreamingMarkdown`).
 *
 * @module utils/webCitationTransformer
 */
import { hostOf, sourceKey } from '../../../shared/webCitations.js';

/** Block elements a citation's passage is highlighted by. */
export const PASSAGE_SELECTOR = 'p, li, td, th, blockquote, h1, h2, h3, h4, h5, h6, dd, dt';

const NUMBER_LABEL = /^\[?\s*\d{1,3}\s*\]?$/;

function isBadge(node) {
  return node?.nodeType === 1 && node.classList?.contains('web-citation-ref');
}

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
    source?.host &&
    bare ===
      String(source.host)
        .toLowerCase()
        .replace(/^www\./, '')
  ) {
    return true;
  }
  const labelKey = sourceKey(String(label).trim());
  return Boolean(labelKey) && labelKey === sourceKey(href);
}

function createBadge(doc, n, href, source) {
  const sup = doc.createElement('sup');
  sup.className = 'web-citation-ref';
  const link = doc.createElement('a');
  link.className = 'web-citation';
  link.setAttribute('href', href);
  link.setAttribute('data-web-citation', String(n));
  const host = source?.host || hostOf(source?.url || href);
  const title = source?.title || host;
  link.setAttribute(
    'title',
    title && host && title !== host ? `${title} — ${host}` : title || href
  );
  link.setAttribute('aria-label', `${n}: ${title || host || href}`);
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
  root.querySelectorAll('sup.web-citation-ref').forEach(badge => parents.add(badge.parentNode));
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
 * Turn links to cited sources into numbered badges.
 *
 * @param {string} html - Rendered (not yet sanitized) answer HTML
 * @param {{numbers: Map<string, number>, byNumber: Map<number, Object>}|null} citations -
 *   `numbers` from `resolveCitations`, `byNumber` the cited sources by number
 * @returns {string}
 */
export function transformWebCitations(html, citations) {
  if (!html || typeof html !== 'string' || !citations?.numbers?.size) return html;
  if (typeof document === 'undefined') return html;
  const template = document.createElement('template');
  template.innerHTML = html;
  let changed = false;
  for (const anchor of Array.from(template.content.querySelectorAll('a[href]'))) {
    if (anchor.closest('pre, code')) continue;
    const href = anchor.getAttribute('href');
    const n = citations.numbers.get(sourceKey(href));
    if (!n) continue;
    const source = citations.byNumber?.get(n);
    const badge = createBadge(template.ownerDocument, n, href, source);
    if (isMarkerLabel(anchor.textContent, href, source)) anchor.replaceWith(badge);
    else anchor.after(badge);
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
    .querySelectorAll('.web-citation-active')
    .forEach(el => el.classList.remove('web-citation-active'));
  container
    .querySelectorAll('.web-citation-passage')
    .forEach(el => el.classList.remove('web-citation-passage'));
  if (!n) return;
  container.querySelectorAll(`[data-web-citation="${Number(n)}"]`).forEach(badge => {
    badge.classList.add('web-citation-active');
    const passage = badge.closest(PASSAGE_SELECTOR);
    if (passage && container.contains(passage)) passage.classList.add('web-citation-passage');
  });
}
