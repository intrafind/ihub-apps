#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * An e-mail attachment sent with every turn is stored once per chat: same name and
 * same content (sha256 of the original bytes, else of the text). A copy stored
 * without its original is upgraded when a later turn carries the bytes.
 *
 * Run: node --test server/tests/chat-files-attachment-dedupe.test.js
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { FilesystemStorageProvider } from '../storage/index.js';
import { ChatFileRepository } from '../services/chatFiles/ChatFileRepository.js';
import { prepareTurnFiles } from '../services/chatFiles/ChatFileService.js';

const BYTES = Buffer.from('Quarterly numbers: 1, 2, 3\n');
const attachment = ({
  name = 'numbers.txt',
  content = BYTES.toString('utf8'),
  bytes = null
} = {}) => ({
  type: 'document',
  origin: 'attachment',
  fileName: name,
  fileType: 'text/plain',
  content,
  ...(bytes ? { base64: bytes.toString('base64') } : {})
});

describe('prepareTurnFiles — e-mail attachment dedupe', () => {
  let tmpDir;
  let provider;
  let repo;
  const scope = { type: 'chat', id: 'chat-att' };
  const turn = fileData =>
    prepareTurnFiles({
      chatId: scope.id,
      ownerId: 'jonas',
      message: { role: 'user', content: 'go', fileData },
      store: repo
    });

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-att-dedupe-'));
    provider = new FilesystemStorageProvider({ baseDir: tmpDir });
    await provider.initialize();
    repo = new ChatFileRepository({ documents: provider.documents, blobs: provider.blobs });
  });

  afterEach(async () => {
    await provider?.shutdown?.();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('stores a text-only attachment once across turns', async () => {
    const first = await turn([attachment()]);
    const second = await turn([attachment()]);
    assert.equal((await repo.list(scope)).length, 1);
    assert.equal(first.attachments[0].id, second.attachments[0].id);
    assert.equal(second.promptMessage.fileData.origin, 'attachment');
  });

  it('stores an attachment with original bytes once across turns', async () => {
    const first = await turn([attachment({ bytes: BYTES })]);
    const second = await turn([attachment({ bytes: BYTES })]);
    const items = await repo.list(scope);
    assert.equal(items.length, 1);
    assert.equal(items[0].hasOriginal, true);
    assert.equal(first.attachments[0].id, second.attachments[0].id);
  });

  it('upgrades a text-only copy when a later turn carries the original', async () => {
    const first = await turn([attachment()]);
    assert.equal((await repo.list(scope))[0].hasOriginal, false);
    const second = await turn([attachment({ bytes: BYTES })]);
    const items = await repo.list(scope);
    assert.equal(items.length, 1);
    assert.equal(items[0].hasOriginal, true);
    assert.equal(first.attachments[0].id, second.attachments[0].id);
    const original = await repo.getOriginal(scope, items[0].id);
    assert.deepEqual(Buffer.from(original.data), BYTES);
  });

  it('keeps an original it already has when the new turn sends text only', async () => {
    await turn([attachment({ bytes: BYTES })]);
    await turn([attachment()]);
    const items = await repo.list(scope);
    assert.equal(items.length, 1);
    assert.equal(items[0].hasOriginal, true);
  });

  it('stores different content or a different name separately', async () => {
    await turn([attachment()]);
    await turn([attachment({ content: 'other text' })]);
    await turn([attachment({ name: 'copy.txt' })]);
    assert.equal((await repo.list(scope)).length, 3);
  });
});
