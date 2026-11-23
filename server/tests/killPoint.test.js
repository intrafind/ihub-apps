// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `server/utils/killPoint.js`: a kill point does nothing in an installation,
 * and kills exactly where a fault test asked for it.
 *
 * The first half tests the function built for an environment. The second half
 * starts real processes, because the two things that matter most cannot be
 * shown inside one: that a process with `NODE_ENV=production` lives whatever
 * else is set, and that the conditions are read when the module is imported
 * and never again.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createKillPoint, killPoint, parseKillPointSpec } from '../utils/killPoint.js';

const MODULE = pathToFileURL(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'utils', 'killPoint.js')
).href;

/** A kill point for an environment, with the kill and the file writes recorded. */
function build(env, { existing = null, claimError = null, staleClaim = false } = {}) {
  const calls = { kills: 0, appended: [], warned: [] };
  // Not in `calls`: most tests compare that with what an inert process does.
  const claims = [];
  const point = createKillPoint({
    env,
    kill: () => {
      calls.kills += 1;
    },
    appendFile: (file, text) => calls.appended.push([file, text]),
    readFile: () => {
      if (existing === null) throw Object.assign(new Error('no file'), { code: 'ENOENT' });
      return existing;
    },
    createFile: file => {
      claims.push(file);
      if (claimError) throw claimError;
    },
    fileExists: () => staleClaim,
    warn: line => calls.warned.push(line)
  });
  return { point, calls, claims };
}

test('the kill point of this test process is not armed', () => {
  assert.equal(killPoint.armed, false);
  assert.equal(killPoint('e2e-counter-after-write'), undefined);
});

test('armed only with NODE_ENV=test and a kill point: every other environment is inert', () => {
  const inert = [
    {},
    { NODE_ENV: 'test' },
    { NODE_ENV: 'test', IHUB_TEST_KILLPOINT: '' },
    { IHUB_TEST_KILLPOINT: 'after-write' },
    { NODE_ENV: 'production', IHUB_TEST_KILLPOINT: 'after-write' },
    { NODE_ENV: 'development', IHUB_TEST_KILLPOINT: 'after-write' },
    { NODE_ENV: 'Test', IHUB_TEST_KILLPOINT: 'after-write' },
    { NODE_ENV: 'production', IHUB_TEST_KILLPOINT: 'after-write', IHUB_TEST_KILLPOINT_FILE: 'f' }
  ];
  for (const env of inert) {
    const { point, calls } = build(env);
    assert.equal(point.armed, false, JSON.stringify(env));
    point('after-write');
    point('after-write');
    assert.deepEqual(calls, { kills: 0, appended: [], warned: [] }, JSON.stringify(env));
  }
});

test('an inert environment does not even read a malformed kill point', () => {
  const { point } = build({ NODE_ENV: 'production', IHUB_TEST_KILLPOINT: 'NOT A NAME@x' });
  assert.equal(point.armed, false);
});

test('armed: the name goes to the file, then the process is killed, at that name only', () => {
  const { point, calls, claims } = build({
    NODE_ENV: 'test',
    IHUB_TEST_KILLPOINT: 'after-write',
    IHUB_TEST_KILLPOINT_FILE: 'reached-file'
  });
  assert.equal(point.armed, true);
  assert.equal(calls.warned.length, 1);
  assert.match(calls.warned[0], /TEST ONLY.*"after-write"/);

  point('before-write');
  assert.equal(calls.kills, 0);
  point('after-write');
  assert.equal(calls.kills, 1);
  assert.deepEqual(calls.appended, [['reached-file', 'after-write\n']]);
  assert.deepEqual(
    claims,
    ['reached-file.after-write.claim'],
    'claimed before the name was written'
  );
});

test('armed without a file: the process is killed and nothing is written', () => {
  const { point, calls, claims } = build({ NODE_ENV: 'test', IHUB_TEST_KILLPOINT: 'after-write' });
  point('after-write');
  assert.equal(calls.kills, 1);
  assert.deepEqual(calls.appended, []);
  assert.deepEqual(claims, []);
});

test('a process that loses the claim to another lives and writes nothing', () => {
  const env = {
    NODE_ENV: 'test',
    IHUB_TEST_KILLPOINT: 'after-write',
    IHUB_TEST_KILLPOINT_FILE: 'reached-file'
  };
  // The other process holds the claim and has not written the name yet.
  const taken = Object.assign(new Error('file exists'), { code: 'EEXIST' });
  const loser = build(env, { claimError: taken });
  loser.point('after-write');
  assert.equal(loser.calls.kills, 0);
  assert.deepEqual(loser.calls.appended, []);

  // Any other failure is not a lost claim: it is shown, not swallowed.
  const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' });
  const broken = build(env, { claimError: denied });
  assert.throws(() => broken.point('after-write'), /permission denied/);
  assert.equal(broken.calls.kills, 0);
});

test('a claim that outlived its file: the process is not armed, and says so', () => {
  const env = {
    NODE_ENV: 'test',
    IHUB_TEST_KILLPOINT: 'after-write',
    IHUB_TEST_KILLPOINT_FILE: 'reached-file'
  };
  const { point, calls, claims } = build(env, { staleClaim: true });
  assert.equal(point.armed, false);
  assert.equal(calls.warned.length, 1);
  assert.match(calls.warned[0], /"after-write" is NOT armed/);
  assert.match(calls.warned[0], /reached-file\.after-write\.claim/);
  point('after-write');
  assert.equal(calls.kills, 0);
  assert.deepEqual(calls.appended, []);
  assert.deepEqual(claims, []);

  // Without a file there is no claim to find.
  const noFile = build(
    { NODE_ENV: 'test', IHUB_TEST_KILLPOINT: 'after-write' },
    { staleClaim: true }
  );
  assert.equal(noFile.point.armed, true);
});

test('"<name>@<n>" kills at the n-th time the place is reached, and only then', () => {
  const { point, calls } = build({ NODE_ENV: 'test', IHUB_TEST_KILLPOINT: 'after-write@3' });
  point('after-write');
  point('other');
  point('after-write');
  assert.equal(calls.kills, 0);
  point('after-write');
  assert.equal(calls.kills, 1);
  // In the test the "kill" returns. A later time does not kill again.
  point('after-write');
  assert.equal(calls.kills, 1);
});

test('a kill point fires once per file: a process that finds the name in it lives', () => {
  const env = {
    NODE_ENV: 'test',
    IHUB_TEST_KILLPOINT: 'after-write',
    IHUB_TEST_KILLPOINT_FILE: 'reached-file'
  };
  // The file holds the name when the process starts: a worker that replaces a dead one.
  const replacement = build(env, { existing: 'after-write\n' });
  assert.equal(replacement.point.armed, false);
  assert.deepEqual(replacement.calls.warned, []);
  replacement.point('after-write');
  assert.equal(replacement.calls.kills, 0);

  // The file gets the name while the process runs: a worker beside the one that died.
  let fileText = null;
  const calls = { kills: 0 };
  const sibling = createKillPoint({
    env,
    kill: () => {
      calls.kills += 1;
    },
    appendFile: () => {},
    readFile: () => {
      if (fileText === null) throw new Error('no file');
      return fileText;
    },
    warn: () => {}
  });
  assert.equal(sibling.armed, true);
  fileText = 'after-write\n';
  sibling('after-write');
  assert.equal(calls.kills, 0);

  // Another name in the file does not disarm.
  const other = build(env, { existing: 'before-write\n' });
  assert.equal(other.point.armed, true);
  other.point('after-write');
  assert.equal(other.calls.kills, 1);
});

test('the spec is "<name>" or "<name>@<n>"; anything else stops an armed process at import', () => {
  assert.deepEqual(parseKillPointSpec('after-tool-start'), { name: 'after-tool-start', hit: 1 });
  assert.deepEqual(parseKillPointSpec('after-tool-start@2'), { name: 'after-tool-start', hit: 2 });
  const malformed = [
    ...['After-Write', 'after_write', 'a b', '@2'],
    ...['a@0', 'a@-1', 'a@1.5', 'a@', 'a@2@3', 'a@01', 'a@1e3', 'a@two']
  ];
  for (const bad of malformed) {
    assert.throws(() => parseKillPointSpec(bad), /IHUB_TEST_KILLPOINT must be/, bad);
    assert.throws(
      () => createKillPoint({ env: { NODE_ENV: 'test', IHUB_TEST_KILLPOINT: bad }, warn() {} }),
      /IHUB_TEST_KILLPOINT must be/,
      bad
    );
  }
});

// --- real processes -------------------------------------------------------------

/** Run a script that imports the module, with an environment of its own. */
function run(script, env) {
  return spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    env: cleanEnv(env),
    encoding: 'utf8'
  });
}

/** The environment of this process without a kill point of its own, and `env` on top. */
function cleanEnv(env) {
  const clean = { ...process.env };
  for (const key of Object.keys(clean)) {
    if (key.startsWith('IHUB_TEST_KILLPOINT') || key === 'NODE_TEST_CONTEXT') delete clean[key];
  }
  return { ...clean, ...env };
}

const REACH = `
  const { killPoint } = await import(${JSON.stringify(MODULE)});
  killPoint('after-write');
  console.log('alive');
`;

test('a process with NODE_ENV=production lives, even with the variable and a file set', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ihub-killpoint-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'reached');
  for (const nodeEnv of ['production', 'development', '']) {
    const result = run(REACH, {
      NODE_ENV: nodeEnv,
      IHUB_TEST_KILLPOINT: 'after-write',
      IHUB_TEST_KILLPOINT_FILE: file
    });
    assert.equal(result.status, 0, `NODE_ENV=${nodeEnv}: ${result.stderr}`);
    assert.equal(result.signal, null);
    assert.equal(result.stdout.trim(), 'alive');
    assert.equal(result.stderr, '', 'and prints no warning');
    assert.equal(fs.existsSync(file), false, 'and writes no file');
  }
});

test('a process with NODE_ENV=test and the variable is killed with SIGKILL after it wrote the name', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ihub-killpoint-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'reached');
  const result = run(REACH, {
    NODE_ENV: 'test',
    IHUB_TEST_KILLPOINT: 'after-write',
    IHUB_TEST_KILLPOINT_FILE: file
  });
  assert.equal(result.signal, 'SIGKILL');
  assert.equal(result.stdout, '', 'nothing after the kill point ran');
  assert.match(result.stderr, /\[killPoint\] TEST ONLY/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'after-write\n');

  // The same file again: the kill point fired, the next process lives.
  const next = run(REACH, {
    NODE_ENV: 'test',
    IHUB_TEST_KILLPOINT: 'after-write',
    IHUB_TEST_KILLPOINT_FILE: file
  });
  assert.equal(next.status, 0, next.stderr);
  assert.equal(next.stdout.trim(), 'alive');

  // The file removed and its claim left: the process is not armed, and it does
  // not announce a kill that will not come.
  fs.rmSync(file);
  const stale = run(REACH, {
    NODE_ENV: 'test',
    IHUB_TEST_KILLPOINT: 'after-write',
    IHUB_TEST_KILLPOINT_FILE: file
  });
  assert.equal(stale.status, 0, stale.stderr);
  assert.equal(stale.stdout.trim(), 'alive');
  assert.match(stale.stderr, /"after-write" is NOT armed/);
  assert.doesNotMatch(stale.stderr, /kills itself/);

  // Both removed: armed again.
  fs.rmSync(`${file}.after-write.claim`);
  const again = run(REACH, {
    NODE_ENV: 'test',
    IHUB_TEST_KILLPOINT: 'after-write',
    IHUB_TEST_KILLPOINT_FILE: file
  });
  assert.equal(again.signal, 'SIGKILL');
});

/**
 * Start a process that reaches the kill point at a given time of the clock.
 * Resolves when it is gone.
 */
function reachAt(time, env) {
  const script = `
    const { killPoint } = await import(${JSON.stringify(MODULE)});
    while (Date.now() < ${time}) {}
    killPoint('after-write');
    console.log('alive');
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
      env: cleanEnv(env),
      stdio: ['ignore', 'pipe', 'ignore']
    });
    let stdout = '';
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.on('error', reject);
    child.on('close', (status, signal) => resolve({ status, signal, stdout }));
  });
}

test('two processes that reach a kill point in the same instant: exactly one dies', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ihub-killpoint-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // Both import the module, then spin until the same millisecond and call. One
  // round can be decided by the scheduler; ten in a row are not.
  for (let round = 0; round < 10; round += 1) {
    const file = path.join(dir, `reached-${round}`);
    const env = {
      NODE_ENV: 'test',
      IHUB_TEST_KILLPOINT: 'after-write',
      IHUB_TEST_KILLPOINT_FILE: file
    };
    const time = Date.now() + 400;
    const ends = await Promise.all([reachAt(time, env), reachAt(time, env)]);
    const killed = ends.filter(end => end.signal === 'SIGKILL');
    const alive = ends.filter(end => end.status === 0 && end.stdout.trim() === 'alive');
    assert.equal(killed.length, 1, `round ${round}: ${JSON.stringify(ends)}`);
    assert.equal(alive.length, 1, `round ${round}: ${JSON.stringify(ends)}`);
    assert.equal(fs.readFileSync(file, 'utf8'), 'after-write\n', 'the name is in the file once');
  }
});

test('the conditions are read at import: setting them in a running process arms nothing', () => {
  const result = run(
    `
    const { killPoint } = await import(${JSON.stringify(MODULE)});
    process.env.NODE_ENV = 'test';
    process.env.IHUB_TEST_KILLPOINT = 'after-write';
    killPoint('after-write');
    console.log('alive', killPoint.armed);
  `,
    { NODE_ENV: 'production' }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'alive false');
});

test('a malformed kill point stops a test process at import, with the reason', () => {
  const result = run(REACH, { NODE_ENV: 'test', IHUB_TEST_KILLPOINT: 'Not A Name' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /IHUB_TEST_KILLPOINT must be "<name>" or "<name>@<n>"/);
});
