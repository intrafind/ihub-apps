// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Bytes in = bytes out (#3328, EU AI Act Art. 50(2)): a generated image keeps
 * its provider marks only if nothing between the provider response and the
 * user touches the bytes. The signed upstream `C.jpg` stands in for a provider
 * image, and its SHA-256 is compared at every hop:
 *
 *   provider chunk -> ResultAccumulator.push -> SSE delta -> artifact store
 *   -> GET /api/chats/:chatId/artifacts/:id
 *
 * After the last hop the C2PA binding must still validate, and the negative
 * control (one flipped byte) must not. One record is written per image, also
 * when the artifact store refuses the image, and it never holds the bytes.
 *
 * A real Gemini or gpt-image sample is not available in CI (no network, no
 * keys); this proves that whatever C2PA a provider sends is preserved, not
 * what a provider really sends.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import configCache from '../configCache.js';
import { bootstrapStorage, shutdownStorageBootstrap } from '../storage/bootstrap.js';
import { getChatRepository } from '../services/chat/ChatRepository.js';
import { getArtifactRepository } from '../services/artifacts/ArtifactRepository.js';
import { getProvenanceStore } from '../services/provenance/ProvenanceStore.js';
import { ResultAccumulator } from '../services/loop/LLMClient.js';
import { createChatChannel } from '../services/chat/chatChannel.js';
import { storeGeneratedArtifacts } from '../services/chat/chatMaterializer.js';
import { stepDeltaData } from '../services/loop/contracts/sseV2.js';
import { readC2pa } from '../services/provenance/c2paReader.js';
import { hashBytes } from '../services/provenance/mediaMarking.js';
import registerChatRoutes from '../routes/chats.js';
import errorHandler from '../middleware/errorHandler.js';
import { flipByte, readSignedJpeg } from './helpers/mediaFixtures.js';

const OWNER = { id: 'user-ada', name: 'Ada' };
const MODEL = {
  id: 'gemini-image',
  provider: 'google',
  modelId: 'gemini-image',
  contentMarking: { image: { by: 'provider', scheme: 'synthid' } }
};

let baseDir;

function emptyChunk(images) {
  return { content: [], thinking: [], tool_calls: [], images };
}

/** The handler chain of the artifact route, skipping authentication. */
function artifactHandler() {
  const routes = [];
  const record =
    () =>
    (routePath, ...handlers) =>
      routes.push({ routePath, handlers });
  registerChatRoutes({
    get: record(),
    post: () => {},
    put: () => {},
    patch: () => {},
    delete: () => {},
    use: () => {}
  });
  return routes.find(r => r.routePath.endsWith('/api/chats/:chatId/artifacts/:artifactId'))
    .handlers;
}

async function getArtifact(chatId, artifactId) {
  const handlers = artifactHandler();
  const req = { params: { chatId, artifactId }, query: {}, body: {}, headers: {}, user: OWNER };
  const res = { statusCode: 200, body: null, headers: {} };
  res.status = code => ((res.statusCode = code), res);
  res.setHeader = (name, value) => ((res.headers[name.toLowerCase()] = value), res);
  res.send = value => ((res.body = value), res);
  res.json = value => ((res.body = value), res);
  for (let i = 1; i < handlers.length; i += 1) {
    try {
      await handlers[i](req, res, () => {});
    } catch (error) {
      errorHandler(error, req, res, () => {});
    }
  }
  return res;
}

before(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-image-bytes-'));
  await bootstrapStorage({
    storage: { provider: 'filesystem', filesystem: { baseDir, flushIntervalMs: 25 } }
  });
  configCache.setCacheEntry('config/features.json', { chatPersistence: true });
  configCache.setCacheEntry('config/platform.json', { chats: { enabled: true } });
});

after(async () => {
  await shutdownStorageBootstrap();
  await fs.rm(baseDir, { recursive: true, force: true });
});

describe('a generated image keeps its bytes from the provider to the download', () => {
  it('has the same SHA-256 at every hop and the C2PA binding still validates', async () => {
    const original = readSignedJpeg();
    const originalHash = hashBytes(original);
    const base64 = original.toString('base64');
    const image = { mimeType: 'image/jpeg', data: base64 };

    // 1. The accumulator stamps it and starts the record.
    const acc = new ResultAccumulator({ model: MODEL, requestId: 'req-1', runId: 'run-1' });
    acc.push(emptyChunk([image]));
    assert.equal(image.data, base64, 'data untouched by the stamp');
    assert.equal(image.provenance.contentHash, originalHash);
    assert.match(image.provenance.outputId, /^[0-9A-HJKMNP-TV-Z]{26}$/);

    // 2. The SSE delta carries the same string and the provenance.
    const frames = [];
    const channel = createChatChannel({
      chatId: 'chat-bytes',
      runId: 'run-1',
      stream: { emit: (type, data) => frames.push({ type, data }) }
    });
    channel.onChunk(emptyChunk(acc.images), { iteration: 0 });
    const delta = frames.find(f => f.data?.kind === 'image').data;
    assert.equal(delta.image.data, base64);
    assert.equal(hashBytes(Buffer.from(delta.image.data, 'base64')), originalHash);
    assert.deepEqual(delta.image.provenance, image.provenance);
    assert.deepEqual(stepDeltaData.parse(delta).image.provenance, image.provenance);

    // 3. The artifact store.
    await getChatRepository().ensureChat({
      chatId: 'chat-bytes',
      ownerId: OWNER.id,
      appId: 'chat'
    });
    const [descriptor] = await storeGeneratedArtifacts({
      chatId: 'chat-bytes',
      runId: 'run-1',
      artifacts: acc.images.map(i => ({ ...i, kind: 'image' })),
      store: getArtifactRepository(),
      policy: { enabled: true, maxBytes: 10 * 1024 * 1024, maxPerBatch: 8 }
    });
    assert.equal(descriptor.sha256, originalHash, 'the store records the same hash');
    assert.equal(descriptor.outputId, image.provenance.outputId);

    // 4. The serve route.
    const served = await getArtifact('chat-bytes', descriptor.id);
    assert.equal(served.statusCode, 200);
    assert.equal(hashBytes(served.body), originalHash);
    assert.equal(served.headers['content-type'], 'image/jpeg');
    const after = await readC2pa(served.body);
    assert.equal(after.valid, true, 'the hard binding still validates after the round trip');

    // 5. Exactly one record, with the provider marking and no bytes.
    await acc.settleMedia();
    const records = await getProvenanceStore().findByHash(originalHash);
    assert.equal(records.length, 1);
    assert.equal(records[0].output_id, image.provenance.outputId);
    assert.equal(records[0].kind, 'image');
    assert.equal(records[0].content_hash.normalization, 'none');
    assert.equal(records[0].content_hash.bytes, original.length);
    assert.equal(records[0].provider_marking.declared, 'synthid');
    assert.equal(records[0].provider_marking.c2pa.present, true);
    assert.equal(records[0].provider_marking.c2pa.valid, true);
    assert.equal(records[0].provider_marking.c2pa.trust, 'not-evaluated');
    assert.ok(!JSON.stringify(records).includes(base64.slice(0, 64)), 'no bytes in the record');
  });

  it('negative control: a re-encoded (one byte changed) image fails the binding', async () => {
    const changed = flipByte(readSignedJpeg());
    assert.notEqual(hashBytes(changed), hashBytes(readSignedJpeg()));
    assert.equal((await readC2pa(changed)).valid, false);
  });

  it('a stamped image seen twice produces one record', async () => {
    const original = flipByte(readSignedJpeg(), 70000);
    const image = { mimeType: 'image/jpeg', data: original.toString('base64') };
    const acc = new ResultAccumulator({ model: MODEL, requestId: 'req-2' });
    acc.push(emptyChunk([image]));
    acc.push(emptyChunk([image]));
    await acc.settleMedia();
    const records = await getProvenanceStore().findByHash(hashBytes(original));
    assert.equal(records.length, 1);
  });

  it('the record exists when the artifact store refuses the image as too large', async () => {
    const original = flipByte(readSignedJpeg(), 80000);
    const image = { mimeType: 'image/jpeg', data: original.toString('base64') };
    const acc = new ResultAccumulator({ model: MODEL, requestId: 'req-3' });
    acc.push(emptyChunk([image]));
    await getChatRepository().ensureChat({ chatId: 'chat-big', ownerId: OWNER.id, appId: 'chat' });
    const [descriptor] = await storeGeneratedArtifacts({
      chatId: 'chat-big',
      runId: 'run-3',
      artifacts: [{ ...image, kind: 'image' }],
      store: getArtifactRepository(),
      policy: { enabled: true, maxBytes: 1000, maxPerBatch: 8 }
    });
    assert.equal(descriptor.unavailable, 'too-large');
    assert.equal(descriptor.outputId, image.provenance.outputId);
    await acc.settleMedia();
    const records = await getProvenanceStore().findByHash(hashBytes(original));
    assert.equal(records.length, 1);
    assert.equal(records[0].provider_marking.c2pa.valid, false);
  });

  it('writes no record when there is no model (a bare collect) or records are off', async () => {
    const original = flipByte(readSignedJpeg(), 90000);
    const acc = new ResultAccumulator({});
    acc.push(emptyChunk([{ mimeType: 'image/jpeg', data: original.toString('base64') }]));
    await acc.settleMedia();
    assert.equal((await getProvenanceStore().findByHash(hashBytes(original))).length, 0);

    configCache.setCacheEntry('config/platform.json', {
      chats: { enabled: true },
      provenance: { storeRecords: false }
    });
    try {
      const other = flipByte(readSignedJpeg(), 91000);
      const off = new ResultAccumulator({ model: MODEL });
      off.push(emptyChunk([{ mimeType: 'image/jpeg', data: other.toString('base64') }]));
      await off.settleMedia();
      assert.equal((await getProvenanceStore().findByHash(hashBytes(other))).length, 0);
    } finally {
      configCache.setCacheEntry('config/platform.json', { chats: { enabled: true } });
    }
  });
});
