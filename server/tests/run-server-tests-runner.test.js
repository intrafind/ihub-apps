// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Self-test of `scripts/run-server-tests.js`: the tier rule, the quarantine
 * check and the command line.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
  assert.deepEqual(selectFiles(files, { filters: ['faults'], quarantined }).selected, []);
  assert.deepEqual(
    selectFiles(files, { tier: 'nightly', filters: ['faults'], quarantined }).selected,
    ['server/tests/faults/kill.fault.test.js']
  );
  // The filter "faults" leaves out a nightly file outside server/tests/faults/: that file runs
  // only when the whole tier runs (npm run test:nightly).
  assert.ok(
    !selectFiles(files, { tier: 'nightly', filters: ['faults'], quarantined }).selected.includes(
      'server/tests/slow.nightly.test.js'
    )
  );
});

test('more than one path filter narrows further: a file must contain every one', () => {
  const files = [
    'server/tests/faults/resume-after-kill.fault.test.js',
    'server/tests/faults/takeover.fault.test.js',
    'server/tests/run/resume.test.js'
  ];
  // `npm run test:faults -- resume` is `--tier=nightly faults resume`.
  assert.deepEqual(parseArgs(['--tier=nightly', 'faults', 'resume']).filters, ['faults', 'resume']);
  assert.deepEqual(
    selectFiles(files, { tier: 'nightly', filters: ['faults', 'resume'], quarantined: {} })
      .selected,
    ['server/tests/faults/resume-after-kill.fault.test.js']
  );
  assert.deepEqual(
    selectFiles(files, { tier: 'all', filters: ['resume'], quarantined: {} }).selected,
    ['server/tests/faults/resume-after-kill.fault.test.js', 'server/tests/run/resume.test.js']
  );
});

test('the command line: options, path filters, a known tier', () => {
  assert.deepEqual(parseArgs([]), {
    list: false,
    checkQuarantine: false,
    tier: 'pr',
    filters: []
  });
  assert.deepEqual(parseArgs(['--tier=nightly', 'faults']), {
    list: false,
    checkQuarantine: false,
    tier: 'nightly',
    filters: ['faults']
  });
  assert.equal(parseArgs(['--tier', 'all', '--list']).tier, 'all');
  assert.equal(parseArgs(['--check-quarantine']).checkQuarantine, true);
  assert.throws(() => parseArgs(['--tier=weekly']), /Unknown tier "weekly"/);
  assert.throws(() => parseArgs(['--teir=nightly']), /Unknown option: --teir=nightly/);
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
    checkQuarantine({ files: [], quarantined, passes: () => false, filters: ['broken'] }).missing,
    ['broken.test.js']
  );
});

test('the three tests that guard the code the run service moves are out of the quarantine', () => {
  for (const name of [
    'appToolsGateway.test.js',
    'mcpToolUserContext.test.js',
    'CorpusSearchNodeExecutor.pagination.test.js'
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

/**
 * The quarantine check on fixture files, through the script's own `main`: a
 * directory with a failing file, a passing file and a script that logs a
 * failed check but exits 0, and a quarantine list of the test's choice. The
 * check must not depend on which test of the repository is broken today.
 */
function quarantineFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ihub-runner-quarantine-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (name, source) => fs.writeFileSync(path.join(dir, name), source);
  write('fails.test.js', "console.log('a check failed');\nprocess.exit(1);\n");
  write('passes.test.js', "console.log('fine');\n");
  write('swallows.test.js', "console.log('❌ a check failed');\n");
  write(
    'failing-node-test.test.js',
    "import test from 'node:test';\ntest('fails', () => {\n  throw new Error('no');\n});\n"
  );
  write(
    'run.mjs',
    `import { main } from ${JSON.stringify(pathToFileURL(SCRIPT).href)};\n` +
      'main({\n' +
      '  argv: process.argv.slice(2),\n' +
      '  quarantined: JSON.parse(process.env.FIXTURE_QUARANTINED),\n' +
      `  testsDir: ${JSON.stringify(dir)}\n` +
      '});\n'
  );
  return (names, ...args) => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    env.FIXTURE_QUARANTINED = JSON.stringify(Object.fromEntries(names.map(n => [n, 'a reason'])));
    const result = spawnSync(process.execPath, [path.join(dir, 'run.mjs'), ...args], {
      cwd: root,
      encoding: 'utf8',
      env
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
}

test('--check-quarantine passes while every listed file still fails', t => {
  const run = quarantineFixture(t);
  const { status, stdout, stderr } = run(
    ['fails.test.js', 'failing-node-test.test.js'],
    '--check-quarantine'
  );
  assert.match(stdout, /checking 2 quarantined files/);
  assert.match(stdout, /each file runs with an empty contents directory/);
  assert.match(stdout, /fails {3}\S*fails\.test\.js/);
  assert.match(stdout, /fails {3}\S*failing-node-test\.test\.js/);
  assert.match(stdout, /quarantine: 2 still failing, 0 passing, 0 without a file/);
  assert.equal(stderr, '');
  assert.equal(status, 0);
});

test('--check-quarantine fails when a listed file passes, and names it', t => {
  const run = quarantineFixture(t);
  const { status, stdout, stderr } = run(['fails.test.js', 'passes.test.js'], '--check-quarantine');
  assert.match(stdout, /fails {3}\S*fails\.test\.js/);
  assert.match(stdout, /PASSES {2}\S*passes\.test\.js/);
  assert.match(stdout, /quarantine: 1 still failing, 1 passing, 0 without a file/);
  assert.match(
    stderr,
    /passes\.test\.js is quarantined but passes \(exit code 0\)\. Remove it from QUARANTINED/
  );
  assert.doesNotMatch(stderr, /fails\.test\.js is quarantined but passes/);
  assert.equal(status, 1);
});

test('--check-quarantine fails when a line names a file that does not exist', t => {
  const run = quarantineFixture(t);
  const { status, stdout, stderr } = run(['fails.test.js', 'gone.test.js'], '--check-quarantine');
  assert.match(stdout, /checking 1 quarantined files/);
  assert.match(stdout, /quarantine: 1 still failing, 0 passing, 1 without a file/);
  assert.match(stderr, /gone\.test\.js is quarantined but no such test file exists/);
  assert.equal(status, 1);
  // With a path filter only the entries inside it are checked.
  const filtered = run(['fails.test.js', 'gone.test.js'], '--check-quarantine', 'fails.test.js');
  assert.match(filtered.stdout, /quarantine: 1 still failing, 0 passing, 0 without a file/);
  assert.equal(filtered.status, 0);
});

test('for the quarantine check a file passes when it exits 0, whatever it printed', t => {
  const run = quarantineFixture(t);
  // A script that logs its failed checks and exits 0 is no failing test: the check says that
  // exit code 0 is what it counted, so nobody reads "passes" as "its checks hold".
  const { status, stdout, stderr } = run(['swallows.test.js'], '--check-quarantine');
  assert.match(stdout, /a file passes when its run exits with code 0, whatever it printed/);
  assert.match(stdout, /PASSES {2}\S*swallows\.test\.js/);
  assert.match(stderr, /If its output shows failed checks, the file swallows them/);
  assert.equal(status, 1);
});

test('toolCallingIntegration.test.js exits non-zero whenever it logs a failed check', t => {
  // A plain script that logged ten failed checks and exited 0, so the runner showed it as
  // passing. Whether its checks hold today is the business of the quarantine list; what is
  // pinned here is that a failed check and exit code 0 never go together again.
  const contents = fs.mkdtempSync(path.join(os.tmpdir(), 'ihub-runner-contents-'));
  t.after(() => fs.rmSync(contents, { recursive: true, force: true }));
  const env = { ...process.env, NODE_ENV: 'test', CONTENTS_DIR: contents };
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(
    process.execPath,
    [path.join(root, 'server/tests/toolCallingIntegration.test.js')],
    { cwd: root, encoding: 'utf8', env }
  );
  const output = run.stdout + run.stderr;
  const failedChecks = output.split('\n').filter(line => line.includes('❌'));
  assert.equal(
    run.status === 0,
    failedChecks.length === 0,
    `exit code ${run.status} with ${failedChecks.length} failed checks:\n${failedChecks.join('\n')}`
  );
  assert.match(output, /Adapter registry test passed/, 'the script ran');
});

test('jest workers are replaced when they hold more than the memory limit', () => {
  assert.equal(JEST_WORKER_IDLE_MEMORY_LIMIT, '1GB');
  const source = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(source, /`--workerIdleMemoryLimit=\$\{JEST_WORKER_IDLE_MEMORY_LIMIT\}`/);
});

test('npm run test:nightly runs the whole nightly tier, test:faults its fault tests', () => {
  const scripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts;
  assert.equal(scripts['test:nightly'], 'node scripts/run-server-tests.js --tier=nightly');
  assert.equal(scripts['test:faults'], 'node scripts/run-server-tests.js --tier=nightly faults');
  assert.equal(scripts['test:server'], 'node scripts/run-server-tests.js');
  // What the two scripts select, on files as the docs tell a developer to name them.
  const files = ['server/tests/faults/kill.fault.test.js', 'server/tests/run/long.nightly.test.js'];
  const select = script =>
    selectFiles(files, {
      ...parseArgs(script.split(' ').slice(2)),
      quarantined: {}
    }).selected;
  assert.deepEqual(select(scripts['test:nightly']), files);
  assert.deepEqual(select(scripts['test:faults']), ['server/tests/faults/kill.fault.test.js']);
  assert.deepEqual(select(scripts['test:server']), []);
});
