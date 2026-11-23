// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * No input runs as code on the server: a file that loads `node:vm`, or calls
 * `eval(` or `new Function(`, is an entry of `dynamicCodeAllowList.json` with
 * its reason. A new one fails here until it is listed with a reason a
 * reviewer accepts; an entry whose file no longer does it fails too.
 *
 * The browser libraries vendored under `server/artifactLibraries/` are served
 * to the browser and never run on the server: they are not scanned.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SERVER_ROOT,
  allowListProblems,
  codeOf,
  compareWithAllowList,
  scan
} from './sourceScan.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const allowList = JSON.parse(
  await fs.readFile(path.join(here, 'dynamicCodeAllowList.json'), 'utf8')
);

/** The rules of this guard. */
export const RULES = Object.freeze({
  vm: code =>
    /\bfrom\s+['"](?:node:)?vm['"]|\brequire\s*\(\s*['"](?:node:)?vm['"]\s*\)|\bimport\s*\(\s*['"](?:node:)?vm['"]\s*\)/.test(
      code
    ),
  eval: code => /(?<![\w$.])eval\s*\(/.test(code),
  'new Function': code => /\bnew\s+Function\s*\(/.test(code)
});

/** The directories of the server this guard leaves out, besides tests and dependencies. */
const NOT_RUN_ON_THE_SERVER = ['artifactLibraries'];

test('every entry of the allow-list gives the rules it may break and its reason', () => {
  assert.deepEqual(
    allowListProblems(allowList.entries, Object.keys(RULES), { removalRequired: false }),
    []
  );
});

test('no node:vm, eval( or new Function( on the server except the allow-list', async () => {
  const found = await scan(SERVER_ROOT, RULES, { skip: NOT_RUN_ON_THE_SERVER });
  const { unlisted, stale } = compareWithAllowList(found, allowList.entries);
  assert.deepEqual(
    unlisted,
    [],
    'code that runs input as code: remove it, or list it in server/tests/architecture/dynamicCodeAllowList.json with its reason'
  );
  assert.deepEqual(stale, [], 'listed files that no longer do it');
});

test('the check sees vm, eval and new Function, and not a mention', () => {
  const breaks = (rule, source) => RULES[rule](codeOf(source));
  assert.equal(breaks('vm', "import vm from 'node:vm';"), true);
  assert.equal(breaks('vm', "const vm = require('vm');"), true);
  assert.equal(breaks('vm', "const { Script } = await import('node:vm');"), true);
  assert.equal(breaks('vm', "import { vmStats } from './vmStats.js';"), false);
  assert.equal(breaks('eval', 'const value = eval(source);'), true);
  assert.equal(breaks('eval', 'const value = expression.evaluate(source);'), false);
  assert.equal(breaks('eval', '// no eval( here'), false);
  assert.equal(breaks('new Function', "const f = new Function('a', 'return a');"), true);
  assert.equal(breaks('new Function', '/** No `new Function()` */'), false);
});

test('dynamic code in a scratch file fails the guard (negative fixture)', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-arch-dynamic-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const write = async (rel, source) => {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), source);
  };
  await write('services/scratch.js', "import vm from 'node:vm';\nconst f = new Function('x');\n");
  await write('tools/scratch.js', 'export const run = source => eval(source);\n');
  await write('artifactLibraries/vendored.min.js', 'eval("x");\n');
  const found = await scan(root, RULES, { skip: NOT_RUN_ON_THE_SERVER });
  assert.deepEqual(compareWithAllowList(found, []).unlisted, [
    'services/scratch.js: new Function',
    'services/scratch.js: vm',
    'tools/scratch.js: eval'
  ]);
});
