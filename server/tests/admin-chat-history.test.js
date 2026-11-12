// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

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
    // Same read-change-write the real store does for updateJson.
    updateJson: async (_path, mutate) => {
      const current = state.stored;
      const next = await mutate(current === null ? null : structuredClone(current));
      if (next === undefined) return { data: current, written: false };
      state.stored = JSON.parse(JSON.stringify(next));
      return { data: next, written: true };
    },
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
const { default: errorHandler } = await import('../middleware/errorHandler.js');

function createTestApp() {
  const app = express();
  app.use(express.json());
  registerAdminChatHistoryRoutes(app);
  app.use(errorHandler);
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
      maxMessagesPerChat: 2000,
      temporaryRetentionHours: 24
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

describe('uploaded files settings (platform.uploads)', () => {
  test('reads the effective upload settings with defaults filled in', async () => {
    const response = await request(createTestApp()).get('/api/admin/chat-history');

    expect(response.status).toBe(200);
    expect(response.body.settings.uploads).toEqual({
      enabled: true,
      storageMode: 'original_and_text',
      originalRetentionDays: 14,
      evictOldestOriginalsOnQuota: true,
      quotas: {
        maxFileBytes: 25 * 1024 * 1024,
        maxChatBytes: 100 * 1024 * 1024,
        maxChatFiles: 25,
        maxUserBytes: 1024 * 1024 * 1024,
        maxServerBytes: 50 * 1024 * 1024 * 1024,
        maxApiFiles: 200,
        maxApiBytes: 1024 * 1024 * 1024
      }
    });
  });

  test('writes the Inference API limits of the user scope', async () => {
    const response = await request(createTestApp())
      .put('/api/admin/chat-history/settings')
      .send({ uploads: { quotas: { maxApiFiles: 50, maxApiBytes: 0 } } });

    expect(response.status).toBe(200);
    expect(response.body.changed).toEqual([
      'uploads.quotas.maxApiFiles',
      'uploads.quotas.maxApiBytes'
    ]);
    expect(state.stored.uploads.quotas).toEqual({ maxApiFiles: 50, maxApiBytes: 0 });
    expect(response.body.settings.uploads.quotas.maxApiFiles).toBe(50);
    expect(response.body.settings.uploads.quotas.maxApiBytes).toBe(0);
  });

  test('writes the mode, retention and quotas, changed values only', async () => {
    state.stored.uploads = { quotas: { maxChatFiles: 10 } };
    const response = await request(createTestApp())
      .put('/api/admin/chat-history/settings')
      .send({
        uploads: {
          storageMode: 'client_text_only',
          originalRetentionDays: 7,
          quotas: { maxChatFiles: 10, maxUserBytes: 500 * 1024 * 1024, maxServerBytes: 0 }
        }
      });

    expect(response.status).toBe(200);
    expect(response.body.changed).toEqual([
      'uploads.storageMode',
      'uploads.originalRetentionDays',
      'uploads.quotas.maxUserBytes',
      'uploads.quotas.maxServerBytes'
    ]);
    expect(state.stored.uploads).toEqual({
      storageMode: 'client_text_only',
      originalRetentionDays: 7,
      quotas: { maxChatFiles: 10, maxUserBytes: 500 * 1024 * 1024, maxServerBytes: 0 }
    });
    expect(response.body.settings.uploads.storageMode).toBe('client_text_only');
    expect(response.body.restartRequired).toBe(false);
  });

  test.each([
    ['an unknown storage mode', { uploads: { storageMode: 'everything' } }],
    ['an unknown upload field', { uploads: { retentionYears: 1 } }],
    ['an unknown quota', { uploads: { quotas: { maxPetabytes: 1 } } }],
    ['a fractional quota', { uploads: { quotas: { maxChatFiles: 1.5 } } }]
  ])('rejects %s without writing', async (_label, body) => {
    const before = JSON.stringify(state.stored);
    const response = await request(createTestApp())
      .put('/api/admin/chat-history/settings')
      .send(body);

    expect(response.status).toBe(400);
    expect(JSON.stringify(state.stored)).toBe(before);
  });
});

describe('POST /api/admin/chat-history/retention/_run', () => {
  test('sweeps chats and the ledger with the configured settings', async () => {
    const response = await request(createTestApp())
      .post('/api/admin/chat-history/retention/_run')
      .send({});

    expect(response.status).toBe(200);
    expect(response.body.chats).toEqual({ ran: true, removed: 2 });
    expect(response.body.ledger).toEqual({ ran: true, removed: 3 });
    expect(state.sweeps[0]).toMatchObject({ retentionDays: 90, maxChatsPerUser: 200 });
    expect(state.cleanups).toEqual([30]);
  });

  test('with the chat history off, sweeps only temporary chats — never the kept ones', async () => {
    state.features.chatPersistence = false;
    const response = await request(createTestApp())
      .post('/api/admin/chat-history/retention/_run')
      .send({ target: 'chats' });

    expect(response.status).toBe(200);
    expect(response.body.chats).toMatchObject({ ran: true, historyRules: false });
    expect(response.body.ledger).toBeNull();
    expect(state.sweeps).toHaveLength(1);
    expect(state.sweeps[0]).toMatchObject({
      retentionDays: 0,
      maxChatsPerUser: 0,
      temporaryRetentionHours: 24
    });
  });

  test('never sweeps anything while storage is down', async () => {
    state.storageReady = false;
    const response = await request(createTestApp())
      .post('/api/admin/chat-history/retention/_run')
      .send({ target: 'chats' });

    expect(response.status).toBe(200);
    expect(response.body.chats).toMatchObject({ ran: false, reason: 'chatPersistenceInactive' });
    expect(state.sweeps).toHaveLength(0);
  });

  test('skips the ledger when its cleanup is disabled', async () => {
    state.stored.runLog.cleanupEnabled = false;
    const response = await request(createTestApp())
      .post('/api/admin/chat-history/retention/_run')
      .send({ target: 'ledger' });

    expect(response.body.ledger).toMatchObject({ ran: false, reason: 'cleanupDisabled' });
    expect(state.cleanups).toHaveLength(0);
  });

  test('rejects an unknown target', async () => {
    const response = await request(createTestApp())
      .post('/api/admin/chat-history/retention/_run')
      .send({ target: 'everything' });

    expect(response.status).toBe(400);
  });
});
