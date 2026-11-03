// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { FilesystemStorageProvider } from '../storage/index.js';
import {
  chatFilePolicy,
  chatFileSettings,
  canUseFileAsTemplate,
  uploadsClientConfig
} from '../services/chatFiles/chatFilePolicy.js';
import { ChatFileRepository } from '../services/chatFiles/ChatFileRepository.js';
import {
  ingestChatFile,
  prepareTurnFiles,
  hydrateHistoryForPrompt
} from '../services/chatFiles/ChatFileService.js';
import { ChatRepository } from '../services/chat/ChatRepository.js';
import { ChatShareRepository } from '../services/chat/ChatShareRepository.js';
import { sweepChats } from '../services/chat/chatRetention.js';
import { historyForPrompt } from '../routes/chat/sessionRoutes.js';
import { renderUserMessage } from '../../shared/promptContext.js';

describe('Durable Chat & Task Files (Slice 1)', () => {
  let tmpDir;
  let provider;
  let fileRepo;
  let chatRepo;
  let shareRepo;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-chat-files-test-'));
    provider = new FilesystemStorageProvider({ baseDir: tmpDir });
    await provider.initialize();
    fileRepo = new ChatFileRepository({
      documents: provider.documents,
      blobs: provider.blobs
    });
    shareRepo = new ChatShareRepository({
      documents: provider.documents,
      locks: provider.locks
    });
    chatRepo = new ChatRepository({
      documents: provider.documents,
      locks: provider.locks,
      files: fileRepo,
      shares: shareRepo
    });
  });

  afterEach(async () => {
    await provider?.shutdown?.();
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  describe('chatFilePolicy & settings', () => {
    it('resolves default storageMode and allows per-App overrides', () => {
      const defaults = chatFileSettings({});
      assert.equal(defaults.enabled, true);
      assert.equal(defaults.storageMode, 'original_and_text');
      assert.equal(defaults.originalRetentionDays, 14);

      const appOverride = chatFileSettings(
        { uploads: { storageMode: 'original_and_text' } },
        { uploads: { storageMode: 'client_text_only' } }
      );
      assert.equal(appOverride.storageMode, 'client_text_only');

      const clientCfg = uploadsClientConfig(
        { uploads: { storageMode: 'server_text_only', originalRetentionDays: 7 } },
        { storageAvailable: true }
      );
      assert.equal(clientCfg.enabled, true);
      assert.equal(clientCfg.storageMode, 'server_text_only');
      assert.equal(clientCfg.originalRetentionDays, 7);
    });

    it('marks template-capable formats only when original binary is retained', () => {
      assert.equal(
        canUseFileAsTemplate({
          name: 'Master.docx',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          hasOriginal: true
        }),
        true
      );
      assert.equal(
        canUseFileAsTemplate({
          name: 'Master.docx',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          hasOriginal: false
        }),
        false
      );
      assert.equal(
        canUseFileAsTemplate({
          name: 'notes.txt',
          mimeType: 'text/plain',
          hasOriginal: true
        }),
        false
      );
    });
  });

  describe('Storage modes (original_and_text, server_text_only, client_text_only)', () => {
    const scope = { type: 'chat', id: 'chat-modes-1' };

    it('stores both original binary and extracted text in original_and_text mode', async () => {
      const policy = { ...chatFilePolicy(), storageMode: 'original_and_text' };
      const rawBuffer = Buffer.from('# Quarterly Report\n\nRevenue grew by 18%.', 'utf8');

      const descriptor = await ingestChatFile({
        scope,
        ownerId: 'user-1',
        name: 'report.md',
        mimeType: 'text/markdown',
        buffer: rawBuffer,
        policy,
        store: fileRepo
      });

      assert.ok(descriptor.id.startsWith('file_'));
      assert.equal(descriptor.hasOriginal, true);
      assert.equal(descriptor.originalBytes, rawBuffer.length);
      assert.ok(descriptor.extractedBytes > 0);

      const original = await fileRepo.getOriginal(scope, descriptor.id);
      assert.equal(original.discarded, false);
      assert.deepEqual(original.data, rawBuffer);

      const textResult = await fileRepo.getText(scope, descriptor.id);
      assert.match(textResult.text, /Quarterly Report/);
      assert.match(textResult.text, /Revenue grew by 18%/);
    });

    it('extracts text on the server and discards original binary in server_text_only mode', async () => {
      const policy = { ...chatFilePolicy(), storageMode: 'server_text_only' };
      const rawBuffer = Buffer.from('Confidential contract clauses', 'utf8');

      const descriptor = await ingestChatFile({
        scope,
        ownerId: 'user-1',
        name: 'contract.txt',
        mimeType: 'text/plain',
        buffer: rawBuffer,
        policy,
        store: fileRepo
      });

      assert.equal(descriptor.hasOriginal, false);
      assert.equal(descriptor.originalDeletedReason, 'storage_mode');

      const original = await fileRepo.getOriginal(scope, descriptor.id);
      assert.equal(original.discarded, true);

      const textResult = await fileRepo.getText(scope, descriptor.id);
      assert.equal(textResult.text, 'Confidential contract clauses');
    });

    it('rejects binary uploads and accepts pre-extracted text in client_text_only mode', async () => {
      const policy = { ...chatFilePolicy(), storageMode: 'client_text_only' };

      await assert.rejects(
        () =>
          ingestChatFile({
            scope,
            ownerId: 'user-1',
            name: 'contract.txt',
            mimeType: 'text/plain',
            buffer: Buffer.from('raw bytes', 'utf8'),
            policy,
            store: fileRepo
          }),
        err => err.code === 'BINARY_UPLOAD_NOT_ALLOWED'
      );

      const descriptor = await ingestChatFile({
        scope,
        ownerId: 'user-1',
        name: 'client-extracted.pdf',
        mimeType: 'application/pdf',
        text: 'Extracted on the client in browser memory',
        pages: 3,
        policy,
        store: fileRepo
      });

      assert.equal(descriptor.hasOriginal, false);
      assert.equal(descriptor.pages, 3);
      const textResult = await fileRepo.getText(scope, descriptor.id);
      assert.equal(textResult.text, 'Extracted on the client in browser memory');
    });

    it('stores and re-hydrates pageImages for scanned PDFs without extractable text', async () => {
      const policy = { ...chatFilePolicy(), storageMode: 'client_text_only' };
      const fakePageBase64 = Buffer.from('fake-jpeg-bytes').toString('base64');

      const descriptor = await ingestChatFile({
        scope,
        ownerId: 'user-1',
        name: 'scanned.pdf',
        mimeType: 'application/pdf',
        text: '',
        pageImages: [fakePageBase64],
        pages: 1,
        policy,
        store: fileRepo
      });

      assert.equal(descriptor.hasPageImages, true);
      const textResult = await fileRepo.getText(scope, descriptor.id);
      assert.deepEqual(textResult.pageImages, [fakePageBase64]);
    });
  });

  describe('3-tier quotas and automatic LRU eviction of old chat originals', () => {
    it('enforces per-file, per-chat count, and per-chat byte limits', async () => {
      const scope = { type: 'chat', id: 'chat-quota-1' };
      const basePolicy = {
        ...chatFilePolicy(),
        maxFileBytes: 100,
        maxChatFiles: 2,
        maxChatBytes: 150
      };

      await assert.rejects(
        () =>
          fileRepo.put({
            scope,
            ownerId: 'user-1',
            name: 'huge.txt',
            mimeType: 'text/plain',
            text: 'x'.repeat(120),
            policy: basePolicy
          }),
        err => err.code === 'QUOTA_FILE_BYTES'
      );

      await fileRepo.put({
        scope,
        ownerId: 'user-1',
        name: 'first.txt',
        mimeType: 'text/plain',
        text: 'a'.repeat(80),
        policy: basePolicy
      });

      await assert.rejects(
        () =>
          fileRepo.put({
            scope,
            ownerId: 'user-1',
            name: 'second-too-big-for-chat.txt',
            mimeType: 'text/plain',
            text: 'b'.repeat(80),
            policy: basePolicy
          }),
        err => err.code === 'QUOTA_CHAT_BYTES'
      );

      await fileRepo.put({
        scope,
        ownerId: 'user-1',
        name: 'second-small.txt',
        mimeType: 'text/plain',
        text: 'b'.repeat(40),
        policy: basePolicy
      });

      await assert.rejects(
        () =>
          fileRepo.put({
            scope,
            ownerId: 'user-1',
            name: 'third.txt',
            mimeType: 'text/plain',
            text: 'c'.repeat(10),
            policy: basePolicy
          }),
        err => err.code === 'QUOTA_CHAT_FILES'
      );
    });

    it('evicts oldest chat original binaries when user quota is reached while preserving task originals and extracted text', async () => {
      const taskScope = { type: 'task', id: 'task-pinned-1' };
      const oldChatScope = { type: 'chat', id: 'chat-old-1' };
      const newChatScope = { type: 'chat', id: 'chat-new-1' };

      const policy = {
        ...chatFilePolicy(),
        maxFileBytes: 1000,
        maxChatFiles: 10,
        maxChatBytes: 1000,
        maxUserBytes: 250,
        maxServerBytes: 1000
      };

      // 1. Pinned task file (80B original + 10B text = 90B) — must NEVER be evicted
      const taskFile = await fileRepo.put({
        scope: taskScope,
        ownerId: 'user-1',
        name: 'task-template.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        originalData: Buffer.alloc(80, 0x41),
        text: '0123456789',
        now: '2026-10-01T00:00:00.000Z',
        policy
      });

      // 2. Old chat file (100B original + 10B text = 110B; total user bytes = 200B)
      const oldChatFile = await fileRepo.put({
        scope: oldChatScope,
        ownerId: 'user-1',
        name: 'old-report.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        originalData: Buffer.alloc(100, 0x42),
        text: 'abcdefghij',
        now: '2026-10-02T00:00:00.000Z',
        policy
      });

      // 3. New chat file (100B original + 10B text = 110B; would push user to 310B > 250B).
      // Evicting oldChatFile's 100B original brings user bytes down to 100B + 110B = 210B <= 250B!
      const newChatFile = await fileRepo.put({
        scope: newChatScope,
        ownerId: 'user-1',
        name: 'new-report.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        originalData: Buffer.alloc(100, 0x43),
        text: 'klmnopqrst',
        now: '2026-10-03T00:00:00.000Z',
        policy
      });

      assert.equal(newChatFile.hasOriginal, true);

      // Old chat file lost its original binary but kept its extracted text!
      const oldOriginal = await fileRepo.getOriginal(oldChatScope, oldChatFile.id);
      assert.equal(oldOriginal.discarded, true);
      const oldDesc = await fileRepo.getDescriptor(oldChatScope, oldChatFile.id);
      assert.equal(oldDesc.hasOriginal, false);
      assert.equal(oldDesc.originalDeletedReason, 'quota_evicted');
      const oldText = await fileRepo.getText(oldChatScope, oldChatFile.id);
      assert.equal(oldText.text, 'abcdefghij');

      // Task file kept its original binary!
      const taskOriginal = await fileRepo.getOriginal(taskScope, taskFile.id);
      assert.equal(taskOriginal.discarded, false);
      assert.equal(taskOriginal.data.length, 80);
    });
  });

  describe('Independent TTL for original binaries vs extracted text', () => {
    it('discards expired chat original binaries while keeping extracted text and task originals', async () => {
      const chatScope = { type: 'chat', id: 'chat-ttl-1' };
      const taskScope = { type: 'task', id: 'task-ttl-1' };
      const policy = chatFilePolicy();

      const twentyDaysAgo = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();

      const chatFile = await fileRepo.put({
        scope: chatScope,
        ownerId: 'user-1',
        name: 'aged.pdf',
        mimeType: 'application/pdf',
        originalData: Buffer.from('%PDF-1.4 aged binary'),
        text: 'Aged PDF text remains available for multi-turn chat',
        now: twentyDaysAgo,
        policy
      });

      const taskFile = await fileRepo.put({
        scope: taskScope,
        ownerId: 'user-1',
        name: 'aged-task.pdf',
        mimeType: 'application/pdf',
        originalData: Buffer.from('%PDF-1.4 task binary'),
        text: 'Task PDF text',
        now: twentyDaysAgo,
        policy
      });

      await sweepChats({
        repository: chatRepo,
        retentionDays: 90,
        maxChatsPerUser: 200,
        originalRetentionDays: 14
      });

      const chatOriginal = await fileRepo.getOriginal(chatScope, chatFile.id);
      assert.equal(chatOriginal.discarded, true);

      const chatText = await fileRepo.getText(chatScope, chatFile.id);
      assert.equal(chatText.text, 'Aged PDF text remains available for multi-turn chat');

      const taskOriginal = await fileRepo.getOriginal(taskScope, taskFile.id);
      assert.equal(taskOriginal.discarded, false);
      assert.equal(taskOriginal.data.toString('utf8'), '%PDF-1.4 task binary');
    });
  });

  describe('Multi-turn prompt hydration, regenerate inheritance, and edit/delete cascade', () => {
    it('persists Turn 1 inline fileData, re-hydrates it on Turn 2, and cleans up on message edit or chat delete', async () => {
      const chatId = 'chat-multiturn-1';
      const ownerId = 'user-1';

      await chatRepo.ensureChat({
        chatId,
        ownerId,
        identityMode: 'default',
        title: 'Contract Review'
      });

      // Turn 1: user sends inline fileData
      const turn1Input = {
        role: 'user',
        content: 'Please summarize this agreement.',
        fileData: {
          fileName: 'agreement.txt',
          fileType: 'text/plain',
          fileSize: 42,
          content: 'Section 1: Payment terms are net 30 days.'
        }
      };

      const turn1Prepared = await prepareTurnFiles({
        chatId,
        ownerId,
        message: turn1Input,
        store: fileRepo
      });

      assert.equal(turn1Prepared.attachments.length, 1);
      const fileId1 = turn1Prepared.attachments[0].id;
      assert.ok(fileId1.startsWith('file_'));

      // Append Turn 1 user message + assistant reply to ChatRepository
      const appendedUser1 = await chatRepo.appendMessage(chatId, {
        role: 'user',
        content: turn1Input.content,
        attachments: turn1Prepared.attachments
      });
      await chatRepo.appendMessage(chatId, {
        role: 'assistant',
        content: 'The payment terms are net 30 days.'
      });

      // Turn 2: follow-up question without re-uploading the file
      const storedBeforeTurn2 = await chatRepo.getMessages(chatId);
      const hydratedHistory = await hydrateHistoryForPrompt(chatId, storedBeforeTurn2.messages, {
        store: fileRepo
      });
      const promptHistory = historyForPrompt(hydratedHistory);
      assert.equal(promptHistory.length, 2);
      assert.equal(Array.isArray(promptHistory[0].fileData), true);
      assert.equal(promptHistory[0].fileData[0].id, fileId1);
      assert.equal(
        promptHistory[0].fileData[0].content,
        'Section 1: Payment terms are net 30 days.'
      );

      // Verify renderUserMessage includes id="..." on the <content type="document"> tag
      const renderedTurn1 = renderUserMessage({
        content: promptHistory[0].content,
        files: promptHistory[0].fileData
      });
      assert.match(
        renderedTurn1,
        new RegExp(`<content type="document" origin="upload" id="${fileId1}" name="agreement\\.txt"`)
      );

      // Regenerate Turn 1 (replaceFromMessageId without new fileData): inherits fileId1 and does NOT delete it
      const regenPrepared = await prepareTurnFiles({
        chatId,
        ownerId,
        message: { role: 'user', content: 'Please summarize this agreement in detail.' },
        inheritedAttachments: appendedUser1.message.attachments,
        store: fileRepo
      });
      assert.equal(regenPrepared.attachments.length, 1);
      assert.equal(regenPrepared.attachments[0].id, fileId1);

      const regenAppended = await chatRepo.appendMessage(
        chatId,
        {
          role: 'user',
          content: 'Please summarize this agreement in detail.',
          attachments: regenPrepared.attachments
        },
        { replaceFromMessageId: appendedUser1.message.id }
      );
      assert.ok(await fileRepo.getDescriptor({ type: 'chat', id: chatId }, fileId1));

      // Edit Turn 1 with a brand-new file: fileId1 is now orphaned and automatically deleted!
      const editInput = {
        role: 'user',
        content: 'Actually, review this addendum instead.',
        fileData: {
          fileName: 'addendum.txt',
          fileType: 'text/plain',
          fileSize: 28,
          content: 'Addendum: Net 60 days.'
        }
      };
      const editPrepared = await prepareTurnFiles({
        chatId,
        ownerId,
        message: editInput,
        inheritedAttachments: regenAppended.message.attachments,
        store: fileRepo
      });
      const fileId2 = editPrepared.attachments[0].id;
      assert.notEqual(fileId2, fileId1);

      await chatRepo.appendMessage(
        chatId,
        {
          role: 'user',
          content: editInput.content,
          attachments: editPrepared.attachments
        },
        { replaceFromMessageId: regenAppended.message.id }
      );

      // fileId1 was detached by the edit and removed from ChatFileRepository
      assert.equal(await fileRepo.getDescriptor({ type: 'chat', id: chatId }, fileId1), null);
      // fileId2 is present
      assert.ok(await fileRepo.getDescriptor({ type: 'chat', id: chatId }, fileId2));

      // Deleting the chat removes fileId2 as well
      await chatRepo.deleteChat(chatId);
      assert.equal(await fileRepo.getDescriptor({ type: 'chat', id: chatId }, fileId2), null);
    });
  });
});
