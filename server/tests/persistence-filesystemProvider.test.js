/**
 * FilesystemProvider Test Suite
 */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { FilesystemProvider } from '../persistence/FilesystemProvider.js';

describe('FilesystemProvider', () => {
  let tmpDir;
  let provider;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fs-provider-test-'));
    provider = new FilesystemProvider(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns null reading a file that does not exist', async () => {
    expect(await provider.read('missing.json')).toBeNull();
  });

  it('writes then reads back the same content', async () => {
    await provider.write('config/platform.json', '{"a":1}');
    expect(await provider.read('config/platform.json')).toBe('{"a":1}');
  });

  it('creates intermediate directories on write', async () => {
    await provider.write('nested/dir/file.txt', 'hello');
    const onDisk = await fs.readFile(path.join(tmpDir, 'nested/dir/file.txt'), 'utf8');
    expect(onDisk).toBe('hello');
  });

  it('exists() reflects presence', async () => {
    expect(await provider.exists('a.json')).toBe(false);
    await provider.write('a.json', '{}');
    expect(await provider.exists('a.json')).toBe(true);
  });

  it('delete() removes a file and is idempotent', async () => {
    await provider.write('a.json', '{}');
    await provider.delete('a.json');
    expect(await provider.exists('a.json')).toBe(false);
    // deleting again must not throw
    await expect(provider.delete('a.json')).resolves.toBeUndefined();
  });

  it('list() returns sorted entry names, empty for a missing dir', async () => {
    expect(await provider.list('nope')).toEqual([]);
    await provider.write('apps/b.json', '{}');
    await provider.write('apps/a.json', '{}');
    expect(await provider.list('apps')).toEqual(['a.json', 'b.json']);
  });

  it('list() applies the optional pattern filter', async () => {
    await provider.write('apps/a.json', '{}');
    await provider.write('apps/a.json.bak', '{}');
    expect(await provider.list('apps', { pattern: /\.json$/ })).toEqual(['a.json']);
  });

  describe('path traversal', () => {
    const traversalAttempts = ['../escape.json', '../../etc/passwd', '../../../secret.json'];

    it('write() rejects and never creates a file outside baseDir', async () => {
      for (const attempt of traversalAttempts) {
        await expect(provider.write(attempt, '{}')).rejects.toThrow();
      }
      const escaped = path.join(path.dirname(tmpDir), 'escape.json');
      await expect(fs.access(escaped)).rejects.toThrow();
    });

    it('delete() rejects rather than touching anything outside baseDir', async () => {
      for (const attempt of traversalAttempts) {
        await expect(provider.delete(attempt)).rejects.toThrow();
      }
    });

    it('read() treats a blocked path as not-found (null), same as a missing file', async () => {
      for (const attempt of traversalAttempts) {
        expect(await provider.read(attempt)).toBeNull();
      }
    });

    it('exists() treats a blocked path as not-found (false)', async () => {
      for (const attempt of traversalAttempts) {
        expect(await provider.exists(attempt)).toBe(false);
      }
    });

    it('list() treats a blocked directory as not-found (empty array)', async () => {
      for (const attempt of traversalAttempts) {
        expect(await provider.list(attempt)).toEqual([]);
      }
    });
  });
});
