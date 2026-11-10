// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * "Refresh now" of a project web page (#3536) forgets its cached reads on
 * every cluster worker: the worker that handled the request forgets at once
 * and publishes the URL; the others forget it when the message arrives.
 */
import { jest } from '@jest/globals';

const published = [];
const subscribers = new Map();

const actualBus = await import('../clusterBus.js');

jest.unstable_mockModule('../clusterBus.js', () => ({
  ...actualBus,
  publish: (type, payload) => {
    published.push({ type, payload });
    return true;
  },
  subscribe: (type, handler) => {
    subscribers.set(type, handler);
    return () => subscribers.delete(type);
  }
}));

const { FORGET_URL_CHANNEL, forgetCachedUrl } = await import('../sources/URLHandler.js');
const { createSourceManager } = await import('../sources/index.js');
const { getCachedPage, makePageCacheKey, setCachedPage } = await import('../services/pageCache.js');

const URL_A = 'https://docs.example.com/guide';

function cacheBoth(url) {
  const handler = createSourceManager().getHandler('url');
  handler.cache.set(handler.getCacheKey({ url }), {
    data: { content: 'cached' },
    timestamp: Date.now(),
    ttl: 3600 * 1000
  });
  setCachedPage(makePageCacheKey(new URL(url).toString(), 'en'), { text: 'x' }, 1, 600000);
  return handler;
}

describe('forgetting a cached page across workers', () => {
  beforeEach(() => {
    published.length = 0;
  });

  test('forgets locally and publishes the URL to the other workers', async () => {
    const handler = cacheBoth(URL_A);
    await forgetCachedUrl(URL_A);
    expect(handler.cache.has(handler.getCacheKey({ url: URL_A }))).toBe(false);
    expect(getCachedPage(makePageCacheKey(new URL(URL_A).toString(), 'en'))).toBeUndefined();
    expect(published).toEqual([{ type: FORGET_URL_CHANNEL, payload: { url: URL_A } }]);
  });

  test('a message from another worker forgets the page here, without publishing again', async () => {
    const handler = cacheBoth(URL_A);
    const deliver = subscribers.get(FORGET_URL_CHANNEL);
    expect(typeof deliver).toBe('function');
    deliver({ url: URL_A });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(handler.cache.has(handler.getCacheKey({ url: URL_A }))).toBe(false);
    expect(published).toEqual([]);
  });

  test('ignores a message without a URL', async () => {
    const deliver = subscribers.get(FORGET_URL_CHANNEL);
    expect(() => deliver({})).not.toThrow();
    expect(() => deliver(null)).not.toThrow();
  });
});
