/**
 * @jest-environment node
 */

/**
 * The admin changelog endpoints read `docs/releases/` and hand the page a structured view of it:
 * which releases have notes (unreleased `next/` first, then newest first, counts per section,
 * which one is installed and which ones the last upgrade brought in) and, per release, the entries
 * of each section. What they must get right: skip directories without entries, ignore anything
 * that is not a release directory, mark the whole range an upgrade spanned rather than only the
 * version being run, and never let a request parameter pick a path outside the releases
 * directory.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
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

jest.mock('../../../server/utils/versionHelper.js', () => ({
  getAppVersion: () => 'v5.5.7'
}));

// What this installation was upgraded from is read off disk at startup; the range it produces is
// the real thing (`isWithinUpgrade` is not mocked), only the record itself is supplied here.
let mockInstalledRecord = { version: null, previousVersion: null };
jest.mock('../../../server/utils/installedVersionStore.js', () => {
  const actual = jest.requireActual('../../../server/utils/installedVersionStore.js');
  return { ...actual, getInstalledVersionRecord: async () => mockInstalledRecord };
});

import registerAdminChangelogRoutes, {
  loadChangelogIndex
} from '../../../server/routes/admin/changelog.js';

let releasesDir;
let app;

function writeRelease(version, files) {
  const dir = path.join(releasesDir, version);
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), content);
  }
}

beforeAll(() => {
  releasesDir = mkdtempSync(path.join(os.tmpdir(), 'ihub-releases-'));

  writeRelease('next', {
    'breaking-changes.md': '# Breaking Changes — Unreleased\n',
    'features.md': '# Features — Unreleased\n\n## Coming Soon\n\nNot tagged yet.\n',
    'fixes.md': '# Fixes — Unreleased\n'
  });
  writeRelease('5.5.7', {
    'breaking-changes.md':
      '# Breaking Changes — 5.5.7\n\n## Reasoning Effort Is a Level\n\n**Before upgrading:** check `reasoning`.\n',
    'features.md':
      '# Features — 5.5.7\n\n## Artifacts Kept\n\nBody one.\n\n## Grant `tools` to a Group\n\nBody two.\n',
    'fixes.md': '# Fixes — 5.5.7\n\n## Image Models Save Again\n\nBody.\n'
  });
  writeRelease('5.4.9', { 'features.md': '# Features — 5.4.9\n\n## Older\n\nbody\n' });
  writeRelease('5.4.10', { 'features.md': '# Features — 5.4.10\n\n## Newer Than 5.4.9\n\nbody\n' });
  writeRelease('5.4.0-RC1', { 'features.md': '# Features — 5.4.0-RC1\n\n## Candidate\n\nbody\n' });
  // Heading-only files: nothing shipped, so this release is not listed.
  writeRelease('5.5.8', { 'features.md': '# Features — 5.5.8\n', 'fixes.md': '# Fixes — 5.5.8\n' });
  // Not release directories: a README file and a stray folder.
  writeFileSync(path.join(releasesDir, 'README.md'), '# Release notes\n');
  writeRelease('notes', { 'features.md': '# Features\n\n## Should Never Show\n\nbody\n' });

  app = express();
  registerAdminChangelogRoutes(app, { releasesDir });
});

afterAll(() => {
  rmSync(releasesDir, { recursive: true, force: true });
});

describe('GET /api/admin/changelog', () => {
  beforeEach(() => {
    mockInstalledRecord = { version: null, previousVersion: null };
  });

  test('lists releases with entries, next first, newest first, with counts and the running version', async () => {
    const response = await request(app).get('/api/admin/changelog');

    expect(response.status).toBe(200);
    expect(response.body.currentVersion).toBe('5.5.7');
    expect(response.body.versions.map(release => release.version)).toEqual([
      'next',
      '5.5.7',
      '5.4.10',
      '5.4.9',
      '5.4.0-RC1'
    ]);

    const [next, latest] = response.body.versions;
    expect(next.unreleased).toBe(true);
    expect(next.counts).toEqual({ total: 1, breakingChanges: 0, features: 1, fixes: 0 });
    expect(latest.unreleased).toBe(false);
    expect(latest.counts).toEqual({ total: 4, breakingChanges: 1, features: 2, fixes: 1 });
  });

  test('marks the installed release, and nothing as new, on an installation that never upgraded', async () => {
    const response = await request(app).get('/api/admin/changelog');

    expect(response.body.previousVersion).toBeNull();
    expect(response.body.versions.filter(release => release.installed).map(r => r.version)).toEqual(
      ['5.5.7']
    );
    expect(response.body.versions.every(release => release.isNew === false)).toBe(true);
  });

  test('marks every release an upgrade spanned as new, not just the one being run', async () => {
    // The route takes the running version from the build, not from this record.
    mockInstalledRecord = { version: '5.4.0-RC1', previousVersion: '5.4.0-RC1' };

    const response = await request(app).get('/api/admin/changelog');

    expect(response.body.previousVersion).toBe('5.4.0-RC1');
    // Running 5.5.7 after 5.4.0-RC1: everything in between is new, the release that was already
    // installed is not, and unreleased changes never are.
    expect(response.body.versions.filter(release => release.isNew).map(r => r.version)).toEqual([
      '5.5.7',
      '5.4.10',
      '5.4.9'
    ]);
  });

  test('answers with an empty list when the releases directory is missing', async () => {
    expect(await loadChangelogIndex(path.join(releasesDir, 'does-not-exist'))).toEqual([]);
  });
});

describe('GET /api/admin/changelog/:version', () => {
  test('returns the entries of one release per section, in section order', async () => {
    const response = await request(app).get('/api/admin/changelog/5.5.7');

    expect(response.status).toBe(200);
    expect(response.body.version).toBe('5.5.7');
    expect(response.body.unreleased).toBe(false);
    expect(Object.keys(response.body.sections)).toEqual(['breakingChanges', 'features', 'fixes']);
    expect(response.body.sections.features).toEqual([
      { id: 'artifacts-kept', title: 'Artifacts Kept', body: 'Body one.' },
      { id: 'grant-tools-to-a-group', title: 'Grant `tools` to a Group', body: 'Body two.' }
    ]);
    expect(response.body.sections.breakingChanges[0].body).toContain('**Before upgrading:**');
  });

  test('serves next as unreleased', async () => {
    const response = await request(app).get('/api/admin/changelog/next');

    expect(response.status).toBe(200);
    expect(response.body.unreleased).toBe(true);
    expect(response.body.sections.features[0].title).toBe('Coming Soon');
  });

  test('answers 404 for releases without entries, unknown versions and non-release names', async () => {
    for (const name of [
      '5.5.8',
      '9.9.9',
      'notes',
      'README.md',
      '..%2F..%2Fetc',
      'next%2F..%2F5.5.7'
    ]) {
      const response = await request(app).get(`/api/admin/changelog/${name}`);
      expect(response.status).toBe(404);
    }
  });
});
