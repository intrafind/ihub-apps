/**
 * Generated images survive a durable chat — #2362.
 *
 * A picture the model produced used to live only in the tab that asked for it:
 * `sessionStorage` cannot hold megabytes, so the client stripped the payload
 * and the image was gone the moment the user navigated away. With durable
 * chats on, the transcript survives, and so must what the turn drew.
 *
 * The two halves of that are tested here against a real filesystem provider:
 * the repository, which keeps a payload in its own document so the transcript
 * stays small, and the materializer, which turns a turn's images into the
 * descriptors an assistant message carries. What the route does with them —
 * who may read an image, and what happens to one nobody may — lives in
 * `chat-persistence-routes.test.js` beside the other access checks.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { FilesystemStorageProvider } from '../storage/providers/filesystem/index.js';
import { ChatRepository, imageDocumentKey } from '../services/chat/ChatRepository.js';
import {
  materializeAssistantTurn,
  storeGeneratedImages
} from '../services/chat/chatMaterializer.js';

/** Namespace the payloads land in, as the storage layer names it. */
const CHAT_IMAGES_NS = 'chat-images';

const OWNER = 'user-1';
const CHAT_ID = 'chat-image-1';

/** A logger that records instead of printing. */
function recordingLogger() {
  const lines = [];
  const at = level => (message, meta) => lines.push({ level, message, meta });
  return {
    lines,
    logger: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') }
  };
}

/** Base64 of `size` bytes of a recognizable filler. */
function payload(size = 64) {
  return Buffer.alloc(size, 7).toString('base64');
}

/** The image policy a test drives the materializer with, defaults included. */
function policy(overrides = {}) {
  return {
    storeImages: true,
    maxImageBytes: 10 * 1024 * 1024,
    maxImagesPerMessage: 8,
    ...overrides
  };
}

/**
 * Run `fn` with a repository over a scratch directory, torn down after.
 *
 * @param {(ctx: Object) => Promise<void>} fn - The test body.
 * @returns {Promise<void>}
 */
async function withRepository(fn) {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-chat-images-'));
  const provider = new FilesystemStorageProvider({ baseDir, flushIntervalMs: 25 });
  await provider.initialize();
  const { lines, logger } = recordingLogger();
  const repository = new ChatRepository({
    documents: provider.documents,
    locks: provider.locks,
    logger
  });
  try {
    await fn({ repository, provider, documents: provider.documents, lines });
  } finally {
    await provider.shutdown();
    await fs.rm(baseDir, { recursive: true, force: true });
  }
}

describe('a generated image is stored beside the transcript, not inside it', () => {
  it('keeps the payload out of the transcript document and hands back a descriptor', async () => {
    await withRepository(async ({ repository, documents }) => {
      await repository.ensureChat({ chatId: CHAT_ID, ownerId: OWNER, appId: 'chat' });
      const data = payload(1024);

      const stored = await repository.putImage(CHAT_ID, {
        mimeType: 'image/png',
        data,
        runId: 'run-1'
      });
      await repository.appendMessage(CHAT_ID, {
        role: 'assistant',
        content: 'here it is',
        runId: 'run-1',
        images: [stored]
      });

      assert.ok(stored.id, 'the descriptor carries the id the payload is addressed by');
      assert.equal(stored.mimeType, 'image/png');
      assert.equal(stored.bytes, data.length);

      const { messages } = await repository.getMessages(CHAT_ID);
      const answer = messages.at(-1);
      assert.deepEqual(answer.images, [stored]);
      // The point of the whole design: the transcript every later turn reads,
      // re-serializes and re-hashes must not carry a megabyte of base64.
      assert.equal(
        JSON.stringify(answer).includes(data),
        false,
        'the payload is not inlined in the message'
      );

      const doc = await documents.get(CHAT_IMAGES_NS, imageDocumentKey(CHAT_ID, stored.id));
      assert.equal(doc.data.data, data);
      assert.equal(doc.data.chatId, CHAT_ID);
      assert.equal(doc.data.runId, 'run-1');
    });
  });

  it('reads one back only for the chat that owns it', async () => {
    await withRepository(async ({ repository }) => {
      await repository.ensureChat({ chatId: CHAT_ID, ownerId: OWNER, appId: 'chat' });
      await repository.ensureChat({ chatId: 'chat-other', ownerId: OWNER, appId: 'chat' });
      const stored = await repository.putImage(CHAT_ID, { mimeType: 'image/png', data: payload() });

      const own = await repository.getImage(CHAT_ID, stored.id);
      assert.equal(own.data, payload());
      // The id alone is not a capability: it is addressed under the chat, and
      // the chat is what the route authorizes.
      assert.equal(await repository.getImage('chat-other', stored.id), null);
      assert.equal(await repository.getImage(CHAT_ID, 'no-such-image'), null);
    });
  });

  it('refuses to name a media type it is not willing to serve', async () => {
    await withRepository(async ({ repository }) => {
      await repository.ensureChat({ chatId: CHAT_ID, ownerId: OWNER, appId: 'chat' });
      // The type comes from a model response and ends up in a `Content-Type`
      // header on a same-origin URL. `text/html` there is a stored XSS.
      const html = await repository.putImage(CHAT_ID, { mimeType: 'text/html', data: payload() });
      const svg = await repository.putImage(CHAT_ID, {
        mimeType: 'image/svg+xml',
        data: payload()
      });
      const jpeg = await repository.putImage(CHAT_ID, {
        mimeType: 'image/jpeg; charset=binary',
        data: payload()
      });

      assert.equal(html.mimeType, 'application/octet-stream');
      assert.equal(svg.mimeType, 'application/octet-stream', 'svg is a document that runs script');
      assert.equal(jpeg.mimeType, 'image/jpeg', 'a parameterized type is still that type');
      const jpg = await repository.putImage(CHAT_ID, { mimeType: 'IMAGE/JPG', data: payload() });
      assert.equal(jpg.mimeType, 'image/jpeg', 'the spelling providers use is normalized');
      assert.equal(
        (await repository.getImage(CHAT_ID, html.id)).mimeType,
        'application/octet-stream'
      );
    });
  });
});

describe('an image lives exactly as long as the message that names it', () => {
  it('goes with the chat, including a payload no message ever referenced', async () => {
    await withRepository(async ({ repository, documents }) => {
      await repository.ensureChat({ chatId: CHAT_ID, ownerId: OWNER, appId: 'chat' });
      const referenced = await repository.putImage(CHAT_ID, {
        mimeType: 'image/png',
        data: payload()
      });
      // The answer's write can fail after the payload is stored. Nothing else
      // in the tree enumerates this namespace, so the cascade has to be driven
      // by the key prefix rather than by the transcript.
      const orphan = await repository.putImage(CHAT_ID, { mimeType: 'image/png', data: payload() });
      await repository.appendMessage(CHAT_ID, {
        role: 'assistant',
        content: 'here it is',
        runId: 'run-1',
        images: [referenced]
      });

      await repository.deleteChat(CHAT_ID);

      assert.equal(
        await documents.get(CHAT_IMAGES_NS, imageDocumentKey(CHAT_ID, referenced.id)),
        null
      );
      assert.equal(await documents.get(CHAT_IMAGES_NS, imageDocumentKey(CHAT_ID, orphan.id)), null);
    });
  });

  it("leaves another chat's images alone when a chat id contains the key separator", async () => {
    await withRepository(async ({ repository, documents }) => {
      // `a` and `a__b` share a key prefix. Sweeping `a` must not reach `a__b`.
      await repository.ensureChat({ chatId: 'a', ownerId: OWNER, appId: 'chat' });
      await repository.ensureChat({ chatId: 'a__b', ownerId: OWNER, appId: 'chat' });
      const mine = await repository.putImage('a', { mimeType: 'image/png', data: payload() });
      const theirs = await repository.putImage('a__b', { mimeType: 'image/png', data: payload() });

      await repository.deleteChat('a');

      assert.equal(await documents.get(CHAT_IMAGES_NS, imageDocumentKey('a', mine.id)), null);
      assert.ok(
        await documents.get(CHAT_IMAGES_NS, imageDocumentKey('a__b', theirs.id)),
        "the other chat's image survived"
      );
    });
  });

  it('drops the payloads of messages an edit rewrote away', async () => {
    await withRepository(async ({ repository, documents }) => {
      await repository.ensureChat({ chatId: CHAT_ID, ownerId: OWNER, appId: 'chat' });
      const question = await repository.appendMessage(CHAT_ID, {
        role: 'user',
        content: 'draw me a cat',
        runId: 'run-1'
      });
      const superseded = await repository.putImage(CHAT_ID, {
        mimeType: 'image/png',
        data: payload()
      });
      await repository.appendMessage(CHAT_ID, {
        role: 'assistant',
        content: 'a cat',
        runId: 'run-1',
        images: [superseded]
      });

      // Editing the question and sending it again truncates the stored history
      // from that message. Nothing would ever reach the old image again.
      await repository.appendMessage(
        CHAT_ID,
        { role: 'user', content: 'draw me a dog', runId: 'run-2' },
        { replaceFromMessageId: question.message.id }
      );

      assert.equal(
        await documents.get(CHAT_IMAGES_NS, imageDocumentKey(CHAT_ID, superseded.id)),
        null
      );
    });
  });

  it('drops the payloads of messages the per-chat cap pushed out', async () => {
    await withRepository(async ({ provider }) => {
      const { logger } = recordingLogger();
      const repository = new ChatRepository({
        documents: provider.documents,
        locks: provider.locks,
        logger,
        maxMessages: 2
      });
      await repository.ensureChat({ chatId: 'chat-capped', ownerId: OWNER, appId: 'chat' });
      const dropped = await repository.putImage('chat-capped', {
        mimeType: 'image/png',
        data: payload()
      });
      await repository.appendMessage('chat-capped', {
        role: 'assistant',
        content: 'one',
        runId: 'run-1',
        images: [dropped]
      });
      await repository.appendMessage('chat-capped', { role: 'user', content: 'two' });
      await repository.appendMessage('chat-capped', { role: 'user', content: 'three' });

      const { messages } = await repository.getMessages('chat-capped');
      assert.equal(messages.length, 2, 'the cap held');
      assert.equal(
        await provider.documents.get(CHAT_IMAGES_NS, imageDocumentKey('chat-capped', dropped.id)),
        null
      );
    });
  });
});

describe('the materializer records what the turn drew', () => {
  it('stores each image and puts the descriptors on the assistant message', async () => {
    await withRepository(async ({ repository }) => {
      await repository.ensureChat({ chatId: CHAT_ID, ownerId: OWNER, appId: 'chat' });
      await repository.appendMessage(CHAT_ID, {
        role: 'user',
        content: 'draw me a cat',
        runId: 'run-1'
      });

      await materializeAssistantTurn({
        repository,
        chatId: CHAT_ID,
        runId: 'run-1',
        summary: {
          status: 'completed',
          content: 'here you go',
          finishReason: 'stop',
          images: [{ mimeType: 'image/png', data: payload(128) }]
        },
        clientConnected: true
      });

      const { messages } = await repository.getMessages(CHAT_ID);
      const answer = messages.at(-1);
      assert.equal(answer.images.length, 1);
      assert.ok(answer.images[0].id);
      const image = await repository.getImage(CHAT_ID, answer.images[0].id);
      assert.equal(image.data, payload(128));
      assert.equal(image.mimeType, 'image/png');
    });
  });

  it('stores nothing when the installation has image storage switched off', async () => {
    await withRepository(async ({ repository }) => {
      const descriptors = await storeGeneratedImages({
        repository,
        chatId: CHAT_ID,
        runId: 'run-1',
        images: [{ mimeType: 'image/png', data: payload() }],
        policy: policy({ storeImages: false })
      });
      assert.deepEqual(descriptors, [], 'an admin who said no gets the old behaviour back');
    });
  });

  it('describes an image it refused rather than pretending it was never drawn', async () => {
    await withRepository(async ({ repository }) => {
      await repository.ensureChat({ chatId: CHAT_ID, ownerId: OWNER, appId: 'chat' });
      const big = payload(4096);

      const descriptors = await storeGeneratedImages({
        repository,
        chatId: CHAT_ID,
        runId: 'run-1',
        images: [
          { mimeType: 'image/png', data: big },
          { mimeType: 'image/png', data: payload(16) },
          { mimeType: 'image/png', data: payload(16) }
        ],
        policy: policy({ maxImageBytes: 64, maxImagesPerMessage: 1 })
      });

      // A viewer who watched three pictures appear and comes back to two has
      // no way to tell a dropped image from one the model never drew.
      assert.equal(descriptors.length, 3);
      assert.equal(descriptors[0].unavailable, 'too-large');
      assert.equal(descriptors[0].bytes, big.length);
      assert.ok(descriptors[1].id, 'the one that fits is stored');
      assert.equal(descriptors[2].unavailable, 'too-many');
    });
  });

  it('keeps the answer when the payload cannot be written', async () => {
    await withRepository(async ({ repository, lines }) => {
      await repository.ensureChat({ chatId: CHAT_ID, ownerId: OWNER, appId: 'chat' });
      repository.putImage = async () => {
        throw new Error('disk full');
      };

      await materializeAssistantTurn({
        repository,
        chatId: CHAT_ID,
        runId: 'run-1',
        summary: {
          status: 'completed',
          content: 'here you go',
          finishReason: 'stop',
          images: [{ mimeType: 'image/png', data: payload() }]
        },
        clientConnected: true
      });

      const { messages } = await repository.getMessages(CHAT_ID);
      const answer = messages.at(-1);
      assert.equal(answer.content, 'here you go', 'losing a picture never costs the answer');
      assert.equal(answer.images[0].unavailable, 'not-stored');
      assert.equal(
        lines.some(line => line.level === 'error'),
        false,
        'the repository itself logged nothing'
      );
    });
  });
});
