/**
 * `loadAllTools` runs the missing-script check on what it loads: a tool file
 * that names a script which does not exist is reported, a malformed one never
 * stops the other tools from loading, and the call keeps its result.
 *
 * Runs against a throwaway contents directory (set before anything is imported:
 * the config reads it once).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');
const contentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-contents-'));
process.env.CONTENTS_DIR = path.relative(root, contentsDir);

const { default: logger } = await import('../utils/logger.js');
const { loadAllTools } = await import('../toolsLoader.js');

const tool = (id, extra = {}) => ({ id, name: { en: id }, description: { en: id }, ...extra });

describe('loadAllTools', () => {
  const originalWarn = logger.warn;
  let warnings;

  before(() => {
    fs.mkdirSync(path.join(contentsDir, 'tools'), { recursive: true });
    const write = t =>
      fs.writeFileSync(path.join(contentsDir, 'tools', `${t.id}.json`), JSON.stringify(t));
    write(tool('braveSearch', { script: 'braveSearch.js' }));
    write(tool('ghostTool', { script: 'doesNotExist.js' }));
    write(tool('weirdTool', { script: { not: 'a string' } }));
    write(tool('offTool', { script: 'alsoMissing.js', enabled: false }));
    warnings = [];
    logger.warn = (...args) => warnings.push(args);
  });

  after(() => {
    logger.warn = originalWarn;
    fs.rmSync(contentsDir, { recursive: true, force: true });
  });

  it('warns about a configured tool whose script is missing and still returns the tools', async () => {
    const tools = await loadAllTools(false, false);

    assert.deepEqual(tools.map(t => t.id).sort(), ['braveSearch', 'ghostTool', 'weirdTool']);
    const byTool = Object.fromEntries(warnings.map(([message, meta]) => [meta.toolId, message]));
    assert.match(byTool.ghostTool, /does not exist/i);
    assert.match(byTool.weirdTool, /plain file name/i);
    assert.equal(byTool.braveSearch, undefined, 'a tool with its script is not reported');
  });
});
