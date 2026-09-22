/**
 * Tests for the admin Chat History API (server/routes/admin/chatHistory.js).
 *
 * Covers the contract the admin page depends on: one read returns settings
 * with defaults filled in and every persistence gate on its own; the settings
 * write validates, merges only what was sent and leaves the rest of
 * platform.json alone; and a manual retention run honors the same predicates
 * the scheduled sweeps do — in particular, stored chats are never swept while
 * durable chats are switched off.
 *
 * Native ESM, so `jest.unstable_mockModule` + dynamic imports. Run with
 * `NODE_OPTIONS=--experimental-vm-modules`.
 */

import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const state = {
  stored: {},
  features: {},
  storageReady: true,
  sweeps: [],
  cleanups: [],
  audits: []
};

jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    getPlatform: () => state.stored,
    getFeatures: () => state.features,
    refreshCacheEntry: async () => {}
  }
}));

jest.unstable_mockModule('../services/config/ConfigStore.js', () => ({
  default: {
    readJson: async () => JSON.parse(JSON.stringify(state.stored)),
    writeJson: async (_path, data) => {
      state.stored = JSON.parse(JSON.stringify(data));
    }
  }
}));

jest.unstable_mockModule('../middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) => next()
}));

jest.unstable_mockModule('../services/AuditLogService.js', () => ({
  logAudit: entry => state.audits.push(entry)
}));

jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}));

jest.unstable_mockModule('../storage/bootstrap.js', () => ({
  getStorage: () => (state.storageReady ? { name: 'filesystem' } : null),
  isStorageReady: () => state.storageReady,
  readFacet: () => null
}));

jest.unstable_mockModule('../services/loop/RunLog.js', () => ({
  default: {
    isEnabled: () => true,
    cleanup: async days => {
      state.cleanups.push(days);
      return { removed: 3 };
    }
  }
}));

jest.unstable_mockModule('../services/chat/ChatRepository.js', () => ({
  getChatRepository: () => ({ isAvailable: () => true })
}));

jest.unstable_mockModule('../services/chat/chatRetention.js', () => ({
  sweepChats: async options => {
    state.sweeps.push(options);
    return { removed: 2 };
  }
}));

jest.unstable_mockModule('../services/chat/chatAdminStats.js', () => ({
  collectChatStats: async ({ settings }) => ({ available: true, totalChats: 7, settings })
}));

jest.unstable_mockModule('../services/runtime/RunSummaryRepository.js', () => ({
  getRunSummaryRepository: () => ({
    stats: async () => ({ totalExecutions: 4, totalUsers: 2, byStatus: {}, byKind: {} })
  })
}));

const { default: registerAdminChatHistoryRoutes } = await import('../routes/admin/chatHistory.js');

function createTestApp() {
  const app = express();
  app.use(express.json());
  registerAdminChatHistoryRoutes(app);
  return app;
}

beforeEach(() => {
  state.stored = {
    oidcAuth: { providers: [{ clientSecret: 'ENC[secret]' }] },
    chats: { enabled: true, retentionDays: 90 },
    runLog: { enabled: true, retentionDays: 30 }
  };
  state.features = { chatPersistence: true, runLog: false };
  state.storageReady = true;
  state.sweeps = [];
  state.cleanups = [];
  state.audits = [];
});

describe('GET /api/admin/chat-history', () => {
  test('returns settings with defaults filled in, gate status and stats', async () => {
    const response = await request(createTestApp()).get('/api/admin/chat-history');

    expect(response.status).toBe(200);
    expect(response.body.settings.chats).toEqual({
      enabled: true,
      retentionDays: 90,
      maxChatsPerUser: 200,
      maxMessagesPerChat: 2000
    });
    expect(response.body.settings.runLog).toMatchObject({
      enabled: true,
      identityMode: 'default',
      retentionDays: 30,
      cleanupEnabled: true
    });
    expect(response.body.status).toMatchObject({
      featureChatPersistence: true,
      featureRunLog: false,
      storageReady: true,
      storageProvider: 'filesystem',
      chatPersistenceActive: true,
      ledgerForcedByChats: true
    });
    expect(response.body.stats.chats.totalChats).toBe(7);
    expect(response.body.stats.ledger.totalExecutions).toBe(4);
  });

  test('names the closed gate when storage did not come up', async () => {
    state.storageReady = false;
    const response = await request(createTestApp()).get('/api/admin/chat-history');

    expect(response.body.status.storageReady).toBe(false);
    expect(response.body.status.chatPersistenceActive).toBe(false);
  });
});

describe('PUT /api/admin/chat-history/settings', () => {
  test('merges only the sent fields and leaves the rest of platform.json alone', async () => {
    const response = await request(createTestApp())
      .put('/api/admin/chat-history/settings')
      .send({ chats: { retentionDays: 30, maxMessagesPerChat: 500 } });

    expect(response.status).toBe(200);
    expect(response.body.changed).toEqual(['chats.retentionDays', 'chats.maxMessagesPerChat']);
    expect(state.stored.chats).toEqual({
      enabled: true,
      retentionDays: 30,
      maxMessagesPerChat: 500
    });
    expect(state.stored.runLog).toEqual({ enabled: true, retentionDays: 30 });
    expect(state.stored.oidcAuth.providers[0].clientSecret).toBe('ENC[secret]');
    expect(state.audits).toHaveLength(1);
    expect(response.body.restartRequired).toBe(false);
  });

  test('writes nothing for values that are already in force', async () => {
    const before = JSON.stringify(state.stored);
    const response = await request(createTestApp())
      .put('/api/admin/chat-history/settings')
      .send({
        chats: { enabled: true, retentionDays: 90, maxChatsPerUser: 200 },
        runLog: { retentionDays: 30, flushIntervalMs: 2000 }
      });

    expect(response.status).toBe(200);
    expect(response.body.changed).toEqual([]);
    expect(response.body.restartRequired).toBe(false);
    expect(JSON.stringify(state.stored)).toBe(before);
    expect(state.audits).toHaveLength(0);
  });

  test('flags a restart for the ledger flush interval', async () => {
    const response = await request(createTestApp())
      .put('/api/admin/chat-history/settings')
      .send({ runLog: { flushIntervalMs: 5000, identityMode: 'pseudonymized' } });

    expect(response.status).toBe(200);
    expect(state.stored.runLog).toMatchObject({
      flushIntervalMs: 5000,
      identityMode: 'pseudonymized'
    });
    expect(response.body.restartRequired).toBe(true);
  });

  test.each([
    ['an unknown field', { chats: { retentionWeeks: 4 } }],
    ['an unknown block', { audit: { retentionDays: 1 } }],
    ['a fractional day count', { chats: { retentionDays: 1.5 } }],
    ['a string number', { chats: { maxChatsPerUser: '10' } }],
    ['an unknown identity mode', { runLog: { identityMode: 'open' } }],
    ['a zero flush interval', { runLog: { flushIntervalMs: 0 } }]
  ])('rejects %s without writing', async (_label, body) => {
    const before = JSON.stringify(state.stored);
    const response = await request(createTestApp())
      .put('/api/admin/chat-history/settings')
      .send(body);

    expect(response.status).toBe(400);
    expect(JSON.stringify(state.stored)).toBe(before);
    expect(state.audits).toHaveLength(0);
  });

  test('keeps zero and negative values — they switch a rule off', async () => {
    const response = await request(createTestApp())
      .put('/api/admin/chat-history/settings')
      .send({ chats: { retentionDays: 0, maxChatsPerUser: -1 } });

    expect(response.status).toBe(200);
    expect(state.stored.chats).toMatchObject({ retentionDays: 0, maxChatsPerUser: -1 });
  });
});

describe('POST /api/admin/chat-history/retention/run', () => {
  test('sweeps chats and the ledger with the configured settings', async () => {
    const response = await request(createTestApp())
      .post('/api/admin/chat-history/retention/run')
      .send({});

    expect(response.status).toBe(200);
    expect(response.body.chats).toEqual({ ran: true, removed: 2 });
    expect(response.body.ledger).toEqual({ ran: true, removed: 3 });
    expect(state.sweeps[0]).toMatchObject({ retentionDays: 90, maxChatsPerUser: 200 });
    expect(state.cleanups).toEqual([30]);
  });

  test('never sweeps stored chats while durable chats are off', async () => {
    state.features.chatPersistence = false;
    const response = await request(createTestApp())
      .post('/api/admin/chat-history/retention/run')
      .send({ target: 'chats' });

    expect(response.status).toBe(200);
    expect(response.body.chats).toMatchObject({ ran: false, reason: 'chatPersistenceInactive' });
    expect(response.body.ledger).toBeNull();
    expect(state.sweeps).toHaveLength(0);
  });

  test('skips the ledger when its cleanup is disabled', async () => {
    state.stored.runLog.cleanupEnabled = false;
    const response = await request(createTestApp())
      .post('/api/admin/chat-history/retention/run')
      .send({ target: 'ledger' });

    expect(response.body.ledger).toMatchObject({ ran: false, reason: 'cleanupDisabled' });
    expect(state.cleanups).toHaveLength(0);
  });

  test('rejects an unknown target', async () => {
    const response = await request(createTestApp())
      .post('/api/admin/chat-history/retention/run')
      .send({ target: 'everything' });

    expect(response.status).toBe(400);
  });
});
