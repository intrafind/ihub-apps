// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * #3307: the source editor's URL test (`probeUrl`) must agree with Preview.
 * A host the admin trusts (`ssl.domainWhitelist`, `ssrf.allowedHosts`) passes
 * the private-address check, an untrusted internal one does not, and a name
 * nothing resolves gets an error that says so instead of blaming the range.
 *
 * The requests are real, against a loopback server; only the platform config
 * and the DNS-based guard are stubbed.
 */

import { jest } from '@jest/globals';
import http from 'node:http';

let platform = {};
const assertPublicTarget = jest.fn();

jest.unstable_mockModule('../configCache.js', () => ({
  default: { getPlatform: () => platform }
}));
jest.unstable_mockModule('../utils/ssrfGuard.js', () => ({
  assertPublicTarget,
  createPinnedLookup: jest.fn(() => {
    throw new Error('a trusted host has no checked address to pin to');
  }),
  UNRESOLVED_HOST: 'UNRESOLVED_HOST'
}));

const { probeUrl, checkProbeTarget } = await import('../sources/SourceManager.js');

describe('probeUrl and trusted hosts (#3307)', () => {
  let server;
  let base;
  let redirectTarget;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { location: redirectTarget });
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>ok</html>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(() => new Promise(resolve => server.close(resolve)));

  beforeEach(() => {
    platform = {};
    redirectTarget = 'http://169.254.169.254/';
    assertPublicTarget.mockReset().mockResolvedValue({
      ok: false,
      reason: 'host resolves to private IP 127.0.0.1'
    });
  });

  test.each([
    ['ssl.domainWhitelist', { ssl: { domainWhitelist: ['127.0.0.1'] } }],
    ['ssrf.allowedHosts', { ssrf: { allowedHosts: ['127.0.0.1'] } }]
  ])('a host trusted via %s skips the private-address check', async (_name, config) => {
    platform = config;
    const result = await probeUrl({ url: `${base}/page` });
    expect(result.accessible).toBe(true);
    expect(assertPublicTarget).not.toHaveBeenCalled();
  });

  test('a host that is not trusted is still refused', async () => {
    platform = { ssl: { domainWhitelist: ['other-host'] }, ssrf: { allowedHosts: ['*.corp.x'] } };
    await expect(probeUrl({ url: `${base}/page` })).rejects.toThrow(
      /private\/internal addresses is not allowed/
    );
  });

  test('a trusted host does not vouch for the host it redirects to', async () => {
    platform = { ssl: { domainWhitelist: ['127.0.0.1'] } };
    await expect(probeUrl({ url: `${base}/redirect` })).rejects.toThrow(
      /private\/internal addresses is not allowed/
    );
    expect(assertPublicTarget).toHaveBeenCalledTimes(1);
    expect(assertPublicTarget.mock.calls[0][0].hostname).toBe('169.254.169.254');
  });

  test('an unresolvable name says so instead of blaming the address range', async () => {
    assertPublicTarget.mockResolvedValue({
      ok: false,
      reason: 'host did not resolve to any IP',
      code: 'UNRESOLVED_HOST'
    });
    const error = await probeUrl({ url: 'https://if-wiki/display/x' }).catch(e => e);
    expect(error.message).toMatch(/if-wiki could not be resolved/);
    expect(error.message).toMatch(/ssl\.domainWhitelist or ssrf\.allowedHosts/);
    expect(error.message).not.toMatch(/private/);
  });

  test('checkProbeTarget hands untrusted hosts to the guard', async () => {
    assertPublicTarget.mockResolvedValue({ ok: true, addresses: ['93.184.216.34'] });
    const result = await checkProbeTarget(new URL('https://example.com/'));
    expect(result).toEqual({ ok: true, addresses: ['93.184.216.34'] });
  });

  test('checkProbeTarget trusts a whitelisted internal name without resolving it', async () => {
    platform = { ssl: { domainWhitelist: ['if-wiki'] } };
    const result = await checkProbeTarget(new URL('https://if-wiki/display/x'));
    expect(result).toEqual({ ok: true, addresses: null });
    expect(assertPublicTarget).not.toHaveBeenCalled();
  });
});
