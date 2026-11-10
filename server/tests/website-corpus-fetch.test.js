// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The network access of the website corpus sizer. Every request goes through
 * the page reader's guarded fetch, so a private address is refused unless the
 * admin trusts that host (`ssl.domainWhitelist` / `ssrf.allowedHosts`), a
 * redirect to another site is not followed into the corpus, and a response is
 * only read when it is HTML.
 *
 * Native ESM: `jest.unstable_mockModule` + dynamic imports.
 */
import { jest } from '@jest/globals';
import { Readable } from 'node:stream';

const throttledFetchMock = jest.fn();
const registerThrottleHintsMock = jest.fn();
let platform = { ssl: { ignoreInvalidCertificates: false, domainWhitelist: [] } };

jest.unstable_mockModule('../requestThrottler.js', () => ({
  throttledFetch: throttledFetchMock,
  registerThrottleHints: registerThrottleHintsMock
}));
jest.unstable_mockModule('../services/loop/RunStream.js', () => ({
  emitToolProgress: () => null
}));
jest.unstable_mockModule('../configCache.js', () => ({
  default: { getPlatform: () => platform }
}));

function response({
  status = 200,
  type = 'text/html; charset=utf-8',
  body = '<main>hello</main>',
  location
} = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'x',
    headers: {
      get: name => {
        const key = name.toLowerCase();
        if (key === 'content-type') return type;
        if (key === 'location') return location ?? null;
        return null;
      }
    },
    body: Readable.from([Buffer.from(body)])
  };
}

describe('website corpus fetch', () => {
  let fetchSitePage;
  let fetchRobotsText;
  let CORPUS_THROTTLE_ID;

  beforeEach(async () => {
    throttledFetchMock.mockReset();
    platform = { ssl: { ignoreInvalidCertificates: false, domainWhitelist: [] } };
    ({ fetchSitePage, fetchRobotsText, CORPUS_THROTTLE_ID } =
      await import('../services/websiteCorpus/fetch.js'));
  });

  test('has its own throttle queue with a concurrency and a delay', () => {
    expect(registerThrottleHintsMock).toHaveBeenCalledWith(
      CORPUS_THROTTLE_ID,
      expect.objectContaining({
        concurrency: expect.any(Number),
        requestDelayMs: expect.any(Number)
      })
    );
  });

  test('refuses a private address that is not trusted, without sending a request', async () => {
    await expect(
      fetchSitePage('http://127.0.0.1/', { siteHost: '127.0.0.1' })
    ).rejects.toMatchObject({
      message: expect.stringContaining('private/internal IP addresses')
    });
    await expect(
      fetchSitePage('http://169.254.169.254/latest/meta-data', { siteHost: '169.254.169.254' })
    ).rejects.toMatchObject({ message: expect.stringContaining('private/internal IP addresses') });
    expect(throttledFetchMock).not.toHaveBeenCalled();
  });

  test('fetches an internal host the admin trusts (ssrf.allowedHosts)', async () => {
    platform = { ssl: { domainWhitelist: [] }, ssrf: { allowedHosts: ['intranet.corp.test'] } };
    throttledFetchMock.mockResolvedValueOnce(response({ body: '<main>intern</main>' }));
    const page = await fetchSitePage('https://intranet.corp.test/start', {
      siteHost: 'intranet.corp.test'
    });
    expect(page.html).toContain('intern');
    expect(throttledFetchMock).toHaveBeenCalledWith(
      CORPUS_THROTTLE_ID,
      'https://intranet.corp.test/start',
      expect.any(Object)
    );
  });

  test('fetches an internal host on the certificate whitelist too', async () => {
    platform = {
      ssl: { ignoreInvalidCertificates: true, domainWhitelist: ['intranet.corp.test'] }
    };
    throttledFetchMock.mockResolvedValueOnce(response());
    const page = await fetchSitePage('https://intranet.corp.test/', {
      siteHost: 'intranet.corp.test'
    });
    expect(page.status).toBe(200);
  });

  test('revalidates every redirect hop: a redirect to a private address is refused', async () => {
    throttledFetchMock.mockResolvedValueOnce(
      response({ status: 302, location: 'http://169.254.169.254/x' })
    );
    await expect(
      fetchSitePage('http://93.184.216.34/start', { siteHost: '93.184.216.34' })
    ).rejects.toMatchObject({
      message: expect.stringContaining('private/internal IP addresses')
    });
    expect(throttledFetchMock).toHaveBeenCalledTimes(1);
  });

  test('does not keep a page a redirect moved to another site', async () => {
    throttledFetchMock
      .mockResolvedValueOnce(response({ status: 301, location: 'http://93.184.216.40/landing' }))
      .mockResolvedValueOnce(response({ body: '<main>fremd</main>' }));
    const page = await fetchSitePage('http://93.184.216.34/start', { siteHost: '93.184.216.34' });
    expect(page.offSite).toBe(true);
    expect(page.html).toBeNull();
  });

  test('keeps a redirect that stays on the site', async () => {
    throttledFetchMock
      .mockResolvedValueOnce(response({ status: 301, location: 'http://93.184.216.34/neu' }))
      .mockResolvedValueOnce(response({ body: '<main>neu</main>' }));
    const page = await fetchSitePage('http://93.184.216.34/alt', { siteHost: '93.184.216.34' });
    expect(page.offSite).toBe(false);
    expect(page.finalUrl).toBe('http://93.184.216.34/neu');
    expect(page.html).toContain('neu');
  });

  test('reads only HTML, and reports the status of an error page', async () => {
    throttledFetchMock
      .mockResolvedValueOnce(response({ type: 'application/pdf', body: '%PDF' }))
      .mockResolvedValueOnce(response({ status: 404 }));
    const pdf = await fetchSitePage('http://93.184.216.34/a.pdf', { siteHost: '93.184.216.34' });
    expect(pdf).toMatchObject({ status: 200, html: null, offSite: false });
    const missing = await fetchSitePage('http://93.184.216.34/gone', { siteHost: '93.184.216.34' });
    expect(missing).toMatchObject({ status: 404, html: null });
  });

  test('a robots.txt that cannot be read is no robots.txt, and a refused address is one too', async () => {
    throttledFetchMock.mockResolvedValueOnce(response({ status: 404 }));
    expect(await fetchRobotsText('http://93.184.216.34')).toBeNull();
    expect(await fetchRobotsText('http://127.0.0.1')).toBeNull();
  });
});
