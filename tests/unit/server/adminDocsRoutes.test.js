/**
 * @jest-environment node
 */

/**
 * Admin → Documentation reads the shipped docs/ Markdown: the navigation from SUMMARY.md, one page
 * at a time, a section search, and the images under docs/assets/. What it must get right: a
 * request can only select a page the listing found (no path traversal, no release notes, no
 * files outside docs/), and search returns the section a term is in with mdBook's anchor.
 */
import { afterAll, beforeAll, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

jest.mock('../../../server/utils/logger.js', () => ({
  __esModule: true,
  default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

jest.mock('../../../server/pathUtils.js', () => ({
  getRootDir: () => '/nonexistent-root'
}));

jest.mock('../../../server/middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) => next()
}));

import registerAdminDocsRoutes from '../../../server/routes/admin/docs.js';
import {
  normalizeDocMeta,
  pageTitle,
  parseSummary,
  plainText,
  searchDocsIndex,
  splitFrontMatter,
  splitSections
} from '../../../server/utils/docsLibrary.js';

let rootDir;
let docsDir;
let app;

beforeAll(() => {
  rootDir = mkdtempSync(path.join(os.tmpdir(), 'ihub-docs-'));
  docsDir = path.join(rootDir, 'docs');
  mkdirSync(path.join(docsDir, 'releases', '5.6.4'), { recursive: true });
  mkdirSync(path.join(docsDir, 'assets', 'screenshots'), { recursive: true });
  writeFileSync(path.join(rootDir, 'secret.md'), '# Secret\n');
  writeFileSync(
    path.join(docsDir, 'SUMMARY.md'),
    [
      '- [Home](README.md)',
      '  - [Integrations](integrations.md)',
      '  - [Configuration]()',
      '    - [Missing](missing.md)',
      '# Reference',
      '- [Models](models.md)',
      '- [Guide label](guide.md)'
    ].join('\n')
  );
  writeFileSync(
    path.join(docsDir, 'guide.md'),
    [
      '---',
      'title: Setup Guide',
      'description: "Install it: step by step."',
      'audience: admin',
      'type: how-to',
      'adminPage: /admin/models',
      'since: 5.4.0',
      'unknownKey: dropped',
      '---',
      '',
      '# Guide H1',
      '',
      'Body text about zebras.',
      ''
    ].join('\n')
  );
  writeFileSync(
    path.join(docsDir, 'stub.md'),
    '---\ndescription: Moved.\nhidden: true\n---\n\n# Stub\n\nThis page has moved.\n'
  );
  writeFileSync(path.join(docsDir, 'README.md'), '# iHub Apps\n\nWelcome.\n');
  writeFileSync(
    path.join(docsDir, 'integrations.md'),
    '# Integrations\n\nIntro.\n\n## Version compatibility and release notes\n\nEach integration declares `minIhubVersion`.\n\n```md\n# not a heading\n```\n'
  );
  writeFileSync(path.join(docsDir, 'models.md'), '# Models\n\nConfigure models.\n');
  writeFileSync(path.join(docsDir, 'orphan.md'), '# Orphan\n');
  writeFileSync(path.join(docsDir, 'releases', '5.6.4', 'features.md'), '# Features\n');
  writeFileSync(path.join(docsDir, 'assets', 'screenshots', 'shot.png'), 'png');

  app = express();
  registerAdminDocsRoutes(app, { docsDir });
});

afterAll(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

describe('GET /api/admin/docs/toc', () => {
  test('returns the SUMMARY tree, drops missing files, lists unlisted pages', async () => {
    const res = await request(app).get('/api/admin/docs/toc');
    expect(res.status).toBe(200);
    expect(res.body.toc[0]).toMatchObject({ title: 'Home', path: 'README.md' });
    expect(res.body.toc[0].children.map(child => child.title)).toEqual([
      'Integrations',
      'Configuration'
    ]);
    expect(res.body.toc[0].children[1].children[0]).toMatchObject({ title: 'Missing', path: null });
    expect(res.body.toc[1]).toMatchObject({ title: 'Reference', part: true });
    expect(res.body.toc[2]).toMatchObject({ title: 'Models', path: 'models.md' });
    expect(res.body.unlisted).toEqual(['orphan.md']);
  });

  test('page nodes keep the SUMMARY label and carry the front-matter description', async () => {
    const res = await request(app).get('/api/admin/docs/toc');
    expect(res.body.toc[3]).toEqual({
      title: 'Guide label',
      path: 'guide.md',
      description: 'Install it: step by step.',
      children: []
    });
    expect(res.body.toc[1]).toEqual({ title: 'Reference', path: null, part: true, children: [] });
    expect(res.body.toc[2]).not.toHaveProperty('description');
  });

  test('pages marked hidden in their front-matter are not unlisted', async () => {
    const res = await request(app).get('/api/admin/docs/toc');
    expect(res.body.unlisted).not.toContain('stub.md');
  });
});

describe('GET /api/admin/docs/page', () => {
  test('returns a listed page with its title', async () => {
    const res = await request(app).get('/api/admin/docs/page').query({ path: 'integrations.md' });
    expect(res.status).toBe(200);
    expect(res.body.title).toBe('Integrations');
    expect(res.body.markdown).toContain('minIhubVersion');
  });

  test('returns front-matter fields and strips the front-matter from the Markdown', async () => {
    const res = await request(app).get('/api/admin/docs/page').query({ path: 'guide.md' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      path: 'guide.md',
      title: 'Setup Guide',
      description: 'Install it: step by step.',
      audience: 'admin',
      type: 'how-to',
      adminPage: '/admin/models',
      since: '5.4.0',
      markdown: '# Guide H1\n\nBody text about zebras.\n'
    });
  });

  test('a page without front-matter has only path, title and markdown', async () => {
    const res = await request(app).get('/api/admin/docs/page').query({ path: 'models.md' });
    expect(Object.keys(res.body).sort()).toEqual(['markdown', 'path', 'title']);
  });

  test.each(['../secret.md', 'releases/5.6.4/features.md', '/etc/passwd', 'nope.md', 'book.toml'])(
    '404s for %s',
    async requested => {
      const res = await request(app).get('/api/admin/docs/page').query({ path: requested });
      expect(res.status).toBe(404);
    }
  );

  test('400s without a path', async () => {
    const res = await request(app).get('/api/admin/docs/page');
    expect(res.status).toBe(400);
  });
});

describe('GET /api/admin/docs/search', () => {
  test('finds the section with its mdBook anchor', async () => {
    const res = await request(app).get('/api/admin/docs/search').query({ q: 'minIhubVersion' });
    expect(res.status).toBe(200);
    expect(res.body.items[0]).toMatchObject({
      path: 'integrations.md',
      anchor: 'version-compatibility-and-release-notes'
    });
  });

  test('requires every term', async () => {
    const res = await request(app)
      .get('/api/admin/docs/search')
      .query({ q: 'models nonexistentterm' });
    expect(res.body.items).toEqual([]);
  });

  test('uses the canonical title and does not index the front-matter', async () => {
    const zebras = await request(app).get('/api/admin/docs/search').query({ q: 'zebras' });
    expect(zebras.body.items[0]).toMatchObject({
      path: 'guide.md',
      title: 'Setup Guide',
      description: 'Install it: step by step.'
    });
    const meta = await request(app).get('/api/admin/docs/search').query({ q: 'unknownKey' });
    expect(meta.body.items).toEqual([]);
  });

  test('an empty query returns nothing', async () => {
    const res = await request(app).get('/api/admin/docs/search').query({ q: ' ' });
    expect(res.body.items).toEqual([]);
  });
});

describe('GET /api/admin/docs/assets', () => {
  test('serves images and refuses traversal', async () => {
    const ok = await request(app).get('/api/admin/docs/assets/screenshots/shot.png');
    expect(ok.status).toBe(200);
    const bad = await request(app).get('/api/admin/docs/assets/..%2F..%2Fsecret.md');
    expect(bad.status).not.toBe(200);
  });
});

describe('docsLibrary helpers', () => {
  test('parseSummary nests by indentation', () => {
    const tree = parseSummary(
      '- [A](a.md)\n  - [B](b.md)\n    - [C](c.md)\n  - [D](d.md)\n- [E](e.md)'
    );
    expect(tree.map(node => node.title)).toEqual(['A', 'E']);
    expect(tree[0].children.map(node => node.title)).toEqual(['B', 'D']);
    expect(tree[0].children[0].children[0].title).toBe('C');
  });

  test('splitSections numbers duplicate anchors and skips fenced headings', () => {
    const sections = splitSections('# T\n\n## Setup\n\nx\n\n```\n# fenced\n```\n\n## Setup\n\ny\n');
    expect(sections.map(section => section.anchor)).toEqual(['t', 'setup', 'setup-1']);
  });
});

describe('page titles', () => {
  test('ignore `# ` lines inside code fences', () => {
    const markdown = '## Content\n\n```markdown\n# Frequently Asked Questions\n```\n';
    expect(pageTitle(markdown, 'content-management.md')).toBe('content-management');
    expect(pageTitle('~~~\n# Fenced\n~~~\n\n# Real\n', 'x.md')).toBe('Real');
  });

  test('resolve front-matter title, then H1, then SUMMARY label, then file name', () => {
    expect(pageTitle('---\ntitle: Front\n---\n# Heading\n', 'a.md', 'Label')).toBe('Front');
    expect(pageTitle('# `Heading` [link](x.md)\n', 'a.md', 'Label')).toBe('Heading link');
    expect(pageTitle('No heading here.\n', 'a.md', 'Label')).toBe('Label');
    expect(pageTitle('No heading here.\n', 'sub/a.md')).toBe('a');
  });
});

describe('front-matter', () => {
  test('is split from the body', () => {
    const { meta, body } = splitFrontMatter(
      '---\ndescription: One line.\naudience: developer\ntype: concept\n---\n\n# Page\n'
    );
    expect(meta).toEqual({ description: 'One line.', audience: 'developer', type: 'concept' });
    expect(body).toBe('# Page\n');
  });

  test('a page without front-matter is unchanged', () => {
    const text = '# Page\n\n---\n\nAfter a rule.\n';
    expect(splitFrontMatter(text)).toEqual({ meta: {}, body: text });
  });

  test('invalid YAML yields no metadata but is still removed from the body', () => {
    expect(splitFrontMatter('---\nkey: [unclosed\n---\n# Page\n')).toEqual({
      meta: {},
      body: '# Page\n'
    });
  });

  test('only YAML is accepted', () => {
    expect(splitFrontMatter('---js\n{ title: 1 }\n---\n# Page\n').meta).toEqual({});
  });

  test('values outside the allowed sets are dropped', () => {
    expect(
      normalizeDocMeta({
        title: '  Spaced\n title ',
        audience: 'everyone',
        type: 'novel',
        adminPage: 'https://evil.example/admin',
        since: 5.4,
        hidden: 'yes'
      })
    ).toEqual({ title: 'Spaced title', since: '5.4' });
    expect(normalizeDocMeta({ adminPage: '/admin/oauth/clients', hidden: true })).toEqual({
      adminPage: '/admin/oauth/clients',
      hidden: true
    });
    expect(normalizeDocMeta({ adminPage: '/admin/../etc' })).toEqual({});
    expect(normalizeDocMeta(['a'])).toEqual({});
  });
});

describe('SUMMARY parts and prefix chapters', () => {
  test('a link before the first part is a top-level chapter', () => {
    const tree = parseSummary(
      '[Introduction](README.md)\n\n# Start\n\n- [A](a.md)\n  - [B](b.md)\n'
    );
    expect(tree).toEqual([
      { title: 'Introduction', path: 'README.md', children: [] },
      { title: 'Start', path: null, part: true, children: [] },
      { title: 'A', path: 'a.md', children: [{ title: 'B', path: 'b.md', children: [] }] }
    ]);
  });
});

describe('search ranking and snippets', () => {
  const record = (path, title, heading, text, lead = false) => ({
    path,
    title,
    heading,
    anchor: heading.toLowerCase(),
    text,
    plain: plainText(text),
    lead,
    lower: { title: title.toLowerCase(), heading: heading.toLowerCase(), text: text.toLowerCase() }
  });

  test('terms match at the start of a word only', () => {
    const index = [
      record('build.md', 'Build', 'Build', 'Build and guide the requiring steps.', true),
      record('ui.md', 'UI Configuration', 'UI Configuration', 'The ui.json file.', true)
    ];
    expect(searchDocsIndex(index, 'ui').map(hit => hit.path)).toEqual(['ui.md']);
    expect(searchDocsIndex(index, 'conf').map(hit => hit.path)).toEqual(['ui.md']);
  });

  test('a title match ranks the page introduction above body mentions', () => {
    const index = [
      record('prompts.md', 'Prompt Library', 'FAQ Bot', 'faq faq faq faq faq faq faq faq'),
      record('faq.md', 'FAQ', 'FAQ', 'Answers to common questions.', true)
    ];
    expect(searchDocsIndex(index, 'faq')[0].path).toBe('faq.md');
  });

  test('snippets drop table pipes, delimiter rows and alert markers', () => {
    const text = '> [!NOTE]\n> Read this.\n\n| Key | Value |\n| --- | :---: |\n| port | 3000 |\n';
    expect(plainText(text)).toBe('Read this. Key Value port 3000');
  });
});
