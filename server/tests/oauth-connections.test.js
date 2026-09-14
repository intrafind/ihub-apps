/**
 * OAuth connections — who is connected to what, and who may undo it.
 *
 * A connection is a grant (user × client × scopes), which is the unit an admin
 * and a user can actually reason about; the client record cannot answer it, and
 * under CIMD there is no client record to ask.
 *
 * The two things that must not go wrong:
 *
 * - **Revoking is both halves.** Deleting the consent alone only restores the
 *   consent screen on the *next* authorization, while the client's refresh
 *   token would go on minting access tokens for another thirty days.
 * - **A delegated token cannot manage connections.** A token issued *by* a
 *   connection must not be able to enumerate or revoke its user's grants —
 *   the same rule the personal-API-key endpoints enforce.
 *
 * Native-ESM jest (`NODE_OPTIONS=--experimental-vm-modules`); see the
 * `test:oauth` npm script, which `test:quick` chains in.
 */

import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { mkdtempSync } from 'fs';

// Both stores resolve their path from getRootDir() at import time, so the
// scratch directory has to exist before the dynamic imports below.
const state = {
  rootDir: mkdtempSync(path.join(os.tmpdir(), 'ihub-connections-')),
  platform: {},
  user: null
};

jest.unstable_mockModule('../pathUtils.js', () => ({
  getRootDir: () => state.rootDir
}));

jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    getPlatform: () => state.platform,
    get: () => null,
    setCacheEntry: () => {}
  }
}));

jest.unstable_mockModule('../services/AuditLogService.js', () => ({
  logAudit: () => {}
}));

jest.unstable_mockModule('../middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) => next()
}));

jest.unstable_mockModule('../middleware/authRequired.js', () => ({
  authRequired: (req, res, next) => {
    req.user = state.user;
    next();
  }
}));

jest.unstable_mockModule('../featureRegistry.js', () => ({
  requireFeature: () => (req, res, next) => next()
}));

const { grantConsent, hasConsent, listConsents, touchConsentLastUsed } =
  await import('../utils/consentStore.js');
const { generateRefreshToken, storeRefreshToken, revokeRefreshTokensFor, consumeRefreshToken } =
  await import('../utils/refreshTokenStore.js');
const {
  listConnectionsForUser,
  listConnections,
  countByClient,
  listSeenCimdClients,
  revokeConnection
} = await import('../services/oauth/ConnectionService.js');
const { default: registerAdminOAuthConnectionRoutes } =
  await import('../routes/admin/oauthConnections.js');
const { default: connectionRoutes } = await import('../routes/integrations/connections.js');

const CLAUDE = 'https://claude.ai/oauth/claude-code-client-metadata';
const SERVICE = 'client_reporting_a1b2c3d4';

function resetStores() {
  const dataDir = path.join(state.rootDir, 'contents', 'data');
  fs.rmSync(dataDir, { recursive: true, force: true });
  state.platform = {
    oauth: {
      enabled: { authz: true, clients: true },
      defaultTokenExpirationMinutes: 60
    }
  };
  state.user = { id: 'alice', name: 'Alice', authMode: 'local' };
}

async function seedConnection(clientId, userId, options = {}) {
  await grantConsent(clientId, userId, options.scopes || ['openid', 'mcp:tools:call'], 90, {
    clientName: options.clientName || 'Claude Code',
    clientHost: options.clientHost || '',
    clientKind: options.clientKind || 'stored',
    userName: options.userName || userId,
    userEmail: options.userEmail || `${userId}@example.com`
  });

  const token = generateRefreshToken();
  await storeRefreshToken(token, { clientId, userId, scopes: options.scopes || ['openid'] });
  return token;
}

function adminApp() {
  const app = express();
  app.use(express.json());
  registerAdminOAuthConnectionRoutes(app);
  return app;
}

function userApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/integrations/connections', connectionRoutes);
  return app;
}

beforeEach(resetStores);
afterAll(() => fs.rmSync(state.rootDir, { recursive: true, force: true }));

describe('consent store snapshots', () => {
  test('stores the display details the connections list needs', async () => {
    await seedConnection(CLAUDE, 'alice', {
      clientName: 'Claude Code',
      clientHost: 'claude.ai',
      clientKind: 'cimd',
      userName: 'Alice'
    });

    const [entry] = listConsents({ userId: 'alice' });
    expect(entry.clientName).toBe('Claude Code');
    expect(entry.clientHost).toBe('claude.ai');
    expect(entry.clientKind).toBe('cimd');
    expect(entry.userName).toBe('Alice');
  });

  test('keeps working for entries written before the snapshots existed', () => {
    // A store file from an earlier version: no snapshots at all.
    const dataDir = path.join(state.rootDir, 'contents', 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, 'oauth-consent.json'),
      JSON.stringify({
        consents: {
          'legacy_client:bob': {
            clientId: 'legacy_client',
            userId: 'bob',
            scopes: ['openid'],
            grantedAt: '2026-01-01T00:00:00.000Z',
            expiresAt: '2099-01-01T00:00:00.000Z'
          }
        }
      })
    );

    expect(hasConsent('legacy_client', 'bob', ['openid'])).toBe(true);
    const [connection] = listConnectionsForUser('bob');
    expect(connection.clientName).toBe('legacy_client');
    expect(connection.clientKind).toBe('stored');
    expect(connection.lastUsedAt).toBeNull();
  });

  test('re-consenting does not reset the usage clock', async () => {
    await seedConnection(SERVICE, 'alice');
    await touchConsentLastUsed(SERVICE, 'alice');
    const used = listConsents({ userId: 'alice' })[0].lastUsedAt;
    expect(used).toEqual(expect.any(String));

    await grantConsent(SERVICE, 'alice', ['openid'], 90, { clientName: 'Reporting' });
    expect(listConsents({ userId: 'alice' })[0].lastUsedAt).toBe(used);
  });

  test('hides expired grants from the connections list', async () => {
    await grantConsent(SERVICE, 'alice', ['openid'], -1, { clientName: 'Reporting' });
    expect(listConnectionsForUser('alice')).toHaveLength(0);
  });
});

describe('ConnectionService', () => {
  test('lists, counts and groups by client', async () => {
    await seedConnection(CLAUDE, 'alice', { clientKind: 'cimd', clientHost: 'claude.ai' });
    await seedConnection(CLAUDE, 'bob', { clientKind: 'cimd', clientHost: 'claude.ai' });
    await seedConnection(SERVICE, 'alice', { clientName: 'Reporting' });

    expect(listConnectionsForUser('alice')).toHaveLength(2);
    expect(listConnections({ clientId: CLAUDE }).total).toBe(2);
    expect(countByClient()[CLAUDE]).toBe(2);

    const [cimd] = listSeenCimdClients();
    expect(cimd.clientId).toBe(CLAUDE);
    expect(cimd.host).toBe('claude.ai');
    expect(cimd.connectionCount).toBe(2);
  });

  test('pages results', async () => {
    for (const user of ['a', 'b', 'c', 'd', 'e']) {
      await seedConnection(SERVICE, user);
    }
    const page = listConnections({ pageSize: 2, page: 2 });
    expect(page.connections).toHaveLength(2);
    expect(page.total).toBe(5);
  });

  test('revoking removes the consent AND every refresh token for the pair', async () => {
    const aliceToken = await seedConnection(CLAUDE, 'alice');
    const bobToken = await seedConnection(CLAUDE, 'bob');

    const result = await revokeConnection(CLAUDE, 'alice');
    expect(result.revoked).toBe(true);
    expect(result.refreshTokensRevoked).toBe(1);

    expect(hasConsent(CLAUDE, 'alice', ['openid'])).toBe(false);
    // The whole point: the client cannot keep minting access tokens either.
    expect(await consumeRefreshToken(aliceToken)).toBeNull();
    // ...and nobody else's connection was touched.
    expect(await consumeRefreshToken(bobToken)).not.toBeNull();
  });

  test('revoking an unknown connection reports that nothing happened', async () => {
    const result = await revokeConnection(SERVICE, 'nobody');
    expect(result.revoked).toBe(false);
  });

  test('revokeRefreshTokensFor only matches the exact pair', async () => {
    await seedConnection(CLAUDE, 'alice');
    await seedConnection(SERVICE, 'alice');

    expect(await revokeRefreshTokensFor(CLAUDE, 'alice')).toBe(1);
    expect(await revokeRefreshTokensFor(CLAUDE, 'alice')).toBe(0);
  });
});

describe('admin API', () => {
  test('lists connections and the CIMD clients behind them', async () => {
    await seedConnection(CLAUDE, 'alice', { clientKind: 'cimd', clientHost: 'claude.ai' });

    const res = await request(adminApp()).get('/api/admin/oauth/connections');
    expect(res.status).toBe(200);
    expect(res.body.connections).toHaveLength(1);
    expect(res.body.cimdClients[0].host).toBe('claude.ai');
  });

  test('filters by user', async () => {
    await seedConnection(SERVICE, 'alice');
    await seedConnection(SERVICE, 'bob');

    const res = await request(adminApp()).get('/api/admin/oauth/connections?userId=bob');
    expect(res.body.connections).toHaveLength(1);
    expect(res.body.connections[0].userId).toBe('bob');
  });

  test('revokes a connection, including URL-shaped client IDs', async () => {
    await seedConnection(CLAUDE, 'alice', { clientKind: 'cimd', clientHost: 'claude.ai' });

    const res = await request(adminApp()).delete(
      `/api/admin/oauth/connections/${encodeURIComponent(CLAUDE)}/alice`
    );
    expect(res.status).toBe(200);
    expect(listConnectionsForUser('alice')).toHaveLength(0);
  });

  test('404s on a connection that does not exist', async () => {
    const res = await request(adminApp()).delete(
      `/api/admin/oauth/connections/${encodeURIComponent(SERVICE)}/nobody`
    );
    expect(res.status).toBe(404);
  });
});

describe('user API', () => {
  test('lists only the caller’s own connections', async () => {
    await seedConnection(CLAUDE, 'alice', { clientKind: 'cimd', clientHost: 'claude.ai' });
    await seedConnection(CLAUDE, 'bob', { clientKind: 'cimd', clientHost: 'claude.ai' });

    const res = await request(userApp()).get('/api/integrations/connections');
    expect(res.status).toBe(200);
    expect(res.body.connections).toHaveLength(1);
    expect(res.body.connections[0].userId).toBe('alice');
    expect(res.body.tokenExpirationMinutes).toBe(60);
  });

  test('disconnects the caller’s own connection', async () => {
    const token = await seedConnection(SERVICE, 'alice');

    const res = await request(userApp()).delete(`/api/integrations/connections/${SERVICE}`);
    expect(res.status).toBe(200);
    expect(listConnectionsForUser('alice')).toHaveLength(0);
    expect(await consumeRefreshToken(token)).toBeNull();
  });

  test('another user’s connection is a 404, not a 403', async () => {
    await seedConnection(SERVICE, 'bob');

    const res = await request(userApp()).delete(`/api/integrations/connections/${SERVICE}`);
    // Whether bob has connected this client is not alice's business either.
    expect(res.status).toBe(404);
    expect(listConnectionsForUser('bob')).toHaveLength(1);
  });

  test('rejects delegated and machine tokens', async () => {
    await seedConnection(SERVICE, 'alice');

    for (const authMode of [
      'oauth_authorization_code',
      'oauth_personal_key',
      'oauth_client_credentials',
      'oauth_static_api_key'
    ]) {
      state.user = { id: 'alice', authMode };
      expect((await request(userApp()).get('/api/integrations/connections')).status).toBe(403);
      expect(
        (await request(userApp()).delete(`/api/integrations/connections/${SERVICE}`)).status
      ).toBe(403);
    }

    state.user = { id: 'alice', authMode: 'local', isOAuthClient: true };
    expect((await request(userApp()).get('/api/integrations/connections')).status).toBe(403);
  });

  test('rejects anonymous callers', async () => {
    state.user = { id: 'anonymous', authMode: 'anonymous' };
    expect((await request(userApp()).get('/api/integrations/connections')).status).toBe(401);
  });

  test('404s while the authorization server is off', async () => {
    state.platform.oauth.enabled.authz = false;
    expect((await request(userApp()).get('/api/integrations/connections')).status).toBe(404);
  });
});
