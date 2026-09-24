/**
 * Managed default files (utils/setupUtils.js): the shipped copy is
 * authoritative and is refreshed into contents on every start. A directory
 * entry (`skills/ifinder-search/`) manages every file under it, so a skill an
 * installation already holds is brought up to the shipped version instead of
 * keeping an older copy forever.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MANAGED_DEFAULT_FILES,
  expandManagedDefaultFiles,
  syncManagedDefaultFiles
} from '../utils/setupUtils.js';

const DEFAULTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../defaults');

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ihub-managed-'));
}

async function write(root, relPath, content) {
  const file = path.join(root, relPath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

test('the shipped iFinder search skill is a managed directory', () => {
  assert.ok(MANAGED_DEFAULT_FILES.includes('skills/ifinder-search/'));
});

test('a directory entry expands to every shipped file under it', async () => {
  const files = await expandManagedDefaultFiles(DEFAULTS_DIR, ['skills/ifinder-search/']);
  assert.ok(files.includes('skills/ifinder-search/SKILL.md'));
  assert.ok(files.includes('skills/ifinder-search/references/query-cookbook.md'));
  assert.ok(files.every(f => f.startsWith('skills/ifinder-search/')));
  // Plain file entries pass through; a missing directory is skipped.
  assert.deepEqual(await expandManagedDefaultFiles(DEFAULTS_DIR, ['sources/x.md']), [
    'sources/x.md'
  ]);
  assert.deepEqual(await expandManagedDefaultFiles(DEFAULTS_DIR, ['skills/does-not-exist/']), []);
});

test('an installed skill at an older version is overwritten with the shipped one', async () => {
  const defaults = await tmpDir();
  const contents = await tmpDir();
  await write(defaults, 'skills/demo/SKILL.md', "---\nversion: '1.3'\n---\nnew guidance\n");
  await write(defaults, 'skills/demo/references/cookbook.md', 'new cookbook\n');
  await write(contents, 'skills/demo/SKILL.md', "---\nversion: '1.2'\n---\nold guidance\n");
  // A file the installation added on its own is left alone.
  await write(contents, 'skills/demo/references/local-notes.md', 'mine\n');

  const updated = await syncManagedDefaultFiles({
    defaultsPath: defaults,
    contentsPath: contents,
    entries: ['skills/demo/']
  });

  assert.equal(updated, 2);
  assert.equal(
    await fs.readFile(path.join(contents, 'skills/demo/SKILL.md'), 'utf8'),
    "---\nversion: '1.3'\n---\nnew guidance\n"
  );
  assert.equal(
    await fs.readFile(path.join(contents, 'skills/demo/references/cookbook.md'), 'utf8'),
    'new cookbook\n'
  );
  assert.equal(
    await fs.readFile(path.join(contents, 'skills/demo/references/local-notes.md'), 'utf8'),
    'mine\n'
  );

  // Idempotent: a second run finds everything current.
  assert.equal(
    await syncManagedDefaultFiles({
      defaultsPath: defaults,
      contentsPath: contents,
      entries: ['skills/demo/']
    }),
    0
  );
});

test('a skill the installation does not have is created from the shipped files', async () => {
  const defaults = await tmpDir();
  const contents = await tmpDir();
  await write(defaults, 'skills/demo/SKILL.md', 'guidance\n');

  const updated = await syncManagedDefaultFiles({
    defaultsPath: defaults,
    contentsPath: contents,
    entries: ['skills/demo/']
  });

  assert.equal(updated, 1);
  assert.equal(
    await fs.readFile(path.join(contents, 'skills/demo/SKILL.md'), 'utf8'),
    'guidance\n'
  );
});

test('the real shipped skill syncs into an empty contents directory', async () => {
  const contents = await tmpDir();
  const updated = await syncManagedDefaultFiles({
    defaultsPath: DEFAULTS_DIR,
    contentsPath: contents,
    entries: ['skills/ifinder-search/']
  });
  assert.ok(updated >= 4, `refreshed ${updated}`);
  const skill = await fs.readFile(path.join(contents, 'skills/ifinder-search/SKILL.md'), 'utf8');
  assert.match(skill, /version: '1\.3'/);
});
