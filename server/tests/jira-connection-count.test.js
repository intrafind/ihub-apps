// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The "users connected" count of the Jira installation: adjusted as users
 * connect and disconnect, left alone by a token refresh, and re-counted from
 * the token files in the background at most once per 30 s.
 *
 * Run: node --test server/tests/jira-connection-count.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import tokenStorage from '../services/TokenStorageService.js';

// The token store writes to a temp directory with an in-memory key, before
// the connector module is loaded (it seeds the count from disk on import).
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'jira-connections-'));
tokenStorage.storageBasePath = tmp;
tokenStorage.encryptionKey = 'd'.repeat(64);

const JiraService = (await import('../services/integrations/JiraService.js')).default;
const { default: configCache } = await import('../configCache.js');
const { default: credentialService } = await import('../services/CredentialService.js');
const { IntegrationConnectionService } =
  await import('../services/integrations/auth/IntegrationConnectionService.js');
const { setIntegrationConnectionServiceForTests } =
  await import('../services/integrations/auth/IntegrationConnectionService.js');
const { OAuthFlowStore } = await import('../services/integrations/auth/oauthFlowStore.js');
const { fakeTokenEndpoint, connectThroughService } =
  await import('./helpers/integrationConnect.js');

// The Jira installation, its client secret and a local token endpoint.
configCache.getIntegrations = () => ({
  data: {
    installed: [
      {
        id: 'jira',
        definition: 'com.intrafind/jira',
        enabled: true,
        values: {
          clientId: 'client-1',
          clientSecretRef: 'jira-secret',
          redirectUri: 'https://ihub.example/api/integrations/jira/callback'
        }
      }
    ]
  }
});
credentialService.resolveSecret = () => 'jira-client-secret';
const tokenEndpoint = fakeTokenEndpoint([{}]);
const originalStrategy = JiraService.oauthStrategy;
JiraService.oauthStrategy = function oauthStrategyForTest() {
  const strategy = originalStrategy.call(this);
  return {
    ...strategy,
    async resolve(ctx) {
      return { ...(await strategy.resolve(ctx)), fetchFn: tokenEndpoint };
    }
  };
};
const service = new IntegrationConnectionService({
  documents: null,
  flowStore: new OAuthFlowStore({ documents: null })
});
setIntegrationConnectionServiceForTests(service);

/** Connect a user (or connect again: a re-consent rewrites the same file). */
function connect(userId) {
  return connectThroughService({ service, installationId: 'jira', userId });
}
const {
  JIRA_CONNECTION_COUNT_REFRESH_MS,
  adjustJiraConnectionCount,
  getJiraConnectionCount,
  refreshJiraConnectionCount,
  resetJiraConnectionCount
} = await import('../services/integrations/jiraConnectionCount.js');
const connector = (
  await import('../services/integrations/protocols/native/connectors/jira/index.js')
).default;

const jiraDir = path.join(tmp, 'jira');

/** A token file another worker wrote; the listing only needs the file to exist. */
async function writeForeignTokenFile(userId) {
  await fs.mkdir(jiraDir, { recursive: true });
  await fs.writeFile(
    path.join(jiraDir, `${userId}.json`),
    JSON.stringify({ createdAt: new Date().toISOString(), expiresAt: null })
  );
}

async function clearTokenFiles() {
  await fs.rm(jiraDir, { recursive: true, force: true });
}

describe('Jira connection count', () => {
  before(async () => {
    await refreshJiraConnectionCount({ force: true });
  });
  beforeEach(async () => {
    await clearTokenFiles();
    service.memory.clear();
    resetJiraConnectionCount();
  });
  after(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('counts a first connection, not a reconnect, and a disconnect', async () => {
    await connect('u1');
    assert.equal(getJiraConnectionCount(), 1);
    await connect('u1');
    assert.equal(getJiraConnectionCount(), 1, 'a reconnect is not a new connection');
    await connect('u2');
    assert.equal(getJiraConnectionCount(), 2);

    assert.equal(await JiraService.deleteUserTokens('u1'), true);
    assert.equal(getJiraConnectionCount(), 1);
    assert.equal(await JiraService.deleteUserTokens('u1'), false);
    assert.equal(getJiraConnectionCount(), 1, 'nothing removed, nothing counted');
    assert.equal(await JiraService.deleteUserTokens('u2'), true);
    assert.equal(getJiraConnectionCount(), 0);
  });

  it('never goes below zero', () => {
    assert.equal(adjustJiraConnectionCount(-1), 0);
  });

  it('re-counts the token files at most once per refresh interval', async () => {
    await writeForeignTokenFile('a');
    await writeForeignTokenFile('b');
    assert.equal(await refreshJiraConnectionCount({ now: 1000 }), 2);

    await writeForeignTokenFile('c');
    const soon = 1000 + JIRA_CONNECTION_COUNT_REFRESH_MS - 1;
    assert.equal(await refreshJiraConnectionCount({ now: soon }), 2, 'throttled');
    assert.equal(await refreshJiraConnectionCount({ now: soon, force: true }), 3, 'forced');

    await writeForeignTokenFile('d');
    assert.equal(await refreshJiraConnectionCount({ now: soon }), 3, 'throttled again');
    assert.equal(
      await refreshJiraConnectionCount({ now: soon + JIRA_CONNECTION_COUNT_REFRESH_MS }),
      4,
      'interval elapsed'
    );
  });

  it('shares one in-flight listing', async () => {
    await writeForeignTokenFile('a');
    const first = refreshJiraConnectionCount({ force: true });
    const second = refreshJiraConnectionCount({ force: true });
    assert.equal(first, second);
    assert.equal(await first, 1);
  });

  it('status() reports the count and refreshes it in the background', async () => {
    const instance = { enabled: true, values: { clientId: 'c', clientSecretRef: 'ref' } };
    await writeForeignTokenFile('x');
    await writeForeignTokenFile('y');

    const stale = connector.status(instance);
    assert.deepEqual(stale, { connected: true, perUser: true, userConnections: 0 });
    // status() started the listing; awaiting the throttled refresh joins it.
    await refreshJiraConnectionCount();
    assert.equal(getJiraConnectionCount(), 2);
    assert.equal(connector.status(instance).userConnections, 2);

    // Within the interval a further status() call does not re-count.
    await writeForeignTokenFile('z');
    connector.status(instance);
    await refreshJiraConnectionCount();
    assert.equal(getJiraConnectionCount(), 2);
  });

  it('listConnections() and an admin disconnect keep the count exact', async () => {
    await connect('u1');
    await connect('u2');
    resetJiraConnectionCount();
    const list = await connector.listConnections({ id: 'jira' });
    assert.deepEqual(
      list.map(c => c.userId),
      ['u1', 'u2']
    );
    assert.equal(getJiraConnectionCount(), 2);

    assert.deepEqual(await connector.disconnectUser(null, 'u1'), { removed: true });
    assert.equal(getJiraConnectionCount(), 1);
    assert.deepEqual(await connector.disconnectUser(null, 'u1'), { removed: false });
    assert.equal(getJiraConnectionCount(), 1);
  });
});
