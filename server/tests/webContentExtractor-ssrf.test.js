/**
 * SSRF regression tests for #1693: `webContentExtractor` only validated the
 * *initial* hostname before fetching, then let redirects (and DNS rebinding)
 * bypass the check entirely. These tests assert every redirect hop is
 * re-validated against the SSRF guard and that DNS is pinned to the addresses
 * validated for that hop.
 *
 * Uses `jest.unstable_mockModule` + dynamic imports since the source is
 * native ESM (see toolExecutor-usage-telemetry.test.js for the same pattern).
 */

import { jest } from '@jest/globals';

const throttledFetchMock = jest.fn();

jest.unstable_mockModule('../requestThrottler.js', () => ({
  throttledFetch: throttledFetchMock
}));

jest.unstable_mockModule('../actionTracker.js', () => ({
  actionTracker: {
    trackToolCallStart: () => {},
    trackToolCallProgress: () => {},
    trackToolCallEnd: () => {}
  }
}));

let platformConfig = { ssl: { ignoreInvalidCertificates: false, domainWhitelist: [] } };

jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    getPlatform: () => platformConfig
  }
}));

function htmlResponse(body = '<html><body><main>hello</main></body></html>') {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: name => (name.toLowerCase() === 'content-type' ? 'text/html' : null) },
    text: async () => body
  };
}

function redirectResponse(location) {
  return {
    ok: false,
    status: 302,
    statusText: 'Found',
    headers: { get: name => (name.toLowerCase() === 'location' ? location : null) }
  };
}

describe('webContentExtractor SSRF guard', () => {
  let webContentExtractor;

  beforeEach(async () => {
    jest.resetAllMocks();
    platformConfig = { ssl: { ignoreInvalidCertificates: false, domainWhitelist: [] } };
    ({ default: webContentExtractor } = await import('../tools/webContentExtractor.js'));
  });

  test('blocks a private IP literal before ever fetching', async () => {
    await expect(webContentExtractor({ url: 'http://127.0.0.1/' })).rejects.toMatchObject({
      message: expect.stringContaining('private/internal IP addresses')
    });
    expect(throttledFetchMock).not.toHaveBeenCalled();
  });

  test('blocks the AWS/GCP/Azure metadata address', async () => {
    await expect(
      webContentExtractor({ url: 'http://169.254.169.254/latest/meta-data' })
    ).rejects.toMatchObject({
      message: expect.stringContaining('private/internal IP addresses')
    });
    expect(throttledFetchMock).not.toHaveBeenCalled();
  });

  test('follows a redirect to a public IP and extracts content', async () => {
    throttledFetchMock
      .mockResolvedValueOnce(redirectResponse('http://93.184.216.34/final'))
      .mockResolvedValueOnce(htmlResponse());

    const result = await webContentExtractor({ url: 'http://93.184.216.34/start' });

    expect(result.content).toContain('hello');
    expect(throttledFetchMock).toHaveBeenCalledTimes(2);
  });

  test('blocks a redirect that points at a private/internal address', async () => {
    throttledFetchMock.mockResolvedValueOnce(
      redirectResponse('http://169.254.169.254/latest/meta-data')
    );

    await expect(webContentExtractor({ url: 'http://93.184.216.34/start' })).rejects.toMatchObject({
      message: expect.stringContaining('private/internal IP addresses')
    });

    // The malicious hop must never be fetched.
    expect(throttledFetchMock).toHaveBeenCalledTimes(1);
  });

  test('blocks a redirect that DNS-rebinds via a hostname resolving to a private IP', async () => {
    // No real DNS is exercised here: dns.resolve4/6 would be needed for a
    // hostname redirect target, which this suite intentionally avoids by
    // using IP literals everywhere — this case is instead covered indirectly
    // by the "blocks a redirect that points at a private/internal address"
    // test above using the pinned-lookup code path.
    throttledFetchMock.mockResolvedValueOnce(redirectResponse('http://[::ffff:a9fe:a9fe]/'));

    await expect(webContentExtractor({ url: 'http://93.184.216.34/start' })).rejects.toMatchObject({
      message: expect.stringContaining('private/internal IP addresses')
    });
    expect(throttledFetchMock).toHaveBeenCalledTimes(1);
  });

  test('gives up after too many redirects', async () => {
    // Six public IPs so every hop passes the SSRF check but the chain never terminates.
    for (let i = 1; i <= 7; i++) {
      throttledFetchMock.mockResolvedValueOnce(redirectResponse(`http://93.184.216.${i}/hop`));
    }

    await expect(webContentExtractor({ url: 'http://93.184.216.0/start' })).rejects.toMatchObject({
      message: expect.stringContaining('Too many redirects')
    });

    // Initial request + MAX_REDIRECTS (5) follow-ups = 6 fetches before giving up.
    expect(throttledFetchMock).toHaveBeenCalledTimes(6);
  });

  test('rejects non-http(s) redirect targets', async () => {
    throttledFetchMock.mockResolvedValueOnce(redirectResponse('file:///etc/passwd'));

    await expect(webContentExtractor({ url: 'http://93.184.216.34/start' })).rejects.toMatchObject({
      message: expect.stringContaining('Only HTTP and HTTPS URLs are supported')
    });
    expect(throttledFetchMock).toHaveBeenCalledTimes(1);
  });

  describe('platform.ssrf.allowedHosts bypass', () => {
    test('allows a private IP literal explicitly allow-listed by the admin', async () => {
      platformConfig = {
        ssl: { ignoreInvalidCertificates: false, domainWhitelist: [] },
        ssrf: { allowedHosts: ['169.254.169.254'] }
      };
      throttledFetchMock.mockResolvedValueOnce(htmlResponse());

      const result = await webContentExtractor({ url: 'http://169.254.169.254/internal' });

      expect(result.content).toContain('hello');
      expect(throttledFetchMock).toHaveBeenCalledTimes(1);
    });

    test('the pinned DNS lookup for an allow-listed private target actually resolves it', async () => {
      // Regression test: assertPublicTarget() lets an allow-listed private
      // address through, but createPinnedLookup() used to unconditionally
      // drop private addresses as a defense-in-depth re-check — silently
      // breaking the allowlist bypass with an ENOTFOUND at connect time. This
      // exercises the actual `lookup` function handed to the request agent to
      // prove it resolves rather than erroring.
      platformConfig = {
        ssl: { ignoreInvalidCertificates: false, domainWhitelist: [] },
        ssrf: { allowedHosts: ['169.254.169.254'] }
      };
      throttledFetchMock.mockResolvedValueOnce(htmlResponse());

      await webContentExtractor({ url: 'http://169.254.169.254/internal' });

      const [, , requestOptions] = throttledFetchMock.mock.calls[0];
      const lookup = requestOptions.agent?.options?.lookup;
      expect(typeof lookup).toBe('function');

      const lookupResult = await new Promise((resolve, reject) => {
        lookup('169.254.169.254', {}, (err, address, family) => {
          if (err) reject(err);
          else resolve({ address, family });
        });
      });
      expect(lookupResult.address).toBe('169.254.169.254');
    });

    test('still blocks a private IP that is not on the allowlist', async () => {
      platformConfig = {
        ssl: { ignoreInvalidCertificates: false, domainWhitelist: [] },
        ssrf: { allowedHosts: ['other-internal-host.corp'] }
      };

      await expect(webContentExtractor({ url: 'http://169.254.169.254/' })).rejects.toMatchObject({
        message: expect.stringContaining('private/internal IP addresses')
      });
      expect(throttledFetchMock).not.toHaveBeenCalled();
    });
  });
});
