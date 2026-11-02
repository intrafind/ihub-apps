// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The connection service of the unified integrations
 * (services/integrations/auth/IntegrationConnectionService.js): resolve,
 * refresh, revocation, endpoint invalidation, audit — with the real
 * installations' descriptors, the real token store (temp directory) and a
 * local token endpoint.
 *
 * Run: node --test server/tests/integrations/integrationConnectionService.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tokenStorage from '../../services/TokenStorageService.js';
import configCache from '../../configCache.js';
import credentialService from '../../services/CredentialService.js';
import GoogleDriveService from '../../services/integrations/GoogleDriveService.js';
import NextcloudService from '../../services/integrations/NextcloudService.js';
import {
  IntegrationConnectionService,
  connectionIdFor,
  terminalRefreshRejection
} from '../../services/integrations/auth/IntegrationConnectionService.js';
import { OAuthFlowStore } from '../../services/integrations/auth/oauthFlowStore.js';
import { FilesystemDocumentStore } from '../../storage/providers/filesystem/FilesystemDocumentStore.js';
import { validateIntegrationConnection } from '../../validators/integrationConnectionSchema.js';
import {
  fakeTokenEndpoint,
  connectThroughService,
  fakeRequest
} from '../helpers/integrationConnect.js';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'connection-service-'));
const saved = {
  base: tokenStorage.storageBasePath,
  key: tokenStorage.encryptionKey,
  getIntegrations: configCache.getIntegrations,
  getGroups: configCache.getGroups,
  resolveSecret: credentialService.resolveSecret
};

const installation = (id, definition, values, auth = { mode: 'oauth-user' }) => ({
  id,
  definition,
  enabled: true,
  values: { clientId: `${id}-client`, clientSecretRef: `${id}-secret`, ...values },
  auth
});
let installed;
function resetInstallations() {
  installed = [
    installation('gdrive', 'com.intrafind/google-drive', {}),
    installation('nc', 'com.intrafind/nextcloud', { serverUrl: 'https://nc.example.com' }),
    { id: 'ifinder', definition: 'com.intrafind/ifinder', enabled: true, values: {} },
    installation(
      'ckan',
      'com.example/ckan',
      {},
      { mode: 'service-account', credentialRef: 'ckan-key' }
    )
  ];
}

/** The service's own token endpoint, answered locally. */
function answer(service, answers) {
  const endpoint = fakeTokenEndpoint(answers);
  const original = Object.getPrototypeOf(service).oauthStrategy;
  service.oauthStrategy = function oauthStrategyForTest(...args) {
    const strategy = original.apply(this, args);
    return {
      ...strategy,
      async resolve(ctx) {
        return { ...(await strategy.resolve(ctx)), fetchFn: endpoint };
      }
    };
  };
  return endpoint;
}

const user = id => ({ type: 'user', id });
let audit;
let service;

function newService(now) {
  audit = [];
  const created = new IntegrationConnectionService({
    documents: null,
    flowStore: new OAuthFlowStore({ documents: null }),
    audit: entry => audit.push(entry),
    ...(now ? { now } : {})
  });
  created.refreshGraceMs = 0;
  return created;
}

before(() => {
  tokenStorage.storageBasePath = tmp;
  tokenStorage.encryptionKey = 'e'.repeat(64);
  configCache.getIntegrations = () => ({ data: { installed } });
  configCache.getGroups = () => ({
    data: { groups: { users: { id: 'users', permissions: { integrations: ['*'] } } } }
  });
  credentialService.resolveSecret = ref => `secret-of-${ref}`;
});

after(() => {
  tokenStorage.storageBasePath = saved.base;
  tokenStorage.encryptionKey = saved.key;
  configCache.getIntegrations = saved.getIntegrations;
  configCache.getGroups = saved.getGroups;
  credentialService.resolveSecret = saved.resolveSecret;
  delete GoogleDriveService.oauthStrategy;
  delete NextcloudService.oauthStrategy;
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(path.join(tmp, 'googledrive'), { recursive: true, force: true });
  rmSync(path.join(tmp, 'nextcloud'), { recursive: true, force: true });
  resetInstallations();
  service = newService();
});

async function connect(installationId, userId) {
  const outcome = await connectThroughService({ service, installationId, userId });
  assert.equal(outcome.outcome.ok, true, outcome.outcome.redirectTo);
  return outcome;
}

describe('resolve', () => {
  it("returns the principal's own connection and never another user's", async () => {
    answer(GoogleDriveService, [{}]);
    await connect('gdrive', 'alice@example.com');

    const alice = await service.resolve(user('alice@example.com'), 'gdrive');
    assert.equal(alice.ok, true);
    assert.equal(alice.kind, 'oauth-user');
    assert.deepEqual(alice.connection.principal, user('alice@example.com'));
    assert.match(
      alice.connection.secretRef,
      /^tokenstore:googledrive\/alice@example\.com__gdrive$/
    );
    assert.ok(!JSON.stringify(alice.connection).includes('access-1'), 'no token in the index');

    const bob = await service.resolve(user('bob'), 'gdrive');
    assert.equal(bob.ok, false);
    assert.equal(bob.error.code, 'INTEGRATION_AUTH_REQUIRED');
    assert.equal(bob.error.reason, 'not_connected');
    assert.equal(bob.error.integration, 'gdrive');
  });

  it('refuses anonymous and shared principals for a per-user OAuth integration', async () => {
    answer(GoogleDriveService, [{}]);
    await connect('gdrive', 'alice');
    assert.equal((await service.resolve(user('anonymous'), 'gdrive')).ok, false);
    assert.equal((await service.resolve({ type: 'shared', groups: ['x'] }, 'gdrive')).ok, false);
  });

  it('resolves iFinder as sso (nothing stored) and a service account as the shared credential', async () => {
    const ifinder = await service.resolve(user('alice'), 'ifinder');
    assert.equal(ifinder.ok, true);
    assert.equal(ifinder.kind, 'sso');
    assert.equal(ifinder.connection.secretRef, null);

    const forAlice = await service.resolve(user('alice'), 'ckan');
    const forBob = await service.resolve(user('bob'), 'ckan');
    assert.equal(forAlice.kind, 'service-account');
    assert.equal(forAlice.connection.secretRef, 'credential:ckan-key');
    assert.deepEqual(forAlice.connection.principal, { type: 'shared', groups: [] });
    assert.equal(forAlice.connection.id, forBob.connection.id);
  });

  it('invalidates a connection whose installation was repointed (another server URL)', async () => {
    answer(NextcloudService, [{ user_id: 'alice-nc' }]);
    await connect('nc', 'alice');
    const file = path.join(tmp, 'nextcloud', 'alice__nc.json');
    assert.ok(existsSync(file));
    assert.equal((await service.resolve(user('alice'), 'nc')).ok, true);

    installed[1] = installation('nc', 'com.intrafind/nextcloud', {
      serverUrl: 'https://other-nextcloud.example.com'
    });
    const after = await service.resolve(user('alice'), 'nc');
    assert.equal(after.ok, false);
    assert.equal(after.error.reason, 'expired');
    assert.equal(
      existsSync(file),
      false,
      'a token for the old server is never sent to the new one'
    );
    const record = await service.getConnection(connectionIdFor('nc', user('alice')));
    assert.equal(record.status, 'needs-reconnect');
  });

  it('reports insufficient_scope when the granted scopes lack a required one', async () => {
    answer(GoogleDriveService, [{ scope: 'drive.readonly' }]);
    await connect('gdrive', 'alice');
    const ok = await service.resolve(user('alice'), 'gdrive', {
      requiredScopes: ['drive.readonly']
    });
    assert.equal(ok.ok, true);
    const more = await service.resolve(user('alice'), 'gdrive', { requiredScopes: ['drive.file'] });
    assert.equal(more.ok, false);
    assert.equal(more.error.reason, 'insufficient_scope');
  });

  it('indexes a token file it meets without a record (no reconnect needed)', async () => {
    answer(GoogleDriveService, [{}]);
    await connect('gdrive', 'alice');
    const fresh = newService();
    const resolved = await fresh.resolve(user('alice'), 'gdrive');
    assert.equal(resolved.ok, true);
    assert.ok(await fresh.getConnection(connectionIdFor('gdrive', user('alice'))));
  });
});

describe('connect, refresh, disconnect', () => {
  it('writes connection.create and connection.revoke audit entries, revoking upstream', async () => {
    const endpoint = answer(GoogleDriveService, [{}]);
    await connect('gdrive', 'alice');
    assert.deepEqual(
      audit.map(entry => [entry.resource, entry.action, entry.resourceId]),
      [['connection', 'create', 'gdrive:alice']]
    );

    const result = await service.disconnect({ installationId: 'gdrive', userId: 'alice' });
    assert.deepEqual(result, { removed: true, revoked: true });
    assert.ok(endpoint.calls.some(call => call.url === 'https://oauth2.googleapis.com/revoke'));
    assert.deepEqual(audit.at(-1).resource, 'connection');
    assert.deepEqual(audit.at(-1).action, 'revoke');
    assert.equal(
      (await service.getConnection(connectionIdFor('gdrive', user('alice')))).status,
      'revoked'
    );
    const after = await service.resolve(user('alice'), 'gdrive');
    assert.equal(after.ok, false);
  });

  it('refreshes once for concurrent callers (single flight) and keeps the issuer binding', async () => {
    const endpoint = answer(GoogleDriveService, [{ expires_in: 1 }, { refresh_token: undefined }]);
    await connect('gdrive', 'alice');
    const [a, b] = await Promise.all([
      service.getUserTokens({ installationId: 'gdrive', userId: 'alice', forceRefresh: true }),
      service.getUserTokens({ installationId: 'gdrive', userId: 'alice', forceRefresh: true })
    ]);
    const refreshes = endpoint.calls.filter(
      call => call.params.get('grant_type') === 'refresh_token'
    );
    assert.equal(refreshes.length, 1);
    assert.equal(a.accessToken, 'access-2');
    assert.equal(b.accessToken, 'access-2');
    assert.equal(a.refreshToken, 'refresh-1', 'an unrotated refresh token is kept');
    assert.equal(a.binding.issuer, 'https://accounts.google.com');
    assert.equal(a.binding.clientId, 'gdrive-client');
  });

  it('deletes the tokens only when the refresh token is refused', async () => {
    answer(GoogleDriveService, [{}, { status: 400, body: { error: 'invalid_grant' } }]);
    await connect('gdrive', 'alice');
    const error = await service
      .getUserTokens({ installationId: 'gdrive', userId: 'alice', forceRefresh: true })
      .catch(e => e);
    assert.equal(error.code, 'INTEGRATION_AUTH_REQUIRED');
    assert.equal(error.reason, 'expired');
    assert.equal(existsSync(path.join(tmp, 'googledrive', 'alice__gdrive.json')), false);
    const record = await service.getConnection(connectionIdFor('gdrive', user('alice')));
    assert.equal(record.status, 'expired');
    assert.equal(record.error, 'invalid_grant');
  });

  it('keeps the tokens on a transient failure or a client problem an admin can fix', async () => {
    for (const failure of [
      { status: 503, body: {} },
      { status: 401, body: { error: 'invalid_client' } }
    ]) {
      service = newService();
      answer(GoogleDriveService, [{}, failure]);
      await connect('gdrive', 'alice');
      const error = await service
        .getUserTokens({ installationId: 'gdrive', userId: 'alice', forceRefresh: true })
        .catch(e => e);
      assert.equal(error.code, 'integration_unavailable', JSON.stringify(failure));
      assert.ok(existsSync(path.join(tmp, 'googledrive', 'alice__gdrive.json')));
      const record = await service.getConnection(connectionIdFor('gdrive', user('alice')));
      assert.equal(record.status, 'active');
      assert.equal(record.error, 'refresh_unavailable');
    }
  });

  it('forgets every record of a deleted user', async () => {
    answer(GoogleDriveService, [{}]);
    await connect('gdrive', 'alice');
    answer(NextcloudService, [{}]);
    await connect('nc', 'alice');
    assert.equal(await service.forgetUser('alice'), 2);
    assert.deepEqual(await service.listConnections({ userId: 'alice' }), []);
  });
});

describe('which refused refresh ends a connection', () => {
  it('ends it for a refused refresh token, keeps it for a client problem an admin fixes', () => {
    const err = (errorCode, errorDescription) => ({ errorCode, errorDescription });
    assert.equal(terminalRefreshRejection(err('invalid_grant')), 'invalid_grant');
    assert.equal(terminalRefreshRejection(err('other_client')), 'other_client');
    assert.equal(
      terminalRefreshRejection(err('unauthorized_client', 'refresh_token is invalid')),
      'unauthorized_client'
    );
    assert.equal(
      terminalRefreshRejection(err('invalid_client', 'The refresh token has expired')),
      'invalid_client'
    );
    assert.equal(terminalRefreshRejection(err('invalid_client', 'client secret expired')), null);
    assert.equal(terminalRefreshRejection(err('unauthorized_client')), null);
    assert.equal(terminalRefreshRejection(err('temporarily_unavailable')), null);
    assert.equal(terminalRefreshRejection(new Error('ECONNRESET')), null);
  });
});

describe('review fixes (#3140)', () => {
  const member = id => ({ id, groups: ['users'], permissions: { integrations: ['*'] } });
  const forceRefresh = (installationId = 'gdrive', userId = 'alice') =>
    service.getUserTokens({ installationId, userId, forceRefresh: true }).catch(e => e);

  it('ends the connection when Atlassian-style 403 unauthorized_client refuses the refresh token', async () => {
    answer(GoogleDriveService, [
      {},
      {
        status: 403,
        body: { error: 'unauthorized_client', error_description: 'refresh_token is invalid' }
      }
    ]);
    await connect('gdrive', 'alice');
    const error = await forceRefresh();
    assert.equal(error.code, 'INTEGRATION_AUTH_REQUIRED');
    assert.equal(error.reason, 'expired');
    assert.equal(existsSync(path.join(tmp, 'googledrive', 'alice__gdrive.json')), false);
    const record = await service.getConnection(connectionIdFor('gdrive', user('alice')));
    assert.equal(record.status, 'expired');
    assert.equal(record.error, 'unauthorized_client');
  });

  it('backs off after repeated transient failures, then gives up with failed', async () => {
    let clock = Date.parse('2026-11-02T10:00:00Z');
    service = newService(() => clock);
    const endpoint = answer(GoogleDriveService, [{}, { status: 503, body: {} }]);
    await connect('gdrive', 'alice');
    const refreshes = () =>
      endpoint.calls.filter(call => call.params.get('grant_type') === 'refresh_token').length;
    for (let i = 0; i < 3; i++) {
      assert.equal((await forceRefresh()).code, 'integration_unavailable');
    }
    assert.equal(refreshes(), 3);
    const id = connectionIdFor('gdrive', user('alice'));
    let record = await service.getConnection(id);
    assert.equal(record.refreshFailures, 3);
    assert.ok(record.retryAfter, 'a cooldown after three failures in a row');
    // Within the cooldown the token endpoint is left alone.
    assert.equal((await forceRefresh()).code, 'integration_unavailable');
    assert.equal(refreshes(), 3);
    // After it, iHub asks again; after ten failures in a row the connection is failed.
    for (let i = 0; i < 7; i++) {
      clock += 2 * 60 * 60 * 1000;
      await forceRefresh();
    }
    assert.equal(refreshes(), 10);
    record = await service.getConnection(id);
    assert.equal(record.status, 'failed');
    const resolved = await service.resolve(user('alice'), 'gdrive');
    assert.equal(resolved.ok, false);
    assert.equal(resolved.error.reason, 'expired');
    assert.equal((await forceRefresh()).reason, 'expired', 'a failed connection is not used');
  });

  it('resets the failure count after a successful refresh', async () => {
    answer(GoogleDriveService, [{}, { status: 503, body: {} }, { status: 503, body: {} }, {}]);
    await connect('gdrive', 'alice');
    await forceRefresh();
    await forceRefresh();
    const ok = await forceRefresh();
    assert.equal(ok.accessToken, 'access-4');
    const record = await service.getConnection(connectionIdFor('gdrive', user('alice')));
    assert.equal(record.refreshFailures, 0);
    assert.equal(record.retryAfter, null);
  });

  it('keeps tokens another worker rotated while this refresh was refused', async () => {
    const file = path.join(tmp, 'googledrive', 'alice__gdrive.json');
    answer(GoogleDriveService, [
      {},
      async () => {
        // Another worker refreshed first with the rotating refresh token.
        await tokenStorage.storeUserTokens(
          'alice',
          'googledrive',
          { accessToken: 'from-worker-2', refreshToken: 'rotated', providerId: 'gdrive' },
          'gdrive'
        );
        return { status: 400, body: { error: 'invalid_grant' } };
      }
    ]);
    await connect('gdrive', 'alice');
    const tokens = await forceRefresh();
    assert.equal(tokens.accessToken, 'from-worker-2');
    assert.ok(existsSync(file), 'nothing deleted');
  });

  it('does not send tokens to a server or client they were not issued to on disconnect', async () => {
    const endpoint = answer(GoogleDriveService, [{}]);
    await connect('gdrive', 'alice');
    installed[0] = installation('gdrive', 'com.intrafind/google-drive', {
      clientId: 'another-client'
    });
    const result = await service.disconnect({ installationId: 'gdrive', userId: 'alice' });
    assert.deepEqual(result, { removed: true, revoked: false });
    assert.equal(
      endpoint.calls.filter(call => call.url.endsWith('/revoke')).length,
      0,
      'no revocation request'
    );
  });

  it('never adopts a legacy unscoped file while several installations of the service exist', async () => {
    installed.push(
      installation('nc2', 'com.intrafind/nextcloud', { serverUrl: 'https://nc2.example.com' })
    );
    await tokenStorage.storeUserTokens('alice', 'nextcloud', {
      accessToken: 'legacy',
      refreshToken: 'legacy-r',
      expiresIn: 3600
    });
    const legacy = path.join(tmp, 'nextcloud', 'alice.json');
    const before = readFileSync(legacy, 'utf8');
    for (const id of ['nc', 'nc2']) {
      const resolved = await service.resolve(user('alice'), id);
      assert.equal(resolved.ok, false, id);
      assert.equal(resolved.error.reason, 'not_connected');
      assert.equal(
        (await service.disconnect({ installationId: id, userId: 'alice' })).removed,
        false
      );
    }
    assert.equal(readFileSync(legacy, 'utf8'), before, 'the legacy file is untouched');

    // With one installation of the service the legacy file is that installation's.
    installed.pop();
    const single = await service.resolve(user('alice'), 'nc');
    assert.equal(single.ok, true);
    assert.equal(single.connection.secretRef, 'tokenstore:nextcloud/alice');
    rmSync(legacy, { force: true });
  });

  it('does not trust a record whose token file is gone', async () => {
    answer(GoogleDriveService, [{}]);
    await connect('gdrive', 'alice');
    rmSync(path.join(tmp, 'googledrive', 'alice__gdrive.json'));
    const resolved = await service.resolve(user('alice'), 'gdrive');
    assert.equal(resolved.ok, false);
    assert.equal(resolved.error.reason, 'not_connected');
    const record = await service.getConnection(connectionIdFor('gdrive', user('alice')));
    assert.equal(record.status, 'revoked');
  });

  it('invalidateInstallation deletes exactly the token files the records name', async () => {
    answer(GoogleDriveService, [{}]);
    await connect('gdrive', 'alice');
    await connect('gdrive', 'bob');
    assert.equal(await service.invalidateInstallation('gdrive'), 2);
    assert.equal(existsSync(path.join(tmp, 'googledrive', 'alice__gdrive.json')), false);
    assert.equal(existsSync(path.join(tmp, 'googledrive', 'bob__gdrive.json')), false);
    const record = await service.getConnection(connectionIdFor('gdrive', user('bob')));
    assert.equal(record.status, 'needs-reconnect');
  });

  it("does not burn the owner's sign-in on a callback from another user or installation", async () => {
    answer(GoogleDriveService, [{}]);
    const alice = member('alice');
    const { authorizationUrl } = await service.beginConnect({
      installationId: 'gdrive',
      user: alice,
      req: fakeRequest({ user: alice }),
      returnUrl: '/apps/chat'
    });
    const state = authorizationUrl.searchParams.get('state');
    const mallory = await service.completeConnect({
      req: fakeRequest({ user: member('mallory'), query: { code: 'c', state } })
    });
    assert.equal(mallory.ok, false);
    assert.equal(
      mallory.redirectTo,
      '/settings/integrations?integration_error=user_mismatch&integration=gdrive'
    );
    const elsewhere = await service.completeConnect({
      req: fakeRequest({ user: alice, query: { code: 'c', state } }),
      alias: { installationId: 'nc', stack: 'cloud-storage' }
    });
    assert.equal(elsewhere.ok, false);
    const owner = await service.completeConnect({
      req: fakeRequest({ user: alice, query: { code: 'c', state } })
    });
    assert.equal(owner.ok, true, owner.redirectTo);
  });

  it('the re-index writes create-only: a record written meanwhile is kept', async () => {
    const documents = new FilesystemDocumentStore({ baseDir: path.join(tmp, 'docs') });
    const stored = newService();
    stored._documents = documents;
    stored._pinned = true;
    const record = {
      id: connectionIdFor('gdrive', user('alice')),
      integration: 'gdrive',
      principal: user('alice'),
      kind: 'oauth-user',
      status: 'active',
      secretRef: 'tokenstore:googledrive/alice__gdrive',
      lastUsedAt: '2026-11-02T09:00:00.000Z'
    };
    assert.equal((await stored.createConnection(record)).created, true);
    const again = await stored.createConnection({ ...record, lastUsedAt: null, status: 'expired' });
    assert.equal(again.created, false);
    assert.equal(again.record.lastUsedAt, '2026-11-02T09:00:00.000Z');
    assert.equal(again.record.status, 'active');
  });
});

describe('connection record schema (#2912)', () => {
  const valid = {
    id: connectionIdFor('gdrive', user('alice')),
    integration: 'gdrive',
    principal: user('alice'),
    kind: 'oauth-user',
    status: 'active',
    secretRef: 'tokenstore:googledrive/alice__gdrive',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z'
  };

  it('accepts a valid record and fills the optional fields', () => {
    const parsed = validateIntegrationConnection(valid);
    assert.equal(parsed.success, true);
    assert.deepEqual(parsed.data.scopesGranted, []);
    assert.equal(parsed.data.lastUsedAt, null);
  });

  it('refuses a shared personal OAuth grant, an sso secret, a token as secretRef and bad statuses', () => {
    for (const bad of [
      { ...valid, principal: { type: 'shared', groups: ['legal'] } },
      { ...valid, kind: 'sso' },
      { ...valid, secretRef: 'eyJhbGciOiJSUzI1NiJ9.token' },
      { ...valid, secretRef: 'credential:svc' },
      { ...valid, status: 'connected' },
      { ...valid, kind: 'service-account', secretRef: null },
      { ...valid, id: 'alice' }
    ]) {
      assert.equal(validateIntegrationConnection(bad).success, false, JSON.stringify(bad));
    }
  });
});
