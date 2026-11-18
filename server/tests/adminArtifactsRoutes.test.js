// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Admin → Artifacts (`/api/admin/artifacts/config`, #3822): the settings in
 * force with the kit's contents, a PUT that changes only the fields it names,
 * and validation that refuses what the preview would silently drop.
 *
 * Native ESM, so `jest.unstable_mockModule` + dynamic imports. Run with
 * `NODE_OPTIONS=--experimental-vm-modules`.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const state = { platform: {} };

jest.unstable_mockModule('../middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) => next()
}));
jest.unstable_mockModule('../utils/platformConfigStore.js', () => ({
  updatePlatform: async mutate => {
    const next = structuredClone(state.platform);
    await mutate(next);
    state.platform = next;
    return next;
  }
}));
jest.unstable_mockModule('../configCache.js', () => ({
  default: { getPlatform: () => state.cache ?? state.platform, refreshCacheEntry: async () => {} }
}));
jest.unstable_mockModule('../services/AuditLogService.js', () => ({
  logAudit: () => {}
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}));

const { default: registerAdminArtifactRoutes } = await import('../routes/admin/artifacts.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');

const app = express();
app.use(express.json());
registerAdminArtifactRoutes(app);
app.use(errorHandler);

beforeEach(() => {
  state.cache = undefined;
  state.platform = {
    artifacts: { enabled: true, maxBytes: 1234567, scriptHosts: ['cdn.jsdelivr.net'] },
    other: { kept: true }
  };
});

describe('Admin artifact settings', () => {
  it('reads the settings in force, defaults filled in, and the kit', async () => {
    const res = await request(app).get('/api/admin/artifacts/config').expect(200);
    expect(res.body).toMatchObject({
      enabled: true,
      maxBytes: 1234567,
      maxPerBatch: 8,
      maxZipFiles: 200,
      scriptHosts: ['cdn.jsdelivr.net'],
      libraryKit: { enabled: true }
    });
    expect(res.body.libraries.map(library => library.id)).toEqual(['chart.js', 'd3', 'alpinejs']);
    expect(res.body.libraries.every(library => library.available)).toBe(true);
  });

  it('changes only the named fields and keeps the rest of platform.json', async () => {
    const res = await request(app)
      .put('/api/admin/artifacts/config')
      .send({ scriptHosts: [], libraryKit: { enabled: false }, maxPerBatch: 4 })
      .expect(200);
    expect(state.platform.artifacts).toEqual({
      enabled: true,
      maxBytes: 1234567,
      maxPerBatch: 4,
      scriptHosts: [],
      libraryKit: { enabled: false }
    });
    expect(state.platform.other).toEqual({ kept: true });
    expect(res.body.libraryKit).toEqual({ enabled: false });
    expect(res.body.scriptHosts).toEqual([]);
  });

  it('stores hosts normalized', async () => {
    await request(app)
      .put('/api/admin/artifacts/config')
      .send({ scriptHosts: ['https://CDN.Example.com/', 'mirror.intra.example'] })
      .expect(200);
    expect(state.platform.artifacts.scriptHosts).toEqual([
      'cdn.example.com',
      'mirror.intra.example'
    ]);
  });

  it('refuses a field someone else changed meanwhile, and saves unrelated fields', async () => {
    const read = await request(app).get('/api/admin/artifacts/config').expect(200);
    const loaded = read.body;

    // Someone else removes a host in between.
    await request(app)
      .put('/api/admin/artifacts/config')
      .send({ scriptHosts: [], expected: { scriptHosts: loaded.scriptHosts } })
      .expect(200);

    // A stale replacement of the same field is refused, nothing written.
    const before = structuredClone(state.platform);
    const stale = await request(app)
      .put('/api/admin/artifacts/config')
      .send({
        scriptHosts: ['cdn.jsdelivr.net', 'unpkg.com'],
        expected: { scriptHosts: loaded.scriptHosts }
      })
      .expect(412);
    expect(stale.body.code).toBe('PRECONDITION_FAILED');
    expect(stale.body.details).toEqual({ fields: ['scriptHosts'] });
    expect(state.platform).toEqual(before);

    // A change of another field from the same old read still goes through.
    await request(app)
      .put('/api/admin/artifacts/config')
      .send({ maxPerBatch: 3, expected: { maxPerBatch: loaded.maxPerBatch } })
      .expect(200);
    expect(state.platform.artifacts.maxPerBatch).toBe(3);
    expect(state.platform.artifacts.scriptHosts).toEqual([]);
  });

  it("does not count an environment-resolved value as someone else's change", async () => {
    // The file holds a placeholder; the value in force (the cache) is resolved.
    state.platform.artifacts.maxPerBatch = '${ARTIFACT_BATCH}';
    state.cache = { artifacts: { ...state.platform.artifacts, maxPerBatch: 12 } };
    const read = await request(app).get('/api/admin/artifacts/config').expect(200);
    expect(read.body.maxPerBatch).toBe(12);
    await request(app)
      .put('/api/admin/artifacts/config')
      .send({ maxPerBatch: 4, expected: { maxPerBatch: read.body.maxPerBatch } })
      .expect(200);
    expect(state.platform.artifacts.maxPerBatch).toBe(4);
  });

  it.each([
    [{ scriptHosts: ['*.example.com'] }, 400, /Not a plain host name: "\*\.example\.com"/],
    [{ scriptHosts: ['http://cdn.example.com'] }, 400, /Not a plain host name/],
    [{ scriptHosts: ['cdn.example.com:8443'] }, 400, /Not a plain host name/],
    [{ maxBytes: 'big' }, 400, /maxBytes/],
    [{ maxPerBatch: 1.5 }, 400, /maxPerBatch/],
    [{ libraryKit: { enabled: 'yes' } }, 400, /libraryKit\.enabled/],
    [{ libraryKit: { enabled: true, extra: 1 } }, 400, /libraryKit/],
    [{ unknown: true }, 400, /unknown|Unrecognized/i],
    [{ maxBytes: 1, expected: { maxBytes: 'x' } }, 400, /expected\.maxBytes/]
  ])('refuses %j', async (body, status, detail) => {
    const before = structuredClone(state.platform);
    const res = await request(app).put('/api/admin/artifacts/config').send(body).expect(status);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.detail).toMatch(detail);
    expect(state.platform).toEqual(before);
  });
});
