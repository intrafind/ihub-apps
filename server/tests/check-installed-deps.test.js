// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Specs for scripts/check-installed-deps.js — the `predev` check that stops `npm run dev` when a
 * dependency declared in package.json is not installed.
 *
 * Run: node --test server/tests/check-installed-deps.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkPackages,
  findDependencyProblems,
  satisfiesSimpleRange,
  shouldSkip
} from '../../scripts/check-installed-deps.js';

const SCRIPT = fileURLToPath(new URL('../../scripts/check-installed-deps.js', import.meta.url));

function writeJson(file, data) {
  writeFileSync(file, JSON.stringify(data));
}

function install(dir, name, version) {
  const pkgDir = join(dir, 'node_modules', name);
  mkdirSync(pkgDir, { recursive: true });
  writeJson(join(pkgDir, 'package.json'), { name, version });
}

/** A package whose package.json declares three dependencies, one of them not installed. */
function makeFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'deps-check-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const client = join(root, 'client');
  mkdirSync(client);
  writeJson(join(client, 'package.json'), {
    name: 'client',
    dependencies: { react: '^19.0.0', 'highlight.js': '^11.12.0' },
    devDependencies: { '@scope/tool': '~1.2.0' }
  });
  install(client, 'react', '19.2.1');
  install(client, '@scope/tool', '1.2.9');
  return { root, client };
}

test('reports a declared package that is missing from node_modules', t => {
  const { client } = makeFixture(t);
  assert.deepEqual(findDependencyProblems(client), [
    { name: 'highlight.js', declared: '^11.12.0', installed: null }
  ]);
});

test('passes once every declared package is installed', t => {
  const { client } = makeFixture(t);
  install(client, 'highlight.js', '11.12.0');
  assert.deepEqual(findDependencyProblems(client), []);
});

test('finds a package installed in a parent node_modules, as Node does', t => {
  const { root, client } = makeFixture(t);
  install(root, 'highlight.js', '11.13.1');
  assert.deepEqual(findDependencyProblems(client), []);
});

test('reports an installed version outside the declared range', t => {
  const { client } = makeFixture(t);
  install(client, 'highlight.js', '10.7.3');
  assert.deepEqual(findDependencyProblems(client), [
    { name: 'highlight.js', declared: '^11.12.0', installed: '10.7.3' }
  ]);
});

test('satisfiesSimpleRange follows npm semantics for exact, ^ and ~', () => {
  assert.equal(satisfiesSimpleRange('1.4.0', '^1.2.3'), true);
  assert.equal(satisfiesSimpleRange('2.0.0', '^1.2.3'), false);
  assert.equal(satisfiesSimpleRange('1.2.2', '^1.2.3'), false);
  assert.equal(satisfiesSimpleRange('0.20.9', '^0.20.3'), true);
  assert.equal(satisfiesSimpleRange('0.21.0', '^0.20.3'), false);
  assert.equal(satisfiesSimpleRange('1.2.9', '~1.2.0'), true);
  assert.equal(satisfiesSimpleRange('1.3.0', '~1.2.0'), false);
  assert.equal(satisfiesSimpleRange('1.2.3', '1.2.3'), true);
  assert.equal(satisfiesSimpleRange('1.2.4', '1.2.3'), false);
  // Other forms are only checked for presence
  assert.equal(satisfiesSimpleRange('0.20.3', 'https://cdn.example/x-0.20.3.tgz'), null);
  assert.equal(satisfiesSimpleRange('1.0.0-beta.1', '^1.0.0'), null);
  assert.equal(satisfiesSimpleRange('1.0.0', '>=1 <3'), null);
});

test('the report names the package directory and the fix', t => {
  const { root } = makeFixture(t);
  const report = checkPackages(['client'], root);
  assert.match(report, /client\/package\.json:/);
  assert.match(report, /highlight\.js \(\^11\.12\.0\): not installed/);
  assert.match(report, /npm run install:all/);
});

test('the check is skipped in CI and production', () => {
  assert.equal(shouldSkip({ CI: 'true' }), true);
  assert.equal(shouldSkip({ NODE_ENV: 'production' }), true);
  assert.equal(shouldSkip({ SKIP_DEPS_CHECK: '1' }), true);
  assert.equal(shouldSkip({ NODE_ENV: 'development' }), false);
});

test('the script exits non-zero on a missing package and zero otherwise', t => {
  const { root, client } = makeFixture(t);
  const env = { ...process.env, CI: '', NODE_ENV: 'development', SKIP_DEPS_CHECK: '' };
  const failing = spawnSync(process.execPath, [SCRIPT, client], {
    cwd: root,
    env,
    encoding: 'utf8'
  });
  assert.equal(failing.status, 1);
  assert.match(failing.stderr, /highlight\.js/);
  assert.match(failing.stderr, /npm run install:all/);

  const skipped = spawnSync(process.execPath, [SCRIPT, client], {
    cwd: root,
    env: { ...env, CI: 'true' },
    encoding: 'utf8'
  });
  assert.equal(skipped.status, 0);

  install(client, 'highlight.js', '11.12.0');
  const passing = spawnSync(process.execPath, [SCRIPT, client], {
    cwd: root,
    env,
    encoding: 'utf8'
  });
  assert.equal(passing.status, 0);
  assert.equal(passing.stderr, '');
});
