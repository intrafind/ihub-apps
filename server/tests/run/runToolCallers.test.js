// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * No tool call skips the tool runner: outside `server/services/run/`, every
 * call of `runTool(` (bare or as a method) is an entry of
 * `runToolAllowList.json`, with its reason and the issue that removes it.
 * A new caller fails here until it goes through `ToolRunner.execute` or is
 * listed; an entry whose file no longer calls `runTool` fails too.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { byCodeUnit } from '../golden/byCodeUnit.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '../..');
const allowList = JSON.parse(await fs.readFile(path.join(here, 'runToolAllowList.json'), 'utf8'));

/** A call of `runTool(`, bare or as a method; never its definition. */
const RUN_TOOL_CALL = /(?<![\w$])runTool\s*\(/g;

async function* jsFiles(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (['node_modules', 'tests', 'defaults'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* jsFiles(full);
    else if (entry.name.endsWith('.js')) yield full;
  }
}

/** The source without its comments, line by line, so a doc comment never counts. */
function codeOf(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(line => line.replace(/(^|\s)\/\/.*$/, ''))
    .join('\n');
}

/** Whether the code calls `runTool(` anywhere but in its own definition. */
export function callsRunTool(code) {
  for (const match of code.matchAll(RUN_TOOL_CALL)) {
    const before = code.slice(Math.max(0, match.index - 20), match.index);
    if (!/function\s*\*?\s*$/.test(before)) return true;
  }
  return false;
}

async function runToolCallers() {
  const callers = [];
  for await (const file of jsFiles(serverRoot)) {
    const rel = path.relative(serverRoot, file).split(path.sep).join('/');
    if (rel.startsWith('services/run/')) continue;
    if (callsRunTool(codeOf(await fs.readFile(file, 'utf8')))) callers.push(rel);
  }
  return callers.sort(byCodeUnit);
}

test('every entry of the allow-list gives its reason and the issue that removes it', () => {
  assert.ok(Array.isArray(allowList.entries) && allowList.entries.length > 0);
  const seen = new Set();
  for (const entry of allowList.entries) {
    assert.equal(typeof entry.path, 'string', JSON.stringify(entry));
    assert.ok(!seen.has(entry.path), `${entry.path} is listed twice`);
    seen.add(entry.path);
    assert.ok(
      typeof entry.reason === 'string' && entry.reason.trim().length > 20,
      `${entry.path}: a reason`
    );
    assert.match(String(entry.removal), /^#\d+$/, `${entry.path}: the removal issue (#<number>)`);
  }
});

test('no runTool( call outside server/services/run/ except the allow-list', async () => {
  const callers = await runToolCallers();
  const listed = new Set(allowList.entries.map(entry => entry.path));
  const unlisted = callers.filter(rel => !listed.has(rel));
  assert.deepEqual(
    unlisted,
    [],
    'a tool call that skips the tool runner: use ToolRunner.execute, or list it in server/tests/run/runToolAllowList.json'
  );
  const stale = [...listed].filter(rel => !callers.includes(rel));
  assert.deepEqual(stale, [], 'listed callers that no longer call runTool');
});

test('the check sees a bare call and a method call, and not the definition or a comment', () => {
  assert.equal(callsRunTool(codeOf('await runTool(id, params);')), true);
  assert.equal(callsRunTool(codeOf('await this.runTool(id, params);')), true);
  assert.equal(callsRunTool(codeOf('const r = await Promise.race([runTool(id, p), t]);')), true);
  assert.equal(callsRunTool(codeOf('export async function runTool(toolId, params) {}')), false);
  assert.equal(callsRunTool(codeOf('// runTool(toolId, params) runs it')), false);
  assert.equal(callsRunTool(codeOf('/**\n * `runTool(id)` dispatches\n */')), false);
  assert.equal(callsRunTool(codeOf('new ToolRunner({ runTool: options.runTool });')), false);
  assert.equal(callsRunTool(codeOf('const runToolSafely = 1; myrunTool(x);')), false);
});
