/**
 * Dynamic client registration de-duplication.
 *
 * Claude re-registers on every fresh connection, so before this every user who
 * added iHub as a custom connector created another indistinguishable record in
 * `oauth-clients.json` and `oauth.dcr.maxClients` (default 100) became a cap on
 * *users*. A public registration with byte-identical metadata now gets the
 * client_id it was already issued.
 *
 * Locked in here:
 * - two identical public registrations return the same client_id, and the
 *   second bumps the registration counter instead of writing a record,
 * - a differing redirect URI is different software and gets its own record,
 * - a confidential registration mints a secret and is therefore never merged,
 * - maxClients counts distinct records, so a repeat registration still
 *   succeeds once the cap is reached — that is the cliff this removes.
 *
 * Native-ESM jest (`NODE_OPTIONS=--experimental-vm-modules`); see the
 * `test:oauth` npm script, which `test:quick` chains in.
 */

import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const CLIENTS_KEY = 'config/oauth-clients.json';

// The client store is a JSON file behind configCache + configStore. Both are
// replaced with an in-memory pair so the real registration logic runs against
// a real store shape without touching the repository's contents/.
const state = {
  platform: {},
  store: { clients: {}, metadata: { version: '1.0.0' } }
};

jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    getPlatform: () => state.platform,
    get: key => (key === CLIENTS_KEY ? { data: state.store } : null),
    setCacheEntry: (key, data) => {
      if (key === CLIENTS_KEY) state.store = data;
    }
  }
}));

jest.unstable_mockModule('../services/config/ConfigStore.js', () => ({
  default: {
    writeJson: async (_relPath, data) => {
      state.store = data;
    }
  }
}));

jest.unstable_mockModule('../configSync.js', () => ({
  announceConfigChange: () => {}
}));

jest.unstable_mockModule('../services/AuditLogService.js', () => ({
  logAudit: () => {}
}));

const { default: registerOAuthRegisterRoutes } = await import('../routes/oauthRegister.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  registerOAuthRegisterRoutes(app);
  return app;
}

function resetState({ maxClients = 100 } = {}) {
  state.platform = {
    oauth: {
      enabled: { authz: true, clients: true },
      clientsFile: 'contents/config/oauth-clients.json',
      dcr: { enabled: true, maxClients }
    }
  };
  state.store = { clients: {}, metadata: { version: '1.0.0' } };
}

const claudeRegistration = {
  client_name: 'Claude',
  redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none'
};

function storedClients() {
  return Object.values(state.store.clients || {});
}

describe('DCR de-duplication', () => {
  beforeEach(() => resetState());

  test('two identical public registrations return the same client_id', async () => {
    const app = buildApp();

    const first = await request(app).post('/api/oauth/register').send(claudeRegistration);
    expect(first.status).toBe(201);

    const second = await request(app).post('/api/oauth/register').send(claudeRegistration);
    expect(second.status).toBe(201);

    expect(second.body.client_id).toBe(first.body.client_id);
    expect(second.body.client_id_issued_at).toBe(first.body.client_id_issued_at);
    expect(storedClients()).toHaveLength(1);
  });

  test('a repeat registration bumps the counter rather than writing a record', async () => {
    const app = buildApp();

    await request(app).post('/api/oauth/register').send(claudeRegistration);
    expect(storedClients()[0].metadata.registrationCount).toBe(1);

    await request(app).post('/api/oauth/register').send(claudeRegistration);
    await request(app).post('/api/oauth/register').send(claudeRegistration);

    expect(storedClients()).toHaveLength(1);
    expect(storedClients()[0].metadata.registrationCount).toBe(3);
    expect(storedClients()[0].metadata.lastRegisteredAt).toEqual(expect.any(String));
  });

  test('reordered redirect URIs are still the same software', async () => {
    const app = buildApp();
    const twoUris = {
      ...claudeRegistration,
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback', 'http://localhost/callback']
    };

    const first = await request(app).post('/api/oauth/register').send(twoUris);
    const second = await request(app)
      .post('/api/oauth/register')
      .send({ ...twoUris, redirect_uris: [...twoUris.redirect_uris].reverse() });

    expect(second.body.client_id).toBe(first.body.client_id);
    expect(storedClients()).toHaveLength(1);
  });

  test('a different redirect URI gets its own client', async () => {
    const app = buildApp();

    const first = await request(app).post('/api/oauth/register').send(claudeRegistration);
    const second = await request(app)
      .post('/api/oauth/register')
      .send({ ...claudeRegistration, redirect_uris: ['https://other.example.com/callback'] });

    expect(second.body.client_id).not.toBe(first.body.client_id);
    expect(storedClients()).toHaveLength(2);
  });

  test('a different client name gets its own client', async () => {
    const app = buildApp();

    const first = await request(app).post('/api/oauth/register').send(claudeRegistration);
    const second = await request(app)
      .post('/api/oauth/register')
      .send({ ...claudeRegistration, client_name: 'Cursor' });

    expect(second.body.client_id).not.toBe(first.body.client_id);
    expect(storedClients()).toHaveLength(2);
  });

  test('confidential registrations are never de-duplicated', async () => {
    const app = buildApp();
    const confidential = {
      ...claudeRegistration,
      token_endpoint_auth_method: 'client_secret_post'
    };

    const first = await request(app).post('/api/oauth/register').send(confidential);
    const second = await request(app).post('/api/oauth/register').send(confidential);

    expect(first.body.client_secret).toEqual(expect.any(String));
    expect(second.body.client_secret).toEqual(expect.any(String));
    expect(second.body.client_secret).not.toBe(first.body.client_secret);
    expect(second.body.client_id).not.toBe(first.body.client_id);
    expect(storedClients()).toHaveLength(2);
  });

  test('a public registration never returns a secret', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/oauth/register').send(claudeRegistration);

    expect(res.body.client_secret).toBeUndefined();
  });

  test('maxClients counts distinct records, and a repeat still succeeds at the cap', async () => {
    resetState({ maxClients: 2 });
    const app = buildApp();

    const claude = await request(app).post('/api/oauth/register').send(claudeRegistration);
    await request(app)
      .post('/api/oauth/register')
      .send({ ...claudeRegistration, client_name: 'Cursor' });
    expect(storedClients()).toHaveLength(2);

    // A third distinct registration is refused...
    const third = await request(app)
      .post('/api/oauth/register')
      .send({ ...claudeRegistration, client_name: 'VS Code' });
    expect(third.status).toBe(400);
    expect(third.body.error).toBe('invalid_client_metadata');

    // ...but an existing one still connects, which is the cliff this removes.
    const repeat = await request(app).post('/api/oauth/register').send(claudeRegistration);
    expect(repeat.status).toBe(201);
    expect(repeat.body.client_id).toBe(claude.body.client_id);
    expect(storedClients()).toHaveLength(2);
  });

  test('registration stays 404 while the feature is off', async () => {
    resetState();
    state.platform.oauth.dcr.enabled = false;
    const app = buildApp();

    const res = await request(app).post('/api/oauth/register').send(claudeRegistration);
    expect(res.status).toBe(404);
  });

  test('a suspended dynamic client is not handed out again', async () => {
    const app = buildApp();

    const first = await request(app).post('/api/oauth/register').send(claudeRegistration);
    state.store.clients[first.body.client_id].active = false;

    const second = await request(app).post('/api/oauth/register').send(claudeRegistration);
    expect(second.body.client_id).not.toBe(first.body.client_id);
    expect(storedClients()).toHaveLength(2);
  });
});
