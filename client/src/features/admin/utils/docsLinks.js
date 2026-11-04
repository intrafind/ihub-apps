// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { createAnchorSequence } from '../../../../../shared/docsAnchors.js';
import { buildApiUrl, buildPath } from '../../../utils/runtimeBasePath';

/**
 * Links between documentation pages are written for the repository: relative `*.md` paths,
 * resolved against the file they appear in (`docs/releases/5.6.4/features.md` links to
 * `../../integrations.md#…`). Rendered as-is inside the admin UI the browser resolves them against
 * the page URL and they break. These helpers map them onto the admin pages that show the same
 * content: release notes onto Admin → What's New, everything else onto Admin → Documentation.
 */

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Where files outside docs/ live. Some pages point at repository files that do not ship with a
 * build (`../docker/DOCKER.md`, design notes under `concepts/`); those links open on GitHub.
 */
export const REPOSITORY_BLOB_URL = 'https://github.com/intrafind/ihub-apps/blob/main/';

/** Source path of a release-notes section file, e.g. `releases/5.6.4/features.md`. */
export const releaseSourcePath = (version, file) => `releases/${version}/${file}`;

/**
 * Resolve a relative reference against the directory of `sourcePath` (both relative to docs/).
 * `null` when the reference is absolute, has a scheme, or climbs above docs/.
 *
 * @param {string} reference without fragment
 * @param {string} sourcePath
 * @returns {string|null}
 */
export function resolveDocsReference(reference, sourcePath) {
  if (!reference || reference.startsWith('/') || SCHEME_RE.test(reference)) return null;
  const parts = String(sourcePath || '')
    .split('/')
    .slice(0, -1);
  for (const segment of reference.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(segment);
    }
  }
  return parts.join('/');
}

/**
 * The admin route (without base path) a documentation link points to, or `null` when it is not a
 * link to another Markdown file (external URL, in-page fragment, mailto:, …).
 *
 * @param {string} href as written in the Markdown
 * @param {string} sourcePath the file the link appears in, relative to docs/
 * @returns {string|null}
 */
export function docsLinkTarget(href, sourcePath) {
  if (typeof href !== 'string' || !href || href.startsWith('#')) return null;
  const hashAt = href.indexOf('#');
  const reference = hashAt === -1 ? href : href.slice(0, hashAt);
  const fragment = hashAt === -1 ? '' : href.slice(hashAt);
  if (!/\.md$/i.test(reference)) return null;

  let resolved;
  try {
    resolved = resolveDocsReference(decodeURI(reference), sourcePath);
  } catch {
    resolved = resolveDocsReference(reference, sourcePath);
  }
  if (!resolved) return null;

  const release = /^releases\/([^/]+)\/[^/]+\.md$/i.exec(resolved);
  if (release) {
    return `/admin/changelog?version=${encodeURIComponent(release[1])}${fragment}`;
  }
  return `/admin/docs/${resolved.split('/').map(encodeURIComponent).join('/')}${fragment}`;
}

/**
 * The GitHub URL for a relative link that leaves docs/ (`../docker/DOCKER.md` from
 * `INSTALLATION.md`), or `null` for any other link.
 *
 * @param {string} href as written in the Markdown
 * @param {string} sourcePath the file the link appears in, relative to docs/
 * @returns {string|null}
 */
export function repositoryLinkTarget(href, sourcePath) {
  if (typeof href !== 'string' || !href || href.startsWith('#')) return null;
  const hashAt = href.indexOf('#');
  const reference = hashAt === -1 ? href : href.slice(0, hashAt);
  const fragment = hashAt === -1 ? '' : href.slice(hashAt);
  if (!reference || resolveDocsReference(reference, sourcePath) !== null) return null;
  const repositoryPath = resolveDocsReference(reference, `docs/${sourcePath}`);
  if (!repositoryPath || repositoryPath.startsWith('docs/')) return null;
  return `${REPOSITORY_BLOB_URL}${repositoryPath}${fragment}`;
}

/**
 * Rewrite the links and images of rendered documentation HTML: `*.md` links point to the admin
 * pages (with `data-docs-link` holding the router path so a click can navigate without a reload),
 * images under `docs/assets/` load from the admin docs assets endpoint. Optionally gives every
 * heading the id mdBook would, so `page.md#fragment` links land on it.
 *
 * Runs before DOMPurify (as a `renderMarkdown` `transformHtml`), so it may only add attributes the
 * sanitizer keeps.
 *
 * @param {string} html
 * @param {string} sourcePath the file the HTML was rendered from, relative to docs/
 * @param {{ headingIds?: boolean }} [options]
 * @returns {string}
 */
export function rewriteDocsHtml(html, sourcePath, { headingIds = false } = {}) {
  if (typeof document === 'undefined' || !html) return html;
  const template = document.createElement('template');
  template.innerHTML = html;
  const root = template.content;

  for (const anchor of root.querySelectorAll('a[href]')) {
    const href = anchor.getAttribute('href');
    // The shared renderer shows a link's raw destination as its tooltip; for a rewritten link
    // that is a repository path the admin cannot use.
    const dropRawTooltip = () => {
      if (anchor.getAttribute('title') === href) anchor.removeAttribute('title');
    };
    const outside = repositoryLinkTarget(href, sourcePath);
    if (outside) {
      anchor.setAttribute('href', outside);
      anchor.setAttribute('target', '_blank');
      anchor.setAttribute('rel', 'noopener noreferrer');
      dropRawTooltip();
      continue;
    }
    const target = docsLinkTarget(href, sourcePath);
    if (!target) continue;
    dropRawTooltip();
    anchor.setAttribute('href', buildPath(target));
    anchor.setAttribute('data-docs-link', target);
    anchor.removeAttribute('target');
    anchor.removeAttribute('rel');
  }

  for (const image of root.querySelectorAll('img[src]')) {
    const src = image.getAttribute('src');
    const resolved = resolveDocsReference(src.split('#')[0], sourcePath);
    if (resolved && resolved.startsWith('assets/')) {
      image.setAttribute(
        'src',
        buildApiUrl(`admin/docs/${resolved.split('/').map(encodeURIComponent).join('/')}`)
      );
    }
  }

  if (headingIds) {
    const nextAnchor = createAnchorSequence();
    for (const heading of root.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
      if (!heading.id) heading.id = nextAnchor(heading.textContent);
    }
  }

  return template.innerHTML;
}

/**
 * Click handler for a container of rewritten documentation HTML: a plain left click on a
 * documentation link navigates inside the SPA; modified clicks (new tab, …) keep their default.
 *
 * @param {MouseEvent} event
 * @param {(to: string) => void} navigate react-router's navigate
 */
export function handleDocsLinkClick(event, navigate) {
  if (event.defaultPrevented || event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const anchor = event.target?.closest?.('a[data-docs-link]');
  if (!anchor) return;
  event.preventDefault();
  navigate(anchor.getAttribute('data-docs-link'));
}
