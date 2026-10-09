/**
 * What deleting a user takes with it.
 *
 * Removing the users.json record ends the user's access, but not the rest of
 * what is filed under their id: connections, personal API keys, the credentials
 * they stored for other systems, tasks and content. Left behind it is personal
 * data nobody can reach any more, and a personal API key would keep
 * authenticating for an owner who no longer exists.
 *
 * The properties this suite keeps true:
 *
 * - **Only that user's.** Every store removes the deleted user's entries and
 *   leaves everyone else's, including entries that merely look alike.
 * - **One failing step does not strand the rest.** A single unreadable store
 *   must not leave the user's other credentials behind.
 * - **The cleanup is not part of the request.** It starts at once and the caller
 *   does not wait for it.
 *
 * Native-ESM jest (`NODE_OPTIONS=--experimental-vm-modules`); see the
 * `test:auth-routes` npm script.
 */

import { jest } from '@jest/globals';
import os from 'os';
import path from 'path';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync, readFileSync } from 'fs';

const state = {
  rootDir: mkdtempSync(path.join(os.tmpdir(), 'ihub-user-deletion-')),
  platform: {}
};

// Outside `contents/` on purpose: the clients file is then written directly
// rather than through the configuration store.
const CLIENTS_FILE = path.join(state.rootDir, 'oauth-clients.json');

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

jest.unstable_mockModule('../configSync.js', () => ({
  announceConfigChange: () => {}
}));

const { grantConsent, hasConsent, listConsents } = await import('../utils/consentStore.js');
const { generateRefreshToken, storeRefreshToken, consumeRefreshToken } =
  await import('../utils/refreshTokenStore.js');
const { revokeConnectionsForUser } = await import('../services/oauth/ConnectionService.js');
const { deletePersonalClientsByOwner, loadOAuthClients } =
  await import('../utils/oauthClientManager.js');
const { default: tokenStorageService } = await import('../services/TokenStorageService.js');
const { tokenStorageIdFor } = await import('../services/mcp/mcpUserTokens.js');
const { deleteChatsOfOwner } = await import('../services/chat/chatDeletion.js');
const { USER_CLEANUP_STEPS, cleanUpDeletedUser, startUserCleanup, waitForUserCleanups } =
  await import('../services/userDeletion.js');

const SCOPES = ['openid'];

describe('refresh tokens', () => {
  it('are revoked for every client of the user, and only that user', async () => {
    const [a1, a2, b1] = [generateRefreshToken(), generateRefreshToken(), generateRefreshToken()];
    await storeRefreshToken(a1, { clientId: 'client-one', userId: 'alice', scopes: SCOPES });
    await storeRefreshToken(a2, { clientId: 'client-two', userId: 'alice', scopes: SCOPES });
    await storeRefreshToken(b1, { clientId: 'client-one', userId: 'bob', scopes: SCOPES });

    const { refreshTokensRevoked } = await revokeConnectionsForUser('alice');

    expect(refreshTokensRevoked).toBe(2);
    expect(await consumeRefreshToken(a1)).toBeNull();
    expect(await consumeRefreshToken(a2)).toBeNull();
    expect(await consumeRefreshToken(b1)).toMatchObject({ userId: 'bob' });
  });
});

describe('consents', () => {
  it('are removed for every client of the user, lapsed ones too, and only that user', async () => {
    await grantConsent('client-one', 'carol', SCOPES);
    await grantConsent('client-two', 'carol', SCOPES);
    await grantConsent('client-one', 'dave', SCOPES);
    // A user whose id is a prefix of another's must not take theirs along.
    await grantConsent('client-one', 'carol-2', SCOPES);
    const store = path.join(state.rootDir, 'contents', 'data', 'oauth-consent.json');
    const stored = JSON.parse(readFileSync(store, 'utf8'));
    stored.consents['client-two:carol'].expiresAt = '2000-01-01T00:00:00.000Z';
    writeFileSync(store, JSON.stringify(stored));

    const { consentsRevoked } = await revokeConnectionsForUser('carol');

    expect(consentsRevoked).toBe(2);
    expect(hasConsent('client-one', 'carol', SCOPES)).toBe(false);
    expect(hasConsent('client-one', 'dave', SCOPES)).toBe(true);
    expect(hasConsent('client-one', 'carol-2', SCOPES)).toBe(true);
    expect(listConsents({ userId: 'carol' })).toEqual([]);
  });

  it('removes nothing, and does not write, for a user without any', async () => {
    expect(await revokeConnectionsForUser('nobody')).toEqual({
      consentsRevoked: 0,
      refreshTokensRevoked: 0
    });
    expect(await revokeConnectionsForUser('')).toEqual({
      consentsRevoked: 0,
      refreshTokensRevoked: 0
    });
  });
});

describe('personal API keys', () => {
  const client = (clientId, extra = {}) => ({
    clientId,
    name: clientId,
    active: true,
    ...extra
  });

  beforeEach(() => {
    writeFileSync(
      CLIENTS_FILE,
      JSON.stringify({
        clients: {
          'key-alice-1': client('key-alice-1', { personal: true, ownerUserId: 'alice' }),
          'key-alice-2': client('key-alice-2', { personal: true, ownerUserId: 'alice' }),
          'key-bob': client('key-bob', { personal: true, ownerUserId: 'bob' }),
          // Made by alice, but a client other people use: not hers to take away.
          shared: client('shared', { createdBy: 'alice' }),
          // Owner field without being a personal key.
          odd: client('odd', { ownerUserId: 'alice' })
        },
        metadata: { version: '1.0.0' }
      })
    );
  });

  it('are deleted with their owner, and only theirs', async () => {
    const removed = await deletePersonalClientsByOwner(CLIENTS_FILE, 'alice', 'test');

    expect(removed.sort()).toEqual(['key-alice-1', 'key-alice-2']);
    const left = Object.keys(JSON.parse(readFileSync(CLIENTS_FILE, 'utf8')).clients).sort();
    expect(left).toEqual(['key-bob', 'odd', 'shared']);
    expect(Object.keys(loadOAuthClients(CLIENTS_FILE).clients)).not.toContain('key-alice-1');
  });

  it('leave the file alone when the user has none', async () => {
    const before = readFileSync(CLIENTS_FILE, 'utf8');

    expect(await deletePersonalClientsByOwner(CLIENTS_FILE, 'nobody', 'test')).toEqual([]);
    expect(await deletePersonalClientsByOwner(CLIENTS_FILE, '', 'test')).toEqual([]);
    expect(readFileSync(CLIENTS_FILE, 'utf8')).toBe(before);
  });
});

describe('integration and MCP tokens', () => {
  const dir = service => path.join(state.rootDir, 'contents', 'integrations', service);
  const put = (service, file) => {
    mkdirSync(dir(service), { recursive: true });
    writeFileSync(path.join(dir(service), file), '{}');
  };
  const files = service => (existsSync(dir(service)) ? readdirSync(dir(service)).sort() : []);

  it('are deleted across services and providers for the user, and only that user', async () => {
    put('jira', 'erin__jira-cloud.json');
    put('jira', 'erin__jira-onprem.json');
    put('jira', 'frank__jira-cloud.json');
    put('office365', 'erin__tenant-a.json');
    // The legacy single slot, and a user whose id merely starts with the same letters.
    put('nextcloud', 'erin.json');
    put('nextcloud', 'erin-2__server.json');
    put('nextcloud', 'erinaceous.json');

    const removed = await tokenStorageService.deleteAllTokensForStorageIds(['erin']);

    expect(removed).toBe(4);
    expect(files('jira')).toEqual(['frank__jira-cloud.json']);
    expect(files('office365')).toEqual([]);
    expect(files('nextcloud')).toEqual(['erin-2__server.json', 'erinaceous.json']);
  });

  it('also reach the files an MCP server keeps under a hashed id', async () => {
    const odd = 'auth0|507f1f77bcf86cd799439011';
    const hashed = tokenStorageIdFor(odd);
    expect(hashed).not.toBe(odd);
    put('mcp', `${hashed}__server-a.json`);
    put('mcp', `${tokenStorageIdFor('someone-else')}__server-a.json`);

    const removed = await tokenStorageService.deleteAllTokensForStorageIds([
      odd,
      tokenStorageIdFor(odd)
    ]);

    expect(removed).toBe(1);
    expect(files('mcp')).toEqual([`${tokenStorageIdFor('someone-else')}__server-a.json`]);
  });

  it('ignore ids that are not file names, and a store that does not exist', async () => {
    expect(await tokenStorageService.deleteAllTokensForStorageIds(['../../etc/passwd', ''])).toBe(
      0
    );
    const previous = tokenStorageService.storageBasePath;
    tokenStorageService.storageBasePath = path.join(state.rootDir, 'not-there');
    try {
      expect(await tokenStorageService.deleteAllTokensForStorageIds(['erin'])).toBe(0);
    } finally {
      tokenStorageService.storageBasePath = previous;
    }
  });
});

describe('chats of an owner', () => {
  /** A repository holding `chats`, listing at most `visible` of them at a time. */
  const fakeRepository = (chats, { visible = Infinity } = {}) => {
    const live = new Map(chats.map(chat => [chat.id, chat]));
    return {
      live,
      isAvailable: () => true,
      listChats: jest.fn(async (_ownerId, { limit, cursor }) => {
        const all = [...live.values()].slice(0, visible);
        const start = cursor ? Number(cursor) : 0;
        const items = all.slice(start, start + limit);
        return { items, nextCursor: start + limit < all.length ? String(start + limit) : null };
      }),
      deleteChat: jest.fn(async id => ({ deleted: live.delete(id), runIds: [`run-of-${id}`] }))
    };
  };
  const deps = () => ({
    deleteRun: jest.fn(async () => {}),
    removeWorkflowState: jest.fn(async () => {}),
    deleteShares: jest.fn(async () => {}),
    component: 'Test'
  });
  const chat = (id, extra = {}) => ({ id, ...extra });

  it('all go, across pages, each through the cascade', async () => {
    const chats = Array.from({ length: 250 }, (_, i) => chat(`c${i}`));
    const repository = fakeRepository(chats);
    const d = deps();

    expect(await deleteChatsOfOwner(repository, 'alice', d)).toBe(250);

    expect(repository.live.size).toBe(0);
    expect(d.deleteRun).toHaveBeenCalledTimes(250);
    expect(d.removeWorkflowState).toHaveBeenCalledTimes(250);
    expect(d.deleteShares).toHaveBeenCalledTimes(250);
  });

  it('are listed again when one listing could not show them all', async () => {
    const chats = Array.from({ length: 12 }, (_, i) => chat(`c${i}`));
    const repository = fakeRepository(chats, { visible: 5 });

    expect(await deleteChatsOfOwner(repository, 'alice', deps())).toBe(12);
    expect(repository.live.size).toBe(0);
  });

  it('stop at a chat that will not go instead of looping', async () => {
    const repository = fakeRepository([chat('stuck')]);
    repository.deleteChat = jest.fn(async () => ({ deleted: false, runIds: [] }));

    expect(await deleteChatsOfOwner(repository, 'alice', deps())).toBe(0);
    expect(repository.listChats).toHaveBeenCalledTimes(1);
  });

  it('stop a chat that is still generating before removing it', async () => {
    const order = [];
    const repository = fakeRepository([chat('busy', { status: 'running' }), chat('idle')]);
    const original = repository.deleteChat;
    repository.deleteChat = jest.fn(async id => {
      order.push(`delete ${id}`);
      return original(id);
    });
    const stopChat = jest.fn(async c => order.push(`stop ${c.id}`));

    await deleteChatsOfOwner(repository, 'alice', { ...deps(), stopChat });

    expect(order).toEqual(['stop busy', 'delete busy', 'delete idle']);
  });

  it('do nothing without an owner or a store', async () => {
    const repository = fakeRepository([chat('c1')]);
    expect(await deleteChatsOfOwner(repository, '', deps())).toBe(0);
    repository.isAvailable = () => false;
    expect(await deleteChatsOfOwner(repository, 'alice', deps())).toBe(0);
    expect(repository.live.size).toBe(1);
  });
});

describe('the cleanup', () => {
  const step = (name, run) => ({ name, run: jest.fn(run) });

  it('covers what a user owns, in an order that stops a task before its chats go', () => {
    const names = USER_CLEANUP_STEPS.map(entry => entry.name);

    expect(names).toEqual([
      'personalApiKeys',
      'oauthConnections',
      'integrationTokens',
      'mcpConnections',
      'scheduledTasks',
      'chats',
      'userPrompts',
      'userSkills',
      'shortLinks'
    ]);
    expect(names.indexOf('scheduledTasks')).toBeLessThan(names.indexOf('chats'));
  });

  it('tells what lets something act as the user from what the user made', () => {
    const kindOf = name => USER_CLEANUP_STEPS.find(entry => entry.name === name).kind;

    for (const name of [
      'personalApiKeys',
      'oauthConnections',
      'integrationTokens',
      'mcpConnections',
      'scheduledTasks'
    ]) {
      expect(kindOf(name)).toBe('access');
    }
    for (const name of ['chats', 'userPrompts', 'userSkills', 'shortLinks']) {
      expect(kindOf(name)).toBe('content');
    }
  });

  it('runs every step with the user and the platform, and reports what each removed', async () => {
    const first = step('first', async () => ({ removed: 2 }));
    const second = step('second', async () => ({ removed: 0 }));

    const outcome = await cleanUpDeletedUser({
      userId: 'alice',
      platform: { marker: true },
      steps: [first, second]
    });

    expect(first.run).toHaveBeenCalledWith('alice', { marker: true });
    expect(second.run).toHaveBeenCalledWith('alice', { marker: true });
    expect(outcome).toEqual({
      results: { first: { removed: 2 }, second: { removed: 0 } },
      failed: []
    });
  });

  it('carries on after a step fails, and names it', async () => {
    const broken = step('broken', async () => {
      throw new Error('store unreadable');
    });
    const after = step('after', async () => ({ removed: 1 }));

    const outcome = await cleanUpDeletedUser({
      userId: 'alice',
      platform: {},
      steps: [broken, after]
    });

    expect(after.run).toHaveBeenCalled();
    expect(outcome.failed).toEqual(['broken']);
    expect(outcome.results).toEqual({ after: { removed: 1 } });
  });

  it('starts in the background: the caller is not held up by a slow step', async () => {
    let release;
    const slow = step(
      'slow',
      () => new Promise(resolve => (release = () => resolve({ removed: 1 })))
    );
    const onDone = jest.fn();

    startUserCleanup({ userId: 'alice', platform: {}, steps: [slow], onDone });
    await new Promise(resolve => setImmediate(resolve));

    expect(slow.run).toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();

    release();
    await waitForUserCleanups();

    expect(onDone).toHaveBeenCalledWith({ results: { slow: { removed: 1 } }, failed: [] });
  });

  it('does not reject when the callback throws: nobody is waiting to hear of it', async () => {
    const onDone = jest.fn(() => {
      throw new Error('audit unavailable');
    });

    startUserCleanup({
      userId: 'alice',
      platform: {},
      steps: [step('ok', async () => ({}))],
      onDone
    });

    await expect(waitForUserCleanups()).resolves.toBeUndefined();
    expect(onDone).toHaveBeenCalled();
  });

  it('removes the credentials of the user through the real stores', async () => {
    writeFileSync(
      CLIENTS_FILE,
      JSON.stringify({
        clients: { 'key-zed': { clientId: 'key-zed', personal: true, ownerUserId: 'zed' } },
        metadata: { version: '1.0.0' }
      })
    );
    const token = generateRefreshToken();
    await storeRefreshToken(token, { clientId: 'client-one', userId: 'zed', scopes: SCOPES });
    await grantConsent('client-one', 'zed', SCOPES);
    mkdirSync(path.join(state.rootDir, 'contents', 'integrations', 'jira'), { recursive: true });
    writeFileSync(
      path.join(state.rootDir, 'contents', 'integrations', 'jira', 'zed__cloud.json'),
      '{}'
    );
    const credentialSteps = USER_CLEANUP_STEPS.filter(entry =>
      ['personalApiKeys', 'oauthConnections', 'integrationTokens'].includes(entry.name)
    );

    const outcome = await cleanUpDeletedUser({
      userId: 'zed',
      platform: { oauth: { clientsFile: CLIENTS_FILE } },
      steps: credentialSteps
    });

    expect(outcome.failed).toEqual([]);
    expect(outcome.results).toEqual({
      personalApiKeys: { removed: 1 },
      oauthConnections: { consentsRevoked: 1, refreshTokensRevoked: 1 },
      integrationTokens: { removed: 1 }
    });
    expect(await consumeRefreshToken(token)).toBeNull();
    expect(JSON.parse(readFileSync(CLIENTS_FILE, 'utf8')).clients).toEqual({});
  });
});
