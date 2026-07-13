/**
 * Regression tests for the contents/sources containment boundary added to
 * FileSystemHandler (issue #1687). Before this fix, any relative path that
 * stayed inside contents/ but outside contents/sources/ (e.g.
 * "config/groups.json" or a filesystem source's own config.path) was still
 * accepted, letting a contentAdmin read/write files like
 * contents/.encryption-key or contents/config/groups.json.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import FileSystemHandler from '../sources/FileSystemHandler.js';

describe('FileSystemHandler sources/ containment', () => {
  let tempDir;
  let handler;

  before(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-fs-handler-'));
    // Files outside contents/sources that must never be reachable.
    await fs.mkdir(path.join(tempDir, 'config'), { recursive: true });
    await fs.writeFile(path.join(tempDir, 'config', 'groups.json'), '{"secret":true}');
    await fs.writeFile(path.join(tempDir, '.encryption-key'), 'top-secret');

    handler = new FileSystemHandler({ basePath: tempDir });
    // Constructor kicks off directory creation without awaiting it.
    await handler.ensureSourcesDirectory();
    await fs.writeFile(path.join(tempDir, 'sources', 'faq.md'), '# FAQ');
  });

  after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('reads a file under sources/ successfully', async () => {
    const result = await handler.loadContent({ path: 'sources/faq.md' });
    assert.strictEqual(result.content, '# FAQ');
  });

  it('rejects a relative path outside sources/ that still resolves inside contents/', async () => {
    await assert.rejects(
      () => handler.loadContent({ path: 'config/groups.json' }),
      /outside allowed directory/
    );
  });

  it('rejects a dotfile at the contents/ root', async () => {
    await assert.rejects(
      () => handler.loadContent({ path: '.encryption-key' }),
      /outside allowed directory/
    );
  });

  it('rejects writeFile targeting a path outside sources/', async () => {
    await assert.rejects(
      () => handler.writeFile('config/groups.json', '{"adminAccess":true}'),
      /outside allowed directory/
    );

    // The original file must be untouched.
    const original = await fs.readFile(path.join(tempDir, 'config', 'groups.json'), 'utf8');
    assert.strictEqual(original, '{"secret":true}');
  });

  it('rejects deleteFile targeting a path outside sources/', async () => {
    await assert.rejects(() => handler.deleteFile('.encryption-key'), /outside allowed directory/);

    const stillExists = await fs
      .access(path.join(tempDir, '.encryption-key'))
      .then(() => true)
      .catch(() => false);
    assert.strictEqual(stillExists, true);
  });

  it('allows writeFile targeting a path under sources/', async () => {
    const result = await handler.writeFile('sources/new-file.md', 'hello');
    assert.strictEqual(result.success, true);

    const written = await fs.readFile(path.join(tempDir, 'sources', 'new-file.md'), 'utf8');
    assert.strictEqual(written, 'hello');
  });

  it('validateConfig rejects a path outside sources/', () => {
    assert.strictEqual(handler.validateConfig({ path: 'config/groups.json' }), false);
    assert.strictEqual(handler.validateConfig({ path: 'sources/faq.md' }), true);
  });
});
