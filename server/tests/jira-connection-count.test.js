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
const tokens = { accessToken: 'a', refreshToken: 'r', expiresIn: 3600 };

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
    resetJiraConnectionCount();
  });
  after(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('counts a first connection, not a token refresh, and a disconnect', async () => {
    await JiraService.storeUserTokens('u1', tokens);
    assert.equal(getJiraConnectionCount(), 1);
    await JiraService.storeUserTokens('u1', { ...tokens, accessToken: 'refreshed' });
    assert.equal(getJiraConnectionCount(), 1, 'a refresh is not a new connection');
    await JiraService.storeUserTokens('u2', tokens);
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
    await JiraService.storeUserTokens('u1', tokens);
    await JiraService.storeUserTokens('u2', tokens);
    resetJiraConnectionCount();
    const list = await connector.listConnections();
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
