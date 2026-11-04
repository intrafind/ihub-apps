// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { createAnchorSequence } from '../../shared/docsAnchors.js';

/**
 * The shipped documentation (`docs/*.md`, `docs/SUMMARY.md`, `docs/assets/`) as the admin
 * documentation viewer sees it. Every path this module opens is built from a name the filesystem
 * listing returned — a request can only select a page, never spell a path.
 */

/** Directories under docs/ that are not documentation pages. */
const EXCLUDED_DIRS = new Set([
  'book',
  'theme',
  'releases',
  'assets',
  'superpowers',
  'node_modules'
]);

/**
 * Every Markdown page under `docsDir`, as POSIX paths relative to it (`integrations.md`,
 * `sub/page.md`). Release notes are left out: they have their own viewer.
 *
 * @param {string} docsDir
 * @returns {Promise<string[]>} sorted; empty when the directory does not exist
 */
export async function listDocPages(docsDir) {
  const pages = [];
  async function walk(dir, prefix) {
    let dirents;
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      if (dirent.name.startsWith('.')) continue;
      if (dirent.isDirectory()) {
        if (prefix === '' && EXCLUDED_DIRS.has(dirent.name)) continue;
        await walk(join(dir, dirent.name), `${prefix}${dirent.name}/`);
      } else if (dirent.isFile() && dirent.name.toLowerCase().endsWith('.md')) {
        pages.push(`${prefix}${dirent.name}`);
      }
    }
  }
  await walk(docsDir, '');
  return pages.sort();
}

/**
 * Parse mdBook's `SUMMARY.md` into a navigation tree. Each list item becomes
 * `{ title, path, children }`; `path` is `null` for a draft chapter (`[Title]()`) that only groups
 * its children. `# Heading` lines become part separators: `{ title, path: null, part: true }`.
 *
 * @param {string} markdown
 * @returns {Array<{ title: string, path: string|null, part?: boolean, children: Array }>}
 */
export function parseSummary(markdown) {
  const root = [];
  // Stack of { indent, children } — the list a deeper item is appended to.
  const stack = [{ indent: -1, children: root }];
  for (const line of String(markdown ?? '').split(/\r?\n/)) {
    const part = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (part) {
      root.push({ title: part[1], path: null, part: true, children: [] });
      stack.length = 1;
      continue;
    }
    const item = /^(\s*)[-*]\s+\[([^\]]+)\]\(([^)]*)\)/.exec(line);
    if (!item) continue;
    const indent = item[1].replace(/\t/g, '  ').length;
    const target = item[3].trim().replace(/^\.\//, '');
    const node = { title: item[2], path: target || null, children: [] };
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    stack[stack.length - 1].children.push(node);
    stack.push({ indent, children: node.children });
  }
  return root;
}

/**
 * The navigation tree from `SUMMARY.md`, plus a flat list of pages that exist on disk but are not
 * in the summary so the viewer can still reach them. Summary entries whose file is missing keep
 * their title but lose their path.
 *
 * @param {string} docsDir
 * @returns {Promise<{ toc: Array, unlisted: string[] }>}
 */
export async function loadDocsToc(docsDir) {
  const pages = new Set(await listDocPages(docsDir));
  const summary = await fs.readFile(join(docsDir, 'SUMMARY.md'), 'utf8').catch(() => '');
  const toc = parseSummary(summary);
  const listed = new Set();
  const prune = nodes =>
    nodes.map(node => {
      const exists = node.path && pages.has(node.path);
      if (exists) listed.add(node.path);
      return { ...node, path: exists ? node.path : null, children: prune(node.children) };
    });
  const pruned = prune(toc);
  const unlisted = [...pages].filter(page => !listed.has(page) && page !== 'SUMMARY.md');
  return { toc: pruned, unlisted };
}

/** The first `# Heading` of a page, or its file name. */
export function pageTitle(markdown, path) {
  const match = /^#\s+(.+?)\s*#*\s*$/m.exec(markdown);
  return match ? match[1].replace(/`/g, '') : path.replace(/\.md$/i, '');
}

/**
 * One page. `null` when `requested` is not one of the pages the listing found.
 *
 * @param {string} docsDir
 * @param {string} requested POSIX path relative to docsDir
 * @returns {Promise<null | { path: string, title: string, markdown: string }>}
 */
export async function loadDocPage(docsDir, requested) {
  if (typeof requested !== 'string' || !requested) return null;
  const known = (await listDocPages(docsDir)).find(page => page === requested);
  if (!known) return null;
  const markdown = await fs.readFile(join(docsDir, ...known.split('/')), 'utf8');
  return { path: known, title: pageTitle(markdown, known), markdown };
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Split a page into heading-delimited sections for search: `{ heading, anchor, text }`. Text
 * before the first heading belongs to the page itself (anchor `''`).
 */
export function splitSections(markdown) {
  const sections = [];
  const nextAnchor = createAnchorSequence();
  let current = { heading: '', anchor: '', lines: [] };
  let fence = null;
  for (const line of String(markdown ?? '').split(/\r?\n/)) {
    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1][0];
      else if (fenceMatch[1][0] === fence) fence = null;
    }
    const heading = !fence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      sections.push(current);
      current = {
        heading: heading[2].replace(/[`*]/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'),
        anchor: nextAnchor(heading[2]),
        lines: []
      };
    } else {
      current.lines.push(line);
    }
  }
  sections.push(current);
  return sections
    .map(({ heading, anchor, lines }) => ({ heading, anchor, text: lines.join('\n').trim() }))
    .filter(section => section.heading || section.text);
}

/**
 * Build the search index of all pages: one record per section.
 *
 * @param {string} docsDir
 * @returns {Promise<Array<{ path: string, title: string, heading: string, anchor: string, text: string, lower: { title: string, heading: string, text: string } }>>}
 */
export async function buildDocsIndex(docsDir) {
  const records = [];
  for (const path of await listDocPages(docsDir)) {
    if (path === 'SUMMARY.md') continue;
    const markdown = await fs.readFile(join(docsDir, ...path.split('/')), 'utf8').catch(() => '');
    const title = pageTitle(markdown, path);
    for (const section of splitSections(markdown)) {
      records.push({
        path,
        title,
        heading: section.heading,
        anchor: section.anchor,
        text: section.text,
        lower: {
          title: title.toLowerCase(),
          heading: section.heading.toLowerCase(),
          text: section.text.toLowerCase()
        }
      });
    }
  }
  return records;
}

/** A plain-text excerpt of `text` around the first hit of any term. */
function snippet(text, terms, radius = 90) {
  const plain = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_>#|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const lower = plain.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const index = lower.indexOf(term);
    if (index !== -1 && (at === -1 || index < at)) at = index;
  }
  if (at === -1) return plain.slice(0, radius * 2) + (plain.length > radius * 2 ? '…' : '');
  const start = Math.max(0, at - radius);
  const end = Math.min(plain.length, at + radius);
  return `${start > 0 ? '…' : ''}${plain.slice(start, end)}${end < plain.length ? '…' : ''}`;
}

/**
 * Rank sections for a query. Every term must occur somewhere in the section (title, heading or
 * text); title and heading hits weigh more than body hits.
 *
 * @param {ReturnType<typeof buildDocsIndex> extends Promise<infer T> ? T : never} index
 * @param {string} query
 * @param {number} [limit]
 */
export function searchDocsIndex(index, query, limit = 30) {
  const terms = String(query ?? '')
    .toLowerCase()
    .split(/\s+/)
    .map(term => term.trim())
    .filter(term => term.length > 1)
    .slice(0, 10);
  if (terms.length === 0) return [];

  const scored = [];
  for (const record of index) {
    let score = 0;
    let all = true;
    for (const term of terms) {
      const inTitle = record.lower.title.includes(term);
      const inHeading = record.lower.heading.includes(term);
      let count = 0;
      let from = record.lower.text.indexOf(term);
      while (from !== -1 && count < 20) {
        count++;
        from = record.lower.text.indexOf(term, from + term.length);
      }
      if (!inTitle && !inHeading && count === 0) {
        all = false;
        break;
      }
      score += (inTitle ? 6 : 0) + (inHeading ? 10 : 0) + Math.min(count, 10);
    }
    if (all) scored.push({ record, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(({ record }) => ({
    path: record.path,
    title: record.title,
    heading: record.heading,
    anchor: record.anchor,
    snippet: snippet(record.text, terms)
  }));
}
