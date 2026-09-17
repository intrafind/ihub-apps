/**
 * `chatRetention` — the two rules that keep durable chats from growing without
 * bound — driven against a real `ChatRepository` over a real filesystem
 * storage provider.
 *
 * Both rules delete data, so both are tested from the store's point of view:
 * what survives the sweep is read back out of it, not inferred from the
 * returned count. The disable-at-zero behaviour gets the same treatment,
 * because a retention rule that silently switches itself on is the kind of bug
 * whose blast radius is "every chat the installation ever had".
 *
 * The ledger cascade is observed through the injectable `deleteRun`: the
 * sweep's job is to call it once per run the chat recorded, and what `RunLog`
 * then does with the run has its own tests.
 *
 * Contract: `CHAT_PERSISTENCE_CONTRACT.md` §10 and §12.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FilesystemStorageProvider } from '../storage/providers/filesystem/index.js';
import { ChatRepository } from '../services/chat/ChatRepository.js';
import { startChatRetentionSweep, sweepChats } from '../services/chat/chatRetention.js';

const OWNER = 'user-1';
const OTHER_OWNER = 'user-2';

/** One day in milliseconds — the unit `retentionDays` is expressed in. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** Poll interval while waiting for the background sweep to do something. */
const POLL_MS = 10;

/** Give-up budget for those waits; a sweep over a handful of chats is instant. */
const WAIT_BUDGET_MS = 2000;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * A logger that swallows what it is given.
 *
 * @returns {Object}
 */
function quietLogger() {
  const noop = () => {};
  return { debug: noop, info: noop, warn: noop, error: noop };
}

/**
 * Wait until `check()` resolves truthy, polling rather than sleeping a fixed
 * amount so a slow filesystem does not turn into a flaky test.
 *
 * @param {() => Promise<unknown>|unknown} check - Condition to poll.
 * @param {string} what - Description used in the failure message.
 * @returns {Promise<void>}
 */
async function waitFor(check, what) {
  const deadline = Date.now() + WAIT_BUDGET_MS;
  for (;;) {
    if (await check()) return;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${what}`);
    await delay(POLL_MS);
  }
}

/**
 * Run `fn` with a repository over a scratch directory of its own.
 *
 * @param {(ctx: {repository: ChatRepository, provider: Object}) => Promise<void>} fn - Test body.
 * @returns {Promise<void>}
 */
async function withRepository(fn) {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-chat-retention-'));
  const provider = new FilesystemStorageProvider({ baseDir, flushIntervalMs: 25 });
  await provider.initialize();
  const repository = new ChatRepository({
    documents: provider.documents,
    locks: provider.locks,
    logger: quietLogger()
  });
  try {
    await fn({ repository, provider });
  } finally {
    await provider.shutdown();
    await fs.rm(baseDir, { recursive: true, force: true });
  }
}

/**
 * Store a chat whose last activity is `ageDays` in the past.
 *
 * Ages are relative to the wall clock rather than to an injected one, so the
 * test says nothing about how the sweep reads the time.
 *
 * @param {ChatRepository} repository - Repository under test.
 * @param {Object} options
 * @param {string} options.chatId - Chat id.
 * @param {string|null} options.ownerId - Owning principal, or null for an
 *   unowned chat.
 * @param {number} options.ageDays - How long ago the chat last saw a message.
 * @param {string[]} [options.runIds] - Ledger runs the chat recorded.
 * @returns {Promise<Object>} The stored chat.
 */
async function storeChat(repository, { chatId, ownerId, ageDays, runIds = [] }) {
  await repository.ensureChat({ chatId, ownerId, identityMode: 'default', appId: 'chat' });
  await repository.appendMessage(chatId, { role: 'user', content: `body of ${chatId}` });
  return repository.updateChat(chatId, {
    lastMessageAt: new Date(Date.now() - ageDays * DAY_MS).toISOString(),
    runIds
  });
}

/**
 * Store a chat document with no owner.
 *
 * `ensureChat` refuses to create one — every chat the server writes belongs to
 * a run principal — but the sweep still has to reason about one, because a
 * document written by an older build or one whose owner index was lost looks
 * exactly like this. It is written straight through the document store for
 * that reason.
 *
 * @param {Object} provider - Storage provider under test.
 * @param {Object} options
 * @param {string} options.chatId - Chat id.
 * @param {number} options.ageDays - How long ago the chat last saw a message.
 * @returns {Promise<void>}
 */
async function storeUnownedChat(provider, { chatId, ageDays }) {
  const at = new Date(Date.now() - ageDays * DAY_MS).toISOString();
  await provider.documents.put(
    'chats',
    chatId,
    {
      id: chatId,
      ownerId: null,
      identityMode: 'default',
      appId: 'chat',
      title: chatId,
      createdAt: at,
      lastMessageAt: at,
      messageCount: 0,
      activeRunId: null,
      hasUnseenActivity: false,
      status: 'active',
      runIds: []
    },
    { ownerId: null }
  );
}

/**
 * A `deleteRun` that records what it was asked to cascade into.
 *
 * @returns {{calls: string[], deleteRun: (runId: string) => Promise<void>}}
 */
function recordingCascade() {
  const calls = [];
  return {
    calls,
    deleteRun: async runId => {
      calls.push(runId);
    }
  };
}

/**
 * Ids of the chats still stored for an owner.
 *
 * @param {ChatRepository} repository - Repository under test.
 * @param {string} ownerId - Owning principal.
 * @returns {Promise<string[]>} Ids, sorted for comparison.
 */
async function survivingIds(repository, ownerId) {
  const { items } = await repository.listChats(ownerId, { limit: 100 });
  return items.map(chat => chat.id).sort();
}

describe('sweepChats: the age rule', () => {
  it('removes a chat whose last message is older than retentionDays', async () => {
    await withRepository(async ({ repository, provider }) => {
      await storeChat(repository, { chatId: 'chat-old', ownerId: OWNER, ageDays: 40 });
      await storeChat(repository, { chatId: 'chat-fresh', ownerId: OWNER, ageDays: 1 });
      const cascade = recordingCascade();

      const result = await sweepChats({
        repository,
        retentionDays: 30,
        maxChatsPerUser: 0,
        deleteRun: cascade.deleteRun
      });

      assert.equal(result.removed, 1);
      assert.equal(await repository.getChat('chat-old'), null);
      assert.ok(await repository.getChat('chat-fresh'));
      // The transcript goes with the chat; an orphan transcript is a leak.
      assert.equal(await provider.documents.get('chat-messages', 'chat-old'), null);
      assert.ok(await provider.documents.get('chat-messages', 'chat-fresh'));
    });
  });

  it('keeps a chat exactly at the boundary and drops the one past it', async () => {
    await withRepository(async ({ repository }) => {
      await storeChat(repository, { chatId: 'chat-inside', ownerId: OWNER, ageDays: 29.5 });
      await storeChat(repository, { chatId: 'chat-outside', ownerId: OWNER, ageDays: 30.5 });
      const cascade = recordingCascade();

      const result = await sweepChats({
        repository,
        retentionDays: 30,
        maxChatsPerUser: 0,
        deleteRun: cascade.deleteRun
      });

      assert.equal(result.removed, 1);
      assert.deepEqual(await survivingIds(repository, OWNER), ['chat-inside']);
    });
  });

  it('applies to every owner, and to chats with no owner at all', async () => {
    await withRepository(async ({ repository, provider }) => {
      await storeChat(repository, { chatId: 'chat-mine', ownerId: OWNER, ageDays: 40 });
      await storeChat(repository, { chatId: 'chat-theirs', ownerId: OTHER_OWNER, ageDays: 40 });
      await storeChat(repository, { chatId: 'chat-fresh', ownerId: OTHER_OWNER, ageDays: 1 });
      await storeUnownedChat(provider, { chatId: 'chat-orphan', ageDays: 40 });
      const cascade = recordingCascade();

      const result = await sweepChats({
        repository,
        retentionDays: 30,
        maxChatsPerUser: 0,
        deleteRun: cascade.deleteRun
      });

      assert.equal(result.removed, 3);
      assert.deepEqual(await survivingIds(repository, OWNER), []);
      assert.deepEqual(await survivingIds(repository, OTHER_OWNER), ['chat-fresh']);
      assert.equal(await repository.getChat('chat-orphan'), null);
    });
  });
});

describe('sweepChats: the count rule', () => {
  it('keeps the most recent maxChatsPerUser per owner and drops the rest', async () => {
    await withRepository(async ({ repository }) => {
      for (let index = 0; index < 5; index += 1) {
        await storeChat(repository, {
          chatId: `chat-mine-${index}`,
          ownerId: OWNER,
          ageDays: index
        });
      }
      await storeChat(repository, { chatId: 'chat-theirs-0', ownerId: OTHER_OWNER, ageDays: 9 });
      await storeChat(repository, { chatId: 'chat-theirs-1', ownerId: OTHER_OWNER, ageDays: 10 });
      const cascade = recordingCascade();

      const result = await sweepChats({
        repository,
        retentionDays: 0,
        maxChatsPerUser: 3,
        deleteRun: cascade.deleteRun
      });

      assert.equal(result.removed, 2);
      assert.deepEqual(await survivingIds(repository, OWNER), [
        'chat-mine-0',
        'chat-mine-1',
        'chat-mine-2'
      ]);
      assert.deepEqual(
        await survivingIds(repository, OTHER_OWNER),
        ['chat-theirs-0', 'chat-theirs-1'],
        'an owner under the cap is untouched'
      );
    });
  });

  it('counts only what survived the age rule', async () => {
    await withRepository(async ({ repository }) => {
      // Two ancient chats go on age; of the three that remain the cap keeps two.
      await storeChat(repository, { chatId: 'chat-a', ownerId: OWNER, ageDays: 100 });
      await storeChat(repository, { chatId: 'chat-b', ownerId: OWNER, ageDays: 99 });
      await storeChat(repository, { chatId: 'chat-c', ownerId: OWNER, ageDays: 3 });
      await storeChat(repository, { chatId: 'chat-d', ownerId: OWNER, ageDays: 2 });
      await storeChat(repository, { chatId: 'chat-e', ownerId: OWNER, ageDays: 1 });
      const cascade = recordingCascade();

      const result = await sweepChats({
        repository,
        retentionDays: 30,
        maxChatsPerUser: 2,
        deleteRun: cascade.deleteRun
      });

      assert.equal(result.removed, 3);
      assert.deepEqual(await survivingIds(repository, OWNER), ['chat-d', 'chat-e']);
    });
  });

  it("never counts an unowned chat against anybody's quota", async () => {
    await withRepository(async ({ repository, provider }) => {
      await storeChat(repository, { chatId: 'chat-mine-0', ownerId: OWNER, ageDays: 1 });
      await storeUnownedChat(provider, { chatId: 'chat-orphan-0', ageDays: 2 });
      await storeUnownedChat(provider, { chatId: 'chat-orphan-1', ageDays: 3 });
      const cascade = recordingCascade();

      const result = await sweepChats({
        repository,
        retentionDays: 0,
        maxChatsPerUser: 1,
        deleteRun: cascade.deleteRun
      });

      assert.equal(result.removed, 0);
      assert.ok(await repository.getChat('chat-orphan-0'));
      assert.ok(await repository.getChat('chat-orphan-1'));
    });
  });
});

describe('sweepChats: the rules switch off at zero', () => {
  it('retentionDays <= 0 keeps chats forever', async () => {
    await withRepository(async ({ repository }) => {
      await storeChat(repository, { chatId: 'chat-ancient', ownerId: OWNER, ageDays: 3650 });
      const cascade = recordingCascade();

      for (const retentionDays of [0, -1]) {
        const result = await sweepChats({
          repository,
          retentionDays,
          // The count rule stays on, so this proves the age rule alone is off
          // rather than the whole sweep being skipped.
          maxChatsPerUser: 50,
          deleteRun: cascade.deleteRun
        });
        assert.equal(result.removed, 0, `retentionDays=${retentionDays} must delete nothing`);
        assert.ok(await repository.getChat('chat-ancient'));
      }
      assert.deepEqual(cascade.calls, []);
    });
  });

  it('maxChatsPerUser <= 0 puts no cap on an owner', async () => {
    await withRepository(async ({ repository }) => {
      for (let index = 0; index < 4; index += 1) {
        await storeChat(repository, { chatId: `chat-${index}`, ownerId: OWNER, ageDays: index });
      }
      const cascade = recordingCascade();

      for (const maxChatsPerUser of [0, -5]) {
        const result = await sweepChats({
          repository,
          // The age rule stays on but nothing is old enough to trip it.
          retentionDays: 3650,
          maxChatsPerUser,
          deleteRun: cascade.deleteRun
        });
        assert.equal(result.removed, 0, `maxChatsPerUser=${maxChatsPerUser} must delete nothing`);
      }
      assert.equal((await survivingIds(repository, OWNER)).length, 4);
    });
  });

  it('both rules off removes nothing, however old and however many', async () => {
    await withRepository(async ({ repository }) => {
      for (let index = 0; index < 3; index += 1) {
        await storeChat(repository, {
          chatId: `chat-${index}`,
          ownerId: OWNER,
          ageDays: 500 + index
        });
      }
      const cascade = recordingCascade();

      const result = await sweepChats({
        repository,
        retentionDays: 0,
        maxChatsPerUser: 0,
        deleteRun: cascade.deleteRun
      });

      assert.deepEqual(result, { removed: 0 });
      assert.equal((await survivingIds(repository, OWNER)).length, 3);
      assert.deepEqual(cascade.calls, []);
    });
  });
});

describe('sweepChats: the ledger cascade', () => {
  it('deletes every run the removed chat recorded, once each', async () => {
    await withRepository(async ({ repository }) => {
      await storeChat(repository, {
        chatId: 'chat-old',
        ownerId: OWNER,
        ageDays: 40,
        runIds: ['run-a', 'run-b']
      });
      await storeChat(repository, {
        chatId: 'chat-fresh',
        ownerId: OWNER,
        ageDays: 1,
        runIds: ['run-keep']
      });
      const cascade = recordingCascade();

      await sweepChats({
        repository,
        retentionDays: 30,
        maxChatsPerUser: 0,
        deleteRun: cascade.deleteRun
      });

      assert.deepEqual([...cascade.calls].sort(), ['run-a', 'run-b']);
      assert.equal(cascade.calls.includes('run-keep'), false);
    });
  });

  it('one stubborn run does not strand the rest of the sweep', async () => {
    await withRepository(async ({ repository }) => {
      await storeChat(repository, {
        chatId: 'chat-a',
        ownerId: OWNER,
        ageDays: 40,
        runIds: ['run-broken']
      });
      await storeChat(repository, {
        chatId: 'chat-b',
        ownerId: OWNER,
        ageDays: 41,
        runIds: ['run-fine']
      });
      const seen = [];

      const result = await sweepChats({
        repository,
        retentionDays: 30,
        maxChatsPerUser: 0,
        deleteRun: async runId => {
          seen.push(runId);
          if (runId === 'run-broken') throw new Error('ledger unavailable');
        }
      });

      assert.equal(result.removed, 2, 'both chats are still removed');
      assert.deepEqual([...seen].sort(), ['run-broken', 'run-fine']);
      assert.deepEqual(await survivingIds(repository, OWNER), []);
    });
  });
});

describe('sweepChats: nothing to sweep', () => {
  it('is a no-op when storage is unavailable', async () => {
    const repository = new ChatRepository({ logger: quietLogger() });
    const cascade = recordingCascade();

    assert.deepEqual(
      await sweepChats({
        repository,
        retentionDays: 30,
        maxChatsPerUser: 10,
        deleteRun: cascade.deleteRun
      }),
      { removed: 0 }
    );
    assert.deepEqual(await sweepChats({}), { removed: 0 });
  });

  it('is a no-op on an empty store', async () => {
    await withRepository(async ({ repository }) => {
      const cascade = recordingCascade();

      assert.deepEqual(
        await sweepChats({
          repository,
          retentionDays: 30,
          maxChatsPerUser: 10,
          deleteRun: cascade.deleteRun
        }),
        { removed: 0 }
      );
    });
  });
});

/**
 * The two halves of the persistence predicate that are not the platform config.
 *
 * The sweep evaluates the same `isChatPersistenceConfigured` the write path
 * does — feature flag, `chats.enabled`, storage readiness — so a test that
 * wants a sweep to happen has to say the feature is on and storage is up.
 */
const SWEEP_ON = { getFeatures: () => ({ chatPersistence: true }), storageReady: () => true };

describe('startChatRetentionSweep', () => {
  /**
   * Run `fn` with `setInterval` instrumented, so a test can inspect the timer
   * the sweep installed without the module having to expose it.
   *
   * @param {(timers: Object[]) => Promise<void>} fn - Test body.
   * @returns {Promise<void>}
   */
  async function withCapturedTimers(fn) {
    const timers = [];
    const realSetInterval = globalThis.setInterval;
    globalThis.setInterval = (...args) => {
      const timer = realSetInterval(...args);
      timers.push(timer);
      return timer;
    };
    try {
      await fn(timers);
    } finally {
      globalThis.setInterval = realSetInterval;
    }
  }

  it('sweeps immediately on an unref-ed timer', async () => {
    await withRepository(async ({ repository }) => {
      await storeChat(repository, { chatId: 'chat-old', ownerId: OWNER, ageDays: 400 });
      await storeChat(repository, { chatId: 'chat-fresh', ownerId: OWNER, ageDays: 1 });

      await withCapturedTimers(async timers => {
        const stop = startChatRetentionSweep({
          repository,
          getFeatures: () => ({ chatPersistence: true }),
          storageReady: () => true,
          getPlatformConfig: () => ({ chats: { retentionDays: 90, maxChatsPerUser: 0 } }),
          intervalMs: 60_000
        });
        // Counted before the first sweep runs, not after: the capture is a
        // global `setInterval`, and the sweep's own deletes take storage locks,
        // which keep their leases alive on an interval of their own. The claim
        // is about what `startChatRetentionSweep` installs, and it installs it
        // synchronously.
        const installed = timers.length;
        try {
          await waitFor(
            async () => (await repository.getChat('chat-old')) === null,
            'the first sweep to remove the expired chat'
          );
          assert.ok(await repository.getChat('chat-fresh'));

          assert.equal(installed, 1, 'exactly one interval is installed');
          assert.equal(
            timers[0].hasRef(),
            false,
            'a pending sweep must never keep the process alive'
          );
        } finally {
          stop();
          await delay(POLL_MS * 2);
        }
      });
    });
  });

  it('starting twice does not sweep twice', async () => {
    await withRepository(async ({ repository }) => {
      let reads = 0;
      const getPlatformConfig = () => {
        reads += 1;
        return { chats: { retentionDays: 90, maxChatsPerUser: 0 } };
      };

      await withCapturedTimers(async timers => {
        const stop = startChatRetentionSweep({
          repository,
          ...SWEEP_ON,
          getPlatformConfig,
          intervalMs: 60_000
        });
        const stopAgain = startChatRetentionSweep({
          repository,
          ...SWEEP_ON,
          getPlatformConfig,
          intervalMs: 60_000
        });
        try {
          await waitFor(() => reads > 0, 'the first tick to read the platform config');
          await delay(POLL_MS * 2);

          assert.equal(reads, 1, 'the second start must not add a second sweep');
          assert.equal(timers.length, 1);
        } finally {
          stop();
          stopAgain();
          await delay(POLL_MS * 2);
        }
      });
    });
  });

  it('switching chats off disables a feature — it does not purge the store', async () => {
    await withRepository(async ({ repository }) => {
      await storeChat(repository, { chatId: 'chat-ancient', ownerId: OWNER, ageDays: 4000 });
      let reads = 0;
      const getPlatformConfig = () => {
        reads += 1;
        return { chats: { enabled: false, retentionDays: 1, maxChatsPerUser: 1 } };
      };

      await withCapturedTimers(async () => {
        const stop = startChatRetentionSweep({
          repository,
          ...SWEEP_ON,
          getPlatformConfig,
          intervalMs: 60_000
        });
        try {
          await waitFor(() => reads > 0, 'the first tick to read the platform config');
          await delay(POLL_MS * 2);

          assert.ok(
            await repository.getChat('chat-ancient'),
            'an admin turning the feature off is not asking for a purge'
          );
        } finally {
          stop();
          await delay(POLL_MS * 2);
        }
      });
    });
  });

  it('turning the Durable Chats feature off does not purge the store either', async () => {
    // The switch an admin actually sees is `features.chatPersistence`; it does
    // not touch `platform.chats.enabled`. Gating the sweep on the platform key
    // alone meant turning the feature off stopped writes but kept deleting —
    // and with writes stopped, every stored chat was guaranteed to age out.
    await withRepository(async ({ repository }) => {
      await storeChat(repository, { chatId: 'chat-ancient', ownerId: OWNER, ageDays: 4000 });
      let reads = 0;
      const getPlatformConfig = () => {
        reads += 1;
        return { chats: { enabled: true, retentionDays: 1, maxChatsPerUser: 1 } };
      };

      await withCapturedTimers(async () => {
        const stop = startChatRetentionSweep({
          repository,
          getFeatures: () => ({ chatPersistence: false }),
          storageReady: () => true,
          getPlatformConfig,
          intervalMs: 60_000
        });
        try {
          await waitFor(() => reads > 0, 'the first tick to read the platform config');
          await delay(POLL_MS * 2);

          assert.ok(
            await repository.getChat('chat-ancient'),
            'an expired chat survives while the feature is off'
          );
        } finally {
          stop();
          await delay(POLL_MS * 2);
        }
      });
    });
  });

  it('does not sweep while storage is unavailable', async () => {
    // The third half of the predicate. A no-op repository would delete
    // nothing anyway, but sweeping against one logs deletions that never
    // happened.
    await withRepository(async ({ repository }) => {
      await storeChat(repository, { chatId: 'chat-ancient', ownerId: OWNER, ageDays: 4000 });
      let reads = 0;
      const getPlatformConfig = () => {
        reads += 1;
        return { chats: { enabled: true, retentionDays: 1, maxChatsPerUser: 1 } };
      };

      await withCapturedTimers(async () => {
        const stop = startChatRetentionSweep({
          repository,
          getFeatures: () => ({ chatPersistence: true }),
          storageReady: () => false,
          getPlatformConfig,
          intervalMs: 60_000
        });
        try {
          await waitFor(() => reads > 0, 'the first tick to read the platform config');
          await delay(POLL_MS * 2);
          assert.ok(await repository.getChat('chat-ancient'));
        } finally {
          stop();
          await delay(POLL_MS * 2);
        }
      });
    });
  });

  it('re-reads the platform config on every tick', async () => {
    await withRepository(async ({ repository }) => {
      await storeChat(repository, { chatId: 'chat-old', ownerId: OWNER, ageDays: 400 });
      let reads = 0;
      // The first tick keeps everything; only once an admin lowers the limit
      // does the chat expire, which can only work if config is read per tick.
      const getPlatformConfig = () => {
        reads += 1;
        return { chats: { retentionDays: reads === 1 ? 0 : 90, maxChatsPerUser: 0 } };
      };

      await withCapturedTimers(async () => {
        // The first tick runs synchronously inside `start`, so the assertion
        // below is taken well before the interval can fire a second one.
        const stop = startChatRetentionSweep({
          repository,
          ...SWEEP_ON,
          getPlatformConfig,
          intervalMs: 200
        });
        try {
          await waitFor(() => reads > 0, 'the immediate first tick');
          assert.equal(reads, 1, 'the sweep runs once immediately');
          assert.ok(await repository.getChat('chat-old'), 'retention was off on the first tick');

          await waitFor(
            async () => (await repository.getChat('chat-old')) === null,
            'a later tick to pick up the lowered limit'
          );
        } finally {
          stop();
          // Let an in-flight tick clear the module's re-entrancy guard, or the
          // next test's sweep would find it still set and skip itself.
          await delay(POLL_MS * 2);
        }
      });
    });
  });
});

describe('sweepChats: a namespace bigger than one page', () => {
  it('reaches an owner whose chats sort past the first pages', async () => {
    // The defect this replaces: the sweep materialized the namespace behind a
    // fixed 20,000-document ceiling. Listing is ascending by key and chat ids
    // are random uuids, so every tick saw the same lexicographic prefix and
    // everything past it was invisible to *both* rules — while the count rule
    // was the only thing keeping the namespace under that ceiling.
    //
    // Scaled down: eight chats sort ahead of the owner under test, so a walk
    // that stops early never learns that owner exists and never applies the
    // count rule to them at all.
    await withRepository(async ({ repository }) => {
      for (let index = 0; index < 8; index += 1) {
        await storeChat(repository, {
          chatId: `aa-early-${index}`,
          ownerId: OWNER,
          ageDays: 100 + index
        });
      }
      for (let index = 0; index < 5; index += 1) {
        await storeChat(repository, {
          chatId: `zz-late-${index}`,
          ownerId: OTHER_OWNER,
          ageDays: index
        });
      }

      const result = await sweepChats({
        repository,
        retentionDays: 30,
        maxChatsPerUser: 2,
        deleteRun: recordingCascade().deleteRun,
        // Two per page, so thirteen chats span seven pages and the owner under
        // test appears only in the last three.
        pageSize: 2
      });

      // Eight expired by age at the front, three over the cap at the back.
      assert.equal(result.removed, 11);
      assert.deepEqual(await survivingIds(repository, OWNER), []);
      assert.deepEqual(
        await survivingIds(repository, OTHER_OWNER),
        ['zz-late-0', 'zz-late-1'],
        'the count rule reached an owner the old scan would have stopped short of'
      );
    });
  });

  it('does not remove a live chat to make up a quota the age rule already met', async () => {
    // The count rule runs after the age rule and is told what it took. Counting
    // an already-deleted chat against the quota would take a live one to make
    // up the number.
    await withRepository(async ({ repository }) => {
      await storeChat(repository, { chatId: 'chat-ancient', ownerId: OWNER, ageDays: 100 });
      await storeChat(repository, { chatId: 'chat-live-1', ownerId: OWNER, ageDays: 2 });
      await storeChat(repository, { chatId: 'chat-live-2', ownerId: OWNER, ageDays: 1 });

      const result = await sweepChats({
        repository,
        retentionDays: 30,
        maxChatsPerUser: 2,
        deleteRun: recordingCascade().deleteRun
      });

      assert.equal(result.removed, 1, 'only the ancient one');
      assert.deepEqual(await survivingIds(repository, OWNER), ['chat-live-1', 'chat-live-2']);
    });
  });
});
