// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V250 — the filesystem provider's key-prefix index is built for the
 * documents and blobs stored before it existed, so a scoped listing after the
 * upgrade still finds them.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FilesystemStorageProvider } from '../storage/providers/filesystem/index.js';
import { precondition, up } from '../migrations/V250__index_scoped_storage_keys.js';

const roots = [];
after(async () => {
  for (const root of roots) await fs.rm(root, { recursive: true, force: true });
});

async function install(platform = {}) {
  const contentsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-v250-'));
  roots.push(contentsDir);
  await fs.mkdir(path.join(contentsDir, 'config'), { recursive: true });
  await fs.writeFile(path.join(contentsDir, 'config', 'platform.json'), JSON.stringify(platform));
  return contentsDir;
}

function context(contentsDir) {
  const lines = [];
  return {
    lines,
    ctx: {
      contentsDir,
      readJson: async rel => JSON.parse(await fs.readFile(path.join(contentsDir, rel), 'utf8')),
      log: message => lines.push(message),
      warn: message => lines.push(`WARN ${message}`)
    }
  };
}

/** Store data the way a release without the index did. */
async function seedWithoutIndex(baseDir) {
  const old = new FilesystemStorageProvider({
    baseDir,
    keyPrefixSegments: {},
    fenceSweepIntervalMs: 0
  });
  await old.initialize();
  await old.documents.put('chat-files', 'chat__c1__f1', { bytes: 1 }, { ownerId: 'u1' });
  await old.documents.put('chat-files', 'chat__c2__f1', { bytes: 2 }, { ownerId: 'u1' });
  await old.documents.put('chat-files', '_meta__server-bytes', { bytes: 3 });
  await old.documents.put('artifacts', 'run__r1__a1', { name: 'x' });
  await old.blobs.put('chat-files', 'chat__c1__f1.txt', 'text');
  await old.blobs.put('artifacts', 'run__r1__a1', 'payload');
  await old.blobs.put('project-files', 'proj__itm__000000001deadbeef', 'text');
  await old.shutdown();
}

test('builds the markers a scoped listing needs, for documents and blobs', async () => {
  const contentsDir = await install();
  const baseDir = path.join(contentsDir, 'data');
  await seedWithoutIndex(baseDir);

  const { ctx, lines } = context(contentsDir);
  assert.equal(await precondition(ctx), true);
  await up(ctx);
  assert.match(lines.join('\n'), /3 document and 3 blob marker/);

  const provider = new FilesystemStorageProvider({ baseDir, fenceSweepIntervalMs: 0 });
  await provider.initialize();
  try {
    const docs = await provider.documents.list('chat-files', { prefix: 'chat__c1__' });
    assert.deepEqual(
      docs.items.map(d => d.key),
      ['chat__c1__f1']
    );
    const artifacts = await provider.documents.list('artifacts', { prefix: 'run__r1__' });
    assert.deepEqual(
      artifacts.items.map(d => d.key),
      ['run__r1__a1']
    );
    const texts = await provider.blobs.list('chat-files', { prefix: 'chat__c1__' });
    assert.deepEqual(
      texts.items.map(b => b.key),
      ['chat__c1__f1.txt']
    );
    const payloads = await provider.blobs.list('artifacts', { prefix: 'run__r1__' });
    assert.deepEqual(
      payloads.items.map(b => b.key),
      ['run__r1__a1']
    );
    const projects = await provider.blobs.list('project-files', { prefix: 'proj__' });
    assert.deepEqual(
      projects.items.map(b => b.key),
      ['proj__itm__000000001deadbeef']
    );
  } finally {
    await provider.shutdown();
  }
  await fs.access(path.join(baseDir, 'chat-files', '.prefixes', 'chat__c2', 'chat__c2__f1'));
});

test('is idempotent', async () => {
  const contentsDir = await install();
  const baseDir = path.join(contentsDir, 'data');
  await seedWithoutIndex(baseDir);
  const { ctx } = context(contentsDir);
  await up(ctx);
  const before = await fs.readdir(path.join(baseDir, 'chat-files', '.prefixes'), {
    recursive: true
  });
  await up(ctx);
  const again = await fs.readdir(path.join(baseDir, 'chat-files', '.prefixes'), {
    recursive: true
  });
  assert.deepEqual(again.sort(), before.sort());
});

test('runs on an installation with nothing stored', async () => {
  const contentsDir = await install();
  const { ctx, lines } = context(contentsDir);
  await up(ctx);
  assert.match(lines.join('\n'), /0 document and 0 blob marker/);
});

test('skips a provider other than the filesystem', async () => {
  const contentsDir = await install({ storage: { provider: 'postgres' } });
  const { ctx } = context(contentsDir);
  assert.equal(await precondition(ctx), false);
});
