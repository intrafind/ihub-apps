/**
 * Route tests for `PUT /api/admin/office-integration/config` with `allowedApps`.
 *
 * The app limit lives in the add-in's OAuth client, everything else in
 * platform.json. The two files cannot be saved as one transaction, so the order
 * of the two writes decides what a failure leaves behind. The rule under test:
 * an error response never comes with a changed access policy.
 *
 * - the platform write goes first and the access change last, so a failed
 *   platform write leaves app access exactly as it was;
 * - a request that fails validation writes nothing at all.
 *
 * The route and its validators are real; only the stores, the audit log and
 * admin auth are stubbed.
 *
 * Note: The repo's source is native ESM, so this file uses
 * `jest.unstable_mockModule` + dynamic imports. Run with
 * `NODE_OPTIONS=--experimental-vm-modules`.
 */

import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const CLIENT_ID = 'client_office_add_in_test';

const state = {};
const reset = () => {
  state.calls = [];
  state.platformError = null;
  state.clientError = null;
  state.audit = [];
  state.platform = {
    oauth: { enabled: { clients: true } },
    officeIntegration: { enabled: true, oauthClientId: CLIENT_ID, defaultMailAction: 'auto' }
  };
  state.client = { clientId: CLIENT_ID, allowedApps: [] };
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
    getPlatform: () => state.platform,
    refreshCacheEntry: async () => {}
  }
}));

jest.unstable_mockModule('../services/config/ConfigStore.js', () => ({
  default: {
    writeJson: async () => {
      state.calls.push('platform');
      if (state.platformError) throw state.platformError;
    }
  }
}));

jest.unstable_mockModule('../utils/oauthClientManager.js', () => ({
  createOAuthClient: async () => {
    throw new Error('not expected: the integration is already enabled');
  },
  loadOAuthClients: () => ({
    clients: state.client ? { [state.client.clientId]: state.client } : {}
  }),
  findClientById: (config, id) => (config.clients[id] ? { ...config.clients[id] } : null),
  updateOAuthClient: async (id, updates) => {
    state.calls.push('client');
    if (state.clientError) throw state.clientError;
    state.client = { ...state.client, ...updates };
    return state.client;
  }
}));

jest.unstable_mockModule('../services/AuditLogService.js', () => ({
  logAudit: entry => {
    state.audit.push(entry);
    return entry;
  }
}));

jest.unstable_mockModule('../utils/contentsPath.js', () => ({
  oauthClientsFile: () => 'config/oauth-clients.json'
}));

const { default: registerRoutes } = await import('../routes/admin/officeIntegration.js');

const app = express();
app.use(express.json());
registerRoutes(app);

const put = body => request(app).put('/api/admin/office-integration/config').send(body);

beforeEach(reset);

describe('PUT /config with allowedApps', () => {
  test('saves the platform config first and the access change last', async () => {
    const res = await put({ defaultMailAction: 'answer', allowedApps: ['summarizer'] });

    expect(res.status).toBe(200);
    expect(state.calls).toEqual(['platform', 'client']);
    expect(state.client.allowedApps).toEqual(['summarizer']);
    expect(state.audit).toHaveLength(1);
    expect(state.audit[0]).toMatchObject({ resource: 'oauthClient', resourceId: CLIENT_ID });
  });

  test('a failed platform write leaves app access untouched and reports the failure', async () => {
    // The case that matters: an error response must not coincide with a new policy.
    state.platformError = new Error('disk full');

    const res = await put({ defaultMailAction: 'answer', allowedApps: ['summarizer'] });

    expect(res.status).toBe(500);
    expect(state.calls).toEqual(['platform']);
    expect(state.client.allowedApps).toEqual([]);
    expect(state.audit).toHaveLength(0);
  });

  test('a failed access write reports the failure', async () => {
    // The accepted direction of the trade-off: what stays saved is configuration
    // that is harmless to save again, and the admin is told to.
    state.clientError = new Error('disk full');

    const res = await put({ defaultMailAction: 'answer', allowedApps: ['summarizer'] });

    expect(res.status).toBe(500);
    expect(state.calls).toEqual(['platform', 'client']);
    expect(state.client.allowedApps).toEqual([]);
    expect(state.audit).toHaveLength(0);
  });

  test('a request that fails validation writes nothing', async () => {
    for (const allowedApps of [[], 'summarizer', ['ok-app', '../etc/passwd']]) {
      const res = await put({ defaultMailAction: 'answer', allowedApps });

      expect(res.status).toBe(400);
    }
    expect(state.calls).toEqual([]);
    expect(state.client.allowedApps).toEqual([]);
  });

  test('a bad field elsewhere in the request keeps the access change from being written', async () => {
    const res = await put({ defaultMailAction: 'not-an-action', allowedApps: ['summarizer'] });

    expect(res.status).toBe(400);
    expect(state.calls).toEqual([]);
    expect(state.client.allowedApps).toEqual([]);
  });

  test('without an OAuth client there is nothing to limit, and nothing is written', async () => {
    state.client = null;

    const res = await put({ allowedApps: ['summarizer'] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no OAuth client/);
    expect(state.calls).toEqual([]);
  });

  test('a save that leaves allowedApps out does not touch the OAuth client', async () => {
    state.client.allowedApps = ['summarizer'];

    const res = await put({ defaultMailAction: 'answer' });

    expect(res.status).toBe(200);
    expect(state.calls).toEqual(['platform']);
    expect(state.client.allowedApps).toEqual(['summarizer']);
  });
});

describe('GET /status app access', () => {
  const status = () => request(app).get('/api/admin/office-integration/status');

  test('reports the limit the OAuth client holds', async () => {
    state.client.allowedApps = ['summarizer', 'translator'];

    const res = await status();

    expect(res.status).toBe(200);
    expect(res.body.appAccess).toEqual({ mode: 'limited', appIds: ['summarizer', 'translator'] });
  });

  test('an unrestricted client reads as all apps', async () => {
    for (const allowedApps of [[], ['*']]) {
      state.client.allowedApps = allowedApps;
      expect((await status()).body.appAccess).toEqual({ mode: 'all', appIds: [] });
    }
  });

  test('a deleted OAuth client is null, not a made-up "all apps"', async () => {
    state.client = null;

    expect((await status()).body.appAccess).toBeNull();
  });
});
