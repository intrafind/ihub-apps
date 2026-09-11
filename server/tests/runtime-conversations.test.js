/**
 * `ConversationStateManager` on the storage provider, driven against a real
 * `FilesystemStorageProvider`.
 *
 * Two fields per chat — the remote iAssistant conversation id and the id of
 * the last answer, which the next message threads onto — used to live in a
 * per-worker `Map`. Storing them fixes a live cluster bug as well as restart
 * durability: with non-sticky routing, turn 2 of a chat lands on a worker
 * with no state and silently starts a second remote conversation.
 *
 * The constraint that shapes the implementation is that `updateParentId` is
 * called on **every streamed chunk**. A document write on that path is not
 * acceptable, so the write is coalesced — and the case below is written to
 * fail if it ever stops being.
 *
 * Contract: `RUNTIME_STORES_CONTRACT.md` §6.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FilesystemStorageProvider } from '../storage/providers/filesystem/index.js';
import {
  ConversationStateManager,
  INTEGRATION_CONVERSATIONS_NAMESPACE
} from '../services/integrations/ConversationStateManager.js';

const CHAT_ID = 'chat-1';

/**
 * A document facet that counts what passes through it, so a test can assert
 * how many writes a streamed turn cost.
 *
 * @param {Object} documents - The real facet.
 * @returns {{calls: {get: number, put: number, delete: number}, facade: Object}}
 */
function countingDocuments(documents) {
  const calls = { get: 0, put: 0, delete: 0 };
  return {
    calls,
    facade: {
      get: (...args) => {
        calls.get += 1;
        return documents.get(...args);
      },
      put: (...args) => {
        calls.put += 1;
        return documents.put(...args);
      },
      delete: (...args) => {
        calls.delete += 1;
        return documents.delete(...args);
      },
      list: (...args) => documents.list(...args)
    }
  };
}

/**
 * Bring up a provider and one or more managers over a scratch directory.
 *
 * @param {Object} [options]
 * @param {string} [options.baseDir] - Existing directory to re-open.
 * @param {number} [options.writeDebounceMs=5000] - Long enough that no test
 *   depends on the timer firing; `flush()` is what drains a write.
 * @param {number} [options.ttlMs] - Entry lifetime.
 * @param {boolean} [options.withProvider=true] - Wire the provider in.
 * @returns {Promise<Object>} Provider, manager, counters and the directory.
 */
async function openManager({
  baseDir,
  writeDebounceMs = 5000,
  ttlMs = 24 * 60 * 60 * 1000,
  withProvider = true
} = {}) {
  const dir = baseDir || (await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-conversations-')));
  let provider = null;
  let counted = { calls: { get: 0, put: 0, delete: 0 }, facade: null };
  if (withProvider) {
    provider = new FilesystemStorageProvider({ baseDir: dir, flushIntervalMs: 25 });
    await provider.initialize();
    counted = countingDocuments(provider.documents);
  }
  const manager = new ConversationStateManager({
    documents: counted.facade,
    writeDebounceMs,
    ttlMs,
    cleanupIntervalMs: 60_000
  });
  return { baseDir: dir, provider, manager, calls: counted.calls };
}

/**
 * Run `fn` with a manager of its own, torn down after.
 *
 * @param {(ctx: Object) => Promise<void>} fn - The test body.
 * @param {Object} [options] - Passed to {@link openManager}.
 * @returns {Promise<void>}
 */
async function withManager(fn, options = {}) {
  const ctx = await openManager(options);
  try {
    await fn(ctx);
  } finally {
    ctx.manager.stop();
    await ctx.provider?.shutdown();
    await fs.rm(ctx.baseDir, { recursive: true, force: true });
  }
}

describe('conversation state: durability', () => {
  it('survives a restart and reaches a worker that never saw the chat', async () => {
    const first = await openManager();
    try {
      first.manager.setState(CHAT_ID, {
        conversationId: 'conv-7',
        lastParentId: 'msg-1',
        baseUrl: 'https://iassistant.example'
      });
      await first.manager.flush();

      const doc = await first.provider.documents.get(INTEGRATION_CONVERSATIONS_NAMESPACE, CHAT_ID);
      assert.equal(doc.data.conversationId, 'conv-7');
      assert.equal(doc.data.lastParentId, 'msg-1');
    } finally {
      first.manager.stop();
      await first.provider.shutdown();
    }

    // A fresh provider over the same directory is a restart; a second manager
    // over one provider is the worker that turn 2 landed on.
    const second = await openManager({ baseDir: first.baseDir });
    try {
      assert.equal(second.manager.getState(CHAT_ID), null, 'the sync read is cache-only');
      const loaded = await second.manager.loadState(CHAT_ID);
      assert.equal(loaded.conversationId, 'conv-7', 'the chat keeps one remote conversation');
      assert.equal(loaded.lastParentId, 'msg-1', 'and keeps threading onto the last answer');
      assert.equal(
        second.manager.getState(CHAT_ID).conversationId,
        'conv-7',
        'the load caches for the rest of the turn'
      );
      assert.equal(await second.manager.loadState('chat-never-seen'), null);
    } finally {
      second.manager.stop();
      await second.provider.shutdown();
      await fs.rm(first.baseDir, { recursive: true, force: true });
    }
  });

  it('drops an entry past its TTL, in the cache and in the store', async () => {
    await withManager(
      async ({ manager, provider }) => {
        manager.setState(CHAT_ID, {
          conversationId: 'conv-old',
          createdAt: Date.now() - 60_000
        });
        await manager.flush();
        assert.ok(await provider.documents.get(INTEGRATION_CONVERSATIONS_NAMESPACE, CHAT_ID));

        assert.equal(manager.getState(CHAT_ID), null, 'an expired entry reads as absent');
        assert.equal(await manager.loadState(CHAT_ID), null);
        await manager.flush();
        assert.equal(
          await provider.documents.get(INTEGRATION_CONVERSATIONS_NAMESPACE, CHAT_ID),
          null,
          'and its document goes with it'
        );
      },
      { ttlMs: 1000 }
    );
  });

  it('keeps working with no storage provider', async () => {
    await withManager(
      async ({ manager }) => {
        manager.setState(CHAT_ID, { conversationId: 'conv-7' });
        manager.updateParentId(CHAT_ID, 'msg-2');
        assert.equal(manager.getState(CHAT_ID).lastParentId, 'msg-2');
        assert.equal(await manager.loadState('chat-other'), null);
        await manager.flush();
      },
      { withProvider: false }
    );
  });
});

describe('conversation state: ownership', () => {
  it("does not hand one user's conversation to another", async () => {
    // A chat id is a URL path segment, so it reaches history, referrers and
    // pasted links. Keyed on the chat id alone and stored unowned, a user who
    // held someone else's id could post a turn that threaded onto that user's
    // remote conversation — durable and cross-worker for the full TTL.
    await withManager(async ({ manager, provider }) => {
      manager.setState(CHAT_ID, {
        conversationId: 'conv-owned',
        lastParentId: 'msg-9',
        ownerId: 'user-a'
      });
      await manager.flush();

      const doc = await provider.documents.get(INTEGRATION_CONVERSATIONS_NAMESPACE, CHAT_ID);
      assert.equal(doc.ownerId, 'user-a', 'the document carries the owner');

      // Same process, cache warm.
      assert.equal(await manager.loadState(CHAT_ID, { ownerId: 'user-b' }), null);
      assert.equal(
        (await manager.loadState(CHAT_ID, { ownerId: 'user-a' }))?.conversationId,
        'conv-owned'
      );
    });
  });

  it('refuses a cross-owner read from a cold cache too', async () => {
    const first = await openManager();
    try {
      first.manager.setState(CHAT_ID, { conversationId: 'conv-owned', ownerId: 'user-a' });
      await first.manager.flush();
    } finally {
      first.manager.stop();
      await first.provider.shutdown();
    }

    const second = await openManager({ baseDir: first.baseDir });
    try {
      assert.equal(await second.manager.loadState(CHAT_ID, { ownerId: 'user-b' }), null);
      assert.equal(
        (await second.manager.loadState(CHAT_ID, { ownerId: 'user-a' }))?.conversationId,
        'conv-owned'
      );
    } finally {
      second.manager.stop();
      await second.provider.shutdown();
      await fs.rm(first.baseDir, { recursive: true, force: true });
    }
  });

  it('still serves state written before it carried an owner', async () => {
    // An upgrade inherits unowned documents; refusing them would drop every
    // conversation in flight at the moment of the deploy.
    await withManager(async ({ manager }) => {
      manager.setState(CHAT_ID, { conversationId: 'conv-legacy' });
      await manager.flush();
      assert.equal(
        (await manager.loadState(CHAT_ID, { ownerId: 'anyone' }))?.conversationId,
        'conv-legacy'
      );
    });
  });

  it('matches any state when the caller names no owner', async () => {
    await withManager(async ({ manager }) => {
      manager.setState(CHAT_ID, { conversationId: 'conv-owned', ownerId: 'user-a' });
      await manager.flush();
      assert.equal((await manager.loadState(CHAT_ID))?.conversationId, 'conv-owned');
    });
  });
});

describe('conversation state: the streaming path', () => {
  it('never writes a document from updateParentId', async () => {
    await withManager(async ({ manager, calls, provider }) => {
      manager.setState(CHAT_ID, { conversationId: 'conv-7', lastParentId: 'msg-0' });
      await manager.flush();
      const putsAfterSetup = calls.put;

      // One call per streamed chunk carrying a response message id.
      for (let i = 1; i <= 50; i += 1) {
        const returned = manager.updateParentId(CHAT_ID, `msg-${i}`);
        assert.equal(returned, undefined, 'the chunk path is not handed a promise to await');
        assert.equal(
          manager.getState(CHAT_ID).lastParentId,
          `msg-${i}`,
          'the update is visible to the next chunk immediately'
        );
      }

      assert.equal(
        calls.put,
        putsAfterSetup,
        'no document write happened while the turn was streaming'
      );

      await manager.flush();
      assert.equal(calls.put, putsAfterSetup + 1, 'fifty chunks coalesce into one write');
      const doc = await provider.documents.get(INTEGRATION_CONVERSATIONS_NAMESPACE, CHAT_ID);
      assert.equal(doc.data.lastParentId, 'msg-50');
    });
  });

  it('coalesces the writes the debounce timer makes', async () => {
    await withManager(
      async ({ manager, calls, provider }) => {
        manager.setState(CHAT_ID, { conversationId: 'conv-7' });
        for (let i = 1; i <= 20; i += 1) manager.updateParentId(CHAT_ID, `msg-${i}`);

        // The timer, not `flush()`, is what a real turn relies on. Waiting on
        // the document rather than the counter also waits for the write to
        // land, so the assertion below counts finished writes.
        const deadline = Date.now() + 2000;
        let doc = null;
        while (!doc && Date.now() < deadline) {
          doc = await provider.documents.get(INTEGRATION_CONVERSATIONS_NAMESPACE, CHAT_ID);
          if (!doc) await new Promise(resolve => setTimeout(resolve, 5));
        }

        assert.ok(doc, 'the debounce timer wrote the turn out on its own');
        assert.equal(calls.put, 1, 'one write for the whole turn');
        assert.equal(doc.data.lastParentId, 'msg-20');
      },
      { writeDebounceMs: 10 }
    );
  });

  it('persists mid-stream rather than only when the stream ends', async () => {
    // A throttle with a trailing write, not a restarting debounce. The
    // difference only shows when the chunks keep coming: a debounce re-armed
    // by every chunk writes nothing for the whole turn, so a crash or a
    // deploy mid-answer loses `lastParentId` and the next turn threads onto
    // a stale parent message — the cluster bug this store exists to fix.
    await withManager(
      async ({ manager, provider }) => {
        manager.setState(CHAT_ID, { conversationId: 'conv-7' });

        // Chunks closer together than the debounce window, for several
        // windows: a restarting timer would never fire while this loop runs.
        let persisted = null;
        for (let i = 1; i <= 40 && !persisted; i += 1) {
          manager.updateParentId(CHAT_ID, `msg-${i}`);
          await new Promise(resolve => setTimeout(resolve, 5));
          persisted = await provider.documents.get(INTEGRATION_CONVERSATIONS_NAMESPACE, CHAT_ID);
        }

        assert.ok(persisted, 'a write landed while the turn was still streaming');
        assert.ok(
          persisted.data.lastParentId.startsWith('msg-'),
          'and it carried the parent id of the chunk it saw'
        );
      },
      { writeDebounceMs: 20 }
    );
  });

  it('writes an update that lands mid-write rather than losing it', async () => {
    await withManager(async ({ manager, provider }) => {
      manager.setState(CHAT_ID, { conversationId: 'conv-7' });
      const flushing = manager.flush();
      // Dirtying the chat while the write is in flight: the dirty set is
      // drained before the first await, so this must arm another write.
      manager.updateParentId(CHAT_ID, 'msg-late');
      await flushing;
      await manager.flush();

      assert.equal(
        (await provider.documents.get(INTEGRATION_CONVERSATIONS_NAMESPACE, CHAT_ID)).data
          .lastParentId,
        'msg-late'
      );
    });
  });

  it('removes a deleted conversation from the store', async () => {
    await withManager(async ({ manager, provider }) => {
      manager.setState(CHAT_ID, { conversationId: 'conv-7' });
      await manager.flush();
      manager.deleteState(CHAT_ID);
      await manager.flush();

      assert.equal(manager.getState(CHAT_ID), null);
      assert.equal(
        await provider.documents.get(INTEGRATION_CONVERSATIONS_NAMESPACE, CHAT_ID),
        null
      );
    });
  });
});
