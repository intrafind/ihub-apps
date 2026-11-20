// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `scripts/check-test-only-diff.js`: a pull request whose title says it changes
 * no production code may only touch tests, docs, scripts and workflows. The
 * last tests run the script on a scratch repository.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isTestOnlyTitle, productionPaths, titleType } from '../../scripts/check-test-only-diff.js';
import { gitExecutable } from '../../scripts/git-executable.js';

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../scripts/check-test-only-diff.js'
);

test('the type of a title is read as conventional commits write it', () => {
  assert.equal(titleType('test: characterization goldens'), 'test');
  assert.equal(titleType('test(golden): record the chat surface'), 'test');
  assert.equal(titleType('Docs: the difference list'), 'docs');
  assert.equal(titleType('feat!: remove the Agent Factory routes'), 'feat');
  assert.equal(titleType('refactor(run): one tool runner'), 'refactor');
  assert.equal(titleType('Update the goldens'), null);
  assert.equal(titleType(''), null);
  assert.equal(titleType(undefined), null);
});

test('test, docs and ci titles claim that no production code changes; others do not', () => {
  for (const title of ['test: x', 'test(e2e): x', 'docs: x', 'ci(golden): x']) {
    assert.equal(isTestOnlyTitle(title), true, title);
  }
  for (const title of ['feat: x', 'fix(chat): x', 'refactor: x', 'chore: x', 'tests: x', 'x']) {
    assert.equal(isTestOnlyTitle(title), false, title);
  }
});

test('a path outside tests, docs, scripts and workflows is a production path', () => {
  assert.deepEqual(
    productionPaths([
      'server/tests/golden/surfaces/chat.js',
      'server/tests/golden/__goldens__/chat/plain.json',
      'tests/fixtures/stellungnahmen/05-leer.txt',
      'docs/run-testing.md',
      'scripts/check-test-only-diff.js',
      '.github/workflows/e2e.yml'
    ]),
    []
  );
  assert.deepEqual(
    productionPaths([
      'server/tests/golden/surfaces/chat.js',
      'server/services/chat/ChatService.js',
      'client/src/App.jsx',
      'package.json',
      // Not under `server/tests/`, although the name starts alike.
      'server/testsupport.js',
      'shared/runEvents.js'
    ]),
    [
      'client/src/App.jsx',
      'package.json',
      'server/services/chat/ChatService.js',
      'server/testsupport.js',
      'shared/runEvents.js'
    ]
  );
});

/** A repository with one commit on `main` and a branch with the given files changed. */
function scratchRepository(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ihub-test-only-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync(gitExecutable(), args, { cwd: dir, stdio: 'pipe' });
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  };
  git('init', '--quiet', '--initial-branch=main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  write('server/services/chat/ChatService.js', 'export const a = 1;\n');
  // The script and the one module it imports.
  for (const name of ['check-test-only-diff.js', 'git-executable.js']) {
    write(`scripts/${name}`, fs.readFileSync(path.join(path.dirname(SCRIPT), name), 'utf8'));
  }
  git('add', '.');
  git('commit', '--quiet', '-m', 'base');
  git('checkout', '--quiet', '-b', 'work');
  for (const [file, text] of Object.entries(files)) write(file, text);
  git('add', '.');
  git('commit', '--quiet', '-m', 'work');
  return dir;
}

const run = (dir, title) =>
  spawnSync(process.execPath, ['scripts/check-test-only-diff.js', '--base', 'main'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, PR_TITLE: title }
  });

test('the script passes a test-only pull request that touches only tests and docs', t => {
  const dir = scratchRepository(t, {
    'server/tests/golden/__goldens__/chat/plain.json': '{}\n',
    'docs/run-testing.md': '# Testing Runs\n'
  });
  const result = run(dir, 'test: characterization goldens');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /2 changed file\(s\).*no production path/);
});

test('the script fails a test-only pull request with a production path in the diff, and names it', t => {
  const dir = scratchRepository(t, {
    'server/tests/golden/__goldens__/chat/plain.json': '{}\n',
    'server/services/chat/ChatService.js': 'export const a = 2;\n'
  });
  const result = run(dir, 'test: characterization goldens');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /server\/services\/chat\/ChatService\.js/);
  assert.doesNotMatch(result.stderr, / {2}server\/tests\//);
});

test('the script does not check a pull request that may change production code', t => {
  const dir = scratchRepository(t, {
    'server/services/chat/ChatService.js': 'export const a = 2;\n'
  });
  const result = run(dir, 'refactor(run): one tool runner');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Not checked/);
});

test('the script says so when the base cannot be read', t => {
  const dir = scratchRepository(t, { 'docs/x.md': 'x\n' });
  const result = spawnSync(
    process.execPath,
    ['scripts/check-test-only-diff.js', '--base', 'no-such-branch'],
    { cwd: dir, encoding: 'utf8', env: { ...process.env, PR_TITLE: 'docs: x' } }
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /could not be read/);
});
