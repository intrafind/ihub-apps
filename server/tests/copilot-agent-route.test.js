/**
 * Route tests for the Microsoft 365 Copilot agent (`/api/admin/copilot-agent/*`).
 *
 * Pinned here:
 *
 * - enabling sets up what Copilot needs and nothing it does not: one
 *   confidential OAuth client with Microsoft's redirect URI and the `mcp:*`
 *   scopes (its secret shown once), the OAuth server and the MCP gateway;
 *   enabling again reuses that client;
 * - disabling deactivates the client, so Copilot's tokens stop working;
 * - settings are validated against Microsoft's limits;
 * - the package is refused until it can work (enabled, registration ID set)
 *   and is otherwise a flat zip of the three manifests and two icons, pointing
 *   at the gateway's public URL.
 *
 * The route and the package builder are real; the stores, the audit log and
 * admin auth are stubbed. Native ESM: run with
 * `NODE_OPTIONS=--experimental-vm-modules`.
 */

import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import path from 'path';
import yauzl from 'yauzl';

const state = {};
const reset = () => {
  state.platform = { oauth: { enabled: { authz: false } }, mcpServer: { enabled: false } };
  state.clients = {};
  state.created = [];
  state.updates = [];
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
    getPlatform: () => state.platform,
    refreshCacheEntry: async () => {}
  }
}));

jest.unstable_mockModule('../services/config/ConfigStore.js', () => ({
  default: {
    writeJson: async (_file, data) => {
      state.platform = data;
    }
  }
}));

jest.unstable_mockModule('../utils/oauthClientManager.js', () => ({
  createOAuthClient: async data => {
    const client = { ...data, clientId: 'client_copilot', active: true };
    state.clients[client.clientId] = client;
    state.created.push(data);
    return { ...client, clientSecret: 'plain-secret' };
  },
  loadOAuthClients: () => ({ clients: state.clients }),
  findClientById: (config, id) => (config.clients[id] ? { ...config.clients[id] } : null),
  updateOAuthClient: async (id, updates) => {
    state.updates.push({ id, updates });
    state.clients[id] = { ...state.clients[id], ...updates };
    return state.clients[id];
  },
  rotateClientSecret: async id => ({ clientId: id, clientSecret: 'rotated-secret' })
}));

jest.unstable_mockModule('../services/AuditLogService.js', () => ({
  logAudit: entry => {
    state.audit.push(entry);
    return entry;
  }
}));

jest.unstable_mockModule('../utils/contentsPath.js', () => ({
  getContentsPath: (...segments) => path.join('/tmp/ihub-test-contents', ...segments),
  oauthClientsFile: () => 'config/oauth-clients.json'
}));

const { default: registerRoutes } = await import('../routes/admin/copilotAgent.js');

const app = express();
app.use(express.json());
registerRoutes(app);

const HOST = 'ihub.example.com';
const get = url => request(app).get(url).set('Host', HOST);
const post = url => request(app).post(url).set('Host', HOST);
const put = (url, body) => request(app).put(url).set('Host', HOST).send(body);

/** Entry name → contents of a zip buffer. */
function unzip(buffer) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      const files = {};
      zip.on('entry', entry => {
        zip.openReadStream(entry, (streamErr, stream) => {
          if (streamErr) return reject(streamErr);
          const chunks = [];
          stream.on('data', chunk => chunks.push(chunk));
          stream.on('end', () => {
            files[entry.fileName] = Buffer.concat(chunks);
            zip.readEntry();
          });
        });
      });
      zip.on('end', () => resolve(files));
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

const binaryParser = (res, callback) => {
  const chunks = [];
  res.on('data', chunk => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
};

beforeEach(reset);

describe('enable', () => {
  test('creates the Copilot OAuth client and turns on what the agent needs', async () => {
    const res = await post('/api/admin/copilot-agent/enable');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      oauthClientId: 'client_copilot',
      clientSecret: 'plain-secret'
    });
    expect(state.created).toHaveLength(1);
    expect(state.created[0]).toMatchObject({
      clientType: 'confidential',
      grantTypes: ['authorization_code', 'refresh_token'],
      redirectUris: ['https://teams.microsoft.com/api/platform/v1.0/oAuthRedirect']
    });
    expect(state.created[0].scopes).toEqual(
      expect.arrayContaining(['mcp:tools:read', 'mcp:tools:call', 'mcp:apps:invoke'])
    );

    expect(state.platform.oauth.enabled).toMatchObject({ authz: true, clients: true });
    expect(state.platform.mcpServer.enabled).toBe(true);
    expect(state.platform.copilotAgent).toMatchObject({
      enabled: true,
      oauthClientId: 'client_copilot'
    });
    expect(state.platform.copilotAgent.appId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });

  test('enabling again keeps the client, its secret and the app id', async () => {
    await post('/api/admin/copilot-agent/enable');
    const appId = state.platform.copilotAgent.appId;
    await post('/api/admin/copilot-agent/disable');

    const res = await post('/api/admin/copilot-agent/enable');
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('clientSecret');
    expect(state.created).toHaveLength(1);
    expect(state.clients.client_copilot.active).toBe(true);
    expect(state.platform.copilotAgent.appId).toBe(appId);
  });
});

describe('disable', () => {
  test('deactivates the client so Copilot tokens stop working; the gateway stays', async () => {
    await post('/api/admin/copilot-agent/enable');
    const res = await post('/api/admin/copilot-agent/disable');

    expect(res.status).toBe(200);
    expect(state.clients.client_copilot.active).toBe(false);
    expect(state.platform.copilotAgent.enabled).toBe(false);
    expect(state.platform.mcpServer.enabled).toBe(true);
  });
});

describe('config', () => {
  test('saves the settings that were sent', async () => {
    const res = await put('/api/admin/copilot-agent/config', {
      oauthReferenceId: '  ref-123  ',
      name: 'Contoso AI',
      conversationStarters: [{ title: 'Policy', text: 'What is our travel policy?' }, { text: '' }]
    });
    expect(res.status).toBe(200);
    expect(state.platform.copilotAgent).toMatchObject({
      oauthReferenceId: 'ref-123',
      name: 'Contoso AI',
      conversationStarters: [{ title: 'Policy', text: 'What is our travel policy?' }]
    });
  });

  test('refuses what Microsoft 365 would refuse, and writes nothing', async () => {
    for (const body of [
      { name: 'x'.repeat(31) },
      { description: '' },
      { instructions: 'x'.repeat(8001) },
      { conversationStarters: Array.from({ length: 13 }, () => ({ text: 'Hi' })) },
      { oauthReferenceId: 'has spaces in it' }
    ]) {
      const res = await put('/api/admin/copilot-agent/config', body);
      expect(res.status).toBe(400);
    }
    expect(state.platform.copilotAgent).toBeUndefined();
  });
});

describe('rotate-secret', () => {
  test('needs a client, then hands out a new secret once', async () => {
    expect((await post('/api/admin/copilot-agent/rotate-secret')).status).toBe(404);
    await post('/api/admin/copilot-agent/enable');
    const res = await post('/api/admin/copilot-agent/rotate-secret');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ oauthClientId: 'client_copilot', clientSecret: 'rotated-secret' });
  });
});

describe('status', () => {
  test('says what to register in the Teams Developer Portal', async () => {
    await post('/api/admin/copilot-agent/enable');
    const res = await get('/api/admin/copilot-agent/status');
    expect(res.status).toBe(200);
    expect(res.body.prerequisites).toEqual({
      mcpGateway: true,
      oauthServer: true,
      appsExposed: true,
      oauthClient: true
    });
    expect(res.body.packageReady).toBe(false); // no registration ID yet
    expect(res.body.registration).toMatchObject({
      baseUrl: `http://${HOST}/mcp`,
      clientId: 'client_copilot',
      authorizationEndpoint: `http://${HOST}/api/oauth/authorize`,
      tokenEndpoint: `http://${HOST}/api/oauth/token`,
      redirectUri: 'https://teams.microsoft.com/api/platform/v1.0/oAuthRedirect',
      pkce: true
    });
    expect(res.body.registration.scope).toContain('mcp:apps:invoke');
  });
});

describe('package.zip', () => {
  test('is refused until the agent can work', async () => {
    let res = await get('/api/admin/copilot-agent/package.zip');
    expect(res.status).toBe(409);
    expect(res.body.details.code).toBe('COPILOT_AGENT_DISABLED');

    await post('/api/admin/copilot-agent/enable');
    res = await get('/api/admin/copilot-agent/package.zip');
    expect(res.status).toBe(409);
    expect(res.body.details.code).toBe('COPILOT_REFERENCE_ID_MISSING');
  });

  test('is a flat zip of the manifests and icons, pointing at the public gateway', async () => {
    await post('/api/admin/copilot-agent/enable');
    await put('/api/admin/copilot-agent/config', { oauthReferenceId: 'ref-123' });
    state.platform.mcpServer.publicUrl = 'https://ihub.contoso.com/';

    const res = await get('/api/admin/copilot-agent/package.zip').buffer(true).parse(binaryParser);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toContain('ihub-copilot-agent.zip');

    const files = await unzip(res.body);
    expect(Object.keys(files).sort()).toEqual([
      'color.png',
      'declarativeAgent.json',
      'ihub-plugin.json',
      'manifest.json',
      'outline.png'
    ]);
    const manifest = JSON.parse(files['manifest.json']);
    expect(manifest.id).toBe(state.platform.copilotAgent.appId);
    expect(manifest.copilotAgents.declarativeAgents[0].file).toBe('declarativeAgent.json');

    const agent = JSON.parse(files['declarativeAgent.json']);
    expect(agent.actions).toEqual([{ id: 'ihubMcp', file: 'ihub-plugin.json' }]);

    const plugin = JSON.parse(files['ihub-plugin.json']);
    expect(plugin.runtimes[0]).toEqual({
      type: 'RemoteMCPServer',
      auth: { type: 'OAuthPluginVault', reference_id: 'ref-123' },
      spec: { url: 'https://ihub.contoso.com/mcp' },
      run_for_functions: ['*']
    });
    // PNG signatures: the icons are the real files.
    expect(files['color.png'].subarray(1, 4).toString()).toBe('PNG');
    expect(files['outline.png'].subarray(1, 4).toString()).toBe('PNG');
  });
});
