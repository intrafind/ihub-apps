import { jest } from '@jest/globals';

/**
 * Unit tests for shortLinkManager.js after its port onto the shared
 * debouncedJsonStore (server/utils/debouncedJsonStore.js). Disk I/O is
 * mocked so tests run against an in-memory links object only; one test
 * exercises the debounced save path end-to-end via fake timers.
 */

let fileContents = null;

jest.unstable_mockModule('fs/promises', () => ({
  default: {
    readFile: jest.fn(async () => {
      if (fileContents === null) {
        const error = new Error('ENOENT');
        error.code = 'ENOENT';
        throw error;
      }
      return fileContents;
    }),
    mkdir: jest.fn(async () => {})
  }
}));

// debouncedJsonStore saves via atomicWriteJSON (write-temp-then-rename), which
// internally imports { promises as fs } from 'fs' rather than 'fs/promises' —
// mock the utility directly so tests never touch the real filesystem.
jest.unstable_mockModule('../utils/atomicWrite.js', () => ({
  atomicWriteJSON: jest.fn(async (_file, data) => {
    fileContents = JSON.stringify(data, null, 2);
  })
}));

jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }
}));

// The module registers a real periodic setInterval on import; fake timers
// keep that handle from holding the process open and let tests drive the
// debounced save deterministically.
jest.useFakeTimers();

const {
  createLink,
  getLink,
  isCodeAvailable,
  recordUsage,
  deleteLink,
  updateLink,
  searchLinks,
  isLinkExpired
} = await import('../shortLinkManager.js');

afterAll(() => {
  jest.useRealTimers();
});

beforeEach(() => {
  fileContents = null;
});

describe('createLink', () => {
  it('generates a unique code and builds a url from appId when none is given', async () => {
    const link = await createLink({ appId: 'a1', userId: 'u1' });
    expect(link.code).toHaveLength(6);
    expect(link.url).toBe('/apps/a1');
    expect(link.usage).toBe(0);

    const fetched = await getLink(link.code);
    expect(fetched).toEqual(link);
  });

  it('rejects an explicit code that already exists', async () => {
    const link = await createLink({ appId: 'a1', userId: 'u1' });
    await expect(createLink({ code: link.code, appId: 'a2', userId: 'u2' })).rejects.toThrow(
      'Code already exists'
    );
  });

  it('includes params in the url only when includeParams is true', async () => {
    const withParams = await createLink({
      appId: 'a1',
      userId: 'u1',
      includeParams: true,
      params: { model: 'gpt-4', empty: '' }
    });
    expect(withParams.url).toBe('/apps/a1?model=gpt-4');

    const withoutParams = await createLink({
      appId: 'a1',
      userId: 'u1',
      includeParams: false,
      params: { model: 'gpt-4' }
    });
    expect(withoutParams.url).toBe('/apps/a1');
  });
});

describe('isCodeAvailable / recordUsage / deleteLink / updateLink / searchLinks', () => {
  it('reflects code availability before and after creation', async () => {
    expect(await isCodeAvailable('abc123')).toBe(true);
    const link = await createLink({ code: 'abc123', appId: 'a1', userId: 'u1' });
    expect(await isCodeAvailable(link.code)).toBe(false);
  });

  it('increments usage and stamps lastUsed', async () => {
    const link = await createLink({ appId: 'a1', userId: 'u1' });
    const updated = await recordUsage(link.code);
    expect(updated.usage).toBe(1);
    expect(updated.lastUsed).toBeTruthy();

    await recordUsage(link.code);
    const fetched = await getLink(link.code);
    expect(fetched.usage).toBe(2);
  });

  it('returns undefined from recordUsage for an unknown code without throwing', async () => {
    await expect(recordUsage('doesNotExist')).resolves.toBeUndefined();
  });

  it('updates fields but keeps the original code', async () => {
    const link = await createLink({ appId: 'a1', userId: 'u1' });
    const updated = await updateLink(link.code, { code: 'ignored', appId: 'a2' });
    expect(updated.code).toBe(link.code);
    expect(updated.appId).toBe('a2');
  });

  it('returns null from updateLink for an unknown code', async () => {
    expect(await updateLink('doesNotExist', { appId: 'a2' })).toBeNull();
  });

  it('deletes a link and reports whether it existed', async () => {
    const link = await createLink({ appId: 'a1', userId: 'u1' });
    expect(await deleteLink(link.code)).toBe(true);
    expect(await getLink(link.code)).toBeUndefined();
    expect(await deleteLink(link.code)).toBe(false);
  });

  it('filters by appId and userId', async () => {
    // Use identifiers unique to this test — the store is a module-level
    // singleton shared across tests in this file, so reusing 'a1'/'u1' here
    // would double-count links created by earlier tests.
    const before = (await searchLinks()).length;
    await createLink({ appId: 'filter-a1', userId: 'filter-u1' });
    await createLink({ appId: 'filter-a1', userId: 'filter-u2' });
    await createLink({ appId: 'filter-a2', userId: 'filter-u1' });

    expect(await searchLinks({ appId: 'filter-a1' })).toHaveLength(2);
    expect(await searchLinks({ userId: 'filter-u1' })).toHaveLength(2);
    expect(await searchLinks({ appId: 'filter-a1', userId: 'filter-u1' })).toHaveLength(1);
    expect((await searchLinks()).length).toBe(before + 3);
  });
});

describe('isLinkExpired', () => {
  it('is false when there is no expiresAt', () => {
    expect(isLinkExpired({})).toBe(false);
    expect(isLinkExpired(null)).toBe(false);
  });

  it('compares expiresAt against the current time', () => {
    expect(isLinkExpired({ expiresAt: new Date(Date.now() - 1000).toISOString() })).toBe(true);
    expect(isLinkExpired({ expiresAt: new Date(Date.now() + 100000).toISOString() })).toBe(false);
  });
});

describe('cross-worker visibility (reload on miss)', () => {
  // Settle any dirty state left by earlier tests before each case: findByCode
  // flushes local writes before it reloads, and a stale in-flight flush would
  // silently overwrite the "remote worker" fileContents this suite injects
  // below, rather than the reload actually being exercised.
  beforeEach(async () => {
    await jest.advanceTimersByTimeAsync(10000);
  });

  function simulateRemoteWorkerWrote(link) {
    const known = fileContents ? JSON.parse(fileContents).links : [];
    fileContents = JSON.stringify(
      { links: [...known, link], lastUpdated: new Date().toISOString() },
      null,
      2
    );
  }

  it('getLink finds a code that only exists on disk, written by another worker', async () => {
    const remoteLink = {
      code: 'remote-only-code',
      appId: 'remote-app',
      userId: 'remote-user',
      path: null,
      params: null,
      url: '/apps/remote-app',
      includeParams: false,
      createdAt: new Date().toISOString(),
      usage: 0,
      expiresAt: null
    };
    expect(await getLink(remoteLink.code)).toBeUndefined();
    simulateRemoteWorkerWrote(remoteLink);

    expect(await getLink(remoteLink.code)).toEqual(remoteLink);
  });

  it('recordUsage finds and updates a code created by another worker', async () => {
    const remoteLink = {
      code: 'remote-only-code-2',
      appId: 'remote-app',
      userId: 'remote-user',
      path: null,
      params: null,
      url: '/apps/remote-app',
      includeParams: false,
      createdAt: new Date().toISOString(),
      usage: 0,
      expiresAt: null
    };
    simulateRemoteWorkerWrote(remoteLink);

    const updated = await recordUsage(remoteLink.code);
    expect(updated).toMatchObject({ code: remoteLink.code, usage: 1 });
    // Now resolved locally too, without a further reload.
    expect(await getLink(remoteLink.code)).toMatchObject({ usage: 1 });
  });

  it('a code that truly does not exist anywhere still reports missing', async () => {
    expect(await getLink('truly-does-not-exist-anywhere')).toBeUndefined();
    expect(await isCodeAvailable('truly-does-not-exist-anywhere')).toBe(true);
  });
});

describe('debounced save', () => {
  it('persists the link to disk once the debounce interval elapses', async () => {
    const link = await createLink({ appId: 'a1', userId: 'u1' });
    expect(fileContents).toBeNull();

    await jest.advanceTimersByTimeAsync(10000);

    expect(fileContents).not.toBeNull();
    const saved = JSON.parse(fileContents);
    expect(saved.links.some(l => l.code === link.code)).toBe(true);
  });
});
