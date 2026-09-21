/**
 * @jest-environment node
 */

/**
 * The Office.js pull-through cache is what lets a network that blocks
 * Microsoft still run the add-in: the server fetches the library, clients never
 * do. Two properties matter enough to pin here.
 *
 * 1. The requested path reaches both an outbound URL and a filesystem write, so
 *    it is allowlisted rather than sanitized.
 * 2. A cached copy is served when upstream is unreachable, however old it is.
 *    That is what makes a pre-warmed cache work with no egress at all — an
 *    air-gapped install would otherwise serve nothing.
 *
 * Module mocking follows the pattern used elsewhere in tests/unit/server:
 * `jest.mock` factories, with a `mock`-prefixed binding so the hoisted
 * factories may reference it.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';

const UPSTREAM = 'https://officeapis.public.onecdn.static.microsoft/1/';

const mockState = { tempRoot: '', fetchCalls: [], fetchImpl: null };

jest.mock('../../../server/pathUtils.js', () => ({
  getRootDir: () => mockState.tempRoot
}));

jest.mock('../../../server/config.js', () => ({
  __esModule: true,
  default: { CONTENTS_DIR: 'contents' }
}));

jest.mock('../../../server/utils/logger.js', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}));

jest.mock('../../../server/utils/httpConfig.js', () => ({
  httpFetch: async url => {
    mockState.fetchCalls.push(url);
    return mockState.fetchImpl(url);
  }
}));

import {
  _resetInFlight,
  contentTypeFor,
  getOfficeJsAsset,
  isSafeOfficeJsAssetPath
} from '../../../server/services/OfficeJsProxyService.js';

/** A minimal stand-in for the subset of Response the service touches. */
function okResponse(body) {
  const buffer = Buffer.from(body);
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () =>
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length)
  };
}

function cachedFilePath(...segments) {
  return path.join(mockState.tempRoot, 'contents', 'data', 'office-js-cache', ...segments);
}

beforeEach(async () => {
  mockState.tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'officejs-proxy-'));
  mockState.fetchCalls = [];
  mockState.fetchImpl = async () => okResponse('// office.js');
  _resetInFlight();
});

afterEach(async () => {
  await fs.rm(mockState.tempRoot, { recursive: true, force: true });
});

describe('isSafeOfficeJsAssetPath', () => {
  test.each([
    ['the bootstrapper itself', 'office.js'],
    ['the debug build', 'office.debug.js'],
    ['the host/version mapping table', 'o15apptofilemappingtable.js'],
    ['a host payload', 'outlook-win32-16.01.js'],
    ['locale strings in their subdirectory', 'en-us/outlook_strings.js']
  ])('accepts %s', (_label, assetPath) => {
    expect(isSafeOfficeJsAssetPath(assetPath)).toBe(true);
  });

  test.each([
    ['parent traversal', '../../../etc/passwd'],
    ['traversal in a later segment', 'en-us/../../secret.js'],
    ['a backslash segment', 'en-us\\..\\secret.js'],
    ['an absolute path', '/etc/passwd'],
    ['a dotfile', '.env'],
    ['a non-JS extension', 'payload.sh'],
    ['no extension at all', 'office'],
    ['a NUL byte', 'office.js\u0000.sh'],
    ['too many segments', 'a/b/c/d.js'],
    ['an empty path', ''],
    ['a non-string', null]
  ])('rejects %s', (_label, assetPath) => {
    expect(isSafeOfficeJsAssetPath(assetPath)).toBe(false);
  });
});

describe('contentTypeFor', () => {
  test('serves .js as JavaScript', () => {
    expect(contentTypeFor('office.js')).toBe('application/javascript; charset=utf-8');
  });
});

describe('getOfficeJsAsset', () => {
  test('fetches from upstream on a cold cache and writes the file', async () => {
    const result = await getOfficeJsAsset('office.js', UPSTREAM);

    expect(result.source).toBe('upstream');
    expect(result.body.toString()).toBe('// office.js');
    expect(mockState.fetchCalls).toEqual([`${UPSTREAM}office.js`]);
    expect(await fs.readFile(cachedFilePath('office.js'), 'utf-8')).toBe('// office.js');
  });

  test('serves the second request from cache without touching upstream', async () => {
    await getOfficeJsAsset('office.js', UPSTREAM);
    const second = await getOfficeJsAsset('office.js', UPSTREAM);

    expect(second.source).toBe('cache');
    expect(mockState.fetchCalls).toHaveLength(1);
  });

  test('builds the upstream URL for a nested locale path', async () => {
    await getOfficeJsAsset('en-us/outlook_strings.js', UPSTREAM);
    expect(mockState.fetchCalls).toEqual([`${UPSTREAM}en-us/outlook_strings.js`]);
  });

  test('serves a stale cached copy when upstream is unreachable', async () => {
    await getOfficeJsAsset('office.js', UPSTREAM);

    // Age the cached file well past the TTL, then cut upstream off — the
    // air-gapped case, where the cache was pre-warmed at install time.
    const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await fs.utimes(cachedFilePath('office.js'), longAgo, longAgo);
    mockState.fetchImpl = async () => {
      throw new Error('ENOTFOUND');
    };
    _resetInFlight();

    const result = await getOfficeJsAsset('office.js', UPSTREAM);
    expect(result.source).toBe('stale');
    expect(result.body.toString()).toBe('// office.js');
  });

  test('propagates the failure when upstream is down and nothing is cached', async () => {
    mockState.fetchImpl = async () => {
      throw new Error('ENOTFOUND');
    };
    await expect(getOfficeJsAsset('office.js', UPSTREAM)).rejects.toThrow('ENOTFOUND');
  });

  test('surfaces a non-200 from upstream rather than caching it', async () => {
    mockState.fetchImpl = async () => ({
      ok: false,
      status: 404,
      arrayBuffer: async () => new ArrayBuffer(0)
    });

    await expect(getOfficeJsAsset('office.js', UPSTREAM)).rejects.toThrow('404');
    await expect(fs.access(cachedFilePath('office.js'))).rejects.toThrow();
  });

  test('collapses concurrent requests for the same file into one fetch', async () => {
    const results = await Promise.all([
      getOfficeJsAsset('office.js', UPSTREAM),
      getOfficeJsAsset('office.js', UPSTREAM),
      getOfficeJsAsset('office.js', UPSTREAM)
    ]);

    expect(mockState.fetchCalls).toHaveLength(1);
    for (const result of results) expect(result.body.toString()).toBe('// office.js');
  });

  test('rejects a traversal path before any fetch happens', async () => {
    await expect(getOfficeJsAsset('../../../etc/passwd', UPSTREAM)).rejects.toThrow(
      /Rejected Office\.js asset path/
    );
    expect(mockState.fetchCalls).toHaveLength(0);
  });

  test('refuses to run without an upstream base URL', async () => {
    await expect(getOfficeJsAsset('office.js', null)).rejects.toThrow(/No upstream/);
  });
});
