/**
 * Regression test for #1764: tools configured with a `script` file that
 * doesn't exist under server/tools/ used to fail silently until the tool
 * was actually invoked (ERR_MODULE_NOT_FOUND). warnAboutMissingToolScripts
 * should surface this at load time instead.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
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

  it('loadAllTools does not warn about any shipped default tool', async () => {
    logger.warn = (...args) => warnings.push(args);

    await loadAllTools(true, false);

    const missingScriptWarnings = warnings.filter(([message]) => /does not exist/i.test(message));
    assert.deepStrictEqual(missingScriptWarnings, []);
  });
});
