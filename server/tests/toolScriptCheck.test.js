/**
 * Startup check for script-backed tools: a tool that cannot load, or whose
 * script does not export what the definition declares, is reported at startup
 * instead of failing the first time a model calls it.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import logger from '../utils/logger.js';
import { getRootDir } from '../pathUtils.js';
import {
  checkToolScripts,
  expectedExports,
  runStartupToolCheck,
  TOOL_SCRIPT_PROBLEMS
} from '../services/tools/toolScriptCheck.js';

describe('expectedExports', () => {
  it('wants the default export for a plain tool', () => {
    assert.deepEqual(expectedExports({ id: 'a', script: 'a.js' }), ['default']);
  });

  it('wants the method of one expanded function', () => {
    assert.deepEqual(expectedExports({ id: 'a_search', script: 'a.js', method: 'search' }), [
      'search'
    ]);
  });

  it('wants every function of a raw multi-function tool', () => {
    const tool = { id: 'a', script: 'a.js', functions: { search: {}, getContent: {} } };
    assert.deepEqual(expectedExports(tool), ['search', 'getContent']);
  });
});

describe('checkToolScripts', () => {
  let scriptsDir;

  beforeEach(() => {
    scriptsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-script-check-'));
  });

  afterEach(() => {
    fs.rmSync(scriptsDir, { recursive: true, force: true });
  });

  const write = name => fs.writeFileSync(path.join(scriptsDir, name), '// fixture\n');

  /** Loader that serves canned modules by file name, throws for `broken.js`. */
  const importScript = async scriptPath => {
    const name = path.basename(scriptPath);
    if (name === 'broken.js') {
      throw new Error("Cannot find package 'somePackage' imported from broken.js\n  at x");
    }
    if (name === 'multi.js') return { search: () => {}, getContent: 'not a function' };
    return { default: () => {} };
  };

  it('passes a tool whose script loads and exports a default function', async () => {
    write('good.js');

    const report = await checkToolScripts([{ id: 'good', script: 'good.js' }], {
      scriptsDir,
      importScript
    });

    assert.deepEqual(report, { checked: 1, ok: 1, skipped: 0, problems: [] });
  });

  it('reports a script that does not exist', async () => {
    const report = await checkToolScripts([{ id: 'ghost', script: 'ghost.js' }], {
      scriptsDir,
      importScript
    });

    assert.equal(report.problems.length, 1);
    assert.equal(report.problems[0].kind, TOOL_SCRIPT_PROBLEMS.MISSING);
    assert.deepEqual(report.problems[0].toolIds, ['ghost']);
  });

  it('reports a script that fails to load, with the first line of the reason', async () => {
    write('broken.js');

    const report = await checkToolScripts([{ id: 'broken', script: 'broken.js' }], {
      scriptsDir,
      importScript
    });

    assert.equal(report.problems[0].kind, TOOL_SCRIPT_PROBLEMS.LOAD_FAILED);
    assert.equal(
      report.problems[0].message,
      "Cannot find package 'somePackage' imported from broken.js"
    );
    assert.equal(report.ok, 0);
  });

  it('reports exports the definition declares but the script does not provide', async () => {
    write('multi.js');
    const tools = [
      { id: 'multi_search', script: 'multi.js', method: 'search' },
      { id: 'multi_getContent', script: 'multi.js', method: 'getContent' },
      { id: 'multi_missing', script: 'multi.js', method: 'missing' }
    ];

    const report = await checkToolScripts(tools, { scriptsDir, importScript });

    assert.equal(report.checked, 1, 'one script shared by three definitions is loaded once');
    assert.equal(report.problems.length, 1);
    assert.equal(report.problems[0].kind, TOOL_SCRIPT_PROBLEMS.MISSING_EXPORT);
    assert.deepEqual(report.problems[0].missingExports, ['getContent', 'missing']);
    assert.deepEqual(report.problems[0].toolIds, [
      'multi_search',
      'multi_getContent',
      'multi_missing'
    ]);
  });

  it('rejects a script name that is a path rather than a file name', async () => {
    const report = await checkToolScripts([{ id: 'evil', script: '../../etc/passwd' }], {
      scriptsDir,
      importScript
    });

    assert.equal(report.problems[0].kind, TOOL_SCRIPT_PROBLEMS.INVALID_NAME);
  });

  it('skips disabled, provider-handled, MCP, A2A and OpenAPI tools', async () => {
    const tools = [
      { id: 'off', script: 'broken.js', enabled: false },
      { id: 'special', script: 'broken.js', isSpecialTool: true },
      { id: 'mcp', script: 'broken.js', _mcp: { serverId: 'x' } },
      { id: 'a2a', script: 'broken.js', _a2a: { agentId: 'x' } },
      { id: 'api', script: 'broken.js', type: 'openapi' }
    ];

    const report = await checkToolScripts(tools, { scriptsDir, importScript });

    assert.deepEqual(report, { checked: 0, ok: 0, skipped: 5, problems: [] });
  });

  it('checks <id>.js for a tool that names no script, as runTool would load it', async () => {
    write('implicit.js');

    const report = await checkToolScripts([{ id: 'implicit' }, { id: 'noScriptAtAll' }], {
      scriptsDir,
      importScript
    });

    assert.equal(report.checked, 2);
    assert.equal(report.ok, 1);
    assert.equal(report.problems.length, 1);
    assert.equal(report.problems[0].script, 'noScriptAtAll.js');
    assert.equal(report.problems[0].kind, TOOL_SCRIPT_PROBLEMS.MISSING);
  });

  it('reports a script value that is not a string without failing the other tools', async () => {
    write('good.js');

    const report = await checkToolScripts(
      [
        { id: 'weird', script: { not: 'a string' } },
        { id: 'good', script: 'good.js' }
      ],
      { scriptsDir, importScript }
    );

    assert.equal(report.checked, 2);
    assert.equal(report.ok, 1);
    assert.equal(report.problems.length, 1);
    assert.equal(report.problems[0].kind, TOOL_SCRIPT_PROBLEMS.INVALID_NAME);
    assert.deepEqual(report.problems[0].toolIds, ['weird']);
  });
});

describe('runStartupToolCheck', () => {
  const originalWarn = logger.warn;
  const originalInfo = logger.info;
  let warnings;
  let infos;
  let scriptsDir;

  beforeEach(() => {
    warnings = [];
    infos = [];
    logger.warn = (...args) => warnings.push(args);
    logger.info = (...args) => infos.push(args);
    scriptsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-script-check-'));
    fs.writeFileSync(path.join(scriptsDir, 'good.js'), '// fixture\n');
    fs.writeFileSync(path.join(scriptsDir, 'broken.js'), '// fixture\n');
  });

  afterEach(() => {
    logger.warn = originalWarn;
    logger.info = originalInfo;
    fs.rmSync(scriptsDir, { recursive: true, force: true });
  });

  const importScript = async scriptPath => {
    if (path.basename(scriptPath) === 'broken.js') throw new Error('boom');
    return { default: () => {} };
  };

  it('logs one warning per unusable script and a summary', async () => {
    const tools = [
      { id: 'good', script: 'good.js' },
      { id: 'broken', script: 'broken.js' },
      { id: 'ghost', script: 'ghost.js' }
    ];

    const report = await runStartupToolCheck({ tools, scriptsDir, importScript });

    assert.equal(report.problems.length, 2);
    const perScript = warnings.filter(([, meta]) => meta.script);
    assert.equal(perScript.length, 1, 'a missing script was already reported at load time');
    assert.equal(perScript[0][1].script, 'broken.js');
    assert.equal(perScript[0][1].reason, 'boom');
    const summary = warnings.find(([, meta]) => meta.scripts !== undefined);
    assert.deepEqual(
      { scripts: summary[1].scripts, ok: summary[1].ok, problems: summary[1].problems },
      { scripts: 3, ok: 1, problems: 2 }
    );
  });

  it('logs only an info line when every tool can be loaded', async () => {
    await runStartupToolCheck({
      tools: [{ id: 'good', script: 'good.js' }],
      scriptsDir,
      importScript
    });

    assert.equal(warnings.length, 0);
    assert.equal(infos.length, 1);
  });

  it('does nothing, and does not throw, when there are no tools to check', async () => {
    assert.equal(await runStartupToolCheck({ tools: 'not a list' }), null);
    assert.equal(warnings.length, 0);
  });
});

describe('the shipped default tools', () => {
  it('every enabled default tool script loads and exports what its definition declares', async () => {
    // Read straight from server/defaults: loadAllTools() reads contents/tools,
    // which a fresh checkout does not have until the server has run once.
    const defaultsDir = path.join(getRootDir(), 'server', 'defaults', 'tools');
    const tools = fs
      .readdirSync(defaultsDir)
      .filter(file => file.endsWith('.json'))
      .map(file => JSON.parse(fs.readFileSync(path.join(defaultsDir, file), 'utf8')));

    const report = await checkToolScripts(tools);

    assert.ok(report.checked > 0, 'the defaults have script-backed tools to check');
    assert.deepEqual(report.problems, []);
  });
});
