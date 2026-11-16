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
import { ChatEvidenceRepository } from '../services/chat/ChatEvidenceRepository.js';

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

  it("counts a chat's evidence against a user upload, never against a file of an answer", async () => {
    const policy = { quotas: { maxChatBytes: 1000 } };
    const upload = n =>
      repo.put(chat, {
        ownerId: 'u1',
        name: `u${n}.txt`,
        mimeType: 'text/plain',
        text: 'x'.repeat(100),
        policy,
        countEvidence: true
      });
    await upload(1);
    const evidence = new ChatEvidenceRepository({
      documents: provider.documents,
      blobs: provider.blobs
    });
    await evidence.writeRecord(
      'chat',
      chat.id,
      { messageId: 'm1' },
      new Map([['b'.repeat(64), JSON.stringify('y'.repeat(900))]])
    );
    await assert.rejects(upload(2), error => error.code === 'QUOTA_CHAT_BYTES');
    // A file stored during an answer (tool output, MCP) is not checked against it.
    await put(chat, 3, policy);
    // Another chat is not charged for it.
    await put({ type: 'chat', id: 'other-chat' }, 1, policy);
  });

  it('refuses a user upload when the evidence usage cannot be read', async () => {
    repo._evidence.chatBytes = async () => {
      throw new Error('listing failed');
    };
    await assert.rejects(
      repo.put(chat, {
        ownerId: 'u1',
        name: 'u.txt',
        mimeType: 'text/plain',
        text: 'x',
        policy: { quotas: { maxChatBytes: 1000 } },
        countEvidence: true
      }),
      error => error.code === 'QUOTA_CHAT_BYTES'
    );
  });

  it('0 removes the API limits', async () => {
    const policy = {
      quotas: { maxChatFiles: 1, maxChatBytes: 10, maxApiFiles: 0, maxApiBytes: 0 }
    };
    for (let i = 0; i < 5; i += 1) await put(user, i, policy);
    assert.equal((await repo.list(user)).length, 5);
  });
});
