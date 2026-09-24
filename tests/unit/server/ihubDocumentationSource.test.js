/**
 * @jest-environment node
 */

/**
 * The bundled "iHub Documentation" knowledge source is what the iHub Support Bot answers from. It
 * is generated, not committed: `scripts/export-docs-markdown.js` consolidates `docs/` plus the
 * release notes of every release into `server/defaults/sources/ihub-documentation.md`, and the
 * server re-syncs that file into contents/ on startup. Two things keep the bot current with each
 * release, and both are easy to break without noticing:
 *
 * - every build path regenerates the file *before* it copies `server/` into the artifact —
 *   otherwise a release ships no documentation, or the previous build's;
 * - the file carries the breaking changes, features and fixes from `docs/releases/`.
 *
 * Build scripts are read as text: their order is exactly what is at stake.
 */
import { execFileSync } from 'child_process';
import { existsSync, readdirSync, readFileSync } from 'fs';
import path from 'path';
import { describe, expect, test } from '@jest/globals';
import {
  RELEASE_SECTIONS,
  UNRELEASED_VERSION,
  countEntries,
  isReleaseVersionName,
  parseReleaseSections,
  sortVersionsNewestFirst
} from '../../../server/utils/releaseNotes.js';

const repoRoot = path.resolve(__dirname, '../../..');
const scripts = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).scripts;

/** The npm scripts a script runs, in order (`npm run a && npm run b` → `['a', 'b']`). */
const npmRuns = name => [...(scripts[name] ?? '').matchAll(/npm run ([\w:-]+)/g)].map(m => m[1]);

describe('builds regenerate the documentation source before shipping server/', () => {
  test('build:server exports the docs before it copies server/', () => {
    const script = scripts['build:server'];
    const exportAt = script.indexOf('npm run docs:build:markdown');
    const copyAt = script.indexOf('cp -r server/');
    expect(exportAt).toBeGreaterThanOrEqual(0);
    expect(copyAt).toBeGreaterThan(exportAt);
    expect(scripts['docs:build:markdown']).toBe('node scripts/export-docs-markdown.js');
  });

  test('the production and Docker builds go through build:server', () => {
    expect(npmRuns('build:no-docs')).toContain('build:server');
    expect(npmRuns('build')[0]).toBe('build:no-docs');
    expect(npmRuns('prod:build')[0]).toBe('build');
    expect(npmRuns('build:docker')[0]).toBe('build:no-docs');
    expect(readFileSync(path.join(repoRoot, 'docker/Dockerfile'), 'utf8')).toMatch(
      /RUN npm run build:docker/
    );
  });

  test('the binary build exports the docs before packaging server/defaults', () => {
    const sea = readFileSync(path.join(repoRoot, 'build-sea.sh'), 'utf8');
    const exportAt = sea.indexOf('npm run docs:build:all');
    const packAt = sea.indexOf('node build-sea.cjs');
    expect(exportAt).toBeGreaterThanOrEqual(0);
    expect(packAt).toBeGreaterThan(exportAt);
    expect(npmRuns('docs:build:all')).toContain('docs:build:markdown');
  });
});

describe('the generated documentation source', () => {
  const releasesDir = path.join(repoRoot, 'docs', 'releases');
  const releases = readdirSync(releasesDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && isReleaseVersionName(d.name))
    .map(d => {
      const files = {};
      for (const section of RELEASE_SECTIONS) {
        const file = path.join(releasesDir, d.name, section.file);
        files[section.file] = existsSync(file) ? readFileSync(file, 'utf8') : '';
      }
      const sections = parseReleaseSections(files);
      return { version: d.name, sections, total: countEntries(sections).total };
    })
    .filter(release => release.total > 0);

  execFileSync(process.execPath, [path.join(repoRoot, 'scripts/export-docs-markdown.js')], {
    cwd: repoRoot,
    stdio: 'ignore'
  });
  const source = readFileSync(
    path.join(repoRoot, 'server/defaults/sources/ihub-documentation.md'),
    'utf8'
  );
  const chapter = source.slice(source.indexOf('\n# Release Notes\n'));

  test('is the standalone export, and carries the docs and a Release Notes chapter', () => {
    expect(readFileSync(path.join(repoRoot, 'docs/book/iHub-Apps-Documentation.md'), 'utf8')).toBe(
      source
    );
    expect(source).toContain('<!-- Source: README.md -->');
    expect(source).toContain('<!-- Source: releases/ -->');
    expect(source.indexOf('\n# Release Notes\n')).toBeGreaterThan(0);
  });

  test('holds every breaking change, feature and fix of every release', () => {
    const total = releases.reduce((sum, release) => sum + release.total, 0);
    const entryHeadings = chapter.split('\n').filter(line => line.startsWith('#### '));
    expect(entryHeadings).toHaveLength(total);

    const newest = sortVersionsNewestFirst(releases.map(r => r.version)).find(
      version => version !== UNRELEASED_VERSION
    );
    const release = releases.find(r => r.version === newest);
    expect(chapter).toContain(`\n## Version ${newest}\n`);
    for (const section of RELEASE_SECTIONS) {
      for (const entry of release.sections[section.key].entries) {
        expect(chapter).toContain(`\n#### ${entry.title}\n`);
      }
    }
  });
});
