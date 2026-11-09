// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The agent artifact routes answer errors through the global error middleware
 * (RFC 9457 problem+json with a registry `code`). The 404 for an unknown run
 * and the 403 for a run the caller did not trigger must reach the client as
 * such: only a failing engine lookup is the generic "Authorization check
 * failed." answer.
 *
 * Run with `NODE_OPTIONS=--experimental-vm-modules`.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import * as realAuthRequired from '../middleware/authRequired.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-artifacts-'));
const state = { runs: {}, getStateFails: false };

jest.unstable_mockModule('../middleware/authRequired.js', () => ({
  ...realAuthRequired,
  authRequired: (req, res, next) => next()
}));
jest.unstable_mockModule('../utils/contentsPath.js', () => ({
  getContentsPath: (...segments) => path.join(tmpRoot, ...segments)
}));
jest.unstable_mockModule('../services/workflow/index.js', () => ({
  getWorkflowEngine: () => ({
    getState: async runId => {
      if (state.getStateFails) throw new Error('engine down: secret-internal-detail');
      return state.runs[runId] || null;
    }
  })
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}));

const { default: registerAgentArtifactRoutes } = await import('../routes/agents/artifacts.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');

let user = { id: 'owner', groups: ['users'] };
const app = express();
app.use((req, res, next) => {
  req.user = user;
  next();
});
registerAgentArtifactRoutes(app);
app.use(errorHandler);

const GENERIC = 'Authorization check failed.';

beforeAll(() => {
  const dir = path.join(tmpRoot, 'data', 'agent-artifacts', 'run1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'report.md'), '# Report');
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  user = { id: 'owner', groups: ['users'] };
  state.getStateFails = false;
  state.runs = { run1: { data: { _agent: { triggeredBy: { userId: 'owner' } } } } };
});

describe('agent artifact routes: errors', () => {
  it('answers an unknown run with NOT_FOUND naming the run, not the generic message', async () => {
    const res = await request(app).get('/api/agents/runs/ghost/artifacts').expect(404);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.code).toBe('NOT_FOUND');
    expect(res.body.detail).toContain('ghost');
    expect(res.body.detail).not.toBe(GENERIC);
    expect(res.body.code).not.toBe('FORBIDDEN');
  });

  it('answers a user who did not trigger the run with FORBIDDEN "not allowed"', async () => {
    user = { id: 'intruder', groups: ['users'] };
    const res = await request(app).get('/api/agents/runs/run1/artifacts').expect(403);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.code).toBe('FORBIDDEN');
    expect(res.body.detail).toMatch(/not allowed/);
    expect(res.body.detail).not.toBe(GENERIC);
  });

  it('allows the user who triggered the run', async () => {
    const res = await request(app).get('/api/agents/runs/run1/artifacts').expect(200);
    expect(res.body.map(a => a.name)).toEqual(['report.md']);
  });

  it('allows an administrator, even for a run they did not trigger', async () => {
    user = { id: 'boss', isAdmin: true, groups: ['admins'] };
    await request(app).get('/api/agents/runs/run1/artifacts').expect(200);
  });

  it('answers an admin on a run without artifacts with an empty list', async () => {
    user = { id: 'boss', isAdmin: true, groups: ['admins'] };
    const res = await request(app).get('/api/agents/runs/norun/artifacts').expect(200);
    expect(res.body).toEqual([]);
  });

  it('answers a failing engine lookup with the generic FORBIDDEN, without leaking the cause', async () => {
    state.getStateFails = true;
    const res = await request(app).get('/api/agents/runs/run1/artifacts').expect(403);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.code).toBe('FORBIDDEN');
    expect(res.body.detail).toBe(GENERIC);
    expect(JSON.stringify(res.body)).not.toContain('secret-internal-detail');
  });

  it('answers an invalid run id with BAD_REQUEST', async () => {
    const res = await request(app).get('/api/agents/runs/bad$id/artifacts').expect(400);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.code).toBe('BAD_REQUEST');
    expect(res.body.detail).toMatch(/Invalid run ID/);
  });

  it('answers an invalid run id on the file route with BAD_REQUEST', async () => {
    const res = await request(app).get('/api/agents/runs/bad$id/artifacts/report.md').expect(400);
    expect(res.body.code).toBe('BAD_REQUEST');
  });

  it('answers an unsafe artifact name with BAD_REQUEST', async () => {
    const res = await request(app).get('/api/agents/runs/run1/artifacts/.hidden').expect(400);
    expect(res.body.code).toBe('BAD_REQUEST');
    expect(res.body.detail).toBe('invalid artifact name');
  });

  it('answers an unknown artifact file with NOT_FOUND', async () => {
    const res = await request(app).get('/api/agents/runs/run1/artifacts/missing.md').expect(404);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.code).toBe('NOT_FOUND');
    expect(res.body.detail).toBe('artifact not found');
  });

  it('answers an unknown run on the file route with NOT_FOUND, not the generic FORBIDDEN', async () => {
    const res = await request(app).get('/api/agents/runs/ghost/artifacts/report.md').expect(404);
    expect(res.body.code).toBe('NOT_FOUND');
    expect(res.body.detail).toContain('ghost');
    expect(res.body.detail).not.toBe(GENERIC);
  });

  it('answers a foreign user on the file route with FORBIDDEN "not allowed"', async () => {
    user = { id: 'intruder', groups: ['users'] };
    const res = await request(app).get('/api/agents/runs/run1/artifacts/report.md').expect(403);
    expect(res.body.code).toBe('FORBIDDEN');
    expect(res.body.detail).toMatch(/not allowed/);
    expect(res.body.detail).not.toBe(GENERIC);
  });

  it('serves an existing artifact to the triggering user', async () => {
    const res = await request(app).get('/api/agents/runs/run1/artifacts/report.md').expect(200);
    expect(res.text).toBe('# Report');
  });
  it('answers a read error before the first byte as an ordinary 500, not an unhandled stream error', async () => {
    const spy = jest.spyOn(fs, 'createReadStream').mockImplementation(
      () =>
        new Readable({
          read() {
            this.destroy(new Error('EIO: disk fault at /secret/path'));
          }
        })
    );
    try {
      const res = await request(app).get('/api/agents/runs/run1/artifacts/report.md?download=1');
      expect(res.status).toBe(500);
      expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
      expect(res.body.code).toBe('INTERNAL_ERROR');
      expect(res.headers['content-disposition']).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toContain('/secret/path');
    } finally {
      spy.mockRestore();
    }
  });

  // Keep this the last test of the file: it spends the rest of the route's rate-limit window.
  it('rate-limits listing and reading artifacts', async () => {
    let status = null;
    for (let i = 0; i < 80 && status !== 429; i += 1) {
      status = (await request(app).get('/api/agents/runs/ghost/artifacts')).status;
    }
    expect(status).toBe(429);
  });
});
