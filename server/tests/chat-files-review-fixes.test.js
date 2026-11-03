// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Review findings on the chat file pipeline: skills activated in earlier turns
 * survive history hydration, and the original bytes of an inline `fileData`
 * entry are stored only when they pass the same checks as an upload.
 *
 * Run: node --test server/tests/chat-files-review-fixes.test.js
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import configCache from '../configCache.js';
import { FilesystemStorageProvider } from '../storage/index.js';
import { ChatFileRepository } from '../services/chatFiles/ChatFileRepository.js';
import {
  hydrateHistoryForPrompt,
  prepareTurnFiles
} from '../services/chatFiles/ChatFileService.js';
import { historyForPrompt } from '../routes/chat/sessionRoutes.js';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

describe('chat file review fixes', () => {
  let tmpDir;
  let provider;
  let repo;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-chat-files-review-'));
    provider = new FilesystemStorageProvider({ baseDir: tmpDir });
    await provider.initialize();
    repo = new ChatFileRepository({ documents: provider.documents, blobs: provider.blobs });
    configCache.setCacheEntry('config/platform.json', {});
  });

  afterEach(async () => {
    configCache.setCacheEntry('config/platform.json', {});
    await provider?.shutdown?.();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('keeps the skills an earlier answer activated when the history comes from the file store', async () => {
    const hydrated = await hydrateHistoryForPrompt(
      'chat-skills',
      [
        { role: 'user', content: 'make a deck' },
        {
          role: 'assistant',
          content: 'done',
          activity: { activeSkills: [{ id: 'pptx', name: 'PowerPoint' }] }
        }
      ],
      { store: repo }
    );
    const history = historyForPrompt(hydrated);
    assert.deepEqual(history[1].activeSkills, [{ id: 'pptx', name: 'PowerPoint' }]);
    // The stored shape still works.
    assert.deepEqual(
      historyForPrompt([
        { role: 'assistant', content: 'x', activity: { activeSkills: [{ id: 'docx' }] } }
      ])[0].activeSkills,
      [{ id: 'docx' }]
    );
  });

  const inline = (overrides = {}) => ({
    type: 'document',
    fileName: 'letter.docx',
    fileType: DOCX,
    content: 'Dear customer',
    base64: Buffer.from('PK-docx-bytes').toString('base64'),
    ...overrides
  });

  async function store(fileData) {
    const { attachments } = await prepareTurnFiles({
      chatId: 'chat-inline',
      ownerId: 'ada',
      message: { role: 'user', content: 'x', fileData },
      store: repo
    });
    return attachments[0];
  }

  it('stores the original of an inline file of a supported type', async () => {
    const stored = await store(inline());
    assert.equal(stored.hasOriginal, true);
    assert.equal(stored.canUseAsTemplate, true);
  });

  it('accepts a base64 data URL payload', async () => {
    const stored = await store(
      inline({ base64: `data:${DOCX};base64,${Buffer.from('PK-docx-bytes').toString('base64')}` })
    );
    assert.equal(stored.hasOriginal, true);
    const original = await repo.getOriginal({ type: 'chat', id: 'chat-inline' }, stored.id);
    assert.equal(original.data.toString(), 'PK-docx-bytes');
  });

  it('keeps only the text when the bytes are of a type the extraction does not know', async () => {
    const stored = await store(
      inline({
        fileName: 'setup.exe',
        fileType: 'application/x-msdownload',
        content: 'readable text'
      })
    );
    assert.equal(stored.hasOriginal, undefined);
    const text = await repo.getText({ type: 'chat', id: 'chat-inline' }, stored.id);
    assert.equal(text.text, 'readable text');
    assert.equal(text.hasOriginal, false);
  });

  it('keeps only the text when the bytes exceed the file size limit', async () => {
    configCache.setCacheEntry('config/platform.json', { uploads: { quotas: { maxFileBytes: 5 } } });
    const stored = await store(inline());
    assert.equal(stored.hasOriginal, undefined);
  });

  it('ignores an empty or invalid base64 payload', async () => {
    assert.equal((await store(inline({ base64: '' }))).hasOriginal, undefined);
  });
});
