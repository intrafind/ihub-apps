#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The server-wide byte total is a counter document shared by every instance over
 * the same storage, so several instances enforce `maxServerBytes` together; an
 * exact recount heals a counter that drifted.
 *
 * Run: node --test server/tests/chat-files-shared-counter.test.js
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { FilesystemStorageProvider } from '../storage/index.js';
import { ChatFileRepository } from '../services/chatFiles/ChatFileRepository.js';

const COUNTER_KEY = '_meta__server-bytes';
const NS = 'chat-files';

describe('shared server-wide quota counter', () => {
  let tmpDir;
  let provider;
  let a;
  let b;
  const policy = maxServerBytes => ({ quotas: { maxServerBytes } });
  const put = (repo, n, text, limit) =>
    repo.put(
      { type: 'chat', id: `chat-cnt-${n}` },
      { ownerId: `u${n}`, name: `f${n}.txt`, mimeType: 'text/plain', text, policy: policy(limit) }
    );
  const counter = async () => (await provider.documents.get(NS, COUNTER_KEY))?.data;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-counter-'));
    provider = new FilesystemStorageProvider({ baseDir: tmpDir });
    await provider.initialize();
    a = new ChatFileRepository({ documents: provider.documents, blobs: provider.blobs });
    b = new ChatFileRepository({ documents: provider.documents, blobs: provider.blobs });
  });

  afterEach(async () => {
    await provider?.shutdown?.();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('two instances enforce one limit together', async () => {
    const limit = 1000;
    await put(a, 1, 'a'.repeat(400), limit);
    await put(b, 2, 'b'.repeat(400), limit);
    assert.equal((await counter()).serverBytes, 800);
    // 800 + 400 > 1000: refused whichever instance gets the upload.
    await assert.rejects(put(a, 3, 'c'.repeat(400), limit), e => e.code === 'QUOTA_SERVER_BYTES');
    await assert.rejects(put(b, 4, 'd'.repeat(400), limit), e => e.code === 'QUOTA_SERVER_BYTES');
  });

  it('a delete on one instance frees the space for the other', async () => {
    const limit = 1000;
    const first = await put(a, 1, 'a'.repeat(600), limit);
    await assert.rejects(put(b, 2, 'b'.repeat(600), limit), e => e.code === 'QUOTA_SERVER_BYTES');
    await a.delete({ type: 'chat', id: 'chat-cnt-1' }, first.id);
    assert.equal((await counter()).serverBytes, 0);
    assert.ok((await put(b, 2, 'b'.repeat(600), limit)).id);
    assert.equal((await counter()).serverBytes, 600);
  });

  it('deleteScope, discardOriginal and a replacing put keep the counter exact', async () => {
    const scope = { type: 'chat', id: 'chat-cnt-9' };
    const original = Buffer.from('o'.repeat(300));
    const withOriginal = await a.put(scope, {
      ownerId: 'u9',
      name: 'o.txt',
      mimeType: 'text/plain',
      text: 'text',
      originalBuffer: original,
      policy: policy(100000)
    });
    const total = (await counter()).serverBytes;
    assert.equal(total, 304);
    await b.discardOriginal(scope, withOriginal.id);
    assert.equal((await counter()).serverBytes, 4);
    await a.put(scope, {
      id: withOriginal.id,
      ownerId: 'u9',
      name: 'o.txt',
      mimeType: 'text/plain',
      text: 'text-longer',
      policy: policy(100000)
    });
    assert.equal((await counter()).serverBytes, 11);
    await b.deleteScope(scope);
    assert.equal((await counter()).serverBytes, 0);
  });

  it('concurrent writers lose no update (compare-and-set with retry)', async () => {
    await put(a, 0, 'seed', 1_000_000);
    await Promise.all(
      Array.from({ length: 12 }, (_, i) => put(i % 2 ? a : b, i + 1, 'x'.repeat(10), 1_000_000))
    );
    const docs = await a._listAllDocs();
    const real = docs.reduce((sum, doc) => sum + doc.data.bytes, 0);
    assert.equal((await counter()).serverBytes, real);
  });

  it('an exact recount heals a counter that drifted, and the counter is no file', async () => {
    const limit = 1000;
    await put(a, 1, 'a'.repeat(500), limit);
    await provider.documents.put(NS, COUNTER_KEY, {
      serverBytes: 0,
      recountedAt: new Date().toISOString()
    });
    // 0 + 300 stays below 90 % of the limit, so the stale zero is believed…
    assert.ok((await put(b, 2, 'b'.repeat(300), limit)).id);
    // …until an upload near the limit (300 + 650 > 900) makes the check exact and
    // rewrites the counter: really 800 bytes are stored, so 650 more do not fit.
    await assert.rejects(put(b, 3, 'c'.repeat(650), limit), e => e.code === 'QUOTA_SERVER_BYTES');
    assert.equal((await counter()).serverBytes, 800);
    const keys = (await a._listAllDocs()).map(doc => doc.key);
    assert.ok(!keys.includes(COUNTER_KEY));
  });

  it('an old counter is recounted on the next check', async () => {
    await put(a, 1, 'a'.repeat(100), 100000);
    await provider.documents.put(NS, COUNTER_KEY, {
      serverBytes: 5,
      recountedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString()
    });
    await put(b, 2, 'b'.repeat(50), 100000);
    assert.equal((await counter()).serverBytes, 150);
  });
});
