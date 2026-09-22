/**
 * `collectChatStats` — the numbers the admin Chat History page shows — driven
 * against a real `ChatRepository` over a real filesystem storage provider.
 *
 * The retention preview is the part an admin acts on ("lowering this to 30
 * days would remove N chats"), so it is checked against what `sweepChats`
 * then actually removes from the same store rather than against a hand-counted
 * expectation.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FilesystemStorageProvider } from '../storage/providers/filesystem/index.js';
import { ChatRepository } from '../services/chat/ChatRepository.js';
import { sweepChats } from '../services/chat/chatRetention.js';
import { collectChatStats } from '../services/chat/chatAdminStats.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NO_RULES = { retentionDays: 0, maxChatsPerUser: 0, maxMessagesPerChat: 0 };

function quietLogger() {
  const noop = () => {};
  return { debug: noop, info: noop, warn: noop, error: noop };
}

async function withRepository(fn) {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-chat-stats-'));
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
 * Store a chat with `messages` messages whose last activity is `ageDays` ago.
 */
async function storeChat(
  repository,
  { chatId, ownerId, ageDays, appId = 'chat', messages = 1, status }
) {
  await repository.ensureChat({ chatId, ownerId, identityMode: 'default', appId });
  for (let i = 0; i < messages; i += 1) {
    await repository.appendMessage(chatId, { role: 'user', content: `${chatId} #${i}` });
  }
  return repository.updateChat(chatId, {
    lastMessageAt: new Date(Date.now() - ageDays * DAY_MS).toISOString(),
    ...(status ? { status } : {})
  });
}

describe('collectChatStats', () => {
  it('reports an unavailable store instead of zeros that look real', async () => {
    const stats = await collectChatStats({
      repository: { isAvailable: () => false },
      settings: NO_RULES
    });
    assert.equal(stats.available, false);
    assert.equal(stats.totalChats, 0);
  });

  it('counts chats, messages, owners, apps and recent activity', async () => {
    await withRepository(async ({ repository }) => {
      await storeChat(repository, { chatId: 'a1', ownerId: 'alice', ageDays: 0, messages: 3 });
      await storeChat(repository, {
        chatId: 'a2',
        ownerId: 'alice',
        ageDays: 3,
        appId: 'translator',
        messages: 2
      });
      await storeChat(repository, {
        chatId: 'a3',
        ownerId: 'alice',
        ageDays: 20,
        messages: 1,
        status: 'error'
      });
      await storeChat(repository, { chatId: 'b1', ownerId: 'bob', ageDays: 10, messages: 4 });

      const stats = await collectChatStats({ repository, settings: NO_RULES });

      assert.equal(stats.available, true);
      assert.equal(stats.truncated, false);
      assert.equal(stats.totalChats, 4);
      assert.equal(stats.totalMessages, 10);
      assert.equal(stats.totalUsers, 2);
      assert.deepEqual(stats.byStatus, { active: 3, error: 1 });
      assert.equal(stats.activeLast24h, 1);
      assert.equal(stats.activeLast7d, 2);
      assert.ok(Date.parse(stats.oldestActivityAt) < Date.parse(stats.newestActivityAt));
      assert.deepEqual(stats.topUsers, [
        { ownerId: 'alice', chats: 3, messages: 6 },
        { ownerId: 'bob', chats: 1, messages: 4 }
      ]);
      assert.deepEqual(stats.topApps, [
        { appId: 'chat', chats: 3, messages: 8 },
        { appId: 'translator', chats: 1, messages: 2 }
      ]);
      // Every rule is off, so nothing is flagged for removal.
      assert.deepEqual(stats.retention, {
        expiringByAge: 0,
        usersOverQuota: 0,
        chatsOverQuota: 0,
        chatsAtMessageCap: 0,
        chatsNearMessageCap: 0
      });
    });
  });

  it('previews exactly what the next sweep removes', async () => {
    await withRepository(async ({ repository }) => {
      // alice: one expired, three survivors against a cap of two -> one over.
      await storeChat(repository, { chatId: 'a-old', ownerId: 'alice', ageDays: 40 });
      await storeChat(repository, { chatId: 'a1', ownerId: 'alice', ageDays: 1 });
      await storeChat(repository, { chatId: 'a2', ownerId: 'alice', ageDays: 2 });
      await storeChat(repository, { chatId: 'a3', ownerId: 'alice', ageDays: 3 });
      // bob: within both rules.
      await storeChat(repository, { chatId: 'b1', ownerId: 'bob', ageDays: 5 });

      const settings = { retentionDays: 30, maxChatsPerUser: 2, maxMessagesPerChat: 0 };
      const stats = await collectChatStats({ repository, settings });
      assert.equal(stats.retention.expiringByAge, 1);
      assert.equal(stats.retention.usersOverQuota, 1);
      assert.equal(stats.retention.chatsOverQuota, 1);

      const { removed } = await sweepChats({
        repository,
        ...settings,
        deleteRun: async () => {},
        removeWorkflowState: async () => {}
      });
      assert.equal(removed, stats.retention.expiringByAge + stats.retention.chatsOverQuota);

      const after = await collectChatStats({ repository, settings });
      assert.equal(after.totalChats, 3);
      assert.equal(after.retention.expiringByAge, 0);
      assert.equal(after.retention.chatsOverQuota, 0);
    });
  });

  it('flags chats at and near the message cap', async () => {
    await withRepository(async ({ repository }) => {
      await storeChat(repository, { chatId: 'full', ownerId: 'alice', ageDays: 0, messages: 10 });
      await storeChat(repository, { chatId: 'near', ownerId: 'alice', ageDays: 0, messages: 9 });
      await storeChat(repository, { chatId: 'fine', ownerId: 'alice', ageDays: 0, messages: 2 });

      const stats = await collectChatStats({
        repository,
        settings: { retentionDays: 0, maxChatsPerUser: 0, maxMessagesPerChat: 10 }
      });
      assert.equal(stats.retention.chatsAtMessageCap, 1);
      assert.equal(stats.retention.chatsNearMessageCap, 1);
    });
  });

  it('says so when the walk bound cut the count short', async () => {
    await withRepository(async ({ repository }) => {
      for (const chatId of ['c1', 'c2', 'c3']) {
        await storeChat(repository, { chatId, ownerId: 'alice', ageDays: 0 });
      }
      const stats = await collectChatStats({ repository, settings: NO_RULES, maxScanned: 2 });
      assert.equal(stats.truncated, true);
      assert.equal(stats.scanned, 2);
      assert.equal(stats.totalChats, 2);
    });
  });

  it('walks a store that cannot stream through paged list', async () => {
    await withRepository(async ({ repository, provider }) => {
      for (const chatId of ['p1', 'p2', 'p3']) {
        await storeChat(repository, { chatId, ownerId: 'alice', ageDays: 0 });
      }
      const pagedOnly = {
        isAvailable: () => true,
        documents: {
          supportsScan: false,
          list: (ns, opts) => provider.documents.list(ns, opts)
        }
      };
      const stats = await collectChatStats({
        repository: pagedOnly,
        settings: NO_RULES,
        pageSize: 1
      });
      assert.equal(stats.totalChats, 3);
      assert.equal(stats.truncated, false);
    });
  });
});
