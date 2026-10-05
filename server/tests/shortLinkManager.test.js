import { jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Unit tests for shortLinkManager.js on the shared JSON file
 * (server/utils/sharedJsonFile.js): every change is a locked
 * read-modify-write of the file on disk, so they run against a real file in a
 * temporary contents directory. Another cluster worker is simulated by
 * writing that file directly.
 */

const contentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shortlinks-'));
const dataFile = path.join(contentsDir, 'data', 'shortlinks.json');

jest.unstable_mockModule('../utils/contentsPath.js', () => ({
  getContentsPath: (...segments) => path.join(contentsDir, ...segments)
}));

jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }
}));

const {
  createLink,
  getLink,
  isCodeAvailable,
  recordUsage,
  deleteLink,
  updateLink,
  searchLinks,
  isLinkExpired,
  canManageLink,
  ShortLinkTargetError
} = await import('../shortLinkManager.js');

afterAll(() => {
  fs.rmSync(contentsDir, { recursive: true, force: true });
});

const readFile = () => JSON.parse(fs.readFileSync(dataFile, 'utf8'));

describe('createLink', () => {
  it('generates a unique code and builds a url from appId when none is given', async () => {
    const link = await createLink({ appId: 'a1', ownerId: 'u1' });
    expect(link.code).toHaveLength(6);
    expect(link.url).toBe('/apps/a1');
    expect(link.usage).toBe(0);

    const fetched = await getLink(link.code);
    expect(fetched).toEqual(link);
  });

  it('rejects an explicit code that already exists', async () => {
    const link = await createLink({ appId: 'a1', ownerId: 'u1' });
    await expect(createLink({ code: link.code, appId: 'a2', ownerId: 'u2' })).rejects.toThrow(
      'Code already exists'
    );
  });

  it('includes params in the url only when includeParams is true', async () => {
    const withParams = await createLink({
      appId: 'a1',
      ownerId: 'u1',
      includeParams: true,
      params: { model: 'gpt-4', empty: '' }
    });
    expect(withParams.url).toBe('/apps/a1?model=gpt-4');

    const withoutParams = await createLink({
      appId: 'a1',
      ownerId: 'u1',
      includeParams: false,
      params: { model: 'gpt-4' }
    });
    expect(withoutParams.url).toBe('/apps/a1');
  });
});

describe('isCodeAvailable / recordUsage / deleteLink / updateLink / searchLinks', () => {
  it('reflects code availability before and after creation', async () => {
    expect(await isCodeAvailable('abc123')).toBe(true);
    const link = await createLink({ code: 'abc123', appId: 'a1', ownerId: 'u1' });
    expect(await isCodeAvailable(link.code)).toBe(false);
  });

  it('increments usage and stamps lastUsed', async () => {
    const link = await createLink({ appId: 'a1', ownerId: 'u1' });
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
    const link = await createLink({ appId: 'a1', ownerId: 'u1' });
    const updated = await updateLink(link.code, { code: 'ignored', appId: 'a2' });
    expect(updated.code).toBe(link.code);
    expect(updated.appId).toBe('a2');
  });

  it('returns null from updateLink for an unknown code', async () => {
    expect(await updateLink('doesNotExist', { appId: 'a2' })).toBeNull();
  });

  it('deletes a link and reports whether it existed', async () => {
    const link = await createLink({ appId: 'a1', ownerId: 'u1' });
    expect(await deleteLink(link.code)).toBe(true);
    expect(await getLink(link.code)).toBeUndefined();
    expect(await deleteLink(link.code)).toBe(false);
  });

  it('filters by appId and ownerId', async () => {
    // Use identifiers unique to this test — the store is a module-level
    // singleton shared across tests in this file, so reusing 'a1'/'u1' here
    // would double-count links created by earlier tests.
    const before = (await searchLinks()).length;
    await createLink({ appId: 'filter-a1', ownerId: 'filter-u1' });
    await createLink({ appId: 'filter-a1', ownerId: 'filter-u2' });
    await createLink({ appId: 'filter-a2', ownerId: 'filter-u1' });

    expect(await searchLinks({ appId: 'filter-a1' })).toHaveLength(2);
    expect(await searchLinks({ ownerId: 'filter-u1' })).toHaveLength(2);
    expect(await searchLinks({ appId: 'filter-a1', ownerId: 'filter-u1' })).toHaveLength(1);
    expect((await searchLinks()).length).toBe(before + 3);
  });
});

describe('owner and targets', () => {
  it('records the owner it is given', async () => {
    const link = await createLink({ appId: 'a1', ownerId: 'owner-1' });
    expect(link.ownerId).toBe('owner-1');
    expect(link).not.toHaveProperty('userId');
  });

  it('refuses a target that is not a path on this server', async () => {
    for (const url of ['https://elsewhere.example/', '//elsewhere.example/x', 'mailto:a@b.c']) {
      await expect(createLink({ url, ownerId: 'u1' })).rejects.toBeInstanceOf(ShortLinkTargetError);
    }
    await expect(createLink({ path: '//elsewhere.example', ownerId: 'u1' })).rejects.toBeInstanceOf(
      ShortLinkTargetError
    );
  });

  it('accepts an absolute URL on an allowed host', async () => {
    const link = await createLink(
      { url: 'https://Docs.Example.com/page', ownerId: 'u1' },
      { allowedHosts: ['docs.example.com'] }
    );
    expect(link.url).toBe('https://Docs.Example.com/page');
  });

  it('changes only the editable fields', async () => {
    const link = await createLink({ appId: 'a1', ownerId: 'owner-1' });
    const updated = await updateLink(link.code, {
      appId: 'a2',
      ownerId: 'someone-else',
      userId: 'someone-else',
      usage: 99,
      createdAt: 'then'
    });
    expect(updated.appId).toBe('a2');
    expect(updated.ownerId).toBe('owner-1');
    expect(updated).not.toHaveProperty('userId');
    expect(updated.usage).toBe(0);
    expect(updated.createdAt).toBe(link.createdAt);
  });

  it('refuses an update whose target is not allowed, leaving the link unchanged', async () => {
    const link = await createLink({ appId: 'a1', ownerId: 'u1' });
    await expect(
      updateLink(link.code, { url: 'https://elsewhere.example/' })
    ).rejects.toBeInstanceOf(ShortLinkTargetError);
    expect((await getLink(link.code)).url).toBe('/apps/a1');
  });

  it('builds the target again when an update clears the url', async () => {
    const link = await createLink({ url: '/apps/a1', ownerId: 'u1' });
    const updated = await updateLink(link.code, { url: '', appId: 'a3' });
    expect(updated.url).toBe('/apps/a3');
  });

  it('lets the owner and admins manage a link, and only admins one without an owner', () => {
    const owned = { code: 'c1', ownerId: 'u1' };
    expect(canManageLink(owned, { id: 'u1' }, false)).toBe(true);
    expect(canManageLink(owned, { id: 'u2' }, false)).toBe(false);
    expect(canManageLink(owned, { id: 'u2' }, true)).toBe(true);
    const legacy = { code: 'c2', userId: 'u1' };
    expect(canManageLink(legacy, { id: 'u1' }, false)).toBe(false);
    expect(canManageLink(legacy, { id: 'admin' }, true)).toBe(true);
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

describe('cross-worker visibility', () => {
  /** Another worker changing the file, as it would: a whole new file. */
  function simulateRemoteWorkerWrote(mutate) {
    const data = fs.existsSync(dataFile) ? readFile() : { links: [] };
    mutate(data);
    const tmp = `${dataFile}.remote`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, dataFile);
  }

  function remoteLink(code) {
    return {
      code,
      appId: 'remote-app',
      ownerId: 'remote-user',
      path: null,
      params: null,
      url: '/apps/remote-app',
      includeParams: false,
      createdAt: new Date().toISOString(),
      usage: 0,
      expiresAt: null
    };
  }

  it('getLink finds a code another worker created', async () => {
    const link = remoteLink('remote-only-code');
    expect(await getLink(link.code)).toBeUndefined();
    simulateRemoteWorkerWrote(data => data.links.push(link));

    expect(await getLink(link.code)).toEqual(link);
  });

  it('recordUsage finds and updates a code created by another worker', async () => {
    const link = remoteLink('remote-only-code-2');
    simulateRemoteWorkerWrote(data => data.links.push(link));

    const updated = await recordUsage(link.code);
    expect(updated).toMatchObject({ code: link.code, usage: 1 });
    expect(await getLink(link.code)).toMatchObject({ usage: 1 });
  });

  it('a change here keeps a link another worker created meanwhile', async () => {
    const mine = await createLink({ appId: 'mine', ownerId: 'u1' });
    const theirs = remoteLink('created-elsewhere');
    simulateRemoteWorkerWrote(data => data.links.push(theirs));

    await updateLink(mine.code, { appId: 'mine-2' });

    const codes = readFile().links.map(l => l.code);
    expect(codes).toEqual(expect.arrayContaining([mine.code, theirs.code]));
  });

  it('a link deleted by another worker is gone here too, and stays gone', async () => {
    const link = await createLink({ appId: 'doomed', ownerId: 'u1' });
    simulateRemoteWorkerWrote(data => {
      data.links = data.links.filter(l => l.code !== link.code);
    });

    expect(await getLink(link.code)).toBeUndefined();
    await createLink({ appId: 'unrelated', ownerId: 'u1' });
    expect(readFile().links.some(l => l.code === link.code)).toBe(false);
  });

  it('a code that truly does not exist anywhere still reports missing', async () => {
    expect(await getLink('truly-does-not-exist-anywhere')).toBeUndefined();
    expect(await isCodeAvailable('truly-does-not-exist-anywhere')).toBe(true);
  });
});

describe('saving', () => {
  it('writes a new link to disk right away', async () => {
    const link = await createLink({ appId: 'a1', ownerId: 'u1' });
    expect(readFile().links.some(l => l.code === link.code)).toBe(true);
  });
});
