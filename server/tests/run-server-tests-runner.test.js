// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Self-test of `scripts/run-server-tests.js`: the tier rule, the quarantine
 * check and the command line.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  JEST_WORKER_IDLE_MEMORY_LIMIT,
  QUARANTINED,
  TIERS,
  checkQuarantine,
  parseArgs,
  selectFiles,
  tierOf
} from '../../scripts/run-server-tests.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(root, 'scripts/run-server-tests.js');

function runScript(...args) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: root,
    encoding: 'utf8',
    env
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('tier rule: fault tests and *.nightly.test.js are the nightly tier, everything else is pr', () => {
  assert.equal(tierOf('server/tests/faults/kill-after-tool-start.fault.test.js'), 'nightly');
  assert.equal(tierOf('server/tests/faults/helpers/harness.test.js'), 'nightly');
  assert.equal(tierOf('server/tests/run/claims.nightly.test.js'), 'nightly');
  assert.equal(tierOf('server/tests/golden/determinism.test.js'), 'pr');
  assert.equal(tierOf('server/tests/chat-faults.test.js'), 'pr');
  assert.equal(tierOf('server/tests/nightly.test.js'), 'pr');
  assert.equal(tierOf(path.join('server', 'tests', 'faults', 'x.test.js')), 'nightly');
  assert.deepEqual(TIERS, ['pr', 'nightly', 'all']);
});

test('a run executes one tier: nightly files never run in the default tier', () => {
  const files = [
    'server/tests/b.test.js',
    'server/tests/a.test.js',
    'server/tests/faults/kill.fault.test.js',
    'server/tests/slow.nightly.test.js',
    'server/tests/broken.test.js'
  ];
  const quarantined = { 'broken.test.js': 'fails' };
  assert.deepEqual(selectFiles(files, { quarantined }), {
    selected: ['server/tests/a.test.js', 'server/tests/b.test.js'],
    quarantined: ['server/tests/broken.test.js'],
    otherTier: ['server/tests/faults/kill.fault.test.js', 'server/tests/slow.nightly.test.js']
  });
  assert.deepEqual(selectFiles(files, { tier: 'nightly', quarantined }).selected, [
    'server/tests/faults/kill.fault.test.js',
    'server/tests/slow.nightly.test.js'
  ]);
  assert.equal(selectFiles(files, { tier: 'all', quarantined }).selected.length, 4);
  // The path filter narrows a tier, it does not widen it.
  assert.deepEqual(selectFiles(files, { filter: 'faults', quarantined }).selected, []);
  assert.deepEqual(
    selectFiles(files, { tier: 'nightly', filter: 'faults', quarantined }).selected,
    ['server/tests/faults/kill.fault.test.js']
  );
});

test('the command line: options, one filter, a known tier', () => {
  assert.deepEqual(parseArgs([]), {
    list: false,
    checkQuarantine: false,
    tier: 'pr',
    filter: undefined
  });
  assert.deepEqual(parseArgs(['--tier=nightly', 'faults']), {
    list: false,
    checkQuarantine: false,
    tier: 'nightly',
    filter: 'faults'
  });
  assert.equal(parseArgs(['--tier', 'all', '--list']).tier, 'all');
  assert.equal(parseArgs(['--check-quarantine']).checkQuarantine, true);
  assert.throws(() => parseArgs(['--tier=weekly']), /Unknown tier "weekly"/);
  assert.throws(() => parseArgs(['--teir=nightly']), /Unknown option: --teir=nightly/);
  assert.throws(() => parseArgs(['a', 'b']), /Only one path filter/);
});

test('the quarantine check reports a file that passes and an entry without a file', () => {
  const quarantined = {
    'fixed.test.js': 'was broken',
    'broken.test.js': 'fails',
    'gone.test.js': 'deleted'
  };
  const ran = [];
  const result = checkQuarantine({
    files: ['server/tests/broken.test.js', 'server/tests/fixed.test.js'],
    quarantined,
    passes: file => {
      ran.push(file);
      return file.endsWith('fixed.test.js');
    }
  });
  assert.deepEqual(ran, ['server/tests/broken.test.js', 'server/tests/fixed.test.js']);
  assert.deepEqual(result, {
    passing: ['server/tests/fixed.test.js'],
    missing: ['gone.test.js'],
    stillFailing: ['server/tests/broken.test.js']
  });
  // With a path filter, entries outside it are not reported as missing.
  assert.deepEqual(
    checkQuarantine({ files: [], quarantined, passes: () => false, filter: 'broken' }).missing,
    ['broken.test.js']
  );
});

test('the three tests that guard the code the run service moves are out of the quarantine', () => {
  for (const name of [
    'appToolsGateway.test.js',
    'mcpToolUserContext.test.js',
    'CorpusSearchNodeExecutor.pagination.test.js',
    // Found passing by the first run of --check-quarantine: its entry was stale.
    'toolCallingIntegration.test.js'
  ]) {
    assert.equal(QUARANTINED[name], undefined, `${name} is still quarantined`);
    assert.ok(fs.existsSync(path.join(root, 'server/tests', name)), `${name} exists`);
  }
  // Every entry still names a test file: a deleted test leaves no stale line behind.
  const present = new Set(
    fs
      .readdirSync(path.join(root, 'server/tests'), { recursive: true })
      .map(file => path.basename(String(file)))
  );
  assert.deepEqual(
    Object.keys(QUARANTINED).filter(name => !present.has(name)),
    []
  );
});

test('--list shows the tiers; the three tests are counted in the pr tier', () => {
  const { status, stdout } = runScript('--list');
  assert.equal(status, 0);
  assert.match(stdout, /^tier: pr$/m);
  assert.match(stdout, /^tier pr: \d+ files$/m);
  assert.match(stdout, /^tier nightly: \d+ files$/m);
  assert.match(stdout, new RegExp(`^quarantined: ${Object.keys(QUARANTINED).length}$`, 'm'));

  const listed = filter => {
    const out = runScript('--list', filter).stdout;
    return (
      Number(/^node:test\/plain: (\d+)$/m.exec(out)[1]) + Number(/^jest: (\d+)$/m.exec(out)[1])
    );
  };
  assert.equal(listed('appToolsGateway.test.js'), 1);
  assert.equal(listed('mcpToolUserContext.test.js'), 1);
  assert.equal(listed('CorpusSearchNodeExecutor.pagination.test.js'), 1);
  // A quarantined file is in no tier.
  assert.equal(listed('WebhookTrigger.test.js'), 0);
});

test('an unknown tier or option stops the run before any test starts', () => {
  const tier = runScript('--tier=weekly');
  assert.equal(tier.status, 2);
  assert.match(tier.stderr, /Unknown tier "weekly"\. Known tiers: pr, nightly, all/);
  assert.equal(runScript('--chek-quarantine').status, 2);
});

test('a tier without a matching file says so and passes', () => {
  const { status, stdout } = runScript('--tier=nightly', 'no-such-directory');
  assert.equal(status, 0);
  assert.match(stdout, /no test file in tier "nightly" matches "no-such-directory"/);
});

test('--check-quarantine runs the listed files and passes while they still fail', () => {
  // One entry is enough here: the nightly workflow checks the whole list.
  const { status, stdout } = runScript('--check-quarantine', 'teamsAuth.test.js');
  assert.match(stdout, /checking 1 quarantined files/);
  assert.match(stdout, /each file runs with an empty contents directory/);
  assert.match(stdout, /fails {3}server\/tests\/teamsAuth\.test\.js/);
  assert.match(stdout, /quarantine: 1 still failing, 0 passing, 0 without a file/);
  assert.equal(status, 0);
});

test('jest workers are replaced when they hold more than the memory limit', () => {
  assert.equal(JEST_WORKER_IDLE_MEMORY_LIMIT, '1GB');
  const source = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(source, /`--workerIdleMemoryLimit=\$\{JEST_WORKER_IDLE_MEMORY_LIMIT\}`/);
});

test('npm run test:faults runs the nightly tier', () => {
  const scripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts;
  assert.equal(scripts['test:faults'], 'node scripts/run-server-tests.js --tier=nightly faults');
  assert.equal(scripts['test:server'], 'node scripts/run-server-tests.js');
});
