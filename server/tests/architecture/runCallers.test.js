// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Nothing runs the model or a tool outside the run service: outside
 * `server/services/run/`, every file that runs the agent loop
 * (`agentLoop.run(`, under any name that ends in `agentLoop`), builds one
 * (`new AgentLoop(`) or calls a tool past the tool runner (`runTool(`, bare
 * or as a method) is an entry of `runCallersAllowList.json`, with the rules
 * it may break, its reason and the issue that removes it. A new caller fails
 * here until it goes through `RunService.run` / `ToolRunner.execute` or is
 * listed; an entry whose file no longer breaks a listed rule fails too.
 *
 * The module that defines the loop (`services/loop/AgentLoop.js`) builds the
 * instance every caller shares; it is not a caller and is not scanned.
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
  await fs.readFile(path.join(here, 'runCallersAllowList.json'), 'utf8')
);

/** A call of `runTool(`, bare or as a method; never its definition. */
const RUN_TOOL_CALL = /(?<![\w$])runTool\s*\(/g;

/** Whether the code calls `runTool(` anywhere but in its own definition. */
export function callsRunTool(code) {
  for (const match of code.matchAll(RUN_TOOL_CALL)) {
    const before = code.slice(Math.max(0, match.index - 20), match.index);
    if (!/function\s*\*?\s*$/.test(before)) return true;
  }
  return false;
}

/** The rules of this guard. */
export const RULES = Object.freeze({
  runTool: callsRunTool,
  'agentLoop.run': code => /(?<![\w$])[\w$]*agentloop\s*\.\s*run\s*\(/i.test(code),
  'new AgentLoop': code => /\bnew\s+AgentLoop\s*\(/.test(code)
});

/** The files of a root this guard scans. */
const scanned = root =>
  scan(root, RULES, {
    exclude: rel => rel.startsWith('services/run/') || rel === 'services/loop/AgentLoop.js'
  });

test('every entry of the allow-list gives the rules it may break, its reason and its removal issue', () => {
  assert.deepEqual(allowListProblems(allowList.entries, Object.keys(RULES)), []);
});

test('no agentLoop.run(, new AgentLoop( or runTool( outside server/services/run/ except the allow-list', async () => {
  const { unlisted, stale } = compareWithAllowList(await scanned(SERVER_ROOT), allowList.entries);
  assert.deepEqual(
    unlisted,
    [],
    'model work or a tool call outside the run service: use RunService.run or ToolRunner.execute, or list it in server/tests/architecture/runCallersAllowList.json'
  );
  assert.deepEqual(stale, [], 'listed callers that no longer make that call');
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

test('the check sees a loop run under any name and a new loop, and not a mention', () => {
  const breaks = (rule, source) => RULES[rule](codeOf(source));
  assert.equal(breaks('agentLoop.run', 'await this.agentLoop.run({ model });'), true);
  assert.equal(breaks('agentLoop.run', 'await defaultAgentLoop.run(request);'), true);
  assert.equal(breaks('agentLoop.run', 'svc.agentLoop . run (x)'), true);
  assert.equal(breaks('agentLoop.run', '// agentLoop.run( is the loop'), false);
  assert.equal(breaks('agentLoop.run', 'const runs = agentLoop.runs;'), false);
  assert.equal(breaks('new AgentLoop', 'const loop = new AgentLoop({ llmClient });'), true);
  assert.equal(breaks('new AgentLoop', 'import { AgentLoop } from "./AgentLoop.js";'), false);
});

test('a forbidden call in a scratch file fails the guard (negative fixture)', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-arch-run-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const write = async (rel, source) => {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), source);
  };
  await write('services/run/hosts/Allowed.js', 'await svc.agentLoop.run({});\n');
  await write('services/loop/AgentLoop.js', 'export default new AgentLoop();\n');
  await write('services/scratch/sneaky.js', 'const loop = new AgentLoop();\nawait loop.run({});\n');
  await write('tools/scratch.js', 'await runTool("x", {});\nawait this.agentLoop.run({});\n');
  const { unlisted } = compareWithAllowList(await scanned(root), []);
  assert.deepEqual(unlisted, [
    'services/scratch/sneaky.js: new AgentLoop',
    'tools/scratch.js: agentLoop.run',
    'tools/scratch.js: runTool'
  ]);
  // Listed, the same file passes; a listed rule the file no longer breaks is stale.
  const listed = compareWithAllowList(await scanned(root), [
    { path: 'tools/scratch.js', rules: ['runTool', 'agentLoop.run', 'new AgentLoop'] }
  ]);
  assert.deepEqual(listed.unlisted, ['services/scratch/sneaky.js: new AgentLoop']);
  assert.deepEqual(listed.stale, ['tools/scratch.js: new AgentLoop']);
});
