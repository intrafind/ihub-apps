/**
 * Regression tests for #1804: ContentInstaller's skill multi-file write path
 * used a prefix check (`resolvedPath.startsWith(path.resolve(skillDir))`)
 * with no trailing separator, so a companion filename resolving into a
 * sibling directory that shares the skill directory's name as a prefix
 * (e.g. skillDir `.../skills/foo`, filename `../foo-evil/x`) incorrectly
 * passed the boundary check. The fix reuses `resolveAndValidatePath` from
 * `utils/pathSecurity.js`, which performs a separator-aware boundary check.
 *
 * Note: The repo's source is native ESM (uses `import.meta.url`), so this
 * file uses `jest.unstable_mockModule` + dynamic imports rather than the
 * CommonJS-only `jest.mock` API. Run with
 * `NODE_OPTIONS=--experimental-vm-modules`.
 */

import { jest } from '@jest/globals';
import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import os from 'os';
import path from 'path';

// TokenStorageService (a transitive import via RegistryService) reads
// getRootDir() synchronously at module-load time to build its singleton, so
// this must resolve to a real directory before the dynamic import below runs.
const state = { rootDir: os.tmpdir() };

jest.unstable_mockModule('../pathUtils.js', () => ({
  getRootDir: () => state.rootDir,
  getContentsDir: () => path.join(state.rootDir, 'contents'),
  getContentsPath: (...segments) => path.join(state.rootDir, 'contents', ...segments)
}));

const { default: contentInstaller } = await import('../services/marketplace/ContentInstaller.js');

describe('ContentInstaller skill multi-file path traversal protection (#1804)', () => {
  let tmpRoot;
  let skillDir;
  let siblingEvilFile;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-content-installer-test-'));
    state.rootDir = tmpRoot;

    skillDir = path.join(tmpRoot, 'contents', 'skills', 'foo');
    await fs.mkdir(skillDir, { recursive: true });

    // A sibling directory that shares the target skill directory's name as a
    // prefix ("foo" vs "foo-evil") — the exact case the old prefix check missed.
    const evilDir = path.join(tmpRoot, 'contents', 'skills', 'foo-evil');
    await fs.mkdir(evilDir, { recursive: true });
    siblingEvilFile = path.join(evilDir, 'x');
    await fs.writeFile(siblingEvilFile, 'untouched');
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  test('writes a benign companion file in a subdirectory', async () => {
    await contentInstaller._writeContent(
      'skill',
      'foo',
      { files: { 'assets/logo.png': 'binarydata' } },
      { dir: 'skills', ext: null }
    );

    const written = await fs.readFile(path.join(skillDir, 'assets', 'logo.png'), 'utf8');
    expect(written).toBe('binarydata');
  });

  test('rejects a companion filename that traverses into a sibling directory sharing a name prefix', async () => {
    await expect(
      contentInstaller._writeContent(
        'skill',
        'foo',
        { files: { '../foo-evil/x': 'pwned' } },
        { dir: 'skills', ext: null }
      )
    ).rejects.toThrow('Path traversal detected in skill file');

    const content = await fs.readFile(siblingEvilFile, 'utf8');
    expect(content).toBe('untouched');
  });

  test('rejects a classic ../.. traversal attempt', async () => {
    await expect(
      contentInstaller._writeContent(
        'skill',
        'foo',
        { files: { '../../../../etc/passwd': 'pwned' } },
        { dir: 'skills', ext: null }
      )
    ).rejects.toThrow('Path traversal detected in skill file');

    expect(existsSync(path.join(tmpRoot, 'etc', 'passwd'))).toBe(false);
  });
});
