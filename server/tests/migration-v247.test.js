// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V247 — every stored document envelope gets its `etag` and `size`
 * (#3624).
 *
 * The filesystem document store now writes both into the envelope, before the
 * body, and reads metadata-only listings from the start of the file. Envelopes
 * written by earlier releases have neither; this migration rewrites them once.
 * The values must be exactly what the store reported for them before (the
 * contract: sha256 and byte length of the canonical serialization), so that a
 * client holding an etag from before the upgrade can still compare-and-set.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalJson } from '../storage/canonicalJson.js';
import { documentEtag } from '../storage/etag.js';
import { FilesystemStorageProvider } from '../storage/providers/filesystem/index.js';
import { precondition, up } from '../migrations/V247__document_envelope_etag.js';

const roots = [];
after(async () => {
  for (const root of roots) await fs.rm(root, { recursive: true, force: true });
});

/** Etag and size as releases before V247 derived them on every read. */
function legacyDigest(data) {
  const json = canonicalJson(data);
  return { etag: documentEtag(json), size: Buffer.byteLength(json, 'utf8') };
}

async function legacyInstall(platform = {}) {
  const contentsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-v247-'));
  roots.push(contentsDir);
  await fs.mkdir(path.join(contentsDir, 'config'), { recursive: true });
  await fs.writeFile(path.join(contentsDir, 'config', 'platform.json'), JSON.stringify(platform));
  return contentsDir;
}

/** Write an envelope the way releases before V247 did. */
async function writeLegacyEnvelope(baseDir, ns, key, data, ownerId = null) {
  await fs.mkdir(path.join(baseDir, ns), { recursive: true });
  const envelope = {
    v: 1,
    key,
    ownerId,
    contentType: 'application/json',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    data
  };
  await fs.writeFile(path.join(baseDir, ns, `${key}.json`), JSON.stringify(envelope, null, 2));
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

test('upgrades every legacy envelope once, with the etag the store reported before', async () => {
  const contentsDir = await legacyInstall();
  const baseDir = path.join(contentsDir, 'data');
  const bodies = {
    'wf-exec-1': { status: 'completed', z: [1, { b: 2, a: 'ä' }], 10: 'x', 9: 'y' },
    'wf-exec-2': { status: 'paused', history: Array.from({ length: 50 }, (_, i) => ({ i })) }
  };
  for (const [key, data] of Object.entries(bodies)) {
    await writeLegacyEnvelope(baseDir, 'workflow-state', key, data, 'user-1');
  }
  await writeLegacyEnvelope(baseDir, 'chats', 'c1', { title: 'Hello' }, 'user-1');
  // Not envelopes: the old execution registry and a legacy checkpoint directory.
  await fs.writeFile(
    path.join(baseDir, 'workflow-state', 'execution-registry.json'),
    JSON.stringify({ executions: [] })
  );
  await fs.mkdir(path.join(baseDir, 'workflow-state', 'wf-exec-old'), { recursive: true });
  await fs.writeFile(path.join(baseDir, 'workflow-state', 'wf-exec-old', 'latest.json'), '{}');

  assert.equal(await precondition(context(contentsDir).ctx), true);
  const first = context(contentsDir);
  await up(first.ctx);
  assert.ok(
    first.lines.some(line => /upgraded 3 /.test(line)),
    first.lines.join('\n')
  );

  for (const [key, data] of Object.entries(bodies)) {
    const raw = await fs.readFile(path.join(baseDir, 'workflow-state', `${key}.json`), 'utf8');
    const envelope = JSON.parse(raw);
    assert.equal(envelope.v, 2);
    assert.deepEqual({ etag: envelope.etag, size: envelope.size }, legacyDigest(data), key);
    assert.deepEqual(envelope.data, data);
    assert.equal(envelope.ownerId, 'user-1');
    assert.equal(envelope.createdAt, '2026-01-01T00:00:00.000Z', 'timestamps are kept');
    assert.equal(envelope.updatedAt, '2026-01-02T00:00:00.000Z');
    assert.ok(raw.indexOf('"etag"') < raw.indexOf('"data"'));
  }
  assert.deepEqual(
    JSON.parse(
      await fs.readFile(path.join(baseDir, 'workflow-state', 'execution-registry.json'), 'utf8')
    ),
    { executions: [] },
    'a file that is not an envelope is left alone'
  );

  // The store reads the upgraded documents with the etag clients already hold.
  const provider = new FilesystemStorageProvider({ baseDir });
  await provider.initialize();
  try {
    const doc = await provider.documents.get('workflow-state', 'wf-exec-1');
    assert.equal(doc.etag, legacyDigest(bodies['wf-exec-1']).etag);
    const page = await provider.documents.list('workflow-state', { includeData: false });
    // The old registry file is not an envelope: it is reported, not listed.
    assert.equal(page.skipped, 1);
    assert.deepEqual(
      page.items.map(item => item.key),
      ['wf-exec-1', 'wf-exec-2']
    );
    await provider.documents.put('workflow-state', 'wf-exec-2', bodies['wf-exec-2'], {
      etag: legacyDigest(bodies['wf-exec-2']).etag
    });
  } finally {
    await provider.shutdown();
  }

  // Idempotent: a second run finds nothing left to upgrade.
  const second = context(contentsDir);
  await up(second.ctx);
  assert.ok(
    second.lines.some(line => /upgraded 0 /.test(line)),
    second.lines.join('\n')
  );
});

test('honours a configured data directory, and skips another storage provider', async () => {
  const contentsDir = await legacyInstall({ storage: { filesystem: { dataDir: 'store' } } });
  await writeLegacyEnvelope(path.join(contentsDir, 'store'), 'chats', 'c1', { a: 1 });
  await up(context(contentsDir).ctx);
  const envelope = JSON.parse(
    await fs.readFile(path.join(contentsDir, 'store', 'chats', 'c1.json'), 'utf8')
  );
  assert.equal(envelope.v, 2);

  const other = await legacyInstall({ storage: { provider: 'postgres' } });
  assert.equal(await precondition(context(other).ctx), false);
});

test('a fresh install has nothing to upgrade', async () => {
  const contentsDir = await legacyInstall();
  const run = context(contentsDir);
  assert.equal(await precondition(run.ctx), true);
  await up(run.ctx);
  assert.ok(run.lines.some(line => /upgraded 0 /.test(line)));
});
