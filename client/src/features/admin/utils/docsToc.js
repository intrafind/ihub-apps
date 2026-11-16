// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The documentation navigation as the viewer uses it. The server sends SUMMARY.md as a tree in
 * which `# Part` headings are separators between top-level entries; these helpers turn that into
 * sections, a reading order for previous/next, and the trail from a section down to a page.
 */

/**
 * Group the top-level entries under the part heading before them. Entries before the first part
 * form a section without a title (the introduction).
 *
 * @param {Array<{ title: string, path: string|null, part?: boolean, children: Array }>} toc
 * @returns {Array<{ id: string, title: string|null, items: Array }>}
 */
export function groupDocsSections(toc) {
  const sections = [];
  let current = { id: 'intro', title: null, items: [] };
  for (const node of toc || []) {
    if (node.part) {
      if (current.items.length > 0 || current.title) sections.push(current);
      current = { id: `part-${sections.length}-${node.title}`, title: node.title, items: [] };
    } else {
      current.items.push(node);
    }
  }
  if (current.items.length > 0 || current.title) sections.push(current);
  return sections;
}

/**
 * Every page in reading order, with where it sits: its section and the entries above it.
 *
 * @param {ReturnType<typeof groupDocsSections>} sections
 * @returns {Array<{ path: string, title: string, description?: string, section: object|null,
 *   ancestors: Array<{ title: string, path: string|null }> }>}
 */
export function flattenDocsPages(sections) {
  const pages = [];
  const walk = (nodes, section, ancestors) => {
    for (const node of nodes) {
      if (node.path) {
        pages.push({
          path: node.path,
          title: node.title,
          description: node.description,
          section,
          ancestors
        });
      }
      if (node.children?.length) {
        walk(node.children, section, [...ancestors, { title: node.title, path: node.path }]);
      }
    }
  };
  for (const section of sections) walk(section.items, section, []);
  return pages;
}

/**
 * Where a page sits and its neighbours in reading order. A page listed twice uses its first entry.
 *
 * @param {ReturnType<typeof flattenDocsPages>} pages
 * @param {string} path
 * @returns {{ entry: object|null, previous: object|null, next: object|null }}
 */
export function locateDocsPage(pages, path) {
  const index = pages.findIndex(page => page.path === path);
  if (index === -1) return { entry: null, previous: null, next: null };
  return {
    entry: pages[index],
    previous: index > 0 ? pages[index - 1] : null,
    next: index < pages.length - 1 ? pages[index + 1] : null
  };
}

/**
 * Whether `nodes` (or their children) contain the page at `path`.
 *
 * @param {Array} nodes
 * @param {string} path
 * @returns {boolean}
 */
export function docsNodesContain(nodes, path) {
  return (nodes || []).some(node => node.path === path || docsNodesContain(node.children, path));
}

/** The admin route of a documentation page, with an optional heading fragment. */
export const docsRoute = (path, anchor) =>
  `/admin/docs/${path.split('/').map(encodeURIComponent).join('/')}${anchor ? `#${anchor}` : ''}`;
