/**
 * The decisions around durable chats: *whether* a turn is persisted, *who* may
 * touch a stored chat, *what* the POST body is allowed to assert, and what
 * happens to a running turn when its client disappears.
 *
 * These four live in four modules but are one policy — get any of them wrong
 * and the others become harmful rather than useless. A chat that persists for
 * an anonymous caller is unlistable disk; a chat whose owner is not checked is
 * readable by anyone who guesses a client-minted id; a server that trusts a
 * client-sent history defeats the point of storing one; and a turn that keeps
 * running for a chat nobody is persisting bills tokens into the void.
 *
 * Storage is real throughout — a `FilesystemStorageProvider` over `mkdtemp`,
 * including one test that drives the actual `bootstrapStorage()` singleton so
 * the policy's default readiness probe is not taken on trust.
 *
 * Contract: `CHAT_PERSISTENCE_CONTRACT.md` §3, §5, §7, §8, §11 and §12.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FilesystemStorageProvider } from '../storage/providers/filesystem/index.js';
import {
  bootstrapStorage,
  isStorageReady,
  shutdownStorageBootstrap
} from '../storage/bootstrap.js';
import {
  chatRetentionSettings,
  isChatPersistenceActive,
  isChatPersistenceConfigured
} from '../services/chat/chatPersistence.js';
import { authorizeChat } from '../services/chat/chatAccess.js';
import { ChatRepository } from '../services/chat/ChatRepository.js';
import { resolvePrincipal } from '../services/loop/runIdentity.js';
import { RunLog } from '../services/loop/RunLog.js';
import { featureCategories, featureRegistry } from '../featureRegistry.js';
import {
  abortChatRequest,
  abortChatRequestOnDisconnect,
  activeRequests,
  clearChatDurable,
  isChatDurable,
  markChatDurable
} from '../sse.js';
import validate from '../validators/validate.js';
import { chatPostSchema } from '../validators/index.js';

/** Feature flags with durable chats switched on. */
const FLAG_ON = { chatPersistence: true };

/** Feature flags with durable chats switched off. */
const FLAG_OFF = { chatPersistence: false };

/** Storage readiness predicates, injected so the truth table needs no provider. */
const STORAGE_UP = () => true;
const STORAGE_DOWN = () => false;

const USER = { id: 'user-1', name: 'Ada' };
const ADMIN = { id: 'user-9', groups: ['admin'] };
const ANONYMOUS = { id: 'anonymous', anonymous: true };

/**
 * A logger that swallows what it is given; the modules under test take one so
 * a deliberate failure need not print.
 *
 * @returns {Object}
 */
function quietLogger() {
  const noop = () => {};
  return { debug: noop, info: noop, warn: noop, error: noop };
}

/**
 * Run `fn` with a repository over a scratch directory of its own.
 *
 * @param {(ctx: {repository: ChatRepository}) => Promise<void>} fn - Test body.
 * @returns {Promise<void>}
 */
async function withRepository(fn) {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-chat-policy-'));
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

describe('chat persistence policy: the truth table', () => {
  /**
   * Every axis the contract names, each row an independent claim. `expected`
   * is what {@link isChatPersistenceActive} must answer.
   */
  const rows = [
    {
      name: 'everything on: the turn is persisted',
      input: { features: FLAG_ON, platformConfig: {}, user: USER, storageReady: STORAGE_UP },
      expected: true
    },
    {
      name: 'the feature flag is off',
      input: { features: FLAG_OFF, platformConfig: {}, user: USER, storageReady: STORAGE_UP },
      expected: false
    },
    {
      name: 'no flags saved at all — a preview feature defaults off',
      input: { features: undefined, platformConfig: {}, user: USER, storageReady: STORAGE_UP },
      expected: false
    },
    {
      name: 'platform.chats.enabled is false',
      input: {
        features: FLAG_ON,
        platformConfig: { chats: { enabled: false } },
        user: USER,
        storageReady: STORAGE_UP
      },
      expected: false
    },
    {
      name: 'platform.chats.enabled is explicitly true',
      input: {
        features: FLAG_ON,
        platformConfig: { chats: { enabled: true } },
        user: USER,
        storageReady: STORAGE_UP
      },
      expected: true
    },
    {
      name: 'the storage provider never came up',
      input: { features: FLAG_ON, platformConfig: {}, user: USER, storageReady: STORAGE_DOWN },
      expected: false
    },
    {
      name: 'the caller is anonymous',
      input: { features: FLAG_ON, platformConfig: {}, user: ANONYMOUS, storageReady: STORAGE_UP },
      expected: false
    },
    {
      name: 'there is no caller at all',
      input: { features: FLAG_ON, platformConfig: {}, user: undefined, storageReady: STORAGE_UP },
      expected: false
    },
    {
      name: 'a user with no id is an anonymous user',
      input: { features: FLAG_ON, platformConfig: {}, user: { id: '' }, storageReady: STORAGE_UP },
      expected: false
    },
    {
      name: 'the request asked for an ephemeral turn',
      input: {
        features: FLAG_ON,
        platformConfig: {},
        user: USER,
        ephemeral: true,
        storageReady: STORAGE_UP
      },
      expected: false
    },
    {
      name: 'the request explicitly asked for a persisted turn',
      input: {
        features: FLAG_ON,
        platformConfig: {},
        user: USER,
        ephemeral: false,
        storageReady: STORAGE_UP
      },
      expected: true
    },
    {
      name: 'ephemeral:false cannot switch a disabled feature back on',
      input: {
        features: FLAG_OFF,
        platformConfig: {},
        user: USER,
        ephemeral: false,
        storageReady: STORAGE_UP
      },
      expected: false
    }
  ];

  for (const row of rows) {
    it(`isChatPersistenceActive — ${row.name}`, () => {
      assert.equal(isChatPersistenceActive(row.input), row.expected);
    });
  }

  it('isChatPersistenceActive with no arguments is off, not a crash', () => {
    assert.equal(isChatPersistenceActive(), false);
  });

  it('isChatPersistenceConfigured ignores the caller and the ephemeral flag', () => {
    // It is the half of the policy that `RunLog` consults, where there is no
    // request and no user in scope.
    assert.equal(isChatPersistenceConfigured(FLAG_ON, {}, STORAGE_UP), true);
    assert.equal(isChatPersistenceConfigured(FLAG_OFF, {}, STORAGE_UP), false);
    assert.equal(isChatPersistenceConfigured(FLAG_ON, {}, STORAGE_DOWN), false);
    assert.equal(
      isChatPersistenceConfigured(FLAG_ON, { chats: { enabled: false } }, STORAGE_UP),
      false
    );
  });

  it('the feature is registered, so an unknown-id default cannot switch it on', () => {
    // `isFeatureEnabled` answers true for ids it does not know; a registry that
    // shipped without this entry would turn durable chats on everywhere.
    const entry = featureRegistry.find(feature => feature.id === 'chatPersistence');
    assert.ok(entry, 'chatPersistence must exist in the feature registry');
    assert.equal(entry.default, false);
    assert.equal(entry.preview, true);
    assert.equal(entry.category, 'preview');
  });

  it('the run ledger has left preview, because chat persistence implies it', () => {
    const entry = featureRegistry.find(feature => feature.id === 'runLog');
    assert.ok(entry, 'runLog must exist in the feature registry');
    assert.ok(!entry.preview, 'runLog is no longer a preview feature');
    // And is not filed under Preview either. Dropping the badge while leaving
    // the category renders it under the Preview heading as the only row
    // without one — the admin reads the heading, not the missing badge.
    assert.notEqual(entry.category, 'preview');
    assert.ok(
      Object.prototype.hasOwnProperty.call(featureCategories, entry.category),
      `runLog's category ${entry.category} must exist, or Admin → Features drops the row`
    );
  });
});

describe('chat persistence policy: the real storage probe', () => {
  it('follows bootstrapStorage rather than a hard-coded default', async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-chat-bootstrap-'));
    try {
      assert.equal(isStorageReady(), false, 'nothing is bootstrapped yet');
      assert.equal(
        isChatPersistenceConfigured(FLAG_ON, {}),
        false,
        'no provider means no persistence, whatever the flag says'
      );

      await bootstrapStorage({
        storage: { provider: 'filesystem', filesystem: { baseDir, flushIntervalMs: 25 } }
      });
      assert.equal(isStorageReady(), true);
      assert.equal(isChatPersistenceConfigured(FLAG_ON, {}), true);
      assert.equal(isChatPersistenceActive({ features: FLAG_ON, user: USER }), true);
    } finally {
      await shutdownStorageBootstrap();
      await fs.rm(baseDir, { recursive: true, force: true });
    }

    assert.equal(isStorageReady(), false, 'a shutdown puts the policy back to off');
    assert.equal(isChatPersistenceConfigured(FLAG_ON, {}), false);
  });

  it('a broken storage configuration degrades instead of throwing', async () => {
    try {
      const provider = await bootstrapStorage({ storage: { provider: 'no-such-backend' } });

      assert.equal(provider, null);
      assert.equal(isStorageReady(), false);
      assert.equal(isChatPersistenceConfigured(FLAG_ON, {}), false);
    } finally {
      await shutdownStorageBootstrap();
    }
  });
});

describe('chat retention settings', () => {
  it('defaults to 90 days and 200 chats per user', () => {
    assert.deepEqual(chatRetentionSettings(undefined), { retentionDays: 90, maxChatsPerUser: 200 });
    assert.deepEqual(chatRetentionSettings({}), { retentionDays: 90, maxChatsPerUser: 200 });
  });

  it('passes configured values through', () => {
    assert.deepEqual(chatRetentionSettings({ chats: { retentionDays: 7, maxChatsPerUser: 5 } }), {
      retentionDays: 7,
      maxChatsPerUser: 5
    });
  });

  it('keeps zero and negative values — both mean "rule disabled"', () => {
    assert.deepEqual(chatRetentionSettings({ chats: { retentionDays: 0, maxChatsPerUser: 0 } }), {
      retentionDays: 0,
      maxChatsPerUser: 0
    });
    assert.deepEqual(chatRetentionSettings({ chats: { retentionDays: -1, maxChatsPerUser: -5 } }), {
      retentionDays: -1,
      maxChatsPerUser: -5
    });
  });

  it('falls back to the defaults for a value that is not a number', () => {
    assert.deepEqual(chatRetentionSettings({ chats: { retentionDays: 'soon' } }), {
      retentionDays: 90,
      maxChatsPerUser: 200
    });
  });
});

describe('authorizeChat', () => {
  /**
   * Store a chat owned by `ownerId`, resolved in `identityMode`.
   *
   * @param {ChatRepository} repository - Repository under test.
   * @param {string} chatId - Chat id.
   * @param {string} ownerId - Owning principal id.
   * @param {string} identityMode - Mode `ownerId` was resolved in.
   * @returns {Promise<Object>} The stored chat.
   */
  function storeChat(repository, chatId, ownerId, identityMode) {
    return repository.ensureChat({ chatId, ownerId, identityMode, appId: 'chat' });
  }

  it('lets the owner through', async () => {
    await withRepository(async ({ repository }) => {
      const me = await resolvePrincipal(USER, { mode: 'default' });
      await storeChat(repository, 'chat-1', me.id, 'default');

      const result = await authorizeChat('chat-1', USER, { repository });
      assert.equal(result.ok, true);
      assert.equal(result.chat.id, 'chat-1');
    });
  });

  it("answers 404 — never 403 — for somebody else's chat", async () => {
    await withRepository(async ({ repository }) => {
      const owner = await resolvePrincipal(USER, { mode: 'default' });
      await storeChat(repository, 'chat-1', owner.id, 'default');

      // 403 would confirm the id exists, and chat ids are enumerable.
      const result = await authorizeChat('chat-1', { id: 'user-2' }, { repository });
      assert.deepEqual(result, { ok: false, status: 404 });
    });
  });

  it('answers 404 for an anonymous caller', async () => {
    await withRepository(async ({ repository }) => {
      const owner = await resolvePrincipal(USER, { mode: 'default' });
      await storeChat(repository, 'chat-1', owner.id, 'default');

      assert.deepEqual(await authorizeChat('chat-1', ANONYMOUS, { repository }), {
        ok: false,
        status: 404
      });
      assert.deepEqual(await authorizeChat('chat-1', undefined, { repository }), {
        ok: false,
        status: 404
      });
    });
  });

  it('lets an admin read any chat, and says the decision came from the bypass', async () => {
    await withRepository(async ({ repository }) => {
      const owner = await resolvePrincipal(USER, { mode: 'default' });
      await storeChat(repository, 'chat-1', owner.id, 'default');

      const result = await authorizeChat('chat-1', ADMIN, { repository });
      assert.equal(result.ok, true);
      assert.equal(result.chat.ownerId, owner.id);
      // The caller needs to know: an admin read must not clear the owner's
      // unseen badge, because the owner has not seen anything.
      assert.equal(result.viaAdmin, true);
    });
  });

  it('refuses an admin a write on a chat they do not own', async () => {
    // The bypass is documented and tested as a *read* affordance, but the
    // decision used to be one verb-less boolean and every write path
    // authorizes through the same call — so an admin holding a chat id from a
    // support ticket could append a turn to someone else's conversation
    // (stored with no record of who sent it), rename it, or delete it and
    // cascade its ledger, with no audit entry anywhere.
    await withRepository(async ({ repository }) => {
      const owner = await resolvePrincipal(USER, { mode: 'default' });
      await storeChat(repository, 'chat-1', owner.id, 'default');

      assert.deepEqual(await authorizeChat('chat-1', ADMIN, { repository, intent: 'write' }), {
        ok: false,
        status: 404
      });
    });
  });

  it('lets an admin write their own chat', async () => {
    // The refusal above is about ownership, not about being an admin.
    await withRepository(async ({ repository }) => {
      const admin = await resolvePrincipal(ADMIN, { mode: 'default' });
      await storeChat(repository, 'chat-admin-own', admin.id, 'default');

      const result = await authorizeChat('chat-admin-own', ADMIN, {
        repository,
        intent: 'write'
      });
      assert.equal(result.ok, true);
      assert.equal(result.chat.ownerId, admin.id);
    });
  });

  it('defaults to read when no intent is given', async () => {
    await withRepository(async ({ repository }) => {
      const owner = await resolvePrincipal(USER, { mode: 'default' });
      await storeChat(repository, 'chat-1', owner.id, 'default');
      assert.equal((await authorizeChat('chat-1', ADMIN, { repository })).ok, true);
    });
  });

  it('treats a chat that does not exist yet as creatable, not as forbidden', async () => {
    await withRepository(async ({ repository }) => {
      // The first turn of every new chat arrives before anything is stored;
      // 404-ing here would make a new chat impossible.
      assert.deepEqual(await authorizeChat('chat-brand-new', USER, { repository }), {
        ok: true,
        chat: null
      });
      // Same for an id the store cannot key at all.
      assert.deepEqual(await authorizeChat('agent:run-9:ab12', USER, { repository }), {
        ok: true,
        chat: null
      });
    });
  });

  it('resolves the caller in the mode recorded on the chat, not the current one', async () => {
    await withRepository(async ({ repository }) => {
      // An admin switching platform.runLog.identityMode must not orphan chats
      // written before the switch, so the mode travels with the document.
      const pseudonymous = await resolvePrincipal(USER, { mode: 'pseudonymized' });
      const plain = await resolvePrincipal(USER, { mode: 'default' });
      assert.notEqual(pseudonymous.id, plain.id, 'the two modes must differ for this to test');

      await storeChat(repository, 'chat-pseudo', pseudonymous.id, 'pseudonymized');
      const allowed = await authorizeChat('chat-pseudo', USER, { repository });
      assert.equal(allowed.ok, true);
      assert.equal(allowed.chat.identityMode, 'pseudonymized');

      // The same owner id under the wrong recorded mode no longer matches —
      // proof the stored mode is what drives the comparison.
      await storeChat(repository, 'chat-mislabelled', pseudonymous.id, 'default');
      assert.deepEqual(await authorizeChat('chat-mislabelled', USER, { repository }), {
        ok: false,
        status: 404
      });
    });
  });

  it('is creatable when persistence is off, because nothing is stored', async () => {
    const repository = new ChatRepository({ logger: quietLogger() });

    assert.deepEqual(await authorizeChat('chat-1', USER, { repository }), { ok: true, chat: null });
  });
});

describe('POST protocol: what the client may assert', () => {
  /**
   * Drive the real `validate()` middleware over a request-shaped object.
   *
   * @param {Object} body - Request body.
   * @returns {{ok: boolean, body: Object, status: number|null, payload: Object|null}}
   */
  function runValidation(body) {
    let status = null;
    let payload = null;
    const res = {
      status(code) {
        status = code;
        return res;
      },
      json(value) {
        payload = value;
        return res;
      }
    };
    const req = { body, params: { appId: 'chat', chatId: 'chat-1' }, query: {} };
    let ok = false;
    validate(chatPostSchema)(req, res, () => {
      ok = true;
    });
    return { ok, body: req.body, status, payload };
  }

  it('carries replaceFromMessageId and ephemeral through to the handler', () => {
    // `validate()` REPLACES req.body with the parsed object, so a field the
    // schema does not name vanishes silently. That is why both had to be added
    // rather than simply read off the raw body.
    const result = runValidation({
      messages: [{ role: 'user', content: 'hi' }],
      replaceFromMessageId: 'msg-1',
      ephemeral: true,
      somethingElse: 'dropped'
    });

    assert.equal(result.ok, true);
    assert.equal(result.body.replaceFromMessageId, 'msg-1');
    assert.equal(result.body.ephemeral, true);
    assert.equal('somethingElse' in result.body, false);
  });

  it('leaves both fields absent when the client sends neither', () => {
    const result = runValidation({ messages: [{ role: 'user', content: 'hi' }] });

    assert.equal(result.ok, true);
    assert.equal(result.body.replaceFromMessageId, undefined);
    assert.equal(result.body.ephemeral, undefined);
  });

  it('rejects a non-boolean ephemeral and a non-string replaceFromMessageId', () => {
    for (const body of [
      { messages: [], ephemeral: 'yes' },
      { messages: [], replaceFromMessageId: 7 }
    ]) {
      const result = runValidation(body);
      assert.equal(result.ok, false);
      assert.equal(result.status, 400);
    }
  });

  it('refuses a client-asserted history exactly when the turn is persisted', () => {
    // The handler's guard is `messages.length > 1 && isChatPersistenceActive(...)`
    // → 400 CLIENT_HISTORY_NOT_ALLOWED. Driving the handler needs a booted
    // server, so what is pinned here is the carve-out matrix it branches on:
    // every path that keeps today's full-array behaviour must stay open.
    const clientHistory = [
      { role: 'user', content: 'older turn' },
      { role: 'user', content: 'the new message' }
    ];
    const refuses = context =>
      clientHistory.length > 1 && isChatPersistenceActive({ storageReady: STORAGE_UP, ...context });

    assert.equal(refuses({ features: FLAG_ON, user: USER }), true);

    assert.equal(refuses({ features: FLAG_OFF, user: USER }), false, 'feature off keeps the array');
    assert.equal(refuses({ features: FLAG_ON, user: ANONYMOUS }), false, 'anonymous keeps it');
    assert.equal(
      refuses({ features: FLAG_ON, user: USER, ephemeral: true }),
      false,
      'an ephemeral turn keeps it'
    );
    assert.equal(
      refuses({ features: FLAG_ON, user: USER, platformConfig: { chats: { enabled: false } } }),
      false,
      'chats switched off keeps it'
    );
    assert.equal(
      refuses({ features: FLAG_ON, user: USER, storageReady: STORAGE_DOWN }),
      false,
      'storage down keeps it'
    );

    // A single element is the new message; it is never a client-asserted history.
    assert.equal(
      [{ role: 'user', content: 'the new message' }].length > 1 &&
        isChatPersistenceActive({ features: FLAG_ON, user: USER, storageReady: STORAGE_UP }),
      false
    );
  });
});

describe('the disconnect durability guard', () => {
  /**
   * Register an abortable turn for `chatId` and hand back a probe for it.
   *
   * @param {string} chatId - Chat id.
   * @returns {{aborted: () => boolean}}
   */
  function startTurn(chatId) {
    let aborted = false;
    activeRequests.set(chatId, {
      abort() {
        aborted = true;
      }
    });
    return { aborted: () => aborted };
  }

  it('aborts an ordinary turn when its client goes away', () => {
    const chatId = 'chat-guard-plain';
    const turn = startTurn(chatId);
    try {
      assert.equal(isChatDurable(chatId), false);

      assert.equal(abortChatRequestOnDisconnect(chatId), true);
      assert.equal(turn.aborted(), true);
      assert.equal(activeRequests.has(chatId), false);
    } finally {
      activeRequests.delete(chatId);
      clearChatDurable(chatId);
    }
  });

  it('leaves a durable turn running, and Stop still ends it', () => {
    const chatId = 'chat-guard-durable';
    const turn = startTurn(chatId);
    try {
      markChatDurable(chatId);
      assert.equal(isChatDurable(chatId), true);

      // All three disconnect paths — the SSE onClose, the inactivity sweep and
      // a failed envelope write — go through this one call.
      assert.equal(abortChatRequestOnDisconnect(chatId), false);
      assert.equal(turn.aborted(), false);
      assert.equal(activeRequests.has(chatId), true, 'the controller is still there');

      // The Stop button must work on a durable turn too, so the unconditional
      // abort keeps its behaviour.
      assert.equal(abortChatRequest(chatId), true);
      assert.equal(turn.aborted(), true);
      assert.equal(activeRequests.has(chatId), false);
    } finally {
      activeRequests.delete(chatId);
      clearChatDurable(chatId);
    }
  });

  it('a cleared mark makes the next disconnect abort again', () => {
    const chatId = 'chat-guard-cleared';
    const turn = startTurn(chatId);
    try {
      markChatDurable(chatId);
      clearChatDurable(chatId);
      assert.equal(isChatDurable(chatId), false);

      assert.equal(abortChatRequestOnDisconnect(chatId), true);
      assert.equal(turn.aborted(), true);
    } finally {
      activeRequests.delete(chatId);
      clearChatDurable(chatId);
    }
  });

  it('a disconnect for a chat with no turn running is a no-op either way', () => {
    const chatId = 'chat-guard-idle';
    try {
      assert.equal(abortChatRequestOnDisconnect(chatId), false);
      markChatDurable(chatId);
      assert.equal(abortChatRequestOnDisconnect(chatId), false);
    } finally {
      clearChatDurable(chatId);
    }
  });

  it('an empty chat id is never durable', () => {
    markChatDurable('');
    assert.equal(isChatDurable(''), false);
    assert.equal(isChatDurable(undefined), false);
  });

  it('two overlapping turns keep the mark until the second one ends', () => {
    // `runTurn` supersedes rather than refuses: turn B marks the chat, aborts
    // A's controller, and A's request handler then unwinds and clears. If that
    // clear dropped the mark outright, B — the turn that is actually still
    // producing — would spend the rest of its life one disconnect away from
    // being killed with nothing written.
    const chatId = 'chat-guard-overlap';
    const turn = startTurn(chatId);
    try {
      markChatDurable(chatId); // turn A
      markChatDurable(chatId); // turn B supersedes A
      clearChatDurable(chatId); // A's handler unwinds first

      assert.equal(isChatDurable(chatId), true, 'B is still running and still protected');
      assert.equal(abortChatRequestOnDisconnect(chatId), false);
      assert.equal(turn.aborted(), false);

      clearChatDurable(chatId); // B ends
      assert.equal(isChatDurable(chatId), false);
      assert.equal(abortChatRequestOnDisconnect(chatId), true);
      assert.equal(turn.aborted(), true);
    } finally {
      activeRequests.delete(chatId);
      clearChatDurable(chatId);
    }
  });

  it('clearing more often than marking cannot resurrect the mark', () => {
    // The counter must not go negative: a stray clear would otherwise leave a
    // chat that the next single mark could not protect.
    const chatId = 'chat-guard-unbalanced';
    try {
      clearChatDurable(chatId);
      clearChatDurable(chatId);
      assert.equal(isChatDurable(chatId), false);

      markChatDurable(chatId);
      assert.equal(isChatDurable(chatId), true);
      clearChatDurable(chatId);
      assert.equal(isChatDurable(chatId), false);
    } finally {
      clearChatDurable(chatId);
    }
  });
});

describe('the ledger coupling (D4)', () => {
  /**
   * Run `fn` with a `RunLog` over a scratch directory and real storage
   * bootstrapping available.
   *
   * @param {Object} options - `RunLog` options to merge in.
   * @param {(ctx: {log: Object, baseDir: string}) => Promise<void>} fn - Test body.
   * @returns {Promise<void>}
   */
  async function withRunLog(options, fn) {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-chat-runlog-'));
    const log = new RunLog({
      baseDir: path.join(baseDir, 'run-log'),
      getFeatures: () => FLAG_ON,
      getPlatformConfig: () => ({}),
      ...options
    });
    try {
      await fn({ log, baseDir });
    } finally {
      await log.stop();
      await shutdownStorageBootstrap();
      await fs.rm(baseDir, { recursive: true, force: true });
    }
  }

  it('chat persistence alone turns the ledger on, once storage is up', async () => {
    // Materialization reads the run's own events back, so a chat store with no
    // ledger behind it would silently record nothing.
    await withRunLog({}, async ({ log, baseDir }) => {
      assert.equal(log.isEnabled(), false, 'no provider yet, so no persistence and no ledger');

      await bootstrapStorage({
        storage: { provider: 'filesystem', filesystem: { baseDir, flushIntervalMs: 25 } }
      });
      assert.equal(log.isEnabled(), true, 'the chatPersistence flag alone is enough');
    });
  });

  it('stays on for a persisted chat even when runLog.enabled is false', async () => {
    await withRunLog(
      { getPlatformConfig: () => ({ runLog: { enabled: false } }) },
      async ({ log, baseDir }) => {
        await bootstrapStorage({
          storage: { provider: 'filesystem', filesystem: { baseDir, flushIntervalMs: 25 } }
        });
        assert.equal(
          log.isEnabled(),
          true,
          'the platform switch turns off the flag, not the chats'
        );
      }
    );
  });

  it('is off when chat persistence is off and the runLog flag is not set', async () => {
    await withRunLog({ getFeatures: () => FLAG_OFF }, async ({ log, baseDir }) => {
      await bootstrapStorage({
        storage: { provider: 'filesystem', filesystem: { baseDir, flushIntervalMs: 25 } }
      });
      assert.equal(log.isEnabled(), false);
    });
  });

  it('forceEnabled still wins over the coupling in both directions', async () => {
    await withRunLog({ forceEnabled: false }, async ({ log, baseDir }) => {
      await bootstrapStorage({
        storage: { provider: 'filesystem', filesystem: { baseDir, flushIntervalMs: 25 } }
      });
      assert.equal(log.isEnabled(), false, 'the test override is absolute');
    });
    await withRunLog({ forceEnabled: true, getFeatures: () => FLAG_OFF }, async ({ log }) => {
      assert.equal(log.isEnabled(), true);
    });
  });
});
