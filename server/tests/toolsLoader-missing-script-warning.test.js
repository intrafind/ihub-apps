/**
 * Regression test for #1764: tools configured with a `script` file that
 * doesn't exist under server/tools/ used to fail silently until the tool
 * was actually invoked (ERR_MODULE_NOT_FOUND). warnAboutMissingToolScripts
 * should surface this at load time instead.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { getRootDir } from '../pathUtils.js';
import logger from '../utils/logger.js';
import { warnAboutMissingToolScripts, loadAllTools } from '../toolsLoader.js';

describe('warnAboutMissingToolScripts', () => {
  const originalWarn = logger.warn;
  const warnings = [];

  afterEach(() => {
    logger.warn = originalWarn;
    warnings.length = 0;
  });

  it('warns for a tool whose script file does not exist', () => {
    logger.warn = (...args) => warnings.push(args);

    warnAboutMissingToolScripts([{ id: 'ghostTool', script: 'doesNotExist.js' }]);

    assert.strictEqual(warnings.length, 1);
    const [message, meta] = warnings[0];
    assert.match(message, /does not exist/i);
    assert.strictEqual(meta.toolId, 'ghostTool');
    assert.strictEqual(meta.script, 'doesNotExist.js');
  });

  it('does not warn for a tool whose script file exists', () => {
    logger.warn = (...args) => warnings.push(args);

    warnAboutMissingToolScripts([{ id: 'braveSearch', script: 'braveSearch.js' }]);

    assert.strictEqual(warnings.length, 0);
  });

  it('skips tools without a script field (MCP/OpenAPI/special tools)', () => {
    logger.warn = (...args) => warnings.push(args);

    warnAboutMissingToolScripts([{ id: 'someMcpTool', _mcp: { serverId: 'x' } }]);

    assert.strictEqual(warnings.length, 0);
  });

  it('skips tools that other dispatchers run (A2A, OpenAPI, provider-handled)', () => {
    logger.warn = (...args) => warnings.push(args);

    warnAboutMissingToolScripts([
      { id: 'a2aSkill', script: 'nope.js', _a2a: { agentId: 'x' } },
      { id: 'api', script: 'nope.js', type: 'openapi' },
      { id: 'native', script: 'nope.js', isSpecialTool: true }
    ]);

    assert.strictEqual(warnings.length, 0);
  });

  it('checks <id>.js for a tool that names no script, as runTool would load it', () => {
    logger.warn = (...args) => warnings.push(args);

    warnAboutMissingToolScripts([{ id: 'braveSearch' }, { id: 'ghostTool' }]);

    assert.strictEqual(warnings.length, 1);
    assert.strictEqual(warnings[0][1].toolId, 'ghostTool');
    assert.strictEqual(warnings[0][1].script, 'ghostTool.js');
  });

  it('reports a script value that is not a plain file name and keeps checking the rest', () => {
    logger.warn = (...args) => warnings.push(args);

    assert.doesNotThrow(() =>
      warnAboutMissingToolScripts([
        { id: 'objectScript', script: { not: 'a string' } },
        { id: 'arrayScript', script: ['braveSearch.js'] },
        { id: 'traversal', script: '../../etc/passwd' },
        { id: 'ghostTool', script: 'doesNotExist.js' }
      ])
    );

    assert.deepStrictEqual(
      warnings.map(([message, meta]) => [meta.toolId, /plain file name/.test(message)]),
      [
        ['objectScript', true],
        ['arrayScript', true],
        ['traversal', true],
        ['ghostTool', false]
      ]
    );
  });

  it('does not warn about any shipped default tool', () => {
    logger.warn = (...args) => warnings.push(args);
    // Read straight from server/defaults: loadAllTools() reads contents/tools,
    // which a fresh checkout does not have until the server has run once, so a
    // check on its result would pass with no tools at all.
    const defaultsDir = path.join(getRootDir(), 'server', 'defaults', 'tools');
    const defaults = fs
      .readdirSync(defaultsDir)
      .filter(file => file.endsWith('.json'))
      .map(file => JSON.parse(fs.readFileSync(path.join(defaultsDir, file), 'utf8')));
    assert.ok(defaults.length > 0, 'there are shipped default tools to check');

    warnAboutMissingToolScripts(defaults);

    assert.deepStrictEqual(warnings, []);
  });

  it('loadAllTools runs the check on whatever it loads', async () => {
    logger.warn = (...args) => warnings.push(args);

    await loadAllTools(true, false);

    const missingScriptWarnings = warnings.filter(([message]) => /does not exist/i.test(message));
    assert.deepStrictEqual(missingScriptWarnings, []);
  });
});

describe('examples/config/tools.json', () => {
  it('only references scripts that exist in server/tools', () => {
    const scriptsDir = path.join(getRootDir(), 'server', 'tools');
    const examples = JSON.parse(
      fs.readFileSync(path.join(getRootDir(), 'examples', 'config', 'tools.json'), 'utf8')
    );
    const tools = Array.isArray(examples) ? examples : examples.tools;

    const missing = tools
      .filter(tool => tool.script && !fs.existsSync(path.join(scriptsDir, tool.script)))
      .map(tool => `${tool.id} -> ${tool.script}`);

    assert.deepStrictEqual(missing, []);
  });
});
