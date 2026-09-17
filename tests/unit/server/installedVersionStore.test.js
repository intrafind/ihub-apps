/**
 * @jest-environment node
 */

/**
 * What's New marks the releases an upgrade brought in, which means the server has to remember the
 * version it was running before this one — nothing else in the process knows. This covers the
 * record kept for that (`contents/data/installed-version.json`): a first start, a restart on the
 * same build, an upgrade, a downgrade, a corrupt file, and the range the changelog derives from it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { promises as fs } from 'fs';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';

jest.mock('../../../server/utils/logger.js', () => ({
  __esModule: true,
  default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

// The store writes under the installation root, so the test gives it a throwaway one. The module
// resolves its path as it loads, which is why it is imported inside `beforeAll` — by then the
// directory exists and the mock can answer with it.
let mockRootDir;
jest.mock('../../../server/pathUtils.js', () => ({ getRootDir: () => mockRootDir }));

let store;
let storePath;

beforeAll(async () => {
  mockRootDir = mkdtempSync(path.join(os.tmpdir(), 'ihub-installed-version-'));
  store = await import('../../../server/utils/installedVersionStore.js');
  storePath = store.INSTALLED_VERSION_STORE_PATH;
});

afterAll(() => {
  rmSync(mockRootDir, { recursive: true, force: true });
});

beforeEach(async () => {
  store.resetInstalledVersionCache();
  await fs.rm(storePath, { force: true });
});

const readStoreFile = async () => JSON.parse(await fs.readFile(storePath, 'utf8'));

describe('recordInstalledVersion', () => {
  test('writes the running version with no previous one on a first start', async () => {
    const record = await store.recordInstalledVersion('5.4.3');

    expect(record.version).toBe('5.4.3');
    expect(record.previousVersion).toBeNull();
    expect(Date.parse(record.firstSeenAt)).not.toBeNaN();
    expect(await readStoreFile()).toEqual(record);
  });

  test('keeps the record and its timestamp when the same version starts again', async () => {
    const first = await store.recordInstalledVersion('5.4.3');
    store.resetInstalledVersionCache();

    const second = await store.recordInstalledVersion('5.4.3');
    expect(second).toEqual(first);
  });

  test('remembers what an upgrade replaced, and strips the tag prefix', async () => {
    await store.recordInstalledVersion('v5.4.3');
    store.resetInstalledVersionCache();

    const record = await store.recordInstalledVersion('v5.5.1');
    expect(record).toMatchObject({ version: '5.5.1', previousVersion: '5.4.3' });
    expect(await readStoreFile()).toMatchObject({ version: '5.5.1', previousVersion: '5.4.3' });
  });

  test('records a downgrade the same way round', async () => {
    await store.recordInstalledVersion('5.5.1');
    store.resetInstalledVersionCache();

    const record = await store.recordInstalledVersion('5.4.3');
    expect(record).toMatchObject({ version: '5.4.3', previousVersion: '5.5.1' });
  });

  test('starts over from a corrupt file instead of failing the boot', async () => {
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(storePath, '{ this is not json');

    const record = await store.recordInstalledVersion('5.5.1');
    expect(record).toMatchObject({ version: '5.5.1', previousVersion: null });
  });

  test('leaves the record alone when the version cannot be determined', async () => {
    const written = await store.recordInstalledVersion('5.5.1');
    store.resetInstalledVersionCache();

    expect(await store.recordInstalledVersion('unknown')).toEqual(written);
  });
});

describe('getInstalledVersionRecord', () => {
  test('is empty when nothing was ever recorded', async () => {
    expect(await store.getInstalledVersionRecord()).toEqual({
      version: null,
      previousVersion: null,
      firstSeenAt: null,
      previousFirstSeenAt: null
    });
  });

  test('reads the file when this process did not record anything itself', async () => {
    await store.recordInstalledVersion('5.5.1');
    store.resetInstalledVersionCache();

    expect(await store.getInstalledVersionRecord()).toMatchObject({ version: '5.5.1' });
  });
});

describe('isWithinUpgrade', () => {
  const jump = { version: '5.5.1', previousVersion: '5.4.3' };

  test('covers everything after the previous version up to the running one', () => {
    expect(store.isWithinUpgrade('5.4.4', jump)).toBe(true);
    expect(store.isWithinUpgrade('5.5.0', jump)).toBe(true);
    expect(store.isWithinUpgrade('5.5.1', jump)).toBe(true);
  });

  test('excludes the version that was already installed and anything not installed yet', () => {
    expect(store.isWithinUpgrade('5.4.3', jump)).toBe(false);
    expect(store.isWithinUpgrade('5.4.2', jump)).toBe(false);
    expect(store.isWithinUpgrade('5.5.2', jump)).toBe(false);
  });

  test('is empty on a fresh installation and after a downgrade', () => {
    expect(store.isWithinUpgrade('5.5.0', { version: '5.5.1', previousVersion: null })).toBe(false);
    expect(store.isWithinUpgrade('5.5.0', { version: '5.4.3', previousVersion: '5.5.1' })).toBe(
      false
    );
  });

  test('has no upper bound when the running version is unknown', () => {
    expect(store.isWithinUpgrade('9.9.9', { version: null, previousVersion: '5.4.3' })).toBe(true);
  });
});
