/**
 * The shared artifact store, driven against a real filesystem provider.
 *
 * An artifact is content a run produced that is worth keeping in its own
 * right. A chat turn's generated image is the first producer; a workflow's
 * report and an agent's output are the same kind of thing, which is the whole
 * reason this store is addressed by a **scope** rather than by a chat id. So
 * what has to hold here is what every producer depends on: a payload lands in
 * its own document, one scope cannot read or sweep another's, the media type
 * is one the server is willing to name, and a scope can be listed and emptied
 * by key prefix alone — without the producer's own documents being readable.
 *
 * The chat-specific half — descriptors on a message, the transcript cascade —
 * lives in `chat-persistence-artifacts.test.js`.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { FilesystemStorageProvider } from '../storage/providers/filesystem/index.js';
import {
  ArtifactRepository,
  ARTIFACTS_NAMESPACE,
  artifactKey,
  normalizeScope
} from '../services/artifacts/ArtifactRepository.js';
import { artifactMediaType, artifactSettings } from '../services/artifacts/artifactPolicy.js';

const CHAT = { type: 'chat', id: 'chat-1' };
const RUN = { type: 'run', id: 'run-1' };

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

/** Run `fn` with a repository over a scratch directory, torn down after. */
async function withRepository(fn, { policy } = {}) {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-artifacts-'));
  const provider = new FilesystemStorageProvider({ baseDir, flushIntervalMs: 25 });
  await provider.initialize();
  const { lines, logger } = recordingLogger();
  const repository = new ArtifactRepository({
    documents: provider.documents,
    logger,
    ...(policy ? { policy: () => policy } : {})
  });
  try {
    await fn({ repository, documents: provider.documents, lines });
  } finally {
    await provider.shutdown();
    await fs.rm(baseDir, { recursive: true, force: true });
  }
}

describe('an artifact belongs to a scope, not to a chat', () => {
  it('stores a payload in its own document and hands back a descriptor', async () => {
    await withRepository(async ({ repository, documents }) => {
      const data = payload(1024);

      const stored = await repository.put(RUN, {
        kind: 'document',
        mimeType: 'text/markdown',
        data,
        name: 'report.md',
        runId: 'run-1'
      });

      assert.ok(stored.id);
      assert.equal(stored.kind, 'document');
      assert.equal(stored.mimeType, 'text/markdown');
      assert.equal(stored.bytes, data.length);
      assert.equal(stored.name, 'report.md');
      assert.equal(stored.data, undefined, 'a descriptor never carries the payload');

      const doc = await documents.get(ARTIFACTS_NAMESPACE, artifactKey(RUN, stored.id));
      assert.equal(doc.data.data, data);
      assert.deepEqual(doc.data.scope, RUN, 'the scope is in the document, not only the key');
    });
  });

  it('keeps two scopes apart, even when they share an artifact id', async () => {
    await withRepository(async ({ repository }) => {
      const stored = await repository.put(CHAT, { mimeType: 'image/png', data: payload() });

      assert.equal((await repository.get(CHAT, stored.id)).data, payload());
      // A run and a chat are different owners. The id alone is not a
      // capability: it is addressed under its scope, and the scope is what a
      // route authorizes.
      assert.equal(await repository.get(RUN, stored.id), null);
      assert.equal(await repository.get({ type: 'chat', id: 'other' }, stored.id), null);
    });
  });

  it('refuses a scope it cannot key, rather than inventing one', async () => {
    await withRepository(async ({ repository }) => {
      // A headless agent chat is `agent:<runId>:<hex>` — legal, but a colon is
      // not a valid document key, so such a scope simply has no artifacts.
      assert.equal(normalizeScope({ type: 'chat', id: 'agent:run-1:beef' }), null);
      assert.equal(normalizeScope({ type: 'nonsense', id: 'x' }), null);
      assert.equal(await repository.put({ type: 'nonsense', id: 'x' }, { data: payload() }), null);
      assert.equal(await repository.put({ type: 'chat', id: '../etc' }, { data: payload() }), null);
    });
  });

  it('refuses to name a media type it is not willing to serve', async () => {
    await withRepository(async ({ repository }) => {
      // The type comes from whatever produced the artifact and ends up in a
      // `Content-Type` header on a same-origin URL. `text/html` there is a
      // stored XSS, and SVG is a document that runs script.
      const html = await repository.put(CHAT, { mimeType: 'text/html', data: payload() });
      const svg = await repository.put(CHAT, { mimeType: 'image/svg+xml', data: payload() });
      const jpeg = await repository.put(CHAT, {
        mimeType: 'image/jpeg; charset=binary',
        data: payload()
      });
      const jpg = await repository.put(CHAT, { mimeType: 'IMAGE/JPG', data: payload() });

      assert.equal(html.mimeType, 'application/octet-stream');
      assert.equal(svg.mimeType, 'application/octet-stream');
      assert.equal(jpeg.mimeType, 'image/jpeg', 'a parameterized type is still that type');
      assert.equal(jpg.mimeType, 'image/jpeg', 'the spelling producers use is normalized');
      assert.equal((await repository.get(CHAT, html.id)).mimeType, 'application/octet-stream');
    });
  });

  it('allowlists per kind, so one kind cannot widen another', async () => {
    // Markdown is a document, not an image; a PNG is not a document. Each kind
    // brings its own list, which is what keeps adding a kind from loosening
    // the ones already there.
    assert.equal(artifactMediaType('document', 'text/markdown'), 'text/markdown');
    assert.equal(artifactMediaType('image', 'text/markdown'), 'application/octet-stream');
    assert.equal(artifactMediaType('document', 'image/png'), 'application/octet-stream');
    assert.equal(artifactMediaType('nonsense', 'image/png'), 'image/png', 'unknown kind → default');
  });
});

describe('everything one scope produced can be listed and emptied', () => {
  it('lists newest first, without payloads', async () => {
    await withRepository(async ({ repository }) => {
      const first = await repository.put(RUN, {
        mimeType: 'image/png',
        data: payload(),
        name: 'a cat.png',
        runId: 'run-1'
      });
      const second = await repository.put(RUN, { mimeType: 'image/webp', data: payload(128) });

      const listed = await repository.list(RUN);

      assert.deepEqual(
        listed.map(entry => entry.id),
        [second.id, first.id]
      );
      assert.equal(listed[1].name, 'a cat.png');
      assert.equal(listed[1].runId, 'run-1');
      assert.ok(
        listed.every(entry => entry.data === undefined),
        'no payloads in a listing'
      );
    });
  });

  it('lists nothing belonging to another scope', async () => {
    await withRepository(async ({ repository }) => {
      const mine = await repository.put(CHAT, { mimeType: 'image/png', data: payload() });
      await repository.put(RUN, { mimeType: 'image/png', data: payload() });

      assert.deepEqual(
        (await repository.list(CHAT)).map(entry => entry.id),
        [mine.id]
      );
    });
  });

  it('tells apart scope ids that contain the key separator', async () => {
    await withRepository(async ({ repository }) => {
      // `a` and `a__b` share a key prefix, so both the listing and the sweep
      // have to count separators in the suffix rather than trust the prefix.
      const outer = { type: 'chat', id: 'a' };
      const inner = { type: 'chat', id: 'a__b' };
      const mine = await repository.put(outer, { mimeType: 'image/png', data: payload() });
      const theirs = await repository.put(inner, { mimeType: 'image/png', data: payload() });

      assert.deepEqual(
        (await repository.list(outer)).map(entry => entry.id),
        [mine.id]
      );

      await repository.deleteScope(outer);

      assert.equal(await repository.get(outer, mine.id), null);
      assert.ok(await repository.get(inner, theirs.id), "the other scope's artifact survived");
    });
  });

  it('empties a scope by key, including a payload nothing ever referenced', async () => {
    await withRepository(async ({ repository }) => {
      // A producer's write can fail after the payload is stored. Nothing else
      // enumerates this namespace, so the sweep has to be driven by the key
      // prefix rather than by whatever was supposed to point at it.
      const orphan = await repository.put(CHAT, { mimeType: 'image/png', data: payload() });
      const named = await repository.put(CHAT, { mimeType: 'image/png', data: payload() });

      assert.equal(await repository.deleteScope(CHAT), 2);
      assert.equal(await repository.get(CHAT, orphan.id), null);
      assert.equal(await repository.get(CHAT, named.id), null);
    });
  });

  it('removes only the named artifacts', async () => {
    await withRepository(async ({ repository }) => {
      const gone = await repository.put(CHAT, { mimeType: 'image/png', data: payload() });
      const kept = await repository.put(CHAT, { mimeType: 'image/png', data: payload() });

      assert.equal(await repository.deleteMany(CHAT, [gone.id, 'not-a-real-id']), 1);
      assert.equal(await repository.get(CHAT, gone.id), null);
      assert.ok(await repository.get(CHAT, kept.id));
    });
  });
});

describe("the policy is the installation's, not the producer's", () => {
  it('stores nothing when artifacts are switched off', async () => {
    await withRepository(
      async ({ repository }) => {
        assert.equal(await repository.put(CHAT, { mimeType: 'image/png', data: payload() }), null);
        assert.deepEqual(await repository.list(CHAT), []);
      },
      { policy: { enabled: false, maxBytes: 0, maxPerBatch: 0 } }
    );
  });

  it('reads its settings from platform.artifacts, keeping a zero as written', () => {
    // Not from `chats`: a workflow reading its own limits must not have to
    // reach into the chat settings to find them.
    assert.deepEqual(artifactSettings({}), {
      enabled: true,
      maxBytes: 10485760,
      maxPerBatch: 8
    });
    assert.deepEqual(artifactSettings({ artifacts: { enabled: false, maxBytes: 0 } }), {
      enabled: false,
      maxBytes: 0,
      maxPerBatch: 8
    });
  });
});

describe('storage that is not there', () => {
  it('is a no-op rather than a failure', async () => {
    // A misconfigured provider must cost the picture, not the answer.
    const repository = new ArtifactRepository({ documents: null });
    assert.equal(repository.isAvailable(), false);
    assert.equal(await repository.put(CHAT, { mimeType: 'image/png', data: payload() }), null);
    assert.equal(await repository.get(CHAT, 'whatever'), null);
    assert.deepEqual(await repository.list(CHAT), []);
    assert.equal(await repository.deleteScope(CHAT), 0);
    assert.equal(await repository.deleteMany(CHAT, ['a']), 0);
  });
});
