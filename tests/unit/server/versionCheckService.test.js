/**
 * @jest-environment node
 */

/**
 * Regression tests for #2150: the Admin Overview rendered nothing but loading
 * skeletons in deployments without outbound internet access, because
 * `/api/admin/version/check-update` fetched api.github.com with no timeout.
 * Where packets are dropped rather than refused the connection never
 * completes, so the request hung until the OS TCP timeout.
 *
 * These tests pin the two properties that fix it: the GitHub lookup aborts on a
 * deadline, and the admin endpoint answers from cache without ever awaiting the
 * network.
 */
import { beforeEach, describe, expect, jest, test } from '@jest/globals';

jest.mock('../../../server/utils/httpConfig.js', () => ({
  httpFetch: jest.fn()
}));

jest.mock('../../../server/utils/logger.js', () => ({
  __esModule: true,
  default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

jest.mock('../../../server/middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) => next()
}));

jest.mock('../../../server/utils/versionHelper.js', () => ({
  getAppVersion: () => '1.2.3'
}));

const mockPublish = jest.fn();

// `subscribe` runs while the service module is being imported, so the handler
// store has to be created inside the factory — a module-scope const is still in
// its temporal dead zone at that point.
jest.mock('../../../server/clusterBus.js', () => {
  const handlers = {};
  return {
    __handlers: handlers,
    publish: (...args) => mockPublish(...args),
    subscribe: (type, handler) => {
      handlers[type] = handler;
      return () => delete handlers[type];
    }
  };
});

import { __handlers as clusterHandlers } from '../../../server/clusterBus.js';
import { httpFetch } from '../../../server/utils/httpConfig.js';
import {
  FAILURE_TTL_MS,
  SUCCESS_TTL_MS,
  buildUpdateInfo,
  getVersionCheckEntry,
  getVersionCheckTimeoutMs,
  isVersionCheckStale,
  refreshVersionCheck,
  resetVersionCheckCache,
  startBackgroundVersionCheck
} from '../../../server/services/versionCheckService.js';
import registerAdminVersionRoutes from '../../../server/routes/admin/version.js';

const CHECK_UPDATE_PATH = '/api/admin/version/check-update';

/** A GitHub release payload, trimmed to the fields the service reads. */
const release = (tagName = 'v9.9.9') => ({
  tag_name: tagName,
  name: `Release ${tagName}`,
  html_url: `https://github.com/intrafind/ihub-apps/releases/tag/${tagName}`,
  published_at: '2026-07-01T00:00:00Z',
  assets: []
});

const okResponse = body => ({ ok: true, status: 200, json: async () => body });

/**
 * Stands in for a connection to a host that drops packets: the promise settles
 * only when the caller's own AbortSignal fires, exactly as node-fetch behaves.
 */
const dropsPackets = () => (url, options) =>
  new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      const error = new Error('The operation was aborted.');
      error.name = 'AbortError';
      reject(error);
    });
  });

/** Collect the route handlers the module registers, skipping middleware. */
function captureRoutes() {
  const routes = {};
  registerAdminVersionRoutes({
    get: (path, ...handlers) => {
      routes[path] = handlers[handlers.length - 1];
    }
  });
  return routes;
}

function createResponse() {
  const res = {
    payload: undefined,
    statusCode: 200,
    json(body) {
      res.payload = body;
      return res;
    },
    status(code) {
      res.statusCode = code;
      return res;
    }
  };
  return res;
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

beforeEach(() => {
  resetVersionCheckCache();
  httpFetch.mockReset();
  mockPublish.mockReset();
  delete process.env.VERSION_CHECK_TIMEOUT_MS;
  delete process.env.IHUB_VERSION_CHECK_TIMEOUT_MS;
  delete process.env.NO_VERSION_CHECK;
  delete process.env.IHUB_NO_VERSION_CHECK;
  process.env.VERSION_CHECK_TIMEOUT_MS = '500';
});

describe('versionCheckService — timeout', () => {
  test('aborts the GitHub request on the configured deadline instead of hanging', async () => {
    httpFetch.mockImplementation(dropsPackets());

    const startedAt = Date.now();
    const entry = await refreshVersionCheck();

    expect(Date.now() - startedAt).toBeLessThan(3000);
    expect(entry.release).toBeNull();
    expect(entry.error).toMatch(/timed out/);
  });

  test('passes an abort signal to the fetch', async () => {
    httpFetch.mockImplementation(dropsPackets());
    await refreshVersionCheck();

    const [url, options] = httpFetch.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/intrafind/ihub-apps/releases/latest');
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  test('reports network failures as a cached outcome rather than throwing', async () => {
    httpFetch.mockRejectedValue(new Error('getaddrinfo EAI_AGAIN api.github.com'));

    const entry = await refreshVersionCheck();
    expect(entry.error).toMatch(/EAI_AGAIN/);
  });

  test('clamps the configured timeout and falls back to the default', () => {
    process.env.VERSION_CHECK_TIMEOUT_MS = '12000';
    expect(getVersionCheckTimeoutMs()).toBe(12000);

    process.env.VERSION_CHECK_TIMEOUT_MS = '10';
    expect(getVersionCheckTimeoutMs()).toBe(500);

    process.env.VERSION_CHECK_TIMEOUT_MS = '999999999';
    expect(getVersionCheckTimeoutMs()).toBe(60000);

    process.env.VERSION_CHECK_TIMEOUT_MS = 'not-a-number';
    expect(getVersionCheckTimeoutMs()).toBe(5000);

    delete process.env.VERSION_CHECK_TIMEOUT_MS;
    expect(getVersionCheckTimeoutMs()).toBe(5000);
  });
});

describe('versionCheckService — caching', () => {
  test('serves a successful lookup from cache for the success TTL', async () => {
    httpFetch.mockResolvedValue(okResponse(release('v9.9.9')));

    const first = await refreshVersionCheck();
    const second = await refreshVersionCheck();

    expect(httpFetch).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(first.expiresAt - first.checkedAt).toBe(SUCCESS_TTL_MS);
    expect(isVersionCheckStale()).toBe(false);
  });

  test('caches a failure too, so a blocked network is not retried on every request', async () => {
    httpFetch.mockImplementation(dropsPackets());

    const entry = await refreshVersionCheck();
    expect(entry.expiresAt - entry.checkedAt).toBe(FAILURE_TTL_MS);
    expect(FAILURE_TTL_MS).toBeLessThan(SUCCESS_TTL_MS);

    expect(startBackgroundVersionCheck()).toBe(false);
    await refreshVersionCheck();
    expect(httpFetch).toHaveBeenCalledTimes(1);
  });

  test('re-queries GitHub when forced', async () => {
    httpFetch.mockResolvedValue(okResponse(release('v9.9.9')));

    await refreshVersionCheck();
    await refreshVersionCheck({ force: true });

    expect(httpFetch).toHaveBeenCalledTimes(2);
  });

  test('concurrent callers share a single in-flight request', async () => {
    httpFetch.mockResolvedValue(okResponse(release('v9.9.9')));

    const results = await Promise.all([
      refreshVersionCheck(),
      refreshVersionCheck(),
      refreshVersionCheck({ force: true })
    ]);

    expect(httpFetch).toHaveBeenCalledTimes(1);
    expect(results[1]).toBe(results[0]);
    expect(results[2]).toBe(results[0]);
  });
});

describe('versionCheckService — cluster mode', () => {
  const CLUSTER_CHANNEL = 'versionCheck:result';

  test('relays a completed check to the other workers', async () => {
    httpFetch.mockResolvedValue(okResponse(release('v9.9.9')));
    const entry = await refreshVersionCheck();

    expect(mockPublish).toHaveBeenCalledWith(CLUSTER_CHANNEL, entry);
  });

  test('relays a failed check too, so every worker holds off retrying', async () => {
    httpFetch.mockImplementation(dropsPackets());
    await refreshVersionCheck();

    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockPublish.mock.calls[0][1].error).toMatch(/timed out/);
  });

  test('adopts a result from another worker instead of querying GitHub again', () => {
    const checkedAt = Date.now();
    clusterHandlers[CLUSTER_CHANNEL]({
      release: { tag_name: 'v9.9.9', name: 'v9.9.9', html_url: 'url', published_at: null },
      error: null,
      checkedAt,
      expiresAt: checkedAt + SUCCESS_TTL_MS
    });

    expect(isVersionCheckStale()).toBe(false);
    expect(startBackgroundVersionCheck()).toBe(false);
    expect(buildUpdateInfo(getVersionCheckEntry(), '1.2.3').latestVersion).toBe('9.9.9');
    expect(httpFetch).not.toHaveBeenCalled();
  });

  test('keeps its own result when another worker relays an older one', async () => {
    httpFetch.mockResolvedValue(okResponse(release('v9.9.9')));
    const own = await refreshVersionCheck();

    clusterHandlers[CLUSTER_CHANNEL]({
      release: { tag_name: 'v1.0.0' },
      error: null,
      checkedAt: own.checkedAt - 1000,
      expiresAt: own.expiresAt
    });

    expect(getVersionCheckEntry().release.tag_name).toBe('v9.9.9');
  });

  test('ignores a malformed relay', async () => {
    httpFetch.mockResolvedValue(okResponse(release('v9.9.9')));
    await refreshVersionCheck();

    clusterHandlers[CLUSTER_CHANNEL](null);
    clusterHandlers[CLUSTER_CHANNEL]({ release: { tag_name: 'v0.0.1' } });
    clusterHandlers[CLUSTER_CHANNEL]({
      release: { name: 'no tag here' },
      checkedAt: Date.now() + 1000,
      expiresAt: Date.now() + SUCCESS_TTL_MS
    });

    expect(getVersionCheckEntry().release.tag_name).toBe('v9.9.9');
  });

  test('trims the release to the fields that are cached and relayed', async () => {
    httpFetch.mockResolvedValue(
      okResponse({
        ...release('v9.9.9'),
        body: 'x'.repeat(50000),
        author: { login: 'someone' },
        assets: [
          {
            name: 'ihub-apps-v9.9.9-linux.tar.gz',
            browser_download_url: 'https://example.invalid/asset',
            size: 42,
            uploader: { login: 'someone' }
          }
        ]
      })
    );

    const entry = await refreshVersionCheck();

    expect(Object.keys(entry.release).sort()).toEqual([
      'assets',
      'html_url',
      'name',
      'published_at',
      'tag_name'
    ]);
    expect(entry.release.assets).toEqual([
      {
        name: 'ihub-apps-v9.9.9-linux.tar.gz',
        browser_download_url: 'https://example.invalid/asset',
        size: 42
      }
    ]);
  });
});

describe('versionCheckService — buildUpdateInfo', () => {
  test('flags a newer release and strips the tag prefix', async () => {
    httpFetch.mockResolvedValue(okResponse(release('v9.9.9')));
    const entry = await refreshVersionCheck();

    expect(buildUpdateInfo(entry, '1.2.3')).toMatchObject({
      updateAvailable: true,
      currentVersion: '1.2.3',
      latestVersion: '9.9.9',
      releaseName: 'Release v9.9.9',
      checking: false
    });
  });

  test('reports no update when the installation is current', async () => {
    httpFetch.mockResolvedValue(okResponse(release('v1.2.3')));
    const entry = await refreshVersionCheck();

    expect(buildUpdateInfo(entry, '1.2.3').updateAvailable).toBe(false);
  });

  test('carries the error forward and leaves updateAvailable false', () => {
    const entry = { release: null, error: 'boom', checkedAt: Date.now(), expiresAt: Date.now() };

    expect(buildUpdateInfo(entry, '1.2.3')).toMatchObject({
      updateAvailable: false,
      error: 'boom'
    });
  });

  test('handles a cold cache without a result', () => {
    expect(buildUpdateInfo(null, '1.2.3', { checking: true })).toEqual({
      updateAvailable: false,
      currentVersion: '1.2.3',
      checking: true,
      lastCheckedAt: null
    });
  });

  test('does not throw on an entry with neither a usable release nor an error', () => {
    const checkedAt = Date.now();
    const entry = { release: {}, error: null, checkedAt, expiresAt: checkedAt + SUCCESS_TTL_MS };

    const info = buildUpdateInfo(entry, '1.2.3');
    expect(info.updateAvailable).toBe(false);
    expect(info).not.toHaveProperty('latestVersion');
  });
});

describe('GET /api/admin/version/check-update', () => {
  test('answers without awaiting the GitHub request that never completes', async () => {
    httpFetch.mockImplementation(dropsPackets());
    const routes = captureRoutes();
    const res = createResponse();

    // Not awaited: the handler must have responded before it returns, or the
    // Admin Overview waits on api.github.com again.
    routes[CHECK_UPDATE_PATH]({ query: {} }, res);

    expect(res.payload).toEqual({
      updateAvailable: false,
      currentVersion: '1.2.3',
      checking: true,
      lastCheckedAt: null
    });
    expect(httpFetch).toHaveBeenCalledTimes(1);

    // The check it kicked off still records its failure in the background.
    await delay(800);
    expect(getVersionCheckEntry()?.error).toMatch(/timed out/);
  });

  test('serves the cached result once a check has completed', async () => {
    httpFetch.mockResolvedValue(okResponse(release('v9.9.9')));
    await refreshVersionCheck();

    const res = createResponse();
    captureRoutes()[CHECK_UPDATE_PATH]({ query: {} }, res);

    expect(res.payload).toMatchObject({
      updateAvailable: true,
      latestVersion: '9.9.9',
      checking: false
    });
    expect(res.payload.lastCheckedAt).not.toBeNull();
    expect(httpFetch).toHaveBeenCalledTimes(1);
  });

  test('does not contact GitHub at all when version checks are disabled', () => {
    process.env.NO_VERSION_CHECK = 'true';
    httpFetch.mockImplementation(dropsPackets());

    const res = createResponse();
    captureRoutes()[CHECK_UPDATE_PATH]({ query: {} }, res);

    expect(res.payload).toEqual({
      updateAvailable: false,
      currentVersion: '1.2.3',
      versionCheckDisabled: true,
      checking: false,
      lastCheckedAt: null
    });
    expect(httpFetch).not.toHaveBeenCalled();
  });
});
