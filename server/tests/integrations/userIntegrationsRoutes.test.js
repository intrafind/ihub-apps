// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The integrations of the signed-in user and the one connect flow (#2917):
 *
 *   GET  /api/integrations, GET /api/integrations/:id
 *   POST /api/integrations/:id/connect | reconnect | disconnect
 *
 * - the listing never shows an installation the user's groups do not allow,
 *   and says how each one runs (personal, service account, shared key, none);
 * - connect answers the vendor's authorization URL with a server-side state;
 *   the id is checked against the registry and the user's groups;
 * - the return URL must be same-origin http(s); a JSON body is required;
 * - reconnect asks for the union of granted and new scopes and keeps the
 *   connection id; disconnect removes the caller's own tokens.
 *
 * Plus the "connect first" result shape of the adapters (Jira tool, the
 * connection service) and the result parameters of the one callback.
 *
 * Run: node --test server/tests/integrations/userIntegrationsRoutes.test.js
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import configCache from '../../configCache.js';
import tokenStorageService from '../../services/TokenStorageService.js';
import credentialService from '../../services/CredentialService.js';
import JiraService from '../../services/integrations/JiraService.js';
import * as jiraTool from '../../tools/jira.js';
import userIntegrationRoutes, {
  connectLimiter,
  parseRequestedScopes
} from '../../routes/integrations/userIntegrations.js';
import {
  IntegrationConnectionService,
  connectionIdFor,
  resultParams,
  setIntegrationConnectionServiceForTests
} from '../../services/integrations/auth/IntegrationConnectionService.js';
import { OAuthFlowStore } from '../../services/integrations/auth/oauthFlowStore.js';
import {
  INTEGRATION_AUTH_REQUIRED,
  IntegrationAuthRequiredError,
  integrationAuthRequiredResult
} from '../../services/integrations/auth/integrationAuthRequired.js';
import {
  appUsesIntegration,
  connectionStatusOf,
  credentialMissingOf,
  sharedModeOf,
  sharedWithOf,
  unavailableReasonOf
} from '../../services/integrations/userIntegrations.js';
import errorHandler from '../../middleware/errorHandler.js';
import { fakeTokenEndpoint } from '../helpers/integrationConnect.js';
import { scratchDocuments } from '../helpers/testStorage.js';

const scratch = await scratchDocuments();

const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'user-integrations-'));
tokenStorageService.encryptionKey = 'e'.repeat(64);
tokenStorageService.jwtSecret = 'user-integrations-secret';
tokenStorageService.storageBasePath = tmpDir;

const installation = (id, definition, values = {}) => ({
  id,
  definition,
  definitionVersion: '1.0.0',
  enabled: true,
  values,
  auth: { mode: definition === 'com.intrafind/brave-search' ? 'none' : 'oauth-user' }
});
const integrations = {
  installed: [
    installation('jira', 'com.intrafind/jira', { clientId: 'jira-client', clientSecretRef: 'js' }),
    installation('nc-main', 'com.intrafind/nextcloud', {
      serverUrl: 'https://nc.example.com',
      clientId: 'nc-client',
      clientSecretRef: 'ns'
    }),
    installation('nc-legal', 'com.intrafind/nextcloud', {
      serverUrl: 'https://legal.example.com',
      clientId: 'legal-client',
      clientSecretRef: 'ls'
    }),
    installation('brave', 'com.intrafind/brave-search', {})
  ]
};

const saved = {};
before(() => {
  saved.getIntegrations = configCache.getIntegrations;
  saved.get = configCache.get;
  saved.getPlatform = configCache.getPlatform;
  saved.getFeatures = configCache.getFeatures;
  saved.resolveSecret = credentialService.resolveSecret;
  saved.tryResolveSecret = credentialService.tryResolveSecret;
  configCache.getIntegrations = () => ({ data: integrations });
  configCache.get = key =>
    key === 'config/integrations.json' ? { data: integrations } : saved.get.call(configCache, key);
  configCache.getPlatform = () => ({ anonymousAuth: { enabled: false } });
  configCache.getFeatures = () => ({ integrations: true });
  credentialService.resolveSecret = ref => `secret-of-${ref}`;
  credentialService.tryResolveSecret = ref => `secret-of-${ref}`;
});
after(() => {
  configCache.getIntegrations = saved.getIntegrations;
  configCache.get = saved.get;
  configCache.getPlatform = saved.getPlatform;
  configCache.getFeatures = saved.getFeatures;
  credentialService.resolveSecret = saved.resolveSecret;
  credentialService.tryResolveSecret = saved.tryResolveSecret;
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Users by header: `member` may use jira, nc-main and brave; `outsider` nothing. */
const USERS = {
  member: {
    id: 'member',
    groups: ['users'],
    permissions: { integrations: new Set(['jira', 'nc-main', 'brave']) }
  },
  other: {
    id: 'other',
    groups: ['users'],
    permissions: { integrations: new Set(['jira', 'nc-main']) }
  },
  outsider: { id: 'outsider', groups: ['users'], permissions: { integrations: new Set() } },
  admin: {
    id: 'admin',
    isAdmin: true,
    groups: ['admins'],
    permissions: { integrations: new Set(), adminAccess: true }
  },
  client: {
    id: 'member',
    groups: ['users'],
    isOAuthClient: true,
    permissions: { integrations: new Set(['*']) }
  },
  // An admin's personal API key: the admin's groups, but a bearer token.
  adminKey: {
    id: 'admin',
    groups: ['admins'],
    authMode: 'oauth_personal_key',
    permissions: { integrations: new Set(), adminAccess: true }
  },
  memberKey: {
    id: 'member',
    groups: ['users'],
    authMode: 'oauth_personal_key',
    permissions: { integrations: new Set(['jira', 'nc-main', 'brave']) }
  }
};

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.user = USERS[req.headers['x-test-user']] || { id: 'anonymous', groups: ['anonymous'] };
  next();
});
app.use('/api/integrations', userIntegrationRoutes);
// Another router under the same prefix: unknown ids fall through to it.
app.get('/api/integrations/connections', (_req, res) => res.json({ fallthrough: true }));
app.use(errorHandler);

let connections;
let tokenEndpoint;
const originalStrategy = JiraService.oauthStrategy;
beforeEach(async () => {
  await scratch.reset();
  // The per-user start limit (20 a minute) is not what these tests exercise.
  for (const user of Object.values(USERS)) await connectLimiter.resetKey(`user:${user.id}`);
  connections = new IntegrationConnectionService({
    documents: scratch.documents,
    flowStore: new OAuthFlowStore({ documents: scratch.documents })
  });
  setIntegrationConnectionServiceForTests(connections);
  tokenEndpoint = fakeTokenEndpoint([{ scope: 'read:jira-work offline_access' }]);
  JiraService.oauthStrategy = function oauthStrategyForTest() {
    const strategy = originalStrategy.call(this);
    return {
      ...strategy,
      async resolve(ctx) {
        return { ...(await strategy.resolve(ctx)), fetchFn: tokenEndpoint };
      }
    };
  };
});
after(() => {
  JiraService.oauthStrategy = originalStrategy;
});

const post = (url, user = 'member', body = {}) =>
  request(app).post(url).set('x-test-user', user).send(body);

/** Connect `member` to Jira through the real callback (the alias handler). */
async function connectJira(user = 'member') {
  const started = await post('/api/integrations/jira/connect', user, { returnUrl: '/apps/a/c/1' });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const state = new URL(started.body.url).searchParams.get('state');
  const outcome = await connections.completeConnect({
    req: {
      query: { code: 'code-1', state },
      user: USERS[user],
      headers: { host: '127.0.0.1' },
      get: () => '127.0.0.1',
      hostname: '127.0.0.1',
      protocol: 'http'
    },
    alias: { stack: 'jira', installationId: 'jira' }
  });
  return { started, outcome };
}

describe('GET /api/integrations', () => {
  it('lists only the installations the groups allow, with how each runs', async () => {
    const res = await request(app).get('/api/integrations').set('x-test-user', 'member');
    assert.equal(res.status, 200);
    const ids = res.body.integrations.map(entry => entry.id);
    assert.ok(ids.includes('jira') && ids.includes('nc-main') && ids.includes('brave'));
    assert.ok(!ids.includes('nc-legal'), 'an installation the groups do not grant is never listed');
    const byId = Object.fromEntries(res.body.integrations.map(entry => [entry.id, entry]));
    assert.deepEqual(
      {
        mode: byId.jira.connection.mode,
        status: byId.jira.connection.status,
        reason: byId.jira.connection.reason,
        signInHost: byId.jira.connection.signInHost,
        connectable: byId.jira.connection.connectable
      },
      {
        mode: 'personal',
        status: 'not_connected',
        reason: 'not_connected',
        signInHost: 'auth.atlassian.com',
        connectable: true
      }
    );
    assert.equal(byId['nc-main'].type, 'storage');
    assert.deepEqual(byId['nc-main'].capabilities, ['files']);
    assert.equal(byId.brave.connection.mode, 'shared_key');
    assert.equal(byId.brave.connection.status, 'shared_key');
    for (const entry of res.body.integrations) {
      assert.ok(Array.isArray(entry.actions) && Array.isArray(entry.effects), entry.id);
      assert.ok(!JSON.stringify(entry).includes('secret-of-'), 'no secret in the listing');
    }
  });

  it('lists nothing for a user whose groups grant nothing, and refuses anonymous callers', async () => {
    const outsider = await request(app).get('/api/integrations').set('x-test-user', 'outsider');
    assert.deepEqual(
      outsider.body.integrations.filter(entry => entry.id !== 'ihub'),
      []
    );
    const anonymous = await request(app).get('/api/integrations');
    assert.equal(anonymous.status, 401);
  });

  it('answers one integration, 404 for one not granted, and hands other paths on', async () => {
    const one = await request(app).get('/api/integrations/jira').set('x-test-user', 'member');
    assert.equal(one.status, 200);
    assert.equal(one.body.integration.id, 'jira');
    const hidden = await request(app)
      .get('/api/integrations/nc-legal')
      .set('x-test-user', 'member');
    assert.equal(hidden.status, 404);
    const other = await request(app)
      .get('/api/integrations/connections')
      .set('x-test-user', 'member');
    assert.deepEqual(other.body, { fallthrough: true });
  });

  it('gives an anonymous caller one answer for installed and unknown ids', async () => {
    const installed = await request(app).get('/api/integrations/jira');
    const unknown = await request(app).get('/api/integrations/no-such-installation');
    assert.equal(installed.status, unknown.status);
    assert.deepEqual(installed.body, unknown.body);
    assert.notEqual(installed.status, 401, 'no 401 that only an installed id gets');
    // The other routers under the prefix still answer anonymous callers.
    const other = await request(app).get('/api/integrations/connections');
    assert.deepEqual(other.body, { fallthrough: true });
  });

  it('says connected (and when) after a connect', async () => {
    const { outcome } = await connectJira();
    assert.equal(outcome.ok, true);
    assert.equal(outcome.redirectTo, '/apps/a/c/1?integration_connected=jira');
    const one = await request(app).get('/api/integrations/jira').set('x-test-user', 'member');
    assert.equal(one.body.integration.connection.status, 'connected');
    assert.ok(one.body.integration.connection.connectedAt);
    // Another user is not connected by it.
    const other = await request(app).get('/api/integrations/jira').set('x-test-user', 'other');
    assert.equal(other.body.integration.connection.status, 'not_connected');
  });
});

describe('POST /api/integrations/:id/connect', () => {
  it('answers the authorization URL with PKCE and an opaque, server-side state', async () => {
    const res = await post('/api/integrations/jira/connect', 'member', {
      returnUrl: '/apps/a/c/1'
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers['cache-control'], 'no-store');
    const url = new URL(res.body.url);
    assert.equal(url.origin, 'https://auth.atlassian.com');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.match(url.searchParams.get('state'), /^[A-Za-z0-9_-]{43}$/);
  });

  it('checks the id against the registry and the groups', async () => {
    assert.equal((await post('/api/integrations/nope/connect')).status, 404);
    assert.equal((await post('/api/integrations/..%2Fetc/connect')).status, 404);
    const notGranted = await post('/api/integrations/nc-legal/connect');
    assert.equal(notGranted.status, 404);
    assert.equal(notGranted.body.code, 'INTEGRATION_NOT_FOUND');
    assert.equal((await post('/api/integrations/jira/connect', 'outsider')).status, 404);
    // Admins configure and test integrations: they pass the group check
    // (Jira); an installation's own rule (a storage provider's grant) still holds.
    assert.equal((await post('/api/integrations/jira/connect', 'admin')).status, 200);
    assert.equal((await post('/api/integrations/nc-legal/connect', 'admin')).status, 404);
    // An integration that takes no personal connection.
    const shared = await post('/api/integrations/brave/connect');
    assert.equal(shared.status, 400);
    assert.equal(shared.body.code, 'NOT_CONNECTABLE');
  });

  it('accepts only same-origin http(s) return URLs', async () => {
    for (const evil of [
      '//evil.example',
      '/\\evil.example',
      'https://evil.example/x',
      'javascript://127.0.0.1/%0Aalert(1)',
      'data:text/html,x'
    ]) {
      const res = await post('/api/integrations/jira/connect', 'member', { returnUrl: evil });
      assert.equal(res.status, 400, evil);
      assert.equal(res.body.code, 'INVALID_RETURN_URL');
      assert.equal(res.body.url, undefined);
    }
    const sameOrigin = await post('/api/integrations/jira/connect', 'member', {
      returnUrl: 'http://127.0.0.1/apps/a/c/1'
    });
    assert.equal(sameOrigin.status, 200);
  });

  it('refuses anonymous, delegated and non-JSON requests (CSRF)', async () => {
    assert.equal((await request(app).post('/api/integrations/jira/connect').send({})).status, 401);
    assert.equal((await post('/api/integrations/jira/connect', 'client')).status, 403);
    // A personal API key is a bearer token too, even with the user's own groups.
    const keyConnect = await post('/api/integrations/jira/connect', 'memberKey');
    assert.equal(keyConnect.status, 403);
    assert.equal(keyConnect.body.code, 'INTERACTIVE_SESSION_REQUIRED');
    assert.equal((await post('/api/integrations/jira/reconnect', 'memberKey')).status, 403);
    assert.equal((await post('/api/integrations/jira/disconnect', 'memberKey')).status, 403);
    // An admin's personal key gets neither the connect nor the admin bypass.
    assert.equal((await post('/api/integrations/jira/connect', 'adminKey')).status, 403);
    const form = await request(app)
      .post('/api/integrations/jira/connect')
      .set('x-test-user', 'member')
      .type('form')
      .send('returnUrl=/x');
    assert.equal(form.status, 415);
  });

  it('binds the state to the user: another user cannot complete it', async () => {
    const started = await post('/api/integrations/jira/connect', 'member', {
      returnUrl: '/apps/a/c/1'
    });
    const state = new URL(started.body.url).searchParams.get('state');
    const outcome = await connections.completeConnect({
      req: { query: { code: 'c', state }, user: USERS.other },
      alias: { stack: 'jira', installationId: 'jira' }
    });
    assert.equal(outcome.ok, false);
    assert.equal(
      outcome.redirectTo,
      '/settings/integrations?integration_error=user_mismatch&integration=jira'
    );
    assert.equal(tokenEndpoint.calls.length, 0);
  });
});

describe('POST /api/integrations/:id/reconnect and /disconnect', () => {
  it('reconnect asks for the granted plus the new scopes and keeps the connection id', async () => {
    await connectJira();
    const id = connectionIdFor('jira', { type: 'user', id: 'member' });
    const before = await connections.getConnection(id);
    assert.deepEqual(before.scopesGranted, ['read:jira-work', 'offline_access']);

    const res = await post('/api/integrations/jira/reconnect', 'member', {
      returnUrl: '/apps/a/c/1',
      scopes: ['write:jira-work', 'bad scope "x"']
    });
    assert.equal(res.status, 200);
    const scope = new URL(res.body.url).searchParams.get('scope').split(' ');
    for (const wanted of ['read:jira-work', 'offline_access', 'write:jira-work']) {
      assert.ok(scope.includes(wanted), `${wanted} in ${scope}`);
    }
    assert.ok(!scope.includes('"x"'), 'invalid scope tokens are dropped');

    tokenEndpoint = fakeTokenEndpoint([{ scope: 'read:jira-work write:jira-work offline_access' }]);
    const state = new URL(res.body.url).searchParams.get('state');
    const outcome = await connections.completeConnect({
      req: { query: { code: 'c2', state }, user: USERS.member },
      alias: { stack: 'jira', installationId: 'jira' }
    });
    assert.equal(outcome.ok, true);
    const afterwards = await connections.getConnection(id);
    assert.equal(afterwards.id, before.id, 'the connection id is preserved');
    assert.ok(afterwards.scopesGranted.includes('write:jira-work'));
    assert.equal(afterwards.createdAt, before.createdAt);
  });

  it("disconnect removes only the caller's tokens", async () => {
    await connectJira('member');
    await connectJira('other');
    const res = await post('/api/integrations/jira/disconnect', 'member');
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.removed, true);
    const member = await request(app).get('/api/integrations/jira').set('x-test-user', 'member');
    assert.equal(member.body.integration.connection.status, 'not_connected');
    const other = await request(app).get('/api/integrations/jira').set('x-test-user', 'other');
    assert.equal(other.body.integration.connection.status, 'connected');
    assert.equal((await post('/api/integrations/nope/disconnect')).status, 404);
    assert.equal((await post('/api/integrations/brave/disconnect')).status, 404);
  });

  it('parses requested scopes defensively', () => {
    assert.deepEqual(parseRequestedScopes('a b  c'), ['a', 'b', 'c']);
    assert.deepEqual(parseRequestedScopes(['a', 'b"c']), ['a']);
    assert.deepEqual(parseRequestedScopes(42), []);
    assert.equal(parseRequestedScopes(Array.from({ length: 80 }, (_, i) => `s${i}`)).length, 50);
  });
});

describe('the "connect first" result of the adapters', () => {
  it('Jira answers INTEGRATION_AUTH_REQUIRED before calling Atlassian', async () => {
    let called = false;
    const original = JiraService.searchTickets;
    JiraService.searchTickets = async () => {
      called = true;
      return { total: 0, issues: [] };
    };
    try {
      const result = await jiraTool.searchTickets({ jql: 'x', user: USERS.member });
      assert.deepEqual(
        {
          error: result.error,
          integration: result.integration,
          reason: result.reason,
          connectUrl: result.connectUrl
        },
        {
          error: INTEGRATION_AUTH_REQUIRED,
          integration: 'jira',
          reason: 'not_connected',
          connectUrl: '/api/integrations/jira/connect'
        }
      );
      assert.equal(called, false, 'nothing ran at the vendor');
      const anonymous = await jiraTool.searchTickets({ jql: 'x', user: { id: 'anonymous' } });
      assert.equal(anonymous.error, INTEGRATION_AUTH_REQUIRED);
    } finally {
      JiraService.searchTickets = original;
    }
  });

  it('an expired connection says expired; a missing scope goes to the reconnect route', async () => {
    await connectJira();
    const id = connectionIdFor('jira', { type: 'user', id: 'member' });
    await connections.updateConnection(id, { status: 'needs-reconnect' });
    const expired = await connections.resolve({ type: 'user', id: 'member' }, 'jira');
    assert.equal(expired.ok, false);
    assert.equal(expired.error.reason, 'expired');
    assert.equal(expired.error.connectUrl, '/api/integrations/jira/connect');

    await connections.updateConnection(id, { status: 'active' });
    const scoped = await connections.resolve({ type: 'user', id: 'member' }, 'jira', {
      requiredScopes: ['write:jira-work']
    });
    assert.equal(scoped.error.reason, 'insufficient_scope');
    assert.equal(scoped.error.connectUrl, '/api/integrations/jira/reconnect');
    assert.ok(scoped.error.scopes.includes('write:jira-work'));
    const result = connections.authRequiredResult(scoped.error);
    assert.equal(result.error, INTEGRATION_AUTH_REQUIRED);
    assert.ok(result.scopes.includes('read:jira-work'));
  });

  it('builds the one result shape, with the connect route by default', () => {
    assert.deepEqual(integrationAuthRequiredResult({ integration: 'okta', message: 'm' }), {
      error: INTEGRATION_AUTH_REQUIRED,
      integration: 'okta',
      reason: 'not_connected',
      message: 'm',
      connectUrl: '/api/integrations/okta/connect'
    });
    const error = new IntegrationAuthRequiredError({
      integration: 'x',
      reason: 'bogus',
      connectUrl: null
    });
    assert.equal(error.reason, 'not_connected');
    assert.equal(error.connectUrl, null);
  });

  it('the callback result is one shape for every protocol', () => {
    assert.deepEqual(resultParams('jira', { ok: true }), { integration_connected: 'jira' });
    assert.deepEqual(
      resultParams({ installationId: 'okta', stack: 'mcp' }, { ok: false, code: 'access_denied' }),
      {
        integration_error: 'access_denied',
        integration: 'okta'
      }
    );
  });
});

describe('connection status (pure)', () => {
  it('maps every kind of connection', () => {
    const instance = { id: 'x', auth: { mode: 'none' } };
    assert.equal(connectionStatusOf({ descriptor: { kind: 'sso' }, instance }).status, 'sso');
    assert.equal(
      connectionStatusOf({ descriptor: { kind: 'service-account' }, instance }).status,
      'service_account'
    );
    assert.equal(connectionStatusOf({ descriptor: null, instance, definition: {} }).status, 'none');
    const personal = { kind: 'oauth-user', issuer: 'https://login.example.com/t/v2.0' };
    assert.deepEqual(
      (({ status, reason, signInHost }) => ({ status, reason, signInHost }))(
        connectionStatusOf({
          descriptor: personal,
          resolved: { ok: false, error: { reason: 'expired' } },
          record: { externalAccount: { label: 'ada@example.com' }, scopesGranted: ['a'] },
          instance
        })
      ),
      { status: 'needs_reconnect', reason: 'expired', signInHost: 'login.example.com' }
    );
    const connected = connectionStatusOf({
      descriptor: personal,
      resolved: { ok: true },
      record: { externalAccount: { label: 'ada@example.com' }, createdAt: '2026-11-01T00:00:00Z' },
      instance
    });
    assert.equal(connected.status, 'connected');
    assert.equal(connected.account, 'ada@example.com');
  });

  it('tells a shared key from a service account from nothing', () => {
    const keyed = { install: [{ key: 'apiKeyRef', type: 'credential' }] };
    const bind = { install: [{ key: 'bindPassword', type: 'secret', sensitive: true }] };
    assert.equal(sharedModeOf({ auth: { mode: 'none' } }, keyed), 'shared_key');
    assert.equal(sharedModeOf({ auth: { mode: 'none' } }, bind), 'service_account');
    assert.equal(sharedModeOf({ auth: { mode: 'service-account' } }, {}), 'service_account');
    assert.equal(sharedModeOf({ auth: { mode: 'oauth-client' } }, {}), 'service_account');
    assert.equal(sharedModeOf({ auth: { mode: 'none' } }, { install: [] }), 'none');
  });

  it('says unavailable with the reason an admin has to act on (#2922)', () => {
    const instance = { id: 'x', auth: { mode: 'none' } };
    const keyed = { install: [{ key: 'apiKeyRef', type: 'credential' }] };
    // The admin list's "Unreachable" (live status) is the user's "Unavailable".
    const rejected = connectionStatusOf({
      descriptor: null,
      instance,
      definition: keyed,
      live: { unhealthy: true, lastError: 'Streamable HTTP error: 401 Unauthorized' },
      sharedWith: [{ id: 'legal', name: 'Legal' }]
    });
    assert.deepEqual(
      { mode: rejected.mode, status: rejected.status, reason: rejected.reason },
      { mode: 'shared_key', status: 'unavailable', reason: 'credential_rejected' }
    );
    assert.deepEqual(rejected.sharedWith, [{ id: 'legal', name: 'Legal' }]);
    assert.equal(
      unavailableReasonOf({ live: { unhealthy: true, lastError: 'connect ECONNREFUSED' } }),
      'unreachable'
    );
    assert.equal(unavailableReasonOf({ live: { unhealthy: false, lastError: '401' } }), null);
    assert.equal(unavailableReasonOf({ credentialMissing: true }), 'credential_missing');
    const sso = connectionStatusOf({
      descriptor: { kind: 'sso' },
      instance,
      sharedWith: [{ id: 'legal', name: 'Legal' }]
    });
    assert.deepEqual(sso.sharedWith, [], 'SSO is not shared by a group');
    // A per-user sign-in an admin switched off or did not set up.
    const off = connectionStatusOf({
      descriptor: { kind: 'oauth-user', configured: false },
      resolved: null,
      instance
    });
    assert.deepEqual(
      { status: off.status, reason: off.reason, connectable: off.connectable },
      { status: 'unavailable', reason: 'not_configured', connectable: false }
    );
    // Connected: whether the access renews itself (a refresh token is held).
    const connected = connectionStatusOf({
      descriptor: { kind: 'oauth-user' },
      resolved: { ok: true },
      record: { expiresAt: '2026-11-02T12:00:00Z' },
      instance,
      renewable: true
    });
    assert.equal(connected.renewable, true);
  });

  it('finds a credential the store does not hold', () => {
    const saved = credentialService.has;
    credentialService.has = ref => ref === 'present';
    try {
      const definition = { install: [{ key: 'apiKeyRef', type: 'credential', required: true }] };
      assert.equal(credentialMissingOf({ values: { apiKeyRef: 'present' } }, definition), false);
      assert.equal(credentialMissingOf({ values: { apiKeyRef: 'gone' } }, definition), true);
      assert.equal(
        credentialMissingOf({ values: {} }, definition),
        false,
        'not set is not missing'
      );
      assert.equal(
        credentialMissingOf({ auth: { mode: 'service-account', credentialRef: 'gone' } }, null),
        true
      );
    } finally {
      credentialService.has = saved;
    }
  });

  it('names the groups that share an installation, never "*"', () => {
    const savedGroups = configCache.getGroups;
    configCache.getGroups = () => ({
      data: {
        groups: {
          users: { name: 'Users', permissions: { integrations: ['*'] } },
          legal: {
            name: { en: 'Legal team', de: 'Rechtsabteilung' },
            permissions: { integrations: ['enaio'] }
          },
          dms: { name: 'DMS', permissions: { integrations: ['com.example/enaio'] } }
        }
      }
    });
    try {
      const instance = { id: 'enaio', definition: 'com.example/enaio' };
      assert.deepEqual(sharedWithOf(instance, { groups: ['users', 'legal', 'dms'] }, 'de'), [
        { id: 'legal', name: 'Rechtsabteilung' }
      ]);
      assert.deepEqual(sharedWithOf(instance, { groups: ['users', 'dms'] }, 'en'), [
        { id: 'dms', name: 'DMS' }
      ]);
      assert.deepEqual(sharedWithOf(instance, { groups: ['users'] }, 'en'), []);
    } finally {
      configCache.getGroups = savedGroups;
    }
  });

  it('knows which apps use an installation', () => {
    const instance = { id: 'jira', definition: 'com.intrafind/jira' };
    const bindingKeyFor = (app, inst) =>
      app.integrations && Object.hasOwn(app.integrations, inst.id) ? inst.id : null;
    assert.equal(appUsesIntegration({ integrations: { jira: {} } }, instance, bindingKeyFor), true);
    assert.equal(
      appUsesIntegration({ integrations: { other: {} } }, instance, bindingKeyFor),
      false
    );
    assert.equal(appUsesIntegration({}, instance, bindingKeyFor), false);
  });
});

describe('GET /api/integrations: apps and categories (#2922)', () => {
  let savedApps;
  before(() => {
    savedApps = configCache.getAppsForUser;
    configCache.getAppsForUser = async () => ({
      data: [
        { id: 'tickets', name: { en: 'Tickets', de: 'Tickets' }, integrations: { jira: {} } },
        { id: 'research', name: 'Research', websearch: { enabled: true, provider: 'auto' } },
        { id: 'off', name: 'Off', enabled: false, integrations: { jira: {} } },
        { id: 'plain', name: 'Plain' }
      ]
    });
  });
  after(() => {
    configCache.getAppsForUser = savedApps;
  });

  it('lists the apps the user may open that use each integration', async () => {
    const res = await request(app).get('/api/integrations').set('x-test-user', 'member');
    assert.equal(res.status, 200);
    const byId = Object.fromEntries(res.body.integrations.map(entry => [entry.id, entry]));
    assert.deepEqual(byId.jira.apps, [{ id: 'tickets', name: 'Tickets' }]);
    // `websearch.provider: "auto"` uses the first engine the user may use.
    assert.deepEqual(byId.brave.apps, [{ id: 'research', name: 'Research' }]);
    assert.deepEqual(byId['nc-main'].apps, []);
    for (const entry of res.body.integrations) {
      assert.ok(Array.isArray(entry.categories), entry.id);
      assert.ok(Array.isArray(entry.connection.sharedWith), entry.id);
    }
  });
});
