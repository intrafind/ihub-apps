// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The downloads that stream a stored blob to the client, over a real HTTP
 * connection and with storage encryption on: an artifact, an uploaded file's
 * original and an artifact ZIP, for the chat's owner and through a share.
 *
 * For each: the bytes and `Content-Length` are those of the content, and a
 * blob whose later part was changed on disk makes the transfer break off. The
 * response is never ended as if the file were complete.
 */
import './support/scratchContents.js';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import configCache from '../configCache.js';
import { bootstrapStorage, getStorage, shutdownStorageBootstrap } from '../storage/bootstrap.js';
import { getChatRepository } from '../services/chat/ChatRepository.js';
import { artifactKey } from '../services/artifacts/ArtifactRepository.js';
import { chatFileKey } from '../services/chatFiles/ChatFileRepository.js';
import registerChatRoutes from '../routes/chats.js';
import registerChatShareRoutes from '../routes/chatShares.js';
import { StorageError } from '../storage/errors.js';
import { callRoute, failNextOpenRead } from './support/httpRoute.js';

const ADA = { id: 'user-ada', name: 'Ada Lovelace', email: 'ada@example.com' };
const MIB = 1024 * 1024;
/** Stored offset of a byte in the third 1 MiB segment of an encrypted blob. */
const LATE = 512 + 2 * MIB + 4321;
/** Payload bytes of the two segments in front of it. */
const GENUINE = MIB - 56 + (MIB - 16);

let baseDir;
let chatCounter = 0;

function captureRoutes(register) {
  const routes = [];
  const record =
    method =>
    (routePath, ...handlers) =>
      routes.push({ method, routePath, handlers });
  register({
    get: record('get'),
    post: record('post'),
    put: record('put'),
    patch: record('patch'),
    delete: record('delete'),
    use: () => {}
  });
  return routes;
}

function handlersOf(routes, method, suffix) {
  const route = routes.find(entry => entry.method === method && entry.routePath.endsWith(suffix));
  assert.ok(route, `${method.toUpperCase()} ${suffix} must be registered`);
  return route.handlers;
}

const chatRoutes = captureRoutes(registerChatRoutes);
const shareRoutes = captureRoutes(registerChatShareRoutes);
const ROUTES = {
  chatArtifact: handlersOf(chatRoutes, 'get', '/api/chats/:chatId/artifacts/:artifactId'),
  chatZip: handlersOf(chatRoutes, 'post', '/api/chats/:chatId/artifacts/zip'),
  chatFile: handlersOf(chatRoutes, 'get', '/api/chats/:chatId/files/:fileId'),
  createShare: handlersOf(shareRoutes, 'post', '/api/chats/:chatId/shares'),
  shareArtifact: handlersOf(shareRoutes, 'get', '/api/shares/:shareId/artifacts/:artifactId'),
  shareZip: handlersOf(shareRoutes, 'post', '/api/shares/:shareId/artifacts/zip'),
  shareFile: handlersOf(shareRoutes, 'get', '/api/shares/:shareId/files/:fileId')
};

/** Where the filesystem provider keeps a blob. */
const blobFile = (ns, key) => path.join(baseDir, 'blobs', ns, key);

/** Change one byte of a stored blob, and return a function that puts it back. */
async function damage(file, offset) {
  const stored = await fs.readFile(file);
  assert.equal(stored.toString('ascii', 0, 4), 'IHB1', 'the blob is stored encrypted');
  assert.ok(offset < stored.length);
  const changed = Buffer.from(stored);
  changed[offset] ^= 0x01;
  await fs.writeFile(file, changed);
  return () => fs.writeFile(file, stored);
}

/**
 * A chat of Ada's with a large image, a small HTML artifact and an uploaded
 * file, all named on its messages.
 */
async function seedChat() {
  chatCounter += 1;
  const chatId = `stream-chat-${chatCounter}`;
  const repository = getChatRepository();
  await repository.ensureChat({ chatId, ownerId: ADA.id, appId: 'chat', title: 'Streams' });
  const artifacts = repository.artifactStore();
  const artifactScope = repository.artifactScope(chatId);
  const imageBytes = crypto.randomBytes(3 * MIB + 777);
  const image = await artifacts.put(artifactScope, {
    kind: 'image',
    mimeType: 'image/png',
    data: imageBytes,
    name: 'large.png'
  });
  const pageBytes = Buffer.from('<!doctype html><title>page</title><p>hello</p>');
  const page = await artifacts.put(artifactScope, {
    kind: 'file',
    mimeType: 'text/html',
    data: pageBytes,
    name: 'page.html'
  });
  assert.ok(image?.id && page?.id, 'the artifacts were stored');
  const files = repository.fileStore();
  const fileScope = repository.fileScope(chatId);
  const fileBytes = crypto.randomBytes(3 * MIB + 99);
  const file = await files.put(fileScope, {
    ownerId: ADA.id,
    name: 'scan.pdf',
    mimeType: 'application/pdf',
    text: 'extracted text',
    originalBuffer: fileBytes,
    storageMode: 'original_and_text'
  });
  await repository.appendMessage(chatId, {
    role: 'user',
    content: 'look at this',
    clientMessageId: 'c1',
    attachments: [{ id: file.id, type: file.mimeType, name: file.name, bytes: file.bytes }]
  });
  await repository.appendMessage(chatId, {
    role: 'assistant',
    content: 'here you go',
    artifacts: [image, page]
  });
  // The original of an upload is the blob `<file key>.bin`.
  const fileBlob = blobFile('chat-files', `${chatFileKey(fileScope, file.id)}.bin`);
  await fs.access(fileBlob);
  return {
    chatId,
    image: { ...image, data: imageBytes },
    page: { ...page, data: pageBytes },
    file: { ...file, data: fileBytes },
    imageBlob: blobFile('artifacts', artifactKey(artifactScope, image.id)),
    fileBlob
  };
}

async function shareOf(chatId) {
  const created = await callRoute(ROUTES.createShare, {
    method: 'POST',
    params: { chatId },
    body: { mode: 'public', uploadedFilesAccess: 'original' },
    user: ADA
  });
  assert.equal(created.status, 201, created.body.toString());
  return JSON.parse(created.body.toString());
}

/** Asserts a download that arrived whole. */
function assertWhole(outcome, content, label) {
  assert.equal(outcome.status, 200, `${label}: ${outcome.body.toString('utf8', 0, 300)}`);
  assert.equal(outcome.complete, true, `${label}: the transfer ended`);
  assert.equal(outcome.headers['content-length'], String(content.length), `${label}: length`);
  assert.equal(outcome.headers['transfer-encoding'], undefined, `${label}: not chunked`);
  assert.ok(outcome.body.equals(content), `${label}: the bytes are the content`);
}

/** Asserts a download that broke off after a genuine start. */
function assertCut(outcome, content, label) {
  assert.equal(outcome.complete, false, `${label}: the transfer must not end cleanly`);
  assert.ok(outcome.body.length < content.length, `${label}: not the whole content`);
  assert.ok(
    outcome.body.equals(content.subarray(0, outcome.body.length)),
    `${label}: what arrived is genuine`
  );
  assert.ok(outcome.body.length <= GENUINE, `${label}: nothing of the changed segment`);
  if (outcome.status !== null) {
    assert.equal(outcome.status, 200, label);
    assert.equal(outcome.headers['content-length'], String(content.length), label);
  }
}

before(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-stream-routes-'));
  await bootstrapStorage({
    storage: {
      provider: 'filesystem',
      filesystem: { baseDir, flushIntervalMs: 25 },
      encryption: { enabled: true }
    }
  });
  configCache.setCacheEntry('config/features.json', { chatPersistence: true, chatSharing: true });
  configCache.setCacheEntry('config/platform.json', {
    chats: {
      enabled: true,
      sharing: {
        enabled: true,
        allowUsers: true,
        allowAuthenticated: true,
        allowPublic: true,
        defaultExpiryDays: 0,
        maxExpiryDays: 0,
        maxViewsCap: 0
      }
    }
  });
});

after(async () => {
  await shutdownStorageBootstrap();
  await fs.rm(baseDir, { recursive: true, force: true });
});

describe('streamed downloads of a chat', () => {
  it('serves an artifact with its length, its headers and an entity tag', async () => {
    const { chatId, image } = await seedChat();
    const params = { chatId, artifactId: image.id };

    const outcome = await callRoute(ROUTES.chatArtifact, { params, user: ADA });

    assertWhole(outcome, image.data, 'artifact');
    assert.equal(outcome.headers['content-type'], 'image/png');
    assert.equal(outcome.headers['content-disposition'], 'inline');
    assert.equal(outcome.headers['x-content-type-options'], 'nosniff');
    assert.equal(outcome.headers['cache-control'], 'private, max-age=31536000, immutable');
    const sha256 = crypto.createHash('sha256').update(image.data).digest('hex');
    assert.equal(outcome.headers.etag, `"${sha256}"`);

    const cached = await callRoute(ROUTES.chatArtifact, {
      params,
      user: ADA,
      headers: { 'if-none-match': outcome.headers.etag }
    });
    assert.equal(cached.status, 304);
    assert.equal(cached.body.length, 0);

    const head = await callRoute(ROUTES.chatArtifact, { method: 'HEAD', params, user: ADA });
    assert.equal(head.status, 200);
    assert.equal(head.headers['content-length'], String(image.data.length));
    assert.equal(head.body.length, 0);

    const missing = await callRoute(ROUTES.chatArtifact, {
      params: { chatId, artifactId: 'nope' },
      user: ADA
    });
    assert.equal(missing.status, 404);
    assert.match(missing.headers['content-type'], /application\/problem\+json/);
  });

  it('cuts an artifact download whose blob was changed further in, and answers a status when it does not open at all', async () => {
    const { chatId, image, imageBlob } = await seedChat();
    const params = { chatId, artifactId: image.id };

    let restore = await damage(imageBlob, LATE);
    assertCut(await callRoute(ROUTES.chatArtifact, { params, user: ADA }), image.data, 'artifact');
    await restore();

    // Changed in its first segment: known before a byte is sent, so the
    // client gets an error answer and not a download.
    restore = await damage(imageBlob, 512 + 100);
    const refused = await callRoute(ROUTES.chatArtifact, { params, user: ADA });
    assert.equal(refused.status, 500);
    assert.equal(refused.complete, true);
    assert.match(refused.headers['content-type'], /application\/problem\+json/);
    assert.equal(refused.headers['content-disposition'], undefined);
    assert.equal(refused.body.includes(image.data.subarray(0, 16)), false);
    await restore();

    assertWhole(await callRoute(ROUTES.chatArtifact, { params, user: ADA }), image.data, 'again');
  });

  it('serves the original of an uploaded file, and cuts it when its blob was changed', async () => {
    const { chatId, file, fileBlob } = await seedChat();
    const params = { chatId, fileId: file.id };

    const outcome = await callRoute(ROUTES.chatFile, {
      params,
      query: { download: '1' },
      user: ADA
    });

    assertWhole(outcome, file.data, 'file');
    assert.equal(outcome.headers['content-type'], 'application/pdf');
    assert.match(outcome.headers['content-disposition'], /attachment/);
    assert.match(outcome.headers['content-disposition'], /scan\.pdf/);
    assert.equal(outcome.headers['x-content-type-options'], 'nosniff');
    assert.equal(outcome.headers['cache-control'], 'private, max-age=31536000, immutable');
    assert.match(outcome.headers.etag, /^"[0-9a-f]{64}"$/);
    const inline = await callRoute(ROUTES.chatFile, { params, user: ADA });
    assert.equal(inline.headers['content-disposition'], 'inline');

    const restore = await damage(fileBlob, LATE);
    assertCut(await callRoute(ROUTES.chatFile, { params, user: ADA }), file.data, 'file');
    await restore();
  });

  it('packs artifacts into a ZIP without reading them whole, and cuts the archive when one fails', async () => {
    const { chatId, image, page, imageBlob } = await seedChat();
    const gets = [];
    const blobs = getStorage().blobs;
    const get = blobs.get;
    blobs.get = function countedGet(ns, key) {
      gets.push(key);
      return get.call(this, ns, key);
    };
    let outcome;
    try {
      outcome = await callRoute(ROUTES.chatZip, {
        method: 'POST',
        params: { chatId },
        body: {},
        user: ADA
      });
    } finally {
      blobs.get = get;
    }
    assert.equal(outcome.status, 200, outcome.body.toString('utf8', 0, 300));
    assert.equal(outcome.complete, true);
    assert.equal(outcome.headers['content-type'], 'application/zip');
    assert.equal(outcome.headers['cache-control'], 'private, no-store');
    const zip = await JSZip.loadAsync(outcome.body);
    assert.deepEqual(Object.keys(zip.files).sort(), ['large.png', 'page.html']);
    assert.ok((await zip.file('large.png').async('nodebuffer')).equals(image.data));
    assert.ok((await zip.file('page.html').async('nodebuffer')).equals(page.data));
    // Only the HTML file, which is rewritten on the way out, is read whole.
    assert.equal(gets.length, 1, `read whole: ${gets.join(', ')}`);
    assert.ok(gets[0].endsWith(page.id));

    const restore = await damage(imageBlob, LATE);
    const cut = await callRoute(ROUTES.chatZip, {
      method: 'POST',
      params: { chatId },
      body: { artifactIds: [image.id] },
      user: ADA
    });
    await restore();
    assert.equal(cut.complete, false, 'the archive must not end cleanly');
    await assert.rejects(JSZip.loadAsync(cut.body), 'what arrived is not a readable archive');

    // A payload that is gone is still answered with a status, before the archive starts.
    await fs.rename(imageBlob, `${imageBlob}.away`);
    const missing = await callRoute(ROUTES.chatZip, {
      method: 'POST',
      params: { chatId },
      body: { artifactIds: [image.id] },
      user: ADA
    });
    await fs.rename(`${imageBlob}.away`, imageBlob);
    assert.equal(missing.status, 404);
    assert.equal(missing.complete, true);
  });
});

describe('streamed downloads of a share', () => {
  it('serves a shared artifact and a shared original, and cuts each when its blob was changed', async () => {
    const { chatId, image, page, file, imageBlob, fileBlob } = await seedChat();
    const share = await shareOf(chatId);

    const artifactParams = { shareId: share.id, artifactId: image.id };
    const artifact = await callRoute(ROUTES.shareArtifact, { params: artifactParams });
    assertWhole(artifact, image.data, 'shared artifact');
    assert.equal(artifact.headers['content-type'], 'image/png');
    assert.equal(artifact.headers['content-disposition'], 'inline');
    assert.equal(artifact.headers['x-robots-tag'], 'noindex, nofollow');
    assert.equal(artifact.headers['cache-control'], 'private, max-age=31536000, immutable');
    const saved = await callRoute(ROUTES.shareArtifact, {
      params: artifactParams,
      query: { download: '1' }
    });
    assertWhole(saved, image.data, 'shared artifact, downloaded');
    assert.match(saved.headers['content-disposition'], /^attachment; filename="large\.png"/);
    assert.equal(saved.headers['cache-control'], 'private, no-store');
    // An HTML file is rewritten for the download and still arrives whole.
    const html = await callRoute(ROUTES.shareArtifact, {
      params: { shareId: share.id, artifactId: page.id },
      query: { download: '1' }
    });
    assertWhole(html, page.data, 'shared HTML, downloaded');

    const fileParams = { shareId: share.id, fileId: file.id };
    const original = await callRoute(ROUTES.shareFile, { params: fileParams });
    assertWhole(original, file.data, 'shared original');
    assert.equal(original.headers['cache-control'], 'private, no-store');
    assert.equal(original.headers['x-robots-tag'], 'noindex, nofollow');

    let restore = await damage(imageBlob, LATE);
    assertCut(
      await callRoute(ROUTES.shareArtifact, { params: artifactParams }),
      image.data,
      'artifact'
    );
    const zip = await callRoute(ROUTES.shareZip, {
      method: 'POST',
      params: { shareId: share.id },
      body: { artifactIds: [image.id] }
    });
    assert.equal(zip.complete, false, 'the shared archive must not end cleanly');
    await restore();
    restore = await damage(fileBlob, LATE);
    assertCut(await callRoute(ROUTES.shareFile, { params: fileParams }), file.data, 'original');
    await restore();
  });
});

describe('streamed downloads: what an error answer and a 304 carry', () => {
  /** The four downloads that send an entity tag, for one seeded chat. */
  async function downloads() {
    const { chatId, image, file } = await seedChat();
    const share = await shareOf(chatId);
    return [
      ['artifact', ROUTES.chatArtifact, { params: { chatId, artifactId: image.id }, user: ADA }],
      ['file', ROUTES.chatFile, { params: { chatId, fileId: file.id }, user: ADA }],
      [
        'shared artifact',
        ROUTES.shareArtifact,
        { params: { shareId: share.id, artifactId: image.id } }
      ],
      ['shared file', ROUTES.shareFile, { params: { shareId: share.id, fileId: file.id } }]
    ];
  }

  it('answers a read that fails before its first byte without the headers of the content', async () => {
    const blobs = getStorage().blobs;
    for (const [label, handlers, request] of await downloads()) {
      const restore = failNextOpenRead(blobs, {
        after: 0,
        error: new StorageError('The bucket went away', { code: 'STORAGE_UNAVAILABLE' })
      });
      let outcome;
      try {
        outcome = await callRoute(handlers, request);
      } finally {
        restore();
      }
      assert.equal(outcome.status, 503, `${label}: ${outcome.body.toString('utf8', 0, 200)}`);
      assert.match(outcome.headers['content-type'], /application\/problem\+json/, label);
      // A cache may keep an answer with explicit freshness whatever its
      // status: the error would be served as the content for a year.
      assert.doesNotMatch(outcome.headers['cache-control'] || '', /max-age|immutable/, label);
      // Express tags the error body itself (a weak tag); the content's must be gone.
      assert.doesNotMatch(
        outcome.headers.etag || '',
        /^"[0-9a-f]{64}"$/,
        `${label}: no entity tag of the content`
      );
      assert.equal(outcome.headers['content-disposition'], undefined, label);

      // The same URL answers with the content, and its headers, afterwards.
      const whole = await callRoute(handlers, request);
      assert.equal(whole.status, 200, label);
      assert.match(whole.headers.etag, /^"[0-9a-f]{64}"$/, label);
    }
  });

  it('answers a conditional request from the recorded hash, without opening the blob', async () => {
    const blobs = getStorage().blobs;
    for (const [label, handlers, request] of await downloads()) {
      const first = await callRoute(handlers, request);
      assert.equal(first.status, 200, label);
      const reads = [];
      const { openRead, get } = blobs;
      blobs.openRead = function countedOpenRead(ns, key) {
        reads.push(`openRead ${key}`);
        return openRead.call(this, ns, key);
      };
      blobs.get = function countedGet(ns, key) {
        reads.push(`get ${key}`);
        return get.call(this, ns, key);
      };
      let cached;
      try {
        cached = await callRoute(handlers, {
          ...request,
          headers: { 'if-none-match': first.headers.etag }
        });
      } finally {
        blobs.openRead = openRead;
        blobs.get = get;
      }
      assert.equal(cached.status, 304, label);
      assert.equal(cached.body.length, 0, label);
      assert.equal(cached.headers.etag, first.headers.etag, label);
      assert.equal(cached.headers['cache-control'], first.headers['cache-control'], label);
      assert.deepEqual(reads, [], `${label}: the blob was read for a 304`);
    }
  });
});
