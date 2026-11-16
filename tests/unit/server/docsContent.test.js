/**
 * @jest-environment node
 */
// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Checks of the shipped documentation in docs/, as Admin → Documentation and the mdBook build see
 * it: every SUMMARY entry exists, no page is left out of the navigation, each page has one H1 that
 * matches its SUMMARY label and the metadata the viewer shows, and relative links between pages
 * resolve. The mdBook preprocessor that hides the front-matter is checked here too.
 */
import { describe, expect, test } from '@jest/globals';
import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import {
  firstHeading,
  listDocPages,
  loadDocsToc,
  parseSummary,
  splitFrontMatter
} from '../../../server/utils/docsLibrary.js';

const rootDir = path.resolve(__dirname, '../../..');
const docsDir = path.join(rootDir, 'docs');
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

const summary = parseSummary(readFileSync(path.join(docsDir, 'SUMMARY.md'), 'utf8'));
const flatten = (nodes, depth = 1) =>
  nodes.flatMap(node => [{ ...node, depth }, ...flatten(node.children, depth + 1)]);
const entries = flatten(summary).filter(node => !node.part);
const read = page => readFileSync(path.join(docsDir, ...page.split('/')), 'utf8');

/** Lines outside fenced code blocks. */
function proseLines(markdown) {
  const lines = [];
  let fence = null;
  for (const line of markdown.split(/\r?\n/)) {
    const match = FENCE_RE.exec(line);
    if (match) {
      if (!fence) fence = match[1][0];
      else if (match[1].startsWith(fence)) fence = null;
      continue;
    }
    if (!fence) lines.push(line);
  }
  return lines;
}

describe('docs/SUMMARY.md', () => {
  test('every entry points to an existing page', () => {
    const missing = entries.filter(
      node => !node.path || !existsSync(path.join(docsDir, node.path))
    );
    expect(missing.map(node => node.title)).toEqual([]);
  });

  test('no page is unlisted', async () => {
    const { unlisted } = await loadDocsToc(docsDir);
    expect(unlisted).toEqual([]);
  });

  test('starts with the README as a plain chapter and nests at most two levels', () => {
    expect(summary[0]).toEqual({ title: 'Introduction', path: 'README.md', children: [] });
    expect(summary[1].part).toBe(true);
    expect(Math.max(...entries.map(node => node.depth))).toBeLessThanOrEqual(2);
  });

  test('lists no page twice', () => {
    const paths = entries.map(node => node.path);
    expect(paths.filter((page, i) => paths.indexOf(page) !== i)).toEqual([]);
  });
});

describe('docs pages', () => {
  const listed = entries.filter(node => node.path);

  test.each(listed.map(node => [node.path, node.title]))(
    '%s has one H1 on its first line that matches its SUMMARY label',
    (page, label) => {
      const { body } = splitFrontMatter(read(page));
      const h1s = proseLines(body).filter(line => /^#\s/.test(line));
      expect(h1s).toHaveLength(1);
      expect(body.startsWith('# ')).toBe(true);
      // The README is the docs home: SUMMARY calls it "Introduction".
      if (page !== 'README.md') expect(firstHeading(body)).toBe(label);
    }
  );

  test.each(listed.map(node => [node.path]))('%s has a description, audience and type', page => {
    const { meta } = splitFrontMatter(read(page));
    expect(meta.description).toEqual(expect.any(String));
    expect(meta.audience).toEqual(expect.any(String));
    expect(meta.type).toEqual(expect.any(String));
  });

  test('pages outside the SUMMARY are hidden redirect stubs', async () => {
    const listedPaths = new Set(listed.map(node => node.path));
    const others = (await listDocPages(docsDir)).filter(
      page => page !== 'SUMMARY.md' && !listedPaths.has(page)
    );
    for (const page of others) expect(splitFrontMatter(read(page)).meta.hidden).toBe(true);
  });

  test('relative links between pages resolve to existing files', async () => {
    const broken = [];
    for (const page of await listDocPages(docsDir)) {
      for (const line of proseLines(read(page))) {
        const text = line.replace(/`[^`]*`/g, '');
        for (const match of text.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g)) {
          const href = match[1];
          if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#') || href.startsWith('/')) {
            continue;
          }
          const target = decodeURI(href.split('#')[0]);
          if (!target) continue;
          const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(page), target));
          if (resolved.startsWith('..')) continue; // leaves docs/
          if (!existsSync(path.join(docsDir, resolved))) broken.push(`${page} -> ${href}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });
});

describe('mdBook front-matter preprocessor', () => {
  const script = path.join(rootDir, 'scripts', 'mdbook-strip-frontmatter.js');

  test('supports every renderer', () => {
    expect(spawnSync(process.execPath, [script, 'supports', 'html']).status).toBe(0);
  });

  test('removes the front-matter of nested chapters', () => {
    const chapter = (content, subItems = []) => ({ Chapter: { content, sub_items: subItems } });
    const book = {
      items: [
        chapter('---\ndescription: "A: b"\n---\n\n# A\n', [chapter('---\nhidden: true\n---\n# B')]),
        'Separator',
        { PartTitle: 'Part' }
      ]
    };
    const result = spawnSync(process.execPath, [script], {
      input: JSON.stringify([{ root: docsDir }, book])
    });
    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout.toString());
    expect(out.items[0].Chapter.content).toBe('# A\n');
    expect(out.items[0].Chapter.sub_items[0].Chapter.content).toBe('# B');
    expect(out.items.slice(1)).toEqual(['Separator', { PartTitle: 'Part' }]);
  });
});
