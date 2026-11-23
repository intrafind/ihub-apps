/**
 * @jest-environment node
 */
// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Checks of the shipped documentation in docs/, as Admin → Documentation and the mdBook build see
 * it: every SUMMARY entry exists, no page is left out of the navigation, each page has one H1 that
 * matches its SUMMARY label and the metadata the viewer shows, relative links between pages
 * resolve, and a page's `adminPage` names an admin route of the client. The mdBook preprocessor
 * that hides the front-matter is checked here too.
 */
import { describe, expect, test } from '@jest/globals';
import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import {
  firstHeading,
  listDocPages,
  loadDocsToc,
  normalizeDocMeta,
  parseSummary,
  splitFrontMatter
} from '../../../server/utils/docsLibrary.js';
import { parseFrontMatter } from '../../../server/utils/frontMatter.js';
import { splitDocsFrontMatter } from '../../../shared/docsFrontMatter.js';
import { appRoutes, matchRoute, routesInSource } from '../../utils/appRoutes.js';

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

  // mdBook builds only the pages in SUMMARY.md, so a link to a hidden page 404s on the published
  // site even though the file exists and the admin viewer opens it.
  test('pages do not link to hidden pages', async () => {
    const pages = await listDocPages(docsDir);
    const hidden = new Set(pages.filter(page => splitFrontMatter(read(page)).meta.hidden));
    const offending = [];
    for (const page of pages) {
      if (hidden.has(page)) continue;
      for (const line of proseLines(read(page))) {
        const text = line.replace(/`[^`]*`/g, '');
        for (const match of text.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g)) {
          const href = match[1];
          if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#') || href.startsWith('/')) {
            continue;
          }
          const target = decodeURI(href.split('#')[0]);
          const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(page), target));
          if (hidden.has(resolved)) offending.push(`${page} -> ${href}`);
        }
      }
    }
    expect(offending).toEqual([]);
  });
});

/**
 * The `adminPage` a page's front-matter names, as written (`null` when it has none). Parsed as the
 * viewer parses it, but before `normalizeDocMeta` drops a value that is not shaped like an admin
 * path: such a page would otherwise pass for having no button at all.
 */
function rawAdminPage(markdown) {
  const { block } = splitDocsFrontMatter(markdown);
  if (block === null) return null;
  const { data } = parseFrontMatter(`---\n${block}---\n`);
  return data && Object.hasOwn(data, 'adminPage') ? data.adminPage : null;
}

/**
 * Why the viewer's "Open in admin" button of a page would not open an admin page, or `null` when
 * it does. The button is built from `adminPage` alone, so a value the viewer drops leaves no
 * button, and a page that was removed or renamed in `client/src/App.jsx` leaves a button that
 * lands on "not found".
 */
function adminPageProblem(adminPage, routes) {
  if (normalizeDocMeta({ adminPage }).adminPage === undefined) {
    return `"${adminPage}" is not a path under /admin`;
  }
  const target = adminPage.trim();
  const route = matchRoute(target, routes);
  if (!route) return `no route in client/src/App.jsx opens ${target}`;
  if (route.redirectTo) return `${target} only redirects; name ${route.redirectTo} instead`;
  return null;
}

describe("adminPage in a page's front-matter", () => {
  const routes = appRoutes();

  test('names an admin route that exists in client/src/App.jsx', async () => {
    const problems = [];
    let checked = 0;
    for (const page of await listDocPages(docsDir)) {
      const adminPage = rawAdminPage(read(page));
      if (adminPage === null) continue;
      checked += 1;
      const problem = adminPageProblem(adminPage, routes);
      if (problem) problems.push(`${page}: ${problem}`);
    }
    expect(problems).toEqual([]);
    // The check reads something: most admin how-tos carry the field.
    expect(checked).toBeGreaterThan(20);
  });

  test('a missing, redirected or malformed route is reported', () => {
    const sample = routesInSource(`
      const App = () => (
        <Routes>
          <Route path="/" element={<Layout />}>
            <Route path="apps" element={<Apps />} />
            <Route path="admin" element={<AdminLayout />}>
              <Route index element={<Overview />} />
              {show('models') && <Route path="models" element={<Models />} />}
              <Route path="models/:modelId" element={<Model />} />
              <Route path="system" element={<Navigate replace to="/admin/security" />} />
              <Route path="security" element={<Security />} />
            </Route>
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      );
    `);
    for (const adminPage of ['/admin', '/admin/models', '/admin/models/new', '/admin/security']) {
      expect([adminPage, adminPageProblem(adminPage, sample)]).toEqual([adminPage, null]);
    }
    expect(adminPageProblem('/admin/no-such-page', sample)).toBe(
      'no route in client/src/App.jsx opens /admin/no-such-page'
    );
    expect(adminPageProblem('/admin/system', sample)).toBe(
      '/admin/system only redirects; name /admin/security instead'
    );
    expect(adminPageProblem('/apps', sample)).toBe('"/apps" is not a path under /admin');
    expect(adminPageProblem('admin/models', sample)).toBe(
      '"admin/models" is not a path under /admin'
    );
    // The viewer drops a value with a query or a fragment, so the page would have no button.
    for (const adminPage of ['/admin/models/new?tab=details', '/admin/models#top']) {
      expect(adminPageProblem(adminPage, sample)).toBe(`"${adminPage}" is not a path under /admin`);
    }
  });

  test('is read as written, quoted or not, and also when the viewer would drop it', () => {
    expect(rawAdminPage('---\nadminPage: /admin/apps\n---\n\n# A\n')).toBe('/admin/apps');
    expect(rawAdminPage('---\nadminPage: "/admin/apps"\n---\n\n# A\n')).toBe('/admin/apps');
    expect(rawAdminPage('---\nadminPage: admin apps\n---\n\n# A\n')).toBe('admin apps');
    expect(rawAdminPage('---\naudience: admin\n---\n\n# A\n')).toBeNull();
    expect(rawAdminPage('# A\n\nadminPage: /admin/apps\n')).toBeNull();
    // YAML, not the line: a trailing comment is not part of the value, a quoted key is the key.
    expect(rawAdminPage('---\nadminPage: /admin/apps # the app list\n---\n\n# A\n')).toBe(
      '/admin/apps'
    );
    expect(rawAdminPage('---\n"adminPage": /admin/apps\n---\n\n# A\n')).toBe('/admin/apps');
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
