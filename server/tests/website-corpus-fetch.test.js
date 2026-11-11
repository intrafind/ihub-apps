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
    const { fetchWebPage } = await import('../services/pageReader/pageReader.js');
    throttledFetchMock.mockResolvedValueOnce(
      response({ status: 302, location: 'http://169.254.169.254/x' })
    );
    await expect(fetchWebPage('http://93.184.216.34/start')).rejects.toMatchObject({
      message: expect.stringContaining('private/internal IP addresses')
    });
    expect(throttledFetchMock).toHaveBeenCalledTimes(1);
  });

  test('does not follow a redirect to another site: nothing is sent there', async () => {
    throttledFetchMock
      .mockResolvedValueOnce(response({ status: 301, location: 'http://93.184.216.40/landing' }))
      .mockResolvedValueOnce(response({ body: '<main>fremd</main>' }));
    const page = await fetchSitePage('http://93.184.216.34/start', { siteHost: '93.184.216.34' });
    expect(page.offSite).toBe(true);
    expect(page.html).toBeNull();
    expect(throttledFetchMock).toHaveBeenCalledTimes(1);
  });

  test('does not follow a redirect to another port of the same host', async () => {
    throttledFetchMock.mockResolvedValueOnce(
      response({ status: 302, location: 'http://93.184.216.34:8500/v1/kv/?recurse' })
    );
    const page = await fetchSitePage('http://93.184.216.34/start', { siteHost: '93.184.216.34' });
    expect(page.offSite).toBe(true);
    expect(throttledFetchMock).toHaveBeenCalledTimes(1);
  });

  test('a robots.txt or sitemap that redirects off the site is no robots.txt: nothing is sent there', async () => {
    const { fetchSitemapText } = await import('../services/websiteCorpus/fetch.js');
    throttledFetchMock.mockResolvedValue(
      response({ status: 302, location: 'http://93.184.216.40:8080/admin' })
    );
    expect(await fetchRobotsText('http://93.184.216.34')).toBeNull();
    expect(await fetchSitemapText('http://93.184.216.34/sitemap.xml')).toBeNull();
    expect(throttledFetchMock).toHaveBeenCalledTimes(2);
    expect(throttledFetchMock.mock.calls.map(call => call[1])).toEqual([
      'http://93.184.216.34/robots.txt',
      'http://93.184.216.34/sitemap.xml'
    ]);
  });

  test('a sitemap redirect on the same site is followed', async () => {
    const { fetchSitemapText } = await import('../services/websiteCorpus/fetch.js');
    throttledFetchMock
      .mockResolvedValueOnce(
        response({ status: 301, location: 'https://93.184.216.34/sitemap.xml' })
      )
      .mockResolvedValueOnce(response({ type: 'application/xml', body: '<urlset></urlset>' }));
    expect(await fetchSitemapText('http://93.184.216.34/sitemap.xml')).toBe('<urlset></urlset>');
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

  describe('company-internal hosts (policy.allowPrivate)', () => {
    const only = host => ({ allowPrivate: hostname => hostname === host });

    test('refuses a private host by default and fetches it when the policy names it', async () => {
      await expect(
        fetchSitePage('http://10.1.2.3/', { siteHost: '10.1.2.3' })
      ).rejects.toMatchObject({
        message: expect.stringContaining('private/internal IP addresses')
      });
      expect(throttledFetchMock).not.toHaveBeenCalled();

      throttledFetchMock.mockResolvedValueOnce(response({ body: '<main>intern</main>' }));
      const page = await fetchSitePage('http://10.1.2.3/', {
        siteHost: '10.1.2.3',
        policy: only('10.1.2.3')
      });
      expect(page.html).toContain('intern');
    });

    test('keeps loopback, link-local and the metadata services blocked even for a host the policy allows', async () => {
      const everything = { allowPrivate: () => true };
      for (const host of ['127.0.0.1', '169.254.169.254', '100.100.100.200']) {
        await expect(
          fetchSitePage(`http://${host}/`, { siteHost: host, policy: everything })
        ).rejects.toMatchObject({
          message: expect.stringContaining('private/internal IP addresses')
        });
      }
      expect(throttledFetchMock).not.toHaveBeenCalled();
    });

    test('asks the policy for every hop: a redirect to another internal host is refused', async () => {
      const { fetchWebPage } = await import('../services/pageReader/pageReader.js');
      throttledFetchMock.mockResolvedValueOnce(
        response({ status: 302, location: 'http://10.9.9.9/x' })
      );
      await expect(
        fetchWebPage('http://10.1.2.3/', { policy: only('10.1.2.3') })
      ).rejects.toMatchObject({
        message: expect.stringContaining('private/internal IP addresses')
      });
      expect(throttledFetchMock).toHaveBeenCalledTimes(1);
    });

    test('a redirect from an allowed host to the metadata service is refused, even for a policy that allows all', async () => {
      const { fetchWebPage } = await import('../services/pageReader/pageReader.js');
      throttledFetchMock.mockResolvedValueOnce(
        response({ status: 302, location: 'http://169.254.169.254/latest/meta-data/' })
      );
      await expect(
        fetchWebPage('http://10.1.2.3/', { policy: { allowPrivate: () => true } })
      ).rejects.toMatchObject({
        message: expect.stringContaining('private/internal IP addresses')
      });
    });

    test('a policy that is not a function of the host is ignored', async () => {
      await expect(
        fetchSitePage('http://10.1.2.3/', { siteHost: '10.1.2.3', policy: { allowPrivate: true } })
      ).rejects.toMatchObject({
        message: expect.stringContaining('private/internal IP addresses')
      });
    });

    test('the policy is asked with the port too, so an approval can mean web ports only', async () => {
      const seen = [];
      const policy = {
        allowPrivate: (hostname, port) => {
          seen.push([hostname, port]);
          return port === '';
        }
      };
      throttledFetchMock.mockResolvedValueOnce(response());
      await fetchSitePage('http://10.1.2.3/', { siteHost: '10.1.2.3', policy });
      await expect(
        fetchSitePage('http://10.1.2.3:2375/containers/json', { siteHost: '10.1.2.3:2375', policy })
      ).rejects.toMatchObject({
        message: expect.stringContaining('private/internal IP addresses')
      });
      expect(seen).toEqual([
        ['10.1.2.3', ''],
        ['10.1.2.3', '2375']
      ]);
    });

    test('refuses an internal host that would be fetched through a proxy', async () => {
      platform = {
        ssl: { domainWhitelist: [] },
        proxy: { enabled: true, http: 'http://proxy.test:3128', https: 'http://proxy.test:3128' }
      };
      await expect(
        fetchSitePage('http://10.1.2.3/', { siteHost: '10.1.2.3', policy: only('10.1.2.3') })
      ).rejects.toMatchObject({ message: expect.stringContaining('proxy.noProxy') });
      expect(throttledFetchMock).not.toHaveBeenCalled();
      // The public rule through a proxy is unchanged.
      throttledFetchMock.mockResolvedValueOnce(response());
      expect(
        (await fetchSitePage('http://93.184.216.34/', { siteHost: '93.184.216.34' })).status
      ).toBe(200);
    });

    test('the host check answers the way the fetch will', async () => {
      const { checkHostReachable } = await import('../services/websiteCorpus/fetch.js');
      expect(await checkHostReachable(new URL('http://10.1.2.3/'))).toMatchObject({ ok: false });
      expect(await checkHostReachable(new URL('http://10.1.2.3/'), only('10.1.2.3'))).toEqual({
        ok: true
      });
      expect(await checkHostReachable(new URL('http://10.1.2.4/'), only('10.1.2.3'))).toMatchObject(
        { ok: false }
      );
      expect(
        await checkHostReachable(new URL('http://169.254.169.254/'), { allowPrivate: () => true })
      ).toMatchObject({ ok: false });
      expect(await checkHostReachable(new URL('http://93.184.216.34/'))).toEqual({ ok: true });
    });
  });
});
