// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The agent profile administration routes answer errors through the global
 * error middleware: an unsafe or unknown profile id, a missing or mismatched
 * id, a profile that does not validate (VALIDATION_FAILED with `errors`), a
 * profile that exists already, a memory write that lost the version race (with
 * `details.currentVersion`) and an unexpected failure.
 *
 * Native ESM, so `jest.unstable_mockModule` + dynamic imports. Run with
 * `NODE_OPTIONS=--experimental-vm-modules`.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const state = { profiles: [], createError: null, writeMemoryError: null, listError: null };

jest.unstable_mockModule('../middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) => next()
}));
jest.unstable_mockModule('../services/config/ConfigStore.js', () => ({
  default: {
    createJson: async () => {
      if (state.createError) throw state.createError;
    },
    writeJson: async () => {}
  }
}));
jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    getAgentProfiles: () => {
      if (state.listError) throw state.listError;
      return { data: state.profiles, etag: null };
    },
    refreshAgentProfilesCache: async () => {}
  }
}));
jest.unstable_mockModule('../agents/memory/memoryFile.js', () => ({
  default: {
    writeMemory: async () => {
      throw state.writeMemoryError;
    }
  }
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}));

const { default: registerAdminAgentsRoutes } = await import('../routes/admin/agents.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');
const { ServiceError } = await import('../utils/ServiceError.js');

const app = express();
app.use(express.json());
registerAdminAgentsRoutes(app);
app.use(errorHandler);

beforeEach(() => {
  state.profiles = [];
  state.createError = null;
  state.writeMemoryError = null;
  state.listError = null;
});

describe('agent administration routes: errors', () => {
  it('answers an unsafe id with BAD_REQUEST and an unknown profile with NOT_FOUND', async () => {
    const unsafe = await request(app).get('/api/admin/agents/profiles/bad%20id').expect(400);
    expect(unsafe.body.code).toBe('BAD_REQUEST');
    const missing = await request(app).get('/api/admin/agents/profiles/nobody').expect(404);
    expect(missing.body).toMatchObject({ code: 'NOT_FOUND', detail: 'Profile nobody not found' });
  });

  it('answers a missing id and an id that differs from the URL with BAD_REQUEST', async () => {
    const none = await request(app).post('/api/admin/agents/profiles').send({}).expect(400);
    expect(none.body).toMatchObject({ code: 'BAD_REQUEST', detail: 'Profile id is required' });
    const differs = await request(app)
      .put('/api/admin/agents/profiles/a1')
      .send({ id: 'a2' })
      .expect(400);
    expect(differs.body.detail).toBe('Profile id in URL must match payload id');
  });

  it('answers a profile that does not validate with VALIDATION_FAILED and the fields', async () => {
    const res = await request(app)
      .post('/api/admin/agents/profiles')
      .send({ id: 'a1', name: 42 })
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(Array.isArray(res.body.errors)).toBe(true);
  });

  it('answers a memory write that lost the version race with VERSION_CONFLICT and the current version', async () => {
    state.writeMemoryError = new ServiceError('VERSION_CONFLICT', 'Memory version mismatch', {
      details: { currentVersion: 7 }
    });
    const res = await request(app)
      .put('/api/admin/agents/profiles/a1/memory')
      .send({ content: 'x', expectedVersion: 3 })
      .expect(409);
    expect(res.body).toMatchObject({ code: 'VERSION_CONFLICT', details: { currentVersion: 7 } });
  });

  it('keeps an unexpected failure hidden behind the fixed text', async () => {
    state.listError = new Error('ENOENT: no such file /srv/contents/config/agents/a.json');
    const res = await request(app).get('/api/admin/agents/profiles').expect(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
    expect(res.body.detail).not.toMatch(/srv|contents/);
  });
});
