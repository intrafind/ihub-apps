#!/usr/bin/env node

/**
 * Specs for scripts/check-migration-versions.js — the CI guard that fails a
 * PR whose new migration collides with one already on the base branch.
 *
 * Run: node --test server/tests/migration-version-check.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findMigrationConflicts } from '../../scripts/check-migration-versions.js';

const SCRIPT = fileURLToPath(new URL('../../scripts/check-migration-versions.js', import.meta.url));

const source = version => `export const version = '${version}';\nexport async function up() {}\n`;

test('a new migration above the base maximum passes', () => {
  const { problems, nextVersion } = findMigrationConflicts({
    baseFiles: ['V001__baseline.js', 'V002__two.js', 'runner.js', 'README.md'],
    addedFiles: ['V003__three.js'],
    readSource: () => source('003')
  });
  assert.deepEqual(problems, []);
  assert.equal(nextVersion, '003');
});

test('a version already taken on the base branch is a duplicate', () => {
  const { problems, nextVersion } = findMigrationConflicts({
    baseFiles: ['V001__baseline.js', 'V002__bot_one.js'],
    addedFiles: ['V002__bot_two.js'],
    readSource: () => source('002')
  });
  assert.equal(problems.length, 1);
  assert.equal(problems[0].kind, 'duplicate');
  assert.match(problems[0].message, /V002__bot_one\.js/);
  assert.equal(nextVersion, '003');
});

test('a version below the base maximum is out of order', () => {
  const { problems } = findMigrationConflicts({
    baseFiles: ['V001__baseline.js', 'V004__four.js'],
    addedFiles: ['V003__three.js'],
    readSource: () => source('003')
  });
  assert.deepEqual(
    problems.map(p => p.kind),
    ['out-of-order']
  );
});

test('two added files with the same version are flagged', () => {
  const { problems } = findMigrationConflicts({
    baseFiles: ['V001__baseline.js'],
    addedFiles: ['V002__a.js', 'V002__b.js'],
    readSource: () => source('002')
  });
  assert.deepEqual(
    problems.map(p => p.kind),
    ['self-duplicate', 'self-duplicate']
  );
});

test('an exported version that differs from the file name is flagged', () => {
  const { problems } = findMigrationConflicts({
    baseFiles: ['V001__baseline.js'],
    addedFiles: ['V002__renamed.js'],
    readSource: () => source('003')
  });
  assert.equal(problems.length, 1);
  assert.equal(problems[0].kind, 'mismatch');
});

test('files already on the base branch are not treated as added', () => {
  const { problems } = findMigrationConflicts({
    baseFiles: ['V001__baseline.js', 'V002__two.js'],
    addedFiles: ['V002__two.js'],
    readSource: () => source('002')
  });
  assert.deepEqual(problems, []);
});

test('CLI: the second branch fails once the first has merged', t => {
  const dir = mkdtempSync(join(tmpdir(), 'migration-check-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  const addMigration = (file, version) => {
    writeFileSync(join(dir, 'server/migrations', file), source(version));
    git('add', '.');
    git('commit', '-qm', file);
  };

  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(dir, 'server/migrations'), { recursive: true });
  addMigration('V001__baseline.js', '001');

  git('checkout', '-qb', 'bot-one');
  addMigration('V002__bot_one.js', '002');
  git('checkout', '-q', 'main');
  git('checkout', '-qb', 'bot-two');
  addMigration('V002__bot_two.js', '002');

  const run = () =>
    spawnSync('node', [SCRIPT, '--base', 'main', '--head', 'bot-two'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_STEP_SUMMARY: '' }
    });

  // Before bot one merges, bot two is fine.
  assert.equal(run().status, 0);

  git('checkout', '-q', 'main');
  git('merge', '-q', '--no-ff', '-m', 'merge bot-one', 'bot-one');

  const result = run();
  assert.equal(result.status, 1);
  assert.match(result.stdout, /`V002__bot_two\.js` \(duplicate\)/);
  assert.match(result.stdout, /next free version on the base branch is \*\*V003\*\*/);
});
