// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `scripts/check-test-only-diff.js`: a pull request that records goldens and
 * whose title says it changes no production code may not touch the code a
 * golden pins. The last tests run the script on a scratch repository.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  changedPaths,
  currentTitle,
  fetchTitle,
  goldenPaths,
  isTestOnlyTitle,
  productionPaths,
  titleType
} from '../../scripts/check-test-only-diff.js';
import { gitExecutable } from '../../scripts/git-executable.js';

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../scripts/check-test-only-diff.js'
);

const GOLDEN = 'server/tests/golden/__goldens__/chat/plain.json';

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

test('production code is the server outside its tests, the shared code and the client', () => {
  assert.deepEqual(
    productionPaths([
      'server/tests/golden/surfaces/chat.js',
      GOLDEN,
      'tests/fixtures/stellungnahmen/05-leer.txt',
      'docs/run-testing.md',
      'scripts/check-test-only-diff.js',
      '.github/workflows/e2e.yml',
      // What a `docs:` or `ci:` pull request touches in this repository.
      'concepts/2026-11-21 Run service.md',
      'CLAUDE.md',
      'README.md',
      '.claude/skills/api-design/SKILL.md',
      'package.json',
      'docker/Dockerfile'
    ]),
    []
  );
  assert.deepEqual(
    productionPaths([
      'server/tests/golden/surfaces/chat.js',
      'server/services/chat/ChatService.js',
      'server/utils/killPoint.js',
      'server/defaults/workflows/approval-workflow.json',
      'server/package.json',
      'client/src/App.jsx',
      // Not under `server/tests/`, although the name starts alike.
      'server/testsupport.js',
      'shared/runEvents.js'
    ]),
    [
      'client/src/App.jsx',
      'server/defaults/workflows/approval-workflow.json',
      'server/package.json',
      'server/services/chat/ChatService.js',
      'server/testsupport.js',
      'server/utils/killPoint.js',
      'shared/runEvents.js'
    ]
  );
});

test('a golden is a file under __goldens__, not a file beside it', () => {
  assert.deepEqual(
    goldenPaths([
      'server/tests/golden/differences.json',
      'server/tests/golden/surfaces/chat.js',
      GOLDEN,
      'server/tests/golden/__goldens__/a2a/message-send.json',
      'docs/run-testing.md'
    ]),
    ['server/tests/golden/__goldens__/a2a/message-send.json', GOLDEN]
  );
});

test('with the number of a pull request the title is the one it has now, never the one of the event', () => {
  const asked = [];
  const fetch = params => {
    asked.push({ repo: params.repo, pr: params.pr });
    return 'test: renamed since';
  };
  assert.deepEqual(
    currentTitle({ PR_NUMBER: '7', GITHUB_REPOSITORY: 'o/r', PR_TITLE: 'feat: as opened' }, fetch),
    { title: 'test: renamed since', source: 'github' }
  );
  assert.deepEqual(asked, [{ repo: 'o/r', pr: '7' }]);
  // GitHub cannot be asked: no falling back to the title of the event.
  assert.throws(
    () =>
      currentTitle({ PR_NUMBER: '7', GITHUB_REPOSITORY: 'o/r', PR_TITLE: 'feat: x' }, () => {
        throw new Error('HTTP 502');
      }),
    /HTTP 502/
  );
  // By hand, without a pull request.
  assert.deepEqual(
    currentTitle({ PR_TITLE: 'docs: x' }, () => assert.fail('not asked')),
    { title: 'docs: x', source: 'PR_TITLE' }
  );
  assert.deepEqual(currentTitle({}), { title: '', source: 'PR_TITLE' });
});

test('the title is not asked for with something that is no repository or no number', () => {
  assert.throws(() => fetchTitle({ repo: 'o/r; rm -rf', pr: '7', env: {} }), /Not a repository/);
  assert.throws(() => fetchTitle({ repo: 'o/r', pr: '7/../x', env: {} }), /Not a repository/);
  assert.throws(() => fetchTitle({ repo: undefined, pr: '7', env: {} }), /Not a repository/);
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

/** The environment of a run by hand: nothing of a pull request this test may itself run in. */
function plainEnv(extra) {
  const env = { ...process.env, ...extra };
  for (const key of ['PR_NUMBER', 'GITHUB_REPOSITORY', 'TEST_ONLY_BASE_REF', 'GH_EXECUTABLE']) {
    if (!(key in extra)) delete env[key];
  }
  return env;
}

const run = (dir, title, extra = {}) =>
  spawnSync(process.execPath, ['scripts/check-test-only-diff.js', '--base', 'main'], {
    cwd: dir,
    encoding: 'utf8',
    env: plainEnv({ PR_TITLE: title, ...extra })
  });

test('the script passes a recording pull request that touches only tests and docs', t => {
  const dir = scratchRepository(t, {
    [GOLDEN]: '{}\n',
    'docs/run-testing.md': '# Testing Runs\n',
    'concepts/2026-11-21 Goldens.md': '# Goldens\n',
    'CLAUDE.md': '# CLAUDE.md\n',
    'package.json': '{}\n'
  });
  const result = run(dir, 'test: characterization goldens');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /5 changed file\(s\), 1 of them goldens, none in production code/);
});

test('the script fails a recording pull request with a production path in the diff, and names it', t => {
  const dir = scratchRepository(t, {
    [GOLDEN]: '{}\n',
    'server/services/chat/ChatService.js': 'export const a = 2;\n'
  });
  const result = run(dir, 'test: characterization goldens');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /server\/services\/chat\/ChatService\.js/);
  assert.doesNotMatch(result.stderr, / {2}server\/tests\//);
});

test('the script does not check a pull request that may change production code', t => {
  const dir = scratchRepository(t, {
    [GOLDEN]: '{}\n',
    'server/services/chat/ChatService.js': 'export const a = 2;\n'
  });
  const result = run(dir, 'refactor(run): one tool runner');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Not checked/);
});

test('the script does not check a test pull request that records no golden: a test hook in the server passes', t => {
  // The fault harness: a `test:` pull request with one inert module in the server and no golden.
  const dir = scratchRepository(t, {
    'server/utils/killPoint.js': 'export const killPoint = () => {};\n',
    'server/tests/faults/harness.mjs': 'export {};\n',
    'tests/load/scenarios/agentTurn.mjs': 'export {};\n'
  });
  const result = run(
    dir,
    'test: fault harness with kill points, counter tool and a nightly workflow'
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /3 changed file\(s\), none under .*__goldens__.*Not checked/);
});

test('the script does not check a docs pull request that records no golden', t => {
  const dir = scratchRepository(t, {
    'concepts/2026-11-21 Run service.md': '# Run service\n',
    'CLAUDE.md': '# CLAUDE.md\n'
  });
  const result = run(dir, 'docs: concept for the run service');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /records no golden/);
});

test('a file name with an umlaut is read as it is: a fixture under tests/ passes, a file in the server is named', t => {
  const fixtures = {
    [GOLDEN]: '{}\n',
    'tests/fixtures/stellungnahmen/Bündnis für Ärzte.pdf': 'x\n',
    'tests/fixtures/stellungnahmen/"quoted".txt': 'x\n'
  };
  const passing = scratchRepository(t, fixtures);
  assert.deepEqual(
    changedPaths('main', passing).filter(file => file.startsWith('tests/')),
    [
      'tests/fixtures/stellungnahmen/"quoted".txt',
      'tests/fixtures/stellungnahmen/Bündnis für Ärzte.pdf'
    ]
  );
  const passed = run(passing, 'test: more statements');
  assert.equal(passed.status, 0, passed.stderr);

  const failing = scratchRepository(t, {
    ...fixtures,
    'server/services/Bündnis.js': 'export {};\n'
  });
  const failed = run(failing, 'test: more statements');
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /^ {2}server\/services\/Bündnis\.js$/m);
  assert.doesNotMatch(failed.stderr, /stellungnahmen/);
});

/** A stand-in for `gh` that answers with a title and writes down what it was asked. */
function fakeGh(dir, { title, status = 0 }) {
  const file = path.join(dir, 'fake-gh.sh');
  const log = path.join(dir, 'fake-gh.log');
  fs.writeFileSync(
    file,
    `#!/bin/sh\nprintf '%s\\n' "$*" > '${log}'\n` +
      (status === 0
        ? `printf '%s\\n' '${title}'\n`
        : `printf 'HTTP 502: Bad Gateway\\n' >&2\nexit ${status}\n`)
  );
  fs.chmodSync(file, 0o700);
  return { file, asked: () => fs.readFileSync(log, 'utf8').trim() };
}

test('in a pull request the script judges the title of now: renamed to test, it is checked', t => {
  const dir = scratchRepository(t, {
    [GOLDEN]: '{}\n',
    'server/services/chat/ChatService.js': 'export const a = 2;\n'
  });
  const gh = fakeGh(fs.mkdtempSync(path.join(os.tmpdir(), 'ihub-fake-gh-')), {
    title: 'test: goldens'
  });
  t.after(() => fs.rmSync(path.dirname(gh.file), { recursive: true, force: true }));
  // The event still carries the title the pull request was opened with.
  const result = run(dir, 'feat: as opened', {
    PR_NUMBER: '7',
    GITHUB_REPOSITORY: 'intrafind/ihub-apps',
    GH_EXECUTABLE: gh.file
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /The title "test: goldens"/);
  assert.equal(gh.asked(), 'api repos/intrafind/ihub-apps/pulls/7 --jq .title');
});

test('in a pull request the script judges the title of now: renamed from test, it is not checked', t => {
  const dir = scratchRepository(t, {
    [GOLDEN]: '{}\n',
    'server/services/chat/ChatService.js': 'export const a = 2;\n'
  });
  const gh = fakeGh(fs.mkdtempSync(path.join(os.tmpdir(), 'ihub-fake-gh-')), {
    title: 'refactor(run): one tool runner'
  });
  t.after(() => fs.rmSync(path.dirname(gh.file), { recursive: true, force: true }));
  const result = run(dir, 'test: as opened', {
    PR_NUMBER: '7',
    GITHUB_REPOSITORY: 'intrafind/ihub-apps',
    GH_EXECUTABLE: gh.file
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"refactor\(run\): one tool runner".*Not checked/);
});

test('the script cannot run when the title cannot be read, and does not fall back to the event', t => {
  const dir = scratchRepository(t, {
    [GOLDEN]: '{}\n',
    'server/services/chat/ChatService.js': 'export const a = 2;\n'
  });
  const gh = fakeGh(fs.mkdtempSync(path.join(os.tmpdir(), 'ihub-fake-gh-')), { status: 1 });
  t.after(() => fs.rmSync(path.dirname(gh.file), { recursive: true, force: true }));
  const result = run(dir, 'feat: as opened', {
    PR_NUMBER: '7',
    GITHUB_REPOSITORY: 'intrafind/ihub-apps',
    GH_EXECUTABLE: gh.file
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /The title of #7 could not be read with gh: HTTP 502/);
});

test('the script says so when the base cannot be read', t => {
  const dir = scratchRepository(t, { 'docs/x.md': 'x\n' });
  const result = spawnSync(
    process.execPath,
    ['scripts/check-test-only-diff.js', '--base', 'no-such-branch'],
    { cwd: dir, encoding: 'utf8', env: plainEnv({ PR_TITLE: 'docs: x' }) }
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /could not be read/);
});
