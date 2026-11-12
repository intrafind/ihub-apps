// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Route tests for the installation-wide LLM timeouts (`/api/admin/llm-timeouts`).
 *
 * Pinned here:
 *
 * - GET separates what platform.json holds (`saved`) from what applies without
 *   it (`defaults`) and from what the next request runs with (`effective`);
 * - PUT writes only `llm` in the stored platform.json — never the cache, which
 *   holds environment overrides and decrypted secrets — keeps other `llm` keys,
 *   and removes a key sent as `null` so the default applies again;
 * - a key left out is unchanged; values outside 0–300000, non-integers and
 *   unknown keys are refused with `VALIDATION_FAILED`.
 *
 * Native ESM: run with `NODE_OPTIONS=--experimental-vm-modules`.
 */

import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const state = {};
const reset = () => {
  state.platform = { auth: { mode: 'local' }, llm: { connectTimeoutMs: 30000, other: 'kept' } };
  state.cacheExtra = { jwtSecret: 'decrypted-secret' };
  state.writes = [];
  state.audit = [];
};
reset();

jest.unstable_mockModule('../middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) => {
    req.user = { id: 'admin-user' };
    next();
  }
}));

jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    getPlatform: () => ({ ...state.platform, ...state.cacheExtra }),
    refreshCacheEntry: async () => {}
  }
}));

jest.unstable_mockModule('../services/config/ConfigStore.js', () => ({
  default: {
    // Same read-change-write the real store does for updateJson.
    updateJson: async (_path, mutate) => {
      const current = state.platform;
      const next = await mutate(current === null ? null : structuredClone(current));
      if (next === undefined) return { data: current, written: false };
      state.writes.push(next);
      state.platform = next;
      return { data: next, written: true };
    },
    readJsonStrict: async () => JSON.parse(JSON.stringify(state.platform)),
    writeJson: async (_file, data) => {
      state.writes.push(data);
      state.platform = data;
    }
  }
}));

jest.unstable_mockModule('../services/AuditLogService.js', () => ({
  logAudit: entry => {
    state.audit.push(entry);
    return entry;
  }
}));

jest.unstable_mockModule('../config.js', () => ({
  default: { LLM_CONNECT_TIMEOUT_MS: 30000, LLM_STREAM_IDLE_TIMEOUT_MS: 60000 }
}));

const { default: registerRoutes } = await import('../routes/admin/llmTimeouts.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');

function createApp() {
  const app = express();
  app.use(express.json());
  registerRoutes(app);
  app.use(errorHandler);
  return app;
}

beforeEach(reset);

describe('GET /api/admin/llm-timeouts', () => {
  it('reports saved, default and effective values', async () => {
    const res = await request(createApp()).get('/api/admin/llm-timeouts');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      saved: { connectTimeoutMs: 30000 },
      defaults: { connectTimeoutMs: 30000, streamIdleTimeoutMs: 60000 },
      effective: { connectTimeoutMs: 30000, streamIdleTimeoutMs: 60000 }
    });
  });

  it('shows a saved 0 as saved, not as unset', async () => {
    state.platform.llm.streamIdleTimeoutMs = 0;
    const res = await request(createApp()).get('/api/admin/llm-timeouts');
    expect(res.body.saved.streamIdleTimeoutMs).toBe(0);
    expect(res.body.effective.streamIdleTimeoutMs).toBe(0);
  });
});

describe('PUT /api/admin/llm-timeouts', () => {
  it('saves the given value and keeps the rest of llm and of platform.json', async () => {
    const res = await request(createApp())
      .put('/api/admin/llm-timeouts')
      .send({ streamIdleTimeoutMs: 180000 });
    expect(res.status).toBe(200);
    expect(res.body.saved).toEqual({ connectTimeoutMs: 30000, streamIdleTimeoutMs: 180000 });
    expect(res.body.effective.streamIdleTimeoutMs).toBe(180000);
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0].llm).toEqual({
      connectTimeoutMs: 30000,
      streamIdleTimeoutMs: 180000,
      other: 'kept'
    });
    expect(state.writes[0].auth).toEqual({ mode: 'local' });
    // The cache's decrypted secret never reaches the file.
    expect(state.writes[0].jwtSecret).toBeUndefined();
    expect(state.audit).toHaveLength(1);
    expect(state.audit[0].summary).toMatch(/streamIdleTimeoutMs=180000/);
  });

  it('stores 0 as "no ceiling"', async () => {
    const res = await request(createApp())
      .put('/api/admin/llm-timeouts')
      .send({ streamIdleTimeoutMs: 0 });
    expect(res.status).toBe(200);
    expect(state.platform.llm.streamIdleTimeoutMs).toBe(0);
  });

  it('removes a key sent as null so the default applies again', async () => {
    const res = await request(createApp())
      .put('/api/admin/llm-timeouts')
      .send({ connectTimeoutMs: null });
    expect(res.status).toBe(200);
    expect('connectTimeoutMs' in state.platform.llm).toBe(false);
    expect(res.body.saved).toEqual({});
    expect(res.body.effective.connectTimeoutMs).toBe(30000);
  });

  it.each([
    ['negative', { streamIdleTimeoutMs: -1 }],
    ['above 5 minutes', { connectTimeoutMs: 300001 }],
    ['fractional', { connectTimeoutMs: 1.5 }],
    ['text', { streamIdleTimeoutMs: '60s' }],
    ['unknown key', { somethingElse: 1 }]
  ])('refuses a %s value', async (_label, body) => {
    const res = await request(createApp()).put('/api/admin/llm-timeouts').send(body);
    expect(res.status).toBe(400);
    expect(state.writes).toHaveLength(0);
  });

  it('refuses a request that changes nothing', async () => {
    const res = await request(createApp()).put('/api/admin/llm-timeouts').send({});
    expect(res.status).toBe(400);
    expect(state.writes).toHaveLength(0);
  });
});
