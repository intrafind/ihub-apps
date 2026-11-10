// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A project's web page item (the `url` source handler) reads through the page
 * reader, the one way iHub reads a web page: the same fetch with its SSRF guard,
 * the same extraction and the same page cache as `read_url`. There is no
 * second fetch or HTML conversion behind it.
 */

import { jest } from '@jest/globals';

const throttledFetchMock = jest.fn();

jest.unstable_mockModule('../requestThrottler.js', () => ({
  throttledFetch: throttledFetchMock,
  registerThrottleHints: () => null
}));

jest.unstable_mockModule('../services/loop/RunStream.js', () => ({
  emitToolProgress: () => null
}));

jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    getPlatform: () => ({ ssl: { ignoreInvalidCertificates: false, domainWhitelist: [] } })
  }
}));

const html = `<html lang="en"><head><title>Lease guide</title>
<meta name="description" content="How the lease works"></head><body><main><article>
<h1>Lease guide</h1>
<p>${'The rent is due on the first day of each month. '.repeat(12)}</p>
<h2>Deposit</h2><p>${'The deposit is two months of rent. '.repeat(12)}</p>
</article></main></body></html>`;

function htmlResponse(body) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: name => (name.toLowerCase() === 'content-type' ? 'text/html' : null) },
    text: async () => body
  };
}

let counter = 0;
/** A public address that no earlier test has put into the page cache. */
const freshUrl = () => `http://93.184.216.34/lease-${++counter}`;

describe('the url source handler', () => {
  let URLHandler;
  let extractForTool;

  beforeEach(async () => {
    jest.resetAllMocks();
    ({ default: URLHandler } = await import('../sources/URLHandler.js'));
    ({ extractForTool } = await import('../tools/webContentExtractor.js'));
  });

  test('reads the page as the page reader does, and shares its cache with read_url', async () => {
    throttledFetchMock.mockResolvedValue(htmlResponse(html));
    const url = freshUrl();

    const loaded = await new URLHandler().loadContent({ url });
    expect(loaded.content).toContain('## Deposit');
    expect(loaded.content).toContain('The deposit is two months of rent.');
    expect(loaded.metadata).toMatchObject({
      type: 'url',
      url,
      title: 'Lease guide',
      description: 'How the lease works',
      contentType: 'html',
      truncated: false
    });

    // The model's `read_url` of the same page is served from the cache the
    // item filled: one fetch, one extraction.
    const read = await extractForTool({ url });
    expect(read.content).toBe(loaded.content);
    expect(throttledFetchMock).toHaveBeenCalledTimes(1);
  });

  test('a private address is refused by the reader, with no other fetch behind it', async () => {
    await expect(new URLHandler().loadContent({ url: 'http://127.0.0.1/admin' })).rejects.toThrow(
      /private\/internal/
    );
    expect(throttledFetchMock).not.toHaveBeenCalled();
  });

  test('passes the item length limit and the chat to the reader', async () => {
    const handler = new URLHandler();
    const seen = [];
    handler.readPage = async params => {
      seen.push(params);
      return { content: 'text', truncated: false };
    };

    await handler.loadContent({ url: 'https://example.com/a', chatId: 'chat-1' });
    await handler.loadContent({
      url: 'https://example.com/b',
      options: { maxContentLength: 1234 }
    });

    expect(seen).toEqual([
      { url: 'https://example.com/a', maxLength: 50000, chatId: 'chat-1' },
      { url: 'https://example.com/b', maxLength: 1234, chatId: undefined }
    ]);
  });

  test('says when the page is longer than what came back', async () => {
    const handler = new URLHandler();
    handler.readPage = async () => ({ content: 'start', truncated: true });
    const loaded = await handler.loadContent({ url: 'https://example.com/long' });
    expect(loaded.metadata.truncated).toBe(true);
  });
});
