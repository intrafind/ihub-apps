import assert from 'node:assert';
import { describe, it } from 'node:test';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import config from '../config.js';
import { getRootDir } from '../pathUtils.js';
import { getContentsPath } from '../utils/contentsPath.js';

describe('contentsPath utility', () => {
  it('builds paths from getRootDir and configured CONTENTS_DIR', () => {
    const expected = path.join(getRootDir(), config.CONTENTS_DIR, 'config', 'platform.json');
    assert.strictEqual(getContentsPath('config', 'platform.json'), expected);
  });

  it('honors CONTENTS_DIR in a fresh process', () => {
    const testContentsDir = 'custom-contents-for-test';
    const testScript = `
      import { getContentsPath } from './server/utils/contentsPath.js';
      console.log(getContentsPath('config'));
    `;
    const __filename = fileURLToPath(import.meta.url);
    const repoRoot = path.resolve(path.dirname(__filename), '..', '..');
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', testScript], {
      cwd: repoRoot,
      env: { ...process.env, CONTENTS_DIR: testContentsDir }
    })
      .toString()
      .trim();

    assert.strictEqual(output, path.join(repoRoot, testContentsDir, 'config'));
  });
});
