#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A picture the user attached is kept (as it was sent to the model) so its thumbnail survives
 * a reload: stored as a chat file of origin `image`, only when the bytes really are a raster
 * image, under the same policy as any original, and never a document for the model.
 *
 * Run: node --test server/tests/chat-turn-images.test.js
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { FilesystemStorageProvider } from '../storage/index.js';
import { ChatFileRepository } from '../services/chatFiles/ChatFileRepository.js';
import {
  hydrateHistoryForPrompt,
  prepareTurnFiles
} from '../services/chatFiles/ChatFileService.js';
import { decodeRasterDataUrl, sniffRasterImage } from '../services/chatFiles/rasterImage.js';
import { normalizeAttachments } from '../services/chat/chatMaterializer.js';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(40, 7)
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 3)]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(40, 1)]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.alloc(4),
  Buffer.from('WEBP'),
  Buffer.alloc(20)
]);
const BMP = Buffer.concat([Buffer.from('BM'), Buffer.alloc(40, 2)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>');

const dataUrl = (bytes, mime = 'image/png') => `data:${mime};base64,${bytes.toString('base64')}`;
const imageOf = (bytes, { name = 'whiteboard.png', mime = 'image/png' } = {}) => ({
  type: 'image',
  fileName: name,
  fileType: mime,
  fileSize: bytes.length,
  base64: dataUrl(bytes, mime)
});

describe('the raster images the server accepts', () => {
  it('knows PNG, JPEG, GIF, WebP and BMP by their bytes', () => {
    assert.equal(sniffRasterImage(PNG), 'image/png');
    assert.equal(sniffRasterImage(JPEG), 'image/jpeg');
    assert.equal(sniffRasterImage(GIF), 'image/gif');
    assert.equal(sniffRasterImage(WEBP), 'image/webp');
    assert.equal(sniffRasterImage(BMP), 'image/bmp');
  });

  it('refuses SVG, text and anything that is not a buffer', () => {
    assert.equal(sniffRasterImage(SVG), null);
    assert.equal(sniffRasterImage(Buffer.from('hello')), null);
    assert.equal(sniffRasterImage(Buffer.alloc(0)), null);
    assert.equal(sniffRasterImage('PNG'), null);
    assert.equal(sniffRasterImage(null), null);
  });

  it('reads the type from the bytes, not from what the data URL says', () => {
    assert.equal(decodeRasterDataUrl(dataUrl(PNG, 'image/jpeg'))?.mimeType, 'image/png');
  });

  it('refuses an SVG, whatever it is declared as, and a data URL that is not base64 image data', () => {
    assert.equal(decodeRasterDataUrl(dataUrl(SVG, 'image/svg+xml')), null);
    assert.equal(decodeRasterDataUrl(dataUrl(SVG, 'image/png')), null);
    assert.equal(decodeRasterDataUrl(`data:text/html;base64,${SVG.toString('base64')}`), null);
    assert.equal(decodeRasterDataUrl('data:image/png;charset=utf-8,abc'), null);
    assert.equal(decodeRasterDataUrl('https://example.com/a.png'), null);
    assert.equal(decodeRasterDataUrl(undefined), null);
  });
});

describe('a picture of a turn', () => {
  let tmpDir;
  let provider;
  let repo;
  const scope = { type: 'chat', id: 'chat-img' };
  const turn = (message, extra = {}) =>
    prepareTurnFiles({
      chatId: scope.id,
      ownerId: 'jonas',
      message: { role: 'user', content: 'what is this', ...message },
      store: repo,
      ...extra
    });

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-turn-img-'));
    provider = new FilesystemStorageProvider({ baseDir: tmpDir });
    await provider.initialize();
    repo = new ChatFileRepository({ documents: provider.documents, blobs: provider.blobs });
  });

  afterEach(async () => {
    await provider?.shutdown?.();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('is stored as it was sent, and its descriptor can open it', async () => {
    const { attachments } = await turn({ imageData: imageOf(PNG) });
    assert.equal(attachments.length, 1);
    const [descriptor] = attachments;
    assert.match(descriptor.id, /^file_/);
    assert.deepEqual(
      { ...descriptor, id: undefined },
      {
        id: undefined,
        type: 'image/png',
        name: 'whiteboard.png',
        bytes: PNG.length,
        origin: 'image',
        hasOriginal: true
      }
    );
    const original = await repo.getOriginal(scope, descriptor.id);
    assert.deepEqual(original.data, PNG);
    assert.equal(original.mimeType, 'image/png');
  });

  it('survives the store: the materializer keeps what a card needs to fetch it', () => {
    const [kept] = normalizeAttachments([
      {
        id: 'file_a',
        type: 'image/png',
        name: 'a.png',
        bytes: 40,
        origin: 'image',
        hasOriginal: true
      }
    ]);
    assert.equal(kept.id, 'file_a');
    assert.equal(kept.type, 'image/png');
    assert.equal(kept.hasOriginal, true);
  });

  it('says the size of the file the user attached, not of the smaller picture it stored', async () => {
    const { attachments } = await turn({ imageData: { ...imageOf(PNG), fileSize: 33000 } });
    assert.equal(attachments[0].bytes, 33000);
    const stored = await repo.getDescriptor(scope, attachments[0].id);
    assert.equal(stored.bytes, PNG.length);
  });

  it('stores several pictures, each once, in the order attached', async () => {
    const { attachments } = await turn({
      imageData: [
        imageOf(PNG, { name: 'a.png' }),
        imageOf(JPEG, { name: 'b.jpg', mime: 'image/jpeg' })
      ]
    });
    assert.deepEqual(
      attachments.map(entry => [entry.name, entry.type]),
      [
        ['a.png', 'image/png'],
        ['b.jpg', 'image/jpeg']
      ]
    );
    assert.equal((await repo.list(scope)).length, 2);
  });

  it('is not stored twice when the same picture is sent again', async () => {
    const first = await turn({ imageData: imageOf(PNG) });
    const again = await turn({ imageData: imageOf(PNG) });
    assert.equal(again.attachments[0].id, first.attachments[0].id);
    assert.equal((await repo.list(scope)).length, 1);
  });

  it('is two files when the content differs, or when only the name does', async () => {
    await turn({ imageData: imageOf(PNG) });
    await turn({ imageData: imageOf(JPEG, { mime: 'image/jpeg' }) });
    await turn({ imageData: imageOf(PNG, { name: 'renamed.png' }) });
    assert.equal((await repo.list(scope)).length, 3);
  });

  it('is described as the client said when it is not a raster image, and not stored', async () => {
    const { attachments } = await turn({
      imageData: imageOf(SVG, { name: 'x.svg', mime: 'image/svg+xml' })
    });
    assert.deepEqual(attachments, [{ type: 'image/svg+xml', name: 'x.svg', bytes: SVG.length }]);
    assert.equal((await repo.list(scope)).length, 0);
  });

  it('is not stored when the app keeps no originals, and still described', async () => {
    const { attachments } = await turn(
      { imageData: imageOf(PNG) },
      { appConfig: { uploads: { storageMode: 'server_text_only' } } }
    );
    assert.equal(attachments.length, 1);
    assert.equal(attachments[0].id, undefined);
    assert.equal(attachments[0].name, 'whiteboard.png');
    assert.equal((await repo.list(scope)).length, 0);
  });

  it('is not stored in client text only mode either', async () => {
    await turn(
      { imageData: imageOf(PNG) },
      { appConfig: { uploads: { storageMode: 'client_text_only' } } }
    );
    assert.equal((await repo.list(scope)).length, 0);
  });

  it('does not stop the message when a quota refuses it', async () => {
    const tight = new ChatFileRepository({
      documents: provider.documents,
      blobs: provider.blobs,
      policy: () => ({ quotas: { maxChatBytes: 10 } })
    });
    const { attachments } = await prepareTurnFiles({
      chatId: scope.id,
      ownerId: 'jonas',
      message: { role: 'user', content: 'x', imageData: imageOf(PNG) },
      store: tight
    });
    assert.equal(attachments.length, 1);
    assert.equal(attachments[0].id, undefined);
    assert.equal((await tight.list(scope)).length, 0);
  });

  it('counts against the bytes of a chat, not against its file slots', async () => {
    const roomForOne = new ChatFileRepository({
      documents: provider.documents,
      blobs: provider.blobs,
      policy: () => ({ quotas: { maxChatFiles: 1 } })
    });
    const send = message =>
      prepareTurnFiles({
        chatId: scope.id,
        ownerId: 'jonas',
        message: { role: 'user', content: 'x', ...message },
        store: roomForOne
      });
    for (const name of ['a.png', 'b.png', 'c.png']) {
      const unique = Buffer.concat([PNG, Buffer.from(name)]);
      const { attachments } = await send({ imageData: imageOf(unique, { name }) });
      assert.match(attachments[0].id, /^file_/, `${name} was stored`);
    }
    // The one slot of the chat is still free for a document
    const document = await send({
      fileData: {
        type: 'document',
        fileName: 'notes.txt',
        fileType: 'text/plain',
        content: 'Quarterly numbers'
      }
    });
    assert.match(document.attachments[0].id, /^file_/);
    assert.equal((await roomForOne.list(scope)).length, 4);
  });

  it('is never a document for the model: a regenerated turn keeps the card, not a prompt file', async () => {
    const first = await turn({ imageData: imageOf(PNG) });
    const regenerated = await turn(
      { content: 'again' },
      { inheritedAttachments: first.attachments }
    );
    assert.equal(regenerated.attachments.length, 1);
    assert.equal(regenerated.attachments[0].id, first.attachments[0].id);
    assert.equal(regenerated.promptMessage.fileData, undefined);
  });

  it('is not repeated as a document in the history of later turns', async () => {
    const first = await turn({ imageData: imageOf(PNG) });
    const history = await hydrateHistoryForPrompt(
      scope.id,
      [
        { role: 'user', content: 'what is this', attachments: first.attachments },
        { role: 'assistant', content: 'A whiteboard' }
      ],
      { store: repo }
    );
    assert.equal(history.length, 2);
    assert.equal(history[0].fileData, undefined);
  });

  it('is sent again after a regenerate without being stored twice', async () => {
    const first = await turn({ imageData: imageOf(PNG) });
    const again = await turn(
      { content: 'again', imageData: imageOf(PNG) },
      { inheritedAttachments: first.attachments }
    );
    assert.equal(again.attachments.length, 1);
    assert.equal((await repo.list(scope)).length, 1);
  });
});

describe('only a picture is stored as a picture', () => {
  let tmpDir;
  let provider;
  let repo;
  const scope = { type: 'chat', id: 'chat-img-origin' };
  const oneSlot = () => ({ quotas: { maxChatFiles: 1 } });

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-turn-img-origin-'));
    provider = new FilesystemStorageProvider({ baseDir: tmpDir });
    await provider.initialize();
    repo = new ChatFileRepository({
      documents: provider.documents,
      blobs: provider.blobs,
      policy: oneSlot
    });
  });

  afterEach(async () => {
    await provider?.shutdown?.();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const put = file =>
    repo.put(scope, { ownerId: 'jonas', mimeType: 'text/plain', origin: 'image', ...file });

  it('a document that asks for the image origin is an ordinary upload and takes a slot', async () => {
    const first = await put({ name: 'a.txt', text: 'Quarterly numbers' });
    assert.equal(first.origin, 'upload');
    await assert.rejects(
      put({ name: 'b.txt', text: 'More numbers' }),
      error => error.code === 'QUOTA_CHAT_FILES'
    );
  });

  it('is an ordinary upload when it holds text next to the picture', async () => {
    const stored = await put({
      name: 'a.png',
      mimeType: 'image/png',
      text: 'caption',
      originalBuffer: PNG
    });
    assert.equal(stored.origin, 'upload');
  });

  it('is an ordinary upload when the bytes are not a raster image', async () => {
    const stored = await put({ name: 'x.png', mimeType: 'image/png', originalBuffer: SVG });
    assert.equal(stored.origin, 'upload');
  });

  it('is a picture when the bytes are one', async () => {
    const stored = await put({ name: 'a.png', mimeType: 'image/png', originalBuffer: PNG });
    assert.equal(stored.origin, 'image');
  });

  it('keeps the other origins as asked and falls back for an unknown one', async () => {
    const open = new ChatFileRepository({ documents: provider.documents, blobs: provider.blobs });
    const email = await open.put(scope, {
      name: 'a.eml',
      mimeType: 'message/rfc822',
      text: 'x',
      origin: 'email'
    });
    const odd = await open.put(scope, {
      name: 'b.txt',
      mimeType: 'text/plain',
      text: 'y',
      origin: 'nope'
    });
    assert.equal(email.origin, 'email');
    assert.equal(odd.origin, 'upload');
  });

  it('a document sent with the image origin in a turn is described as an upload', async () => {
    const { attachments } = await prepareTurnFiles({
      chatId: scope.id,
      ownerId: 'jonas',
      message: {
        role: 'user',
        content: 'x',
        fileData: {
          type: 'document',
          fileName: 'sneaky.txt',
          fileType: 'text/plain',
          content: 'Quarterly numbers',
          origin: 'image'
        }
      },
      store: repo
    });
    assert.equal(attachments[0].origin, undefined);
    assert.equal((await repo.getDescriptor(scope, attachments[0].id)).origin, 'upload');
  });
});

describe('a stored picture over time', () => {
  let tmpDir;
  let provider;
  let repo;
  const scope = { type: 'chat', id: 'chat-img-ttl' };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-turn-img-ttl-'));
    provider = new FilesystemStorageProvider({ baseDir: tmpDir });
    await provider.initialize();
    repo = new ChatFileRepository({ documents: provider.documents, blobs: provider.blobs });
  });

  afterEach(async () => {
    await provider?.shutdown?.();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const store = async name =>
    repo.put(scope, {
      ownerId: 'jonas',
      name,
      mimeType: 'image/png',
      originalBuffer: Buffer.concat([PNG, Buffer.from(name)]),
      origin: 'image'
    });

  it('is removed whole when its original expires: nothing else is left of it', async () => {
    const image = await store('a.png');
    const later = Date.now() + 30 * 24 * 3600 * 1000;
    const { discarded } = await repo.discardExpiredOriginals({
      originalRetentionDays: 14,
      now: () => later
    });
    assert.equal(discarded, 1);
    assert.equal(await repo.getDescriptor(scope, image.id), null);
    assert.equal((await repo.list(scope)).length, 0);
  });

  it('is kept while a share needs it', async () => {
    const image = await store('a.png');
    const later = Date.now() + 30 * 24 * 3600 * 1000;
    await repo.discardExpiredOriginals({
      originalRetentionDays: 14,
      retainedFileIds: new Set([image.id]),
      now: () => later
    });
    assert.ok(await repo.getDescriptor(scope, image.id));
  });

  it('is removed whole when the user drops only its original', async () => {
    const image = await store('a.png');
    const result = await repo.discardOriginal(scope, image.id, { reason: 'user_deleted' });
    assert.equal(result.hasOriginal, false);
    assert.equal(await repo.getDescriptor(scope, image.id), null);
  });

  it('frees its bytes from the chat', async () => {
    await store('a.png');
    const image = await store('b.png');
    await repo.discardOriginal(scope, image.id);
    const rest = await repo.list(scope);
    assert.equal(rest.length, 1);
    assert.equal(rest[0].name, 'a.png');
  });
});
