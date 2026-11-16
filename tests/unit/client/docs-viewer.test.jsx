// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Admin → Documentation as a docs site: the SUMMARY parts as sections with a reading order,
 * GitHub alerts as callouts, tables in a scroll frame, `#` links that stay on the page, and
 * Mermaid diagrams at their own height instead of the 150px default.
 */
import { describe, expect, jest, test } from '@jest/globals';

jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  buildApiUrl: p => `/ihub/api/${p}`,
  buildPath: p => `/ihub${p}`
}));
import { rewriteDocsHtml } from '../../../client/src/features/admin/utils/docsLinks';
import {
  docsNodesContain,
  docsRoute,
  flattenDocsPages,
  groupDocsSections,
  locateDocsPage
} from '../../../client/src/features/admin/utils/docsToc';
import { docsHighlightLanguage } from '../../../client/src/features/admin/utils/docsHighlight';
import { diagramHeight } from '../../../client/src/hooks/useMermaidRenderer';

const page = (title, path, children = []) => ({ title, path, children });
const part = title => ({ title, path: null, part: true, children: [] });

const TOC = [
  page('Introduction', 'README.md'),
  part('Get started'),
  page('Install', 'INSTALLATION.md'),
  page('Admin UI', 'admin-ui.md', [page('Screenshots', 'screenshots.md')]),
  part('Developer docs'),
  page('Architecture', 'architecture.md')
];

describe('groupDocsSections', () => {
  test('entries before the first part form an untitled section; each part opens one', () => {
    const sections = groupDocsSections(TOC);
    expect(sections.map(section => [section.title, section.items.map(item => item.path)])).toEqual([
      [null, ['README.md']],
      ['Get started', ['INSTALLATION.md', 'admin-ui.md']],
      ['Developer docs', ['architecture.md']]
    ]);
  });

  test('an empty or missing tree has no sections', () => {
    expect(groupDocsSections(undefined)).toEqual([]);
    expect(groupDocsSections([])).toEqual([]);
  });
});

describe('reading order', () => {
  const pages = flattenDocsPages(groupDocsSections(TOC));

  test('pages follow the contents depth-first, across sections', () => {
    expect(pages.map(entry => entry.path)).toEqual([
      'README.md',
      'INSTALLATION.md',
      'admin-ui.md',
      'screenshots.md',
      'architecture.md'
    ]);
  });

  test('a page knows its section, its parents and its neighbours', () => {
    const { entry, previous, next } = locateDocsPage(pages, 'screenshots.md');
    expect(entry.section.title).toBe('Get started');
    expect(entry.ancestors).toEqual([{ title: 'Admin UI', path: 'admin-ui.md' }]);
    expect(previous.path).toBe('admin-ui.md');
    expect(next.path).toBe('architecture.md');
  });

  test('the first and last page have one neighbour; an unknown page has none', () => {
    expect(locateDocsPage(pages, 'README.md').previous).toBeNull();
    expect(locateDocsPage(pages, 'architecture.md').next).toBeNull();
    expect(locateDocsPage(pages, 'nope.md')).toEqual({ entry: null, previous: null, next: null });
  });

  test('docsNodesContain finds nested pages', () => {
    const [, started] = groupDocsSections(TOC);
    expect(docsNodesContain(started.items, 'screenshots.md')).toBe(true);
    expect(docsNodesContain(started.items, 'architecture.md')).toBe(false);
  });

  test('docsRoute encodes each path segment and keeps the fragment', () => {
    expect(docsRoute('sub/a b.md', 'x')).toBe('/admin/docs/sub/a%20b.md#x');
  });
});

describe('rewriteDocsHtml docs components', () => {
  const render = (html, options = {}) => {
    const out = document.createElement('div');
    out.innerHTML = rewriteDocsHtml(html, 'guide/page.md', {
      headingIds: true,
      docsComponents: true,
      ...options
    });
    return out;
  };

  test('a GitHub alert becomes a callout with a title', () => {
    const out = render('<blockquote><p>[!WARNING]\nBack up first.</p></blockquote>');
    const callout = out.querySelector('.docs-callout');
    expect(callout.className).toBe('docs-callout docs-callout-warning');
    expect(callout.getAttribute('role')).toBe('note');
    expect(callout.querySelector('.docs-callout-title').textContent).toBe('Warning');
    expect(callout.textContent).toContain('Back up first.');
    expect(callout.textContent).not.toContain('[!WARNING]');
    expect(out.querySelector('blockquote')).toBeNull();
  });

  test('a bold "Note:" lead-in becomes a note callout titled with the label', () => {
    const out = render('<blockquote><p><strong>Tip:</strong> Use groups.</p></blockquote>');
    const callout = out.querySelector('.docs-callout-tip');
    expect(callout.querySelector('.docs-callout-title').textContent).toBe('Tip');
    expect(callout.textContent).toContain('Use groups.');
  });

  test('an ordinary quotation stays a blockquote', () => {
    const out = render('<blockquote><p>"Quoted" text.</p></blockquote>');
    expect(out.querySelector('blockquote')).not.toBeNull();
    expect(out.querySelector('.docs-callout')).toBeNull();
  });

  test('tables are wrapped in a scroll frame', () => {
    const out = render('<table><tr><td>a</td></tr></table>');
    expect(out.querySelector('.docs-table > table')).not.toBeNull();
  });

  test('an in-page #link stays on the documentation page', () => {
    const out = render('<p><a href="#setup">Setup</a></p><h2>Setup</h2>');
    const link = out.querySelector('p a');
    expect(link.getAttribute('href')).toBe('/ihub/admin/docs/guide/page.md#setup');
    expect(link.dataset.docsLink).toBe('/admin/docs/guide/page.md#setup');
  });

  test('h2–h4 get a # link to themselves; the leading h1 can be dropped', () => {
    const out = render('<h1>Title</h1><h2>Setup</h2>', {
      dropLeadingH1: true,
      anchorLabel: 'Link'
    });
    expect(out.querySelector('h1')).toBeNull();
    const anchor = out.querySelector('h2 .docs-heading-anchor');
    expect(anchor.dataset.docsLink).toBe('/admin/docs/guide/page.md#setup');
    expect(anchor.getAttribute('aria-label')).toBe('Link: Setup');
  });

  test('without docsComponents the HTML keeps its blockquotes and bare tables', () => {
    const out = render('<blockquote><p>[!NOTE] x</p></blockquote><table></table>', {
      docsComponents: false
    });
    expect(out.querySelector('blockquote')).not.toBeNull();
    expect(out.querySelector('.docs-table')).toBeNull();
  });
});

describe('docsHighlightLanguage', () => {
  test.each([
    ['json', 'json'],
    ['sh', 'bash'],
    ['YML', 'yaml'],
    ['tsx', 'typescript'],
    ['mermaid', null],
    ['', null]
  ])('%s → %s', (name, expected) => {
    expect(docsHighlightLanguage(name)).toBe(expected);
  });
});

describe('diagramHeight', () => {
  const svg = (width, height) => ({
    viewBox: { baseVal: { width, height } },
    getAttribute: () => null
  });

  test('scales the diagram to the host width, keeping its aspect ratio', () => {
    expect(diagramHeight(svg(800, 400), { clientWidth: 400 })).toBe(200);
  });

  test('never enlarges a small diagram past its natural size', () => {
    expect(diagramHeight(svg(300, 200), { clientWidth: 900 })).toBe(200);
  });

  test('caps a tall diagram at 70% of the viewport and keeps a minimum', () => {
    expect(diagramHeight(svg(100, 5000), { clientWidth: 100 })).toBe(
      Math.round(window.innerHeight * 0.7)
    );
    expect(diagramHeight(svg(1000, 10), { clientWidth: 500 })).toBe(120);
  });
});
