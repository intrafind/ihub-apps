import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * Admin API for remote A2A agents (routes/admin/a2aAgents.js) against an
 * in-memory a2aAgents.json: writes go through ConfigStore, refresh the cache
 * entry and re-initialise the manager.
 */

const state = { file: null, writes: [], refreshed: [], initialized: [] };

jest.unstable_mockModule('../../services/config/ConfigStore.js', () => ({
  default: {
    writeJson: async (file, data) => {
      state.writes.push({ file, data: structuredClone(data) });
      state.file = structuredClone(data);
    }
  }
}));
jest.unstable_mockModule('../../configCache.js', () => ({
  default: {
    getA2aAgents: () => ({ data: structuredClone(state.file), etag: null }),
    refreshCacheEntry: async key => state.refreshed.push(key),
    getPlatform: () => ({})
  },
  resolveEnvVarsInObject: value => value
}));
jest.unstable_mockModule('../../middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) =>
    req.headers['x-admin'] === 'yes' ? next() : res.status(401).json({ error: 'no' })
}));
const manager = {
  initialize: jest.fn(async data => state.initialized.push(data)),
  status: jest.fn(() => [{ id: 'langdock', connected: true, toolCount: 1 }]),
  testConnection: jest.fn(async id => {
    if (id !== 'langdock') throw new Error(`A2A agent not found: ${id}`);
    return { status: { id }, card: { name: 'L' }, skills: [{ id: 's' }] };
  }),
  testConfig: jest.fn(async cfg => {
    if (!cfg.cardUrl) {
      const err = new Error('Invalid agent config');
      err.details = [{ path: ['cardUrl'] }];
      throw err;
    }
    return { status: {}, card: { name: 'Draft' }, skills: [{ id: 'x', allowed: true }] };
  }),
  listSkillsByAgent: jest.fn(async () => [{ id: 'langdock', skills: [], error: null }])
};
jest.unstable_mockModule('../../services/a2a/A2aClientManager.js', () => ({ default: manager }));

const { default: registerAdminA2aAgentsRoutes } = await import('../../routes/admin/a2aAgents.js');

const app = express();
app.use(express.json());
registerAdminA2aAgentsRoutes(app);
const admin = r => r.set('X-Admin', 'yes');

const langdock = {
  id: 'langdock',
  name: 'Langdock',
  cardUrl: 'https://agent.example.com/.well-known/agent-card.json',
  auth: { type: 'apiKey', valueRef: 'langdock-key' }
};

beforeEach(() => {
  state.file = { agents: [], security: { blockPrivateIps: true, allowedHosts: [] } };
  state.writes.length = 0;
  state.refreshed.length = 0;
  state.initialized.length = 0;
});

describe('admin A2A agent routes', () => {
  it('require an admin', async () => {
    expect((await request(app).get('/api/admin/a2a/agents')).status).toBe(401);
  });

  it('create an agent with defaults, write it through ConfigStore and reload', async () => {
    const res = await admin(request(app).post('/api/admin/a2a/agents')).send(langdock);
    expect(res.status).toBe(201);
    expect(res.body.agent).toMatchObject({ id: 'langdock', timeoutMs: 60000, streaming: 'auto' });
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0].file).toBe('config/a2aAgents.json');
    expect(state.refreshed).toEqual(['config/a2aAgents.json']);
    expect(state.initialized[0].agents.map(a => a.id)).toEqual(['langdock']);

    const list = await admin(request(app).get('/api/admin/a2a/agents'));
    expect(list.body.agents[0]).toMatchObject({ id: 'langdock', status: { connected: true } });
  });

  it('refuse a duplicate id with 409 and an invalid config with 400', async () => {
    await admin(request(app).post('/api/admin/a2a/agents')).send(langdock);
    const dup = await admin(request(app).post('/api/admin/a2a/agents')).send(langdock);
    expect(dup.status).toBe(409);
    const bad = await admin(request(app).post('/api/admin/a2a/agents')).send({
      ...langdock,
      id: 'x',
      cardUrl: 'http://agent.example.com/card'
    });
    expect(bad.status).toBe(400);
    expect(bad.body.details.length).toBeGreaterThan(0);
    expect(state.writes).toHaveLength(1);
  });

  it('update and delete an agent, 404 for unknown ones', async () => {
    await admin(request(app).post('/api/admin/a2a/agents')).send(langdock);
    const put = await admin(request(app).put('/api/admin/a2a/agents/langdock')).send({
      ...langdock,
      id: 'ignored',
      timeoutMs: 120000
    });
    expect(put.status).toBe(200);
    expect(state.file.agents[0]).toMatchObject({ id: 'langdock', timeoutMs: 120000 });

    expect(
      (await admin(request(app).put('/api/admin/a2a/agents/missing')).send(langdock)).status
    ).toBe(404);
    expect((await admin(request(app).delete('/api/admin/a2a/agents/missing'))).status).toBe(404);
    expect((await admin(request(app).delete('/api/admin/a2a/agents/langdock'))).status).toBe(204);
    expect(state.file.agents).toEqual([]);
  });

  it('refuse an unsafe id in the path', async () => {
    const res = await admin(request(app).delete('/api/admin/a2a/agents/bad%20id'));
    expect(res.status).toBe(400);
  });

  it('test a saved agent and an unsaved draft', async () => {
    const saved = await admin(request(app).post('/api/admin/a2a/agents/langdock/test'));
    expect(saved.body).toMatchObject({ success: true, card: { name: 'L' }, skills: [{ id: 's' }] });
    const missing = await admin(request(app).post('/api/admin/a2a/agents/other/test'));
    expect(missing.status).toBe(400);

    const draft = await admin(request(app).post('/api/admin/a2a/test')).send(langdock);
    expect(draft.body).toMatchObject({ success: true, card: { name: 'Draft' } });
    const invalid = await admin(request(app).post('/api/admin/a2a/test')).send({ id: 'x' });
    expect(invalid.status).toBe(400);
    expect(invalid.body.details).toEqual([{ path: ['cardUrl'] }]);
  });

  it('serve the health snapshot and the skill catalog', async () => {
    const status = await admin(request(app).get('/api/admin/a2a/status'));
    expect(status.body.agents[0].id).toBe('langdock');
    const skills = await admin(request(app).get('/api/admin/a2a/skills'));
    expect(skills.body).toEqual({
      success: true,
      agents: [{ id: 'langdock', skills: [], error: null }]
    });
  });

  it('never touch the file system directly', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = fs.readFileSync(path.join(here, '../../routes/admin/a2aAgents.js'), 'utf8');
    expect(source).not.toMatch(/from ['"](node:)?fs(\/promises)?['"]/);
    expect(source).toMatch(/configStore\.writeJson/);
  });
});
