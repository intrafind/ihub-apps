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
import { parseSummary, splitSections } from '../../../server/utils/docsLibrary.js';

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
      '- [Models](models.md)'
    ].join('\n')
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
});

describe('GET /api/admin/docs/page', () => {
  test('returns a listed page with its title', async () => {
    const res = await request(app).get('/api/admin/docs/page').query({ path: 'integrations.md' });
    expect(res.status).toBe(200);
    expect(res.body.title).toBe('Integrations');
    expect(res.body.markdown).toContain('minIhubVersion');
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
