// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `sideBySide.mjs` runs two implementations on the same input and writes both
 * reports and both records next to each other. It asserts nothing about them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(here, 'sideBySide.mjs');
const fixture = name => path.join(here, '../fixtures/sideBySide', name);

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ihub-side-by-side-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const input = path.join(dir, 'input');
  fs.mkdirSync(path.join(input, 'scans'), { recursive: true });
  fs.writeFileSync(path.join(input, 'verband-a.txt'), 'Stellungnahme A\n');
  fs.writeFileSync(path.join(input, 'scans', 'verband-b.txt'), 'Stellungnahme B, länger\n');
  return { dir, input, out: path.join(dir, 'out') };
}

function runTool(args) {
  const env = { ...process.env, NODE_ENV: 'test' };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', env });
  return { status: result.status, output: result.stdout + result.stderr };
}

test('both sides run on the same input; reports and records are written side by side', t => {
  const { input, out } = workspace(t);
  const { status, output } = runTool([
    '--left',
    fixture('legacy.mjs'),
    '--right',
    fixture('rebuilt.mjs'),
    '--input',
    input,
    '--out',
    out
  ]);
  // The sides differ, and that is not a failure: the tool asserts nothing.
  assert.equal(status, 0, output);
  assert.deepEqual(fs.readdirSync(out).sort(), [
    'README.md',
    'legacy.record.json',
    'legacy.report.md',
    'rebuilt.record.json',
    'rebuilt.report.md'
  ]);
  assert.equal(
    fs.readFileSync(path.join(out, 'legacy.report.md'), 'utf8'),
    '# Statements\n\n0. scans/verband-b.txt (25 bytes)\n1. verband-a.txt (16 bytes)\n'
  );
  assert.match(
    fs.readFileSync(path.join(out, 'rebuilt.report.md'), 'utf8'),
    /^1\. scans\/verband-b\.txt/m
  );
  const legacy = JSON.parse(fs.readFileSync(path.join(out, 'legacy.record.json'), 'utf8'));
  const rebuilt = JSON.parse(fs.readFileSync(path.join(out, 'rebuilt.record.json'), 'utf8'));
  assert.deepEqual(legacy.steps, ['load', 'summarise']);
  assert.deepEqual(rebuilt.steps, ['load', 'check', 'summarise']);
  assert.deepEqual(Object.keys(legacy), ['modelRequests', 'rows', 'steps'], 'keys are sorted');

  const readme = fs.readFileSync(path.join(out, 'README.md'), 'utf8');
  assert.match(readme, /nothing was\nasserted/);
  assert.match(readme, /\(2 files\)/);
  assert.match(readme, /- scans\/verband-b\.txt\n- verband-a\.txt/);
  assert.match(readme, /Parts of the records that differ:\n\n- rows\n- steps\n/);
  assert.doesNotMatch(readme, /- modelRequests/);
  assert.match(readme, /The reports differ\./);
  assert.match(output, /record parts that differ: rows, steps/);
});

test('labels name the files; identical sides are reported as identical', t => {
  const { input, out } = workspace(t);
  const { status, output } = runTool([
    '--left',
    fixture('legacy.mjs'),
    '--right',
    fixture('legacy.mjs'),
    '--input',
    input,
    '--out',
    out,
    '--left-label',
    'before',
    '--right-label',
    'after'
  ]);
  assert.equal(status, 0, output);
  assert.ok(fs.existsSync(path.join(out, 'before.report.md')));
  assert.ok(fs.existsSync(path.join(out, 'after.record.json')));
  const readme = fs.readFileSync(path.join(out, 'README.md'), 'utf8');
  assert.match(readme, /Parts of the records that differ:\n\n- none\n/);
  assert.match(readme, /The reports are identical\./);
});

test('a side that cannot run is the one failure: the other side is still written', t => {
  const { input, out } = workspace(t);
  const { status, output } = runTool([
    '--left',
    fixture('legacy.mjs'),
    '--right',
    fixture('broken.mjs'),
    '--input',
    input,
    '--out',
    out
  ]);
  assert.equal(status, 1, output);
  assert.match(output, /the rebuilt side failed, see rebuilt\.error\.txt/);
  assert.ok(fs.existsSync(path.join(out, 'legacy.report.md')));
  assert.match(
    fs.readFileSync(path.join(out, 'rebuilt.error.txt'), 'utf8'),
    /the workflow is not installed/
  );
  assert.match(
    fs.readFileSync(path.join(out, 'README.md'), 'utf8'),
    /failed: the workflow is not installed/
  );
});

test('a missing option is a usage error', t => {
  const { input } = workspace(t);
  const { status, output } = runTool(['--left', fixture('legacy.mjs'), '--input', input]);
  assert.equal(status, 2);
  assert.match(output, /--right is required/);
  assert.match(output, /usage: node server\/tests\/golden\/sideBySide\.mjs/);
});

test('a side can be a golden case, recorded by the harness', async t => {
  const { input, out } = workspace(t);
  const { status, output } = runTool([
    '--left',
    'case:harness/chat-turn-plain',
    '--right',
    'case:harness/chat-turn-tool',
    '--input',
    input,
    '--out',
    out,
    '--left-label',
    'plain',
    '--right-label',
    'tool'
  ]);
  assert.equal(status, 0, output);
  const plain = JSON.parse(fs.readFileSync(path.join(out, 'plain.record.json'), 'utf8'));
  const golden = JSON.parse(
    fs.readFileSync(path.join(here, '__goldens__/harness/chat-turn-plain.json'), 'utf8')
  );
  assert.deepEqual(plain, golden, 'the record of a case is what its golden holds');
  assert.match(fs.readFileSync(path.join(out, 'tool.report.md'), 'utf8'), /Record A-1 is open\./);
  assert.match(fs.readFileSync(path.join(out, 'README.md'), 'utf8'), /- toolCalls\n/);
});
