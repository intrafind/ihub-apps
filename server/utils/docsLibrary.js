// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { createAnchorSequence } from '../../shared/docsAnchors.js';
import { splitDocsFrontMatter } from '../../shared/docsFrontMatter.js';
import { parseFrontMatter } from './frontMatter.js';

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
  // Code-unit order, so the listing is the same on every platform and locale.
  return pages.sort((a, b) => Number(a > b) - Number(a < b));
}

/**
 * Parse mdBook's `SUMMARY.md` into a navigation tree. Each list item becomes
 * `{ title, path, children }`; `path` is `null` for a draft chapter (`[Title]()`) that only groups
 * its children. A link that is not a list item (mdBook's prefix or suffix chapter, such as
 * `[Introduction](README.md)`) becomes a top-level node. `# Heading` lines become part separators:
 * `{ title, path: null, part: true }`.
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
    const chapter = /^\[([^\]]+)\]\(([^)]*)\)\s*$/.exec(line);
    if (chapter) {
      root.push({
        title: chapter[1],
        path: chapter[2].trim().replace(/^\.\//, '') || null,
        children: []
      });
      stack.length = 1;
      continue;
    }
    const item = /^(\s*)[-*]\s+\[([^\]]+)\]\(([^)]*)\)/.exec(line);
    if (!item) continue;
    const indent = item[1].replace(/\t/g, '  ').length;
    const target = item[3].trim().replace(/^\.\//, '');
    const node = { title: item[2], path: target || null, children: [] };
    while (stack.length > 1 && stack.at(-1).indent >= indent) stack.pop();
    stack.at(-1).children.push(node);
    stack.push({ indent, children: node.children });
  }
  return root;
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

/** Front-matter fields `GET /api/admin/docs/page` returns next to `title`. */
const PAGE_FIELDS = ['description', 'audience', 'type', 'adminPage', 'since'];

/** Values `audience` may take in a page's front-matter. */
const AUDIENCES = new Set(['admin', 'developer', 'user']);
/** Values `type` may take in a page's front-matter. */
const PAGE_TYPES = new Set(['tutorial', 'how-to', 'reference', 'concept', 'troubleshooting']);
/** An admin route the viewer may link to: `/admin`, `/admin/models`, `/admin/ui/disclaimer`. */
const ADMIN_PAGE_RE = /^\/admin(?:\/[A-Za-z0-9_~-][A-Za-z0-9._~-]*)*$/;

/** A single-line string value, or undefined. */
function metaString(value, max) {
  if (typeof value === 'number') value = String(value);
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : undefined;
}

/**
 * The page metadata the viewer understands, from a parsed front-matter object. Unknown keys and
 * values outside the allowed sets are dropped; `hidden` is present only when it is `true`.
 *
 * @param {*} data
 * @returns {{ title?: string, description?: string, audience?: string, type?: string, adminPage?: string, since?: string, hidden?: true }}
 */
export function normalizeDocMeta(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  const meta = {
    title: metaString(data.title, 200),
    description: metaString(data.description, 500),
    audience: AUDIENCES.has(data.audience) ? data.audience : undefined,
    type: PAGE_TYPES.has(data.type) ? data.type : undefined,
    adminPage:
      typeof data.adminPage === 'string' && ADMIN_PAGE_RE.test(data.adminPage.trim())
        ? data.adminPage.trim()
        : undefined,
    since: metaString(data.since, 40),
    hidden: data.hidden === true ? true : undefined
  };
  return Object.fromEntries(Object.entries(meta).filter(([, value]) => value !== undefined));
}

/**
 * Split a page into its front-matter metadata and the Markdown body after it. A page without
 * front-matter is returned unchanged; a block that is not valid YAML is still removed from the
 * body but yields no metadata.
 *
 * @param {string} raw
 * @returns {{ meta: ReturnType<typeof normalizeDocMeta>, body: string }}
 */
export function splitFrontMatter(raw) {
  const { block, body } = splitDocsFrontMatter(raw);
  if (block === null) return { meta: {}, body };
  let data = {};
  try {
    data = parseFrontMatter(`---\n${block}---\n`).data;
  } catch {
    data = {};
  }
  return { meta: normalizeDocMeta(data), body };
}

/** Heading text as plain text: no code ticks, emphasis or link targets. */
function plainHeading(text) {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*]/g, '')
    .trim();
}

/** The text of the first `# Heading` outside code fences, or `null`. */
export function firstHeading(markdown) {
  let fence = null;
  for (const line of String(markdown ?? '').split(/\r?\n/)) {
    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1][0];
      else if (fenceMatch[1].startsWith(fence)) fence = null;
      continue;
    }
    if (fence) continue;
    const heading = /^ {0,3}#\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) return plainHeading(heading[1]) || null;
  }
  return null;
}

/**
 * The canonical title of a page: front-matter `title`, then the first H1 outside code fences, then
 * the page's SUMMARY label, then its file name.
 *
 * @param {string} raw the page as stored, front-matter included
 * @param {string} path
 * @param {string} [summaryTitle]
 */
export function pageTitle(raw, path, summaryTitle) {
  const { meta, body } = splitFrontMatter(raw);
  return (
    meta.title ||
    firstHeading(body) ||
    (summaryTitle && summaryTitle.trim()) ||
    path.replace(/^.*\//, '').replace(/\.md$/i, '')
  );
}

/** `path → label` of every page in a parsed SUMMARY tree (the first entry wins). */
function summaryTitles(tree, titles = new Map()) {
  for (const node of tree) {
    if (node.path && !titles.has(node.path)) titles.set(node.path, node.title);
    summaryTitles(node.children, titles);
  }
  return titles;
}

async function readSummary(docsDir) {
  return parseSummary(await fs.readFile(join(docsDir, 'SUMMARY.md'), 'utf8').catch(() => ''));
}

async function readPage(docsDir, path) {
  return fs.readFile(join(docsDir, ...path.split('/')), 'utf8').catch(() => '');
}

/**
 * The navigation tree from `SUMMARY.md`, plus a flat list of pages that exist on disk but are not
 * in the summary so the viewer can still reach them. Summary entries whose file is missing keep
 * their title but lose their path. A page node carries the page's front-matter `description` when
 * it has one; its `title` stays the SUMMARY label. Pages marked `hidden: true` in their
 * front-matter (redirect stubs) are left out of `unlisted`.
 *
 * @param {string} docsDir
 * @returns {Promise<{ toc: Array, unlisted: string[] }>}
 */
export async function loadDocsToc(docsDir) {
  const pages = (await listDocPages(docsDir)).filter(page => page !== 'SUMMARY.md');
  const metas = new Map(
    await Promise.all(
      pages.map(async page => [page, splitFrontMatter(await readPage(docsDir, page)).meta])
    )
  );
  const toc = await readSummary(docsDir);
  const listed = new Set();
  const prune = nodes =>
    nodes.map(node => {
      const exists = node.path && metas.has(node.path);
      if (exists) listed.add(node.path);
      const description = exists ? metas.get(node.path).description : undefined;
      return {
        title: node.title,
        path: exists ? node.path : null,
        ...(node.part ? { part: true } : {}),
        ...(description ? { description } : {}),
        children: prune(node.children)
      };
    });
  const pruned = prune(toc);
  const unlisted = pages.filter(page => !listed.has(page) && !metas.get(page).hidden);
  return { toc: pruned, unlisted };
}

/**
 * One page: its canonical title, the metadata from its front-matter and the Markdown body without
 * the front-matter. `null` when `requested` is not one of the pages the listing found.
 *
 * @param {string} docsDir
 * @param {string} requested POSIX path relative to docsDir
 * @returns {Promise<null | { path: string, title: string, description?: string, audience?: string, type?: string, adminPage?: string, since?: string, markdown: string }>}
 */
export async function loadDocPage(docsDir, requested) {
  if (typeof requested !== 'string' || !requested) return null;
  const known = (await listDocPages(docsDir)).find(page => page === requested);
  if (!known) return null;
  const raw = await fs.readFile(join(docsDir, ...known.split('/')), 'utf8');
  const summaryTitle = summaryTitles(await readSummary(docsDir)).get(known);
  const { meta, body } = splitFrontMatter(raw);
  const fields = Object.fromEntries(
    PAGE_FIELDS.filter(key => meta[key]).map(key => [key, meta[key]])
  );
  return { path: known, title: pageTitle(raw, known, summaryTitle), ...fields, markdown: body };
}

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
      else if (fenceMatch[1].startsWith(fence)) fence = null;
    }
    const heading = !fence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      sections.push(current);
      current = {
        heading: plainHeading(heading[2]),
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

/** A table's delimiter row: `| --- | :--: |`. */
const TABLE_RULE_RE = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/**
 * Section text as one line of plain prose for search snippets: no code blocks, images, link
 * targets, HTML tags, alert markers, list bullets, table pipes or rules.
 */
export function plainText(markdown) {
  const lines = [];
  let fence = null;
  for (const line of String(markdown ?? '').split(/\r?\n/)) {
    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1][0];
      else if (fenceMatch[1].startsWith(fence)) fence = null;
      continue;
    }
    if (fence || TABLE_RULE_RE.test(line) || /^\s*([-*_=])(?:\s*\1){2,}\s*$/.test(line)) continue;
    lines.push(
      line
        .replace(/^\s*(?:>\s*)+/, '')
        .replace(/^\[!\w+\]\s*$/, '')
        .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
        .replace(/^\s*#{1,6}\s+/, '')
    );
  }
  return lines
    .join('\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\|/g, ' ')
    .replace(/[`*]/g, '')
    .replace(/-{3,}|={3,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Build the search index of all pages: one record per section, with the page's canonical title
 * (front-matter `title`, first H1, SUMMARY label, file name). Front-matter is not indexed. A section
 * without prose of its own (only subheadings or code) takes its snippet text from the next section
 * that has some. `lead` marks the first section of a page.
 *
 * @param {string} docsDir
 */
export async function buildDocsIndex(docsDir) {
  const titles = summaryTitles(await readSummary(docsDir));
  const records = [];
  for (const path of await listDocPages(docsDir)) {
    if (path === 'SUMMARY.md') continue;
    const raw = await readPage(docsDir, path);
    const { meta, body } = splitFrontMatter(raw);
    const title = pageTitle(raw, path, titles.get(path));
    const sections = splitSections(body).map(section => ({
      ...section,
      plain: plainText(section.text)
    }));
    sections.forEach((section, i) => {
      const fallback =
        section.plain || sections.slice(i + 1).find(next => next.plain)?.plain || meta.description;
      records.push({
        path,
        title,
        ...(meta.description ? { description: meta.description } : {}),
        heading: section.heading,
        anchor: section.anchor,
        text: section.text,
        plain: fallback || '',
        lead: i === 0,
        lower: {
          title: title.toLowerCase(),
          heading: section.heading.toLowerCase(),
          text: section.text.toLowerCase()
        }
      });
    });
  }
  return records;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Matches `term` at the start of a word: `ui` finds "UI" and "ui-config", not "build". */
function wordPrefix(term) {
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(term)}`, 'gu');
}

function countMatches(pattern, text, max) {
  pattern.lastIndex = 0;
  let count = 0;
  while (count < max && pattern.exec(text)) count++;
  pattern.lastIndex = 0;
  return count;
}

/** A plain-text excerpt of `plain` around the first word-prefix hit of any term. */
function snippet(plain, patterns, radius = 90) {
  const lower = plain.toLowerCase();
  let at = -1;
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    const match = pattern.exec(lower);
    pattern.lastIndex = 0;
    if (match && (at === -1 || match.index < at)) at = match.index;
  }
  if (at === -1) return plain.slice(0, radius * 2) + (plain.length > radius * 2 ? '…' : '');
  const start = Math.max(0, at - radius);
  const end = Math.min(plain.length, at + radius);
  return `${start > 0 ? '…' : ''}${plain.slice(start, end)}${end < plain.length ? '…' : ''}`;
}

/**
 * Rank sections for a query. Terms match at the start of a word. Every term must occur somewhere
 * in the section (page title, heading or text). A title hit weighs most on the page's first
 * section, so a page whose title matches ranks its introduction above its subsections; heading
 * hits weigh more than body hits.
 *
 * @param {Awaited<ReturnType<typeof buildDocsIndex>>} index
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
  const patterns = terms.map(wordPrefix);
  const phrase = terms.join(' ');

  const scored = [];
  for (const record of index) {
    let score = 0;
    let all = true;
    for (const pattern of patterns) {
      const inTitle = countMatches(pattern, record.lower.title, 1) > 0;
      const inHeading = countMatches(pattern, record.lower.heading, 1) > 0;
      const count = countMatches(pattern, record.lower.text, 10);
      if (!inTitle && !inHeading && count === 0) {
        all = false;
        break;
      }
      score += (inTitle ? (record.lead ? 20 : 2) : 0) + (inHeading ? 10 : 0) + count;
    }
    if (!all) continue;
    if (record.lead && record.lower.title === phrase) score += 30;
    else if (record.lower.heading === phrase) score += 15;
    scored.push({ record, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(({ record }) => ({
    path: record.path,
    title: record.title,
    ...(record.description ? { description: record.description } : {}),
    heading: record.heading,
    anchor: record.anchor,
    snippet: snippet(record.plain, patterns)
  }));
}
