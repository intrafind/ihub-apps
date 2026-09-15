/**
 * What a durable chat's turns produced survives the chat — #2362.
 *
 * A picture the model produced used to live only in the tab that asked for it:
 * `sessionStorage` cannot hold megabytes, so the client stripped the payload
 * and the image was gone the moment the user navigated away. With durable
 * chats on, the transcript survives, and so must what the turn drew.
 *
 * The payload itself is not a chat concern — it lives in the shared artifact
 * store, which has its own suite in `artifact-repository.test.js`. What is
 * tested here is the chat's half of the contract: the transcript carries
 * descriptors and never a payload, the materializer turns a turn's images into
 * those descriptors, and the messages' lifetime is what decides when the
 * payloads go.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { FilesystemStorageProvider } from '../storage/providers/filesystem/index.js';
import { ChatRepository } from '../services/chat/ChatRepository.js';
import { ArtifactRepository } from '../services/artifacts/ArtifactRepository.js';
import {
  materializeAssistantTurn,
  storeGeneratedArtifacts
} from '../services/chat/chatMaterializer.js';

const OWNER = 'user-1';
const CHAT_ID = 'chat-artifact-1';

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

/** The artifact policy a test drives the materializer with, defaults included. */
function policy(overrides = {}) {
  return { enabled: true, maxBytes: 10 * 1024 * 1024, maxPerBatch: 8, ...overrides };
}

/**
 * Run `fn` with a chat repository and the artifact store it writes through,
 * both over one scratch directory.
 *
 * @param {(ctx: Object) => Promise<void>} fn - The test body.
 * @param {Object} [options]
 * @param {number|null} [options.maxMessages] - Per-chat message cap.
 * @returns {Promise<void>}
 */
async function withRepository(fn, { maxMessages = null } = {}) {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-chat-artifacts-'));
  const provider = new FilesystemStorageProvider({ baseDir, flushIntervalMs: 25 });
  await provider.initialize();
  const { lines, logger } = recordingLogger();
  const artifacts = new ArtifactRepository({ documents: provider.documents, logger });
  const repository = new ChatRepository({
    documents: provider.documents,
    locks: provider.locks,
    logger,
    artifacts,
    maxMessages
  });
  try {
    await fn({ repository, artifacts, provider, lines });
  } finally {
    await provider.shutdown();
    await fs.rm(baseDir, { recursive: true, force: true });
  }
}

/** Store one artifact under a chat and return its descriptor. */
function putChatArtifact(artifacts, chatId, overrides = {}) {
  return artifacts.put(
    { type: 'chat', id: chatId },
    { kind: 'image', mimeType: 'image/png', data: payload(), ...overrides }
  );
}

describe('the transcript carries descriptors, never payloads', () => {
  it('records what the turn produced without inlining it', async () => {
    await withRepository(async ({ repository, artifacts }) => {
      await repository.ensureChat({ chatId: CHAT_ID, ownerId: OWNER, appId: 'chat' });
      const data = payload(1024);
      const stored = await putChatArtifact(artifacts, CHAT_ID, { data, runId: 'run-1' });

      await repository.appendMessage(CHAT_ID, {
        role: 'assistant',
        content: 'here it is',
        runId: 'run-1',
        artifacts: [stored]
      });

      const { messages } = await repository.getMessages(CHAT_ID);
      const answer = messages.at(-1);
      assert.deepEqual(answer.artifacts, [stored]);
      // The point of the whole design: the transcript every later turn reads,
      // re-serializes and re-hashes must not carry a megabyte of base64.
      assert.equal(
        JSON.stringify(answer).includes(data),
        false,
        'the payload is not inlined in the message'
      );
    });
  });

  it('files them under the chat, so the chat can list what it produced', async () => {
    await withRepository(async ({ repository, artifacts }) => {
      await repository.ensureChat({ chatId: CHAT_ID, ownerId: OWNER, appId: 'chat' });
      const stored = await putChatArtifact(artifacts, CHAT_ID);

      assert.deepEqual(repository.artifactScope(CHAT_ID), { type: 'chat', id: CHAT_ID });
      assert.deepEqual(
        (await artifacts.list(repository.artifactScope(CHAT_ID))).map(entry => entry.id),
        [stored.id]
      );
    });
  });
});

describe('an artifact lives exactly as long as the message that names it', () => {
  it('goes with the chat, including a payload no message ever referenced', async () => {
    await withRepository(async ({ repository, artifacts }) => {
      await repository.ensureChat({ chatId: CHAT_ID, ownerId: OWNER, appId: 'chat' });
      const referenced = await putChatArtifact(artifacts, CHAT_ID);
      // The answer's write can fail after the payload is stored.
      const orphan = await putChatArtifact(artifacts, CHAT_ID);
      await repository.appendMessage(CHAT_ID, {
        role: 'assistant',
        content: 'here it is',
        runId: 'run-1',
        artifacts: [referenced]
      });

      await repository.deleteChat(CHAT_ID);

      const scope = repository.artifactScope(CHAT_ID);
      assert.equal(await artifacts.get(scope, referenced.id), null);
      assert.equal(await artifacts.get(scope, orphan.id), null);
    });
  });

  it('drops the payloads of messages an edit rewrote away', async () => {
    await withRepository(async ({ repository, artifacts }) => {
      await repository.ensureChat({ chatId: CHAT_ID, ownerId: OWNER, appId: 'chat' });
      const question = await repository.appendMessage(CHAT_ID, {
        role: 'user',
        content: 'draw me a cat',
        runId: 'run-1'
      });
      const superseded = await putChatArtifact(artifacts, CHAT_ID);
      await repository.appendMessage(CHAT_ID, {
        role: 'assistant',
        content: 'a cat',
        runId: 'run-1',
        artifacts: [superseded]
      });

      // Editing the question and sending it again truncates the stored history
      // from that message. Nothing would ever reach the old artifact again.
      await repository.appendMessage(
        CHAT_ID,
        { role: 'user', content: 'draw me a dog', runId: 'run-2' },
        { replaceFromMessageId: question.message.id }
      );

      assert.equal(await artifacts.get(repository.artifactScope(CHAT_ID), superseded.id), null);
    });
  });

  it('drops the payloads of messages the per-chat cap pushed out', async () => {
    await withRepository(
      async ({ repository, artifacts }) => {
        await repository.ensureChat({ chatId: CHAT_ID, ownerId: OWNER, appId: 'chat' });
        const dropped = await putChatArtifact(artifacts, CHAT_ID);
        await repository.appendMessage(CHAT_ID, {
          role: 'assistant',
          content: 'one',
          runId: 'run-1',
          artifacts: [dropped]
        });
        await repository.appendMessage(CHAT_ID, { role: 'user', content: 'two' });
        await repository.appendMessage(CHAT_ID, { role: 'user', content: 'three' });

        const { messages } = await repository.getMessages(CHAT_ID);
        assert.equal(messages.length, 2, 'the cap held');
        assert.equal(await artifacts.get(repository.artifactScope(CHAT_ID), dropped.id), null);
      },
      { maxMessages: 2 }
    );
  });
});

describe('the materializer records what the turn drew', () => {
  it('stores each image and puts the descriptors on the assistant message', async () => {
    await withRepository(async ({ repository, artifacts }) => {
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
      assert.equal(answer.artifacts.length, 1);
      assert.equal(
        answer.artifacts[0].kind,
        'image',
        'the loop reports images; they are artifacts'
      );
      const artifact = await artifacts.get(
        repository.artifactScope(CHAT_ID),
        answer.artifacts[0].id
      );
      assert.equal(artifact.data, payload(128));
      assert.equal(artifact.mimeType, 'image/png');
    });
  });

  it('stores nothing when the installation has artifacts switched off', async () => {
    await withRepository(async ({ artifacts }) => {
      const descriptors = await storeGeneratedArtifacts({
        chatId: CHAT_ID,
        runId: 'run-1',
        artifacts: [{ kind: 'image', mimeType: 'image/png', data: payload() }],
        store: artifacts,
        policy: policy({ enabled: false })
      });
      assert.deepEqual(descriptors, [], 'an admin who said no gets the old behaviour back');
    });
  });

  it('describes an artifact it refused rather than pretending it was never produced', async () => {
    await withRepository(async ({ artifacts }) => {
      const big = payload(4096);

      const descriptors = await storeGeneratedArtifacts({
        chatId: CHAT_ID,
        runId: 'run-1',
        artifacts: [
          { kind: 'image', mimeType: 'image/png', data: big },
          { kind: 'image', mimeType: 'image/png', data: payload(16) },
          { kind: 'image', mimeType: 'image/png', data: payload(16) }
        ],
        store: artifacts,
        policy: policy({ maxBytes: 64, maxPerBatch: 1 })
      });

      // A viewer who watched three pictures appear and comes back to two has
      // no way to tell a dropped artifact from one the model never drew.
      assert.equal(descriptors.length, 3);
      assert.equal(descriptors[0].unavailable, 'too-large');
      assert.equal(descriptors[0].bytes, big.length);
      assert.ok(descriptors[1].id, 'the one that fits is stored');
      assert.equal(descriptors[2].unavailable, 'too-many');
    });
  });

  it('keeps the answer when the payload cannot be written', async () => {
    await withRepository(async ({ repository, artifacts }) => {
      await repository.ensureChat({ chatId: CHAT_ID, ownerId: OWNER, appId: 'chat' });
      artifacts.put = async () => {
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
      assert.equal(answer.artifacts[0].unavailable, 'not-stored');
    });
  });
});
