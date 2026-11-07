#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What a turn leaves on its user message as `attachments`: one descriptor per file the user
 * attached, with the size of the file (not the text and the original together).
 *
 * Run: node --test server/tests/chat-attachment-descriptors.test.js
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { FilesystemStorageProvider } from '../storage/index.js';
import { ChatFileRepository } from '../services/chatFiles/ChatFileRepository.js';
import { describeStored, prepareTurnFiles } from '../services/chatFiles/ChatFileService.js';
import { messageAttachments } from '../routes/chat/sessionRoutes.js';

const BYTES = Buffer.from('Quarterly numbers: 1, 2, 3\n');
const documentOf = ({ name = 'numbers.txt', bytes = null } = {}) => ({
  type: 'document',
  fileName: name,
  fileType: 'text/plain',
  content: BYTES.toString('utf8'),
  ...(bytes ? { base64: bytes.toString('base64') } : {})
});
const imageOf = name => ({
  type: 'image',
  fileName: name,
  fileType: 'image/png',
  fileSize: 5000,
  base64: 'data:image/png;base64,iVBORw0KGgo='
});
const audioOf = name => ({
  type: 'audio',
  fileName: name,
  fileType: 'audio/wav',
  fileSize: 90000,
  base64: 'data:audio/wav;base64,UklGRg=='
});

describe('the descriptors a turn leaves on its message', () => {
  let tmpDir;
  let provider;
  let repo;
  const turn = message =>
    prepareTurnFiles({
      chatId: 'chat-desc',
      ownerId: 'jonas',
      message: { role: 'user', content: 'go', ...message },
      store: repo
    });

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-att-desc-'));
    provider = new FilesystemStorageProvider({ baseDir: tmpDir });
    await provider.initialize();
    repo = new ChatFileRepository({ documents: provider.documents, blobs: provider.blobs });
  });

  afterEach(async () => {
    await provider?.shutdown?.();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('names a document, an image and an audio file once each', async () => {
    const { attachments } = await turn({
      fileData: documentOf(),
      imageData: imageOf('whiteboard.png'),
      audioData: audioOf('memo.wav')
    });
    assert.deepEqual(
      attachments.map(entry => entry.name),
      ['numbers.txt', 'whiteboard.png', 'memo.wav']
    );
  });

  it('names several images and audio files once each, in the order they were attached', async () => {
    const { attachments } = await turn({
      imageData: [imageOf('a.png'), imageOf('b.png')],
      audioData: [audioOf('one.wav'), audioOf('two.wav')]
    });
    assert.deepEqual(
      attachments.map(entry => entry.name),
      ['a.png', 'b.png', 'one.wav', 'two.wav']
    );
  });

  it('describes an image or audio file by its media type and size, without an id', async () => {
    const { attachments } = await turn({
      imageData: imageOf('a.png'),
      audioData: audioOf('one.wav')
    });
    assert.deepEqual(attachments, [
      { type: 'image/png', name: 'a.png', bytes: 5000 },
      { type: 'audio/wav', name: 'one.wav', bytes: 90000 }
    ]);
  });

  it('is the one list the route stores: images and audio are not added a second time', async () => {
    const message = {
      fileData: documentOf(),
      imageData: imageOf('a.png'),
      audioData: audioOf('b.wav')
    };
    const { attachments } = await turn(message);
    // The route stores this list as it is when it is not empty; it used to append the images and
    // audio of the message to it again
    assert.equal(attachments.length, messageAttachments(message).length);
  });

  it('gives a stored file the size of the file, not of its text and original together', async () => {
    const { attachments } = await turn({ fileData: documentOf({ bytes: BYTES }) });
    assert.equal(attachments[0].hasOriginal, true);
    assert.equal(attachments[0].bytes, BYTES.length);
  });

  it('gives a file kept as text only the size of its text', async () => {
    const { attachments } = await turn({ fileData: documentOf() });
    assert.equal(attachments[0].hasOriginal, undefined);
    assert.equal(attachments[0].bytes, BYTES.length);
  });
});

describe('describeStored', () => {
  const stored = { id: 'file_a', mimeType: 'application/pdf', name: 'a.pdf', bytes: 300 };

  it('shows the original size while the original is kept', () => {
    assert.equal(describeStored({ ...stored, hasOriginal: true, originalBytes: 200 }).bytes, 200);
  });

  it('shows the stored size once only the text is kept', () => {
    assert.equal(
      describeStored({ ...stored, hasOriginal: false, originalBytes: 0, bytes: 100 }).bytes,
      100
    );
  });

  it('falls back to the stored size when the original size is not known', () => {
    assert.equal(describeStored({ ...stored, hasOriginal: true }).bytes, 300);
  });
});
