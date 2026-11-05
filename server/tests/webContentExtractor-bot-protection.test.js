// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `read_url` on a page that refuses the request: a bot-protection block (WAF)
 * is reported as `BOT_PROTECTION` — non-retryable, with the vendor and host,
 * and guidance for the model — instead of "Authentication required", while a
 * real login request and a plain refusal keep their own codes.
 */

import { jest } from '@jest/globals';

const throttledFetchMock = jest.fn();

jest.unstable_mockModule('../requestThrottler.js', () => ({
  throttledFetch: throttledFetchMock
}));

jest.unstable_mockModule('../services/loop/RunStream.js', () => ({
  emitToolProgress: () => null
}));

jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    getPlatform: () => ({ ssl: { ignoreInvalidCertificates: false, domainWhitelist: [] } })
  }
}));

function blockedResponse(status, headers = {}, body = '') {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: false,
    status,
    statusText: 'Forbidden',
    headers: { get: name => lower[name.toLowerCase()] ?? null },
    text: async () => body
  };
}

const AKAMAI_BODY =
  '<html><head><link rel="stylesheet" href="/WAFfailoverassets/style.css"></head>' +
  '<body>Leider können wir im Moment keinen Zugriff auf unsere Seite… Reference Error: 18.2d351ab8.1557333295.a4e16ab</body></html>';
const CLOUDFLARE_BODY =
  '<html><head><title>Just a moment...</title></head><body>' +
  '<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script></body></html>';

describe('read_url refused pages', () => {
  let read_url;
  let extractForTool;
  let clearBlockedHosts;
  let searchWithExtraction;
  let webSearchService;

  beforeEach(async () => {
    jest.resetAllMocks();
    ({
      default: read_url,
      extractForTool,
      clearBlockedHosts
    } = await import('../tools/webContentExtractor.js'));
    clearBlockedHosts();
  });

  test('Akamai block page: BOT_PROTECTION naming the vendor, not AUTH_REQUIRED', async () => {
    throttledFetchMock.mockResolvedValue(
      blockedResponse(403, { server: 'AkamaiNetStorage' }, AKAMAI_BODY)
    );
    await expect(read_url({ url: 'https://8.8.8.8/' })).rejects.toMatchObject({
      code: 'BOT_PROTECTION',
      vendor: 'Akamai',
      status: 403,
      host: '8.8.8.8',
      reference: '18.2d351ab8.1557333295.a4e16ab',
      message: expect.stringContaining('Blocked by bot protection (Akamai)')
    });
  });

  test('Cloudflare challenge page: BOT_PROTECTION', async () => {
    throttledFetchMock.mockResolvedValue(
      blockedResponse(403, { server: 'cloudflare', 'cf-ray': '8a1b2c3d4e5f-FRA' }, CLOUDFLARE_BODY)
    );
    await expect(read_url({ url: 'https://8.8.8.8/' })).rejects.toMatchObject({
      code: 'BOT_PROTECTION',
      vendor: 'Cloudflare'
    });
  });

  test('a 503 Cloudflare challenge is a block, a plain 503 is not', async () => {
    throttledFetchMock.mockResolvedValueOnce(
      blockedResponse(503, { server: 'cloudflare', 'cf-ray': 'x', 'cf-mitigated': 'challenge' })
    );
    await expect(read_url({ url: 'https://8.8.8.8/a' })).rejects.toMatchObject({
      code: 'BOT_PROTECTION'
    });
    throttledFetchMock.mockResolvedValueOnce(blockedResponse(503, {}, 'Service unavailable'));
    await expect(read_url({ url: 'https://8.8.8.8/b' })).rejects.toMatchObject({
      code: 'EXTRACTION_FAILED'
    });
  });

  test('a real 401 stays AUTH_REQUIRED', async () => {
    throttledFetchMock.mockResolvedValue(
      blockedResponse(401, { 'www-authenticate': 'Basic realm="intranet"' }, 'Unauthorized')
    );
    await expect(read_url({ url: 'https://8.8.8.8/' })).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
      message: expect.stringContaining('Authentication required')
    });
  });

  test('a 403 carrying WWW-Authenticate stays AUTH_REQUIRED, even behind a CDN', async () => {
    throttledFetchMock.mockResolvedValue(
      blockedResponse(
        403,
        { 'www-authenticate': 'Bearer', server: 'AkamaiGHost' },
        'Reference #18.1.2.3'
      )
    );
    await expect(read_url({ url: 'https://8.8.8.8/' })).rejects.toMatchObject({
      code: 'AUTH_REQUIRED'
    });
  });

  test('a plain 403 is ACCESS_DENIED with the status, not an authentication error', async () => {
    throttledFetchMock.mockResolvedValue(blockedResponse(403, { server: 'nginx' }, 'Forbidden'));
    const error = await read_url({ url: 'https://8.8.8.8/' }).catch(e => e);
    expect(error.code).toBe('ACCESS_DENIED');
    expect(error.message).toContain('HTTP 403');
    expect(error.message).not.toMatch(/authentication/i);
  });

  test('a 401 without WWW-Authenticate or a vendor is still AUTH_REQUIRED', async () => {
    throttledFetchMock.mockResolvedValue(blockedResponse(401, { server: 'nginx' }, 'no'));
    await expect(read_url({ url: 'https://8.8.8.8/' })).rejects.toMatchObject({
      code: 'AUTH_REQUIRED'
    });
  });

  test('the model-facing result is structured, non-retryable and carries guidance', async () => {
    throttledFetchMock.mockResolvedValue(
      blockedResponse(403, { server: 'AkamaiNetStorage' }, AKAMAI_BODY)
    );
    const result = await extractForTool({ url: 'https://8.8.8.8/shoes' });
    expect(result.error).toMatchObject({
      code: 'BOT_PROTECTION',
      retryable: false,
      vendor: 'Akamai',
      host: '8.8.8.8',
      status: 403
    });
    expect(result.message).toContain('Blocked by bot protection (Akamai)');
    expect(result.instruction).toMatch(/Do not retry or try other URLs on this host/);
    expect(result.instruction).toMatch(/upload it/);
    // Read by the run loop's failure classification.
    const { classifyToolResult } = await import('../services/loop/toolClassify.js');
    expect(classifyToolResult({ content: JSON.stringify(result) })).toMatchObject({
      failed: true
    });
  });

  test('other failures still throw for the model entry point', async () => {
    throttledFetchMock.mockResolvedValue(blockedResponse(403, { server: 'nginx' }, 'Forbidden'));
    await expect(extractForTool({ url: 'https://8.8.8.8/' })).rejects.toMatchObject({
      code: 'ACCESS_DENIED'
    });
  });

  test('a host that blocked a chat is not requested again in that chat', async () => {
    throttledFetchMock.mockResolvedValue(
      blockedResponse(403, { server: 'AkamaiNetStorage' }, AKAMAI_BODY)
    );
    const first = await extractForTool({ url: 'https://8.8.8.8/a', chatId: 'chat-1' });
    expect(first.error.code).toBe('BOT_PROTECTION');
    expect(throttledFetchMock).toHaveBeenCalledTimes(1);

    const second = await extractForTool({ url: 'https://8.8.8.8/other', chatId: 'chat-1' });
    expect(second.error).toMatchObject({ code: 'BOT_PROTECTION', retryable: false });
    expect(second.url).toBe('https://8.8.8.8/other');
    expect(throttledFetchMock).toHaveBeenCalledTimes(1);

    // Another chat is not affected.
    await extractForTool({ url: 'https://8.8.8.8/a', chatId: 'chat-2' });
    expect(throttledFetchMock).toHaveBeenCalledTimes(2);
  });

  test('a block reached through a redirect is remembered for the requested host too', async () => {
    throttledFetchMock.mockImplementation(async (_id, url) =>
      url.startsWith('https://8.8.8.8')
        ? {
            ok: false,
            status: 301,
            statusText: 'Moved',
            headers: { get: n => (n.toLowerCase() === 'location' ? 'https://1.1.1.1/' : null) }
          }
        : blockedResponse(403, { server: 'AkamaiNetStorage' }, AKAMAI_BODY)
    );
    const first = await extractForTool({ url: 'https://8.8.8.8/a', chatId: 'chat-r' });
    expect(first.error).toMatchObject({ code: 'BOT_PROTECTION', host: '1.1.1.1' });
    const calls = throttledFetchMock.mock.calls.length;
    const second = await extractForTool({ url: 'https://8.8.8.8/b', chatId: 'chat-r' });
    expect(second.error.code).toBe('BOT_PROTECTION');
    expect(throttledFetchMock).toHaveBeenCalledTimes(calls);
  });

  test('a 429 from a protection layer is reported but not remembered', async () => {
    throttledFetchMock.mockResolvedValue(
      blockedResponse(429, { server: 'cloudflare', 'cf-mitigated': 'challenge' }, '')
    );
    const first = await extractForTool({ url: 'https://8.8.8.8/a', chatId: 'chat-429' });
    expect(first.error).toMatchObject({ code: 'BOT_PROTECTION', retryable: false, status: 429 });
    await extractForTool({ url: 'https://8.8.8.8/a', chatId: 'chat-429' });
    expect(throttledFetchMock).toHaveBeenCalledTimes(2);
  });

  describe('search with content extraction', () => {
    beforeEach(async () => {
      ({ default: webSearchService } = await import('../services/WebSearchService.js'));
      ({ default: searchWithExtraction } = await import('../tools/lib/searchWithExtraction.js'));
    });

    test('shares the per-chat blocked-host memory with read_url', async () => {
      jest.spyOn(webSearchService, 'getProvider').mockReturnValue(null);
      jest.spyOn(webSearchService, 'search').mockResolvedValue({
        results: [{ title: 'Shop', url: 'https://8.8.8.8/shop', description: 'A shop' }]
      });
      throttledFetchMock.mockResolvedValue(
        blockedResponse(403, { server: 'AkamaiNetStorage' }, AKAMAI_BODY)
      );
      const search = () =>
        searchWithExtraction({
          query: 'shoes',
          provider: 'test',
          component: 'Test',
          extractContent: true,
          chatId: 'chat-s'
        });

      // The search finds the host blocked and remembers it for the chat ...
      const first = await search();
      expect(first.extractedContent[0].extractionErrorCode).toBe('BOT_PROTECTION');
      expect(throttledFetchMock).toHaveBeenCalledTimes(1);

      // ... so neither a later read_url nor another search asks that host again.
      const read = await extractForTool({ url: 'https://8.8.8.8/other', chatId: 'chat-s' });
      expect(read.error.code).toBe('BOT_PROTECTION');
      const second = await search();
      expect(second.extractedContent[0].extractionErrorCode).toBe('BOT_PROTECTION');
      expect(throttledFetchMock).toHaveBeenCalledTimes(1);
    });

    test('passes BOT_PROTECTION through per result and keeps the title and description', async () => {
      jest.spyOn(webSearchService, 'getProvider').mockReturnValue(null);
      jest.spyOn(webSearchService, 'search').mockResolvedValue({
        results: [
          { title: 'Blocked shop', url: 'https://8.8.8.8/shop', description: 'A shop' },
          { title: 'Open page', url: 'https://1.1.1.1/page', description: 'A page' }
        ]
      });
      throttledFetchMock.mockImplementation(async (_id, url) =>
        url.startsWith('https://8.8.8.8')
          ? blockedResponse(403, { server: 'AkamaiNetStorage' }, AKAMAI_BODY)
          : {
              ok: true,
              status: 200,
              statusText: 'OK',
              headers: { get: n => (n.toLowerCase() === 'content-type' ? 'text/html' : null) },
              text: async () => '<html><body><main><p>hello world</p></main></body></html>'
            }
      );

      const result = await searchWithExtraction({
        query: 'shoes',
        provider: 'test',
        component: 'Test',
        extractContent: true
      });
      const [blocked, open] = result.extractedContent;
      expect(blocked).toMatchObject({
        title: 'Blocked shop',
        description: 'A shop',
        contentExtracted: false,
        extractionErrorCode: 'BOT_PROTECTION',
        extractionRetryable: false
      });
      expect(open.contentExtracted).toBe(true);
      expect(open.extractionErrorCode).toBeUndefined();
      expect(result.summary).toMatch(/block automated access/);
      expect(result.summary).toMatch(/Do not retry/);
    });
  });
});
