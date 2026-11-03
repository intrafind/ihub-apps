#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Files of an Inference API user (scope `user`) have limits of their own
 * (`quotas.maxApiFiles` / `maxApiBytes`), apart from the per-chat ones.
 *
 * Run: node --test server/tests/chat-files-api-quota.test.js
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { FilesystemStorageProvider } from '../storage/index.js';
import { ChatFileRepository } from '../services/chatFiles/ChatFileRepository.js';
import { chatFileSettings, normalizeChatFilePolicy } from '../services/chatFiles/chatFilePolicy.js';
import { platformConfigSchema } from '../validators/platformConfigSchema.js';

describe('Inference API file quotas', () => {
  let tmpDir;
  let provider;
  let repo;
  const user = { type: 'user', id: 'api-user-1' };
  const chat = { type: 'chat', id: 'chat-api-quota' };
  const put = (scope, n, policy, text = 'x'.repeat(100)) =>
    repo.put(scope, { ownerId: 'u1', name: `f${n}.txt`, mimeType: 'text/plain', text, policy });

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-api-quota-'));
    provider = new FilesystemStorageProvider({ baseDir: tmpDir });
    await provider.initialize();
    repo = new ChatFileRepository({ documents: provider.documents, blobs: provider.blobs });
  });

  afterEach(async () => {
    await provider?.shutdown?.();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('defaults to 200 files and 1 GB, and the settings carry them', () => {
    const settings = chatFileSettings({});
    assert.equal(settings.quotas.maxApiFiles, 200);
    assert.equal(settings.quotas.maxApiBytes, 1024 * 1024 * 1024);
    assert.equal(
      chatFileSettings({ uploads: { quotas: { maxApiFiles: 0 } } }).quotas.maxApiFiles,
      0
    );
    assert.equal(normalizeChatFilePolicy({ maxApiFiles: 3 }).quotas.maxApiFiles, 3);
  });

  it('the platform schema accepts and defaults them', () => {
    const parsed = platformConfigSchema.parse({});
    assert.equal(parsed.uploads.quotas.maxApiFiles, 200);
    assert.equal(parsed.uploads.quotas.maxApiBytes, 1024 * 1024 * 1024);
  });

  it('limits the file count of a user scope by maxApiFiles, not maxChatFiles', async () => {
    const policy = { quotas: { maxChatFiles: 1, maxApiFiles: 3 } };
    for (let i = 0; i < 3; i += 1) await put(user, i, policy);
    await assert.rejects(put(user, 4, policy), error => {
      assert.equal(error.code, 'QUOTA_API_FILES');
      assert.equal(error.status, 413);
      return true;
    });
    // A chat still follows the per-chat limit.
    await put(chat, 1, policy);
    await assert.rejects(put(chat, 2, policy), error => error.code === 'QUOTA_CHAT_FILES');
  });

  it('limits the bytes of a user scope by maxApiBytes, not maxChatBytes', async () => {
    const policy = { quotas: { maxChatBytes: 10, maxApiBytes: 250 } };
    await put(user, 1, policy);
    await put(user, 2, policy);
    await assert.rejects(put(user, 3, policy), error => error.code === 'QUOTA_API_BYTES');
    await assert.rejects(put(chat, 1, policy), error => error.code === 'QUOTA_CHAT_BYTES');
  });

  it('0 removes the API limits', async () => {
    const policy = {
      quotas: { maxChatFiles: 1, maxChatBytes: 10, maxApiFiles: 0, maxApiBytes: 0 }
    };
    for (let i = 0; i < 5; i += 1) await put(user, i, policy);
    assert.equal((await repo.list(user)).length, 5);
  });
});
